"""Numeric correctness tests for `orchestrator.dashboard.build_data`.

No test asserted a *value* on this dashboard before — only that the HTML contained certain strings —
which is exactly how `p99/p50 tail ratio 4053665000.0×` shipped. Every summary key a human reads is
pinned here against a fixture stream whose expected values are computed by hand in the assertions.

Fixtures mirror real row shapes from the live state dir
(~/.local/state/coding-agent-orchestrator/{metrics,events,outcomes}.jsonl), trimmed to the keys under
test. Nothing here reads the live directory: a metric test that depends on today's telemetry cannot
fail for the right reason.
"""
import json
import math
import os
import re
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from pathlib import Path

from orchestrator.dashboard import (INSTRUMENTATION, MIN_TAIL_SAMPLES, build_data, build_ingest_status,
                                    generate_dashboard, safe, tail_ratio)
from orchestrator.economics import quantile
from orchestrator.records import NO_DATA, is_no_data, to_json

# --- fixtures ---------------------------------------------------------------------------------

def per_call(cost, **kw):
    """An ordinary per-call `model_call` row — the only population per-call statistics may use."""
    row = {'event': 'model_call', 'granularity': 'call', 'agent_runtime': 'humain-terminal',
           'cost_source': 'estimated-from-reported-tokens', 'cost_rate_model': 'gpt-6-astra',
           'input_tokens': 13492, 'output_tokens': 902, 'model': 'gpt-6-astra',
           'role': 'implementation_fast', 'ts': '2026-09-21T16:17:21.684Z'}
    row.update(kw)
    if cost is not None:
        row['cost_usd'] = cost
    return row


#: A whole session recorded as one row: $3.94 covering 29 calls. Its cost is real spend but it is not
#: a per-call magnitude, and `covers_calls` is the only reason interactive volume can be counted.
SESSION_AGGREGATE_ROW = {
    'event': 'model_call', 'granularity': 'session', 'covers_calls': 29, 'cost_usd': 3.94303,
    'cost_source': 'estimated-from-reported-tokens', 'cost_rate_model': 'claude-opus-5',
    'agent_runtime': 'humain-terminal', 'input_tokens': 5704180, 'output_tokens': 33834,
    'model': 'claude-opus-5', 'role': 'lead', 'ts': '2026-09-21T15:44:06.607Z',
}

#: The worst live row: a whole session as one "call", 33,177,381 input tokens, a retry that *passed*.
LEGACY_SESSION_ROW = {
    'event': 'model_call', 'cost_usd': 10.12, 'cost_source': 'provider_reported',
    'legacy_source': '/Users/x/.claude/projects/-Users-x-forge/.orchestrator', 'input_tokens': 33177381,
    'output_tokens': 55803, 'model': 'sonnet', 'agent_runtime': 'claude-code', 'role': 'qa_agent',
    'capability_class': 'technical_review', 'result': 'pass', 'retry': 1,
    'task_id': 'qa-claude-code-focused-run', 'ts': '2026-09-18T14:25:01.642809+00:00',
}

#: Carries `executed_cost_usd`, never `cost_usd`: a $0 row to every cost field that reads `cost_usd`.
ROUTE_EXECUTED_ROW = {
    'event': 'route_executed', 'agent_runtime': 'humain-terminal', 'executed_cost_usd': 0.0082065,
    'capability_class': 'implementation_fast', 'executed_passes': True, 'task_id': 'triage-reply',
    'ts': '2026-09-22T07:29:37.614523+00:00',
}

ADAPTIVE_DECISION_ROW = {
    'event': 'adaptive_route_decision', 'adaptive_mode': 'recommend', 'route_action': 'recommended_only',
    'agent_runtime': 'humain-terminal', 'capability_class': 'architect', 'explored': False,
    'history_sufficient': False, 'policy_id': '8ae7b99435e24efa', 'cost_aggressiveness': 0.7,
    'ts': '2026-09-21T15:55:21.324703+00:00',
}

INGEST_AGGREGATE_ROW = {
    'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
    'granularity': 'session', 'covers_calls': 140, 'cost_usd': 12.5, 'agent_runtime': 'codex',
    'cost_source': 'estimated-from-reported-tokens', 'cost_rate_model': 'gpt-6-astra',
    'input_tokens': 1_000_000, 'output_tokens': 20_000, 'session_id': 'sess-a',
}

INGEST_PER_CALL_ROW = {
    'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
    'granularity': 'call', 'cost_usd': 0.25, 'agent_runtime': 'codex', 'session_id': 'sess-b',
    'cost_source': 'estimated-from-reported-tokens', 'cost_rate_model': 'gpt-6-astra',
    'input_tokens': 10_000, 'output_tokens': 500,
}


def write_stream(root, metrics=(), events=(), outcomes=()):
    for name, rows in (('metrics', metrics), ('events', events), ('outcomes', outcomes)):
        (Path(root) / f'{name}.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows),
                                                  encoding='utf-8')


class StreamCase(unittest.TestCase):
    def build(self, metrics=(), events=(), outcomes=()):
        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory, metrics, events, outcomes)
            return build_data(Path(directory), config={})

    def summary(self, metrics=(), events=(), outcomes=()):
        return self.build(metrics, events, outcomes)['summary']


# --- the headline defect ----------------------------------------------------------------------

class TailRatioTests(StreamCase):
    def test_regression_p50_of_zero_yields_no_data_not_a_billionfold_ratio(self):
        """The shipped card read `4053665000.0×`: p99 in dollars times 10^9.

        The old expression was `quantile(costs,.99)/max(1e-9,quantile(costs,.5))` over *all*
        orchestrated rows — zero-cost event rows (`route_executed`, `adaptive_route_decision`) pooled
        with whole-session aggregates and per-call rows in one population. A fixture of 195 zero-cost
        event rows plus a single $4.0537 call, on its own, computes to `0.0` under that old formula
        (both p50 and p99 land on a zero in a population that is 99.5% zeros) — nowhere near the
        reported `4053665000.0×`, so asserting NO_DATA against *that* fixture alone would not prove
        the guard actually stops the shipped defect. Adding one more nonzero value that the old code
        also pooled in — a whole-session aggregate's cost, exactly the kind of row the live stream
        carries dozens of — reproduces the real magnitude: `quantile([0.0]*195+[4.0537,10.12],.99) /
        max(1e-9, quantile(...,.5))` is `162147999.99996772`. This fixture uses that population.
        """
        rows = ([ROUTE_EXECUTED_ROW] * 111 + [dict(ADAPTIVE_DECISION_ROW)] * 84
                + [per_call(4.0537), dict(LEGACY_SESSION_ROW)])
        summary = self.summary(rows)
        self.assertTrue(is_no_data(summary['tail_ratio']),
                        f"expected NO_DATA, got {summary['tail_ratio']!r}")
        # and the sentinel must survive serialization as null, never as 0
        self.assertIsNone(to_json(summary)['tail_ratio'])
        self.assertIn('"tail_ratio": null', json.dumps(to_json(summary), indent=1))

        # The guard must not rot into testing a fixture the old formula would have answered
        # innocuously: prove the *old* arithmetic, given the exact same population, still produces
        # an absurd ratio. This does not exercise any production code path (the whole point is that
        # the shipped defect's code path no longer exists); it independently recomputes what that
        # removed expression would have returned, using the same quantile implementation the old
        # code used before it was restricted to `is_per_call_cost_row`.
        old_costs = [float(r.get('cost_usd') or 0) for r in rows]
        old_p50 = quantile(old_costs, .5)
        old_p99 = quantile(old_costs, .99)
        self.assertEqual(old_p50, 0.0, 'the fixture must reproduce the zero-p50 shape of the defect')
        old_ratio = old_p99 / max(1e-9, old_p50)
        self.assertAlmostEqual(old_ratio, 162147999.99996772, places=2)
        self.assertGreater(old_ratio, 1e6,
                           'the old formula must still be shown producing an absurd ratio on this '
                           'population, or this regression test could rot without noticing')

    def test_no_data_below_the_sample_floor_even_with_a_healthy_p50(self):
        summary = self.summary([per_call(1.0 + i / 10) for i in range(MIN_TAIL_SAMPLES - 1)])
        self.assertEqual(summary['per_call_samples'], MIN_TAIL_SAMPLES - 1)
        self.assertTrue(is_no_data(summary['tail_ratio']))

    def test_a_real_ratio_once_enough_per_call_samples_exist(self):
        # 40 samples: $0.10 x 39 plus one $10.00 tail call. p50 = $0.10, p99 ~= the tail.
        rows = [per_call(.10) for _ in range(39)] + [per_call(10.0)]
        summary = self.summary(rows)
        self.assertEqual(summary['per_call_samples'], 40)
        self.assertAlmostEqual(summary['p50_cost'], .10, places=6)
        self.assertAlmostEqual(summary['tail_ratio'], summary['p99_cost'] / summary['p50_cost'], places=9)
        self.assertLess(summary['tail_ratio'], 101)
        self.assertGreater(summary['tail_ratio'], 1)

    def test_the_helper_never_divides_by_a_floor_constant(self):
        self.assertTrue(is_no_data(tail_ratio(4.0537, 0.0, 400)))
        self.assertTrue(is_no_data(tail_ratio(4.0537, NO_DATA, 400)))
        self.assertTrue(is_no_data(tail_ratio(NO_DATA, 1.0, 400)))
        self.assertTrue(is_no_data(tail_ratio(4.0, 2.0, MIN_TAIL_SAMPLES - 1)))
        self.assertAlmostEqual(tail_ratio(4.0, 2.0, MIN_TAIL_SAMPLES), 2.0)


class PerCallDistributionTests(StreamCase):
    def test_percentiles_use_per_call_cost_rows_only(self):
        """Session aggregates and event rows are excluded; their spend stays visible separately."""
        per_call_rows = [per_call(c) for c in (.01, .02, .03, .04, 6.00)]
        rows = per_call_rows + [SESSION_AGGREGATE_ROW, LEGACY_SESSION_ROW, ROUTE_EXECUTED_ROW,
                                dict(ADAPTIVE_DECISION_ROW)]
        summary = self.summary(rows)
        self.assertEqual(summary['per_call_samples'], 5)
        self.assertAlmostEqual(summary['p50_cost'], .03, places=6)
        self.assertAlmostEqual(summary['p90_cost'], .04 + (6.00 - .04) * .6, places=6)
        self.assertAlmostEqual(summary['p99_cost'], .04 + (6.00 - .04) * .96, places=6)
        self.assertAlmostEqual(summary['max_call_cost'], 6.00, places=6)
        self.assertAlmostEqual(summary['mean_call_cost'], 6.10 / 5, places=6)
        self.assertAlmostEqual(summary['per_call_cost'], 6.10, places=6)
        # excluded-but-visible: two session aggregates holding $14.06 of the $20.16 total
        self.assertEqual(summary['session_rows'], 2)
        self.assertAlmostEqual(summary['session_cost'], 3.94303 + 10.12, places=6)
        self.assertAlmostEqual(summary['total_cost'], 6.10 + 3.94303 + 10.12, places=6)

    def test_every_per_call_figure_is_no_data_without_a_single_per_call_row(self):
        summary = self.summary([SESSION_AGGREGATE_ROW, ROUTE_EXECUTED_ROW])
        for key in ('p50_cost', 'p90_cost', 'p99_cost', 'mean_call_cost', 'max_call_cost', 'tail_ratio'):
            self.assertTrue(is_no_data(summary[key]), f'{key} fabricated a value')
        self.assertEqual(summary['per_call_samples'], 0)


class ExecutedSpendTests(StreamCase):
    def test_route_executed_spend_is_surfaced_not_read_as_zero(self):
        """111 live `route_executed` rows carry $17.46 that every `cost_usd` reader saw as $0."""
        calls = [per_call(.5), per_call(.25)]
        rows = calls + [dict(ROUTE_EXECUTED_ROW, executed_cost_usd=.5),
                        dict(ROUTE_EXECUTED_ROW, executed_cost_usd=.25)]
        executed = self.summary(rows)['executed_spend']
        self.assertEqual(executed['rows'], 2)
        self.assertAlmostEqual(executed['cost'], .75, places=6)
        self.assertAlmostEqual(executed['by_runtime']['humain-terminal'], .75, places=6)
        # the bridge emits two rows per dispatch: executed spend mirrors the model_call spend of the
        # same runtimes, and is deliberately NOT added into total_cost (different field names)
        self.assertAlmostEqual(executed['model_call_cost_same_runtimes'], .75, places=6)
        self.assertTrue(executed['mirrors_model_call_cost'])
        self.assertFalse(executed['counted_in_total_cost'])
        self.assertAlmostEqual(self.summary(rows)['total_cost'], .75, places=6)

    def test_divergent_executed_spend_is_not_claimed_to_mirror_model_calls(self):
        rows = [per_call(.5), dict(ROUTE_EXECUTED_ROW, executed_cost_usd=2.0)]
        executed = self.summary(rows)['executed_spend']
        self.assertAlmostEqual(executed['cost'], 2.0, places=6)
        self.assertFalse(executed['mirrors_model_call_cost'])

    def test_sub_percent_drift_between_the_two_streams_still_counts_as_the_same_dispatches(self):
        # live: $18.0926 executed vs $18.1030 model_call — two code paths rounding per row, one
        # relationship. An absolute cent would call this a coincidence tomorrow.
        rows = [per_call(18.1030), dict(ROUTE_EXECUTED_ROW, executed_cost_usd=18.0926)]
        executed = self.summary(rows)['executed_spend']
        self.assertTrue(executed['mirrors_model_call_cost'])

    def test_executed_spend_without_any_dispatch_row_claims_nothing(self):
        executed = self.summary([per_call(1.0)])['executed_spend']
        self.assertEqual(executed['rows'], 0)
        self.assertAlmostEqual(executed['cost'], 0.0)
        self.assertFalse(executed['mirrors_model_call_cost'])


class RowsVersusCallsTests(StreamCase):
    def test_interactive_sessions_report_rows_and_calls_separately(self):
        """`calls` was `len(rows)` — 7,084 rows for ~91,900 calls, a 13x understatement."""
        rows = [INGEST_AGGREGATE_ROW, dict(INGEST_AGGREGATE_ROW, covers_calls=60, session_id='sess-c'),
                INGEST_PER_CALL_ROW]
        interactive = self.build(rows)['interactive_sessions']
        self.assertEqual(interactive['rows'], 3)
        self.assertEqual(interactive['calls'], 140 + 60 + 1)
        self.assertEqual(interactive['aggregate_rows'], 2)
        self.assertEqual(interactive['sessions'], 3)
        self.assertAlmostEqual(interactive['cost'], 12.5 + 12.5 + .25, places=6)
        self.assertEqual(interactive['by_runtime']['codex']['rows'], 3)
        self.assertEqual(interactive['by_runtime']['codex']['calls'], 201)

    def test_distinct_sessions_is_no_data_when_no_row_states_a_session_id(self):
        interactive = self.build([{k: v for k, v in INGEST_PER_CALL_ROW.items() if k != 'session_id'}])['interactive_sessions']
        self.assertTrue(is_no_data(interactive['sessions']))

    def test_by_runtime_reconciles_metered_plus_unmetered_against_call_rows(self):
        """The card read '309 calls · 110 metered · 16 unmetered'; 126 != 309."""
        rows = [per_call(.5, cost_source='reported'),
                per_call(None, cost_source='unmetered'),
                per_call(.25),
                dict(ROUTE_EXECUTED_ROW), dict(ADAPTIVE_DECISION_ROW)]
        by_runtime = self.build(rows)['by_runtime']['humain-terminal']
        self.assertEqual(by_runtime['rows'], 5)
        self.assertEqual(by_runtime['call_rows'], 3)
        self.assertEqual(by_runtime['metered_calls'], 2)
        self.assertEqual(by_runtime['unmetered_calls'], 1)
        self.assertEqual(by_runtime['metered_calls'] + by_runtime['unmetered_calls'], by_runtime['call_rows'])
        self.assertAlmostEqual(by_runtime['reported_cost'], .5, places=6)
        self.assertAlmostEqual(by_runtime['estimated_cost'], .25, places=6)
        self.assertEqual(by_runtime['session_rows'], 0)
        self.assertNotIn('calls', by_runtime)

    def test_by_runtime_keeps_session_aggregates_visible(self):
        # $85.99 of live orchestrated spend sits in aggregate rows; a runtime line that hides them
        # invites dividing that spend by a call count it does not describe.
        by_runtime = self.build([SESSION_AGGREGATE_ROW, per_call(.5)])['by_runtime']['humain-terminal']
        self.assertEqual(by_runtime['rows'], 2)
        self.assertEqual(by_runtime['call_rows'], 2)
        self.assertEqual(by_runtime['session_rows'], 1)
        self.assertEqual(by_runtime['covered_calls'], 30)

    def test_by_role_separates_rows_call_rows_session_rows_and_covered_calls(self):
        by_role = self.build([SESSION_AGGREGATE_ROW, per_call(.5, role='lead'),
                              dict(ADAPTIVE_DECISION_ROW, role='lead')])['by_role']['lead']
        self.assertEqual(by_role['rows'], 3)
        self.assertEqual(by_role['call_rows'], 2)
        self.assertEqual(by_role['session_rows'], 1)
        self.assertEqual(by_role['covered_calls'], 30)
        self.assertNotIn('calls', by_role)


class AttributionSummaryTests(StreamCase):
    def test_reported_estimated_unmetered_and_coverage(self):
        rows = [per_call(1.0, cost_source='reported'),
                per_call(.5, cost_source='estimated-from-total-tokens-blended-rate'),
                per_call(None, cost_source='controller-context-not-metered'),
                dict(ADAPTIVE_DECISION_ROW)]
        summary = self.summary(rows)
        self.assertAlmostEqual(summary['reported_cost'], 1.0, places=6)
        self.assertAlmostEqual(summary['estimated_cost'], .5, places=6)
        self.assertEqual(summary['unmetered_calls'], 1)
        self.assertEqual(summary['call_rows'], 3)
        self.assertAlmostEqual(summary['cost_coverage'], 2 / 3, places=9)
        self.assertAlmostEqual(summary['total_cost'], 1.5, places=6)

    def test_coverage_is_no_data_when_nothing_is_accountable_for_cost(self):
        summary = self.summary([dict(ADAPTIVE_DECISION_ROW), dict(ROUTE_EXECUTED_ROW)])
        self.assertTrue(is_no_data(summary['cost_coverage']))
        self.assertEqual(summary['call_rows'], 0)

    def test_rate_provenance_names_the_dominant_unverified_rate_model(self):
        rows = [per_call(1.0, cost_rate_model='gpt-6-astra') for _ in range(3)]
        rows += [per_call(.2, cost_rate_model='claude-opus-5'),
                 per_call(5.0, cost_source='reported', cost_rate_model='sonnet'),
                 INGEST_AGGREGATE_ROW]
        provenance = self.summary(rows)['rate_provenance']
        self.assertEqual(provenance['dominant_model'], 'gpt-6-astra')
        # includes the ingested row: the dominant rate does most of its work on the interactive side
        self.assertEqual(provenance['dominant_rows'], 4)
        self.assertAlmostEqual(provenance['dominant_cost'], 15.5, places=6)
        self.assertAlmostEqual(provenance['estimated_cost'], 15.7, places=6)
        self.assertEqual(provenance['verified_rate_rows'], 0)
        self.assertAlmostEqual(provenance['unverified_rate_cost'], 15.7, places=6)
        # reported spend is not an estimate and must not appear in the rate table
        self.assertNotIn('sonnet', [m['model'] for m in provenance['models']])

    def test_rate_provenance_consumes_t5_fields_defensively_when_present(self):
        rows = [per_call(1.0, cost_rate_source='provider-pricing-page', cost_rate_verified_on='2026-09-23'),
                per_call(2.0)]
        provenance = self.summary(rows)['rate_provenance']
        entry = next(m for m in provenance['models'] if m['model'] == 'gpt-6-astra')
        self.assertEqual(entry['source'], 'provider-pricing-page')
        self.assertEqual(entry['verified_on'], '2026-09-23')
        self.assertEqual(provenance['verified_rate_rows'], 1)
        # the whole model's cost is credited to the verified rate once any row verifies it
        self.assertAlmostEqual(provenance['unverified_rate_cost'], 0.0, places=6)

    def test_rate_provenance_tolerates_the_fields_being_present_and_null(self):
        # `pricing.estimate_cost_usd` now stamps both keys on every priced row, with `None` when the
        # rate table states no provenance — an explicit null must read as "unverified", not crash.
        rows = [per_call(1.0, cost_rate_source=None, cost_rate_verified_on=None)]
        provenance = self.summary(rows)['rate_provenance']
        entry = provenance['models'][0]
        self.assertIsNone(entry['source'])
        self.assertIsNone(entry['verified_on'])
        self.assertEqual(provenance['verified_rate_rows'], 0)
        self.assertAlmostEqual(provenance['unverified_rate_cost'], 1.0, places=6)

    def test_rate_provenance_is_empty_not_broken_when_nothing_is_estimated(self):
        provenance = self.summary([per_call(1.0, cost_source='reported')])['rate_provenance']
        self.assertEqual(provenance['models'], [])
        self.assertTrue(is_no_data(provenance['dominant_model']))
        self.assertEqual(provenance['rate_rows'], 0)


class VerificationSummaryTests(StreamCase):
    def test_only_attested_verdicts_count_as_verified_dispatch_passes_are_reported_separately(self):
        """A dispatch `result: 'pass'` is a process exit code, not a gate verdict.

        Previously this asserted `verified_tasks == 2`, counting t1's dispatch pass as a
        verification. That conflation reported 174 verified tasks on a live stream with 18 attested
        ones. t1 is now a dispatch pass, t3 the only attested verification.
        """
        metrics = [per_call(1.0, task_id='t1', result='pass'),
                   per_call(2.0, task_id='t2', result='fail'),
                   per_call(3.0, task_id='t3')]
        outcomes = [{'task_id': 't3', 'outcome': 'verified', 'ts': '2026-09-20T00:00:00+00:00'},
                    {'task_id': 't2', 'outcome': 'blocked', 'ts': '2026-09-20T00:00:00+00:00'}]
        summary = self.summary(metrics, outcomes=outcomes)
        self.assertEqual(summary['verified_tasks'], 1)
        self.assertAlmostEqual(summary['verified_cost'], 6.0 / 1, places=6)
        # the weaker signal is still reported, under its own name
        self.assertEqual(summary['dispatch_pass_tasks'], 1)
        self.assertAlmostEqual(summary['dispatch_pass_cost'], 6.0 / 1, places=6)

    def test_an_emitted_task_verified_event_is_attested_even_though_it_is_a_metrics_row(self):
        """Strength comes from the row's shape, not from which stream it was read out of."""
        metrics = [per_call(4.0, task_id='t1', event='task_verified')]
        summary = self.summary(metrics)
        self.assertEqual(summary['verified_tasks'], 1)
        self.assertEqual(summary['dispatch_pass_tasks'], 0)

    def test_a_task_with_both_kinds_of_evidence_counts_once_as_attested(self):
        metrics = [per_call(1.0, task_id='t1', result='pass')]
        outcomes = [{'task_id': 't1', 'outcome': 'verified'}]
        summary = self.summary(metrics, outcomes=outcomes)
        self.assertEqual(summary['verified_tasks'], 1)
        # not also counted as a dispatch pass: the populations are disjoint, so summing them is safe
        self.assertEqual(summary['dispatch_pass_tasks'], 0)

    def test_contradictory_attested_evidence_resolves_away_from_verified(self):
        """A task-level resolver must see every row for the task before counting it verified."""
        metrics = [per_call(2.0, task_id='t1', event='task_verified')]
        outcomes = [{'task_id': 't1', 'outcome': 'fail'}]
        summary = self.summary(metrics, outcomes=outcomes)
        self.assertEqual(summary['verified_tasks'], 0)
        self.assertTrue(is_no_data(summary['verified_cost']))
        self.assertEqual(summary['dispatch_pass_tasks'], 0)

    def test_dispatch_passes_never_substitute_for_an_absent_attested_figure(self):
        """With dispatch passes but no attestation, verified is a real 0 and its cost unknown."""
        summary = self.summary([per_call(5.0, task_id='t1', result='pass')])
        self.assertEqual(summary['verified_tasks'], 0)
        self.assertTrue(is_no_data(summary['verified_cost']))
        self.assertEqual(summary['dispatch_pass_tasks'], 1)
        self.assertAlmostEqual(summary['dispatch_pass_cost'], 5.0, places=6)

    def test_verified_cost_is_no_data_rather_than_a_division_by_zero_tasks(self):
        summary = self.summary([per_call(1.0, task_id='t1', result='fail')])
        self.assertEqual(summary['verified_tasks'], 0)
        self.assertTrue(is_no_data(summary['verified_cost']))

    def test_policy_and_trend_rows_use_the_same_verification_signal(self):
        """Policy/daily Verified columns are attested-only, matching the summary.

        Previously asserted `verified == 2` / `verified_cost == 1.5` for both, counting t2's dispatch
        pass. t1 is the only attested verification, so cost per attested task is the group's whole
        $3.00, and t2 surfaces in the separate `dispatch_pass` column.
        """
        metrics = [per_call(1.0, task_id='t1', policy_id='p1', ts='2026-09-21T10:00:00+00:00'),
                   per_call(2.0, task_id='t2', policy_id='p1', result='pass',
                            ts='2026-09-21T11:00:00+00:00')]
        outcomes = [{'task_id': 't1', 'outcome': 'verified'}]
        data = self.build(metrics, outcomes=outcomes)
        policy = next(p for p in data['policies'] if p['policy_id'] == 'p1')
        self.assertEqual(policy['verified'], 1)
        self.assertAlmostEqual(policy['verified_cost'], 3.0, places=6)
        self.assertEqual(policy['dispatch_pass'], 1)
        self.assertEqual(policy['rows'], 2)
        day = next(t for t in data['trends'] if t['day'] == '2026-09-21')
        self.assertEqual(day['verified'], 1)
        self.assertAlmostEqual(day['verified_cost'], 3.0, places=6)
        self.assertEqual(day['dispatch_pass'], 1)

    def test_the_rendered_page_labels_the_two_figures_distinguishably(self):
        """A reader must not be able to mistake a dispatch count for a verification count."""
        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory, [per_call(1.0, task_id='t1', result='pass')])
            html = generate_dashboard(directory, config={}).read_text(encoding='utf-8')
        self.assertIn('Verified tasks (attested verdict)', html)
        self.assertIn('Dispatch passes (exit 0 \u2014 NOT gate-verified)', html)
        # the bare, ambiguous card label is gone
        self.assertNotIn("['Verified tasks',", html)
        # both figures are wired to distinct summary keys
        self.assertIn('S.verified_tasks', html)
        self.assertIn('S.dispatch_pass_tasks', html)
        # and the tables distinguish their columns too
        self.assertIn('<th>Verified (attested)</th>', html)
        self.assertIn('<th>Dispatch pass (exit 0)</th>', html)
        # the page explains which signal each figure rests on
        self.assertIn('the dispatched subprocess exited 0', html)


class WasteAndOverheadTests(StreamCase):
    def test_waste_rate_counts_only_unsuccessful_retries_and_explicit_reasons(self):
        rows = [per_call(1.0, retry=1, result='fail'),
                per_call(2.0, retry=1, result='pass'),   # a retry that worked is not waste
                per_call(3.0, waste_reason='bad_plan_rework'),
                per_call(4.0)]
        summary = self.summary(rows)
        self.assertAlmostEqual(summary['waste_cost'], 4.0, places=6)
        self.assertAlmostEqual(summary['waste_rate'], 4.0 / 10.0, places=9)

    def test_waste_rate_is_no_data_when_nothing_was_spent(self):
        summary = self.summary([dict(ADAPTIVE_DECISION_ROW)])
        self.assertAlmostEqual(summary['waste_cost'], 0.0)
        self.assertTrue(is_no_data(summary['waste_rate']))

    def test_coordination_and_verification_overhead_are_reported_separately(self):
        rows = [per_call(1.0, role='lead'), per_call(3.0, role='technical_review'),
                per_call(6.0, role='implementation_fast')]
        summary = self.summary(rows)
        overhead = summary['orchestration_overhead']
        self.assertAlmostEqual(overhead['total_cost'], 10.0, places=6)
        self.assertAlmostEqual(overhead['coordination_cost'], 1.0, places=6)
        self.assertAlmostEqual(overhead['verification_cost'], 3.0, places=6)
        self.assertAlmostEqual(overhead['coordination_rate'], .1, places=9)
        self.assertAlmostEqual(overhead['verification_rate'], .3, places=9)
        # lifted onto the summary for the cards, with the same values
        self.assertAlmostEqual(summary['coordination_rate'], .1, places=9)
        self.assertAlmostEqual(summary['verification_rate'], .3, places=9)
        self.assertAlmostEqual(summary['coordination_cost'], 1.0, places=6)

    def test_flattened_overhead_fields_never_drift_from_the_nested_dict(self):
        """`coordination_rate`/`verification_rate`/`coordination_cost`/`verification_cost` are
        flattened onto `summary` in addition to living in `summary['orchestration_overhead']`.
        Both representations are assigned once, from the same dict, in `build_data`, so they cannot
        diverge today — but nothing stops a future edit from touching one copy and not the other.
        This test is the tripwire: any such edit fails it, on every fixture below, not just one.
        """
        fixtures = [
            [per_call(1.0, role='lead'), per_call(3.0, role='technical_review'),
             per_call(6.0, role='implementation_fast')],
            [dict(ADAPTIVE_DECISION_ROW)],  # empty-spend case: both copies must agree on NO_DATA too
            [per_call(1.0)],
        ]
        for rows in fixtures:
            summary = self.summary(rows)
            overhead = summary['orchestration_overhead']
            for key in ('coordination_rate', 'verification_rate', 'coordination_cost', 'verification_cost'):
                flat, nested = summary[key], overhead[key]
                if is_no_data(nested):
                    self.assertTrue(is_no_data(flat), f'{key} drifted: nested is NO_DATA, flat is {flat!r}')
                else:
                    self.assertEqual(flat, nested, f'{key} drifted between summary and orchestration_overhead')

    def test_overhead_rates_are_no_data_on_an_empty_stream(self):
        summary = self.summary([dict(ADAPTIVE_DECISION_ROW)])
        self.assertTrue(is_no_data(summary['coordination_rate']))
        self.assertTrue(is_no_data(summary['verification_rate']))


class UninstrumentedFieldTests(StreamCase):
    """The six cards that rendered a confident 0 for signals nothing in this repo writes."""

    def setUp(self):
        self.data = self.build([per_call(1.0), SESSION_AGGREGATE_ROW], events=[{'event': 'run_started'}])
        self.summary_ = self.data['summary']
        self.instrumentation = self.data['instrumentation']

    def test_uninstrumented_metrics_are_no_data_never_zero(self):
        for key in ('review_wait_p90_s', 'context_miss_rate', 'fanout_rework', 'conflicts',
                    'shadow_false_pass_rate', 'shadow_over_reject_rate'):
            self.assertTrue(is_no_data(self.summary_[key]), f'{key} rendered a confident value')

    def test_every_uninstrumented_key_is_labelled_not_instrumented_with_its_field(self):
        for key in ('review_wait_p90_s', 'context_miss_rate', 'fanout_rework', 'conflicts',
                    'shadow_false_pass_rate', 'shadow_over_reject_rate'):
            entry = self.instrumentation[key]
            self.assertFalse(entry['instrumented'], key)
            self.assertEqual(entry['label'], 'not instrumented', key)
            self.assertTrue(entry['field'], key)
            self.assertTrue(entry['note'], f'{key} must say why it is uninstrumented')

    def test_quality_evidence_has_a_producer_but_no_emitted_rows(self):
        # `Engine.verify_task` writes it, so `records.is_instrumented` is True; no live run calls it,
        # so the honest state is 'not emitted' rather than a 0 or a claim of no instrumentation.
        for key in ('quality', 'avg_quality_evidence'):
            entry = self.instrumentation[key]
            self.assertTrue(entry['instrumented'], key)
            self.assertEqual(entry['samples'], 0, key)
            self.assertEqual(entry['label'], 'not emitted', key)
        self.assertTrue(is_no_data(self.data['policies'][0]['quality']))

    def test_a_measured_value_clears_the_missing_label(self):
        data = self.build([per_call(1.0, quality_evidence_score=.9, review_wait_ms=2500),
                           per_call(1.0, quality_evidence_score=.7, review_wait_ms=1500),
                           {'event': 'context_packet'}, {'event': 'context_packet_miss'},
                           {'event': 'shadow_review', 'normal_pass': True, 'shadow_pass': False}],
                          events=[{'event': 'merge_conflict'},
                                  {'event': 'decision_invalidated', 'affected_tasks': 3}])
        summary = data['summary']
        # p90 of [1.5s, 2.5s] with linear interpolation
        self.assertAlmostEqual(summary['review_wait_p90_s'], 2.4, places=6)
        self.assertAlmostEqual(summary['context_miss_rate'], 1.0, places=6)
        self.assertEqual(summary['conflicts'], 1)
        self.assertAlmostEqual(summary['fanout_rework'], 3.0, places=6)
        self.assertAlmostEqual(summary['shadow_false_pass_rate'], 1.0, places=6)
        self.assertAlmostEqual(summary['shadow_over_reject_rate'], 0.0, places=6)
        self.assertIsNone(data['instrumentation']['quality']['label'])
        self.assertAlmostEqual(data['policies'][0]['quality'], .8, places=6)

    def test_a_measured_zero_survives_as_zero_and_is_not_no_data(self):
        data = self.build([per_call(1.0, quality_evidence_score=0.0, review_wait_ms=0),
                           {'event': 'context_packet'},
                           {'event': 'shadow_review', 'normal_pass': True, 'shadow_pass': True}])
        summary = data['summary']
        for key, expected in (('review_wait_p90_s', 0.0), ('context_miss_rate', 0.0),
                              ('shadow_false_pass_rate', 0.0), ('shadow_over_reject_rate', 0.0)):
            self.assertFalse(is_no_data(summary[key]), f'{key} lost a measured zero')
            self.assertAlmostEqual(summary[key], expected, places=9)
        self.assertEqual(data['policies'][0]['quality'], 0.0)
        self.assertFalse(is_no_data(data['policies'][0]['quality']))
        # and a measured zero serializes as 0, not null
        self.assertEqual(to_json(summary)['context_miss_rate'], 0.0)

    def test_the_registry_only_names_fields_the_records_seam_knows_about(self):
        from orchestrator import records
        for key, field in INSTRUMENTATION.items():
            known = field in records.INSTRUMENTED_FIELDS or field in records.UNINSTRUMENTED_FIELDS
            self.assertTrue(known or not records.is_instrumented(field),
                            f'{key} -> {field} is neither registered nor conservatively uninstrumented')


class AdaptiveSummaryTests(StreamCase):
    def test_action_counts_are_real_zeros_when_decisions_exist(self):
        summary = self.summary([dict(ADAPTIVE_DECISION_ROW), dict(ADAPTIVE_DECISION_ROW, explored=True,
                                                                 history_sufficient=True)])
        self.assertEqual(summary['adaptive_decisions'], 2)
        self.assertEqual(summary['adaptive_action_counts']['recommended_only'], 2)
        self.assertEqual(summary['adaptive_action_counts']['empirical_enforced'], 0)
        self.assertAlmostEqual(summary['exploration_rate_observed'], .5, places=9)
        self.assertAlmostEqual(summary['history_sufficient_rate'], .5, places=9)

    def test_rates_and_action_counts_are_no_data_without_any_decision(self):
        summary = self.summary([per_call(1.0)])
        self.assertEqual(summary['adaptive_decisions'], 0)
        self.assertTrue(is_no_data(summary['exploration_rate_observed']))
        self.assertTrue(is_no_data(summary['history_sufficient_rate']))
        self.assertTrue(is_no_data(summary['adaptive_action_counts']['recommended_only']))


class DelayedOutcomeTests(StreamCase):
    def test_stable_30d_failure_rate_is_no_data_without_mature_outcomes(self):
        summary = self.summary([per_call(1.0, task_id='t1')],
                               outcomes=[{'task_id': 't1', 'completed_at': '2099-01-01T00:00:00+00:00'}])
        self.assertTrue(is_no_data(summary['stable_30d_failure_rate']))


class SerializationContractTests(StreamCase):
    def test_no_data_becomes_null_and_zero_stays_zero_through_safe(self):
        summary = self.summary([per_call(0.0, cost_source='reported'), dict(ADAPTIVE_DECISION_ROW)])
        payload = json.loads(safe({'summary': to_json(summary)}).replace('<\\/', '</'))['summary']
        self.assertIsNone(payload['tail_ratio'])
        self.assertIsNone(payload['waste_rate'])
        self.assertEqual(payload['waste_cost'], 0.0)
        self.assertEqual(payload['adaptive_decisions'], 1)

    def test_safe_serializes_a_whole_build_data_payload_containing_sentinels(self):
        data = self.build([per_call(1.0, task_id='t1', result='pass'), SESSION_AGGREGATE_ROW,
                           dict(ROUTE_EXECUTED_ROW), dict(ADAPTIVE_DECISION_ROW)],
                          events=[{'event': 'run_started'}])
        text = safe(data)
        self.assertNotIn('NO_DATA', text)
        round_trip = json.loads(text.replace('<\\/', '</'))
        self.assertIsNone(round_trip['summary']['review_wait_p90_s'])
        # t1's `result: 'pass'` is dispatch evidence, so it counts as a dispatch pass and NOT as a
        # verification (this previously asserted verified_tasks == 1).
        self.assertEqual(round_trip['summary']['verified_tasks'], 0)
        self.assertEqual(round_trip['summary']['dispatch_pass_tasks'], 1)

    def test_every_summary_value_is_json_safe_and_finite(self):
        data = self.build([per_call(c) for c in (.01, 2.0)] + [SESSION_AGGREGATE_ROW])
        for key, value in to_json(data['summary']).items():
            if isinstance(value, float):
                self.assertTrue(math.isfinite(value), f'{key} is not finite')
            json.dumps({key: value})


class IngestStatusTests(unittest.TestCase):
    def test_status_contract_handles_success_partial_error_missing_malformed_stale_and_future(self):
        now = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)
        recent = (now - timedelta(minutes=1)).isoformat()
        stale = (now - timedelta(minutes=31)).isoformat()
        future = (now + timedelta(days=1)).isoformat()

        cases = [
            ({'status': 'ok', 'last_attempt_at': recent, 'last_success_at': recent,
              'emitted': 4, 'failure_count': 0, 'error': None, 'sweep_interval_seconds': 900},
             'ok', recent, recent, 4, 0, None, 1800),
            ({'status': 'partial', 'last_attempt_at': recent, 'last_success_at': stale,
              'emitted': 2, 'failure_count': 1, 'error': 'one file failed', 'sweep_interval_seconds': 900},
             'partial', recent, stale, 2, 1, 'one file failed', 1800),
            ({'status': 'error', 'last_attempt_at': stale, 'last_success_at': stale,
              'sweep_interval_seconds': 900}, 'error', stale, stale, 0, 0, None, 1800),
            ({'status': 'error', 'last_attempt_at': recent, 'last_success_at': recent,
              'emitted': 0, 'failure_count': 1, 'error': 'render failed'},
             'error', recent, recent, 0, 1, 'render failed', 1800),
            ({}, 'unknown', None, None, 0, 0, None, 1800),
            ({'status': ['ok'], 'last_attempt_at': recent, 'last_success_at': recent},
             'unknown', None, None, 0, 0, None, 1800),
            ({'status': 'ok', 'last_attempt_at': 'not-a-time', 'last_success_at': recent},
             'unknown', None, None, 0, 0, None, 1800),
            ({'status': 'ok', 'last_attempt_at': stale, 'last_success_at': stale,
              'sweep_interval_seconds': 900}, 'stale', stale, stale, 0, 0, None, 1800),
            ({'status': 'ok', 'last_attempt_at': future, 'last_success_at': future,
              'sweep_interval_seconds': 900}, 'ok', future, future, 0, 0, None, 1800),
        ]
        for raw, *expected in cases:
            with self.subTest(raw=raw):
                result = build_ingest_status(raw, now=now)
                self.assertEqual(set(result), {'status', 'last_attempt_at', 'last_success_at', 'emitted',
                                               'failure_count', 'error', 'stale_after_seconds'})
                self.assertEqual(list(result.values()), expected)

    def test_build_ingest_status_truncates_error_details(self):
        now = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)
        timestamp = now.isoformat()
        status = build_ingest_status({
            'status': 'error', 'last_attempt_at': timestamp, 'last_success_at': None,
            'error': 'x' * 700,
        }, now=now)

        self.assertEqual(status['status'], 'error')
        self.assertEqual(status['error'], 'x' * 500)

    def test_build_data_reads_status_and_render_escapes_status_values(self):
        timestamp = datetime.now(timezone.utc).isoformat()
        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory)
            Path(directory, 'ingest_status.json').write_text(json.dumps({
                'status': 'ok', 'last_attempt_at': timestamp,
                'last_success_at': timestamp, 'emitted': 3, 'failure_count': 1,
                'error': '<img src=x onerror=alert(1)>', 'sweep_interval_seconds': 900,
                'message': 'PRIVATE SESSION MESSAGE MUST NOT APPEAR',
            }), encoding='utf-8')
            data = build_data(Path(directory), config={})
            html = generate_dashboard(directory, config={}).read_text(encoding='utf-8')

        self.assertEqual(data['ingest_status']['status'], 'ok')
        self.assertIn('Session ingest health', html)
        self.assertIn('${esc(I.status)}', html)
        self.assertIn('${esc(I.error)}', html)
        self.assertNotIn('PRIVATE SESSION MESSAGE MUST NOT APPEAR', html)

    def test_missing_status_is_unknown_and_panel_says_not_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory)
            data = build_data(Path(directory), config={})
            html = generate_dashboard(directory, config={}).read_text(encoding='utf-8')
        self.assertEqual(data['ingest_status']['status'], 'unknown')
        self.assertIn('not reported', html)

    def test_generated_refresh_survives_unavailable_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory)
            html = generate_dashboard(directory, config={}).read_text(encoding='utf-8')
        self.assertIn("try{paused=localStorage.getItem('orch-pause')==='1';}catch{}", html)
        self.assertIn("try{sessionStorage.setItem('orch-scroll',String(window.scrollY));}catch{}", html)
        self.assertIn('try{const savedScroll=sessionStorage.getItem', html)
        self.assertIn('try{localStorage.setItem', html)
        self.assertIn('Pause auto-refresh', html)

    def test_failed_atomic_replacement_preserves_existing_dashboard_and_removes_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory)
            output = Path(directory, 'dashboard.html')
            original = b'previous usable dashboard'
            output.write_bytes(original)
            with patch('orchestrator.dashboard.os.replace', side_effect=OSError('forced replace failure')):
                with self.assertRaisesRegex(OSError, 'forced replace failure'):
                    generate_dashboard(directory, config={})
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual(list(Path(directory).glob('.dashboard.html.*.tmp')), [])


class RenderingTests(unittest.TestCase):
    """The HTML must not contain a formatter that turns a missing value into a number."""

    def test_no_coercion_of_null_to_zero_remains_in_the_embedded_javascript(self):
        from orchestrator.dashboard import generate_dashboard
        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory, [per_call(1.0), SESSION_AGGREGATE_ROW, dict(ROUTE_EXECUTED_ROW)])
            html = generate_dashboard(directory, config={}).read_text(encoding='utf-8')
        script = html.split('<script>', 1)[1]
        for banned in ('Number(S.tail_ratio||0)', 'Number(S.fanout_rework||0)',
                       'Number(S.review_wait_p90_s||0)', 'max(1e-9', 'Number(x||0).toLocaleString()'):
            self.assertNotIn(banned, script, f'{banned} can render a missing value as a number')
        # every summary value reaches the page through the one missing-aware formatter
        self.assertIn('const fmt=(k,x,f)=>', script)
        self.assertIn('not instrumented', html)
        self.assertRegex(script, re.compile(r'const miss=k=>'))

    def test_no_nullable_field_is_coerced_through_nz_or_n0(self):
        """`nz(x)`/`n0(x)` are `Number(x||0)...`: they assume a measured value and turn a missing
        one into a confident `0`. That exact coercion survived on `rate_provenance.dominant_rows`
        (`nz(RP.dominant_rows)` rendered a `NO_DATA` dominant-rows count as `0 priced rows`) even
        though `test_no_coercion_of_null_to_zero_remains_in_the_embedded_javascript` above was
        already passing — it only bans specific literal substrings, and `nz(...)` is not one of them.

        This test does not hardcode a field list. It builds a fixture designed to leave as much of
        `summary` as possible `NO_DATA` (no per-call rows, no estimated-cost rows, no adaptive
        decisions, no outcomes), collects every key that comes back `NO_DATA` under that fixture,
        and asserts none of those key names is ever passed directly to `nz(`/`n0(` in the rendered
        script — only through `fmt`/`m$`/`n$`/`p$`, which all route through `miss()`.
        """
        from orchestrator.dashboard import generate_dashboard

        # Guarded by `S.adaptive_decisions ? nz(n0(...)+n0(...)) : '—'` in the script: when these two
        # keys are `NO_DATA` (no adaptive decisions at all), the ternary's condition is false and the
        # `n0(...)` branch is never evaluated. Covered directly by `AdaptiveSummaryTests`.
        GUARDED = {'static_default', 'fallback_insufficient_history'}

        def nullable_keys(value, prefix=''):
            found = set()
            if is_no_data(value):
                if prefix:
                    found.add(prefix.rsplit('.', 1)[-1])
                return found
            if isinstance(value, dict):
                for k, v in value.items():
                    found |= nullable_keys(v, f'{prefix}.{k}' if prefix else k)
            return found

        with tempfile.TemporaryDirectory() as directory:
            write_stream(directory, [dict(ROUTE_EXECUTED_ROW)])
            data = build_data(Path(directory), config={})
            html = generate_dashboard(directory, config={}).read_text(encoding='utf-8')
        names = nullable_keys(data['summary']) - GUARDED
        self.assertIn('dominant_rows', names, 'fixture must reproduce the dominant_rows regression')
        script = html.split('<script>', 1)[1]
        for name in sorted(names):
            for coercer in ('nz(', 'n0('):
                pattern = re.compile(re.escape(coercer) + r"[\w.\[\]'\"]*\b" + re.escape(name) + r'\b')
                match = pattern.search(script)
                self.assertIsNone(match, f'found {match.group(0) if match else ""!r}: '
                                         f'{name!r} can be NO_DATA and must not reach {coercer}')


if __name__ == '__main__':
    unittest.main()

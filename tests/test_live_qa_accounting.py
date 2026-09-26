"""Phase 3 opt-in Forge live-QA verification stage: cost provenance, verification-role buckets,
dedup, and run-evidence surfacing.

Contract under test (bridge-authored rows, exact shape — see
docs/superpowers/goals/2026-09-25-all-in-one.md Phase 3 items 6-7):

* metrics `model_call` rows: agent row `record_id='live-qa-agent:<session_id>'`,
  `task_id='<run>-live-qa-stage'`, `role='live_qa'`, `capability='live_qa'`; optional app row
  `record_id='live-qa-app:<session_id>'`, `role='live_qa_app'`. `cost_usd` is ABSENT when the cost
  is unknown, never present as `0`.
* outcomes row: `task_id='<run>-live-qa-stage'`, `verification_scope='live_qa'`,
  `outcome='verified'|'fail'|'unavailable'`, `evidence_status`, `live_qa_verdict`,
  `tested_revision`, `tested_tree`, `checkpoint`, `session_id`, `findings`, `artifacts`.

This module deliberately re-uses the existing classification seams
(`orchestrator.economics.cost_class`, `._role_kind`/`_row_role_kind`, `orchestrator.records.
verification_evidence`, `orchestrator.economics.unique_records`) rather than adding a parallel
accounting path for live QA.
"""
import json
import unittest

from orchestrator.economics import (
    ESTIMATED,
    REPORTED,
    UNMETERED,
    cost_attribution,
    cost_class,
    nested_reconciliation,
    orchestration_overhead,
    unique_records,
)
from orchestrator.run_evidence import summarize_runs
from orchestrator import records


def agent_row(run_id, session_id, **kw):
    row = {
        'event': 'model_call', 'record_id': f'live-qa-agent:{session_id}', 'run_id': run_id,
        'task_id': f'{run_id}-live-qa-stage', 'role': 'live_qa', 'capability': 'live_qa',
        'live_qa_session_id': session_id, 'live_qa_adapter': 'forge', 'live_qa_component': 'agent',
        'runtime': 'humain-terminal', 'model': 'anthropic/claude-sonnet-4-5', 'provider': 'anthropic',
        'effort': 'standard', 'input_tokens': 1000, 'output_tokens': 200, 'cached_input_tokens': 0,
        'cache_write_tokens': 0, 'cost_provenance': 'forge-qa-usage.json-v2', 'result': 'pass',
    }
    row.update(kw)
    return row


def app_row(run_id, session_id, **kw):
    row = {
        'event': 'model_call', 'record_id': f'live-qa-app:{session_id}', 'run_id': run_id,
        'task_id': f'{run_id}-live-qa-stage', 'role': 'live_qa_app', 'capability': 'live_qa',
        'live_qa_session_id': session_id, 'live_qa_adapter': 'forge', 'live_qa_component': 'app_under_test',
        'runtime': 'humain-terminal', 'cost_provenance': 'forge-qa-usage.json-v2', 'result': 'pass',
    }
    row.update(kw)
    return row


def outcome_row(run_id, session_id, outcome='verified', **kw):
    row = {
        'run_id': run_id, 'task_id': f'{run_id}-live-qa-stage', 'verification_scope': 'live_qa',
        'outcome': outcome, 'evidence_status': 'verified' if outcome == 'verified' else 'unverified_live_qa_unavailable',
        'live_qa_verdict': outcome, 'tested_revision': 'deadbeef', 'tested_tree': 'clean',
        'checkpoint': 'ckpt-1', 'session_id': session_id, 'findings': [], 'artifacts': [],
        'required': True, 'outcome_finality': 'immediate',
    }
    row.update(kw)
    return row


# --- 1. Cost classes ----------------------------------------------------------------------------

class CostClassTests(unittest.TestCase):
    def test_reported_forge_runs_cost_microcents_is_reported_when_cost_positive(self):
        row = {'cost_usd': 1.23, 'cost_source': 'reported-forge-runs-cost-microcents'}
        self.assertEqual(cost_class(row), REPORTED)

    def test_reported_forge_runs_cost_microcents_is_reported_when_tokens_present(self):
        row = {'cost_source': 'reported-forge-runs-cost-microcents', 'input_tokens': 50, 'output_tokens': 10}
        self.assertEqual(cost_class(row), REPORTED)

    def test_reported_forge_runs_cost_microcents_with_nothing_measured_is_unmetered(self):
        row = {'cost_source': 'reported-forge-runs-cost-microcents'}
        self.assertEqual(cost_class(row), UNMETERED)

    def test_estimated_forge_qa_runtime_catalog_is_estimated(self):
        row = {'cost_usd': 0.4, 'cost_source': 'estimated-forge-qa-runtime-catalog'}
        self.assertEqual(cost_class(row), ESTIMATED)

    def test_unknown_not_reported_by_qa_runtime_is_unmetered(self):
        row = {'cost_source': 'unknown-not-reported-by-qa-runtime'}
        self.assertEqual(cost_class(row), UNMETERED)

    def test_unknown_forge_runs_query_failed_is_unmetered(self):
        row = {'cost_source': 'unknown-forge-runs-query-failed'}
        self.assertEqual(cost_class(row), UNMETERED)

    def test_unknown_sources_never_read_as_metered_even_with_a_stray_cost_usd(self):
        # Contract says cost_usd is absent when unknown; prove the classifier does not depend on
        # that absence — an unknown provenance is never spend, whatever cost_usd happens to hold.
        row = {'cost_usd': 3.0, 'cost_source': 'unknown-forge-runs-query-failed'}
        self.assertEqual(cost_class(row), UNMETERED)


# --- 2. Role buckets -----------------------------------------------------------------------------

class RoleBucketTests(unittest.TestCase):
    def test_live_qa_agent_row_counts_as_verification_spend(self):
        rows = [agent_row('r1', 's1', cost_usd=0.5, cost_source='reported-forge-runs-cost-microcents')]
        overhead = orchestration_overhead(rows)
        self.assertAlmostEqual(overhead['verification_cost'], 0.5)
        self.assertEqual(overhead['coordination_cost'], 0.0)

    def test_live_qa_app_row_counts_as_verification_spend(self):
        rows = [app_row('r1', 's1', cost_usd=0.2, cost_source='reported-forge-runs-cost-microcents')]
        overhead = orchestration_overhead(rows)
        self.assertAlmostEqual(overhead['verification_cost'], 0.2)

    def test_live_qa_agent_and_app_rows_together_are_all_verification(self):
        rows = [
            agent_row('r1', 's1', cost_usd=0.5, cost_source='reported-forge-runs-cost-microcents'),
            app_row('r1', 's1', cost_usd=0.2, cost_source='reported-forge-runs-cost-microcents'),
        ]
        overhead = orchestration_overhead(rows)
        self.assertAlmostEqual(overhead['verification_cost'], 0.7)
        self.assertAlmostEqual(overhead['total_cost'], 0.7)


# --- 3. Dedup, components, unknown-cost coverage -------------------------------------------------

class DedupTests(unittest.TestCase):
    def test_duplicate_delivery_of_the_same_record_id_is_counted_once(self):
        row = agent_row('r1', 's1', cost_usd=0.5, cost_source='reported-forge-runs-cost-microcents')
        rows = [row, dict(row)]  # re-parsed / re-delivered, identical record_id
        deduped = list(unique_records(rows))
        self.assertEqual(len(deduped), 1)
        attribution = cost_attribution(rows)
        self.assertEqual(attribution[REPORTED]['calls'], 1)
        self.assertAlmostEqual(attribution[REPORTED]['cost'], 0.5)

    def test_agent_and_app_rows_for_the_same_session_are_both_counted_not_double_counted(self):
        a = agent_row('r1', 's1', cost_usd=0.5, cost_source='reported-forge-runs-cost-microcents')
        app = app_row('r1', 's1', cost_usd=0.2, cost_source='reported-forge-runs-cost-microcents')
        rows = [a, app, dict(a), dict(app)]  # each delivered twice
        attribution = cost_attribution(rows)
        self.assertEqual(attribution[REPORTED]['calls'], 2)
        self.assertAlmostEqual(attribution[REPORTED]['cost'], 0.7)

    def test_unknown_cost_rows_increase_unmetered_coverage_and_add_zero_known_spend(self):
        rows = [
            agent_row('r1', 's1', cost_source='unknown-not-reported-by-qa-runtime'),
            app_row('r1', 's1', cost_source='unknown-forge-runs-query-failed'),
        ]
        attribution = cost_attribution(rows)
        self.assertEqual(attribution[UNMETERED]['calls'], 2)
        self.assertEqual(attribution[REPORTED]['calls'], 0)
        self.assertEqual(attribution[ESTIMATED]['calls'], 0)
        self.assertEqual(attribution[UNMETERED]['cost'], 0.0)
        # coverage excludes unmetered rows from the numerator, not from the denominator
        self.assertEqual(attribution['coverage'], 0.0)
        self.assertEqual(attribution['call_rows'], 2)

    def test_live_qa_rows_are_never_grouped_into_a_nested_reconciliation_residual(self):
        # Live-QA rows are never `nested: true` detail rows and are never tied to any
        # `dispatch_finished` event (live QA is not dispatched via dispatchParallel at all) —
        # `nested_reconciliation` groups purely by `dispatch_finished` events, so these rows can
        # never be swept into a residual no matter how many of them (or duplicate deliveries)
        # are present.
        a = agent_row('r1', 's1', cost_usd=0.5, cost_source='reported-forge-runs-cost-microcents')
        app = app_row('r1', 's1', cost_usd=0.2, cost_source='reported-forge-runs-cost-microcents')
        rows = [a, app, dict(a), dict(app)]
        result = nested_reconciliation([], rows)
        self.assertEqual(result['rows'], [])
        self.assertEqual(result['ambiguous'], [])
        self.assertEqual(result['ambiguous_count'], 0)

    def test_a_real_dispatch_finished_event_in_the_same_run_does_not_absorb_live_qa_rows(self):
        # A run that also dispatched ordinary work (with its own nested residual gap) must not
        # have that gap satisfied by, or attributed to, the unrelated live-QA rows in the same run.
        events = [{
            'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 'lead-1',
            'nested_cost_usd': 1.0, 'nested_rows_emitted': 1,
        }]
        rows = [
            agent_row('r1', 's1', cost_usd=0.5, cost_source='reported-forge-runs-cost-microcents'),
        ]
        result = nested_reconciliation(events, rows)
        # The dispatch_finished event claimed 1 durable row but none of the live-QA rows are
        # `nested: true` detail rows for it, so the gap is booked as a residual for THAT event—
        # never satisfied by the live-QA rows, and the live-QA rows themselves produce nothing.
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['rows'][0]['parent_task_id'], 'lead-1')
        self.assertAlmostEqual(result['rows'][0]['cost_usd'], 1.0)


# --- 4. Run evidence: live_qa surfaced separately, unavailable never verified --------------------

class RunEvidenceTests(unittest.TestCase):
    def test_live_qa_outcome_surfaces_as_its_own_evidence_item(self):
        metrics = [agent_row('r1', 's1', cost_usd=0.5, cost_source='reported-forge-runs-cost-microcents')]
        outcomes = [outcome_row('r1', 's1', outcome='verified', findings=[{'severity': 'low'}], artifacts=['a.png'])]
        run = {r['run_id']: r for r in summarize_runs(metrics, [], outcomes)}['r1']
        self.assertIsNotNone(run['live_qa'])
        self.assertEqual(run['live_qa']['outcome'], 'verified')
        self.assertEqual(run['live_qa']['evidence_status'], 'verified')
        self.assertEqual(run['live_qa']['verdict'], 'verified')
        self.assertEqual(run['live_qa']['tested_revision'], 'deadbeef')
        self.assertEqual(run['live_qa']['checkpoint'], 'ckpt-1')
        self.assertEqual(run['live_qa']['session_id'], 's1')
        self.assertEqual(run['live_qa']['findings_count'], 1)
        self.assertEqual(run['live_qa']['artifacts_count'], 1)

    def test_unavailable_live_qa_never_reads_as_verified(self):
        outcomes = [outcome_row('r1', 's1', outcome='unavailable')]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['live_qa']['outcome'], 'unavailable')
        # Unavailable is not a recognised verdict spelling: it must not attest a verified task.
        state, strength = records.verification_evidence(outcomes[0])
        self.assertIsNone(state)
        self.assertNotEqual((state, strength), (records.VERIFIED, records.ATTESTED))
        # And it must not have joined the generic per-task verification population at all.
        self.assertEqual(run['verification'], 'unknown')
        self.assertEqual(run['verified_tasks'], 0)

    def test_verified_live_qa_does_not_by_itself_flip_the_run_verdict(self):
        # The bridge's generic run-scoped QA gate says failed; a passed live-QA stage must not
        # override that: `verification` and `verified_tasks` come only from the generic gate/
        # ordinary task join, never from `live_qa`.
        outcomes = [
            outcome_row('r1', 's1', outcome='verified'),
            {'run_id': 'r1', 'task_id': 'r1-qa', 'outcome': 'fail', 'verification_scope': 'run'},
        ]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'failed')
        self.assertEqual(run['verified_tasks'], 0)
        self.assertIsNotNone(run['live_qa'])
        self.assertEqual(run['live_qa']['outcome'], 'verified')

    def test_required_and_unavailable_live_qa_reads_as_unverified_not_verified(self):
        # Mirrors the bridge's `completeRun` summary.live_qa contract
        # (bridge/extensions/orchestrator/index.ts, `composeVerificationVerdict`): a required
        # adapter that could not run is UNVERIFIED, never a pass, on both sides of the bridge.
        outcomes = [outcome_row('r1', 's1', outcome='unavailable', required=True)]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['live_qa']['outcome'], 'unavailable')
        self.assertEqual(run['live_qa']['required'], True)
        state, strength = records.verification_evidence(outcomes[0])
        self.assertNotEqual((state, strength), (records.VERIFIED, records.ATTESTED))

    def test_live_qa_task_id_does_not_end_in_qa_and_is_not_mistaken_for_the_generic_gate(self):
        tid = 'r1-live-qa-stage'
        self.assertFalse(tid.endswith('-qa'))

    def test_run_with_no_live_qa_rows_has_no_live_qa_key_and_unchanged_baseline_shape(self):
        # T1: a run with no `verification_scope: 'live_qa'` outcome row gets NO `live_qa` key at
        # all (not even `None`) -- the exact pre-Phase-3 key set.
        metrics = [
            {'event': 'model_call', 'run_id': 'r1', 'task_id': 'r1-t1', 'role': 'worker',
             'cost_usd': .02, 'cost_source': 'reported', 'input_tokens': 100, 'output_tokens': 50},
        ]
        run = {r['run_id']: r for r in summarize_runs(metrics, [], [])}['r1']
        self.assertNotIn('live_qa', run)
        self.assertEqual(run['call_rows'], 1)
        self.assertAlmostEqual(run['cost_known_usd'], .02)


class RunVerdictAuthorityTests(unittest.TestCase):
    """T2: the live-QA outcome and the terminal run-complete verdict have AUTHORITY over a
    generic `*-qa` PASS row -- a required+unavailable or a failed live-QA stage must never read
    as a passed run just because the generic gate passed, and a terminal
    `verification_passed: false` must never be shadowed by an earlier passed generic row."""

    def _generic_pass(self, run_id='r1'):
        return {'run_id': run_id, 'task_id': f'{run_id}-qa', 'outcome': 'verified',
                'verification_scope': 'run', 'verification': True}

    def test_generic_pass_plus_required_unavailable_live_qa_is_unknown_not_passed(self):
        outcomes = [self._generic_pass(), outcome_row('r1', 's1', outcome='unavailable', required=True)]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'unknown')

    def test_generic_pass_plus_live_qa_fail_is_failed(self):
        outcomes = [self._generic_pass(), outcome_row('r1', 's1', outcome='fail', required=True)]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'failed')

    def test_generic_pass_plus_non_required_unavailable_live_qa_is_unchanged(self):
        outcomes = [self._generic_pass(), outcome_row('r1', 's1', outcome='unavailable', required=False)]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'passed')

    def test_generic_pass_plus_live_qa_pass_is_unchanged(self):
        outcomes = [self._generic_pass(), outcome_row('r1', 's1', outcome='verified', required=True)]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'passed')

    def test_terminal_verification_passed_false_overrides_an_earlier_generic_pass_row(self):
        outcomes = [
            self._generic_pass(),
            {'run_id': 'r1', 'task_id': 'run-complete', 'outcome': 'fail',
             'note': json.dumps({'verification_passed': False})},
        ]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'failed')

    def test_terminal_false_plus_required_unavailable_live_qa_is_unknown_not_failed(self):
        # T3 (escalated fix-round 2): the REAL required-unavailable path -- terminal
        # `verification_passed: false` AND a required live-QA stage that is `unavailable` AND a
        # generic `*-qa` gate that itself PASSED -- must read as unverified ('unknown'), never as
        # a passed run, but also never as a quality FAILURE: the terminal false is presumed to be
        # reporting exactly this required-but-unavailable live-QA stage, not an independently
        # corroborated failure (nothing else here says 'fail').
        outcomes = [
            self._generic_pass(),
            outcome_row('r1', 's1', outcome='unavailable', required=True),
            {'run_id': 'r1', 'task_id': 'run-complete', 'outcome': 'fail',
             'note': json.dumps({'verification_passed': False})},
        ]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'unknown')

    def test_live_qa_fail_still_wins_over_terminal_false_and_required_unavailable_framing(self):
        # A genuine live-QA FAIL is never softened to 'unknown' by this T3 change.
        outcomes = [
            self._generic_pass(),
            outcome_row('r1', 's1', outcome='fail', required=True),
            {'run_id': 'r1', 'task_id': 'run-complete', 'outcome': 'fail',
             'note': json.dumps({'verification_passed': False})},
        ]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'failed')

    def test_terminal_false_corroborated_by_a_failed_generic_gate_plus_required_unavailable_stays_failed(self):
        # When the generic `*-qa` gate ITSELF failed (not merely the terminal note), the required-
        # unavailable live-QA stage does not soften that into 'unknown' -- there is independent
        # corroboration of a real quality failure here, unlike the T3 scenario above.
        outcomes = [
            {'run_id': 'r1', 'task_id': 'r1-qa', 'outcome': 'fail', 'verification_scope': 'run'},
            outcome_row('r1', 's1', outcome='unavailable', required=True),
            {'run_id': 'r1', 'task_id': 'run-complete', 'outcome': 'fail',
             'note': json.dumps({'verification_passed': False})},
        ]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'failed')

    def test_terminal_false_without_any_live_qa_row_stays_failed(self):
        # Mirrors the escalated task's "terminal false without a live-QA explanation -> failed as
        # before": with no `verification_scope: 'live_qa'` outcome row at all, this is unchanged.
        outcomes = [
            self._generic_pass(),
            {'run_id': 'r1', 'task_id': 'run-complete', 'outcome': 'fail',
             'note': json.dumps({'verification_passed': False})},
        ]
        run = {r['run_id']: r for r in summarize_runs([], [], outcomes)}['r1']
        self.assertEqual(run['verification'], 'failed')
        self.assertNotIn('live_qa', run)


if __name__ == '__main__':
    unittest.main()

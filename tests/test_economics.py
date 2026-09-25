"""Numeric correctness tests for `orchestrator.economics`.

Fixtures mirror row shapes read out of the live state dir
(~/.local/state/coding-agent-orchestrator/metrics.jsonl), trimmed to the keys under test. The live
row that motivates most of this file is `SUCCESSFUL_RETRY_SESSION_ROW`: a $10.12 whole-session
aggregate carrying `retry: 1` *and* `result: 'pass'`, which the old `waste_cost` charged as 100%
waste and the old percentiles averaged in as a single "call".
"""
import unittest

from orchestrator import economics, method, records
from orchestrator.economics import (COORDINATION, ESTIMATED, REPORTED, UNMETERED, VERIFICATION,
                                    coordination_roles, cost_attribution, cost_distribution,
                                    fanout_rework, is_call_row, is_unsuccessful_attempt,
                                    orchestration_overhead, per_call_costs, quantile, row_cost,
                                    verification_roles, verified_cost, waste_cost)
from orchestrator.records import NO_DATA

PER_CALL_ROW = {
    'agent_runtime': 'humain-terminal', 'call_id': 'a3c1f0d29b7e4415', 'cost_rate_model': 'gpt-6-astra',
    'cost_source': 'estimated-from-reported-tokens', 'cost_usd': 0.1834, 'event': 'model_call',
    'granularity': 'call', 'input_tokens': 13492, 'model': 'gpt-6-astra', 'output_tokens': 902,
    'role': 'implementation_fast', 'ts': '2026-09-21T16:17:21.684Z',
}

# $85.99 of the $103.46 orchestrated total sits in rows shaped like this one.
SESSION_AGGREGATE_ROW = {
    'agent_runtime': 'humain-terminal', 'cost_source': 'estimated-from-reported-tokens',
    'cost_usd': 3.94303, 'covers_calls': 29, 'event': 'model_call', 'granularity': 'session',
    'input_tokens': 5704180, 'model': 'claude-opus-5', 'output_tokens': 33834, 'role': 'lead',
}

# A whole session recorded as one "call": 33,177,381 input tokens, a retry that *passed*.
SUCCESSFUL_RETRY_SESSION_ROW = {
    'agent_runtime': 'claude-code', 'capability_class': 'technical_review', 'cost_source': 'provider_reported',
    'cost_usd': 10.12, 'event': 'model_call', 'input_tokens': 33177381,
    'legacy_source': '/Users/x/.claude/projects/-Users-x-forge/.orchestrator', 'model': 'sonnet',
    'output_tokens': 55803, 'result': 'pass', 'retry': 1, 'role': 'qa_agent',
    'task_id': 'qa-claude-code-focused-run',
}

ROUTE_EXECUTED_ROW = {
    'agent_runtime': 'humain-terminal', 'capability_class': 'implementation_fast', 'event': 'route_executed',
    'executed_cost_usd': 0.0082065, 'executed_passes': True, 'task_id': 'triage-reply-with-one-sentence',
}

ADAPTIVE_DECISION_ROW = {
    'adaptive_mode': 'recommend', 'capability_class': 'architect', 'event': 'adaptive_route_decision',
    'route_action': 'recommended_only', 'selected_capability': 'implementation_fast',
}

UNMETERED_ROW = {
    'event': 'orchestration_telemetry_migration', 'role': 'technical_review', 'cost_source': 'unmetered',
}


class RowCostSeamTests(unittest.TestCase):
    def test_row_cost_is_the_records_definition_not_a_second_copy(self):
        self.assertIs(row_cost, records.row_cost)

    def test_the_dependency_points_one_way_only(self):
        # records must never import economics: economics imports records, and a cycle would break
        # `from orchestrator import records` for every consumer.
        import inspect
        source = inspect.getsource(records)
        self.assertNotIn('import economics', source)
        self.assertNotIn('from .economics', source)

    def test_all_three_cost_fields_are_summed(self):
        row = {'cost_usd': .25, 'ci_cost_usd': .5, 'human_cost_usd': 1.0}
        self.assertAlmostEqual(row_cost(row), 1.75)
        self.assertAlmostEqual(verified_cost([row, PER_CALL_ROW]), 1.75 + .1834)


class PopulationDistinctionTests(unittest.TestCase):
    """`is_call_row` and `records.is_per_call_cost_row` have deliberately different jobs."""

    def test_an_explicitly_unmetered_row_stays_in_the_coverage_denominator(self):
        self.assertTrue(is_call_row(UNMETERED_ROW))
        self.assertFalse(records.is_per_call_cost_row(UNMETERED_ROW))

    def test_a_session_aggregate_is_accountable_for_cost_but_is_not_a_cost_sample(self):
        self.assertTrue(is_call_row(SESSION_AGGREGATE_ROW))
        self.assertFalse(records.is_per_call_cost_row(SESSION_AGGREGATE_ROW))

    def test_an_event_row_is_neither(self):
        self.assertFalse(is_call_row(ADAPTIVE_DECISION_ROW))
        self.assertFalse(records.is_per_call_cost_row(ADAPTIVE_DECISION_ROW))


class PerCallDistributionTests(unittest.TestCase):
    def test_session_aggregates_and_event_rows_never_join_a_per_call_population(self):
        rows = [PER_CALL_ROW, SESSION_AGGREGATE_ROW, SUCCESSFUL_RETRY_SESSION_ROW,
                ROUTE_EXECUTED_ROW, ADAPTIVE_DECISION_ROW, UNMETERED_ROW]
        self.assertEqual(per_call_costs(rows), [0.1834])
        distribution = cost_distribution(rows)
        self.assertEqual(distribution['samples'], 1)
        self.assertAlmostEqual(distribution['p50_cost'], .1834)
        self.assertAlmostEqual(distribution['p99_cost'], .1834)
        # the excluded aggregate spend stays visible rather than disappearing
        self.assertEqual(distribution['session_rows'], 2)
        self.assertAlmostEqual(distribution['session_cost'], 3.94303 + 10.12)

    def test_a_33m_token_aggregate_cannot_move_the_median(self):
        calls = [{'event': 'model_call', 'cost_usd': c, 'granularity': 'call'} for c in (.1, .2, .3)]
        with_aggregate = cost_distribution(calls + [SUCCESSFUL_RETRY_SESSION_ROW])
        self.assertAlmostEqual(with_aggregate['p50_cost'], .2)
        self.assertAlmostEqual(with_aggregate['mean_cost'], .2)
        self.assertAlmostEqual(with_aggregate['max_cost'], .3)
        self.assertEqual(with_aggregate['samples'], 3)

    def test_every_statistic_is_no_data_without_a_single_per_call_sample(self):
        distribution = cost_distribution([ADAPTIVE_DECISION_ROW, ROUTE_EXECUTED_ROW, UNMETERED_ROW])
        self.assertEqual(distribution['samples'], 0)
        for key in ('mean_cost', 'p50_cost', 'p90_cost', 'p99_cost', 'max_cost'):
            self.assertIs(distribution[key], NO_DATA, key)

    def test_quantile_of_an_empty_population_is_no_data_not_zero(self):
        self.assertIs(quantile([], .5), NO_DATA)
        self.assertAlmostEqual(quantile([.1, .2, .3], .5), .2)


class CostAttributionTests(unittest.TestCase):
    def test_coverage_is_no_data_when_no_row_is_accountable_for_cost(self):
        summary = cost_attribution([ADAPTIVE_DECISION_ROW])
        self.assertEqual(summary['call_rows'], 0)
        self.assertIs(summary['coverage'], NO_DATA)

    def test_a_measured_zero_coverage_is_still_zero(self):
        summary = cost_attribution([UNMETERED_ROW])
        self.assertEqual(summary[UNMETERED]['calls'], 1)
        self.assertEqual(summary['coverage'], 0.0)
        self.assertIsNot(summary['coverage'], NO_DATA)

    def test_rows_and_calls_are_reported_separately(self):
        summary = cost_attribution([PER_CALL_ROW, SESSION_AGGREGATE_ROW])
        self.assertEqual(summary['call_rows'], 2)
        self.assertEqual(summary['covered_calls'], 1 + 29)
        self.assertAlmostEqual(summary[ESTIMATED]['cost'], .1834 + 3.94303)
        self.assertEqual(summary[REPORTED]['calls'], 0)


class WasteTests(unittest.TestCase):
    def test_a_retry_that_succeeded_is_not_waste(self):
        self.assertFalse(is_unsuccessful_attempt(SUCCESSFUL_RETRY_SESSION_ROW))
        self.assertEqual(waste_cost([SUCCESSFUL_RETRY_SESSION_ROW]), {})

    def test_a_retry_that_failed_is_waste(self):
        row = {**SUCCESSFUL_RETRY_SESSION_ROW, 'result': 'fail'}
        self.assertTrue(is_unsuccessful_attempt(row))
        self.assertAlmostEqual(waste_cost([row])['retry'], 10.12)

    def test_a_retry_verified_through_the_outcomes_vocabulary_is_not_waste(self):
        verified = {'event': 'model_call', 'cost_usd': .4, 'retry': 2, 'outcome': 'verified'}
        blocked = {'event': 'model_call', 'cost_usd': .4, 'retry': 2, 'outcome': 'blocked'}
        self.assertEqual(waste_cost([verified]), {})
        self.assertAlmostEqual(waste_cost([blocked])['retry'], .4)

    def test_a_retry_that_states_no_verdict_is_treated_as_unsuccessful(self):
        self.assertAlmostEqual(waste_cost([{'event': 'model_call', 'cost_usd': .4, 'retry': 1}])['retry'], .4)

    def test_an_explicit_waste_reason_stays_authoritative_over_a_successful_retry(self):
        row = {**SUCCESSFUL_RETRY_SESSION_ROW, 'waste_reason': 'abandoned_branch'}
        self.assertAlmostEqual(waste_cost([row])['abandoned_branch'], 10.12)
        self.assertNotIn('retry', waste_cost([row]))

    def test_inherently_wasteful_events_are_still_categorized(self):
        rows = [{'event': 'branch_abandoned', 'cost_usd': .5},
                {'event': 'rework', 'cost_usd': .25, 'ci_cost_usd': .25}]
        waste = waste_cost(rows)
        self.assertAlmostEqual(waste['branch_abandoned'], .5)
        self.assertAlmostEqual(waste['rework'], .5)

    def test_waste_is_empty_rather_than_zero_valued_for_a_clean_stream(self):
        self.assertEqual(waste_cost([PER_CALL_ROW, ADAPTIVE_DECISION_ROW]), {})


class RoleVocabularyTests(unittest.TestCase):
    def test_lead_is_coordination(self):
        # $13.07 across 63 live rows — the most common coordination role, previously uncounted.
        self.assertIn('lead', coordination_roles())
        self.assertIn('technical_lead', coordination_roles())
        self.assertIn('architect', coordination_roles())
        # Every triage lead size is coordination spend, not just `lead`.
        self.assertIn('lead_small', coordination_roles())
        self.assertIn('lead_large', coordination_roles())

    def test_review_is_verification_not_coordination(self):
        for role in ('technical_review', 'integration_review', 'security_review', 'qa_agent', 'qa',
                     'qa_worker', 'reviewer'):
            self.assertIn(role, verification_roles(), role)
            self.assertNotIn(role, coordination_roles(), role)

    def test_production_roles_are_in_neither_bucket(self):
        for role in ('implementer', 'complex_implementer', 'implementation_fast',
                     'implementation_strong', 'scout', 'worker'):
            self.assertNotIn(role, coordination_roles(), role)
            self.assertNotIn(role, verification_roles(), role)

    def test_the_vocabulary_is_derived_from_method_json_not_copied(self):
        roles = method.roles()
        # every verifier role and the capability it resolves to must land in the verification bucket
        for role, capability in roles.items():
            if role.endswith('verifier'):
                self.assertIn(role, verification_roles(), role)
                self.assertIn(capability, verification_roles(), capability)
        self.assertIn(roles['architect'], coordination_roles())
        self.assertIn(roles['technical_lead'], coordination_roles())


class OrchestrationOverheadTests(unittest.TestCase):
    def _rows(self):
        return [
            {'event': 'model_call', 'role': 'lead', 'cost_usd': 13.07},
            {'event': 'model_call', 'role': 'technical_lead', 'cost_usd': 3.98},
            {'event': 'model_call', 'role': 'technical_review', 'cost_usd': 2.0},
            {'event': 'model_call', 'capability_class': 'security_review', 'cost_usd': 1.0},
            {'event': 'model_call', 'role': 'implementation_strong', 'cost_usd': 30.0},
        ]

    def test_lead_is_counted_as_coordination(self):
        summary = orchestration_overhead(self._rows())
        self.assertAlmostEqual(summary['coordination_cost'], 13.07 + 3.98)
        self.assertAlmostEqual(summary['total_cost'], 50.05)
        self.assertAlmostEqual(summary['coordination_rate'], (13.07 + 3.98) / 50.05)

    def test_verification_is_reported_separately_and_never_pooled_into_coordination(self):
        summary = orchestration_overhead(self._rows())
        self.assertAlmostEqual(summary['verification_cost'], 3.0)
        self.assertAlmostEqual(summary['verification_rate'], 3.0 / 50.05)
        self.assertNotAlmostEqual(summary['coordination_rate'], (13.07 + 3.98 + 3.0) / 50.05)

    def test_production_spend_is_neither_coordination_nor_verification(self):
        summary = orchestration_overhead([{'event': 'model_call', 'role': 'implementer', 'cost_usd': 5.0}])
        self.assertEqual(summary['coordination_cost'], 0.0)
        self.assertEqual(summary['verification_cost'], 0.0)
        self.assertEqual(summary['coordination_rate'], 0.0)

    def test_coordination_events_count_even_without_a_role(self):
        rows = [{'event': 'merge_conflict_resolution', 'cost_usd': 1.0},
                {'event': 'model_call', 'role': 'implementer', 'cost_usd': 1.0}]
        self.assertAlmostEqual(orchestration_overhead(rows)['coordination_rate'], .5)

    def test_both_rates_are_no_data_when_nothing_was_spent(self):
        summary = orchestration_overhead([ADAPTIVE_DECISION_ROW, ROUTE_EXECUTED_ROW])
        self.assertIs(summary['coordination_rate'], NO_DATA)
        self.assertIs(summary['verification_rate'], NO_DATA)
        self.assertEqual(summary['total_cost'], 0.0)

    def test_an_empty_stream_yields_no_data_not_zero(self):
        self.assertIs(orchestration_overhead([])['coordination_rate'], NO_DATA)

    def test_all_three_cost_fields_count_toward_overhead(self):
        rows = [{'event': 'model_call', 'role': 'lead', 'cost_usd': 1.0, 'human_cost_usd': 1.0},
                {'event': 'model_call', 'role': 'implementer', 'cost_usd': 2.0}]
        summary = orchestration_overhead(rows)
        self.assertAlmostEqual(summary['coordination_cost'], 2.0)
        self.assertAlmostEqual(summary['coordination_rate'], .5)


class FanoutReworkTests(unittest.TestCase):
    def test_averages_affected_tasks_per_invalidation(self):
        self.assertEqual(fanout_rework([{'event': 'decision_invalidated', 'affected_tasks': 4}]), 4)
        self.assertAlmostEqual(fanout_rework([{'event': 'decision_invalidated', 'affected_tasks': 4},
                                              {'event': 'decision_invalidated', 'affected_tasks': 1}]), 2.5)

    def test_no_invalidations_is_no_data_not_a_measured_zero(self):
        self.assertIs(fanout_rework([]), NO_DATA)
        self.assertIs(fanout_rework([{'event': 'route_executed'}]), NO_DATA)


class TopologyRegretTests(unittest.TestCase):
    def test_declines_to_guess_without_a_comparable(self):
        self.assertIsNone(economics.topology_regret({'verified_cost_usd': 1.0, 'stable_quality': .9}, []))
        self.assertIsNone(economics.topology_regret({'stable_quality': .9}, []))

    def test_regret_is_the_gap_to_the_cheapest_equal_quality_topology(self):
        current = {'verified_cost_usd': 1.0, 'stable_quality': .9}
        comparable = [{'verified_cost_usd': .4, 'stable_quality': .9}, {'verified_cost_usd': .1, 'stable_quality': .5}]
        self.assertAlmostEqual(economics.topology_regret(current, comparable), .6)


class NestedResidualRowsTests(unittest.TestCase):
    """Phase 1 items 2-3: `dispatch_finished.nested_cost_usd` must reach totals exactly once,
    never twice, and never as a guessed real role."""

    def test_no_dispatch_finished_events_yields_nothing(self):
        self.assertEqual(economics.nested_residual_rows([], []), [])

    def test_a_zero_or_missing_nested_cost_synthesizes_nothing(self):
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 0},
                  {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't2'}]
        self.assertEqual(economics.nested_residual_rows(events, []), [])

    def test_positive_nested_cost_with_no_detail_rows_becomes_one_unknown_nested_residual(self):
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 4.19}]
        residuals = economics.nested_residual_rows(events, [])
        self.assertEqual(len(residuals), 1)
        row = residuals[0]
        self.assertEqual(row['role'], 'unknown_nested')
        self.assertEqual(row['capability_class'], 'unknown_nested')
        self.assertAlmostEqual(row_cost(row), 4.19)
        self.assertEqual(row['cost_source'], 'reported')
        self.assertTrue(row['nested'])
        self.assertEqual(row['parent_task_id'], 't1')

    def test_full_write_nested_rows_emitted_matches_durable_rows_and_reconciles_exactly(self):
        # Phase 1 review T3: `nested_rows_emitted` alone must never suppress the residual — only a
        # durable detail row sum that actually EXPLAINS the aggregate does.
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1',
                   'nested_cost_usd': 4.19, 'nested_rows_emitted': 1}]
        calls = [{'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't1', 'nested': True,
                  'role': 'implementation_strong', 'cost_usd': 4.19}]
        self.assertEqual(economics.nested_residual_rows(events, calls), [])
        reconciled = economics.nested_reconciliation(events, calls)
        self.assertEqual(reconciled['ambiguous'], [])

    def test_partial_write_books_only_the_shortfall_not_the_full_aggregate(self):
        # Phase 1 review T3 (the confirmed bug): the old rule suppressed the ENTIRE residual
        # whenever `nested_rows_emitted > 0` or even one matching detail row existed, so a crash
        # between writing detail row 1 and detail row 2 of a claimed 2 lost the second row's
        # dollars forever. The fix books exactly the unexplained remainder.
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1',
                   'nested_cost_usd': 4.19, 'nested_rows_emitted': 2}]
        calls = [{'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't1', 'nested': True,
                  'role': 'implementation_strong', 'cost_usd': 1.19}]
        residuals = economics.nested_residual_rows(events, calls)
        self.assertEqual(len(residuals), 1)
        self.assertAlmostEqual(row_cost(residuals[0]), 3.0)
        self.assertEqual(residuals[0]['role'], 'unknown_nested')
        reconciled = economics.nested_reconciliation(events, calls)
        self.assertEqual(reconciled['ambiguous'], [])

    def test_unexplained_mismatch_books_nothing_but_is_reported_ambiguous(self):
        # The claimed row count IS fully durable, yet the dollars still don't add up. Booking a
        # residual here would be a guess (which of the N rows is wrong, or is the aggregate
        # itself wrong?) — so nothing is added to totals, but the mismatch is surfaced.
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1',
                   'nested_cost_usd': 4.19, 'nested_rows_emitted': 1}]
        calls = [{'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't1', 'nested': True,
                  'role': 'implementation_strong', 'cost_usd': 1.0}]
        self.assertEqual(economics.nested_residual_rows(events, calls), [])
        reconciled = economics.nested_reconciliation(events, calls)
        self.assertEqual(reconciled['rows'], [])
        self.assertEqual(reconciled['ambiguous_count'], 1)
        ambiguous = reconciled['ambiguous'][0]
        self.assertEqual(ambiguous['run_id'], 'r1')
        self.assertEqual(ambiguous['task_id'], 't1')
        self.assertEqual(ambiguous['dispatch_attempt'], 0)
        self.assertAlmostEqual(ambiguous['aggregate_usd'], 4.19)
        self.assertAlmostEqual(ambiguous['detail_usd'], 1.0)
        self.assertAlmostEqual(ambiguous['gap_usd'], 3.19)
        self.assertEqual(ambiguous['nested_rows_emitted'], 1)
        self.assertEqual(ambiguous['durable_rows_found'], 1)

    def test_dispatch_attempt_keeps_a_quota_fallbacks_two_dispatch_finished_events_independent(self):
        # Phase 1 review T1: a codex -> Bedrock quota fallback writes TWO `dispatch_finished`
        # events for the SAME task_id, each carrying only its own attempt's nested cost. Keying
        # reconciliation on `(run_id, task_id)` alone would let one attempt's detail rows satisfy
        # the OTHER attempt's aggregate; `dispatch_attempt` keeps them independent.
        events = [
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 0,
             'nested_cost_usd': 2.0, 'nested_rows_emitted': 1},
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 1,
             'nested_cost_usd': 5.0, 'nested_rows_emitted': 1},
        ]
        calls = [
            {'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't1', 'dispatch_attempt': 0,
             'nested': True, 'role': 'implementation_strong', 'cost_usd': 2.0},
            {'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't1', 'dispatch_attempt': 1,
             'nested': True, 'role': 'implementation_strong', 'cost_usd': 5.0},
        ]
        self.assertEqual(economics.nested_residual_rows(events, calls), [])
        reconciled = economics.nested_reconciliation(events, calls)
        self.assertEqual(reconciled['ambiguous'], [])

        # If attempt 1's detail row were missing, attempt 0's row must not mask that gap.
        residuals = economics.nested_residual_rows(events, calls[:1])
        self.assertEqual(len(residuals), 1)
        self.assertEqual(residuals[0]['dispatch_attempt'], 1)
        self.assertAlmostEqual(row_cost(residuals[0]), 5.0)

    def test_an_actual_detail_row_suppresses_the_residual_even_without_the_emitted_count(self):
        # Durability net: an older event written before `nested_rows_emitted` existed, but detail
        # rows for its dispatch are demonstrably present.
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 4.19}]
        calls = [{'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't1', 'nested': True,
                  'role': 'implementation_strong', 'cost_usd': 4.19}]
        self.assertEqual(economics.nested_residual_rows(events, calls), [])

    def test_detail_rows_for_a_different_dispatch_do_not_suppress_this_ones_residual(self):
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 4.19}]
        calls = [{'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't-other', 'nested': True,
                  'role': 'implementation_strong', 'cost_usd': 1.0}]
        residuals = economics.nested_residual_rows(events, calls)
        self.assertEqual(len(residuals), 1)

    def test_nested_detail_rows_flow_into_totals_by_role_and_coordination_rate(self):
        # A lead's own row (coordination) plus one nested implementer detail row (production,
        # neither coordination nor verification): total spend and coordination_rate must both
        # move once the detail row is present, and the detail row's real role participates in
        # `by_role`-style aggregation the same way `dashboard.py` performs it.
        own = {'event': 'model_call', 'run_id': 'r1', 'task_id': 't1', 'role': 'lead', 'cost_usd': 1.0}
        nested_detail = {'event': 'model_call', 'run_id': 'r1', 'task_id': 't1:impl-0', 'parent_task_id': 't1',
                          'role': 'implementation_strong', 'cost_usd': 4.19, 'nested': True, 'cost_source': 'reported'}
        without_nested = orchestration_overhead([own])
        with_nested = orchestration_overhead([own, nested_detail])
        self.assertAlmostEqual(without_nested['total_cost'], 1.0)
        self.assertAlmostEqual(with_nested['total_cost'], 5.19)
        self.assertAlmostEqual(without_nested['coordination_rate'], 1.0)
        # implementation_strong is production work, not coordination, so the rate DROPS once the
        # nested spend (previously invisible) enters the denominator without joining the numerator.
        self.assertAlmostEqual(with_nested['coordination_rate'], 1.0 / 5.19)

    def test_a_residual_and_its_own_detail_rows_are_never_summed_together(self):
        # If a caller mistakenly ran nested_residual_rows twice against a growing rows list that
        # already contains its own prior output, the SECOND call must still refuse to double it:
        # the residual row it already added carries `parent_task_id` equal to the dispatch's own
        # task_id, which the detail-row scan already treats as authoritative.
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 4.19}]
        first_pass = economics.nested_residual_rows(events, [])
        self.assertEqual(len(first_pass), 1)
        second_pass = economics.nested_residual_rows(events, first_pass)
        self.assertEqual(second_pass, [])


class DispatchAttemptValidationTests(unittest.TestCase):
    """Phase 1 review F4: `dispatch_attempt` must validate (finite, integral, 0<=n<=16); malformed
    input reads as ambiguous/unprovable, never crashes and never masquerades as a trustworthy
    identity."""

    def test_plain_ints_in_range_are_valid(self):
        self.assertEqual(economics._valid_dispatch_attempt(0), 0)
        self.assertEqual(economics._valid_dispatch_attempt(1), 1)
        self.assertEqual(economics._valid_dispatch_attempt(16), 16)

    def test_integral_floats_are_accepted_as_their_int_value(self):
        self.assertEqual(economics._valid_dispatch_attempt(1.0), 1)

    def test_out_of_range_is_invalid(self):
        self.assertIsNone(economics._valid_dispatch_attempt(17))
        self.assertIsNone(economics._valid_dispatch_attempt(-1))

    def test_non_integral_float_is_invalid(self):
        self.assertIsNone(economics._valid_dispatch_attempt(1.5))

    def test_infinity_and_nan_never_crash_and_are_invalid(self):
        self.assertIsNone(economics._valid_dispatch_attempt(float('inf')))
        self.assertIsNone(economics._valid_dispatch_attempt(float('-inf')))
        self.assertIsNone(economics._valid_dispatch_attempt(float('nan')))

    def test_strings_and_bools_are_invalid(self):
        self.assertIsNone(economics._valid_dispatch_attempt('1'))
        self.assertIsNone(economics._valid_dispatch_attempt(True))
        self.assertIsNone(economics._valid_dispatch_attempt(None))

    def test_dispatch_attempt_defaults_malformed_to_zero_never_crashes(self):
        self.assertEqual(economics._dispatch_attempt({'dispatch_attempt': float('inf')}), 0)
        self.assertEqual(economics._dispatch_attempt({'dispatch_attempt': 'bogus'}), 0)
        self.assertEqual(economics._dispatch_attempt({}), 0)


class DynamicAmbiguityGroupingTests(unittest.TestCase):
    """Phase 1 review F1: dynamic reconciliation must apply the SAME ambiguity rule the backfill
    script applies to historical data — a (run_id, task_id) group of dispatch_finished events that
    cannot be proven to carry pairwise-distinct dispatch_attempt values must never get a residual
    booked for any of its members, and is reported as one ambiguous entry naming the event count
    and the total aggregate dollars at stake."""

    def test_two_events_missing_dispatch_attempt_book_nothing_and_are_reported_ambiguous(self):
        events = [
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 2.0},
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 3.0},
        ]
        self.assertEqual(economics.nested_residual_rows(events, []), [])
        reconciled = economics.nested_reconciliation(events, [])
        self.assertEqual(reconciled['rows'], [])
        self.assertEqual(reconciled['ambiguous_count'], 1)
        entry = reconciled['ambiguous'][0]
        self.assertEqual(entry['run_id'], 'r1')
        self.assertEqual(entry['task_id'], 't1')
        self.assertEqual(entry['events'], 2)
        self.assertAlmostEqual(entry['aggregate_usd'], 5.0)
        self.assertIn('cumulative-sum', entry['reason'])

    def test_old_bug_cumulative_sum_shape_books_nothing_even_with_full_detail_coverage(self):
        # The historical bug: the SECOND event's nested_cost_usd is the SUM of both attempts.
        # Even though durable detail rows exist that would fully reconcile the FIRST event alone,
        # the pair as a whole is unprovable, so nothing is booked for either.
        events = [
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 2.0,
             'superseded_by_fallback': True},
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 9.0},
        ]
        calls = [{'event': 'model_call', 'run_id': 'r1', 'parent_task_id': 't1', 'nested': True,
                 'role': 'implementation_strong', 'cost_usd': 2.0}]
        self.assertEqual(economics.nested_residual_rows(events, calls), [])
        reconciled = economics.nested_reconciliation(events, calls)
        self.assertEqual(reconciled['ambiguous_count'], 1)
        self.assertAlmostEqual(reconciled['ambiguous'][0]['aggregate_usd'], 11.0)

    def test_two_events_with_the_same_explicit_attempt_are_ambiguous_not_booked(self):
        events = [
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 0,
             'nested_cost_usd': 2.0},
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 0,
             'nested_cost_usd': 3.0},
        ]
        reconciled = economics.nested_reconciliation(events, [])
        self.assertEqual(reconciled['rows'], [])
        self.assertEqual(reconciled['ambiguous_count'], 1)

    def test_more_than_two_events_sharing_a_task_id_are_ambiguous(self):
        events = [
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 0,
             'nested_cost_usd': 1.0},
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 1,
             'nested_cost_usd': 2.0},
            {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 2,
             'nested_cost_usd': 3.0},
        ]
        reconciled = economics.nested_reconciliation(events, [])
        self.assertEqual(reconciled['rows'], [])
        self.assertEqual(reconciled['ambiguous_count'], 1)
        self.assertEqual(reconciled['ambiguous'][0]['events'], 3)

    def test_a_malformed_dispatch_attempt_on_one_event_makes_the_pair_unprovable(self):
        # F1 + F4 together: a NaN/Infinity/string dispatch_attempt on one event of a pair must not
        # crash, and must not be trusted as "distinct from the other" — it makes the pair exactly
        # as unprovable as a missing field would.
        for bad in (float('nan'), float('inf'), 'not-a-number', 1.5):
            with self.subTest(bad=bad):
                events = [
                    {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': bad,
                     'nested_cost_usd': 2.0},
                    {'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'dispatch_attempt': 1,
                     'nested_cost_usd': 3.0},
                ]
                reconciled = economics.nested_reconciliation(events, [])
                self.assertEqual(reconciled['rows'], [])
                self.assertEqual(reconciled['ambiguous_count'], 1)

    def test_a_single_event_group_is_still_separable_and_reconciles_normally(self):
        # Sanity: the new grouping pre-pass must not regress the single-event (overwhelming
        # majority) case.
        events = [{'event': 'dispatch_finished', 'run_id': 'r1', 'task_id': 't1', 'nested_cost_usd': 4.19}]
        residuals = economics.nested_residual_rows(events, [])
        self.assertEqual(len(residuals), 1)
        self.assertAlmostEqual(row_cost(residuals[0]), 4.19)


if __name__ == '__main__':
    unittest.main()

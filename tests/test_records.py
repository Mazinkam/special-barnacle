import json
import pickle
import unittest

from orchestrator.records import (ATTESTED, CALL, DISPATCH, EVENT, INSTRUMENTED_FIELDS, NO_DATA,
                                  NON_COST_EVENTS, NO_VERIFICATION, SESSION, UNINSTRUMENTED_FIELDS,
                                  VerificationEvidence, classify, covered_calls, is_attested_verified,
                                  is_dispatch_pass, is_instrumented, is_no_data, is_per_call_cost_row,
                                  is_task_attested_verified, json_default, metric, ratio,
                                  resolve_task_verification, row_cost, to_json,
                                  verification_evidence, verification_state)

# Fixtures below mirror row shapes read out of the live state dir
# (~/.local/state/coding-agent-orchestrator/{metrics,outcomes}.jsonl), trimmed to the keys under test.

PER_CALL_ROW = {
    'agent_runtime': 'humain-terminal', 'call_id': 'a3c1f0d29b7e4415', 'cached_input_tokens': 12000,
    'cost_rate_model': 'gpt-6-astra', 'cost_source': 'estimated-from-reported-tokens', 'cost_usd': 0.1834,
    'event': 'model_call', 'granularity': 'call', 'input_tokens': 13492, 'model': 'gpt-6-astra',
    'output_tokens': 902, 'provider': 'openai-codex', 'role': 'interactive_session',
    'session_id': '01a0c4c1-294e-7118-b0fa-00c337e73b91', 'ts': '2026-09-21T16:17:21.684Z',
}

SESSION_AGGREGATE_ROW = {
    'agent_runtime': 'humain-terminal', 'cache_write_tokens': 39174, 'cached_input_tokens': 5704124,
    'call_id': 'f01dd5351106bd57', 'cost_rate_model': 'claude-opus-5',
    'cost_source': 'estimated-from-reported-tokens', 'cost_usd': 3.94303, 'covers_calls': 29,
    'event': 'model_call', 'first_ts': '2026-09-21T15:44:06.607Z', 'granularity': 'session',
    'ingest_source': '/Users/x/.humain-terminal/agent/sessions/2026-09-21T15-43-43-579Z.jsonl',
    'input_tokens': 5704180, 'model': 'claude-opus-5', 'output_tokens': 33834,
    'reasoning_output_tokens': 8909, 'role': 'interactive_session',
}

# The single worst row in the live stream: a whole session's usage recorded as one "call".
LEGACY_SESSION_ROW = {
    'agent_runtime': 'claude-code', 'capability_class': 'technical_review', 'complexity': 6,
    'cost_source': 'provider_reported', 'cost_usd': 10.12, 'duration_ms': 1113703, 'effort': 'standard',
    'event': 'model_call', 'input_tokens': 33177381,
    'legacy_source': '/Users/x/.claude/projects/-Users-x-forge/orchestrator/.orchestrator',
    'model': 'sonnet', 'output_tokens': 55803, 'policy_id': 'qa-runtime', 'provider': 'anthropic',
    'result': 'pass', 'retry': 1, 'risk': 'medium', 'role': 'qa_agent', 'run_id': 'hier-orch-impl',
    'task_class': 'qa_verification', 'task_id': 'qa-claude-code-focused-run',
    'ts': '2026-09-18T14:25:01.642809+00:00', 'verification_depth': 'full',
}

ROUTE_EXECUTED_ROW = {
    'adaptive_mode': 'triage', 'agent_runtime': 'humain-terminal', 'capability_class': 'implementation_fast',
    'complexity': 1, 'event': 'route_executed', 'executed_cost_usd': 0.0082065, 'executed_effort': 'standard',
    'executed_input_tokens': 9, 'executed_model': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'executed_output_tokens': 433, 'executed_passes': True, 'executed_verification_depth': 'targeted',
    'plan_id': 'triage', 'recommended_capability': 'implementation_fast', 'risk': 'low',
    'run_id': 'triage-1790062177313', 'task_class': 'triage', 'task_id': 'triage-reply-with-one-sentence',
    'ts': '2026-09-22T07:29:37.614523+00:00',
}

ADAPTIVE_DECISION_ROW = {
    'adaptive_mode': 'recommend', 'agent_runtime': 'humain-terminal', 'canary': False, 'complexity': 3.0,
    'cost_aggressiveness': 0.7, 'event': 'adaptive_route_decision', 'explored': False,
    'historical_samples': 0, 'history_sufficient': False, 'policy_id': '8ae7b99435e24efa',
    'quality_floor': 0.95, 'recommended_estimated_verified_cost_usd': 0.1632, 'risk': 'low',
    'route_action': 'recommended_only', 'selected_capability': 'implementation_fast',
    'run_id': 'hier-dashboard-attribution-20260921', 'ts': '2026-09-21T15:55:21.324703+00:00',
}


class GranularityTests(unittest.TestCase):
    def test_a_plain_model_call_is_call_granularity(self):
        self.assertEqual(classify(PER_CALL_ROW), CALL)
        self.assertEqual(classify({'event': 'model_call', 'cost_usd': .5}), CALL)

    def test_an_unrecognized_row_falls_back_to_call(self):
        self.assertEqual(classify({'metric': 'qa_runs_valid', 'value': 4, 'unit': 'count'}), CALL)

    def test_covers_calls_granularity_and_legacy_source_each_mark_a_session_aggregate(self):
        self.assertEqual(classify(SESSION_AGGREGATE_ROW), SESSION)
        self.assertEqual(classify(LEGACY_SESSION_ROW), SESSION)
        self.assertEqual(classify({'event': 'model_call', 'granularity': 'session'}), SESSION)
        self.assertEqual(classify({'event': 'model_call', 'covers_calls': 29}), SESSION)

    def test_covers_calls_of_one_still_declares_session_granularity(self):
        # live ingest stamps covers_calls: 1 on single-call sessions; granularity says the same thing
        self.assertEqual(classify({'event': 'model_call', 'covers_calls': 1, 'granularity': 'session'}), SESSION)

    def test_non_cost_orchestration_records_are_events(self):
        self.assertEqual(classify(ROUTE_EXECUTED_ROW), EVENT)
        self.assertEqual(classify(ADAPTIVE_DECISION_ROW), EVENT)
        for name in NON_COST_EVENTS:
            self.assertEqual(classify({'event': name}), EVENT, name)

    def test_route_executed_is_an_event_despite_carrying_executed_cost(self):
        self.assertNotIn('cost_usd', ROUTE_EXECUTED_ROW)
        self.assertEqual(row_cost(ROUTE_EXECUTED_ROW), 0.0)
        self.assertEqual(classify(ROUTE_EXECUTED_ROW), EVENT)

    def test_session_precedence_beats_event_precedence(self):
        # the legacy stream stamped legacy_source onto adaptive_route_decision rows too
        legacy_event = {**ADAPTIVE_DECISION_ROW, 'legacy_source': '/Users/x/.claude/projects/forge'}
        self.assertEqual(classify(legacy_event), SESSION)


class CoveredCallsTests(unittest.TestCase):
    def test_reports_the_calls_an_aggregate_stands_for(self):
        self.assertEqual(covered_calls(SESSION_AGGREGATE_ROW), 29)

    def test_defaults_to_one_call_per_row(self):
        self.assertEqual(covered_calls(PER_CALL_ROW), 1)
        self.assertEqual(covered_calls(ROUTE_EXECUTED_ROW), 1)
        self.assertEqual(covered_calls({}), 1)

    def test_absent_zero_or_unparseable_values_never_erase_a_row(self):
        self.assertEqual(covered_calls({'covers_calls': 0}), 1)
        self.assertEqual(covered_calls({'covers_calls': None}), 1)
        self.assertEqual(covered_calls({'covers_calls': -3}), 1)
        self.assertEqual(covered_calls({'covers_calls': 'n/a'}), 1)

    def test_numeric_strings_are_accepted(self):
        self.assertEqual(covered_calls({'covers_calls': '29'}), 29)


class RowCostTests(unittest.TestCase):
    def test_sums_model_ci_and_human_cost(self):
        self.assertAlmostEqual(row_cost({'cost_usd': 1.5, 'ci_cost_usd': .25, 'human_cost_usd': 2}), 3.75)

    def test_tolerates_none_empty_strings_and_junk(self):
        self.assertEqual(row_cost({}), 0.0)
        self.assertEqual(row_cost({'cost_usd': None, 'ci_cost_usd': ''}), 0.0)
        self.assertEqual(row_cost({'cost_usd': 'n/a'}), 0.0)
        self.assertAlmostEqual(row_cost({'cost_usd': '0.1834'}), .1834)


class PerCallCostPopulationTests(unittest.TestCase):
    def test_includes_only_cost_bearing_per_call_rows(self):
        self.assertTrue(is_per_call_cost_row(PER_CALL_ROW))

    def test_excludes_session_aggregates_even_though_they_carry_cost(self):
        self.assertGreater(row_cost(SESSION_AGGREGATE_ROW), 0)
        self.assertFalse(is_per_call_cost_row(SESSION_AGGREGATE_ROW))
        self.assertFalse(is_per_call_cost_row(LEGACY_SESSION_ROW))

    def test_excludes_event_rows_that_would_drag_p50_to_zero(self):
        self.assertFalse(is_per_call_cost_row(ROUTE_EXECUTED_ROW))
        self.assertFalse(is_per_call_cost_row(ADAPTIVE_DECISION_ROW))

    def test_excludes_unmetered_calls_which_carry_no_measurement(self):
        self.assertFalse(is_per_call_cost_row({'event': 'model_call', 'cost_source': 'unmetered'}))
        self.assertFalse(is_per_call_cost_row({'event': 'model_call', 'cost_usd': 0}))

    def test_percentile_population_matches_the_live_mix(self):
        rows = [PER_CALL_ROW, SESSION_AGGREGATE_ROW, LEGACY_SESSION_ROW, ROUTE_EXECUTED_ROW,
                ADAPTIVE_DECISION_ROW]
        self.assertEqual([r for r in rows if is_per_call_cost_row(r)], [PER_CALL_ROW])


class VerificationVocabularyTests(unittest.TestCase):
    def test_metrics_stream_result_spellings(self):
        self.assertEqual(verification_state({'event': 'model_call', 'result': 'pass'}), 'verified')
        self.assertEqual(verification_state({'event': 'model_call', 'result': 'fail'}), 'failed')
        self.assertEqual(verification_state({'metric': 'qa_scopes_complete', 'result': 'partial'}), 'partial')
        self.assertEqual(verification_state({'event': 'model_call', 'result': 'verified'}), 'verified')

    def test_outcomes_stream_outcome_spellings(self):
        self.assertEqual(verification_state({'outcome': 'verified', 'task_id': 'fanout-fix'}), 'verified')
        self.assertEqual(verification_state({'outcome': 'fail'}), 'failed')
        self.assertEqual(verification_state({'outcome': 'blocked', 'kind': 'delayed'}), 'failed')
        self.assertEqual(verification_state({'outcome': 'partial', 'kind': 'delayed'}), 'partial')
        self.assertEqual(verification_state({'outcome': 'success', 'kind': 'delayed'}), 'verified')

    def test_boolean_success_is_honoured(self):
        self.assertEqual(verification_state({'success': True, 'quality': .94}), 'verified')
        self.assertEqual(verification_state({'success': False, 'kind': 'delayed'}), 'failed')

    def test_canonical_events_outrank_field_values(self):
        self.assertEqual(verification_state({'event': 'task_verified', 'task_id': 'T-1'}), 'verified')
        self.assertEqual(verification_state({'event': 'task_failed', 'task_id': 'T-1'}), 'failed')
        self.assertEqual(verification_state({'event': 'task_verified', 'result': 'fail'}), 'verified')

    def test_outcome_outranks_result_and_success(self):
        row = {'outcome': 'partial', 'result': 'pass', 'success': True}
        self.assertEqual(verification_state(row), 'partial')

    def test_case_and_whitespace_are_tolerated(self):
        self.assertEqual(verification_state({'outcome': ' Verified '}), 'verified')
        self.assertEqual(verification_state({'result': 'FAILED'}), 'failed')

    def test_unrecognized_spellings_fall_through_rather_than_guessing(self):
        # live row: result 'pass_with_residuals' with an explicit success flag alongside it
        self.assertEqual(verification_state({'result': 'pass_with_residuals', 'success': True}), 'verified')
        self.assertIsNone(verification_state({'result': 'pass_with_residuals'}))

    def test_absent_or_unknown_verdicts_are_none_not_failure(self):
        self.assertIsNone(verification_state({}))
        self.assertIsNone(verification_state(PER_CALL_ROW))
        self.assertIsNone(verification_state(ROUTE_EXECUTED_ROW))
        self.assertIsNone(verification_state({'kind': 'delivery', 'quality': 'good'}))
        self.assertIsNone(verification_state({'status': 'implemented'}))
        self.assertIsNone(verification_state({'outcome': None, 'result': None}))

    def test_a_legacy_session_row_still_reports_its_attempt_verdict(self):
        self.assertEqual(verification_state(LEGACY_SESSION_ROW), 'verified')
        # ...but only as DISPATCH evidence: `result: 'pass'` is this row's sole verdict signal.
        self.assertEqual(verification_evidence(LEGACY_SESSION_ROW).strength, DISPATCH)
        self.assertFalse(is_attested_verified(LEGACY_SESSION_ROW))


class EvidenceStrengthTests(unittest.TestCase):
    """The 18-vs-164 split: a dispatch exit code is not a verification verdict.

    On the live stream 164 task ids have a dispatch `result == 'pass'` while only 18 have an attested
    verified verdict. Pooling them reported `Verified tasks 174` and populated `verified_cost_usd`
    for 75 of 85 route groups. These tests exist to stop that pooling being reintroduced.
    """

    def test_a_dispatch_result_is_dispatch_strength_not_attested(self):
        for row in ({'event': 'model_call', 'result': 'pass'},
                    {'event': 'model_call', 'result': 'fail'},
                    {'event': 'model_call', 'result': 'verified'}):
            with self.subTest(row=row):
                self.assertEqual(verification_evidence(row).strength, DISPATCH)
                self.assertFalse(is_attested_verified(row))

    def test_a_dispatch_pass_is_reported_as_a_dispatch_pass(self):
        self.assertTrue(is_dispatch_pass({'event': 'model_call', 'result': 'pass'}))
        self.assertFalse(is_dispatch_pass({'event': 'model_call', 'result': 'fail'}))

    def test_outcomes_verdict_fields_attest(self):
        for row in ({'outcome': 'verified'}, {'success': True}, {'outcome': 'fail'},
                    {'success': False, 'kind': 'delayed'}):
            with self.subTest(row=row):
                self.assertEqual(verification_evidence(row).strength, ATTESTED)
        self.assertTrue(is_attested_verified({'outcome': 'verified'}))
        self.assertTrue(is_attested_verified({'success': True}))
        # an attested verdict is never also counted as a dispatch pass
        self.assertFalse(is_dispatch_pass({'outcome': 'verified'}))

    def test_run_scoped_outcomes_do_not_attest_a_task_verification(self):
        row = {'task_id': 'run-1-qa', 'outcome': 'verified', 'verification_scope': 'run'}
        self.assertEqual(verification_evidence(row), NO_VERIFICATION)
        self.assertFalse(is_attested_verified(row))
        self.assertFalse(is_task_attested_verified([row]))

    def test_canonical_events_attest_even_on_a_metrics_row(self):
        """Strength is data-driven from the row's shape, not from which file it came from."""
        row = {'event': 'task_verified', 'task_id': 'T-1', 'cost_usd': .02, 'agent_runtime': 'humain-terminal'}
        self.assertEqual(verification_evidence(row), VerificationEvidence('verified', ATTESTED))
        self.assertTrue(is_attested_verified(row))
        self.assertEqual(verification_evidence({'event': 'task_failed', 'task_id': 'T-1'}),
                         VerificationEvidence('failed', ATTESTED))

    def test_an_attested_verdict_outranks_a_dispatch_result_on_the_same_row(self):
        self.assertEqual(verification_evidence({'result': 'pass', 'outcome': 'partial'}),
                         VerificationEvidence('partial', ATTESTED))
        self.assertEqual(verification_evidence({'result': 'pass', 'success': False}),
                         VerificationEvidence('failed', ATTESTED))
        self.assertEqual(verification_evidence({'event': 'task_verified', 'result': 'fail'}),
                         VerificationEvidence('verified', ATTESTED))

    def test_no_claim_has_neither_state_nor_strength(self):
        for row in ({}, PER_CALL_ROW, ROUTE_EXECUTED_ROW, {'status': 'implemented'},
                    {'kind': 'delivery'}, {'result': 'pass_with_residuals'}):
            with self.subTest(row=row):
                self.assertEqual(verification_evidence(row), NO_VERIFICATION)
                self.assertIsNone(verification_evidence(row).strength)
                self.assertFalse(is_attested_verified(row))
                self.assertFalse(is_dispatch_pass(row))

    def test_strength_is_none_exactly_when_state_is_none(self):
        for row in ({}, {'result': 'pass'}, {'outcome': 'verified'}, {'event': 'task_failed'},
                    {'result': 'junk'}, PER_CALL_ROW, LEGACY_SESSION_ROW):
            with self.subTest(row=row):
                state, strength = verification_evidence(row)
                self.assertEqual(state is None, strength is None)
                if strength is not None:
                    self.assertIn(strength, (ATTESTED, DISPATCH))

    def test_verification_state_keeps_its_return_contract(self):
        """Existing callers must keep working: same verdicts, strength simply not reported."""
        for row in ({'result': 'pass'}, {'outcome': 'verified'}, {'success': True},
                    {'event': 'task_verified'}, {'result': 'fail'}, {'outcome': 'partial'}, {}):
            with self.subTest(row=row):
                self.assertEqual(verification_state(row), verification_evidence(row).state)


class ConservativeTaskResolutionTests(unittest.TestCase):
    """Contradictory attested evidence about one task must resolve to *not verified*.

    Reproduced against the bridge: a QA dispatch that exited 0 while reporting failed checks wrote an
    attested `task_verified` metrics row and an `outcome: 'fail'` outcomes row under the same
    `task_id`, and a reader scanning for "any attested verified row" counted the task as VERIFIED.
    `resolve_task_verification` is the one place that contradiction is adjudicated, and it breaks
    toward failure because an over-count of verified tasks is the defect this branch exists to remove.
    """

    QA_VERIFIED_METRIC = {'event': 'task_verified', 'task_id': 'run-1-qa', 'run_id': 'run-1'}
    QA_FAILED_OUTCOME = {'task_id': 'run-1-qa', 'outcome': 'fail', 'quality': 0.0}

    def test_an_attested_failure_beats_an_attested_verification_for_the_same_task(self):
        contradiction = [self.QA_VERIFIED_METRIC, self.QA_FAILED_OUTCOME]
        self.assertEqual(resolve_task_verification(contradiction),
                         VerificationEvidence('failed', ATTESTED))
        self.assertFalse(is_task_attested_verified(contradiction))
        # ...and the per-row helper genuinely does read that pair as verified, which is why the
        # task-level resolution has to exist rather than callers scanning rows themselves.
        self.assertTrue(any(is_attested_verified(r) for r in contradiction))

    def test_resolution_is_order_independent(self):
        forwards = [self.QA_VERIFIED_METRIC, self.QA_FAILED_OUTCOME]
        self.assertEqual(resolve_task_verification(forwards),
                         resolve_task_verification(list(reversed(forwards))))

    def test_an_attested_partial_also_beats_an_attested_verification(self):
        rows = [{'outcome': 'verified'}, {'outcome': 'partial'}]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('partial', ATTESTED))
        self.assertFalse(is_task_attested_verified(rows))

    def test_failed_outranks_partial_when_both_are_attested(self):
        rows = [{'outcome': 'partial'}, {'outcome': 'verified'}, {'success': False}]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('failed', ATTESTED))

    def test_consistent_attested_verifications_still_resolve_to_verified(self):
        rows = [{'outcome': 'verified'}, {'event': 'task_verified'}, {'success': True}]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('verified', ATTESTED))
        self.assertTrue(is_task_attested_verified(rows))

    def test_a_dispatch_exit_code_never_overrides_an_attested_verdict(self):
        """Retries make dispatch failures normal; letting them veto attestation would zero the metric.

        A task whose first attempt exited non-zero and which then verified is verified. Conservatism
        applies *within* an evidence strength, not across — across strengths, attestation wins.
        """
        rows = [{'event': 'model_call', 'result': 'fail', 'retry': 0},
                {'event': 'model_call', 'result': 'pass', 'retry': 1},
                {'task_id': 'T-1', 'outcome': 'verified'}]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('verified', ATTESTED))
        self.assertTrue(is_task_attested_verified(rows))

    def test_an_attested_failure_outranks_a_dispatch_pass(self):
        """The exact shape the bridge now writes for a QA pass that exits 0 with failed checks."""
        rows = [{'event': 'model_call', 'task_id': 'run-1-qa', 'result': 'pass', 'cost_usd': .02},
                {'event': 'route_executed', 'task_id': 'run-1-qa', 'executed_passes': True},
                self.QA_FAILED_OUTCOME]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('failed', ATTESTED))
        self.assertFalse(is_task_attested_verified(rows))

    def test_dispatch_evidence_answers_only_when_nothing_attests(self):
        rows = [{'event': 'model_call', 'result': 'pass'}]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('verified', DISPATCH))
        # Never promoted to a verified task: strength is part of the answer.
        self.assertFalse(is_task_attested_verified(rows))

    def test_contradictory_dispatch_evidence_is_also_resolved_conservatively(self):
        rows = [{'event': 'model_call', 'result': 'pass'}, {'event': 'model_call', 'result': 'fail'}]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('failed', DISPATCH))

    def test_absence_of_evidence_is_never_failure(self):
        for rows in ([], [PER_CALL_ROW], [ROUTE_EXECUTED_ROW], [{}, {'status': 'implemented'}],
                     [{'result': 'pass_with_residuals'}], iter(())):
            with self.subTest(rows=rows):
                self.assertEqual(resolve_task_verification(rows), NO_VERIFICATION)
                self.assertFalse(is_task_attested_verified(rows))

    def test_rows_making_no_claim_do_not_dilute_a_verdict(self):
        rows = [PER_CALL_ROW, ROUTE_EXECUTED_ROW, {'outcome': 'verified'}, {'status': 'done'}]
        self.assertEqual(resolve_task_verification(rows), VerificationEvidence('verified', ATTESTED))

    def test_accepts_any_iterable_of_rows(self):
        rows = ({'outcome': 'verified'}, {'outcome': 'fail'})
        self.assertEqual(resolve_task_verification(iter(rows)),
                         VerificationEvidence('failed', ATTESTED))

    def test_a_single_row_resolves_exactly_as_verification_evidence_does(self):
        """No second vocabulary: with one row there is nothing to adjudicate."""
        for row in ({'outcome': 'verified'}, {'result': 'pass'}, {'event': 'task_failed'},
                    {'outcome': 'partial'}, {}, PER_CALL_ROW, LEGACY_SESSION_ROW):
            with self.subTest(row=row):
                self.assertEqual(resolve_task_verification([row]), verification_evidence(row))


class NoDataSentinelTests(unittest.TestCase):
    def test_is_falsy_but_is_not_none_or_zero(self):
        self.assertFalse(NO_DATA)
        self.assertIsNotNone(NO_DATA)
        self.assertNotEqual(NO_DATA, 0)
        self.assertNotEqual(NO_DATA, 0.0)
        self.assertNotEqual(NO_DATA, False)
        self.assertNotEqual(NO_DATA, None)
        self.assertNotEqual(NO_DATA, '')

    def test_a_measured_zero_is_distinguishable_from_no_data(self):
        measured, missing = 0.0, NO_DATA
        self.assertFalse(is_no_data(measured))
        self.assertTrue(is_no_data(missing))
        self.assertNotEqual(measured, missing)

    def test_compares_equal_only_to_itself(self):
        self.assertEqual(NO_DATA, NO_DATA)
        self.assertIs(type(NO_DATA)(), NO_DATA)
        self.assertNotEqual(NO_DATA, object())
        self.assertFalse(NO_DATA != NO_DATA)

    def test_reprs_as_no_data_and_survives_pickling_as_a_singleton(self):
        self.assertEqual(repr(NO_DATA), 'NO_DATA')
        self.assertIs(pickle.loads(pickle.dumps(NO_DATA)), NO_DATA)

    def test_is_hashable_so_it_can_sit_in_dashboard_dicts(self):
        self.assertEqual({NO_DATA: 'missing'}[NO_DATA], 'missing')

    def test_serializes_to_null_via_the_json_default_hook(self):
        payload = {'tail_ratio': NO_DATA, 'p50_cost': 0.0}
        text = json.dumps(payload, default=json_default)
        self.assertEqual(json.loads(text), {'tail_ratio': None, 'p50_cost': 0.0})

    def test_json_default_still_rejects_genuinely_unserializable_values(self):
        with self.assertRaises(TypeError):
            json.dumps({'x': object()}, default=json_default)

    def test_to_json_round_trips_nested_structures(self):
        data = {'summary': {'tail_ratio': NO_DATA, 'verified_tasks': 0},
                'trends': [{'verified_cost': NO_DATA}, {'verified_cost': 1.5}],
                'routes': ({'retry_rate': NO_DATA},)}
        plain = to_json(data)
        self.assertEqual(plain, {'summary': {'tail_ratio': None, 'verified_tasks': 0},
                                 'trends': [{'verified_cost': None}, {'verified_cost': 1.5}],
                                 'routes': [{'retry_rate': None}]})
        self.assertEqual(json.loads(json.dumps(plain))['summary']['tail_ratio'], None)


class RatioAndMetricTests(unittest.TestCase):
    def test_ratio_divides_when_there_is_a_denominator(self):
        self.assertAlmostEqual(ratio(2, 3), 2 / 3)
        self.assertAlmostEqual(ratio('1.5', 3), .5)

    def test_ratio_of_an_empty_denominator_is_no_data_not_zero(self):
        self.assertIs(ratio(0, 0), NO_DATA)
        self.assertIs(ratio(5, 0), NO_DATA)
        self.assertIs(ratio(5, None), NO_DATA)
        self.assertIs(ratio(5, NO_DATA), NO_DATA)
        self.assertIs(ratio(NO_DATA, 5), NO_DATA)

    def test_ratio_reports_a_real_zero_when_the_numerator_is_zero(self):
        self.assertEqual(ratio(0, 10), 0.0)
        self.assertFalse(is_no_data(ratio(0, 10)))

    def test_metric_requires_samples(self):
        self.assertEqual(metric(0.0, 12), 0.0)
        self.assertIs(metric(0.0, 0), NO_DATA)
        self.assertIs(metric(3.2, None), NO_DATA)
        self.assertIs(metric(3.2, NO_DATA), NO_DATA)
        self.assertIs(metric(None, 12), NO_DATA)

    def test_metric_wraps_a_quantile_over_an_empty_population(self):
        costs = [r for r in [ROUTE_EXECUTED_ROW, ADAPTIVE_DECISION_ROW] if is_per_call_cost_row(r)]
        self.assertIs(metric(0.0, len(costs)), NO_DATA)


class InstrumentationRegistryTests(unittest.TestCase):
    def test_fields_with_a_producer_in_this_repo(self):
        for field in ('cost_usd', 'input_tokens', 'output_tokens', 'retry', 'waste_reason',
                      'quality_evidence_score', 'covers_calls', 'executed_cost_usd'):
            self.assertTrue(is_instrumented(field), field)

    def test_fields_the_dashboard_reads_but_nobody_writes(self):
        for field in ('review_wait_ms', 'context_packet', 'context_packet_miss', 'context_refetch',
                      'decision_invalidated', 'shadow_review', 'verification_result'):
            self.assertFalse(is_instrumented(field), field)
            self.assertIn(field, UNINSTRUMENTED_FIELDS)

    def test_unknown_fields_are_treated_as_uninstrumented(self):
        self.assertFalse(is_instrumented('merge_conflict'))
        self.assertFalse(is_instrumented(''))

    def test_every_registry_entry_names_its_producer(self):
        for field, producer in INSTRUMENTED_FIELDS.items():
            self.assertTrue(producer.strip(), field)
        self.assertFalse(set(INSTRUMENTED_FIELDS) & set(UNINSTRUMENTED_FIELDS))


if __name__ == '__main__':
    unittest.main()

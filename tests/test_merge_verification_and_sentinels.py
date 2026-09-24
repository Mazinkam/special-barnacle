"""Merge-integration regressions: one verification vocabulary and NO_DATA-safe routing arithmetic.

Two seams the merge exposed:

* `engine.Engine.verify_task` writes *both* verdicts to metrics as `event: 'task_verified'` and puts
  the real verdict in `result` (`'verified' | 'fail'`). `history._verdict` and the dashboard read
  that row as FAILED; `records.verification_evidence` read it as VERIFIED because the event name
  outranked the field. Every consumer must answer the same thing for the same row.
* `history.build_route_stats` reports unmeasured aggregates as `records.NO_DATA`
  (`avg_quality_evidence`, `retry_rate`). `scheduler`/`adaptive` tested those against `None` only,
  so the sentinel reached `quality - penalty` / `quality >= floor` and crashed `Engine.plan` on any
  real history with priced, verified routes and no quality scores.

Roots are disposable; no live state is read.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from orchestrator import dashboard, records
from orchestrator.adaptive import adaptive_route, recommend_topology, route_evidence
from orchestrator.engine import OrchestrationEngine
from orchestrator.history import _verdict, build_route_stats
from orchestrator.records import ATTESTED, DISPATCH, FAILED, NO_DATA, PARTIAL, VERIFIED, VerificationEvidence
from orchestrator.run_evidence import evidence_coverage, summarize_runs
from orchestrator.runtime import QualityEvidence, load_jsonl
from orchestrator.scheduler import package_history, recommend_package

ROUTE = {'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'implementation_fast',
         'effort': 'standard', 'verification_depth': 'targeted', 'topology_shape': 'single_lead',
         'topology_depth': 2, 'topology_workers': 3, 'topology_leads': 1}


def verified_route_rows(tasks: int, *, quality: float | None = None, retry: int | None = None) -> list[dict]:
    """`tasks` priced, attested-verified tasks on one route; no quality score unless asked for."""
    rows = []
    for i in range(tasks):
        ids = {'run_id': f'R{i}', 'task_id': f'T{i}', 'ts': f'2026-01-{i + 1:02d}T00:00:00+00:00'}
        call = {**ROUTE, **ids, 'event': 'model_call', 'model': 'm', 'cost_usd': .02, 'cost_source': 'reported'}
        if retry is not None:
            call['retry'] = retry
        rows.append(call)
        verify = {**ROUTE, **ids, 'event': 'task_verified', 'result': 'verified'}
        if quality is not None:
            verify['quality_evidence_score'] = quality
        rows.append(verify)
    return rows


class VerificationEvidenceOnEngineRowsTests(unittest.TestCase):
    """`records` must read the engine's `task_verified` + `result` rows the way history/dashboard do."""

    def test_task_verified_with_an_explicit_failed_result_is_an_attested_failure(self):
        row = {'event': 'task_verified', 'task_id': 'T', 'result': 'fail', 'quality_evidence_score': .1}
        self.assertEqual(records.verification_evidence(row), VerificationEvidence(FAILED, ATTESTED))
        self.assertFalse(records.is_attested_verified(row))
        self.assertEqual(records.verification_state(row), FAILED)
        # history's own reading of the same row — the two vocabularies must not diverge.
        self.assertEqual(_verdict(row), FAILED)

    def test_task_verified_with_a_partial_result_is_attested_partial(self):
        row = {'event': 'task_verified', 'task_id': 'T', 'result': 'partial'}
        self.assertEqual(records.verification_evidence(row), VerificationEvidence(PARTIAL, ATTESTED))
        self.assertEqual(_verdict(row), PARTIAL)

    def test_task_verified_with_a_passing_result_or_no_result_stays_attested_verified(self):
        for row in ({'event': 'task_verified', 'task_id': 'T', 'result': 'verified'},
                    {'event': 'task_verified', 'task_id': 'T', 'result': 'pass'},
                    {'event': 'task_verified', 'task_id': 'T'}):
            with self.subTest(row=row):
                self.assertEqual(records.verification_evidence(row), VerificationEvidence(VERIFIED, ATTESTED))
                self.assertEqual(_verdict(row), VERIFIED)

    def test_an_unrecognised_result_on_task_verified_falls_back_to_the_event(self):
        row = {'event': 'task_verified', 'task_id': 'T', 'result': 'pass_with_residuals'}
        self.assertEqual(records.verification_evidence(row), VerificationEvidence(VERIFIED, ATTESTED))
        self.assertEqual(_verdict(row), VERIFIED)

    def test_task_failed_is_never_upgraded_by_a_passing_field(self):
        # A verdict field may only move an attesting event toward the conservative side.
        for row in ({'event': 'task_failed', 'task_id': 'T', 'result': 'pass'},
                    {'event': 'task_failed', 'task_id': 'T', 'outcome': 'verified'},
                    {'event': 'task_failed', 'task_id': 'T', 'success': True}):
            with self.subTest(row=row):
                self.assertEqual(records.verification_evidence(row), VerificationEvidence(FAILED, ATTESTED))
                self.assertEqual(_verdict(row), FAILED)

    def test_dispatch_result_alone_is_still_dispatch_strength(self):
        self.assertEqual(records.verification_evidence({'event': 'model_call', 'result': 'pass'}),
                         VerificationEvidence(VERIFIED, DISPATCH))
        self.assertEqual(records.verification_evidence({'event': 'model_call', 'result': 'fail'}),
                         VerificationEvidence(FAILED, DISPATCH))

    def test_resolve_task_verification_does_not_count_a_failed_engine_verdict(self):
        rows = [{'event': 'model_call', 'task_id': 'T', 'result': 'pass', 'cost_usd': .1},
                {'event': 'task_verified', 'task_id': 'T', 'result': 'fail'}]
        self.assertEqual(records.resolve_task_verification(rows), VerificationEvidence(FAILED, ATTESTED))
        self.assertFalse(records.is_task_attested_verified(rows))


class CrossModuleAgreementTests(unittest.TestCase):
    """The engine's failed verification is failed everywhere: records, history, run_evidence, dashboard."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_engine_verify_task_failure_agrees_across_every_consumer(self):
        engine = OrchestrationEngine(self.root)
        engine.record_model_call(**ROUTE, run_id='R', task_id='T', cost_usd=.1, cost_source='reported')
        engine.record_model_call(**ROUTE, run_id='R', task_id='OK', cost_usd=.1, cost_source='reported')
        engine.verify_task(run_id='R', task_id='T', evidence=QualityEvidence())
        engine.verify_task(run_id='R', task_id='OK',
                           evidence=QualityEvidence(acceptance_pass=True, deterministic_checks_pass=True))
        metrics = load_jsonl(self.root / 'metrics.jsonl')
        failed_row = next(r for r in metrics if r.get('event') == 'task_verified' and r.get('task_id') == 'T')
        self.assertEqual(failed_row['result'], 'fail')

        self.assertEqual(records.verification_evidence(failed_row), VerificationEvidence(FAILED, ATTESTED))
        self.assertEqual(_verdict(failed_row), FAILED)

        run = summarize_runs(metrics, load_jsonl(self.root / 'events.jsonl'), load_jsonl(self.root / 'outcomes.jsonl'))[0]
        self.assertEqual(run['verification'], 'failed')
        self.assertEqual(run['verified_tasks'], 1)
        self.assertEqual(run['verification_rows'], 2)

        group = build_route_stats(metrics)[0]
        self.assertEqual(group['verified_tasks'], 1)

        data = dashboard.build_data(self.root, config={})
        self.assertEqual(data['summary']['verified_tasks'], 1)
        self.assertEqual(data['summary']['dispatch_pass_tasks'], 0)
        self.assertEqual(data['runs'][0]['verification'], 'failed')
        self.assertEqual(data['run_evidence']['runs_with_verification'], 1)
        self.assertEqual(data['policies'][0]['verified'], 1)
        self.assertEqual(sum(t['verified'] for t in data['trends']), 1)


class RunEvidenceReadsVerdictsThroughRecordsTests(unittest.TestCase):
    def _call(self, task_id, **kw):
        return {'event': 'model_call', 'run_id': 'r', 'task_id': task_id, 'role': 'worker', 'model': 'm',
                'cost_usd': .02, 'cost_source': 'reported', **kw}

    def test_a_bare_task_verified_row_is_a_passed_verification(self):
        # `records`, history and the dashboard all read a bare `task_verified` as attested verified.
        # run_evidence previously reported the same run as 'failed' because the row lacked `result`.
        metrics = [self._call('t1'), {'event': 'task_verified', 'run_id': 'r', 'task_id': 't1'}]
        run = summarize_runs(metrics, [], [])[0]
        self.assertEqual(run['verification'], 'passed')
        self.assertEqual(run['verified_tasks'], 1)
        self.assertEqual(run['verification_rows'], 1)
        self.assertEqual(evidence_coverage([run])['runs_with_verification'], 1)

    def test_task_verified_with_a_failed_result_fails_the_run(self):
        metrics = [self._call('t1'), {'event': 'task_verified', 'run_id': 'r', 'task_id': 't1', 'result': 'fail'}]
        run = summarize_runs(metrics, [], [])[0]
        self.assertEqual(run['verification'], 'failed')
        self.assertEqual(run['verified_tasks'], 0)
        self.assertEqual(run['verification_rows'], 1)

    def test_task_failed_event_is_a_verification_row_that_fails_the_run(self):
        metrics = [self._call('t1'), {'event': 'task_failed', 'run_id': 'r', 'task_id': 't1'}]
        run = summarize_runs(metrics, [], [])[0]
        self.assertEqual(run['verification'], 'failed')
        self.assertEqual(run['verification_rows'], 1)
        self.assertEqual(run['verified_tasks'], 0)

    def test_latest_attested_verdict_per_task_decides(self):
        metrics = [self._call('t1'),
                   {'event': 'task_verified', 'run_id': 'r', 'task_id': 't1', 'result': 'fail',
                    'ts': '2026-09-23T10:00:00+00:00'},
                   {'event': 'task_verified', 'run_id': 'r', 'task_id': 't1', 'result': 'verified',
                    'ts': '2026-09-23T10:00:01+00:00'}]
        run = summarize_runs(metrics, [], [])[0]
        self.assertEqual(run['verification'], 'passed')
        self.assertEqual(run['verified_tasks'], 1)

    def test_dispatch_result_without_an_attestation_is_not_a_verification_row(self):
        # `result: 'pass'` on a model_call is the subprocess exit code (records.DISPATCH), not a
        # verdict; it never made a run 'passed' and still must not.
        metrics = [self._call('t1', result='pass')]
        run = summarize_runs(metrics, [], [])[0]
        self.assertEqual(run['verification'], 'unknown')
        self.assertEqual(run['verification_rows'], 0)
        self.assertEqual(run['verified_tasks'], 0)


class NoDataSentinelRoutingTests(unittest.TestCase):
    """Route stats carrying `NO_DATA` must neither crash the scheduler nor be enforced as evidence."""

    def setUp(self):
        self.stats = build_route_stats(verified_route_rows(12))
        self.group = self.stats[0]
        self.assertIs(self.group['avg_quality_evidence'], NO_DATA)
        self.assertIs(self.group['retry_rate'], NO_DATA)
        self.assertIsNotNone(self.group['verified_cost_usd'])
        self.assertEqual(self.group['verified_tasks'], 12)

    def test_package_history_does_not_offer_a_cohort_whose_quality_is_no_data(self):
        package = {'capability': 'implementation_fast', 'effort': 'standard', 'verification_depth': 'targeted'}
        self.assertIsNone(package_history(self.stats, task_class='crud', complexity=3, risk='low', package=package))

    def test_recommend_package_does_not_crash_and_reports_no_history(self):
        rec = recommend_package(task_class='crud', complexity=3, risk='low', quality_floor=.9,
                                cost_aggressiveness=.7, stats=self.stats)
        self.assertFalse(rec['choice']['historical'])
        self.assertTrue(all(not c['historical'] for c in rec['candidates']))
        for c in rec['candidates']:
            self.assertIsInstance(c['estimated_quality_evidence'], float)
            self.assertIsInstance(c['estimated_verified_cost_usd'], float)

    def test_recommend_package_survives_a_sentinel_in_every_optional_field(self):
        poisoned = [{**self.group, 'delayed_failure_rate': NO_DATA, 'verified_cost_usd': NO_DATA,
                     'effective_samples': NO_DATA}]
        rec = recommend_package(task_class='crud', complexity=3, risk='low', quality_floor=.9,
                                cost_aggressiveness=.7, stats=poisoned)
        self.assertFalse(rec['choice']['historical'])

    def test_adaptive_route_in_enforce_mode_falls_back_instead_of_enforcing(self):
        route = adaptive_route(run_id='run', task_class='crud', complexity=3, risk='low', quality_floor=.9,
                               cost_aggressiveness=.7, stats=self.stats,
                               features={'adaptive_routing': {'mode': 'enforce'}}, default_efforts={})
        self.assertFalse(route['history_sufficient'])
        self.assertEqual(route['explanation']['action'], 'fallback_insufficient_history')
        self.assertEqual(route['selected'], route['default'])
        self.assertEqual(route['explanation']['verified_task_samples'], 0)

    def test_route_evidence_counts_nothing_from_a_no_data_cohort(self):
        package = {'capability': 'implementation_fast', 'effort': 'standard', 'verification_depth': 'targeted'}
        self.assertEqual(route_evidence(self.stats, task_class='crud', complexity=3, risk='low', package=package),
                         {'verified_tasks': 0, 'run_samples': 0, 'call_samples': 0})

    def test_recommend_topology_skips_the_cohort_and_names_the_gap(self):
        topo = recommend_topology(task_class='crud', complexity=3, risk='low', coupling=.5, parallelizable=.5,
                                  stats=self.stats, quality_floor=.9, features={})
        self.assertIsNone(topo['empirical'])
        self.assertEqual(topo['candidates'], [])
        self.assertEqual(topo['comparable_groups'], 1)
        self.assertEqual(topo['skipped_missing_quality_or_cost'], 1)
        self.assertEqual(topo['fallback_reason'], 'missing_quality_or_cost')

    def test_a_measured_quality_score_is_still_used_and_can_be_enforced(self):
        # The sentinel guard must not swallow real measurements.
        stats = build_route_stats(verified_route_rows(12, quality=.99))
        rec = recommend_package(task_class='crud', complexity=3, risk='low', quality_floor=.9,
                                cost_aggressiveness=.7, stats=stats)
        self.assertTrue(rec['choice']['historical'])
        route = adaptive_route(run_id='run', task_class='crud', complexity=3, risk='low', quality_floor=.9,
                               cost_aggressiveness=.7, stats=stats,
                               features={'adaptive_routing': {'mode': 'enforce'}}, default_efforts={})
        self.assertTrue(route['history_sufficient'])
        self.assertEqual(route['explanation']['action'], 'empirical_enforced')
        topo = recommend_topology(task_class='crud', complexity=3, risk='low', coupling=.5, parallelizable=.5,
                                  stats=stats, quality_floor=.9, features={})
        self.assertIsNotNone(topo['empirical'])

    def test_engine_plan_does_not_crash_on_a_history_without_quality_scores(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = OrchestrationEngine(root)
            for row in verified_route_rows(12):
                engine.store.metric(**row)
            plan = engine.plan_run(run_id='run-1', task_class='crud', complexity=3, risk='low')
            self.assertEqual(plan['run_id'], 'run-1')
            self.assertIn('route', plan)


if __name__ == '__main__':
    unittest.main()

import tempfile
import unittest
from pathlib import Path

from orchestrator.history import build_route_stats
from orchestrator.outcomes import outcome_summary
from orchestrator.records import NO_DATA
from orchestrator.scheduler import recommend_package, topology_for
from orchestrator.adaptive import adaptive_route, recommend_topology


def topo_rows(run_id='R1',task_id='T1',calls=3,verified=True,shape='multi_lead'):
    base={'task_class':'crud','complexity':3,'risk':'low','capability_class':'implementation_fast','effort':'low','verification_depth':'targeted',
          'topology_shape':shape,'topology_depth':3,'topology_workers':6,'topology_leads':2,'run_id':run_id,'task_id':task_id}
    rows=[{**base,'event':'model_call','model':'m','cost_usd':.01,'cost_source':'reported'} for _ in range(calls)]
    if verified: rows.append({**base,'event':'task_verified','result':'verified','quality_evidence_score':.99})
    return rows


class T(unittest.TestCase):
    def test_stats(self):
        """`verified_tasks` requires ATTESTED evidence; a dispatch `result` does not qualify.

        This previously asserted `verified_tasks == 1` for a row whose only signal is
        `result: 'verified'`. `result` is the dispatch key (it reports the subprocess exit), so
        gating on it populated `verified_cost_usd` for 75 of 85 live groups from 164 dispatch-passing
        task ids when only 18 were ever attested verified. The row is still counted in `pass_rate`,
        which legitimately measures dispatch success.
        """
        rows = [{'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'implementation_fast', 'effort': 'low', 'verification_depth': 'targeted', 'cost_usd': .02, 'result': 'verified', 'task_id': 'T1', 'quality_evidence_score': .97}]
        s = build_route_stats(rows, [])
        self.assertEqual(s[0]['verified_tasks'], 0)
        # NO_DATA (None), not cost-per-dispatch-pass wearing the verified label
        self.assertIsNone(s[0]['verified_cost_usd'])
        # pass_rate keeps the dispatch signal on purpose
        self.assertAlmostEqual(s[0]['pass_rate'], 1.0, places=6)

    def test_an_attested_outcome_populates_verified_tasks_and_cost(self):
        rows = [{'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'implementation_fast', 'effort': 'low', 'verification_depth': 'targeted', 'cost_usd': .02, 'result': 'pass', 'task_id': 'T1'}]
        s = build_route_stats(rows, [{'task_id': 'T1', 'outcome': 'verified'}])
        self.assertEqual(s[0]['verified_tasks'], 1)
        self.assertAlmostEqual(s[0]['verified_cost_usd'], .02, places=6)

    def test_an_emitted_task_verified_metrics_row_is_attested_on_its_own(self):
        """Strength is read from the row's shape, not from which stream it came from."""
        rows = [{'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'implementation_fast', 'effort': 'low', 'verification_depth': 'targeted', 'cost_usd': .02, 'event': 'task_verified', 'task_id': 'T1'}]
        s = build_route_stats(rows, [])
        self.assertEqual(s[0]['verified_tasks'], 1)
        self.assertAlmostEqual(s[0]['verified_cost_usd'], .02, places=6)

    def test_a_task_with_both_kinds_of_evidence_is_counted_once(self):
        rows = [{'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'implementation_fast', 'effort': 'low', 'verification_depth': 'targeted', 'cost_usd': .02, 'result': 'pass', 'event': 'task_verified', 'task_id': 'T1'}]
        s = build_route_stats(rows, [{'task_id': 'T1', 'outcome': 'verified'}])
        self.assertEqual(s[0]['verified_tasks'], 1)

    def test_topology(self):
        self.assertEqual(topology_for(2)['shape'], 'direct')

    def test_route(self):
        r = recommend_package(task_class='crud', complexity=3, risk='low', quality_floor=.90, cost_aggressiveness=.8, stats=[], min_samples=8)
        self.assertIn('choice', r)

    def test_scheduler_min_samples_matches_the_adaptive_routing_default(self):
        # Historically SCHEDULER_MIN_SAMPLES was its own, unrelated literal (8) rather than the
        # general adaptive-routing default (12, `orchestrator.vocab.DEFAULT_MIN_SAMPLES`, sourced
        # from `config.json`'s `history.min_samples_for_empirical_route`). A scheduler needs at
        # least as much evidence as the rest of adaptive routing trusts before it stops discounting
        # a package's estimated quality for a small sample.
        from orchestrator.vocab import DEFAULT_MIN_SAMPLES, SCHEDULER_MIN_SAMPLES
        self.assertEqual(SCHEDULER_MIN_SAMPLES, DEFAULT_MIN_SAMPLES)
        self.assertEqual(SCHEDULER_MIN_SAMPLES, 12)

        import inspect
        from orchestrator.scheduler import recommend_package as _recommend_package
        self.assertEqual(inspect.signature(_recommend_package).parameters['min_samples'].default, 12)

    def _row(self, **kw):
        base = {'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'implementation_fast', 'effort': 'low', 'verification_depth': 'targeted', 'cost_usd': .02, 'task_id': 'T1'}
        base.update(kw)
        return base

    def test_verified_cost_usd_from_outcomes_only_signal(self):
        # metrics row makes no verification claim at all (no result/outcome/success/kind key,
        # and no event=='task_verified'); outcomes.jsonl is the stream that actually says the task
        # was verified. verified_cost_usd must still come out non-null, joined by task_id.
        rows = [self._row(task_id='T1', cost_usd=.02)]
        outcomes = [{'task_id': 'T1', 'outcome': 'verified'}]
        s = build_route_stats(rows, outcomes)
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]['verified_tasks'], 1)
        self.assertIsNotNone(s[0]['verified_cost_usd'])
        self.assertAlmostEqual(s[0]['verified_cost_usd'], .02)

    def test_avg_quality_evidence_is_no_data_when_unmeasured(self):
        # 0 of 410 live metrics rows carry quality_evidence_score; the group must report NO_DATA,
        # not None and not a fabricated score derived from pass/fail.
        rows = [self._row(task_id='T1', result='pass')]
        s = build_route_stats(rows, [])
        self.assertIs(s[0]['avg_quality_evidence'], NO_DATA)

    def test_retry_rate_no_data_vs_real_zero(self):
        # No row in the group carries `retry` at all -> NO_DATA, not a fabricated 0.0.
        no_retry_field = build_route_stats([self._row(task_id='T1')], [])
        self.assertIs(no_retry_field[0]['retry_rate'], NO_DATA)
        # A row that explicitly carries retry==0 is a real measured zero, not NO_DATA.
        real_zero = build_route_stats([self._row(task_id='T1', retry=0)], [])
        self.assertEqual(real_zero[0]['retry_rate'], 0.0)
        self.assertIsNot(real_zero[0]['retry_rate'], NO_DATA)

    def test_unknown_capability_excluded_from_route_stats(self):
        # comparable_key falls back to 'unknown' when neither capability_class nor role resolves;
        # such groups must not surface (and therefore cannot drive scheduler.recommend_package).
        rows = [{'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'unknown', 'effort': 'low', 'verification_depth': 'targeted', 'cost_usd': .02, 'task_id': 'T1'}]
        s = build_route_stats(rows, [])
        self.assertEqual(s, [])

    def test_outcome_summary_parses_json_in_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'outcomes.jsonl').write_text(
                '{"task_id":"T1","note":"{\\"regression\\": true, \\"success_rate\\": 1}"}\n',
                encoding='utf-8',
            )
            result = outcome_summary(root)
            self.assertEqual(len(result), 1)
            self.assertTrue(result[0]['bad_outcome'])

    def test_outcome_summary_ignores_prose_note_safely(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'outcomes.jsonl').write_text(
                '{"task_id":"T1","note":"looks good, shipped without issue"}\n',
                encoding='utf-8',
            )
            result = outcome_summary(root)  # must not raise
            self.assertEqual(len(result), 1)
            self.assertFalse(result[0]['bad_outcome'])

    def test_delayed_failure_agrees_with_outcome_summary_on_json_in_note(self):
        # history.build_route_stats and outcomes.outcome_summary must call the same bad-outcome
        # definition (`outcomes.bad_signal`) so the per-route "Delayed fail" column and the global
        # "30d delayed failure" card never disagree on identical rows. The row's bad-outcome signal
        # lives only in JSON-in-`note`, the shape live outcomes.jsonl rows actually carry.
        metrics_rows = [self._row(task_id='T1', completed_at='2020-01-01T00:00:00Z')]
        outcomes_rows = [{'task_id': 'T1', 'completed_at': '2020-01-01T00:00:00Z', 'note': '{"regression": true}'}]
        s = build_route_stats(metrics_rows, outcomes_rows)
        self.assertEqual(s[0]['delayed_failure_rate'], 1.0)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'outcomes.jsonl').write_text(
                '{"task_id":"T1","note":"{\\"regression\\": true}"}\n', encoding='utf-8',
            )
            summary = outcome_summary(root)
            self.assertTrue(summary[0]['bad_outcome'])

    def test_task_verified_row_with_no_routing_fields_credits_the_model_call_group(self):
        # A `task_verified` metrics row for the same task_id carries none of the routing fields
        # (task_class/complexity/risk/effort/verification_depth/topology_shape/capability_class/role)
        # that `comparable_key` groups on. It must still be resolved by task_id, globally, and credit
        # the group that holds the model_call row for that task -- not a phantom group of its own
        # (it in fact never forms a group at all: it is dropped by the capability/role pre-filter).
        model_call = self._row(task_id='T1', cost_usd=.02)
        verification_row = {'task_id': 'T1', 'event': 'task_verified'}
        s = build_route_stats([model_call, verification_row], [])
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]['verified_tasks'], 1)
        self.assertAlmostEqual(s[0]['verified_cost_usd'], .02, places=6)

    def test_contradictory_attested_evidence_resolves_to_not_verified(self):
        # An attested-failed verdict for a task_id must beat an attested-verified verdict for the
        # same task_id, whichever order the rows are seen in. Over-counting verified tasks is the
        # failure mode this branch exists to eliminate.
        model_call = self._row(task_id='T1', cost_usd=.02)
        verified_row = {'task_id': 'T1', 'event': 'task_verified'}
        failed_row = {'task_id': 'T1', 'event': 'task_failed'}

        s = build_route_stats([model_call, verified_row, failed_row], [])
        self.assertEqual(s[0]['verified_tasks'], 0)
        self.assertIsNone(s[0]['verified_cost_usd'])

        # order-independent: failed seen before verified still wins.
        s2 = build_route_stats([model_call, failed_row, verified_row], [])
        self.assertEqual(s2[0]['verified_tasks'], 0)
        self.assertIsNone(s2[0]['verified_cost_usd'])

        # same contradiction via outcomes.jsonl instead of metrics.jsonl.
        s3 = build_route_stats([model_call], [{'task_id': 'T1', 'outcome': 'verified'}, {'task_id': 'T1', 'outcome': 'failed'}])
        self.assertEqual(s3[0]['verified_tasks'], 0)
        self.assertIsNone(s3[0]['verified_cost_usd'])

    def test_outcome_summary_honors_typed_field_over_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'outcomes.jsonl').write_text(
                '{"task_id":"T1","reopened":false,"notes":"{\\"reopened\\": true}"}\n',
                encoding='utf-8',
            )
            result = outcome_summary(root)
            # typed top-level `reopened: false` is authoritative even though `notes` says true.
            self.assertFalse(result[0]['bad_outcome'])

    def test_route_stats_count_tasks_and_runs_not_rows(self):
        rows=topo_rows('R1','T1',calls=3)+topo_rows('R1','T2',calls=2)+topo_rows('R2','T3',calls=1,verified=False)
        s=build_route_stats(rows,[]); self.assertEqual(len(s),1); g=s[0]
        self.assertEqual(g['samples'],8)               # legacy: every row
        self.assertEqual(g['call_samples'],6)
        self.assertEqual(g['verification_samples'],2)
        self.assertEqual(g['task_samples'],3)
        self.assertEqual(g['verified_tasks'],2)
        self.assertEqual(g['run_samples'],2)
        self.assertEqual(g['verified_runs'],1)
        self.assertAlmostEqual(g['total_cost_usd'],.06)

    def test_session_ingest_excluded_from_route_stats(self):
        rows=topo_rows()+[{'task_class':'crud','complexity':3,'risk':'low','role':'interactive_session','source':'session_ingest','cost_usd':9,'task_id':'S1','result':'verified'}]
        s=build_route_stats(rows,[]); self.assertEqual(len(s),1); self.assertAlmostEqual(s[0]['total_cost_usd'],.03); self.assertEqual(s[0]['verified_tasks'],1)

    def test_enforce_topology_needs_min_samples_of_verified_tasks(self):
        stats=build_route_stats(topo_rows(calls=20),[])
        features={'adaptive_routing':{'mode':'enforce'},'historical_learning':{'minimum_samples':12}}
        rec=recommend_topology(task_class='crud',complexity=3,risk='low',coupling=.5,parallelizable=.5,stats=stats,quality_floor=.9,features=features)
        self.assertIsNone(rec['empirical'])
        self.assertEqual(rec['fallback_reason'],'insufficient_history')
        self.assertEqual(rec['min_samples'],12)
        self.assertEqual(rec['candidates'][0]['verified_tasks'],1)
        self.assertFalse(rec['candidates'][0]['sufficient'])
        self.assertEqual(rec['heuristic']['shape'],'direct')
        rec1=recommend_topology(task_class='crud',complexity=3,risk='low',coupling=.5,parallelizable=.5,stats=stats,quality_floor=.9,features=features,min_samples=1)
        self.assertEqual(rec1['empirical']['shape'],'multi_lead'); self.assertIsNone(rec1['fallback_reason'])

    def test_topology_fallback_reasons(self):
        rec=recommend_topology(task_class='crud',complexity=3,risk='low',coupling=.5,parallelizable=.5,stats=[],quality_floor=.9,features={},min_samples=1)
        self.assertEqual(rec['fallback_reason'],'no_comparable_history')
        stats=build_route_stats(topo_rows(),[])
        rec=recommend_topology(task_class='crud',complexity=3,risk='low',coupling=.5,parallelizable=.5,stats=stats,quality_floor=.999,features={},min_samples=1)
        self.assertEqual(rec['fallback_reason'],'below_quality_floor')
        # Comparable topology-tagged history that never produced a verified task (or quality score) is
        # a data gap, not "no history": say so, so operators do not go looking for missing tags.
        stats=build_route_stats(topo_rows(verified=False),[])
        self.assertIsNone(stats[0]['verified_cost_usd'])
        rec=recommend_topology(task_class='crud',complexity=3,risk='low',coupling=.5,parallelizable=.5,stats=stats,quality_floor=.9,features={},min_samples=1)
        self.assertEqual(rec['fallback_reason'],'missing_quality_or_cost')
        self.assertEqual(rec['candidates'],[])
        self.assertEqual(rec['comparable_groups'],1)
        self.assertEqual(rec['skipped_missing_quality_or_cost'],1)
        self.assertIsNone(rec['empirical'])

    def test_enforce_route_gate_counts_verified_tasks_not_call_rows(self):
        rows=[]
        base={'task_class':'crud','complexity':3,'risk':'low','capability_class':'implementation_fast','effort':'low','verification_depth':'targeted','run_id':'R1','task_id':'T1'}
        rows+=[{**base,'event':'model_call','model':'m','cost_usd':.001,'cost_source':'reported'} for _ in range(30)]
        rows.append({**base,'event':'task_verified','result':'verified','quality_evidence_score':.99})
        stats=build_route_stats(rows,[]); self.assertGreaterEqual(stats[0]['effective_samples'],12); self.assertEqual(stats[0]['verified_tasks'],1)
        f={'adaptive_routing':{'mode':'enforce'},'historical_learning':{'enabled':True,'minimum_samples':12}}
        r=adaptive_route(run_id='x',task_class='crud',complexity=3,risk='low',quality_floor=.9,cost_aggressiveness=.8,stats=stats,features=f,default_efforts={'implementation_fast':'low','implementation_strong':'standard'},min_samples=12)
        self.assertEqual(r['explanation']['action'],'fallback_insufficient_history')
        self.assertFalse(r['history_sufficient'])
        self.assertEqual(r['explanation']['verified_task_samples'],1)
        self.assertEqual(r['explanation']['run_samples'],1)
        self.assertEqual(r['explanation']['min_samples'],12)
        self.assertEqual(r['selected'],r['default'])

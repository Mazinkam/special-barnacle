import json, re, tempfile, unittest
from pathlib import Path
from orchestrator.engine import OrchestrationEngine
from orchestrator.dashboard import MIN_TAIL_SAMPLES, generate_dashboard
from orchestrator.records import is_no_data


def embedded_payload(html: str) -> dict:
    """The data the page actually renders, lifted back out of the `<script>` block.

    Asserting on `assertIn('...', html)` alone is how `p99/p50 tail ratio 4053665000.0×` shipped: the
    string was present, the number was nonsense. Every test below reads the embedded payload so a
    rendering test can make claims about *values*.
    """
    body = html.split('<script>const D=', 1)[1].split(';const $=', 1)[0]
    return json.loads(body.replace('<\\/', '</'))


class V3EngineTests(unittest.TestCase):
    def test_plan_records_adaptive_decision_and_dashboard(self):
        with tempfile.TemporaryDirectory() as td:
            e=OrchestrationEngine(td)
            p=e.plan_run(run_id='r1',task_class='crud',complexity=3,risk='low',repo_revision='abc')
            self.assertIn('selected_compute_package',p)
            self.assertEqual(p['route']['mode'],'recommend')
            metrics=Path(td,'metrics.jsonl').read_text()
            self.assertIn('adaptive_route_decision',metrics)
            out=generate_dashboard(td,config=e.config)
            self.assertTrue(out.exists())
            html=out.read_text()
            self.assertIn('Hierarchical Orchestrator V3',html)
            # Freshness must be visible: a generated-at stamp plus the latest event time,
            # and the page must self-reload so a file:// tab does not look frozen.
            self.assertNotIn('<meta http-equiv="refresh"',html)
            self.assertIn('5000',html)
            self.assertIn('orch-pause',html)
            self.assertIn('document.visibilityState',html)
            self.assertIn("sessionStorage.setItem('orch-scroll'",html)
            self.assertIn("sessionStorage.removeItem('orch-scroll')",html)
            self.assertIn('window.scrollTo',html)
            self.assertIn('"generated_at"',html)
            self.assertIn('"last_event_ts"',html)
            self.assertIn('id="freshness"',html)
            # Every pre-existing section must survive.
            for anchor in ('id="cards"','id="adaptiveHealth"','id="risk"','id="features"','id="adaptive"',
                           'id="policies"','id="trends"','id="routes"','id="roles"','id="runtimes"',
                           'id="interactive"','id="runs"','id="events"'):
                self.assertIn(anchor,html)
            self.assertIn('prefers-color-scheme',html)

    def test_rendered_payload_contains_no_implausible_metric(self):
        """A generated page must not carry a number no reader could defend.

        The adaptive decision written by `plan_run` is a zero-cost event row: exactly the shape whose
        inclusion in the cost population produced a p50 of $0.0000 and a billion-fold tail ratio.
        """
        with tempfile.TemporaryDirectory() as td:
            e=OrchestrationEngine(td)
            e.plan_run(run_id='r1',task_class='crud',complexity=3,risk='low',repo_revision='abc')
            data=embedded_payload(generate_dashboard(td,config=e.config).read_text())
        summary=data['summary']
        # tail_ratio is a real ratio or nothing at all — never p99 x 10^9
        self.assertIsNone(summary['tail_ratio'])
        self.assertEqual(summary['per_call_samples'],0)
        self.assertLess(summary['per_call_samples'],MIN_TAIL_SAMPLES)
        # no per-call figure may exist without a per-call sample
        for key in ('p50_cost','p90_cost','p99_cost','mean_call_cost','max_call_cost'):
            self.assertIsNone(summary[key],key)
        # rates live in [0,1]; costs are non-negative and bounded by total spend
        for key in ('cost_coverage','waste_rate','coordination_rate','verification_rate',
                    'context_miss_rate','exploration_rate_observed','history_sufficient_rate'):
            value=summary[key]
            if value is not None:
                self.assertGreaterEqual(value,0,key)
                self.assertLessEqual(value,1,key)
        self.assertGreaterEqual(summary['total_cost'],0)
        self.assertLessEqual(summary['reported_cost']+summary['estimated_cost'],summary['total_cost']+1e-9)

    def test_uninstrumented_cards_say_so_instead_of_rendering_zero(self):
        with tempfile.TemporaryDirectory() as td:
            e=OrchestrationEngine(td)
            e.plan_run(run_id='r1',task_class='crud',complexity=3,risk='low')
            html=generate_dashboard(td,config=e.config).read_text()
        data=embedded_payload(html)
        for key in ('review_wait_p90_s','context_miss_rate','fanout_rework','conflicts',
                    'shadow_false_pass_rate','shadow_over_reject_rate'):
            self.assertIsNone(data['summary'][key],key)
            self.assertEqual(data['instrumentation'][key]['label'],'not instrumented',key)
        self.assertIn('not instrumented',html)
        # and no formatter is left that could turn those nulls into numbers
        script=html.split('<script>',1)[1]
        for banned in ('Number(S.tail_ratio||0)','Number(S.fanout_rework||0)',
                       'Number(S.review_wait_p90_s||0)','Number(x||0).toLocaleString()','max(1e-9'):
            self.assertNotIn(banned,script,banned)
        self.assertRegex(script,re.compile(r'const miss=k=>'))

    def test_rows_and_calls_reconcile_in_the_rendered_payload(self):
        with tempfile.TemporaryDirectory() as td:
            e=OrchestrationEngine(td)
            e.plan_run(run_id='r1',task_class='crud',complexity=3,risk='low')
            data=embedded_payload(generate_dashboard(td,config=e.config).read_text())
        for name,rt in data['by_runtime'].items():
            self.assertEqual(rt['metered_calls']+rt['unmetered_calls'],rt['call_rows'],name)
            self.assertLessEqual(rt['call_rows'],rt['rows'],name)
            self.assertNotIn('calls',rt,name)
        interactive=data['interactive_sessions']
        self.assertGreaterEqual(interactive['calls'],interactive['rows'])
        self.assertIn('rows',interactive)

    def test_dashboard_reports_complete_run_evidence_coverage(self):
        from orchestrator.dashboard import build_data
        with tempfile.TemporaryDirectory() as td:
            engine = OrchestrationEngine(td)
            engine.plan_run(run_id='r1', task_class='crud', complexity=3, risk='low')
            engine.record_model_call(run_id='r1', task_id='r1-a', role='worker',
                                     capability_class='implementation_fast', model='known',
                                     cost_usd=.05, cost_source='reported')
            engine.record_model_call(run_id='r1', task_id='r1-b', role='worker',
                                     capability_class='implementation_fast', model='unknown',
                                     cost_source='unmetered')
            data = build_data(Path(td), config=engine.config)
            runs = {row['run_id']: row for row in data['runs']}
            self.assertIn('r1', runs)
            self.assertAlmostEqual(runs['r1']['cost_known_usd'], .05)
            self.assertEqual(runs['r1']['unmetered_calls'], 1)
            self.assertEqual(runs['r1']['call_rows'], 2)
            self.assertIsNone(runs['r1']['elapsed_ms'])
            self.assertEqual(data['run_evidence']['runs'], 1)
            self.assertEqual(data['run_evidence']['runs_fully_priced'], 0)
            self.assertEqual(data['run_evidence']['runs_with_elapsed'], 0)
            self.assertTrue(all(route['capability'] != 'interactive_session' for route in data['routes']))

    def test_master_switch_freezes_route(self):
        with tempfile.TemporaryDirectory() as td:
            cfg=json.loads(Path('orchestrator/config.json').read_text())
            cfg['features']['adaptive_system']['enabled']=False
            cp=Path(td,'config.json'); cp.write_text(json.dumps(cfg))
            e=OrchestrationEngine(td,cp)
            p=e.plan_run(run_id='r2',task_class='crud',complexity=4,risk='medium')
            self.assertEqual(p['route']['mode'],'off')
            self.assertEqual(p['route']['selected'],p['route']['default'])

if __name__=='__main__': unittest.main()

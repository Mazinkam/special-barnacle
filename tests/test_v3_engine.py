import json, tempfile, unittest
from pathlib import Path
from orchestrator.engine import OrchestrationEngine
from orchestrator.dashboard import generate_dashboard

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
            self.assertIn('<meta http-equiv="refresh"',html)
            self.assertIn('"generated_at"',html)
            self.assertIn('"last_event_ts"',html)
            self.assertIn('id="freshness"',html)

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

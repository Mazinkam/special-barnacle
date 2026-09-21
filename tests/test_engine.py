import tempfile, unittest
from orchestrator.engine import OrchestrationEngine
from orchestrator.runtime import QualityEvidence

class T(unittest.TestCase):
    def test_plan_and_verify(self):
        with tempfile.TemporaryDirectory() as d:
            e=OrchestrationEngine(d)
            p=e.plan_run(run_id='R1',task_class='crud',complexity=2,risk='low')
            self.assertIn('topology',p)
            out=e.verify_task(task_id='T1',run_id='R1',evidence=QualityEvidence(acceptance_pass=True,deterministic_checks_pass=True,tests_pass=True))
            self.assertEqual(out['result'],'verified')

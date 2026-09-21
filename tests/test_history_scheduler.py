import unittest
from orchestrator.history import build_route_stats
from orchestrator.scheduler import recommend_package,topology_for
class T(unittest.TestCase):
 def test_stats(self):
  rows=[{'task_class':'crud','complexity':3,'risk':'low','capability_class':'implementation_fast','effort':'low','verification_depth':'targeted','cost_usd':.02,'result':'verified','task_id':'T1','quality_evidence_score':.97}]
  s=build_route_stats(rows,[]); self.assertEqual(s[0]['verified_tasks'],1)
 def test_topology(self): self.assertEqual(topology_for(2)['shape'],'direct')
 def test_route(self):
  r=recommend_package(task_class='crud',complexity=3,risk='low',quality_floor=.90,cost_aggressiveness=.8,stats=[],min_samples=8); self.assertIn('choice',r)

import unittest
from orchestrator.economics import waste_cost,orchestration_overhead,fanout_rework
class T(unittest.TestCase):
 def test_waste(self): self.assertAlmostEqual(waste_cost([{'cost_usd':.1,'retry':1}])['retry'],.1)
 def test_fanout(self): self.assertEqual(fanout_rework([{'event':'decision_invalidated','affected_tasks':4}]),4)

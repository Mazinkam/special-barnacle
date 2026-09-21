import unittest
from orchestrator.runtime import Policy,QualityEvidence
class T(unittest.TestCase):
 def test_risk(self): self.assertGreater(Policy().effective_quality_floor('high'),Policy().effective_quality_floor('low'))
 def test_gate(self): self.assertTrue(QualityEvidence(True,True,True).hard_gate_pass())
 def test_score_penalty(self):
  a=QualityEvidence(True,True,True,True,True,True,uncertainty='low').evidence_score(); b=QualityEvidence(True,True,True,True,True,True,uncertainty='high').evidence_score(); self.assertGreater(a,b)

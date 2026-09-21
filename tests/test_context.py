import tempfile,unittest
from orchestrator.context import ContextRegistry
class T(unittest.TestCase):
 def test_budget(self):
  with tempfile.TemporaryDirectory() as d:
   c=ContextRegistry(d); c.put('A','x'*100,source='test',token_estimate=10); c.put('B','y'*100,source='test',token_estimate=20); p=c.packet(['A','B'],15); self.assertEqual(p['artifact_ids'],['A'])

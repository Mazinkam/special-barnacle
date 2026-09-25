import tempfile,unittest
from pathlib import Path
from orchestrator.context import ContextRegistry
class T(unittest.TestCase):
 def test_budget(self):
  with tempfile.TemporaryDirectory() as d:
   c=ContextRegistry(d); c.put('A','x'*100,source='test',token_estimate=10); c.put('B','y'*100,source='test',token_estimate=20); p=c.packet(['A','B'],15); self.assertEqual(p['artifact_ids'],['A'])

 def test_invalidate_missing_artifact_is_a_noop_and_creates_no_file(self):
  """Regression for B3 review finding: invalidating an artifact that was never `put` must not
  create `context_registry.json` (matching the pre-B3 unlocked `ContextRegistry`, which only
  wrote when the artifact was actually found)."""
  with tempfile.TemporaryDirectory() as d:
   c=ContextRegistry(d)
   self.assertFalse(c.path.exists())
   c.invalidate('missing','some reason')
   self.assertFalse(c.path.exists())

 def test_invalidate_missing_artifact_after_other_writes_does_not_rewrite_file(self):
  with tempfile.TemporaryDirectory() as d:
   c=ContextRegistry(d); c.put('A','x',source='test')
   before=c.path.read_bytes(); before_mtime=c.path.stat().st_mtime_ns
   c.invalidate('missing','some reason')
   self.assertEqual(c.path.read_bytes(),before)
   self.assertEqual(c.path.stat().st_mtime_ns,before_mtime)

 def test_legacy_instance_interface(self):
  """`path`, `data`, and `save()` are the pre-B3 public interface; other code/tests may still
  rely on them directly."""
  with tempfile.TemporaryDirectory() as d:
   c=ContextRegistry(d)
   self.assertIsInstance(c.path,Path)
   self.assertEqual(c.path,Path(d)/'context_registry.json')
   self.assertEqual(c.data,{'schema_version':3,'artifacts':{}})
   c.put('A','x',source='test')
   self.assertIn('A',c.data['artifacts'])
   c.data['artifacts']['A']['status']='reviewed'
   c.save()
   self.assertEqual(ContextRegistry(d).data['artifacts']['A']['status'],'reviewed')

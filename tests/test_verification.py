import tempfile,unittest
from pathlib import Path
from orchestrator.verification import VerificationCache
class T(unittest.TestCase):
 def test_keyed_cache(self):
  with tempfile.TemporaryDirectory() as d:
   c=VerificationCache(d); c.put(command='pytest',revision='a',environment_fingerprint='e',result='pass'); self.assertEqual(c.get(command='pytest',revision='a',environment_fingerprint='e',relevant_inputs=None)['result'],'pass'); self.assertIsNone(c.get(command='pytest',revision='b',environment_fingerprint='e',relevant_inputs=None))

 def test_get_missing_entry_creates_no_file(self):
  with tempfile.TemporaryDirectory() as d:
   c=VerificationCache(d)
   self.assertFalse(c.path.exists())
   self.assertIsNone(c.get(command='pytest',revision='a',environment_fingerprint='e',relevant_inputs=None))
   self.assertFalse(c.path.exists())

 def test_legacy_instance_interface(self):
  """`path` and `data` are the pre-B3 public interface; other code/tests may still rely on
  them directly."""
  with tempfile.TemporaryDirectory() as d:
   c=VerificationCache(d)
   self.assertIsInstance(c.path,Path)
   self.assertEqual(c.path,Path(d)/'verification_cache.json')
   self.assertEqual(c.data,{'schema_version':3,'entries':{}})
   c.put(command='pytest',revision='a',environment_fingerprint='e',result='pass')
   self.assertEqual(len(c.data['entries']),1)

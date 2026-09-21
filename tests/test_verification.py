import tempfile,unittest
from orchestrator.verification import VerificationCache
class T(unittest.TestCase):
 def test_keyed_cache(self):
  with tempfile.TemporaryDirectory() as d:
   c=VerificationCache(d); c.put(command='pytest',revision='a',environment_fingerprint='e',result='pass'); self.assertEqual(c.get(command='pytest',revision='a',environment_fingerprint='e',relevant_inputs=None)['result'],'pass'); self.assertIsNone(c.get(command='pytest',revision='b',environment_fingerprint='e',relevant_inputs=None))

import tempfile,unittest
from orchestrator.runtime import EventStore
from orchestrator.state import rebuild
class T(unittest.TestCase):
 def test_replay(self):
  with tempfile.TemporaryDirectory() as d:
   s=EventStore(d); s.emit('run_started',run_id='R1'); s.emit('task_created',task_id='T1'); s.emit('task_completed',task_id='T1'); st=rebuild(d); self.assertEqual(st['runs']['R1']['status'],'running'); self.assertEqual(st['tasks']['T1']['status'],'completed')

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from orchestrator.runtime import EventStore, default_state_root


class StateRootTests(unittest.TestCase):
    def test_uses_the_shared_root_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory, "shared-state")
            with patch.dict(os.environ, {
                "CODING_AGENT_ORCHESTRATOR_HOME": str(root),
                "CODING_AGENT_RUNTIME": "codex",
                "CODING_AGENT_REPOSITORY": "/work/forge",
            }):
                self.assertEqual(default_state_root(), root)
                record = EventStore().emit("run_started", run_id="shared-run")
                self.assertEqual(record["agent_runtime"], "codex")
                self.assertEqual(record["repository"], "/work/forge")


if __name__ == "__main__":
    unittest.main()

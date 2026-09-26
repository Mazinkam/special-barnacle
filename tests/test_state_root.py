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

    def test_deprecated_alias_alone_still_resolves(self):
        """2.3: HUMAIN_ORCHESTRATOR_STATE_ROOT is a deprecated fallback alias for the canonical
        CODING_AGENT_ORCHESTRATOR_HOME; it must still be honoured when set alone."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory, "alias-state")
            with patch.dict(os.environ, {"HUMAIN_ORCHESTRATOR_STATE_ROOT": str(root)}, clear=False):
                os.environ.pop("CODING_AGENT_ORCHESTRATOR_HOME", None)
                self.assertEqual(default_state_root(), root)

    def test_canonical_wins_when_both_are_set(self):
        with tempfile.TemporaryDirectory() as directory:
            canonical_root = Path(directory, "canonical-state")
            alias_root = Path(directory, "alias-state")
            with patch.dict(os.environ, {
                "CODING_AGENT_ORCHESTRATOR_HOME": str(canonical_root),
                "HUMAIN_ORCHESTRATOR_STATE_ROOT": str(alias_root),
            }):
                self.assertEqual(default_state_root(), canonical_root)


if __name__ == "__main__":
    unittest.main()

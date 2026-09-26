"""B3 review requirement (`docs/architecture-review.md`): `scripts/rebuild_ledger.py` and
`scripts/regenerate_dashboard.py` became thin wrappers around names re-exported from
`orchestrator.cli` (not `orchestrator.cli.main(...)` directly -- see each script's module
docstring for why: `cli.main`'s `rebuild`/`dashboard` commands have extra side effects, republishing
the dashboard / pre-creating stream files, that these scripts have never had). This test runs both
scripts as real subprocesses against a temporary state root and checks their stdout/exit code
against calling the underlying `orchestrator.cli` functions directly in-process.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _env(root: Path) -> dict:
    import os
    return {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(root), 'PYTHONPATH': str(REPO_ROOT)}


def test_rebuild_ledger_script_matches_cli_rebuild_function(tmp_path):
    root = tmp_path / 'state'
    result = subprocess.run([sys.executable, str(REPO_ROOT / 'scripts' / 'rebuild_ledger.py')],
                             env=_env(root), cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    from orchestrator.cli import rebuild
    expected = json.dumps(rebuild(tmp_path / 'expected'), indent=2)
    assert result.stdout.rstrip('\n') == expected


def test_regenerate_dashboard_script_matches_cli_generate_dashboard_function(tmp_path):
    root = tmp_path / 'state'
    result = subprocess.run([sys.executable, str(REPO_ROOT / 'scripts' / 'regenerate_dashboard.py')],
                             env=_env(root), cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    from orchestrator.cli import cfg, generate_dashboard
    generate_dashboard(root, config=cfg())  # regenerate again in-process, same root as the subprocess
    assert result.stdout.strip() == str(root / 'dashboard.html')


def test_neither_script_pre_creates_stream_files_the_way_cli_main_does(tmp_path):
    """The one behaviour deliberately NOT unified with `cli.main`: `main()` builds an
    `EventStore(root)` before dispatching, which creates `events.jsonl`/`metrics.jsonl`/
    `outcomes.jsonl`/`discoveries.jsonl` if they don't exist. `regenerate_dashboard.py` must not
    start doing that (ground rule 5)."""
    root = tmp_path / 'state'
    result = subprocess.run([sys.executable, str(REPO_ROOT / 'scripts' / 'regenerate_dashboard.py')],
                             env=_env(root), cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert not (root / 'events.jsonl').exists()
    assert not (root / 'metrics.jsonl').exists()
    assert not (root / 'outcomes.jsonl').exists()

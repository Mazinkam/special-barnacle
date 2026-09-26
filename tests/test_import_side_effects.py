"""B2 step 5: importing an `orchestrator` module must not read files or the environment.

Before this test, `scheduler.py` computed `EFFORTS = effort_levels()` (reads `method.json`),
`dynamic_adapter.py` computed `CAPABILITY_TIER_TARGET = adapter_tier_targets()` (same), and
`cli.py` computed `ROOT = default_state_root()` (reads `CODING_AGENT_ORCHESTRATOR_HOME`) all at
module scope — so a bare `import orchestrator.cli` read the environment and `import
orchestrator.scheduler` read `method.json`, before any command ran. That makes every import
order- and environment-dependent, and (for `cli.ROOT`) meant a *different* `CODING_AGENT_ORCHESTRATOR_HOME`
set after import time (e.g. by a test importing `cli` before patching the env) silently didn't
take effect.

Every module is imported alone, in its own subprocess, with `CODING_AGENT_ORCHESTRATOR_HOME`
pointing at a state root that does not exist yet and `HOME` pointing at an empty directory. Two
independent checks:
  1. the state root directory must not be created by the mere import;
  2. `method.json`/`config.json` must not be opened by the mere import (`builtins.open` and
     `Path.read_text`/`Path.read_bytes` are wrapped to record every path opened).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Every importable module under `orchestrator/`, dotted, excluding `__init__`/entry-point-style
#: scripts that are meant to run code on `import __main__` only (none currently do; this list is
#: derived at collection time so a newly added module is covered automatically).
def _discover_modules() -> list[str]:
    orchestrator_dir = REPO_ROOT / 'orchestrator'
    mods = []
    for path in sorted(orchestrator_dir.rglob('*.py')):
        rel = path.relative_to(orchestrator_dir)
        if rel.name == '__init__.py':
            dotted = 'orchestrator' if rel.parent == Path('.') else 'orchestrator.' + '.'.join(rel.parent.parts)
        else:
            parts = list(rel.with_suffix('').parts)
            dotted = 'orchestrator.' + '.'.join(parts)
        mods.append(dotted)
    return sorted(set(mods))


MODULES = _discover_modules()

_PROBE = textwrap.dedent("""
    import builtins, io, json, sys
    from pathlib import Path

    opened = []
    _orig_open = builtins.open
    def _tracking_open(file, *a, **kw):
        opened.append(str(file))
        return _orig_open(file, *a, **kw)
    builtins.open = _tracking_open

    _orig_read_text = Path.read_text
    def _tracking_read_text(self, *a, **kw):
        opened.append(str(self))
        return _orig_read_text(self, *a, **kw)
    Path.read_text = _tracking_read_text

    _orig_read_bytes = Path.read_bytes
    def _tracking_read_bytes(self, *a, **kw):
        opened.append(str(self))
        return _orig_read_bytes(self, *a, **kw)
    Path.read_bytes = _tracking_read_bytes

    import importlib
    importlib.import_module(sys.argv[1])

    print(json.dumps(opened))
""")


@pytest.mark.parametrize('module', MODULES)
def test_import_alone_touches_no_state_root_or_config(module, tmp_path):
    state_root = tmp_path / 'state-does-not-exist-yet'
    empty_home = tmp_path / 'empty-home'
    empty_home.mkdir()
    assert not state_root.exists()

    env = {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'PYTHONPATH': str(REPO_ROOT),
        'CODING_AGENT_ORCHESTRATOR_HOME': str(state_root),
        'HOME': str(empty_home),
    }
    result = subprocess.run(
        [sys.executable, '-c', _PROBE, module],
        env=env, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, (
        f"import {module!r} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )

    assert not state_root.exists(), (
        f"import {module!r} alone created the state root {state_root}"
    )

    opened = json.loads(result.stdout.strip().splitlines()[-1])
    method_or_config_reads = [
        p for p in opened
        if p.endswith('method.json') or p.endswith('config.json')
    ]
    assert method_or_config_reads == [], (
        f"import {module!r} alone read {method_or_config_reads}"
    )

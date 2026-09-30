"""What happens right after a durable write: publish the dashboard.

`record_batch.write_batch` durably appends records and catches the ledger up (a store-layer
concern: it never imports presentation). Whether a dashboard render also happens, and when, is
an app-layer decision — this module is the only place `cli.py`'s durable-write commands
(`batch`/`event`/`metric`/`outcome`/`init`) go through to get it, so the JSON body and exit
code they have always returned are unchanged.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..contract import RETRY_SAME_IDS, STATUS_REFRESH_FAILED
from ..presentation.publish import dashboard_is_current, generate_dashboard, render_slot_free

SYNC_ENV = 'ORCHESTRATOR_DASHBOARD_SYNC'  # set to 1 to render inside the write call (deterministic readers/tests)


def _spawn_renderer(root: Path, config: dict | None) -> None:
    """Start a detached one-shot renderer unless one already owns the slot (it re-checks after it releases)."""
    if not render_slot_free(root):
        return
    p = subprocess.Popen([sys.executable, '-m', 'orchestrator.presentation.publish', str(root.resolve())], stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                         cwd=str(Path(__file__).resolve().parents[2]))
    p.stdin.write(json.dumps(config).encode()); p.stdin.close()


def refresh_after_write(root: str | Path, result: dict[str, Any], *, config: dict | None = None) -> dict[str, Any]:
    """Render the dashboard after `write_batch`, extending its result with the old `refresh=True` contract.

    Mutates and returns `result`. If the write (or the ledger catch-up `write_batch` already
    performed) left `result['error']` set, the dashboard is never attempted — a batch that is
    already reporting `append_failed`/`checkpoint_failed`/`refresh_failed` must not be silently
    overwritten. Records are durable either way; a dashboard failure alone is reported as
    `status='refresh_failed'` with `retry='same_ids'`, matching the exit code (3) `cli.py` maps
    from `result['ok']`, never a raised exception.
    """
    if result.get('error') is not None:
        return result
    try:
        if os.environ.get(SYNC_ENV):
            generate_dashboard(Path(root), config=config, skip_if_current=True)
            result['dashboard_updated'] = True
        else:  # eventually consistent: the page lags until the background renderer catches up
            current = dashboard_is_current(root)
            if not current:
                _spawn_renderer(Path(root), config)
            result['dashboard_updated'] = current
    except Exception as exc:  # noqa: BLE001 - records (and any ledger catch-up) are already durable
        result['ok'] = False
        result['status'] = STATUS_REFRESH_FAILED
        result['error'] = f'dashboard refresh failed: {exc}'
        result['retry'] = RETRY_SAME_IDS
    return result

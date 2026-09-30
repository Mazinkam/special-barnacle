"""Locking and atomic publication of `dashboard.html` (+ its invalidation receipt).

`generate_dashboard` is the one entry point: it serializes readers/renderers behind
`dashboard.lock` (not canonical writers — an older snapshot can never overwrite a newer
publication because writes during a render invalidate the pre-render `stream_version` receipt),
builds the data (`dashboard_data.build_data`), renders it (`dashboard_html.render`), and publishes
both files via same-directory temporary file + atomic rename (`core.fs.write_text_atomic`/
`write_json`), so an interrupted render leaves the previously published, complete page untouched.

`build_data` is accepted as a keyword so a caller can inject a different implementation (or a
wrapped one) without this module importing `orchestrator.dashboard`; the re-export shim in
`orchestrator/dashboard.py` uses this to keep `dashboard.build_data = <patched>` (an existing test
seam) working after `build_data` moved out of that module.
"""
from __future__ import annotations

import fcntl
from pathlib import Path
from typing import Any, Callable

from ..core.env import default_state_root
from ..core.fs import exclusive_file_lock, read_json, write_json, write_text_atomic
from ..contract import INGEST_STATUS_FILE, STREAMS
from .dashboard_data import build_data as _default_build_data
from .dashboard_html import render


def stream_version(root):
    """Cheap invalidation receipt; sync-health-only writes must invalidate the page too."""
    version = {'format_version': 1}
    for name in (STREAMS['event'], STREAMS['metric'], STREAMS['outcome'], INGEST_STATUS_FILE):
        try:
            s = (Path(root) / name).stat()
            version[name] = [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns]
        except FileNotFoundError:
            version[name] = None
    return version


def dashboard_is_current(root):
    return (Path(root) / 'dashboard.html').exists() and \
        read_json(Path(root) / 'dashboard.version.json', None) == stream_version(root)


def generate_dashboard(state_dir=None, config: dict | None = None, *,
                       build_data: Callable[..., Any] | None = None, skip_if_current: bool = False):
    """Render and atomically publish `dashboard.html`; return its path.

    The page is written to a same-directory temporary file and renamed into place, so an
    interrupted render (exception, crash, disk full) leaves the previously published complete
    page untouched and a later refresh catches up. The document is emitted in three chunks
    (head, data, tail) rather than one concatenated string to avoid an extra copy of the payload.

    `skip_if_current=True` (post-write refresh only) returns the published page without rendering
    when its receipt, checked under the lock, already equals the streams' current version: a
    concurrent renderer that queued ahead of us already published everything we would, and a
    duplicate-only write changed nothing. Time-relative fields (`generated_at`, provider health)
    keep the earlier render's clock; the explicit `dashboard` command always renders.
    """
    build = build_data or _default_build_data
    root = Path(state_dir) if state_dir is not None else default_state_root()
    root.mkdir(parents=True, exist_ok=True)
    # Serialize readers/renderers, not canonical writers. An older snapshot cannot overwrite
    # a newer publication; writes during this render invalidate the pre-render receipt.
    with exclusive_file_lock(root / 'dashboard.lock'):
        version = stream_version(root)
        out = root / 'dashboard.html'
        if skip_if_current and out.exists() and read_json(root / 'dashboard.version.json', None) == version:
            return out
        data = build(root, config)
        write_text_atomic(out, render(data))
        write_json(root / 'dashboard.version.json', version)
        return out


RENDER_LOCK = 'dashboard.render.lock'  # flock: held only by the one background renderer; the OS frees it on death


def render_slot_free(root) -> bool:
    """True when no background renderer is running (probe: take the flock non-blocking, drop it)."""
    with (Path(root) / RENDER_LOCK).open('a') as f:
        try: fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError: return False
        return True


def render_until_current(root, config: dict | None = None, *, build_data=None) -> int:
    """Background renderer body; return the number of renders done (0 if another renderer owns the slot).

    Coalesces write bursts: it renders, releases the slot, then re-checks the receipt *after* release
    and only exits when the page is current. A writer that probed the slot while we held it skipped
    spawning, but its bytes were already on disk, so that post-release check sees them (no lost wakeup).
    Each render goes through `generate_dashboard`, so the receipt is the version read before the build.
    """
    root = Path(root); renders = 0
    while root.is_dir() and not dashboard_is_current(root):
        with (root / RENDER_LOCK).open('a') as f:
            try: fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError: return renders
            if dashboard_is_current(root): break
            generate_dashboard(root, config, build_data=build_data, skip_if_current=True)
            renders += 1
    return renders


if __name__ == '__main__':  # detached one-shot: `python -m orchestrator.presentation.publish <root>`, config JSON on stdin
    import json, sys
    try: _cfg = json.loads(sys.stdin.read() or 'null')
    except ValueError: _cfg = None
    render_until_current(sys.argv[1], _cfg)

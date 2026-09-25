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
                       build_data: Callable[..., Any] | None = None):
    """Render and atomically publish `dashboard.html`; return its path.

    The page is written to a same-directory temporary file and renamed into place, so an
    interrupted render (exception, crash, disk full) leaves the previously published complete
    page untouched and a later refresh catches up. The document is emitted in three chunks
    (head, data, tail) rather than one concatenated string to avoid an extra copy of the payload.
    """
    build = build_data or _default_build_data
    root = Path(state_dir) if state_dir is not None else default_state_root()
    root.mkdir(parents=True, exist_ok=True)
    # Serialize readers/renderers, not canonical writers. An older snapshot cannot overwrite
    # a newer publication; writes during this render invalidate the pre-render receipt.
    with exclusive_file_lock(root / 'dashboard.lock'):
        version = stream_version(root)
        data = build(root, config)
        out = root / 'dashboard.html'
        write_text_atomic(out, render(data))
        write_json(root / 'dashboard.version.json', version)
        return out

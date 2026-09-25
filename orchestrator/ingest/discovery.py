"""Finding session logs on disk.

Split out of `orchestrator/ingest.py` (B3, `docs/architecture-review.md`).
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Iterable

from .parsers import CODEX, HUMAIN_TERMINAL

LOG_GLOBS: dict[str, tuple[str, ...]] = {
    HUMAIN_TERMINAL: ('.humain-terminal/agent/sessions/*/*.jsonl',),
    CODEX: ('.codex/sessions/*/*/*/rollout-*.jsonl',),
}

_TEMP_MARKERS = ('var-folders', 'T-pi-', 'pi-runtime-events', '-tmp-', 'T-tmp')


def is_scratch_log(path: Path) -> bool:
    """True for test-harness and temp-directory sessions (faux models, throwaway sandboxes)."""
    name = path.parent.name
    if any(marker in name for marker in _TEMP_MARKERS):
        return True
    return name.startswith('--var-folders') or '/T/pi-' in str(path)


def discover_logs(*, since_days: float | None = None, runtimes: Iterable[str] | None = None,
                  home: str | Path | None = None, include_scratch: bool = False) -> list[Path]:
    """Find session logs, newest first, optionally limited to those modified recently.

    Test-harness and temp-directory sessions are excluded by default: they run faux models and
    would enter the ledger as real work.
    """
    base = Path(home).expanduser() if home is not None else Path.home()
    cutoff = time.time() - since_days * 86_400 if since_days else None
    wanted = set(runtimes) if runtimes else set(LOG_GLOBS)
    found: list[Path] = []
    for runtime, globs in LOG_GLOBS.items():
        if runtime not in wanted:
            continue
        for pattern in globs:
            for path in base.glob(pattern):
                if not path.is_file():
                    continue
                if cutoff is not None and path.stat().st_mtime < cutoff:
                    continue
                if not include_scratch and is_scratch_log(path):
                    continue
                found.append(path)
    return sorted(set(found), key=lambda p: p.stat().st_mtime, reverse=True)

"""Durable filesystem primitives: read/write JSON, fsync helpers, the writer lock.

Moved out of `orchestrator/runtime.py` (B2.2); `orchestrator.runtime` re-exports every name
here for one release, so existing imports keep working unchanged. No `orchestrator` imports
beyond this comment: this is the bottom of the layer order.
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import secrets
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

_LOGGER = logging.getLogger('orchestrator')
if not _LOGGER.handlers:
    # Independent of the caller's logging config: a warning about a corrupt config file must
    # reach stderr even when nothing else configured logging (e.g. running as `python3 -m
    # orchestrator.cli`), and it must never land on stdout, which the TS bridge parses as JSON.
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(logging.Formatter('%(name)s: %(levelname)s: %(message)s'))
    _LOGGER.addHandler(_handler)
_LOGGER.setLevel(logging.WARNING)


def read_json(path: Path, default):
    if not path.exists(): return default
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        _LOGGER.warning('failed to read %s (%s: %s); using default', path, type(exc).__name__, exc)
        return default

def fsync_directory(path: Path):
    """Make newly created/replaced directory entries durable on local POSIX filesystems."""
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def fsync_directory_ancestry(path: Path) -> list[Path]:
    """fsync the real `path` and every ancestor on the same filesystem, deepest first; return them.

    A stream fsync plus an fsync of the state root only makes the *file* entries durable. Each
    directory entry (`state` in `new`, `new` in `T`, ...) lives in its parent and needs that parent
    synced too, or a power loss after an acknowledged write can drop the whole state tree. Existence
    proves nothing about durability: a directory another process, an older writer or an earlier
    attempt whose fsync failed created a moment ago may still live only in the page cache, so the
    caller syncs the chain itself, whoever created it. The walk stops at the mount point: the entry
    naming a mount point is on the parent filesystem and had to exist for the mount to be there at
    all. Symlinks are resolved first so the physical chain is the one synced. An fsync of a clean
    directory is a cheap syscall (~15 us here), so a write pays well under a millisecond for this.
    """
    directory = Path(path).resolve()
    device = directory.stat().st_dev
    synced: list[Path] = []
    while True:
        fsync_directory(directory); synced.append(directory)
        parent = directory.parent
        if parent == directory or parent.stat().st_dev != device:
            return synced
        directory = parent


def _create_exclusive_tmp(path: Path) -> tuple[int, Path]:
    """Open a fresh same-directory temporary file for an atomic replacement of `path`."""
    for _ in range(100):
        tmp = path.with_name(f'.{path.name}.{secrets.token_hex(8)}.tmp')
        try:
            return os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666), tmp
        except FileExistsError:
            continue
    raise FileExistsError(f'Could not create a unique temporary file for {path}')


def write_json(path: Path, value: Any, *, compact: bool=False, durable: bool=False):
    fd, tmp = _create_exclusive_tmp(path)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            # json.dumps uses the C encoder; json.dump(fp) always falls back to the pure-Python one.
            f.write(json.dumps(value, separators=(',',':') if compact else None, indent=None if compact else 2, sort_keys=True, default=str))
            if durable:
                f.flush()
                os.fsync(f.fileno())
        os.replace(tmp, path)
        if durable: fsync_directory(path.parent)
    finally:
        try: tmp.unlink()
        except FileNotFoundError: pass

def write_text_atomic(path: Path, chunks: Iterable[str], *, encoding: str='utf-8'):
    """Publish a text document by same-directory temporary file + rename.

    Readers (a browser tab on `file://dashboard.html`, another process) see either the previous
    complete document or the new complete one, never a truncated page. A failure while rendering
    or writing leaves the previous document untouched and removes the temporary file. Nothing is
    fsynced: derived views are rebuildable, and the next refresh republishes them.
    """
    fd, tmp = _create_exclusive_tmp(path)
    try:
        with os.fdopen(fd, 'w', encoding=encoding) as f:
            for chunk in chunks: f.write(chunk)
        os.replace(tmp, path)
    finally:
        try: tmp.unlink()
        except FileNotFoundError: pass

@contextmanager
def exclusive_file_lock(path: Path):
    """Hold an advisory exclusive lock until the context exits."""
    with path.open('a', encoding='utf-8') as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try: yield
        finally: fcntl.flock(f.fileno(), fcntl.LOCK_UN)

WRITER_LOCK_FILE='ledger.lock'
RECORD_INDEX_FILE='records.checkpoint.json'  # independent receipt for the rebuildable SQLite record-id cache

def writer_lock(root: Path):
    """The single process-wide lock that serializes check/append/checkpoint/ledger writes.

    The file name is the one the pre-batch code already used for rebuilds, so a process running
    older code still excludes the new writer during a rolling upgrade. Advisory `flock` locks are
    per open file description, so this must not be re-entered from the same call chain.
    """
    return exclusive_file_lock(Path(root)/WRITER_LOCK_FILE)

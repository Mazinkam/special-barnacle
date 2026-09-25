"""Manifest read/write, path validation and the timestamp/run-id helpers everything else needs.

Split out of `orchestrator/archive.py` (B3, `docs/architecture-review.md`); see
`orchestrator/archive/__init__.py` for the package overview and re-export contract.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from ..contract import NEVER_ARCHIVE_FILES
from ..runtime import fsync_directory
from .codec import _open_regular, _private_temp, _unlink_quietly

FORMAT_VERSION = 1
RUNS_DIR = 'runs'
MANIFEST_FILE = 'archive.manifest.json'
ARCHIVE_SUFFIX = '.gz'
#: Authoritative streams and their integrity/recovery metadata: never archived, wherever they appear.
NEVER_ARCHIVE = NEVER_ARCHIVE_FILES
#: Kept readable in place even when the rest of the run is archived (the HT progress board links to it).
KEEP_READABLE = frozenset({'run.log'})
RESTORE_COMMAND = 'python3 -m orchestrator.cli restore-run {run_id}'


def parse_ts(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value: return None
    try: parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError: return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def validate_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or not run_id or run_id in ('.', '..') or run_id.startswith('.') or Path(run_id).name != run_id or '/' in run_id or '\\' in run_id:
        raise ValueError(f'run_id must be a plain run directory name, got {run_id!r}')
    return run_id


def _validate_days(older_than_days: float) -> float:
    if not isinstance(older_than_days, (int, float)) or isinstance(older_than_days, bool) or math.isnan(older_than_days) or older_than_days <= 0:
        raise ValueError(f'older_than_days must be a positive number of days, got {older_than_days!r}')
    return float(older_than_days)


def _validate_directory(path: Path) -> None:
    # Check the state root, runs container and run itself, without resolving away symlinks.
    for directory in (path.parent.parent, path.parent, path):
        try: mode = directory.lstat().st_mode
        except FileNotFoundError: continue
        if not stat.S_ISDIR(mode): raise ValueError(f'unsafe directory (symlink or non-directory): {directory}')


def _validate_file(path: Path) -> None:
    try: mode = path.lstat().st_mode
    except FileNotFoundError: return
    if not stat.S_ISREG(mode): raise ValueError(f'unsafe file (symlink or non-regular): {path}')


def _validate_name(name: str) -> None:
    validate_run_id(name)
    if '\x00' in name or name in NEVER_ARCHIVE or name in KEEP_READABLE or name.endswith(ARCHIVE_SUFFIX):
        raise ValueError(f'unsafe diagnostic name: {name!r}')


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError(f'duplicate manifest key: {key!r}')
        result[key] = value
    return result


def load_manifest(run_dir: Path) -> Optional[dict[str, Any]]:
    """Absent is None; malformed/untrusted metadata raises before any mutation, never defaults."""
    _validate_directory(run_dir)
    path = run_dir / MANIFEST_FILE
    _validate_file(path)
    try:
        with _open_regular(path) as source:
            manifest = json.load(source, object_pairs_hook=_unique_object)
    except FileNotFoundError: return None
    except (OSError, UnicodeError, ValueError) as exc:
        raise ValueError(f'invalid manifest {path}: {exc}') from exc
    if (not isinstance(manifest, dict) or type(manifest.get('format_version')) is not int
            or manifest['format_version'] != FORMAT_VERSION or manifest.get('run_id') != run_dir.name
            or not isinstance(manifest.get('terminal_outcome'), dict) or not isinstance(manifest.get('files'), dict)):
        raise ValueError(f'invalid manifest schema: {path}')
    # Validate ALL entries before callers create locks, temporary files or restore anything.
    for name, info in manifest['files'].items():
        _validate_name(name)
        if (not isinstance(info, dict) or info.get('archive') != name + ARCHIVE_SUFFIX
                or not isinstance(info.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', info['sha256'])
                or any(type(info.get(k)) is not int or info[k] < 0 for k in ('raw_bytes', 'compressed_bytes', 'mtime_ns'))
                or parse_ts(info.get('archived_at')) is None):
            raise ValueError(f'invalid manifest entry: {name!r}')
        _validate_file(run_dir / name)
        _validate_file(run_dir / info['archive'])
    return manifest


def _write_manifest(run_dir: Path, manifest: dict[str, Any]) -> None:
    """Append validated entries under archive.lock, retaining durable prior generations.

    Initial publication is no-clobber. Updates may only extend valid metadata, never change
    an existing entry. A private, content-addressed recovery copy precedes atomic replacement.
    """
    path = run_dir / MANIFEST_FILE
    existing = load_manifest(run_dir)
    previous = None
    if existing is not None:
        if (any(manifest.get(k) != existing.get(k) for k in ('format_version', 'run_id', 'terminal_outcome'))
                or any(manifest['files'].get(k) != v for k, v in existing['files'].items())):
            raise ValueError('manifest update would alter existing recovery metadata')
        if existing == manifest: return
        with _open_regular(path) as source: previous = source.read()
        if json.loads(previous, object_pairs_hook=_unique_object) != existing:
            raise ValueError('manifest changed during update')
        backup = run_dir / f'.archive.manifest.{hashlib.sha256(previous).hexdigest()}.json'
        _validate_file(backup)
        if backup.exists():
            with _open_regular(backup) as source:
                if source.read() != previous: raise ValueError('manifest recovery copy differs')
        else:
            fd, tmp = _private_temp(backup)
            try:
                with os.fdopen(fd, 'wb') as out:
                    out.write(previous); out.flush(); os.fsync(out.fileno())
                os.link(tmp, backup, follow_symlinks=False)
            finally: _unlink_quietly(tmp)
        fsync_directory(run_dir)
    fd, tmp = _private_temp(path)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(manifest, out, indent=2, sort_keys=True)
            out.flush(); os.fsync(out.fileno())
        if previous is None:
            os.link(tmp, path, follow_symlinks=False)
        else:
            with _open_regular(path) as source:
                if source.read() != previous: raise ValueError('manifest changed before publication')
            os.replace(tmp, path)
        fsync_directory(run_dir)
    finally:
        _unlink_quietly(tmp)


def _stat_key(st: os.stat_result) -> tuple[int, ...]:
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns

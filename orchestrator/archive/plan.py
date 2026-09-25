"""Read-only selection of archivable runs: which run directories are eligible, and why not.

Split out of `orchestrator/archive.py` (B3, `docs/architecture-review.md`); see
`orchestrator/archive/__init__.py` for the package overview and re-export contract.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from ..contract import STREAMS
from ..runtime import iter_jsonl
from ..vocab import TERMINAL_TASK_IDS
from .codec import estimate_compressed_bytes
from .manifest import (
    ARCHIVE_SUFFIX,
    KEEP_READABLE,
    NEVER_ARCHIVE,
    RESTORE_COMMAND,
    RUNS_DIR,
    _validate_days,
    _validate_directory,
    _validate_file,
    _validate_name,
    load_manifest,
    parse_ts,
)
from .seal import OWNER_FILE, SEAL_FILE, load_seal

DEFAULT_OLDER_THAN_DAYS = 30


def terminal_outcomes(root: Path) -> dict[str, dict[str, Any]]:
    """Latest durable terminal outcome per run id, streamed from `outcomes.jsonl` (missing file -> {})."""
    latest: dict[str, dict[str, Any]] = {}
    for row in iter_jsonl(Path(root) / STREAMS['outcome']):
        run_id = row.get('run_id'); task_id = row.get('task_id')
        if not isinstance(run_id, str) or task_id not in TERMINAL_TASK_IDS: continue
        latest[run_id] = {'task_id': task_id, 'ts': row.get('ts'), 'outcome': row.get('outcome'), 'finished_at': row.get('finished_at')}
    return latest


def _run_dirs(root: Path) -> Iterator[Path]:
    runs = Path(root) / RUNS_DIR
    _validate_directory(runs / '_validation_')
    if not runs.is_dir(): return
    for entry in sorted(runs.iterdir()):
        if entry.is_dir() and not entry.is_symlink() and not entry.name.startswith('.'): yield entry


def _candidate_files(run_dir: Path) -> list[tuple[Path, os.stat_result]]:
    out = []
    for entry in sorted(run_dir.iterdir()):
        name = entry.name
        if name in NEVER_ARCHIVE or name in KEEP_READABLE or name.endswith(ARCHIVE_SUFFIX) or name.startswith('.'): continue
        if entry.is_symlink() or not entry.is_file(): continue
        out.append((entry, entry.stat()))
    return out


def _skip(run_id: str, run_dir: Path, reason: str, detail: str, **extra) -> dict[str, Any]:
    return {'run_id': run_id, 'path': str(run_dir), 'status': 'skipped', 'reason': reason, 'detail': detail, 'files': [],
            'raw_bytes': 0, 'estimated_compressed_bytes': 0, **extra}


def plan_run(run_dir: Path, terminal: Optional[dict[str, Any]], *, older_than_days: float, now: datetime) -> dict[str, Any]:
    """Classify one run directory: `eligible` (with per-file plan) or `skipped` (with reason + detail). Read-only."""
    run_id = run_dir.name
    manifest = load_manifest(run_dir) or {'files': {}}
    seal = load_seal(run_dir)
    if terminal is None:
        return _skip(run_id, run_dir, 'no_terminal_outcome',
                     f"no durable run-complete/run-failed outcome for {run_id} in {STREAMS['outcome']}; the run may still be active or its status is unknown")
    if seal is None and any((run_dir / name).exists() for name in (OWNER_FILE, SEAL_FILE)):
        return _skip(run_id, run_dir, 'writers_unsealed',
                     'managed diagnostic ownership is incomplete: producers may still be draining; no snapshots or raw removal',
                     ownership='unsealed', originals_retained=True)
    finished = parse_ts(terminal.get('finished_at')) or parse_ts(terminal.get('ts'))
    if finished is None:
        return _skip(run_id, run_dir, 'age_unknown', f'terminal outcome {terminal.get("task_id")} has no parseable timestamp ({terminal.get("ts")!r})', terminal_outcome=terminal)
    age_days = (now - finished).total_seconds() / 86400
    if age_days < older_than_days:
        return _skip(run_id, run_dir, 'recent', f'completed {age_days:.1f} days ago (< {older_than_days:g})', terminal_outcome=terminal, age_days=age_days)
    cutoff_ns = int((now.timestamp() - older_than_days * 86400) * 1e9)
    candidates = _candidate_files(run_dir)
    fresh = [p.name for p, st in candidates if st.st_mtime_ns > cutoff_ns]
    if fresh:
        return _skip(run_id, run_dir, 'recently_modified', f'modified inside the last {older_than_days:g} days: {", ".join(fresh)}', terminal_outcome=terminal, age_days=age_days)
    archived_bytes = sum(int(i.get('compressed_bytes', 0)) for n, i in manifest['files'].items() if (run_dir / str(i.get('archive', n + ARCHIVE_SUFFIX))).exists())
    if not candidates:
        if manifest['files']:
            return _skip(run_id, run_dir, 'already_archived', f'{len(manifest["files"])} file(s) already archived', terminal_outcome=terminal, age_days=age_days,
                         compressed_bytes=archived_bytes, restore_command=RESTORE_COMMAND.format(run_id=run_id))
        return _skip(run_id, run_dir, 'nothing_to_archive', 'only run.log / excluded files present', terminal_outcome=terminal, age_days=age_days)
    files = []
    for path, st in candidates:
        item = {'name': path.name, 'path': str(path), 'destination': str(path.with_name(path.name + ARCHIVE_SUFFIX)), 'raw_bytes': st.st_size,
                'estimated_compressed_bytes': 0, 'status': 'eligible', 'reason': None, 'detail': None}
        _validate_name(path.name)
        _validate_file(Path(item['destination']))
        try: item['estimated_compressed_bytes'] = estimate_compressed_bytes(path, st.st_size)
        except OSError as exc: item.update(status='failed', reason='unreadable', detail=str(exc))
        files.append(item)
    entry = {'run_id': run_id, 'path': str(run_dir), 'status': 'eligible', 'reason': None, 'detail': f'completed {age_days:.1f} days ago', 'terminal_outcome': terminal,
             'age_days': age_days, 'files': files, 'raw_bytes': sum(f['raw_bytes'] for f in files),
             'estimated_compressed_bytes': sum(f['estimated_compressed_bytes'] for f in files)}
    entry.update(ownership='sealed' if seal else 'uncoordinated', originals_retained=seal is None)
    if seal is None:
        entry.update(reason='snapshot_only', detail=entry['detail'] + '; no durable writer seal: snapshot only, raw retained, zero bytes reclaimed')
    for item in files:
        item['removal_authorized'] = bool(seal and item['name'] in seal['files'])
        if not item['removal_authorized'] and item['status'] == 'eligible':
            item.update(reason='snapshot_only', detail='no sealed ownership for this file; raw retained')
    if manifest['files']: entry['compressed_bytes_already_archived'] = archived_bytes
    return entry


def plan_archive(root: Path, *, older_than_days: float = DEFAULT_OLDER_THAN_DAYS, now: Optional[datetime] = None) -> list[dict[str, Any]]:
    """Dry-run plan for every run directory. Reads only; never creates the root, a lock or a manifest."""
    root = Path(root); days = _validate_days(older_than_days); now = now or datetime.now(timezone.utc)
    terminals = terminal_outcomes(root)
    return [plan_run(run_dir, terminals.get(run_dir.name), older_than_days=days, now=now) for run_dir in _run_dirs(root)]

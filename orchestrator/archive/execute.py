"""Execution: compress, verify, publish under `archive.lock`, and remove sealed-owner originals.

Split out of `orchestrator/archive.py` (B3, `docs/architecture-review.md`); see
`orchestrator/archive/__init__.py` for the package overview and re-export contract. Also holds
`summarize_archive_results`, the CLI-facing summary aggregation moved out of
`cli._archive_runs_command` (also B3): `cli.py` keeps only argument handling and printing.
"""
from __future__ import annotations

import os
import shutil
import zlib
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from ..runtime import exclusive_file_lock, fsync_directory, utc_now
from .codec import _compress_to_temp, _decompressed_digest, _digest_file, _open_regular, _unlink_quietly
from .manifest import (
    FORMAT_VERSION,
    RESTORE_COMMAND,
    RUNS_DIR,
    _stat_key,
    _validate_days,
    _validate_file,
    _write_manifest,
    load_manifest,
)
from .plan import DEFAULT_OLDER_THAN_DAYS, plan_archive
from .seal import load_seal

ARCHIVE_LOCK_FILE = 'archive.lock'
FREE_SPACE_MARGIN = 1 << 20


def _archive_file(run_dir: Path, item: dict[str, Any], manifest: dict[str, Any]) -> None:
    """Archive one file per the module protocol, mutating `item` with status/reason/detail/compressed_bytes."""
    src = Path(item['path']); dest = Path(item['destination']); name = item['name']
    try: before = src.stat()
    except FileNotFoundError:
        item.update(status='skipped', reason='missing', detail='raw file disappeared before archiving'); return
    known = manifest['files'].get(name)
    if dest.exists() or dest.is_symlink():
        # Adopt an orphan only after comparing its full decompressed bytes with raw. No overwrite.
        try: raw_digest, raw_bytes = _digest_file(src); arc_digest, arc_bytes = _decompressed_digest(dest)
        except (OSError, EOFError, zlib.error) as exc:
            item.update(status='failed', reason='verification_failed', detail=str(exc)); return
        if known and (raw_digest, raw_bytes) != (known['sha256'], known['raw_bytes']):
            item.update(status='skipped', reason='raw_diverged', detail=f'{name} differs from its manifest entry; neither copy was touched'); return
        if (arc_digest, arc_bytes) != (raw_digest, raw_bytes):
            item.update(status='failed', reason='verification_failed', detail=f'existing {dest.name} does not decompress to the raw bytes; raw kept'); return
        if _stat_key(src.stat()) != _stat_key(before):
            item.update(status='skipped', reason='modified_during_archive', detail=f'{name} changed while being verified'); return
        info = known or {'archive': dest.name, 'sha256': raw_digest, 'raw_bytes': raw_bytes,
                         'compressed_bytes': dest.stat().st_size, 'mtime_ns': before.st_mtime_ns, 'archived_at': utc_now()}
        _commit_archive_file(run_dir, item, manifest, info, before)
        return
    if known:
        item.update(status='failed', reason='archive_missing', detail='manifest archive is missing; recovery metadata retained'); return
    free = shutil.disk_usage(run_dir).free
    if free < item['estimated_compressed_bytes'] + FREE_SPACE_MARGIN:
        item.update(status='skipped', reason='insufficient_disk', detail=f'{free} bytes free, need about {item["estimated_compressed_bytes"] + FREE_SPACE_MARGIN}'); return
    try: tmp, raw_digest, raw_bytes = _compress_to_temp(src, dest)
    except OSError as exc:
        item.update(status='failed', reason='write_failed', detail=str(exc)); return
    try:
        try: arc_digest, arc_bytes = _decompressed_digest(tmp)
        except (OSError, EOFError, zlib.error) as exc:
            item.update(status='failed', reason='verification_failed', detail=f'decompressing the new archive failed: {exc}'); return
        if (arc_digest, arc_bytes) != (raw_digest, raw_bytes):
            item.update(status='failed', reason='verification_failed', detail='decompressed digest does not match the raw file'); return
        try: after = src.stat()
        except FileNotFoundError:
            item.update(status='skipped', reason='missing', detail='raw file disappeared during archiving'); return
        if _stat_key(after) != _stat_key(before) or raw_bytes != before.st_size:
            item.update(status='skipped', reason='modified_during_archive', detail=f'{name} was written to while being compressed; raw kept, archive discarded'); return
        try:
            os.link(tmp, dest, follow_symlinks=False); fsync_directory(run_dir)
            info = {'archive': dest.name, 'sha256': raw_digest, 'raw_bytes': raw_bytes, 'compressed_bytes': tmp.stat().st_size,
                    'mtime_ns': before.st_mtime_ns, 'archived_at': utc_now()}
        except OSError as exc:
            item.update(status='failed', reason='publish_failed', detail=str(exc)); return
        _commit_archive_file(run_dir, item, manifest, info, before)
    finally:
        _unlink_quietly(tmp)


def _commit_archive_file(run_dir: Path, item: dict[str, Any], manifest: dict[str, Any], info: dict[str, Any], before: os.stat_result) -> None:
    """Durably commit one entry, then and only then remove a seal-matching owned original."""
    name = item['name']; src = run_dir / name
    updated = {**manifest, 'files': {**manifest['files'], name: info}}
    try:
        # An adopted archive might not have been fsynced by its previous owner.
        with _open_regular(run_dir / info['archive']) as source: os.fsync(source.fileno())
        fsync_directory(run_dir)
        _write_manifest(run_dir, updated)
    except (OSError, ValueError) as exc:
        item.update(status='failed', reason='manifest_publish_failed', detail=f'{exc}; original and gzip retained'); return
    manifest['files'] = updated['files']
    item.update(status='archived', reason='original_retained', detail='verified snapshot; no sealed ownership, raw retained',
                original_retained=True, raw_bytes_removed=0, compressed_bytes=info['compressed_bytes'])
    seal = load_seal(run_dir)
    owned = seal and seal['files'].get(name)
    if not owned: return
    if before.st_nlink != 1:
        item.update(status='skipped', reason='shared_inode', detail='hardlinked original has uncertain ownership; raw retained'); return
    if (owned['sha256'], owned['raw_bytes']) != (info['sha256'], info['raw_bytes']):
        item.update(status='skipped', reason='seal_mismatch', detail='raw bytes differ from sealed inventory; raw retained'); return
    try:
        if _stat_key(src.stat()) != _stat_key(before):
            item.update(status='skipped', reason='modified_during_archive', detail='sealed original changed; raw retained'); return
        src.unlink()
        item.update(original_retained=False, raw_bytes_removed=before.st_size)
        fsync_directory(run_dir)
        item.update(reason=None, detail='sealed original replaced by durable verified gzip and manifest')
    except OSError as exc:
        item.update(status='failed', reason='remove_failed', detail=f'{exc}; manifest and archive retained for retry')


def _run_storage_bytes(run_dir: Path) -> int:
    # Count unique inodes: temporary hardlinks/publication and recovery links are not extra data.
    files = { (st.st_dev, st.st_ino): st.st_size for p in run_dir.iterdir()
              if not p.is_symlink() and p.is_file() for st in [p.stat()] }
    return sum(files.values())


def _execute_run(run_dir: Path, entry: dict[str, Any]) -> None:
    before_bytes = _run_storage_bytes(run_dir)
    existing = load_manifest(run_dir)
    manifest = existing or {'format_version': FORMAT_VERSION, 'run_id': run_dir.name, 'terminal_outcome': entry.get('terminal_outcome'), 'files': {}}
    # Only fresh temporary files owned by this invocation are cleaned. Unknown files stay intact.
    for item in entry['files']:
        if item['status'] == 'eligible': _archive_file(run_dir, item, manifest)
    raw_removed = sum(f.get('raw_bytes_removed', 0) for f in entry['files'])
    net = before_bytes - _run_storage_bytes(run_dir)
    entry.update(originals_retained=all(f.get('original_retained', True) for f in entry['files']),
                 raw_bytes_removed=raw_removed, storage_delta_bytes=-net,
                 reclaimed_bytes=max(0, net) if raw_removed else 0)
    statuses = [f['status'] for f in entry['files']]
    entry['compressed_bytes'] = sum(f.get('compressed_bytes', 0) for f in entry['files'])
    archived_now = any(s == 'archived' for s in statuses)
    if all(s == 'archived' for s in statuses): entry['status'] = 'archived'
    elif archived_now or manifest['files']: entry['status'] = 'partial'  # some of this run is archived, some is not
    else: entry['status'] = 'failed' if any(s == 'failed' for s in statuses) else 'skipped'
    problems = [f for f in entry['files'] if f['status'] != 'archived']
    if problems:
        reasons = {f['reason'] for f in problems}
        entry['reason'] = reasons.pop() if len(reasons) == 1 else 'see_files'
        entry['detail'] = '; '.join(f'{f["name"]}: {f["reason"]}' for f in problems)
    if manifest['files']: entry['restore_command'] = RESTORE_COMMAND.format(run_id=run_dir.name)


def archive_lock(root: Path):
    """Serializes archive/restore among themselves only; the telemetry writer lock is never taken."""
    _validate_file(Path(root) / ARCHIVE_LOCK_FILE)
    return exclusive_file_lock(Path(root) / ARCHIVE_LOCK_FILE)


def archive_runs(root: Path, *, older_than_days: float = DEFAULT_OLDER_THAN_DAYS, execute: bool = False, now: Optional[datetime] = None) -> list[dict[str, Any]]:
    """List (and with `execute=True`, archive) completed run diagnostics older than `older_than_days`.

    Dry run: pure read; returns one entry per run directory with status `eligible`/`skipped`,
    per-file paths, destinations, raw and estimated compressed bytes. Execute: same entries after
    archiving under the archive lock; statuses become `archived`/`partial`/`failed`/`skipped` and
    `compressed_bytes` is the verified gzip size. Only sealed-owner originals can be removed;
    `raw_bytes_removed`, `storage_delta_bytes` and net `reclaimed_bytes` describe actual changes.
    Uncoordinated legacy originals are retained and can never authorize raw removal.
    """
    root = Path(root); days = _validate_days(older_than_days)
    if not execute: return plan_archive(root, older_than_days=days, now=now)
    # Validate every manifest before even creating the lock. Repeat under the lock, too.
    plan_archive(root, older_than_days=days, now=now)
    if not (root / RUNS_DIR).is_dir(): return []
    with archive_lock(root):
        entries = plan_archive(root, older_than_days=days, now=now)  # planned under the lock so two archivers never race
        for entry in entries:
            if entry['status'] == 'eligible': _execute_run(Path(entry['path']), entry)
    return entries


def summarize_archive_results(entries: list[dict[str, Any]], *, executed: bool, older_than_days: float, state_root: Path) -> dict[str, Any]:
    """Aggregate `archive_runs` entries into the totals `cli._archive_runs_command` prints/emits.

    Moved out of `cli.py` (B3, `docs/architecture-review.md`) so the archive package owns its own
    summary shape; `cli.py` keeps only argument handling and printing, and computes `failed`
    (`executed and summary['not_archived_files'] > 0`) itself from the returned dict.
    """
    planned = [e for e in entries if e['files']]
    skipped = [e for e in entries if e['status'] == 'skipped']
    return {'executed': executed, 'older_than_days': older_than_days, 'state_root': str(state_root), 'runs': entries,
            'originals_retained': all(e.get('originals_retained', True) for e in planned),
            'reclaimed_bytes': max(0, -sum(e.get('storage_delta_bytes', 0) for e in planned)),
            'storage_delta_bytes': sum(e.get('storage_delta_bytes', 0) for e in planned),
            'raw_bytes_removed': sum(e.get('raw_bytes_removed', 0) for e in planned),
            'eligible_runs': len(planned), 'skipped_runs': len(skipped),
            'eligible_raw_bytes': sum(e['raw_bytes'] for e in planned),
            'eligible_estimated_compressed_bytes': sum(e['estimated_compressed_bytes'] for e in planned),
            'archived_files': sum(1 for e in planned for f in e['files'] if f['status'] == 'archived'),
            'archived_raw_bytes': sum(f['raw_bytes'] for e in planned for f in e['files'] if f['status'] == 'archived'),
            'compressed_bytes': sum(e.get('compressed_bytes', 0) for e in planned),
            'not_archived_files': sum(1 for e in planned for f in e['files'] if f['status'] != 'archived')}

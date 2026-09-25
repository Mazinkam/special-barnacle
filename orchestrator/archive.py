"""Opt-in reversible diagnostics archival under `<root>/runs/<run_id>/`.

Eligibility requires a durable terminal outcome and old completion/file timestamps. Active,
recent and ambiguous runs are skipped. Authoritative streams/metadata and run.log stay intact.
A fresh HT RunDiagnostics owner drains all producer leases (including child stdio close),
fsyncs its files and publishes an immutable SHA-256 inventory seal after terminal acknowledgement.
Only inventory-matching files of that sealed owner may be removed. Legacy uncoordinated directories
remain snapshot-only; managed unsealed runs are skipped. Final stat checks alone never establish
ownership of open descriptors.

Under archive.lock, each file is compressed to a private temporary gzip, fsynced and verified,
then linked without clobbering an existing archive. Matching orphan archives can be adopted only
by verifying full decompressed bytes against raw. Commit manifest progress per file before raw
unlink; valid metadata can only be extended, with durable prior generations retained. Failures
leave raw and recovery files available for incremental retry. Unknown temporary files are untouched.
Restore verifies and publishes absent raw names without clobber; archives/manifests remain intact.
No background timer or automatic deletion exists. Accounting reports raw removed, gzip size,
and net logical storage change including recovery metadata (not filesystem allocated blocks).

Manifest v1: {format_version, run_id, terminal_outcome, files: {name: {archive, sha256,
raw_bytes, compressed_bytes, mtime_ns, archived_at}}}. Owner/seal v1 use protocol
`ht-run-diagnostics-v1`, run_id and owner_id; seal adds sealed_at and files:{name:{sha256,raw_bytes}}.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from .runtime import (RECORD_INDEX_FILE, WRITER_LOCK_FILE, exclusive_file_lock, fsync_directory,
                      iter_jsonl, utc_now)
from .record_index import DATABASE_FILE
from .state import LEDGER_FILE

FORMAT_VERSION = 1
OWNER_FILE = '.diagnostics-owner.json'
SEAL_FILE = '.diagnostics-sealed.json'
SEAL_PROTOCOL = 'ht-run-diagnostics-v1'
RUNS_DIR = 'runs'
MANIFEST_FILE = 'archive.manifest.json'
ARCHIVE_LOCK_FILE = 'archive.lock'
ARCHIVE_SUFFIX = '.gz'
DEFAULT_OLDER_THAN_DAYS = 30
TERMINAL_TASK_IDS = frozenset({'run-complete', 'run-failed', 'run-cancelled'})
#: Authoritative streams and their integrity/recovery metadata: never archived, wherever they appear.
NEVER_ARCHIVE = frozenset({'events.jsonl', 'metrics.jsonl', 'outcomes.jsonl', 'discoveries.jsonl', LEDGER_FILE, WRITER_LOCK_FILE,
                           RECORD_INDEX_FILE, DATABASE_FILE, 'ingest_status.json', MANIFEST_FILE, ARCHIVE_LOCK_FILE})
#: Kept readable in place even when the rest of the run is archived (the HT progress board links to it).
KEEP_READABLE = frozenset({'run.log'})
RESTORE_COMMAND = 'python3 -m orchestrator.cli restore-run {run_id}'
CHUNK = 1 << 20
SAMPLE_BYTES = 256 * 1024
COMPRESS_LEVEL = 6
FREE_SPACE_MARGIN = 1 << 20


# --------------------------------------------------------------------------------------------
# Terminal outcomes and age
# --------------------------------------------------------------------------------------------

def parse_ts(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value: return None
    try: parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError: return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def terminal_outcomes(root: Path) -> dict[str, dict[str, Any]]:
    """Latest durable terminal outcome per run id, streamed from `outcomes.jsonl` (missing file -> {})."""
    latest: dict[str, dict[str, Any]] = {}
    for row in iter_jsonl(Path(root) / 'outcomes.jsonl'):
        run_id = row.get('run_id'); task_id = row.get('task_id')
        if not isinstance(run_id, str) or task_id not in TERMINAL_TASK_IDS: continue
        latest[run_id] = {'task_id': task_id, 'ts': row.get('ts'), 'outcome': row.get('outcome'), 'finished_at': row.get('finished_at')}
    return latest


def validate_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or not run_id or run_id in ('.', '..') or run_id.startswith('.') or Path(run_id).name != run_id or '/' in run_id or '\\' in run_id:
        raise ValueError(f'run_id must be a plain run directory name, got {run_id!r}')
    return run_id


def _validate_days(older_than_days: float) -> float:
    if not isinstance(older_than_days, (int, float)) or isinstance(older_than_days, bool) or math.isnan(older_than_days) or older_than_days <= 0:
        raise ValueError(f'older_than_days must be a positive number of days, got {older_than_days!r}')
    return float(older_than_days)


# --------------------------------------------------------------------------------------------
# Hashing / compression primitives
# --------------------------------------------------------------------------------------------

def _private_temp(dest: Path) -> tuple[int, Path]:
    # mkstemp uses O_EXCL and mode 0600 from creation, regardless of the caller's umask.
    fd, name = tempfile.mkstemp(prefix=f'.{dest.name}.', suffix='.tmp', dir=dest.parent)
    return fd, Path(name)


def _open_regular(path: Path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(f'not a regular file: {path}')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def _digest_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256(); n = 0
    with _open_regular(path) as f:
        for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk)
    return h.hexdigest(), n


def _decompressed_digest(archive_path: Path) -> tuple[str, int]:
    """SHA-256 and byte count of the fully decompressed archive (raises on corrupt gzip data)."""
    h = hashlib.sha256(); n = 0
    with _open_regular(archive_path) as source, gzip.GzipFile(fileobj=source, mode='rb') as f:
        for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk)
    return h.hexdigest(), n


def _compress_to_temp(src: Path, dest: Path) -> tuple[Path, str, int]:
    """gzip `src` into a fresh same-directory temp file for `dest`; return (tmp, raw sha256, raw bytes). fsynced."""
    fd, tmp = _private_temp(dest)
    try:
        h = hashlib.sha256(); n = 0
        with os.fdopen(fd, 'wb') as raw_out:
            # mtime=0 and no embedded filename: identical input yields identical archive bytes.
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw_out, compresslevel=COMPRESS_LEVEL, mtime=0) as gz, _open_regular(src) as f:
                for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk); gz.write(chunk)
            raw_out.flush(); os.fsync(raw_out.fileno())
        return tmp, h.hexdigest(), n
    except BaseException:
        _unlink_quietly(tmp); raise


def _decompress_to_temp(archive_path: Path, dest: Path) -> tuple[Path, str, int]:
    fd, tmp = _private_temp(dest)
    try:
        h = hashlib.sha256(); n = 0
        with os.fdopen(fd, 'wb') as out, _open_regular(archive_path) as source, gzip.GzipFile(fileobj=source, mode='rb') as f:
            for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk); out.write(chunk)
            out.flush(); os.fsync(out.fileno())
        return tmp, h.hexdigest(), n
    except BaseException:
        _unlink_quietly(tmp); raise


def _unlink_quietly(path: Path) -> None:
    try: path.unlink()
    except FileNotFoundError: pass


EMPTY_GZIP_BYTES = 20  # header + empty deflate block + trailer


def estimate_compressed_bytes(path: Path, size: int) -> int:
    """Estimate from compressed samples at the head, middle and tail (read-only; exact-ish up to the sample size).

    Event streams compress unevenly (short handshake lines first, big tool outputs later), so a
    head-only sample under-estimates them badly; three windows keep the estimate honest and cheap.
    """
    if size <= 0: return EMPTY_GZIP_BYTES
    with _open_regular(path) as f:
        if size <= SAMPLE_BYTES: return len(zlib.compress(f.read(), COMPRESS_LEVEL)) + 18  # gzip header/trailer over the deflate body
        window = SAMPLE_BYTES // 3; sampled = 0; compressed = 0
        for offset in (0, (size - window) // 2, size - window):
            f.seek(offset); chunk = f.read(window); sampled += len(chunk); compressed += len(zlib.compress(chunk, COMPRESS_LEVEL))
    return max(18, int(round(compressed * (size / max(1, sampled)))) + 18)


# --------------------------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------------------------

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


def load_seal(run_dir: Path) -> Optional[dict[str, Any]]:
    """Only the fresh-directory HT owner protocol may authorize raw removal.

    Absent metadata means legacy snapshot-only; partial managed ownership is skipped by planning.
    Malformed or unsafe metadata fails closed. The inventory binds removal to bytes written by
    that owner, not arbitrary later files.
    """
    values = []
    for name in (OWNER_FILE, SEAL_FILE):
        path = run_dir / name
        _validate_file(path)
        try:
            with _open_regular(path) as source: value = json.load(source, object_pairs_hook=_unique_object)
        except FileNotFoundError:
            values.append(None); continue
        except (OSError, UnicodeError, ValueError) as exc:
            raise ValueError(f'invalid diagnostic ownership metadata: {path}: {exc}') from exc
        if (not isinstance(value, dict) or type(value.get('format_version')) is not int
                or value['format_version'] != 1 or value.get('protocol') != SEAL_PROTOCOL
                or value.get('run_id') != run_dir.name or not isinstance(value.get('owner_id'), str)
                or not value['owner_id']):
            raise ValueError(f'invalid diagnostic ownership schema: {path}')
        values.append(value)
    owner, seal = values
    if owner is None or seal is None: return None
    if (owner['owner_id'] != seal['owner_id'] or parse_ts(seal.get('sealed_at')) is None
            or not isinstance(seal.get('files'), dict)):
        raise ValueError('diagnostic seal does not match its owner')
    for name, info in seal['files'].items():
        validate_run_id(name)
        if (name.startswith('.') or name in NEVER_ARCHIVE or name.endswith(ARCHIVE_SUFFIX)
                or not isinstance(info, dict) or type(info.get('raw_bytes')) is not int or info['raw_bytes'] < 0
                or not isinstance(info.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', info['sha256'])):
            raise ValueError(f'invalid diagnostic seal entry: {name!r}')
    return seal


def _stat_key(st: os.stat_result) -> tuple[int, ...]:
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


# --------------------------------------------------------------------------------------------
# Planning
# --------------------------------------------------------------------------------------------

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
                     f'no durable run-complete/run-failed/run-cancelled outcome for {run_id} in outcomes.jsonl; the run may still be active or its status is unknown')
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


# --------------------------------------------------------------------------------------------
# Execution
# --------------------------------------------------------------------------------------------

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


# --------------------------------------------------------------------------------------------
# Restore and lookup
# --------------------------------------------------------------------------------------------

def _restore_file(run_dir: Path, name: str, info: dict[str, Any]) -> Optional[dict[str, str]]:
    """Restore one manifest entry; return an error dict or None on success (manifest entry left for the caller)."""
    archive_path = run_dir / info['archive']; raw = run_dir / name
    _validate_file(archive_path); _validate_file(raw)
    if not archive_path.is_file(): return {'name': name, 'reason': 'archive_missing', 'detail': f'{archive_path} is not present'}
    if raw.exists():
        # A matching raw file does not establish that the recovery archive is valid.
        try:
            archived_digest = _decompressed_digest(archive_path)
            digest, size = _digest_file(raw)
        except (OSError, EOFError, zlib.error) as exc:
            return {'name': name, 'reason': 'verification_failed', 'detail': str(exc)}
        if archived_digest != (info['sha256'], info['raw_bytes']):
            return {'name': name, 'reason': 'verification_failed', 'detail': 'archive digest differs from manifest'}
        if digest == info.get('sha256') and size == info.get('raw_bytes'): return None  # already restored (interrupted earlier)
        return {'name': name, 'reason': 'raw_exists', 'detail': f'{raw} exists with different content; not overwritten'}
    try: tmp, digest, size = _decompress_to_temp(archive_path, raw)
    except (OSError, EOFError, zlib.error) as exc:
        return {'name': name, 'reason': 'verification_failed', 'detail': f'{archive_path.name} could not be decompressed: {exc}'}
    try:
        if digest != info.get('sha256') or size != info.get('raw_bytes'):
            return {'name': name, 'reason': 'verification_failed', 'detail': f'{archive_path.name} decompresses to a different digest than the manifest records; archive kept'}
        mtime = info.get('mtime_ns')
        if isinstance(mtime, int): os.utime(tmp, ns=(mtime, mtime))
        os.link(tmp, raw, follow_symlinks=False); fsync_directory(run_dir)
    except OSError as exc:
        return {'name': name, 'reason': 'publish_failed', 'detail': str(exc)}
    finally:
        _unlink_quietly(tmp)
    return None


def restore_run(root: Path, run_id: str, *, execute: bool = True) -> dict[str, Any]:
    """Restore every archived file of `run_id` byte-for-byte (verified against the manifest digest).

    `execute=False` only lists what would be restored. Originals are installed without clobbering
    any existing path. The gzip and manifest (including prior generations) remain recovery copies.
    Raises `ValueError` for invalid paths/manifests and `FileNotFoundError` for an unknown run.
    """
    root = Path(root); run_id = validate_run_id(run_id); run_dir = root / RUNS_DIR / run_id
    _validate_directory(run_dir)
    if not run_dir.is_dir(): raise FileNotFoundError(f'no run directory {run_dir}')
    result: dict[str, Any] = {'run_id': run_id, 'path': str(run_dir), 'restored': [], 'errors': [], 'would_restore': []}
    manifest = load_manifest(run_dir)
    if not manifest or not manifest['files']:
        result.update(status='not_archived', message=f'{run_id} is not archived: nothing to restore (its files under {run_dir} are readable as-is)'); return result
    names = sorted(manifest['files'])
    result['would_restore'] = names
    result['files'] = {n: {**manifest['files'][n], 'archive_path': str(run_dir / str(manifest['files'][n].get('archive', n + ARCHIVE_SUFFIX)))} for n in names}
    if not execute:
        result.update(status='dry_run', message=f'{len(names)} archived file(s) would be restored into {run_dir}'); return result
    with archive_lock(root):
        manifest = load_manifest(run_dir)
        if manifest is None: raise ValueError('manifest disappeared before restore; refusing stale recovery metadata')
        for name in sorted(manifest['files']):
            info = manifest['files'].get(name)
            if info is None: continue
            error = _restore_file(run_dir, name, info)
            if error: result['errors'].append(error); continue
            result['restored'].append(name)
    result['status'] = 'restored' if not result['errors'] else ('partial' if result['restored'] else 'failed')
    result['recovery_copies_retained'] = True
    result['message'] = f'restored {len(result["restored"])} file(s) into {run_dir}; gzip and manifest retained for recovery' + (f'; {len(result["errors"])} failed' if result['errors'] else '')
    return result


def locate_run_file(root: Path, run_id: str, name: str) -> dict[str, Any]:
    """Where a run diagnostic lives now: `readable` (raw path), `archived` (`.gz` + restore command) or `missing`."""
    validate_run_id(name)
    root = Path(root); run_dir = root / RUNS_DIR / validate_run_id(run_id); path = run_dir / name
    _validate_directory(run_dir); _validate_file(path)
    out: dict[str, Any] = {'run_id': run_id, 'name': name, 'path': str(path), 'archive': None, 'restore_command': None}
    if path.exists():
        out.update(status='readable', message=str(path)); return out
    manifest = load_manifest(run_dir); info = (manifest or {'files': {}})['files'].get(name)
    archive_path = run_dir / str(info.get('archive', name + ARCHIVE_SUFFIX)) if info else None
    if info and archive_path.exists():
        cmd = RESTORE_COMMAND.format(run_id=run_id)
        out.update(status='archived', archive=str(archive_path), restore_command=cmd,
                   message=f'{path} is archived as {archive_path} (gzip, SHA-256 verified when archived). Read it with `gunzip -c {archive_path}` or restore the run with: {cmd}')
        return out
    out.update(status='missing', message=f'{path} does not exist and is not listed in the run\'s archive manifest'); return out


def locate_path(root: Path, path: Path) -> dict[str, Any]:
    """`locate_run_file` for an absolute path; paths outside `<root>/runs/<id>/` are simply checked for existence."""
    root = Path(root).resolve(); path = Path(path)
    try: rel = path.resolve(strict=False).relative_to(root / RUNS_DIR)
    except ValueError: rel = None
    if rel is not None and len(rel.parts) == 2: return locate_run_file(root, rel.parts[0], rel.parts[1])
    return {'path': str(path), 'status': 'readable' if path.exists() else 'missing', 'archive': None, 'restore_command': None, 'message': str(path)}

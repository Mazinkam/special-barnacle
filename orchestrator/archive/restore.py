"""Restore archived files byte-for-byte, and locate where a run diagnostic currently lives.

Split out of `orchestrator/archive.py` (B3, `docs/architecture-review.md`); see
`orchestrator/archive/__init__.py` for the package overview and re-export contract.
"""
from __future__ import annotations

import os
import zlib
from pathlib import Path
from typing import Any, Optional

from ..runtime import fsync_directory
from .codec import _decompress_to_temp, _decompressed_digest, _digest_file, _unlink_quietly
from .execute import archive_lock
from .manifest import ARCHIVE_SUFFIX, RESTORE_COMMAND, RUNS_DIR, _validate_directory, _validate_file, load_manifest, validate_run_id


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

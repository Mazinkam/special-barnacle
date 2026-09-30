#!/usr/bin/env python3
"""Relabel historical call rows that recorded `cost_usd: 0` without any reported usage.

Such rows are not free calls; `economics.cost_class` already reads them as unmetered, so derived
numbers do not change. This makes the stored fact honest: `cost_usd` is removed and
`cost_source` becomes `unknown-no-usage-reported`. Genuinely free calls (zero cost WITH reported
tokens), decision events and already-unknown rows are untouched.

Safety (spec §1.4; same posture as audit_and_clean_metrics.py / stamp_granularity.py):
  * dry run by default; `--write` required; refuses the live state root without `--allow-live-state`;
  * read→backup→replace under the shared writer lock; atomic temp-file + fsync + os.replace;
  * malformed lines are preserved byte-for-byte, never dropped;
  * manifest records source/backup sha256 and every changed field; `--restore MANIFEST` puts the
    backup back after verifying its hash; a second `--write` is a no-op;
  * derived state (record index, ledger) is rebuilt after the lock is released.

Usage: python3 scripts/migrate_unmetered_zero_costs.py STATE_DIR [--write] [--allow-live-state] [--restore MANIFEST]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator import records  # noqa: E402
from orchestrator.core.env import default_state_root  # noqa: E402
from orchestrator.economics import has_reported_tokens  # noqa: E402
from orchestrator.runtime import writer_lock  # noqa: E402

MIGRATION_ID = 'm20260929-unmetered-zero'
NEW_SOURCE = 'unknown-no-usage-reported'


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _is_live(root: Path) -> bool:
    live = default_state_root()
    try:
        return live.exists() and os.path.samefile(root, live)
    except OSError:
        return root.resolve() == live.resolve()


def is_candidate(row: dict) -> bool:
    if row.get('migration_id') == MIGRATION_ID or records.classify(row) != records.CALL:
        return False
    if 'cost_usd' not in row:
        return False
    v = row['cost_usd']
    zero = isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0
    return zero and not has_reported_tokens(row) and not str(row.get('cost_source') or '').lower().startswith('unknown')


def plan(lines: list[bytes]) -> tuple[list[bytes], list[dict]]:
    out, changed = [], []
    for i, raw in enumerate(lines, start=1):
        try:
            row = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            out.append(raw); continue
        if not isinstance(row, dict) or not is_candidate(row):
            out.append(raw); continue
        changed.append({'line': i, 'record_id': row.get('record_id'),
                        'original': {'cost_usd': row.get('cost_usd'), 'cost_source': row.get('cost_source')}})
        row.pop('cost_usd', None)
        row['cost_source'] = NEW_SOURCE
        row['migration_id'] = MIGRATION_ID
        out.append((json.dumps(row, sort_keys=True) + '\n').encode('utf-8'))
    return out, changed


def _atomic_write(target: Path, chunks: list[bytes]) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=f'.{target.name}.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as fh:
            for c in chunks:
                fh.write(c)
            fh.flush(); os.fsync(fh.fileno())
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _rebuild(root: Path) -> None:
    from orchestrator.state import rebuild  # takes the writer lock itself; call after release
    rebuild(root)


def restore(root: Path, manifest_path: Path) -> int:
    m = json.loads(manifest_path.read_text())
    backup = Path(m['backup'])
    if not backup.is_absolute():
        backup = manifest_path.resolve().parent / backup
    if _sha256(backup) != m['backup_sha256']:
        print('error: backup hash mismatch; refusing to restore', file=sys.stderr); return 1
    with writer_lock(root):
        if m.get('migrated_sha256') is None or _sha256(root / 'metrics.jsonl') != m['migrated_sha256']:
            print('error: metrics.jsonl changed since migration; refusing to restore (would discard newer rows)',
                  file=sys.stderr)
            return 1
        _atomic_write(root / 'metrics.jsonl', [backup.read_bytes()])
    _rebuild(root)
    print(json.dumps({'restored_from': str(backup)}))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('state_dir', type=Path)
    p.add_argument('--write', action='store_true')
    p.add_argument('--allow-live-state', action='store_true')
    p.add_argument('--restore', type=Path)
    a = p.parse_args(argv)
    root: Path = a.state_dir.resolve()
    if (a.write or a.restore) and _is_live(root) and not a.allow_live_state:
        print('error: refusing to modify the live state root without --allow-live-state', file=sys.stderr)
        return 2
    if a.restore:
        return restore(root, a.restore)
    metrics = root / 'metrics.jsonl'
    if not a.write:
        _, changed = plan(metrics.read_bytes().splitlines(keepends=True))
        print(json.dumps({'mode': 'dry-run', 'candidates': len(changed)}))
        return 0
    with writer_lock(root):
        source_sha = _sha256(metrics)
        new_lines, changed = plan(metrics.read_bytes().splitlines(keepends=True))
        if not changed:
            print(json.dumps({'mode': 'write', 'candidates': 0}))
            return 0
        ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = root / f'metrics.pre-migrate-unmetered-zero-{ts}.jsonl'
        shutil.copy2(metrics, backup)
        if _sha256(backup) != source_sha:
            print('error: backup verification failed', file=sys.stderr); return 1
        manifest = root / f'migration-unmetered-zero-{ts}.json'
        doc = {'migration_id': MIGRATION_ID, 'source_sha256': source_sha,
               'backup': str(backup), 'backup_sha256': source_sha, 'changed': changed}
        manifest.write_text(json.dumps(doc, indent=2))
        _atomic_write(metrics, new_lines)
        doc['migrated_sha256'] = _sha256(metrics)
        manifest.write_text(json.dumps(doc, indent=2))
    _rebuild(root)
    print(json.dumps({'mode': 'write', 'candidates': len(changed), 'backup': str(backup), 'manifest': str(manifest)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

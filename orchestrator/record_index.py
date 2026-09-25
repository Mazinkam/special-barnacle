"""Rebuildable exact-ID SQLite cache. JSONL, never SQLite, is authoritative.

Trust boundary: ``records.checkpoint.json`` is an independent writer receipt,
NOT a membership list or a self-checksum supplied by the database. It records
OS metadata of the *closed, committed* database. Ordinary filesystem edits,
replacement, truncation, restored snapshots (even with restored mtime), or a leftover journal
invalidate the receipt before any lookup. Missing/invalid receipts force full
JSONL derivation. The cache cannot publish its own receipt. No periodic audits
or full membership parse/serialization occur on the normal path.

This is tamper detection for cache-only writers and crash recovery, not hostile
same-user isolation: the receipt, writer code/process, OS ctime/inode reporting,
and advisory writer lock must be trusted. This requires local POSIX filesystem
ctime/inode semantics (as with the existing flock contract); latent media corruption
that changes bytes without updating metadata is not authenticated by this receipt.
An actor able to forge BOTH database
and receipt, manipulate OS metadata, or mutate files during the lock can bypass
this boundary. Restrict the whole state directory to trusted writers; do not
import receipts with externally supplied databases. Delete the receipt (or run
rebuild) to validate all membership from JSONL. A secret stored alongside these
files would not protect against that same-user actor either.

Legacy external JSONL writers must append under the shared lock. File replacement,
shrinkage and same-size edits cause re-derivation; append growth reconciles only
the suffix, checking the previous prefix boundary. Arbitrary edits to historical
JSONL combined with append growth are outside the append-only contract: discard
the receipt/rebuild after an intentional history edit. No canonical bytes are
ever removed here. Malformed tails have a separately saved observed file identity
so an unchanged fragment is not repeatedly parsed by unrelated writes.

Cache keys are BLOBs: the exact Python string of a ``record_id`` encoded as UTF-8
with ``surrogatepass`` (see ``encode_key``). ``json.loads`` accepts an escaped
lone surrogate such as ``"\\ud800"`` that the sqlite3 TEXT binding rejects; a
historical line like that must never make derivation raise, or every later write
would fail forever. The encoding is injective (valid UTF-8 never contains encoded
surrogates) and reversible, so no two distinct ids share a key. Only string ids
are indexed: the writer never accepts a non-string id, so a foreign ``7`` has no
retry to dedup and must not shadow a legitimate new ``"7"``.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .contract import STREAMS
# core.fs/core.jsonl, not runtime: record_batch (which uses this module) is imported by
# store.facade.EventStore, which orchestrator.runtime re-exports; importing runtime here would
# cycle (see docs/architecture-review.md B2.2/B2.3).
from .core.fs import RECORD_INDEX_FILE, read_json
from .core.jsonl import tail_fingerprint

DATABASE_FILE = 'records.index.sqlite3'
INDEX_VERSION = 2  # 2: BLOB keys (surrogatepass); receipts of version 1 (TEXT keys) are discarded
# STREAMS is re-exported from contract.py (its canonical home); it used to be defined here.


def encode_key(record_id: str) -> bytes:
    """Reversible cache key for any Python string, including lone surrogates from historical JSON."""
    return record_id.encode('utf-8', 'surrogatepass')


def decode_key(key: bytes) -> str:
    return bytes(key).decode('utf-8', 'surrogatepass')


def signature(path: Path) -> list[int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def discard(root: Path) -> None:
    """Invalidate first, then discard only derived cache files. Caller holds writer_lock."""
    for name in (RECORD_INDEX_FILE, DATABASE_FILE, DATABASE_FILE + '-journal',
                 DATABASE_FILE + '-wal', DATABASE_FILE + '-shm'):
        (root / name).unlink(missing_ok=True)


class RecordIndex:
    """One locked write's cache transaction; close/rollback on every exit path.

    Call commit only after all canonical streams have been fsynced. Publish the
    returned receipt durably *after* commit/close. A crash in between forces a
    rebuild; an old cache transaction never overrides the authoritative stream.
    """

    def __init__(self, root: Path):
        self.root = root
        self.db: sqlite3.Connection | None = None
        self.entries: dict[str, dict[str, Any]] = {}
        receipt_path = root / RECORD_INDEX_FILE
        receipt = read_json(receipt_path, None) if receipt_path.exists() and receipt_path.stat().st_size < 16384 else None
        path = root / DATABASE_FILE
        trusted = (isinstance(receipt, dict) and receipt.get('format_version') == INDEX_VERSION
                   and signature(path) is not None and not path.is_symlink()
                   and receipt.get('database') == signature(path)
                   and not any((root / (DATABASE_FILE + suffix)).exists() for suffix in ('-journal', '-wal', '-shm')))
        if not trusted:
            discard(root)
        try:
            self._open()
        except (sqlite3.DatabaseError, ValueError, KeyError, TypeError):
            # Corrupt schema/pages or invalid metadata: derive from JSONL, once.
            self.close()
            discard(root)
            try:
                self._open()
            except BaseException:
                self.close()
                raise
        except BaseException:
            self.close()
            raise

    def _open(self) -> None:
        self.db = sqlite3.connect(self.root / DATABASE_FILE)
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS ids (stream TEXT NOT NULL, record_id BLOB NOT NULL, '
                        'PRIMARY KEY(stream, record_id)) WITHOUT ROWID')
        self.db.execute('CREATE TABLE IF NOT EXISTS meta (stream TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID')
        self.db.execute('BEGIN IMMEDIATE')
        saved = dict(self.db.execute('SELECT stream, value FROM meta'))
        for stream, name in STREAMS.items():
            path = self.root / name
            observed = signature(path)
            entry = json.loads(saved[stream]) if stream in saved else None
            if entry is not None and entry['observed'] == observed:
                entry['durable_size'] = entry['size']
            else:
                offset = 0
                durable = 0
                if entry and observed and entry['observed']:
                    previous = entry['observed']
                    if (observed[:2] == previous[:2] and observed[2] > previous[2]
                            and tail_fingerprint(path, entry['size']) == entry['tail_hash']):
                        offset = entry['size']
                        durable = offset
                if offset == 0:
                    self.db.execute('DELETE FROM ids WHERE stream=?', (stream,))
                entry = self._scan(stream, path, offset)
                entry['observed'] = observed
                entry['durable_size'] = durable
            self.entries[stream] = entry

    def _scan(self, stream: str, path: Path, offset: int) -> dict[str, Any]:
        end = offset
        tail = None
        if path.exists():
            with path.open('rb') as handle:
                handle.seek(offset)
                for line in handle:
                    complete = line.endswith(b'\n')
                    try:
                        record = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        record = None
                    if isinstance(record, dict) and isinstance(record.get('record_id'), str) and record['record_id']:
                        self.add(stream, record['record_id'])
                    if not complete:
                        tail = 'complete' if isinstance(record, dict) else 'fragment'
                        break
                    end += len(line)
        return {'size': end, 'tail': tail, 'tail_hash': tail_fingerprint(path, end)}

    def __getitem__(self, stream: str) -> dict[str, Any]:
        return self.entries[stream]

    def contains(self, stream: str, record_id: str) -> bool:
        return self.db.execute('SELECT 1 FROM ids WHERE stream=? AND record_id=?',
                               (stream, encode_key(record_id))).fetchone() is not None

    def add(self, stream: str, record_id: str) -> None:
        self.db.execute('INSERT OR IGNORE INTO ids VALUES (?, ?)', (stream, encode_key(record_id)))

    def commit(self) -> dict[str, Any]:
        for stream, entry in self.entries.items():
            path = self.root / STREAMS[stream]
            observed = signature(path)
            saved = {key: entry[key] for key in ('size', 'tail', 'tail_hash', 'observed')}
            if observed != entry['observed']:
                saved.update(observed=observed, tail_hash=tail_fingerprint(path, entry['size']),
                             tail=None if observed is None or observed[2] == entry['size'] else entry['tail'])
            self.db.execute('INSERT OR REPLACE INTO meta VALUES (?, ?)', (stream, json.dumps(saved)))
        self.db.commit()
        self.close()
        return {'format_version': INDEX_VERSION, 'database': signature(self.root / DATABASE_FILE)}

    def close(self) -> None:
        if self.db is not None:
            self.db.close()  # rolls back an uncommitted transaction
            self.db = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

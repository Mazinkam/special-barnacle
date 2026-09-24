"""Durable coordinated writes to the authoritative event/metric/outcome JSONL.

One advisory writer lock covers the state-root ancestry fsync, exact-ID classification,
append, fsync, derived cache commit/receipt, and incremental ledger publication. Input
validation is all-or-nothing; multi-stream append is not atomic. Every ambiguous failure
must be retried with the same IDs. No canonical bytes are rewritten or truncated.

The exact-ID SQLite cache uses unique (stream, record_id) keys. Its independent
receipt, validation boundary and crash recovery are documented in record_index.
Legacy JSON checkpoints v1-v4 are discarded, never migrated as trusted data.

A complete JSON object missing only its newline is recognized before dedup and
terminated before acknowledgement; malformed fragments are left untouched until
an append to that stream needs a separator. The ledger catches up to the complete
event prefix even on an unrelated or duplicate-only batch. `settle_streams` runs
the same durability step without records, for a reader (session ingestion) that
must not trust un-fsynced bytes an interrupted append left behind. Dashboard
rendering remains outside the writer lock. Public CLI/result/record formats are unchanged.
"""
from __future__ import annotations

import contextlib
import os
import secrets
import sqlite3
from pathlib import Path
from typing import Any

from .dashboard import generate_dashboard
from .record_index import RecordIndex, STREAMS
from .runtime import (RECORD_INDEX_FILE, default_attribution, default_state_root, encode_jsonl,
                      fsync_directory, fsync_directory_ancestry, meter, utc_now, write_json, writer_lock)
from .state import REDUCER_KEY_FIELDS, invalid_key_field, ledger_is_current, replay_ledger

FORMAT_VERSION = 1
CHECKPOINT_FILE = RECORD_INDEX_FILE
MAX_BATCH_RECORDS = 500
MAX_RECORD_ID_LENGTH = 200
RESERVED_KEYS = {'stream'}
RETRY_SAME_IDS = 'same_ids'


class BatchValidationError(ValueError):
    """The batch was rejected before any byte was written."""


class BatchAppendError(RuntimeError):
    """An append failed part-way; `persisted` says what is durable. Retry with the same ids."""

    def __init__(self, message: str, persisted: dict[str, int]):
        super().__init__(f'{message}; retry with the same record ids and only the missing records will be appended')
        self.persisted = persisted
        self.retry = RETRY_SAME_IDS


def new_record_id() -> str:
    return secrets.token_hex(12)


def _counts() -> dict[str, int]:
    return {stream: 0 for stream in STREAMS}


def validate_batch(records: Any) -> list[dict[str, Any]]:
    """Validate the complete batch before any append, naming the first bad record."""
    if isinstance(records, dict) and isinstance(records.get('records'), list):
        records = records['records']
    if not isinstance(records, list):
        raise BatchValidationError('batch must be a JSON array of records')
    if not records:
        raise BatchValidationError('batch must contain at least one record')
    if len(records) > MAX_BATCH_RECORDS:
        raise BatchValidationError(f'batch has {len(records)} records; the maximum is {MAX_BATCH_RECORDS}')
    seen: set[str] = set()
    for index, record in enumerate(records):
        where = f'record at index {index}'
        if not isinstance(record, dict):
            raise BatchValidationError(f'{where} must be a JSON object')
        stream = record.get('stream')
        if not isinstance(stream, str) or stream not in STREAMS:
            raise BatchValidationError(f'{where} has unsupported stream {stream!r}; expected one of {sorted(STREAMS)}')
        record_id = record.get('record_id')
        if not isinstance(record_id, str) or not record_id.strip():
            raise BatchValidationError(f'{where} is missing a non-empty string record_id')
        if len(record_id) > MAX_RECORD_ID_LENGTH:
            raise BatchValidationError(f'{where} record_id exceeds {MAX_RECORD_ID_LENGTH} characters')
        if record_id in seen:
            raise BatchValidationError(f'{where} repeats record_id {record_id!r} within the batch')
        seen.add(record_id)
        if stream == 'event' and (not isinstance(record.get('event'), str) or not record['event'].strip()):
            raise BatchValidationError(f'{where} is an event record without a non-empty event name')
        bad_key = invalid_key_field(record)
        if bad_key is not None:
            raise BatchValidationError(f'{where} has {bad_key} {record[bad_key]!r}; identifier fields '
                                       f'{list(REDUCER_KEY_FIELDS)} must be strings or null')
    return records


def single_record(stream: str, payload: Any, *, event: str | None = None) -> dict[str, Any]:
    """The command's stream/event win; reject contradictory payloads."""
    if not isinstance(payload, dict):
        raise BatchValidationError('payload must be a JSON object')
    if 'stream' in payload and payload['stream'] != stream:
        raise BatchValidationError(f'payload stream {payload["stream"]!r} conflicts with the {stream} command')
    if event is not None and 'event' in payload and payload['event'] != event:
        raise BatchValidationError(f'payload event {payload["event"]!r} conflicts with the event name {event!r} given to the command')
    record_id = payload.get('record_id')
    record = {**payload, 'stream': stream, 'record_id': new_record_id() if record_id is None else record_id}
    if event is not None:
        record['event'] = event
    return record


def build_record(record: dict[str, Any]) -> dict[str, Any]:
    payload = {k: v for k, v in record.items() if k not in RESERVED_KEYS}
    if record['stream'] == 'metric':
        payload = meter(payload)
    return {'ts': utc_now(), **default_attribution(), **payload}


def _write_checkpoint(root: Path, index: RecordIndex) -> None:
    """Commit/close the derived database, then durably publish its independent receipt."""
    receipt = index.commit()
    write_json(root / CHECKPOINT_FILE, receipt, compact=True, durable=True)


def _append_stream(path: Path, lines: list[bytes], *, prefix: int, tail: str | None) -> int:
    """Append and fsync using the tail already reconciled under the same writer lock.

    Even a multi-megabyte malformed tail needs only a separator, not another
    backwards read/JSON parse. With no new lines leave that fragment untouched.
    """
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o666)
    try:
        size = os.fstat(fd).st_size
        terminate = tail is not None and (bool(lines) or tail == 'complete')
        payload = (b'\n' if terminate else b'') + b''.join(lines)
        written = 0
        while written < len(payload):
            n = os.write(fd, payload[written:])
            if n == 0:
                raise OSError('append made no progress')
            written += n
        os.fsync(fd)
        # Sync names too, before counting this stream as persisted or touching
        # the next stream. Includes streams pre-created by EventStore.
        fsync_directory(path.parent)
        fsync_directory(path.parent.parent)
        return prefix if tail is not None and not terminate else size + len(payload)
    finally:
        os.close(fd)


def _sync_pending(root: Path, index: RecordIndex, persisted: dict[str, int], pending: dict[str, list[bytes]],
                  duplicates: dict[str, int]) -> list[str]:
    """Append `pending` lines and settle every stream whose complete prefix is not yet known durable.

    A stream needs a sync when it gets new lines, when a duplicate-only retry may be re-acknowledging
    bytes whose fsync failed, when bytes appeared since the last commit (`size != durable_size`) or
    when a complete object still lacks its newline. Returns the streams that were touched.
    """
    touched: list[str] = []
    for stream, lines in pending.items():
        entry = index[stream]; path = root / STREAMS[stream]
        needs_sync = bool(lines) or duplicates[stream] or entry['size'] != entry['durable_size'] or entry['tail'] == 'complete'
        if not needs_sync:
            continue
        try:
            entry['size'] = _append_stream(path, lines, prefix=entry['size'], tail=entry['tail'])
        except OSError as exc:
            raise BatchAppendError(f'append/fsync of {STREAMS[stream]} failed after persisting {persisted}: {exc}', persisted) from exc
        persisted[stream] = len(lines)
        touched.append(stream)
    return touched


def settle_streams(root: str | Path | None, *, lock: bool = True) -> dict[str, Any]:
    """Make what the streams already contain durable, without appending a record.

    A reader that is about to trust the streams as the record of what exists (session ingestion
    deciding what is already recorded) calls this first, under the same writer lock: bytes an
    earlier append wrote before its fsync failed become durable, and a complete object missing
    only its newline gets terminated, exactly as the next `write_batch` would do. A retry that
    then finds nothing new to append has still recovered the earlier write instead of vouching
    for page-cache bytes. Failures raise `BatchAppendError`; a failed receipt after a successful
    sync is reported (`status`) but the streams are durable.
    """
    root = Path(root) if root is not None else default_state_root()
    root.mkdir(parents=True, exist_ok=True)
    status = 'ok'; error: str | None = None; touched: list[str] = []
    with writer_lock(root) if lock else contextlib.nullcontext():
        try:
            fsync_directory_ancestry(root)
            index = RecordIndex(root)
        except (OSError, sqlite3.Error) as exc:
            raise BatchAppendError(f'could not make the state root durable or read the index/streams ({exc}); nothing was written', _counts()) from exc
        with index:
            touched = _sync_pending(root, index, _counts(), {stream: [] for stream in STREAMS}, _counts())
            if touched:
                try:
                    _write_checkpoint(root, index)
                except (OSError, sqlite3.Error) as exc:
                    status = 'checkpoint_failed'
                    error = f'checkpoint write failed after the streams were made durable: {exc}; the next write rebuilds the index'
    return {'ok': error is None, 'status': status, 'settled': touched, 'error': error}


def write_batch(root: str | Path | None, records: Any, *, config: dict | None = None, refresh: bool = True,
                lock: bool = True) -> dict[str, Any]:
    """Durably append once per ID; report derived-state failure with same-ID retry guidance.

    `lock=False` is for a caller that already holds `writer_lock(root)` and must keep its own
    check/append/checkpoint sequence under that one lock (session ingestion). `flock` is per open
    file description, so re-acquiring here would deadlock. Such a caller refreshes afterwards,
    outside its lock: the dashboard render never runs under the writer lock.
    """
    if not lock and refresh:
        raise ValueError('write_batch(lock=False) requires refresh=False; refresh the ledger/dashboard after releasing the lock')
    validated = validate_batch(records)
    root = Path(root) if root is not None else default_state_root()
    root.mkdir(parents=True, exist_ok=True)  # the lock file lives inside; durability of the chain is settled under the lock
    persisted = _counts(); duplicates = _counts(); statuses: list[dict[str, Any]] = []
    built: list[dict[str, Any]] = []
    ledger_updated = False; dashboard_updated = False; error: str | None = None; status = 'ok'
    with writer_lock(root) if lock else contextlib.nullcontext():
        try:
            # Existence is not durability: whoever created these directories (this call, a concurrent
            # writer that has not synced yet, an attempt whose fsync failed), sync the whole chain
            # before a single record byte is written or acknowledged.
            fsync_directory_ancestry(root)
            index = RecordIndex(root)
        except (OSError, sqlite3.Error) as exc:
            raise BatchAppendError(f'could not make the state root durable or read the index/streams before appending ({exc}); nothing was written', _counts()) from exc
        with index:
            pending: dict[str, list[bytes]] = {stream: [] for stream in STREAMS}
            new_ids: dict[str, list[str]] = {stream: [] for stream in STREAMS}
            try:
                for record in validated:
                    stream = record['stream']; record_id = record['record_id']
                    if index.contains(stream, record_id):
                        duplicates[stream] += 1
                        statuses.append({'record_id': record_id, 'stream': stream, 'status': 'duplicate'})
                        built.append({k: v for k, v in record.items() if k not in RESERVED_KEYS})
                        continue
                    materialized = build_record(record)
                    pending[stream].append(encode_jsonl(materialized))
                    new_ids[stream].append(record_id)
                    built.append(materialized)
                    statuses.append({'record_id': record_id, 'stream': stream, 'status': 'persisted'})
            except sqlite3.Error as exc:
                raise BatchAppendError(f'index lookup failed before appending: {exc}', _counts()) from exc
            _sync_pending(root, index, persisted, pending, duplicates)
            try:
                for stream, ids in new_ids.items():
                    for record_id in ids:
                        index.add(stream, record_id)
                _write_checkpoint(root, index)
            except (OSError, sqlite3.Error) as exc:
                status = 'checkpoint_failed'
                error = (f'checkpoint write failed after the records were durably appended: {exc}; '
                         f'retry with the same record ids to rebuild the index and refresh the ledger')
            if refresh and error is None:
                try:
                    if not ledger_is_current(root, index['event']['size']):
                        replay_ledger(root)
                        ledger_updated = True
                except Exception as exc:  # noqa: BLE001 - records are already durable
                    status = 'refresh_failed'; error = f'ledger refresh failed: {exc}'
    if refresh and error is None:
        try:
            generate_dashboard(root, config=config)
            dashboard_updated = True
        except Exception as exc:  # noqa: BLE001 - records are already durable
            status = 'refresh_failed'; error = f'dashboard refresh failed: {exc}'
    return {
        'ok': error is None, 'status': status, 'format_version': FORMAT_VERSION,
        'persisted': persisted, 'duplicates': duplicates, 'ledger_updated': ledger_updated,
        'dashboard_updated': dashboard_updated, 'error': error, 'retry': None if error is None else RETRY_SAME_IDS,
        'statuses': statuses, 'records': built,
    }

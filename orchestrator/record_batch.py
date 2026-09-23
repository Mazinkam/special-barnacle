"""Durable, coordinated batch writes for the orchestrator's authoritative JSONL streams.

This is the single writer behind the CLI `batch`, `event`, `metric` and `outcome` commands and
behind `EventStore.emit/metric/outcome`. It owns three rules that every writer must share:

1. **One process-safe lock** (`runtime.writer_lock`, the `ledger.lock` file) around
   check → append → fsync → checkpoint → incremental ledger replay. Rebuilds take the same lock,
   so a published ledger always describes a complete prefix of `events.jsonl`.
2. **Idempotency by stable `record_id`, decided by the authoritative stream.** The checkpoint
   (`records.checkpoint.json`) caches an *exact* index of every record id per stream, bound to the
   stream by its complete-prefix size, a fingerprint of the last line and a checksum of the ids.
   A cached "already present" verdict is never trusted on its own: before a record is reported as
   a duplicate its stream is re-read and the index rebuilt from it, so a wrong cache can only ever
   cost an extra append (collapsed by full replay), never a silently discarded record. A record
   whose full JSON is present but lacks its newline counts as present; the newline is added before
   it is acknowledged so replay sees it. Visible bytes that no checkpoint vouched for (a writer
   that died between `write` and `fsync`, or whose `fsync` failed) are fsynced before they are
   acknowledged as duplicates or covered by a checkpoint.
3. **JSONL is authoritative and append-only.** Records are appended and fsynced before anything is
   acknowledged; the checkpoint and ledger are derived and rebuildable. A batch is validated
   all-or-nothing before any byte is written (shape, stream, record_id, event name, and the
   identifier fields the ledger reducer keys on), but appends across the three files are not
   atomic: an I/O failure between streams leaves the already-appended records durable and
   unacknowledged, and the same-id retry skips them. Existing bytes are never rewritten or
   truncated: a torn fragment is only ever terminated with a newline when something must be
   appended after it (so the new record is parseable); otherwise it is left alone.

Persisted format (`format_version` 1): one JSON object per line, each carrying `record_id`, `ts`,
`agent_runtime`, `repository`, and the caller's payload (`event` records carry `event`; metric
records pass through `runtime.meter`). The `stream` key is not persisted — the file is the stream.

Result shape of `write_batch`:
    {'ok': bool, 'status': 'ok'|'checkpoint_failed'|'refresh_failed', 'format_version': 1,
     'persisted': {'event': n, 'metric': n, 'outcome': n}, 'duplicates': {...same keys...},
     'ledger_updated': bool, 'dashboard_updated': bool, 'error': None|str,
     'retry': None|'same_ids',
     'statuses': [{'record_id', 'stream', 'status': 'persisted'|'duplicate'}, ...],
     'records': [persisted record dicts in batch order]}
`retry == 'same_ids'` means the records are durable but derived state is behind: resubmit the
same batch (same ids) and the writer will catch up without appending anything twice.
"""
from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any

from .dashboard import generate_dashboard
from .runtime import (default_attribution, default_state_root, encode_jsonl, iter_jsonl_from, meter, read_json,
                      stable_hash, tail_fingerprint, utc_now, write_json, writer_lock)
from .state import REDUCER_KEY_FIELDS, invalid_key_field, replay_ledger

FORMAT_VERSION = 1
CHECKPOINT_FILE = 'records.checkpoint.json'
CHECKPOINT_VERSION = 2
STREAMS: dict[str, str] = {'event': 'events.jsonl', 'metric': 'metrics.jsonl', 'outcome': 'outcomes.jsonl'}
MAX_BATCH_RECORDS = 500
MAX_RECORD_ID_LENGTH = 200
RESERVED_KEYS = {'stream'}
RETRY_SAME_IDS = 'same_ids'
_TAIL_CHUNK = 65536


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


# --- validation --------------------------------------------------------------------------------

def validate_batch(records: Any) -> list[dict[str, Any]]:
    """Return the validated records or raise `BatchValidationError` describing the first problem."""
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
    """Build the one-record batch for a single-record command; the command's stream/event win.

    A payload that names a *different* stream or event is contradictory and rejected rather than
    silently redirected; a missing record_id gets a fresh one.
    """
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
    """Materialize the persisted form of a validated input record (stamps ts/attribution, meters metrics)."""
    payload = {k: v for k, v in record.items() if k not in RESERVED_KEYS}
    if record['stream'] == 'metric':
        payload = meter(payload)
    return {'ts': utc_now(), **default_attribution(), **payload}


# --- exact id index (checkpoint) ---------------------------------------------------------------

def _ids_hash(ids: list[str]) -> str:
    return stable_hash(ids)


def _is_complete_record(tail: bytes) -> bool:
    """True when an unterminated tail is a whole JSON object (objects are self-delimiting)."""
    try:
        return isinstance(json.loads(tail), dict)
    except (ValueError, UnicodeDecodeError):
        return False


def _record_id_of(record: Any) -> str | None:
    if isinstance(record, dict) and record.get('record_id'):
        return str(record['record_id'])
    return None


def _scan_ids(path: Path, offset: int, into: list[str]) -> tuple[int, str | None]:
    """Collect record ids from `offset` on. Returns (complete-prefix end, tail kind).

    Tail kind is None (stream ends in a newline), 'complete' (a whole record missing only its
    newline; its id is collected because the record is already durable data) or 'fragment'.
    """
    end = offset
    for record, end in iter_jsonl_from(path, offset):
        rid = _record_id_of(record)
        if rid:
            into.append(rid)
    size = path.stat().st_size if path.exists() else 0
    if size <= end:
        return end, None
    with path.open('rb') as handle:
        handle.seek(end)
        tail = handle.read()
    if _is_complete_record(tail):
        rid = _record_id_of(json.loads(tail))
        if rid:
            into.append(rid)
        return end, 'complete'
    return end, 'fragment'


def _valid_entry(entry: Any, path: Path, size_now: int) -> bool:
    """Does this checkpoint entry still describe a complete prefix of the stream, with intact ids?"""
    if not isinstance(entry, dict):
        return False
    size = entry.get('size'); ids = entry.get('ids'); tail_hash = entry.get('tail_hash')
    if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > size_now:
        return False
    if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
        return False
    if entry.get('ids_hash') != _ids_hash(ids):
        return False
    if size == 0:
        return tail_hash is None
    return isinstance(tail_hash, str) and tail_hash != 'unterminated' and tail_fingerprint(path, size) == tail_hash


def _from_stream(path: Path, entry: dict[str, Any], offset: int, ids: list[str]) -> None:
    end, tail = _scan_ids(path, offset, ids)
    entry.update({'size': end, 'ids': ids, 'known': set(ids), 'tail': tail})


def _load_index(root: Path) -> dict[str, dict[str, Any]]:
    """Exact record-id index per stream: the checkpoint where it is provably current, the stream otherwise.

    `durable_size` is how many bytes an earlier writer's checkpoint vouched as fsynced; anything the
    index learns beyond that from the stream itself must be fsynced before it is acknowledged.
    """
    raw = read_json(root / CHECKPOINT_FILE, None)
    saved = raw.get('streams') if isinstance(raw, dict) and raw.get('format_version') == CHECKPOINT_VERSION else None
    if not isinstance(saved, dict):
        saved = {}
    index: dict[str, dict[str, Any]] = {}
    for stream, name in STREAMS.items():
        path = root / name
        size_now = path.stat().st_size if path.exists() else 0
        saved_entry = saved.get(stream)
        entry: dict[str, Any] = {'durable_size': 0}
        if _valid_entry(saved_entry, path, size_now):
            entry['durable_size'] = saved_entry['size']
            _from_stream(path, entry, saved_entry['size'], list(saved_entry['ids']))
        else:
            _from_stream(path, entry, 0, [])
        index[stream] = entry
    return index


def _rebuild_from_stream(root: Path, stream: str, entry: dict[str, Any]) -> None:
    """Derive a stream's membership from the authoritative file, discarding the cached ids."""
    _from_stream(root / STREAMS[stream], entry, 0, [])


def _write_checkpoint(root: Path, index: dict[str, dict[str, Any]]) -> None:
    streams = {}
    for stream, entry in index.items():
        path = root / STREAMS[stream]
        size = entry['size']
        streams[stream] = {'size': size, 'tail_hash': tail_fingerprint(path, size) if size else None,
                           'ids': list(entry['ids']), 'ids_hash': _ids_hash(entry['ids'])}
    write_json(root / CHECKPOINT_FILE, {'format_version': CHECKPOINT_VERSION, 'streams': streams}, compact=True)


# --- append ------------------------------------------------------------------------------------

def _unterminated_tail(fd: int, size: int) -> bytes | None:
    """Bytes after the last newline, or None when the file is empty or newline-terminated."""
    if size == 0 or os.pread(fd, 1, size - 1) == b'\n':
        return None
    tail = b''; pos = size
    while pos > 0:
        start = max(0, pos - _TAIL_CHUNK)
        part = os.pread(fd, pos - start, start)
        cut = part.rfind(b'\n')
        if cut != -1:
            return part[cut + 1:] + tail
        tail = part + tail; pos = start
    return tail


def _append_stream(path: Path, lines: list[bytes]) -> int:
    """Append encoded lines and fsync; return the size of the complete (newline-terminated) prefix.

    An unterminated tail that is a whole JSON record gets its newline (it is data that must become
    replayable). A torn fragment is terminated only when lines follow it, so the new records are
    parseable; with nothing to append it is left untouched. Bytes are never rewritten or truncated.
    Called with no lines this is the "make this stream durable" primitive.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o666)
    try:
        size = os.fstat(fd).st_size
        tail = _unterminated_tail(fd, size)
        terminate = tail is not None and (bool(lines) or _is_complete_record(tail))
        payload = (b'\n' if terminate else b'') + b''.join(lines)
        written = 0
        while written < len(payload):
            written += os.write(fd, payload[written:])
        os.fsync(fd)
        if tail is not None and not terminate:
            return size - len(tail)
        return size + len(payload)
    finally:
        os.close(fd)


def write_batch(root: str | Path | None, records: Any, *, config: dict | None = None, refresh: bool = True) -> dict[str, Any]:
    """Validate, append (deduplicated by record_id), checkpoint, and optionally refresh ledger + dashboard.

    Raises `BatchValidationError` (nothing written) or `BatchAppendError` (partial durable append;
    `persisted` says what is). Failures after the records are durable never raise: the result
    reports `status` `checkpoint_failed` or `refresh_failed` with the durable counts and
    `retry='same_ids'`, so a caller resubmits the same ids without duplicating work.
    """
    validated = validate_batch(records)
    root = Path(root) if root is not None else default_state_root()
    root.mkdir(parents=True, exist_ok=True)
    persisted = _counts(); duplicates = _counts(); statuses: list[dict[str, Any]] = []
    built: list[dict[str, Any]] = []
    ledger_updated = False; dashboard_updated = False; error: str | None = None; status = 'ok'
    with writer_lock(root):
        try:
            index = _load_index(root)
            # A cached "present" verdict is confirmed against the authoritative stream before it can
            # turn a record into a duplicate; the rebuilt index then decides for the whole stream.
            for stream in {r['stream'] for r in validated if r['record_id'] in index[r['stream']]['known']}:
                _rebuild_from_stream(root, stream, index[stream])
        except OSError as exc:
            raise BatchAppendError(f'could not read the streams before appending ({exc}); nothing was written', _counts()) from exc
        pending: dict[str, list[bytes]] = {stream: [] for stream in STREAMS}
        new_ids: dict[str, list[str]] = {stream: [] for stream in STREAMS}
        for record in validated:
            stream = record['stream']; record_id = record['record_id']
            if record_id in index[stream]['known']:
                duplicates[stream] += 1
                statuses.append({'record_id': record_id, 'stream': stream, 'status': 'duplicate'})
                built.append({k: v for k, v in record.items() if k not in RESERVED_KEYS})
                continue
            materialized = build_record(record)
            pending[stream].append(encode_jsonl(materialized))
            index[stream]['known'].add(record_id); new_ids[stream].append(record_id)
            built.append(materialized)
            statuses.append({'record_id': record_id, 'stream': stream, 'status': 'persisted'})
        modified: dict[str, bool] = {stream: False for stream in STREAMS}
        for stream, lines in pending.items():
            entry = index[stream]; path = root / STREAMS[stream]
            # Sync when appending, when acknowledging duplicates, when the index learned bytes no
            # checkpoint vouched for, or when a whole record is waiting for its newline.
            needs_sync = bool(lines) or duplicates[stream] or entry['size'] != entry['durable_size'] or entry['tail'] == 'complete'
            if not needs_sync:
                continue
            try:
                new_size = _append_stream(path, lines)
            except OSError as exc:
                what = f'append to {STREAMS[stream]}' if lines else f'fsync of {STREAMS[stream]} (its {duplicates[stream]} visible duplicate(s) are not acknowledged)'
                raise BatchAppendError(f'{what} failed after persisting {persisted}: {exc}', persisted) from exc
            persisted[stream] = len(lines)
            entry['ids'].extend(new_ids[stream])
            modified[stream] = bool(lines) or entry['tail'] == 'complete' or new_size != entry['size']
            entry['size'] = new_size
        try:
            _write_checkpoint(root, index)
        except OSError as exc:
            status = 'checkpoint_failed'
            error = (f'checkpoint write failed after the records were durably appended: {exc}; '
                     f'retry with the same record ids to rebuild the index and refresh the ledger')
        # Refresh for duplicate events too: a retry after a crash between checkpoint and ledger
        # publish must still bring the ledger up to the work it is now acknowledging.
        touched_events = persisted['event'] or duplicates['event'] or modified['event']
        if refresh and error is None and (touched_events or _ledger_missing(root)):
            try:
                replay_ledger(root)
                ledger_updated = True
            except Exception as exc:  # noqa: BLE001 - reported to the caller, records are already durable
                status = 'refresh_failed'; error = f'ledger refresh failed: {exc}'
    if refresh and error is None:
        try:
            generate_dashboard(root, config=config)
            dashboard_updated = True
        except Exception as exc:  # noqa: BLE001 - reported to the caller, records are already durable
            status = 'refresh_failed'; error = f'dashboard refresh failed: {exc}'
    return {
        'ok': error is None, 'status': status, 'format_version': FORMAT_VERSION,
        'persisted': persisted, 'duplicates': duplicates, 'ledger_updated': ledger_updated,
        'dashboard_updated': dashboard_updated, 'error': error, 'retry': None if error is None else RETRY_SAME_IDS,
        'statuses': statuses, 'records': built,
    }


def _ledger_missing(root: Path) -> bool:
    return not (root / 'ledger.json').exists()

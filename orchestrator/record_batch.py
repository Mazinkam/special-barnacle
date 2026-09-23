"""Durable, coordinated batch writes for the orchestrator's authoritative JSONL streams.

This is the single writer behind the CLI `batch`, `event`, `metric` and `outcome` commands and
behind `EventStore.emit/metric/outcome`. It owns three rules that every writer must share:

1. **One process-safe lock** (`runtime.writer_lock`, the `ledger.lock` file) around
   check → append → fsync → checkpoint → incremental ledger replay. Rebuilds take the same lock,
   so a published ledger always describes a complete prefix of `events.jsonl`.
2. **Idempotency by stable `record_id`.** A record whose id was already appended to the same
   stream is reported as a duplicate and not written again. The dedup window is rebuilt from the
   JSONL tail whenever the checkpoint is missing, malformed, or behind the file, so a crash
   between append and acknowledgement (or a lost checkpoint) is recovered by retrying with the
   same ids. The window is bounded (`DEDUP_WINDOW` most recent ids per stream); repeats older than
   that are collapsed by the full `rebuild` replay rather than at append time.
3. **JSONL is authoritative.** Records are appended and flushed before anything is acknowledged;
   the checkpoint (`records.checkpoint.json`) and ledger are derived and rebuildable. A batch is
   validated all-or-nothing before any byte is written, but appends across the three files are
   not atomic: an I/O failure between streams leaves the already-appended records durable and
   unacknowledged, and the same-id retry skips them.

Persisted format (`format_version` 1): one JSON object per line, each carrying `record_id`, `ts`,
`agent_runtime`, `repository`, and the caller's payload (`event` records carry `event`; metric
records pass through `runtime.meter`). The `stream` key is not persisted — the file is the stream.

Result shape of `write_batch`:
    {'ok': bool, 'status': 'ok'|'refresh_failed', 'format_version': 1,
     'persisted': {'event': n, 'metric': n, 'outcome': n}, 'duplicates': {...same keys...},
     'ledger_updated': bool, 'dashboard_updated': bool, 'error': None|str,
     'statuses': [{'record_id', 'stream', 'status': 'persisted'|'duplicate'}, ...],
     'records': [persisted record dicts in batch order]}
"""
from __future__ import annotations

import os
import secrets
from collections import deque
from pathlib import Path
from typing import Any

from .dashboard import generate_dashboard
from .runtime import (default_attribution, default_state_root, encode_jsonl, iter_jsonl_from, meter, read_json,
                      utc_now, write_json, writer_lock)
from .state import replay_ledger

FORMAT_VERSION = 1
CHECKPOINT_FILE = 'records.checkpoint.json'
STREAMS: dict[str, str] = {'event': 'events.jsonl', 'metric': 'metrics.jsonl', 'outcome': 'outcomes.jsonl'}
MAX_BATCH_RECORDS = 500
MAX_RECORD_ID_LENGTH = 200
DEDUP_WINDOW = 4096
RESERVED_KEYS = {'stream'}


class BatchValidationError(ValueError):
    """The batch was rejected before any byte was written."""


class BatchAppendError(RuntimeError):
    """An append failed part-way; `persisted` says what is durable. Retry with the same ids."""

    def __init__(self, message: str, persisted: dict[str, int]):
        super().__init__(message)
        self.persisted = persisted


def new_record_id() -> str:
    return secrets.token_hex(12)


def _counts() -> dict[str, int]:
    return {stream: 0 for stream in STREAMS}


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
        if stream not in STREAMS:
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
    return records


def build_record(record: dict[str, Any]) -> dict[str, Any]:
    """Materialize the persisted form of a validated input record (stamps ts/attribution, meters metrics)."""
    payload = {k: v for k, v in record.items() if k not in RESERVED_KEYS}
    if record['stream'] == 'metric':
        payload = meter(payload)
    return {'ts': utc_now(), **default_attribution(), **payload}


# --- dedup checkpoint --------------------------------------------------------------------------

def _scan_ids(path: Path, offset: int, into: deque) -> int:
    """Append record ids from the complete lines at/after `offset`; return the complete-prefix end."""
    end = offset
    for record, end in iter_jsonl_from(path, offset):
        if isinstance(record, dict) and record.get('record_id'):
            into.append(str(record['record_id']))
    return end


def _load_checkpoint(root: Path) -> dict[str, dict[str, Any]]:
    """Recent record ids per stream, repaired from the JSONL tail wherever the checkpoint is not trustworthy."""
    raw = read_json(root / CHECKPOINT_FILE, None)
    saved = raw.get('streams') if isinstance(raw, dict) and raw.get('format_version') == FORMAT_VERSION else None
    if not isinstance(saved, dict):
        saved = {}
    state: dict[str, dict[str, Any]] = {}
    for stream, name in STREAMS.items():
        path = root / name
        size = path.stat().st_size if path.exists() else 0
        entry = saved.get(stream)
        ids: deque = deque(maxlen=DEDUP_WINDOW)
        checkpointed = entry.get('size') if isinstance(entry, dict) else None
        recent = entry.get('recent_ids') if isinstance(entry, dict) else None
        resume = (isinstance(checkpointed, int) and not isinstance(checkpointed, bool) and 0 <= checkpointed <= size
                  and isinstance(recent, list) and all(isinstance(x, str) for x in recent)
                  and (checkpointed == size or _ends_with_newline(path, checkpointed)))
        if resume:
            ids.extend(recent)
            end = checkpointed if checkpointed == size else _scan_ids(path, checkpointed, ids)
        else:
            end = _scan_ids(path, 0, ids)
        state[stream] = {'size': end, 'recent_ids': ids}
    return state


def _ends_with_newline(path: Path, offset: int) -> bool:
    if offset == 0:
        return True
    if not path.exists() or path.stat().st_size < offset:
        return False
    with path.open('rb') as handle:
        handle.seek(offset - 1)
        return handle.read(1) == b'\n'


def _write_checkpoint(root: Path, state: dict[str, dict[str, Any]]) -> None:
    write_json(root / CHECKPOINT_FILE, {
        'format_version': FORMAT_VERSION,
        'streams': {stream: {'size': entry['size'], 'recent_ids': list(entry['recent_ids'])} for stream, entry in state.items()},
    }, compact=True)


# --- append ------------------------------------------------------------------------------------

def _append_stream(path: Path, lines: list[bytes]) -> int:
    """Append encoded lines, terminating any torn tail first; flush+fsync; return the new size."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o666)
    try:
        size = os.fstat(fd).st_size
        repair = b'' if size == 0 or os.pread(fd, 1, size - 1) == b'\n' else b'\n'
        payload = repair + b''.join(lines)
        written = 0
        while written < len(payload):
            written += os.write(fd, payload[written:])
        os.fsync(fd)
        return size + len(payload)
    finally:
        os.close(fd)


def write_batch(root: str | Path | None, records: Any, *, config: dict | None = None, refresh: bool = True) -> dict[str, Any]:
    """Validate, append (deduplicated by record_id), checkpoint, and optionally refresh ledger + dashboard.

    Raises `BatchValidationError` (nothing written) or `BatchAppendError` (partial durable append).
    Refresh failures never raise: the result reports `status='refresh_failed'` with the durable
    counts so a caller can retry the same ids without duplicating work.
    """
    validated = validate_batch(records)
    root = Path(root) if root is not None else default_state_root()
    root.mkdir(parents=True, exist_ok=True)
    persisted = _counts(); duplicates = _counts(); statuses: list[dict[str, Any]] = []
    built: list[dict[str, Any]] = []
    ledger_updated = False; dashboard_updated = False; error: str | None = None
    with writer_lock(root):
        checkpoint = _load_checkpoint(root)
        known: dict[str, set[str]] = {stream: set(entry['recent_ids']) for stream, entry in checkpoint.items()}
        pending: dict[str, list[bytes]] = {stream: [] for stream in STREAMS}
        new_ids: dict[str, list[str]] = {stream: [] for stream in STREAMS}
        for record in validated:
            stream = record['stream']; record_id = record['record_id']
            if record_id in known[stream]:
                duplicates[stream] += 1
                statuses.append({'record_id': record_id, 'stream': stream, 'status': 'duplicate'})
                built.append({k: v for k, v in record.items() if k not in RESERVED_KEYS})
                continue
            materialized = build_record(record)
            pending[stream].append(encode_jsonl(materialized))
            known[stream].add(record_id); new_ids[stream].append(record_id)
            built.append(materialized)
            statuses.append({'record_id': record_id, 'stream': stream, 'status': 'persisted'})
        for stream, lines in pending.items():
            if not lines:
                continue
            try:
                new_size = _append_stream(root / STREAMS[stream], lines)
            except OSError as exc:
                raise BatchAppendError(f'append to {STREAMS[stream]} failed after persisting {persisted}: {exc}', persisted) from exc
            persisted[stream] = len(lines)
            checkpoint[stream]['recent_ids'].extend(new_ids[stream])
            checkpoint[stream]['size'] = new_size
        _write_checkpoint(root, checkpoint)
        # Refresh for duplicate events too: a retry after a crash between checkpoint and ledger
        # publish must still bring the ledger up to the work it is now acknowledging.
        touched_events = persisted['event'] or duplicates['event']
        if refresh and (touched_events or _ledger_missing(root)):
            try:
                replay_ledger(root)
                ledger_updated = True
            except Exception as exc:  # noqa: BLE001 - reported to the caller, records are already durable
                error = f'ledger refresh failed: {exc}'
    if refresh and error is None:
        try:
            generate_dashboard(root, config=config)
            dashboard_updated = True
        except Exception as exc:  # noqa: BLE001 - reported to the caller, records are already durable
            error = f'dashboard refresh failed: {exc}'
    return {
        'ok': error is None, 'status': 'ok' if error is None else 'refresh_failed', 'format_version': FORMAT_VERSION,
        'persisted': persisted, 'duplicates': duplicates, 'ledger_updated': ledger_updated,
        'dashboard_updated': dashboard_updated, 'error': error, 'statuses': statuses, 'records': built,
    }


def _ledger_missing(root: Path) -> bool:
    return not (root / 'ledger.json').exists()

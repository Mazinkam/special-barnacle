"""Per-source ingestion checkpoint codec and validators.

Split out of `orchestrator/ingest_checkpoint.py` (B3, `docs/architecture-review.md`) into this
module (the checkpoint file format: totals bookkeeping, source/prefix fingerprinting, validation,
load/save) and `orchestrator/ingest/ledger.py` (`IngestLedger`, the incremental `session_ingest`
dedup reader over `metrics.jsonl`). `orchestrator/ingest_checkpoint.py` stays as a re-export shim
of every name that used to be importable from it.

The harness log (what happened), ``metrics.jsonl`` (what is paid) and ``events.jsonl``
(logical fallback -> explicit promotions) are authoritative. Promotion events carry a stable
record ID, source path/inode and from/to sessions, including transitions with zero new metrics.
New metrics persist ``source_identity`` from the scanned descriptor and attest ``promotion_version``:
legacy fallback-only rows without this marker could
have undergone an invisible zero-metric promotion, so origins alone cannot prove eligibility
when the source checkpoint is lost. Logs and metrics normally grow by appending complete lines
and can be resumed from a verified byte offset. For
the log: same identity (device, inode), unchanged stat signature and matching edges, or growth
with the entire checkpointed prefix hashing identically. For ``metrics.jsonl``
(read only under the writer lock): same identity, long enough, same last line. Anything else —
rotation, truncation, a same-size rewrite, an offset landing mid-line — falls back to reading
from byte 0. Modern aggregate rows persist their covered call IDs, so losing the cache cannot
confuse equal token totals with equal calls. Legacy totals-only history without a matching
checkpoint is ambiguous and rejected, never guessed.

One checkpoint per source path lives in ``<state root>/ingest-checkpoints/<sha256(path)>.json``:

* ``identity``/``stat``/``offset``/``head_hash``/``tail_hash``/``prefix_hash`` — the verified source
  prefix: identity (device, inode), stat signature (size, mtime, ctime), byte offset after the last
  complete line, edge fingerprints and a SHA-256 of every byte of the prefix. An unchanged file
  keeps the cheap edge-check path; growth verifies the whole prefix before resuming. Same-size
  rewrites, truncation and rotation fall back to byte 0. ``reader`` — the parser context needed
  to continue mid-file (session id, per-turn models, cwd...), ``observed`` — the usage totals and
  unique call IDs of every call the source has ever shown, ``granularity`` — how it was ingested.
  ``live_sessions`` retains the physical source's session IDs separately from the original
  identities of calls reconciled after session-ID drift (absent in older v3 checkpoints).
  HT ``reader.session_provenance`` distinguishes filename fallback from explicit session IDs;
  ``session_aliases`` caches proven fallback bindings, whose authoritative copies live in
  ``events.jsonl`` and survive checkpoint loss. Inode changes start a new source generation
  rather than promoting a fallback ID. New metric rows persist canonical ``session_origin``
  (fallback/explicit), ``source_identity`` (device, inode), and ``promotion_version`` as well.
  Without checkpoint provenance, source-scoped ledger generations, origins and durable bindings
  determine alias eligibility; missing or
  conflicting legacy evidence cannot establish a cross-session identity.
  The ever-seen IDs deduplicate calls reintroduced after truncation; the ledger's authoritative
  coverage identifies which calls are paid, even if they disappeared from the source;
* ``metrics`` (identity/offset/tail_hash of ``metrics.jsonl``) and ``recorded`` — the
  ``session_ingest`` rows already in ``metrics.jsonl`` for this source's sessions *through that
  metrics offset*: per-model totals, record call IDs, covered call IDs, unidentified legacy totals
  and granularities. ``IngestLedger`` (in `ledger.py`) walks the
  metrics suffix appended since (by any writer) before every decision, or rescans the whole
  stream when the prefix changed, so rows written by another ingester, an older version of this
  code or a hand-run backfill are always accounted for.

A checkpoint is written only after ``record_batch.write_batch`` has fsynced the rows it vouches
for, and the caller holds the same writer lock across check, append and checkpoint, so competing
ingesters (HT hook, launchd sweep, manual backfill) serialize and each sees the others' rows.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, BinaryIO, Optional

from ..runtime import TAIL_FINGERPRINT_BYTES, read_json, stable_hash, tail_fingerprint, write_json
from ..vocab import CALL, SESSION, INGEST_TOKEN_FIELDS

FORMAT_VERSION = 3  # 3: full prefix hash and authoritative aggregate call coverage; older caches cost a full read
CHECKPOINT_DIR = 'ingest-checkpoints'
INGEST_SOURCE = 'session_ingest'
PROMOTION_EVENT = 'session_ingest_promotion'
PROMOTION_VERSION = 1
GRANULARITIES = (CALL, SESSION)
TOKEN_FIELDS = INGEST_TOKEN_FIELDS
COUNT_FIELDS = TOKEN_FIELDS + ('calls',)
MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024  # a per-source file far beyond this is not a checkpoint
MAX_TAIL_BYTES = 16 * 1024 * 1024  # an unterminated metrics tail beyond this is a fragment, not a row


def _int(value: Any) -> int:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def empty_totals() -> dict[str, int]:
    return {field: 0 for field in COUNT_FIELDS}


def add_totals(bucket: dict[str, int], row: dict[str, Any], *, calls: int = 1) -> None:
    for field in TOKEN_FIELDS:
        bucket[field] += _int(row.get(field))
    bucket['calls'] += calls


def totals_equal(a: Optional[dict[str, int]], b: Optional[dict[str, int]]) -> bool:
    a = a or {}; b = b or {}
    return all(_int(a.get(field)) == _int(b.get(field)) for field in COUNT_FIELDS)


def file_identity(path: Path) -> Optional[list[int]]:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return [stat.st_dev, stat.st_ino]


def source_signature(handle: BinaryIO) -> dict[str, list[int]]:
    """Identity and stat signature of an *open* source: `{'identity': [dev, ino], 'stat': [size, mtime_ns, ctime_ns]}`."""
    stat = os.fstat(handle.fileno())
    return {'identity': [stat.st_dev, stat.st_ino], 'stat': [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]}


def head_fingerprint(handle: BinaryIO, offset: int) -> Optional[str]:
    """Hash of the first bytes of the prefix ending at `offset` (None for an empty prefix).

    Complements `tail_fingerprint`: a rewrite of the header that keeps the last line and grows the
    file (so the stat signature alone cannot call it unchanged) still changes this.
    """
    if offset <= 0:
        return None
    handle.seek(0)
    return hashlib.sha256(handle.read(min(offset, TAIL_FINGERPRINT_BYTES))).hexdigest()[:16]


def prefix_fingerprint(handle: BinaryIO, offset: int) -> str:
    """Hash every byte of a source prefix, in bounded chunks (never just its edges)."""
    handle.seek(0)
    digest = hashlib.sha256()
    remaining = offset
    while remaining:
        data = handle.read(min(remaining, 1024 * 1024))
        if not data:
            raise ValueError('source truncated while fingerprinting its prefix; retry')
        digest.update(data)
        remaining -= len(data)
    return digest.hexdigest()


def source_prefix_intact(handle: BinaryIO, checkpoint: dict[str, Any]) -> bool:
    """True when the open source still starts with the checkpointed prefix.

    Same inode, long enough, and both edge fingerprints unchanged. A changed stat must show
    growth, and then every byte of the checkpointed prefix must hash identically too. An unchanged
    stat avoids the whole-prefix read; ctime prevents a rewrite with a restored mtime hiding here.
    """
    signature = source_signature(handle)
    offset = checkpoint['offset']
    if signature['identity'] != checkpoint['identity'] or signature['stat'][0] < offset:
        return False
    if signature['stat'] != checkpoint['stat'] and signature['stat'][0] <= checkpoint['stat'][0]:
        return False
    return (head_fingerprint(handle, offset) == checkpoint['head_hash']
            and tail_fingerprint(handle, offset) == checkpoint['tail_hash']
            and (signature['stat'] == checkpoint['stat']
                 or prefix_fingerprint(handle, offset) == checkpoint['prefix_hash']))


def changed_while_reading(before: dict[str, list[int]], after: dict[str, list[int]]) -> bool:
    """True when the open source's size or mtime changed during the read.

    Growth cannot prove append-only behavior: the writer may also have changed a header or a
    middle context line. Reject any size/mtime change during a read and retry the settled file.
    A changed ctime alone is allowed (unlinking an open inode during rotation changes ctime).
    """
    return after['stat'][:2] != before['stat'][:2]


def verify_prefix(path: Path, offset: int, tail_hash: Optional[str]) -> bool:
    """True when `path` still starts with the checkpointed prefix: long enough, same last line."""
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return False
    if offset < 0 or size < offset:
        return False
    if offset == 0:
        return tail_hash is None
    return tail_fingerprint(path, offset) == tail_hash


def source_key(source: str | Path) -> str:
    return str(Path(os.path.abspath(os.fspath(source))))


def promotion_record(runtime: str, source: str | Path, identity: list[int],
                     from_session: str, to_session: str) -> dict[str, Any]:
    """Stable-ID logical binding, written before metrics even when promotion owes no new usage."""
    source = source_key(source)
    return {'stream': 'event', 'event': PROMOTION_EVENT, 'source': INGEST_SOURCE,
            'record_id': stable_hash([PROMOTION_EVENT, runtime, source, identity, from_session, to_session]),
            'agent_runtime': runtime, 'ingest_source': source, 'source_identity': identity,
            'from_session_id': from_session, 'to_session_id': to_session}


def checkpoint_path(root: Path, source: str | Path) -> Path:
    digest = hashlib.sha256(source_key(source).encode('utf-8', 'surrogatepass')).hexdigest()[:32]
    return Path(root) / CHECKPOINT_DIR / f'{digest}.json'


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _valid_totals(value: Any) -> bool:
    return isinstance(value, dict) and all(_is_int(value.get(field)) and value[field] >= 0 for field in COUNT_FIELDS)


def _valid_identity(value: Any) -> bool:
    return value is None or (isinstance(value, list) and len(value) == 2 and all(_is_int(v) for v in value))


def _valid_stat(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_is_int(v) for v in value) and value[0] >= 0


def _valid_hash(value: Any) -> bool:
    return value is None or isinstance(value, str)


def _valid_recorded(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    for session_id, state in value.items():
        if not isinstance(session_id, str) or not isinstance(state, dict):
            return False
        models = state.get('models')
        if not isinstance(models, dict) or not all(isinstance(m, str) and _valid_totals(t) for m, t in models.items()):
            return False
        if not all(isinstance(state.get(key), list) and all(isinstance(v, str) for v in state[key])
                   for key in ('call_ids', 'covered_call_ids', 'granularities')):
            return False
        if not isinstance(state.get('unidentified'), dict) or not all(
                isinstance(m, str) and _valid_totals(t) for m, t in state['unidentified'].items()):
            return False
    return True


def _valid_observed(value: Any) -> bool:
    return isinstance(value, list) and all(
        isinstance(group, dict) and isinstance(group.get('session_id'), str) and _valid_totals(group)
        and (group.get('model') is None or isinstance(group['model'], str))
        and isinstance(group.get('call_ids'), list) and all(isinstance(v, str) for v in group['call_ids'])
        for group in value)


def valid_session_provenance(value: Any) -> bool:
    return (isinstance(value, dict)
            and all(isinstance(sid, str) and origin in ('fallback', 'explicit') for sid, origin in value.items()))


def load_checkpoint(root: Path, source: str | Path) -> Optional[dict[str, Any]]:
    """The checkpoint for `source`, or None when missing, unreadable, foreign or structurally invalid.

    Only the shape is validated here; whether the prefix it describes still exists is decided by
    the caller against the live files (`source_prefix_intact`, `IngestLedger.seed`), and whether
    the `reader` state fits the parser is the parser's call (`ingest.parsers.PARSERS`).
    """
    path = checkpoint_path(root, source)
    try:
        if not path.is_file() or path.stat().st_size > MAX_CHECKPOINT_BYTES:
            return None
    except OSError:
        return None
    data = read_json(path, None)
    if not isinstance(data, dict) or data.get('format_version') != FORMAT_VERSION:
        return None
    if data.get('source') != source_key(source):
        return None
    metrics = data.get('metrics')
    if not (isinstance(data.get('runtime'), str) and data.get('granularity') in GRANULARITIES
            and _valid_identity(data.get('identity')) and data.get('identity') is not None and _valid_stat(data.get('stat'))
            and _is_int(data.get('offset')) and data['offset'] >= 0 and data['offset'] <= data['stat'][0]
            and _valid_hash(data.get('tail_hash')) and _valid_hash(data.get('head_hash'))
            and isinstance(data.get('prefix_hash'), str) and len(data['prefix_hash']) == 64
            and isinstance(data.get('reader'), dict) and _valid_observed(data.get('observed'))
            and ('session_provenance' not in data['reader']
                 or valid_session_provenance(data['reader']['session_provenance']))
            and ('session_aliases' not in data or (isinstance(data['session_aliases'], dict)
                 and all(isinstance(sid, str) and isinstance(ids, list) and all(isinstance(v, str) for v in ids)
                         for sid, ids in data['session_aliases'].items())))
            and ('live_sessions' not in data or (isinstance(data['live_sessions'], list)
                 and all(isinstance(sid, str) for sid in data['live_sessions'])))
            and isinstance(metrics, dict) and _valid_identity(metrics.get('identity'))
            and _is_int(metrics.get('offset')) and metrics['offset'] >= 0
            and _valid_hash(metrics.get('tail_hash'))
            and _valid_recorded(data.get('recorded'))):
        return None
    return data


def save_checkpoint(root: Path, checkpoint: dict[str, Any]) -> Path:
    """Durably publish `checkpoint` (atomic same-directory replace + fsync). Call only after the rows it covers are durable."""
    path = checkpoint_path(root, checkpoint['source'])
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, {**checkpoint, 'format_version': FORMAT_VERSION}, compact=True, durable=True)
    return path


def _blank_state() -> dict[str, Any]:
    return {'models': {}, 'call_ids': set(), 'covered_call_ids': set(), 'unidentified': {}, 'granularities': set()}


def _state_from_json(value: dict[str, Any]) -> dict[str, Any]:
    return {'models': {model: {field: _int(totals.get(field)) for field in COUNT_FIELDS} for model, totals in value['models'].items()},
            'call_ids': set(value['call_ids']), 'covered_call_ids': set(value['covered_call_ids']),
            'unidentified': {model: dict(totals) for model, totals in value['unidentified'].items()},
            'granularities': set(value['granularities'])}


def _state_to_json(state: dict[str, Any]) -> dict[str, Any]:
    return {'models': {model: dict(totals) for model, totals in state['models'].items()},
            'call_ids': sorted(state['call_ids']), 'covered_call_ids': sorted(state['covered_call_ids']),
            'unidentified': {model: dict(totals) for model, totals in state['unidentified'].items()},
            'granularities': sorted(state['granularities'])}

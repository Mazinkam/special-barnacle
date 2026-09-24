"""Per-source ingestion checkpoints and the incremental `session_ingest` dedup ledger.

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
  and granularities. ``IngestLedger`` walks the
  metrics suffix appended since (by any writer) before every decision, or rescans the whole
  stream when the prefix changed, so rows written by another ingester, an older version of this
  code or a hand-run backfill are always accounted for. The state is exactly what
  ``IngestLedger.ensure()`` rebuilds from ``metrics.jsonl`` alone.

A checkpoint is written only after ``record_batch.write_batch`` has fsynced the rows it vouches
for, and the caller holds the same writer lock across check, append and checkpoint, so competing
ingesters (HT hook, launchd sweep, manual backfill) serialize and each sees the others' rows.
Before reading ``metrics.jsonl`` under that lock the caller settles the streams
(``record_batch.settle_streams``): bytes an interrupted append left un-fsynced become durable and a
complete object missing its newline is terminated, so the ledger never derives dedup state from
bytes that might not survive a crash. A dry run, which holds no lock and writes nothing, reads
such a complete tail as recorded usage in memory instead (``IngestLedger`` marks itself
provisional and re-derives on its next use).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Optional

from .runtime import TAIL_FINGERPRINT_BYTES, iter_jsonl_from, open_binary, read_json, stable_hash, tail_fingerprint, write_json

FORMAT_VERSION = 3  # 3: full prefix hash and authoritative aggregate call coverage; older caches cost a full read
CHECKPOINT_DIR = 'ingest-checkpoints'
INGEST_SOURCE = 'session_ingest'
PROMOTION_EVENT = 'session_ingest_promotion'
PROMOTION_VERSION = 1
CALL = 'call'
SESSION = 'session'
GRANULARITIES = (CALL, SESSION)
TOKEN_FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens',
                'reasoning_output_tokens', 'total_tokens')
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
    the `reader` state fits the parser is the parser's call (`ingest.PARSERS`).
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


class IngestLedger:
    """What ``metrics.jsonl`` already holds for ingested sessions, keyed by (runtime, session id).

    Per session: usage totals per model (every granularity counts — a session aggregated once and
    then ingested per call must still come out to each token exactly once), record call IDs, covered
    source call IDs (from per-call and modern aggregate rows), totals lacking identity evidence,
    and granularities seen. The state is valid through ``offset`` of ``metrics.jsonl``; it is
    either *full* (derived from byte 0, every session present) or *partial* (seeded from
    checkpoints, only the listed sessions tracked). ``ensure`` upgrades to full when an untracked
    session is needed; ``advance`` walks only the suffix appended since ``offset`` and re-derives
    from byte 0 whenever the prefix no longer matches. One instance serves one ingest run; the
    caller holds the writer lock while it reads for a real (non dry-run) import.

    A complete JSON object at the end of the file that lacks only its newline is an append the
    writer will terminate, and its usage is recorded (the record index dedups it too). Under the
    lock the caller settles the stream first so the ledger never meets one; a dry run applies it
    in memory and becomes *provisional*: its next ``advance`` re-derives, and it refuses to be
    exported into a checkpoint. ``stage`` lets a dry run count the rows it would have written so a
    sweep previews the same totals a real sweep records.
    """

    def __init__(self, root: str | Path):
        self.path = Path(root) / 'metrics.jsonl'
        self.sessions: dict[tuple[str, str], dict[str, Any]] = {}
        self.sources: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
        self.full = False
        self.initialized = False
        self.provisional = False
        self.identity: Optional[list[int]] = None
        self.offset = 0
        self.tail_hash: Optional[str] = None
        self.full_scans = 0  # observability for tests/benchmarks
        self.staged: list[dict[str, Any]] = []

    # -- reading -------------------------------------------------------------------------------
    def _apply(self, row: dict[str, Any], keys: Optional[set[tuple[str, str]]]) -> None:
        if row.get('source') != INGEST_SOURCE:
            return
        session_id = row.get('session_id')
        if not session_id:
            return
        key = (str(row.get('agent_runtime') or row.get('runtime') or ''), str(session_id))
        if keys is not None and key not in keys:
            return
        state = self.sessions.get(key)
        if state is None:
            state = self.sessions[key] = _blank_state()
        self._apply_state(state, row)
        source = row.get('ingest_source')
        if isinstance(source, str) and source:
            source_state = self.sources.setdefault((key[0], source_key(source)), {}).setdefault(key[1], _blank_state())
            self._apply_state(source_state, row)
            # Source provenance must be rebuilt from authoritative rows, not session-wide
            # checkpoint totals (which can include contributions from other paths).
            origin = row.get('session_origin')
            source_state.setdefault('session_origins', set()).add(
                origin if origin in ('fallback', 'explicit') else 'unknown')
            identity = row.get('source_identity')
            source_state.setdefault('source_identities', set()).add(
                tuple(identity) if identity is not None and _valid_identity(identity) else None)
            version = row.get('promotion_version')
            if not _is_int(version) or version != PROMOTION_VERSION:
                source_state['legacy_promotions'] = True

    @staticmethod
    def _apply_state(state: dict[str, Any], row: dict[str, Any]) -> None:
        # A session row says how many calls it covers (a tokens-only delta may cover 0); a per-call row is one call.
        add_totals(state['models'].setdefault(str(row.get('model') or ''), empty_totals()), row,
                   calls=_int(row.get('covers_calls')) if row.get('covers_calls') is not None else 1)
        if row.get('call_id'):
            state['call_ids'].add(str(row['call_id']))
        granularity = str(row.get('granularity') or CALL)
        state['granularities'].add(granularity)
        covered = row.get('covered_call_ids')
        if granularity == CALL and isinstance(row.get('call_id'), str) and row['call_id'].strip():
            state['covered_call_ids'].add(row['call_id'])
        elif (granularity == SESSION and isinstance(covered, list)
              and _is_int(row.get('covers_calls')) and row['covers_calls'] > 0
              and all(isinstance(value, str) and value.strip() for value in covered)
              and len(set(covered)) == len(covered) == row['covers_calls']):
            state['covered_call_ids'].update(covered)
        else:
            add_totals(state['unidentified'].setdefault(str(row.get('model') or ''), empty_totals()), row,
                       calls=_int(row.get('covers_calls')) if row.get('covers_calls') is not None else 1)

    def _scan(self, start: int, end: Optional[int], keys: Optional[set[tuple[str, str]]]) -> int:
        """Apply the complete lines in [start, end) (to the current end when None); return the offset reached.

        Scanning to the current end also applies a complete-but-unterminated last object in memory
        and marks the ledger provisional (see class docstring).
        """
        pos = start
        for record, line_end in iter_jsonl_from(self.path, start):
            if end is not None and line_end > end:
                break
            pos = line_end
            if isinstance(record, dict):
                self._apply(record, keys)
        if end is None:
            tail = self._complete_tail(pos)
            if tail is not None:
                self._apply(tail, keys)
                self.provisional = True
        return pos

    def _complete_tail(self, offset: int, path: Path | None = None) -> Optional[dict[str, Any]]:
        """The JSON object occupying [offset, EOF) without a trailing newline, or None (nothing, torn, or too big)."""
        try:
            with open_binary(self.path if path is None else path) as handle:
                handle.seek(offset)
                data = handle.read(MAX_TAIL_BYTES + 1)
        except FileNotFoundError:
            return None
        if not data or data.endswith(b'\n') or len(data) > MAX_TAIL_BYTES:
            return None
        try:
            record = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return record if isinstance(record, dict) else None

    def _full_scan(self) -> None:
        self.sessions = {}
        self.sources = {}
        self.full = True
        self.initialized = True
        self.provisional = False
        self.full_scans += 1
        self.identity = file_identity(self.path)
        self.offset = self._scan(0, None, None)
        self.tail_hash = tail_fingerprint(self.path, self.offset) if self.identity is not None else None
        for row in self.staged:
            self._apply(row, None)

    def _prefix_intact(self, identity: Optional[list[int]], offset: int, tail_hash: Optional[str]) -> bool:
        current = file_identity(self.path)
        if current is None:
            return identity is None and offset == 0
        return identity == current and verify_prefix(self.path, offset, tail_hash)

    def seed(self, runtime: str, recorded: dict[str, Any], metrics: dict[str, Any]) -> bool:
        """Adopt a checkpoint's `recorded` state for its sessions; False when its metrics prefix is gone.

        The return value answers one question whatever the ledger already holds: does the
        ``metrics.jsonl`` prefix the checkpoint's dedup state was verified against still exist?
        A caller resuming a per-call source relies on that — the calls in its prefix were never
        re-read, so if the rows vouching for them were rolled back the source must be re-read.
        An uninitialized ledger takes the checkpoint's state and metrics offset. One that already
        tracks other sessions first catches up to the present, then walks the newcomers forward
        from the checkpoint's offset so every tracked session is valid through the same offset.
        """
        identity, offset, tail_hash = metrics.get('identity'), int(metrics['offset']), metrics.get('tail_hash')
        if not self._prefix_intact(identity, offset, tail_hash):
            return False
        if self.full:
            return True
        keys = {(runtime, session_id) for session_id in recorded}
        newcomers = {key for key in keys if key not in self.sessions}
        if not newcomers:
            return True
        states = {(runtime, sid): _state_from_json(state) for sid, state in recorded.items() if (runtime, sid) in newcomers}
        if not self.initialized:
            self.sessions.update(states)
            self.identity, self.offset, self.tail_hash, self.initialized = identity, offset, tail_hash, True
            return True
        self.advance()
        if self.full:
            return True
        if offset > self.offset or not self._prefix_intact(identity, offset, tail_hash):
            return False  # cannot happen for an intact prefix; refuse rather than guess
        self.sessions.update(states)
        self._scan(offset, self.offset, set(states))
        return True

    def ensure(self, keys: Iterable[tuple[str, str]]) -> None:
        """Guarantee every key is tracked, deriving the whole stream from byte 0 when one is not."""
        keys = set(keys)
        if self.full or not keys:
            return
        if self.initialized and all(key in self.sessions for key in keys):
            return
        self._full_scan()

    def advance(self) -> None:
        """Catch up with everything appended to metrics.jsonl since `offset` (full re-derivation if the prefix changed)."""
        if not self.initialized or self.provisional or not self._prefix_intact(self.identity, self.offset, self.tail_hash):
            self._full_scan()
            return
        self.offset = self._scan(self.offset, None, None if self.full else set(self.sessions))
        self.tail_hash = tail_fingerprint(self.path, self.offset)

    def stage(self, rows: Iterable[dict[str, Any]]) -> None:
        """Count rows a dry run would have written, for the rest of this run only; they survive re-derivations."""
        rows = list(rows)
        self.staged.extend(rows)
        for row in rows:
            self._apply(row, None)

    # -- queries ---------------------------------------------------------------------------------
    def source_promotions(self, runtime: str, source: str | Path) -> dict[str, dict[str, Any]]:
        """Rebuild immutable fallback -> explicit bindings from events, never from the cache.

        Called only for call reconciliation, not unchanged checkpoint refreshes. The caller
        settles events under the writer lock; dry runs also recognize a complete pending tail
        and staged bindings without publishing them. Conflicting/malformed bindings fail closed.
        A binding remains consumed across source generations: inode reuse or rotation is not
        permission to give a different explicit session the old fallback's paid call IDs.
        """
        source = source_key(source)
        bindings: dict[str, dict[str, Any]] = {}

        def apply(row: Any) -> None:
            if not isinstance(row, dict) or row.get('event') != PROMOTION_EVENT:
                return
            if row.get('agent_runtime') != runtime or row.get('ingest_source') != source:
                return
            before, after = row.get('from_session_id'), row.get('to_session_id')
            identity = row.get('source_identity')
            if (row.get('source') != INGEST_SOURCE or not _valid_identity(identity) or identity is None
                    or not isinstance(before, str) or not before.strip()
                    or not isinstance(after, str) or not after.strip() or before == after
                    or row.get('record_id') != promotion_record(runtime, source, identity, before, after)['record_id']
                    or (before in bindings and (bindings[before]['to_session_id'] != after
                                                or bindings[before]['source_identity'] != identity))):
                raise ValueError(f'{source}: ambiguous session promotion binding; reconcile events.jsonl before retrying; '
                                 'nothing was written.')
            bindings[before] = {'to_session_id': after, 'source_identity': identity}

        path = self.path.with_name('events.jsonl')
        end = 0
        for row, end in iter_jsonl_from(path):
            apply(row)
        apply(self._complete_tail(end, path))
        for row in self.staged:
            apply(row)
        return bindings

    def source_states(self, runtime: str, source: str | Path) -> dict[str, dict[str, Any]]:
        """Authoritative coverage per session for one source, never totals from other paths.

        Session checkpoints cannot prove which paths contributed their rows. Rebuild on demand
        for rewrite reconciliation; unchanged sources keep the ordinary incremental fast path.
        """
        if not self.full:
            self._full_scan()
        return self.sources.get((runtime, source_key(source)), {})

    def state(self, runtime: str, session_id: str) -> dict[str, Any]:
        return self.sessions.setdefault((runtime, str(session_id)), _blank_state())

    def export(self, runtime: str, session_ids: Iterable[str]) -> dict[str, Any]:
        """JSON-ready `recorded` state for a checkpoint; identical to what `ensure` would rebuild."""
        self._exportable()
        return {str(sid): _state_to_json(self.sessions.get((runtime, str(sid))) or _blank_state()) for sid in sorted(set(map(str, session_ids)))}

    def metrics_state(self) -> dict[str, Any]:
        self._exportable()
        return {'identity': self.identity, 'offset': self.offset, 'tail_hash': self.tail_hash}

    def _exportable(self) -> None:
        if self.provisional or self.staged:
            raise ValueError('ledger state includes an unterminated metrics tail or dry-run rows; it cannot vouch for a checkpoint')

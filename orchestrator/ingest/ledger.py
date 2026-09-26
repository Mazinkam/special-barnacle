"""The incremental `session_ingest` dedup ledger over `metrics.jsonl`.

Split out of `orchestrator/ingest_checkpoint.py` (B3, `docs/architecture-review.md`); see
`orchestrator/ingest/checkpoint.py`'s module docstring for the checkpoint file format this reads
and writes alongside.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Optional

from ..contract import STREAMS
from ..runtime import iter_jsonl_from, open_binary, tail_fingerprint
from ..vocab import CALL, SESSION
from .checkpoint import (
    INGEST_SOURCE,
    PROMOTION_EVENT,
    PROMOTION_VERSION,
    _blank_state,
    _int,
    _is_int,
    _state_from_json,
    _state_to_json,
    _valid_identity,
    add_totals,
    empty_totals,
    file_identity,
    promotion_record,
    source_key,
    verify_prefix,
)

MAX_TAIL_BYTES = 16 * 1024 * 1024  # an unterminated metrics tail beyond this is a fragment, not a row


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
        self.path = Path(root) / STREAMS['metric']
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

        path = self.path.with_name(STREAMS['event'])
        end = 0
        for row, end in iter_jsonl_from(path):  # noqa: B007 -- end is read after the loop, below
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

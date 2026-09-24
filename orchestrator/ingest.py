"""Ingest per-call token usage from coding-agent session logs.

An agent writing its own telemetry mid-session cannot know its token counts, so records
emitted by hand arrive unmetered. Every harness already writes usage to disk; this module
reads those logs and emits `model_call` metrics through the coordinated writer
(`record_batch.write_batch`), which prices and labels them.

Ingestion is idempotent and incremental. Each call carries a `call_id` derived from the
harness's own identifiers (also used as the durable `record_id`). Session-level rows aggregate
only unrecorded call IDs and persist those IDs as `covered_call_ids` alongside the usage. A per-source
checkpoint (`ingest_checkpoint`) remembers the verified byte offset of the log, every call id the
log has ever shown, and the `session_ingest` rows already known for its sessions. Unchanged sources
need only edge checks; growth verifies the whole checkpointed prefix before parsing the suffix.
The event stream durably binds fallback identities to their explicit logical sessions, even when
promotion emits no new usage. Initial metrics retain the scanned source's device/inode, so
checkpoint loss cannot turn a replacement file into a fallback promotion. Metrics remain authoritative for paid coverage; every checkpoint is a
rebuildable cache, and settle → check → append → checkpoint runs under the one writer lock so
competing ingesters serialize instead of double counting. Each log is read through one open file
(identity, prefix check, scan and fingerprints all see the same inode). Totals-only legacy history
without matching checkpoint evidence, or a file modified under the reader, is rejected before any
write rather than guessed from numeric usage. Identified calls survive rewrites and checkpoint loss.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable, Iterator, NamedTuple, Optional

from . import ingest_checkpoint as ckpt
from .ingest_checkpoint import COUNT_FIELDS, IngestLedger, TOKEN_FIELDS, add_totals, empty_totals, totals_equal
from .record_batch import BatchAppendError, MAX_BATCH_RECORDS, build_record, settle_streams, write_batch
# CALL/SESSION come from `orchestrator.records`, the one definition of granularity vocabulary
# ('call' / 'session'), and are re-exported here because callers outside this module (tests,
# cli.py) import them from `orchestrator.ingest`.
from .records import CALL, SESSION
from .runtime import EventStore, default_state_root, iter_jsonl_from, open_binary, stable_hash, tail_fingerprint, writer_lock

HUMAIN_TERMINAL = 'humain-terminal'
CODEX = 'codex'

LOG_GLOBS: dict[str, tuple[str, ...]] = {
    HUMAIN_TERMINAL: ('.humain-terminal/agent/sessions/*/*.jsonl',),
    CODEX: ('.codex/sessions/*/*/*/rollout-*.jsonl',),
}


class GranularityConflict(ValueError):
    """Legacy aggregate coverage cannot be reconciled safely; the message names the missing evidence."""


class SourceConflict(ValueError):
    """The log and metrics.jsonl disagree in a way no checkpoint can reconstruct; nothing was written."""


def _int(value: Any) -> int:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _lines(source: Path | BinaryIO) -> Iterator[dict[str, Any]]:
    """Every parseable JSON object line of a Path or open binary file, including an unterminated last line."""
    with open_binary(source) as handle:
        handle.seek(0)
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(record, dict):
                yield record


_TEMP_MARKERS = ('var-folders', 'T-pi-', 'pi-runtime-events', '-tmp-', 'T-tmp')
_PROBE_LIMIT = 4_000


def _resolve_encoded_path(name: str, *, root: Path = Path('/')) -> Optional[Path]:
    """Decode a HUMAIN Terminal project directory name back into a real path.

    The name is an absolute path with separators replaced by `-`, which is ambiguous whenever a
    directory name itself contains a dash (`humain-terminal`). Resolve it against the filesystem,
    preferring longer segment merges, so `--Users-a-humain-terminal--` cannot be silently
    mis-split. Returns None when no existing directory matches; guessing a repository is worse
    than leaving attribution to the caller.
    """
    tokens = [token for token in name.strip('-').split('-') if token]
    if not tokens:
        return None
    probes = 0

    def walk(base: Path, index: int) -> Optional[Path]:
        nonlocal probes
        if index >= len(tokens):
            return base
        for end in range(len(tokens), index, -1):
            probes += 1
            if probes > _PROBE_LIMIT:
                return None
            candidate = base / '-'.join(tokens[index:end])
            if candidate.is_dir():
                resolved = walk(candidate, end)
                if resolved is not None:
                    return resolved
        return None

    return walk(root, 0)


def log_repository(path: Path) -> Optional[str]:
    """Repository a HUMAIN Terminal session belongs to, decoded from its project directory."""
    resolved = _resolve_encoded_path(path.parent.name)
    return str(resolved) if resolved else None


def is_scratch_log(path: Path) -> bool:
    """True for test-harness and temp-directory sessions (faux models, throwaway sandboxes)."""
    name = path.parent.name
    if any(marker in name for marker in _TEMP_MARKERS):
        return True
    return name.startswith('--var-folders') or '/T/pi-' in str(path)


# --- incremental readers ---------------------------------------------------------------------
# Each reader is a pure step `(record, state) -> call | None` over a small JSON-serializable
# `state`, so a checkpoint can carry the context (session id, per-turn models, cwd) needed to
# continue mid-file. `valid_state` says whether a state read back from a checkpoint is one this
# parser can continue from; anything else costs a full read, never a crash or a mis-attribution.
# `read_humain_terminal`/`read_codex` remain the whole-file conveniences.

def _optional_str(value: Any) -> bool:
    return value is None or isinstance(value, str)


def _humain_terminal_state(path: Path) -> dict[str, Any]:
    return {'session_id': path.stem.split('_')[-1], 'session_origin': 'fallback', 'session_provenance': {},
            'repository': log_repository(path), 'count': 0}


def _humain_terminal_state_ok(state: dict[str, Any]) -> bool:
    return (isinstance(state.get('session_id'), str) and _optional_str(state.get('repository'))
            and state.get('session_origin') in ('fallback', 'explicit')
            and ckpt.valid_session_provenance(state.get('session_provenance'))
            and _is_int(state.get('count')) and state['count'] >= 0)


def _parse_humain_terminal(record: dict[str, Any], state: dict[str, Any]) -> Optional[dict[str, Any]]:
    """HUMAIN Terminal session JSONL: assistant messages carry a `usage` block.

    `usage.input` excludes cached reads here, unlike the OpenAI-style convention used by the
    telemetry contract, so cached reads are folded back into `input_tokens` to keep
    `cached_input_tokens` a subset of it.
    """
    if record.get('type') == 'session':
        session_id = record.get('id') or record.get('sessionId')
        if session_id:
            state['session_id'] = str(session_id)
            state['session_origin'] = 'explicit'
            state['session_provenance'][state['session_id']] = 'explicit'
    message = record.get('message')
    if not isinstance(message, dict) or message.get('role') != 'assistant':
        return None
    usage = message.get('usage')
    if not isinstance(usage, dict):
        return None
    state['session_provenance'].setdefault(state['session_id'], state['session_origin'])
    cached = _int(usage.get('cacheRead'))
    call = {
        'native_id': str(record.get('id') or state['count']),
        '_native_id_stable': bool(record.get('id')),
        'session_id': state['session_id'],
        'session_origin': state['session_origin'],
        'ts': record.get('timestamp'),
        'model': message.get('model'),
        'provider': message.get('provider'),
        'repository': state['repository'],
        'input_tokens': _int(usage.get('input')) + cached,
        'cached_input_tokens': cached,
        'cache_write_tokens': _int(usage.get('cacheWrite')) + _int(usage.get('cacheWrite1h')),
        'output_tokens': _int(usage.get('output')),
        'reasoning_output_tokens': _int(usage.get('reasoning')),
        'total_tokens': _int(usage.get('totalTokens')),
    }
    state['count'] += 1
    return call


def _codex_state(path: Path) -> dict[str, Any]:
    return {'models': {}, 'latest_model': None, 'repository': None, 'provider': None, 'stem': path.stem}


def _codex_state_ok(state: dict[str, Any]) -> bool:
    models = state.get('models')
    return (isinstance(models, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in models.items())
            and all(_optional_str(state.get(key)) for key in ('latest_model', 'repository', 'provider'))
            and isinstance(state.get('stem'), str))


def _parse_codex(record: dict[str, Any], state: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Codex rollout JSONL: one `token_usage_record` per response.

    `payload.usage` is the per-response delta; `turn_token_usage` and `thread_token_usage` are
    cumulative and must not be summed. The model lives on `turn_context`, keyed by turn.
    """
    kind = record.get('type')
    payload = record.get('payload')
    if not isinstance(payload, dict):
        return None
    if kind == 'session_meta':
        state['repository'] = payload.get('cwd') or state['repository']
        state['provider'] = payload.get('model_provider') or state['provider']
        return None
    if kind == 'turn_context':
        model = payload.get('model')
        if model:
            state['latest_model'] = str(model)
            if payload.get('turn_id'):
                state['models'][str(payload['turn_id'])] = state['latest_model']
        state['repository'] = payload.get('cwd') or state['repository']
        return None
    if kind != 'token_usage_record':
        return None
    usage = payload.get('usage')
    if not isinstance(usage, dict):
        return None
    turn_id = payload.get('turn_id')
    return {
        'native_id': str(payload.get('response_id') or f"{turn_id}:{record.get('ordinal')}"),
        '_native_id_stable': bool(payload.get('response_id') or (turn_id and record.get('ordinal') is not None)),
        'session_id': str(payload.get('session_id') or state['stem']),
        'session_origin': 'explicit' if payload.get('session_id') else 'fallback',
        'turn_id': turn_id,
        'ts': record.get('timestamp'),
        'model': state['models'].get(str(turn_id), state['latest_model']),
        'provider': state['provider'],
        'repository': state['repository'],
        'input_tokens': _int(usage.get('input_tokens')),
        'cached_input_tokens': _int(usage.get('cached_input_tokens')),
        'cache_write_tokens': _int(usage.get('cache_write_input_tokens')),
        'output_tokens': _int(usage.get('output_tokens')),
        'reasoning_output_tokens': _int(usage.get('reasoning_output_tokens')),
        'total_tokens': _int(usage.get('total_tokens')),
    }


class Parser(NamedTuple):
    initial: Callable[[Path], dict[str, Any]]
    step: Callable[[dict[str, Any], dict[str, Any]], Optional[dict[str, Any]]]
    valid_state: Callable[[dict[str, Any]], bool]


PARSERS: dict[str, Parser] = {
    HUMAIN_TERMINAL: Parser(_humain_terminal_state, _parse_humain_terminal, _humain_terminal_state_ok),
    CODEX: Parser(_codex_state, _parse_codex, _codex_state_ok),
}


def read_calls(path: Path, runtime: str, *, offset: int = 0, state: dict[str, Any] | None = None,
               handle: BinaryIO | None = None) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
    """Calls from the complete lines of `path` at or after `offset`; returns (calls, end offset, reader state).

    A trailing line without its newline is a torn or in-progress write: it is not parsed and the
    returned offset stops before it, so the next pass reads it whole. `state` is the reader
    context returned by a previous pass (copied, never mutated) or None to start at byte 0.
    `handle`, when given, is the already open file to read (so identity checks, this scan and the
    fingerprints all see one inode); `path` then only names it.
    """
    parser = PARSERS[runtime]
    state = json.loads(json.dumps(state)) if state else parser.initial(path)
    calls: list[dict[str, Any]] = []
    end = offset
    for record, line_end in iter_jsonl_from(handle if handle is not None else path, offset):
        end = line_end
        if isinstance(record, dict):
            call = parser.step(record, state)
            if call is not None:
                calls.append(call)
    return calls, end, state


def read_humain_terminal(path: Path) -> list[dict[str, Any]]:
    return read_calls(path, HUMAIN_TERMINAL)[0]


def read_codex(path: Path) -> list[dict[str, Any]]:
    return read_calls(path, CODEX)[0]


READERS: dict[str, Callable[[Path], list[dict[str, Any]]]] = {
    HUMAIN_TERMINAL: read_humain_terminal,
    CODEX: read_codex,
}


def detect_runtime(path: Path | BinaryIO) -> Optional[str]:
    """Identify the harness from the log's own record shapes, not from its file name."""
    for index, record in enumerate(_lines(path)):
        if record.get('type') == 'token_usage_record':
            return CODEX
        if record.get('type') == 'session_meta' and isinstance(record.get('payload'), dict):
            return CODEX
        message = record.get('message')
        if isinstance(message, dict) and 'usage' in message:
            return HUMAIN_TERMINAL
        if record.get('type') in {'session', 'model_change'} and 'payload' not in record:
            return HUMAIN_TERMINAL
        if index > 400:
            break
    return None


def discover_logs(*, since_days: float | None = None, runtimes: Iterable[str] | None = None,
                  home: str | Path | None = None, include_scratch: bool = False) -> list[Path]:
    """Find session logs, newest first, optionally limited to those modified recently.

    Test-harness and temp-directory sessions are excluded by default: they run faux models and
    would enter the ledger as real work.
    """
    base = Path(home).expanduser() if home is not None else Path.home()
    cutoff = time.time() - since_days * 86_400 if since_days else None
    wanted = set(runtimes) if runtimes else set(LOG_GLOBS)
    found: list[Path] = []
    for runtime, globs in LOG_GLOBS.items():
        if runtime not in wanted:
            continue
        for pattern in globs:
            for path in base.glob(pattern):
                if not path.is_file():
                    continue
                if cutoff is not None and path.stat().st_mtime < cutoff:
                    continue
                if not include_scratch and is_scratch_log(path):
                    continue
                found.append(path)
    return sorted(set(found), key=lambda p: p.stat().st_mtime, reverse=True)


def call_id_for(runtime: str, session_id: str, native_id: str) -> str:
    return stable_hash(['model_call', runtime, session_id, native_id])


def _reconcile_source_calls(calls: list[dict[str, Any]], *, runtime: str, path: Path,
                            live: set[str], history: dict[tuple[str, str], dict[str, Any]],
                            ledger: IngestLedger, resumable: bool, promotions: dict[str, dict[str, Any]],
                            source_identity: list[int], checkpoint_identity: list[int] | None,
                            alias_targets: dict[str, set[str]] | None = None
                            ) -> tuple[set[str], dict[str, set[str]]]:
    """Resolve orphaned session IDs by exact source call coverage, never by token totals.

    The current native ID can recreate its old session-qualified hash. A matching hash in
    this source's authoritative coverage (or its observed history) identifies the same call.
    Preserve that hash in observations, so drift does not invent unpaid historical aliases
    when metrics are later rolled back. Multiple old identities and positional IDs are not
    evidence of a unique call and must not silently suppress usage. For a rewrite, require
    complete matching coverage and per-model usage as well: reused IDs with missing or changed
    calls are ambiguous. Totals validate an identity match; they never pay for unmatched IDs.
    """
    if not calls:
        return set(), {}  # no identity to reconcile; keep seeded Codex ledgers incremental
    if not resumable:
        # Live IDs bypass alias reconciliation below, but their paid hashes are not
        # proof of continuity across an inode replacement for fallback identities,
        # whether still headerless or promoted to explicit IDs. Check provenance
        # BEFORE comparing any paid IDs, including same-session IDs.
        # Explicit-only sessions still support rotation with call-ID deduplication.
        source_states = ledger.source_states(runtime, path)
        current_generation = {tuple(source_identity)}
        fallback_sessions = {str(call['session_id']) for call in calls if call.get('session_origin') == 'fallback'}
        for sid in {str(call['session_id']) for call in calls}:
            state = source_states.get(sid)
            if not state:
                continue  # no target coverage to inherit; a rotated target can be billed in full
            fallback_origin = sid in fallback_sessions or 'fallback' in state.get('session_origins', set())
            rotated_target = any(bound['to_session_id'] == sid and bound['source_identity'] != source_identity
                                 for bound in promotions.values())
            if ((fallback_origin or rotated_target)
                    and state.get('source_identities', set()) != current_generation):
                # A binding can predate a fully billed replacement. Only rows wholly
                # from that replacement permit its retries; mixed/missing generations
                # cannot establish which same-session calls were actually paid.
                raise SourceConflict(f'{path}: session {sid}: ambiguous source generation for a live fallback or promoted identity; '
                                     'reconcile source identities before retrying; nothing was written.')
    # Missing/old checkpoints are not permission to alias explicit logical sessions.
    # Rebuild eligibility from source-scoped authoritative rows. Unknown legacy origins
    # remain candidates only so an overlapping identity is rejected, never guessed paid/new.
    unknown_origins: set[str] = set()
    if alias_targets is None:
        source_states = ledger.source_states(runtime, path)
        fallback = set()
        explicit_history = any('explicit' in state.get('session_origins', set()) for state in source_states.values())
        for sid in (set(source_states) | {sid for sid, _ in history}) - live:
            origins = source_states.get(sid, {}).get('session_origins', set())
            if origins == {'fallback'}:
                fallback.add(sid)
                if sid not in promotions and (explicit_history or source_states[sid].get('legacy_promotions')):
                    # An older writer may already have consumed this fallback in a
                    # promotion, even one with zero new metrics. Without a protocol
                    # marker or binding, origins cannot name its target; do not guess.
                    unknown_origins.add(sid)
            elif origins != {'explicit'}:
                unknown_origins.add(sid)
        alias_targets = {sid: set(unknown_origins) for sid in live}
        for call in calls:
            if call.get('session_origin') == 'explicit':
                alias_targets[str(call['session_id'])].update(fallback)
    # Durable bindings constrain even a stale checkpoint's proposed aliases. A paid
    # fallback can belong to only one explicit logical session, never its successor.
    for target, ids in alias_targets.items():
        ids.difference_update(sid for sid, bound in promotions.items() if bound['to_session_id'] != target)
        ids.update(sid for sid, bound in promotions.items() if bound['to_session_id'] == target and sid not in live)
    unknown_origins.difference_update(promotions)
    eligible = {sid for ids in alias_targets.values() for sid in ids}
    unknown_generations: set[str] = set()
    for sid in eligible:
        binding = promotions.get(sid)
        if binding is not None and binding['source_identity'] != source_identity:
            same_generation = False
        elif checkpoint_identity is not None and any(old_sid == sid for old_sid, _ in history):
            same_generation = checkpoint_identity == source_identity
        else:
            # Native IDs and equal usage can recur at the same path on a new inode.
            # All source-scoped rows must establish continuity; missing/mixed legacy
            # generations cannot be filled in from a different row or a binding.
            generations = ledger.source_states(runtime, path).get(sid, {}).get('source_identities', set())
            current = tuple(source_identity)
            same_generation = generations == {current}
            if not same_generation and (not generations or None in generations or current in generations):
                unknown_generations.add(sid)
                continue
        if not same_generation:
            for ids in alias_targets.values():
                ids.discard(sid)
    eligible = {sid for ids in alias_targets.values() for sid in ids}
    candidates: dict[str, set[str]] = {}
    evidence = []
    if not resumable:
        for sid, state in ledger.source_states(runtime, path).items():
            if sid in live or sid not in eligible:
                continue
            if state['unidentified']:
                raise SourceConflict(f'{path}: session {sid}: ambiguous totals-only source history after session ID '
                                     'drift; reconcile the legacy rows with call IDs before retrying; nothing was written.')
            candidates[sid] = set(state['covered_call_ids'])
            evidence.append((sid, set(state['covered_call_ids']), state['models']))
    for (sid, model), group in history.items():
        if sid not in live and sid in eligible:
            candidates.setdefault(sid, set()).update(group['call_ids'])
            if not resumable:
                evidence.append((sid, set(group['call_ids']), {model: group}))
    paid = set()
    aliases: dict[str, set[str]] = {}
    matched: dict[str, dict[str, dict[str, Any]]] = {}
    for call in calls:
        target = str(call['session_id'])
        matches = {sid: call_id_for(runtime, sid, call['native_id']) for sid, ids in candidates.items()
                   if sid in alias_targets.get(target, set())
                   and call_id_for(runtime, sid, call['native_id']) in ids}
        if not matches:
            continue
        if unknown_origins.intersection(matches):
            raise SourceConflict(f'{path}: ambiguous session provenance in source history after session ID drift; '
                                 'restore provenance or reconcile the legacy rows before retrying; nothing was written.')
        if unknown_generations.intersection(matches):
            raise SourceConflict(f'{path}: ambiguous source generation after session ID drift; restore a matching '
                                 'checkpoint or reconcile metric source identities before retrying; nothing was written.')
        # Historical hashes do not distinguish HT's numeric positional fallback from an
        # explicit numeric ID. Neither can safely establish cross-session identity.
        positional = runtime == HUMAIN_TERMINAL and call['native_id'].isdecimal()
        if len(matches) != 1 or positional or not call.get('_native_id_stable', False):
            raise SourceConflict(f'{path}: ambiguous source-native call identity after session ID drift; '
                                 'restore unambiguous source history before retrying; nothing was written.')
        sid, call_id = next(iter(matches.items()))
        if any(sid in ids and other != target for other, ids in aliases.items()):
            raise SourceConflict(f'{path}: ambiguous session promotion to multiple explicit sessions; nothing was written.')
        # Retain the original session-qualified identity for old calls only. New calls keep
        # the session the reader found; no tokens move between recorded session buckets.
        call['session_id'] = sid
        call['session_origin'] = 'fallback'
        aliases.setdefault(target, set()).add(sid)
        matched.setdefault(sid, {})[call_id] = call
        if call_id in ledger.state(runtime, sid)['covered_call_ids']:
            paid.add(call_id)
    for sid, ids, models in evidence:
        found = matched.get(sid, {})
        if not ids.intersection(found):
            continue
        totals: dict[str, dict[str, int]] = {}
        for call_id in ids.intersection(found):
            call = found[call_id]
            add_totals(totals.setdefault(str(call.get('model') or ''), empty_totals()), call)
        if not ids.issubset(found) or any(not totals_equal(models.get(model), totals.get(model))
                                        for model in set(models) | set(totals)):
            raise SourceConflict(f'{path}: session {sid}: ambiguous source-native coverage after session ID drift; '
                                 'missing calls or changed usage cannot establish identity; nothing was written.')
    return paid, aliases


def _tally(summary: dict[str, Any], record: dict[str, Any]) -> None:
    """Accumulate cost, separating 'no rate configured' from 'harness reported zero tokens'."""
    cost = record.get('cost_usd')
    if cost is not None:
        summary['estimated_cost_usd'] = round(summary['estimated_cost_usd'] + float(cost), 6)
        return
    from .pricing import load_pricing, rate_for
    model = record.get('model') or 'unknown'
    tokens = sum(int(record.get(field) or 0) for field in TOKEN_FIELDS)
    bucket = 'unpriced_models' if rate_for(model, load_pricing()) is None else 'zero_token_models'
    summary.setdefault(bucket, {})
    summary[bucket][model] = summary[bucket].get(model, 0) + 1
    if tokens == 0:
        summary['zero_usage'] = summary.get('zero_usage', 0) + (int(record.get('covers_calls') or 1))


def _base_metric(call: dict[str, Any], *, runtime: str, path: Path, repository: str | None,
                 source_identity: list[int]) -> dict[str, Any]:
    metric = {k: v for k, v in call.items() if k != 'native_id' and not k.startswith('_') and v is not None}
    metric.update({'event': 'model_call', 'agent_runtime': runtime, 'role': 'interactive_session',
                   'source': 'session_ingest', 'ingest_source': str(path), 'promotion_version': ckpt.PROMOTION_VERSION,
                   'source_identity': source_identity})
    # Precedence: explicit override, then the repository the log itself recorded, then
    # EventStore's env-based attribution. Never the ingesting process's cwd, which is wherever
    # the CLI happened to run and has nothing to do with where the work was done.
    if repository:
        metric['repository'] = repository
    elif not metric.get('repository'):
        metric.pop('repository', None)
    return metric


# --- observed usage per (session, model) -------------------------------------------------------

def _group_key(call: dict[str, Any]) -> tuple[str, str]:
    return str(call['session_id']), str(call.get('model') or '')


def _observe(observed: dict[tuple[str, str], dict[str, Any]], calls: list[dict[str, Any]], *, runtime: str
             ) -> dict[tuple[str, str], dict[str, Any]]:
    """Totals and call ids per (session, model) after `calls`, without mutating `observed` (a checkpoint's view)."""
    out = {key: {**group, 'call_ids': list(group.get('call_ids', ()))} for key, group in observed.items()}
    seen = _observed_ids(observed)
    for call in calls:
        call_id = call_id_for(runtime, str(call['session_id']), call['native_id'])
        if call_id in seen:
            continue
        seen.add(call_id)
        group = out.setdefault(_group_key(call), {**empty_totals(), 'session_id': str(call['session_id']),
                                                   'session_origin': call.get('session_origin'),
                                                   'model': call.get('model'), 'provider': call.get('provider'),
                                                   'repository': call.get('repository'), 'first_ts': call.get('ts'),
                                                   'ts': call.get('ts'), 'call_ids': []})
        add_totals(group, call)
        group['call_ids'].append(call_id)
        if call.get('session_origin') == 'explicit':
            group['session_origin'] = 'explicit'
        for field in ('provider', 'repository'):
            if call.get(field):
                group[field] = call[field]
        if call.get('ts'):
            group['ts'] = call['ts']
    return out


def _observed_from_json(groups: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    return {(group['session_id'], str(group.get('model') or '')): dict(group) for group in groups}


def _observed_to_json(observed: dict[tuple[str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(group) for _, group in sorted(observed.items())]


def _observed_ids(observed: dict[tuple[str, str], dict[str, Any]]) -> set[str]:
    return {call_id for group in observed.values() for call_id in group.get('call_ids', ())}


def _session_rows(calls: list[dict[str, Any]], *, runtime: str, ledger: IngestLedger) -> list[dict[str, Any]]:
    """Aggregate only calls not covered by the ledger, carrying their identities durably with the usage."""
    rows = []
    for (session_id, model), group in sorted(_observe({}, calls, runtime=runtime).items()):
        prior = ledger.state(runtime, session_id)['models'].get(model) or empty_totals()
        row = {key: value for key, value in group.items() if key != 'call_ids'}
        row.update(covered_call_ids=group['call_ids'], native_id=f'{session_id}:{model}:{prior["calls"]}:{group["calls"]}')
        rows.append(row)
    return rows


def _paid_call_ids(calls: list[dict[str, Any]], *, runtime: str, live: set[str], ledger: IngestLedger,
                   checkpoint: dict[str, Any] | None, seeded: bool, prefix_intact: bool, path: Path) -> set[str]:
    """Identity evidence for recorded calls, including a verified legacy checkpoint when available.

    Modern aggregate rows identify their calls just like per-call rows. Totals-only legacy rows
    cannot identify a replaced source, even when every number matches. Only an intact metrics
    checkpoint can anchor those rows; an unchanged source prefix permits exact suffix reconciliation.
    A rewrite permits no new unidentified rows, but identified retries (durable or staged) are safe.
    """
    paid = {call_id for sid in live for call_id in ledger.state(runtime, sid)['covered_call_ids']}
    legacy = {sid for sid in live if ledger.state(runtime, sid)['unidentified']}
    if not legacy:
        return paid
    if checkpoint is None or not seeded:
        details = '; '.join(f'{sid}: {sum(t["calls"] for t in ledger.state(runtime, sid)["models"].values())} calls recorded'
                            for sid in sorted(legacy))
        raise SourceConflict(
            f'{path}: ambiguous totals-only history ({details}); the log may have been truncated or rewritten. '
            'Restore a matching source checkpoint or reconcile the legacy rows with call IDs before retrying. '
            'Switching to --granularity session cannot establish identity. Nothing was written; the recorded rows stand.')
    history = _observed_from_json(checkpoint['observed'])
    historical_ids = _observed_ids(history)
    if not prefix_intact:
        for sid in legacy:
            then = checkpoint['recorded'].get(sid, {}).get('unidentified', {})
            now = ledger.state(runtime, sid)['unidentified']
            if any(not totals_equal(then.get(model), now.get(model)) for model in set(then) | set(now)):
                raise SourceConflict(f'{path}: session {sid}: the log was rewritten and new totals-only rows cannot be '
                                     'matched to its calls. Restore the matching source/checkpoint before retrying; nothing was written.')
        return paid | historical_ids
    # Positional legacy evidence must not count calls already paid by identity (or count a
    # repeated source ID twice). Historical IDs also cover parser fallback and reintroduced calls.
    suffix = []
    seen = paid | historical_ids
    for call in calls:
        call_id = call_id_for(runtime, str(call['session_id']), call['native_id'])
        if call_id not in seen:
            suffix.append(call)
            seen.add(call_id)
    found = _reconcile_prefix(suffix, checkpoint['recorded'], runtime=runtime, sessions=legacy, ledger=ledger)
    if found is None:
        raise _conflict(path, runtime=runtime, sessions=legacy, ledger=ledger, calls_seen=len(calls))
    return paid | historical_ids | {call_id_for(runtime, str(call['session_id']), call['native_id'])
                                    for call in suffix[:found] if str(call['session_id']) in legacy}


def _reconcile_prefix(calls: list[dict[str, Any]], recorded_before: dict[str, Any], *,
                      runtime: str, sessions: set[str], ledger: IngestLedger) -> Optional[int]:
    """Prefix of not-yet-identified calls covered by new legacy rows, or None.

    The verified checkpoint anchors earlier legacy usage. Match only the increase in unidentified
    per-(session, model) totals (tokens *and* call counts), never identified contributions: those
    calls are already excluded by the caller. Otherwise an identified row later in the source can
    numerically pay for an unrelated earlier call and then be deduplicated a second time by ID.
    Calls of other sessions inside the suffix neither count nor match.
    """
    recorded = {}
    for sid in sessions:
        before = recorded_before.get(sid, {}).get('unidentified', {})
        after = ledger.state(runtime, sid)['unidentified']
        for model in set(before) | set(after):
            recorded[(sid, model)] = {field: after.get(model, {}).get(field, 0) - before.get(model, {}).get(field, 0)
                                      for field in COUNT_FIELDS}
    running: dict[tuple[str, str], dict[str, Any]] = {}

    def matches() -> bool:
        return all(totals_equal(recorded.get(key), running.get(key)) for key in set(recorded) | set(running))

    if matches():
        return 0
    for index, call in enumerate(calls):
        if str(call['session_id']) not in sessions:
            continue
        add_totals(running.setdefault(_group_key(call), empty_totals()), call)
        if matches():
            return index + 1
    return None


def _conflict(path: Path, *, runtime: str, sessions: set[str], ledger: IngestLedger, calls_seen: int) -> GranularityConflict:
    parts = []
    for sid in sorted(sessions):
        state = ledger.state(runtime, sid)
        if SESSION not in state['granularities']:
            continue
        calls = sum(t['calls'] for t in state['models'].values())
        tokens = sum(t['total_tokens'] for t in state['models'].values())
        parts.append(f'session {sid}: {calls} calls / {tokens} total tokens recorded at session level')
    return GranularityConflict(
        f'{path}: ingestion cannot identify the recorded calls — {"; ".join(parts)} — and those totals match no prefix of the '
        f'{calls_seen} calls in this log. Restore the matching source/checkpoint or reconcile the legacy rows with call IDs '
        'before retrying. Switching to --granularity session cannot establish identity; nothing was written.')


def _chunks(items: list[Any], size: int) -> Iterator[list[Any]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _empty_summary(path: Path, runtime: str | None, granularity: str, dry_run: bool) -> dict[str, Any]:
    # An empty log is a session that never produced a call, not a broken file.
    return {'file': str(path), 'runtime': runtime, 'granularity': granularity, 'usage_rows': 0,
            'emitted': 0, 'duplicates': 0, 'zero_usage': 0, 'estimated_cost_usd': 0.0,
            'unpriced_models': {}, 'empty': True, 'dry_run': bool(dry_run), 'resumed': False, 'scanned_from': 0}


def _ingest_source(path: Path, root: Path, *, runtime: str | None, repository: str | None, dry_run: bool,
                   granularity: str, ledger: IngestLedger) -> dict[str, Any]:
    """Settle, check, append and checkpoint one log. The caller holds the writer lock unless `dry_run`."""
    settled = None
    if not dry_run:
        # Rows an interrupted append left un-fsynced, or a complete row missing its newline, become
        # durable/terminated before the ledger derives anything from them. Same lock, same writer.
        settled = settle_streams(root, lock=False)
    checkpoint = ckpt.load_checkpoint(root, path)
    with path.open('rb') as source:
        summary, updated = _ingest_open_source(source, path, root, checkpoint=checkpoint, runtime=runtime, repository=repository,
                                               dry_run=dry_run, granularity=granularity, ledger=ledger)
    if dry_run:
        return summary
    if settled is not None and settled['status'] != 'ok':
        summary.setdefault('write_status', settled['status'])
        summary.setdefault('write_error', settled['error'])
    if not (summary['resumed'] and updated == checkpoint):  # an unchanged session with no new history costs no write
        ckpt.save_checkpoint(root, updated)
    return summary


def _ingest_open_source(source: BinaryIO, path: Path, root: Path, *, checkpoint: dict[str, Any] | None, runtime: str | None,
                        repository: str | None, dry_run: bool, granularity: str, ledger: IngestLedger
                        ) -> tuple[dict[str, Any], dict[str, Any]]:
    """One open file from identity check to fingerprint: a rotation of the path meanwhile changes nothing we read."""
    opened = ckpt.source_signature(source)
    prefix_intact = checkpoint is not None and ckpt.source_prefix_intact(source, checkpoint)
    resolved = runtime or (checkpoint['runtime'] if prefix_intact else None) or detect_runtime(source)
    if resolved not in PARSERS:
        raise ValueError(f'Unrecognized session log format: {path}')
    # A checkpoint written by another parser describes different calls: it is neither a prefix nor a history here.
    known = checkpoint if checkpoint is not None and checkpoint['runtime'] == resolved else None
    # The recorded side is about metrics.jsonl, not the log: seed it even when the log must be re-read.
    # `seed` also says whether the metrics prefix the checkpoint's dedup state was verified against still exists.
    seeded = ledger.seed(resolved, known['recorded'], known['metrics']) if known is not None else False
    resumable = known is not None and prefix_intact and PARSERS[resolved].valid_state(known['reader'])
    if resumable and not seeded:
        # The prefix's calls were never re-read; the rows vouching for them were rolled back. Re-read,
        # and let the ids decide what is still missing.
        resumable = False
    if resumable:
        offset, reader_state, prefix = known['offset'], known['reader'], _observed_from_json(known['observed'])
    else:
        offset, reader_state, prefix = 0, None, {}

    calls, end, reader_state = read_calls(path, resolved, offset=offset, state=reader_state, handle=source)
    # Fingerprint before the final signature check and before any metric append. No later source
    # reads can bind a new fingerprint to old parser state. Unchanged imports retain the fast path.
    prefix_hash = (known['prefix_hash'] if resumable and end == known['offset']
                   else ckpt.prefix_fingerprint(source, end))
    head_hash, tail_hash = ckpt.head_fingerprint(source, end), tail_fingerprint(source, end)
    after_read = ckpt.source_signature(source)
    if ckpt.changed_while_reading(opened, after_read):
        raise SourceConflict(f'{path}: the log changed while it was being read; nothing was written, retry when settled')
    prefix_calls = sum(group['calls'] for group in prefix.values())
    live = (set(known.get('live_sessions', [sid for sid, _ in prefix])) if resumable else set())
    live.update(str(call['session_id']) for call in calls)  # physical source sessions, not historical identities
    history = _observed_from_json(known['observed']) if known is not None else {}
    sessions = {sid for sid, _ in history} | live
    ledger.ensure((resolved, sid) for sid in sessions)
    ledger.advance()
    aliases = {sid: set(ids) for sid, ids in known.get('session_aliases', {}).items() if sid in live} if known else {}
    alias_targets = None
    if (resolved == HUMAIN_TERMINAL and known is not None
            and ckpt.valid_session_provenance(known['reader'].get('session_provenance'))):
        provenance = known['reader']['session_provenance']
        # Inode replacement is a new source generation, not evidence that a filename ID
        # was promoted. Explicit IDs likewise delimit logical sessions even on one inode.
        fallback = {sid for sid, origin in provenance.items() if origin == 'fallback' and sid not in live}
        if known['identity'] != opened['identity']:
            fallback = set()
        alias_targets = {sid: set(aliases.get(sid, ())) for sid in live}
        for sid in live:
            if reader_state['session_provenance'].get(sid) == 'explicit' and sid not in provenance:
                alias_targets[sid].update(fallback)
    try:
        promotions = ledger.source_promotions(resolved, path) if calls else {}
    except ValueError as error:
        raise SourceConflict(str(error)) from error
    drift_paid, matched_aliases = _reconcile_source_calls(calls, runtime=resolved, path=path, live=live,
                                                         history=history, ledger=ledger, resumable=resumable,
                                                         promotions=promotions, alias_targets=alias_targets,
                                                         source_identity=opened['identity'],
                                                         checkpoint_identity=known['identity'] if known else None)
    for sid, ids in matched_aliases.items():
        aliases.setdefault(sid, set()).update(ids)
    observed_after = _observe(history, calls, runtime=resolved)
    sessions.update(sid for sid, _ in observed_after)

    summary: dict[str, Any] = {'file': str(path), 'runtime': resolved, 'granularity': granularity,
                               'usage_rows': prefix_calls + len(calls), 'emitted': 0, 'duplicates': 0, 'zero_usage': 0,
                               'estimated_cost_usd': 0.0, 'unpriced_models': {}, 'dry_run': bool(dry_run),
                               'resumed': bool(resumable), 'scanned_from': offset}
    previous_granularity = known['granularity'] if known is not None else None
    reconciled = 0
    paid = _paid_call_ids(calls, runtime=resolved, live=live, ledger=ledger, checkpoint=known,
                          seeded=seeded, prefix_intact=prefix_intact, path=path) | drift_paid
    if known is not None and not seeded:
        accounted = {call_id for sid in sessions for call_id in ledger.state(resolved, sid)['covered_call_ids']}
        current_ids = {call_id_for(resolved, str(call['session_id']), call['native_id']) for call in calls}
        missing = _observed_ids(history) - accounted - current_ids
        if missing:
            raise SourceConflict(f'{path}: metrics were rolled back and {len(missing)} previously seen calls are absent '
                                 'from the source. Restore the source or metrics before retrying; nothing was written.')
    new_calls = []
    seen = set(paid)
    for call in calls:
        call_id = call_id_for(resolved, str(call['session_id']), call['native_id'])
        if call_id not in seen:
            new_calls.append(call)
            seen.add(call_id)
    if granularity == SESSION:
        rows = _session_rows(new_calls, runtime=resolved, ledger=ledger)
        if not rows and summary['usage_rows']:
            summary['duplicates'] = 1
        metrics = []
        for row in rows:
            metric = _base_metric(row, runtime=resolved, path=path, repository=repository,
                                  source_identity=opened['identity'])
            metric.update({'granularity': SESSION, 'covers_calls': int(row['calls']),
                           'call_id': call_id_for(resolved, str(row['session_id']), row['native_id'])})
            metric.pop('calls', None)
            metrics.append(metric)
    else:
        metrics = []
        summary['duplicates'] = prefix_calls + len(calls) - len(new_calls)
        for call in calls:
            sid = str(call['session_id'])
            call_id = call_id_for(resolved, sid, call['native_id'])
            state = ledger.state(resolved, sid)
            if call_id in paid and SESSION in state['granularities'] and call_id not in state['call_ids']:
                reconciled += 1
        for call in new_calls:
            session_id = str(call['session_id'])
            # A usage block of all zeros is a measurement gap, not free work.
            call_id = call_id_for(resolved, session_id, call['native_id'])
            metric = _base_metric(call, runtime=resolved, path=path, repository=repository,
                                  source_identity=opened['identity'])
            metric.update({'call_id': call_id, 'granularity': CALL})
            metrics.append(metric)
    if previous_granularity not in (None, granularity) or reconciled:
        summary['granularity_transition'] = {'from': previous_granularity, 'to': granularity, 'offset': offset,
                                             'reconciled_calls': reconciled}

    # Commit the binding first, under the same writer lock, before any metric chunks.
    # A crash may leave just the event: retry reuses that proof and bills missing calls.
    records = [ckpt.promotion_record(resolved, path, opened['identity'], sid, target)
               for target, ids in sorted(matched_aliases.items()) for sid in sorted(ids) if sid not in promotions]
    records.extend({'stream': 'metric', 'record_id': metric['call_id'], **metric} for metric in metrics)
    if dry_run:
        built = [build_record(record) for record in records]
        ledger.stage(built)  # the rest of this sweep previews against what this file would have written
        for spec, record in zip(records, built):
            if spec['stream'] != 'metric':
                continue
            summary['emitted'] += 1
            _tally(summary, record)
        return summary, {}
    for chunk in _chunks(records, MAX_BATCH_RECORDS):
        result = write_batch(root, chunk, refresh=False, lock=False)
        for status, record in zip(result['statuses'], result['records']):
            if status['stream'] != 'metric':
                continue
            if status['status'] == 'persisted':
                summary['emitted'] += 1
                _tally(summary, record)
            else:
                summary['duplicates'] += 1
        if result['status'] != 'ok':
            # Rows are durable; only the writer's derived cache failed. Say so, but keep going: the
            # next write rebuilds it, and our checkpoint may vouch for what is on disk.
            summary['write_status'] = result['status']
            summary['write_error'] = result['error']
    ledger.advance()  # our own rows, now durable, become part of the recorded state
    updated = {
        'format_version': ckpt.FORMAT_VERSION, 'source': ckpt.source_key(path), 'runtime': resolved, 'granularity': granularity,
        'identity': after_read['identity'], 'stat': after_read['stat'], 'offset': end,
        'head_hash': head_hash, 'tail_hash': tail_hash, 'prefix_hash': prefix_hash, 'reader': reader_state,
        'observed': _observed_to_json(observed_after), 'sessions': sorted(sessions), 'live_sessions': sorted(live),
        'session_aliases': {sid: sorted(ids) for sid, ids in sorted(aliases.items())},
        'metrics': ledger.metrics_state(), 'recorded': ledger.export(resolved, sessions),
    }
    return summary, updated


def _run(paths: Iterable[str | Path], *, runtime: str | None, repository: str | None, root: Path, dry_run: bool,
         granularity: str, ledger: IngestLedger) -> Iterator[tuple[Path, dict[str, Any] | None, Exception | None]]:
    """Ingest each path in turn under the writer lock (none for a dry run), yielding (path, summary, error)."""
    if not dry_run:
        EventStore(root)  # root + streams exist before the first lock; write_batch settles their durability under it
    for raw in paths:
        path = Path(raw).expanduser()
        try:
            if not path.is_file():
                raise FileNotFoundError(f'No session log at {path}')
            if path.stat().st_size == 0:
                yield path, _empty_summary(path, runtime, granularity, dry_run), None
                continue
            if dry_run:
                summary = _ingest_source(path, root, runtime=runtime, repository=repository, dry_run=True,
                                         granularity=granularity, ledger=ledger)
            else:
                with writer_lock(root):
                    summary = _ingest_source(path, root, runtime=runtime, repository=repository, dry_run=False,
                                             granularity=granularity, ledger=ledger)
        except (OSError, ValueError, BatchAppendError) as error:
            # Unreadable/unrecognized log, granularity conflict, or an interrupted append (retry with
            # the same ids): reported per file so a bulk backfill is not abandoned part-way through.
            yield path, None, error
            continue
        yield path, summary, None


def ingest_file(path: str | Path, *, runtime: str | None = None, repository: str | None = None,
                state_root: str | Path | None = None, dry_run: bool = False, granularity: str = CALL) -> dict[str, Any]:
    if granularity not in (CALL, SESSION):
        raise ValueError(f'Unknown granularity: {granularity}')
    root = Path(state_root) if state_root is not None else default_state_root()
    for _, summary, error in _run([path], runtime=runtime, repository=repository, root=root, dry_run=dry_run,
                                  granularity=granularity, ledger=IngestLedger(root)):
        if error is not None:
            raise error
        return summary
    raise FileNotFoundError(f'No session log at {path}')


def ingest_paths(paths: Iterable[str | Path], *, runtime: str | None = None, repository: str | None = None,
                 state_root: str | Path | None = None, dry_run: bool = False,
                 granularity: str = CALL, on_file: Callable[[dict[str, Any]], None] | None = None,
                 summarize_files: bool = True) -> dict[str, Any]:
    if granularity not in (CALL, SESSION):
        raise ValueError(f'Unknown granularity: {granularity}')
    root = Path(state_root) if state_root is not None else default_state_root()
    files: list[dict[str, Any]] = []
    totals = {'emitted': 0, 'duplicates': 0, 'zero_usage': 0, 'usage_rows': 0, 'estimated_cost_usd': 0.0}
    unpriced: dict[str, int] = {}
    zero_token: dict[str, int] = {}
    failures: list[dict[str, str]] = []
    processed = 0
    for path, summary, error in _run(paths, runtime=runtime, repository=repository, root=root, dry_run=dry_run,
                                     granularity=granularity, ledger=IngestLedger(root)):
        if error is not None:
            failures.append({'file': str(path), 'error': f'{type(error).__name__}: {error}'})
            continue
        processed += 1
        for key in totals:
            totals[key] = round(totals[key] + summary.get(key, 0), 6)
        for model, count in summary['unpriced_models'].items():
            unpriced[model] = unpriced.get(model, 0) + count
        for model, count in summary.get('zero_token_models', {}).items():
            zero_token[model] = zero_token.get(model, 0) + count
        if summarize_files:
            files.append(summary)
        if on_file:
            on_file(summary)
    return {
        'files': files,
        'files_processed': processed if summarize_files else None,
        'failures': failures,
        'granularity': granularity,
        **totals,
        'unpriced_models': unpriced,
        'zero_token_models': zero_token,
        'dry_run': bool(dry_run),
    }

from __future__ import annotations
"""Ingest per-call token usage from coding-agent session logs.

An agent writing its own telemetry mid-session cannot know its token counts, so records
emitted by hand arrive unmetered. Every harness already writes usage to disk; this module
reads those logs and emits one `model_call` metric per real model call, which `EventStore.metric`
then prices and labels.

Ingestion is idempotent: each call carries a `call_id` derived from the harness's own
identifiers, and ids already present in `metrics.jsonl` are skipped. The event stream stays
the single authoritative record, so no side index can drift from it.
"""
import json
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Optional

from .records import CALL, SESSION
from .runtime import EventStore, default_state_root, load_jsonl, stable_hash

HUMAIN_TERMINAL = 'humain-terminal'
CODEX = 'codex'
# CALL/SESSION re-exported from `orchestrator.records` (verified byte-identical to the values
# this module used before that seam existed: 'call' and 'session') so there is exactly one
# definition of granularity vocabulary. Re-exported, not just imported privately, because
# callers outside this module (tests, cli.py) import CALL/SESSION from `orchestrator.ingest`.

TOKEN_FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens',
                'reasoning_output_tokens', 'total_tokens')

LOG_GLOBS: dict[str, tuple[str, ...]] = {
    HUMAIN_TERMINAL: ('.humain-terminal/agent/sessions/*/*.jsonl',),
    CODEX: ('.codex/sessions/*/*/*/rollout-*.jsonl',),
}


def _int(value: Any) -> int:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def _lines(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
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


def read_humain_terminal(path: Path) -> list[dict[str, Any]]:
    """HUMAIN Terminal session JSONL: assistant messages carry a `usage` block.

    `usage.input` excludes cached reads here, unlike the OpenAI-style convention used by the
    telemetry contract, so cached reads are folded back into `input_tokens` to keep
    `cached_input_tokens` a subset of it.
    """
    session_id = path.stem.split('_')[-1]
    repository = log_repository(path)
    calls: list[dict[str, Any]] = []
    for record in _lines(path):
        if record.get('type') == 'session':
            session_id = str(record.get('id') or record.get('sessionId') or session_id)
        message = record.get('message')
        if not isinstance(message, dict) or message.get('role') != 'assistant':
            continue
        usage = message.get('usage')
        if not isinstance(usage, dict):
            continue
        cached = _int(usage.get('cacheRead'))
        calls.append({
            'native_id': str(record.get('id') or len(calls)),
            'session_id': session_id,
            'ts': record.get('timestamp'),
            'model': message.get('model'),
            'provider': message.get('provider'),
            'repository': repository,
            'input_tokens': _int(usage.get('input')) + cached,
            'cached_input_tokens': cached,
            'cache_write_tokens': _int(usage.get('cacheWrite')) + _int(usage.get('cacheWrite1h')),
            'output_tokens': _int(usage.get('output')),
            'reasoning_output_tokens': _int(usage.get('reasoning')),
            'total_tokens': _int(usage.get('totalTokens')),
        })
    return calls


def read_codex(path: Path) -> list[dict[str, Any]]:
    """Codex rollout JSONL: one `token_usage_record` per response.

    `payload.usage` is the per-response delta; `turn_token_usage` and `thread_token_usage` are
    cumulative and must not be summed. The model lives on `turn_context`, keyed by turn.
    """
    calls: list[dict[str, Any]] = []
    models: dict[str, str] = {}
    latest_model: Optional[str] = None
    repository: Optional[str] = None
    provider: Optional[str] = None
    for record in _lines(path):
        kind = record.get('type')
        payload = record.get('payload')
        if not isinstance(payload, dict):
            continue
        if kind == 'session_meta':
            repository = payload.get('cwd') or repository
            provider = payload.get('model_provider') or provider
            continue
        if kind == 'turn_context':
            model = payload.get('model')
            if model:
                latest_model = str(model)
                if payload.get('turn_id'):
                    models[str(payload['turn_id'])] = latest_model
            repository = payload.get('cwd') or repository
            continue
        if kind != 'token_usage_record':
            continue
        usage = payload.get('usage')
        if not isinstance(usage, dict):
            continue
        turn_id = payload.get('turn_id')
        calls.append({
            'native_id': str(payload.get('response_id') or f"{turn_id}:{record.get('ordinal')}"),
            'session_id': str(payload.get('session_id') or path.stem),
            'turn_id': turn_id,
            'ts': record.get('timestamp'),
            'model': models.get(str(turn_id), latest_model),
            'provider': provider,
            'repository': repository,
            'input_tokens': _int(usage.get('input_tokens')),
            'cached_input_tokens': _int(usage.get('cached_input_tokens')),
            'cache_write_tokens': _int(usage.get('cache_write_input_tokens')),
            'output_tokens': _int(usage.get('output_tokens')),
            'reasoning_output_tokens': _int(usage.get('reasoning_output_tokens')),
            'total_tokens': _int(usage.get('total_tokens')),
        })
    return calls


READERS: dict[str, Callable[[Path], list[dict[str, Any]]]] = {
    HUMAIN_TERMINAL: read_humain_terminal,
    CODEX: read_codex,
}


def detect_runtime(path: Path) -> Optional[str]:
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


def existing_call_ids(state_root: Path) -> set[str]:
    return {str(row['call_id']) for row in load_jsonl(state_root / 'metrics.jsonl') if row.get('call_id')}


def recorded_session_totals(state_root: Path) -> dict[tuple[str, str, str], dict[str, int]]:
    """Tokens already recorded per (runtime, session, model), at any granularity.

    Session aggregates are emitted as deltas against this, so a session that was partly ingested
    per call, already aggregated, or has since grown contributes each token exactly once. Nothing
    is ever rewritten or removed to achieve that.

    This is one of two independent reconciliation keys; see `recorded_source_totals` for the
    other and `_merge_prior` for why both are needed and why they are combined with `max`, not
    summed.
    """
    totals: dict[tuple[str, str, str], dict[str, int]] = {}
    for row in load_jsonl(state_root / 'metrics.jsonl'):
        session_id = row.get('session_id')
        if not session_id or row.get('source') != 'session_ingest':
            continue
        key = (str(row.get('agent_runtime') or row.get('runtime') or ''), str(session_id), str(row.get('model') or ''))
        bucket = totals.setdefault(key, {field: 0 for field in TOKEN_FIELDS} | {'calls': 0})
        for field in TOKEN_FIELDS:
            try:
                bucket[field] += int(row.get(field) or 0)
            except (TypeError, ValueError):
                pass
        bucket['calls'] += int(row.get('covers_calls') or 1)
    return totals


def recorded_source_totals(state_root: Path) -> dict[tuple[str, str, str], dict[str, int]]:
    """Tokens already recorded per (runtime, ingest_source, model), at any granularity.

    `recorded_session_totals` keys by `session_id`, and `session_id` is not stable: it comes from
    `read_humain_terminal`'s filename fallback (`path.stem.split('_')[-1]`) until a later
    `type=='session'` record overrides it, and that override may or may not be present on any
    given pass over a log that is still being written. When it drifts between passes, a
    session-granularity re-ingest looks up prior totals under the *new* session_id, finds
    nothing, and re-emits tokens that were already recorded under the *old* one. Live evidence:
    one `ingest_source` carries both 2 session-aggregate rows ($9.18) and 113 per-call rows
    ($11.32) for what should have been a single reconciled total.

    `ingest_source` (the file path passed to `ingest_file`) does not drift, so keying on it too
    gives a second, independent way to find "has this already been counted" that survives
    session_id drift within one file. It cannot, by itself, handle one logical session spanning
    multiple files (each has a different `ingest_source`) — that is what the session_id key is
    for. Both keys are kept; see `_merge_prior`.
    """
    totals: dict[tuple[str, str, str], dict[str, int]] = {}
    for row in load_jsonl(state_root / 'metrics.jsonl'):
        source = row.get('ingest_source')
        if not source or row.get('source') != 'session_ingest':
            continue
        key = (str(row.get('agent_runtime') or row.get('runtime') or ''), str(source), str(row.get('model') or ''))
        bucket = totals.setdefault(key, {field: 0 for field in TOKEN_FIELDS} | {'calls': 0})
        for field in TOKEN_FIELDS:
            try:
                bucket[field] += int(row.get(field) or 0)
            except (TypeError, ValueError):
                pass
        bucket['calls'] += int(row.get('covers_calls') or 1)
    return totals


def _merge_prior(*buckets: dict[str, int] | None) -> dict[str, int]:
    """Field-wise maximum across the two reconciliation buckets, never their sum.

    When `session_id` has not drifted, the session-keyed and source-keyed buckets describe the
    exact same prior rows and agree, so the max is that shared value. When it has drifted, one
    bucket is empty (no prior row was ever recorded under the new session_id, or this is the
    first file seen under this ingest_source) and the other holds the real prior total; the max
    picks the real one. Summing instead of taking the max would double-subtract in the common,
    non-drifted case, because both buckets would be counting the same underlying rows.
    """
    merged = {field: 0 for field in TOKEN_FIELDS} | {'calls': 0}
    for bucket in buckets:
        if not bucket:
            continue
        for field in merged:
            merged[field] = max(merged[field], int(bucket.get(field) or 0))
    return merged


def call_id_for(runtime: str, session_id: str, native_id: str) -> str:
    return stable_hash(['model_call', runtime, session_id, native_id])


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


def _base_metric(call: dict[str, Any], *, runtime: str, path: Path, repository: str | None) -> dict[str, Any]:
    metric = {k: v for k, v in call.items() if k != 'native_id' and v is not None}
    metric.update({'event': 'model_call', 'agent_runtime': runtime, 'role': 'interactive_session',
                   'source': 'session_ingest', 'ingest_source': str(path)})
    # Precedence: explicit override, then the repository the log itself recorded, then
    # EventStore's env-based attribution. Never the ingesting process's cwd, which is wherever
    # the CLI happened to run and has nothing to do with where the work was done.
    if repository:
        metric['repository'] = repository
    elif not metric.get('repository'):
        metric.pop('repository', None)
    return metric


def _session_aggregates(calls: list[dict[str, Any]], *, runtime: str, root: Path, ingest_source: str,
                        recorded: dict[tuple[str, str, str], dict[str, int]],
                        recorded_by_source: dict[tuple[str, str, str], dict[str, int]]) -> list[dict[str, Any]]:
    """Collapse a session into one row per (session, model), minus what is already recorded.

    Grouping by model rather than by session alone keeps pricing exact when a session switches
    models mid-stream. The amount already recorded is the merge of two independent reconciliation
    keys — `recorded` (by session_id) and `recorded_by_source` (by this file's `ingest_source`) —
    so that neither a drifted session_id nor a session spanning multiple files can cause the same
    tokens to be counted twice. See `_merge_prior`.
    """
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for call in calls:
        key = (str(call['session_id']), str(call.get('model') or ''))
        group = groups.setdefault(key, {field: 0 for field in TOKEN_FIELDS} | {
            'calls': 0, 'session_id': call['session_id'], 'model': call.get('model'),
            'provider': call.get('provider'), 'repository': call.get('repository'),
            'first_ts': call.get('ts'), 'ts': call.get('ts')})
        for field in TOKEN_FIELDS:
            group[field] += int(call.get(field) or 0)
        group['calls'] += 1
        if call.get('ts'):
            group['ts'] = call['ts']
    rows: list[dict[str, Any]] = []
    for (session_id, model), group in groups.items():
        prior = _merge_prior(recorded.get((runtime, session_id, model)),
                             recorded_by_source.get((runtime, ingest_source, model)))
        for field in TOKEN_FIELDS:
            group[field] = max(0, group[field] - prior.get(field, 0))
        group['calls'] = max(0, group['calls'] - prior.get('calls', 0))
        # Emit whenever unrecorded calls remain, even with zero tokens: that row carries
        # covers_calls and lands in the unmetered bucket.
        if group['calls'] <= 0 and all(group[field] <= 0 for field in TOKEN_FIELDS):
            continue
        rows.append({**group, 'native_id': f'{session_id}:{model}:{group["calls"]}'})
    return rows


def ingest_file(path: str | Path, *, runtime: str | None = None, repository: str | None = None,
                state_root: str | Path | None = None, dry_run: bool = False, granularity: str = CALL,
                store: EventStore | None = None, seen: set[str] | None = None,
                recorded: dict[tuple[str, str, str], dict[str, int]] | None = None,
                recorded_by_source: dict[tuple[str, str, str], dict[str, int]] | None = None) -> dict[str, Any]:
    path = Path(path).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f'No session log at {path}')
    if granularity not in (CALL, SESSION):
        raise ValueError(f'Unknown granularity: {granularity}')
    root = Path(state_root) if state_root is not None else default_state_root()
    if path.stat().st_size == 0:
        # An empty log is a session that never produced a call, not a broken file.
        return {'file': str(path), 'runtime': runtime, 'granularity': granularity, 'usage_rows': 0,
                'emitted': 0, 'duplicates': 0, 'zero_usage': 0, 'estimated_cost_usd': 0.0,
                'unpriced_models': {}, 'empty': True, 'dry_run': bool(dry_run)}
    resolved = runtime or detect_runtime(path)
    if resolved not in READERS:
        raise ValueError(f'Unrecognized session log format: {path}')

    calls = READERS[resolved](path)
    already = existing_call_ids(root) if seen is None else seen
    writer = store or EventStore(root)
    summary = {'file': str(path), 'runtime': resolved, 'granularity': granularity,
               'usage_rows': len(calls), 'emitted': 0, 'duplicates': 0, 'zero_usage': 0,
               'estimated_cost_usd': 0.0, 'unpriced_models': {}, 'dry_run': bool(dry_run)}
    if granularity == SESSION:
        prior = recorded_session_totals(root) if recorded is None else recorded
        prior_by_source = recorded_source_totals(root) if recorded_by_source is None else recorded_by_source
        rows = _session_aggregates(calls, runtime=resolved, root=root, ingest_source=str(path),
                                   recorded=prior, recorded_by_source=prior_by_source)
        if not rows:
            summary['duplicates'] = 1 if calls else 0
            return summary
        for row in rows:
            metric = _base_metric(row, runtime=resolved, path=path, repository=repository)
            covered = int(row['calls'])
            metric.update({'granularity': SESSION, 'covers_calls': covered,
                           'call_id': call_id_for(resolved, str(row['session_id']), row['native_id'])})
            metric.pop('calls', None)
            record = writer.preview_metric(**metric) if dry_run else writer.metric(**metric)
            # Keep the in-memory view consistent for the next file in the same batch, for both
            # reconciliation keys: a later file in the same batch may share this session_id (the
            # multi-file case) or, in principle, be re-processed under this same ingest_source.
            session_key = (resolved, str(row['session_id']), str(row.get('model') or ''))
            session_bucket = prior.setdefault(session_key, {field: 0 for field in TOKEN_FIELDS} | {'calls': 0})
            source_key = (resolved, str(path), str(row.get('model') or ''))
            source_bucket = prior_by_source.setdefault(source_key, {field: 0 for field in TOKEN_FIELDS} | {'calls': 0})
            for field in TOKEN_FIELDS:
                session_bucket[field] += int(row.get(field) or 0)
                source_bucket[field] += int(row.get(field) or 0)
            session_bucket['calls'] += covered
            source_bucket['calls'] += covered
            summary['emitted'] += 1
            _tally(summary, record)
        return summary
    for call in calls:
        # A usage block of all zeros is a measurement gap, not free work, so it is still emitted
        # and lands in the unmetered bucket; `_tally` owns the zero_usage counter.
        call_id = call_id_for(resolved, call['session_id'], call['native_id'])
        if call_id in already:
            summary['duplicates'] += 1
            continue
        already.add(call_id)
        metric = _base_metric(call, runtime=resolved, path=path, repository=repository)
        metric.update({'call_id': call_id, 'granularity': CALL})
        record = writer.preview_metric(**metric) if dry_run else writer.metric(**metric)
        summary['emitted'] += 1
        _tally(summary, record)
    return summary


def ingest_paths(paths: Iterable[str | Path], *, runtime: str | None = None, repository: str | None = None,
                 state_root: str | Path | None = None, dry_run: bool = False,
                 granularity: str = CALL, on_file: Callable[[dict[str, Any]], None] | None = None,
                 summarize_files: bool = True) -> dict[str, Any]:
    root = Path(state_root) if state_root is not None else default_state_root()
    store = EventStore(root)
    seen = existing_call_ids(root)
    recorded = recorded_session_totals(root) if granularity == SESSION else None
    recorded_by_source = recorded_source_totals(root) if granularity == SESSION else None
    files: list[dict[str, Any]] = []
    totals = {'emitted': 0, 'duplicates': 0, 'zero_usage': 0, 'usage_rows': 0, 'estimated_cost_usd': 0.0}
    unpriced: dict[str, int] = {}
    zero_token: dict[str, int] = {}
    failures: list[dict[str, str]] = []
    for path in paths:
        try:
            summary = ingest_file(path, runtime=runtime, repository=repository, state_root=root,
                                  dry_run=dry_run, granularity=granularity, store=store, seen=seen,
                                  recorded=recorded, recorded_by_source=recorded_by_source)
        except (FileNotFoundError, ValueError, OSError) as error:
            # One unreadable log must not abandon a bulk backfill part-way through.
            failures.append({'file': str(path), 'error': f'{type(error).__name__}: {error}'})
            continue
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
        'files_processed': len(files) if summarize_files else None,
        'failures': failures,
        'granularity': granularity,
        **totals,
        'unpriced_models': unpriced,
        'zero_token_models': zero_token,
        'dry_run': bool(dry_run),
    }

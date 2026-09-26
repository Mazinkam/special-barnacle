"""Settle, check, append, checkpoint: the coordinated ingest write path, plus the CLI-facing
sweep/status helpers.

Split out of `orchestrator/ingest.py` and `orchestrator/cli.py` (B3, `docs/architecture-review.md`).
`make_ingest_status`/`process_ingest` used to live in `cli.py`; they move here because they are
ingest bookkeeping, not argument parsing, but this module stays below `presentation`/`app`/`cli`
in the B2 layer order, so `process_ingest` cannot call `cli.refresh` (ledger catch-up + dashboard
publish) itself — its caller injects that as the `refresh` parameter (ground rule 4). `cli.py`
keeps a `process_ingest` wrapper that supplies its own `refresh`, so the name (and its
`unittest.mock.patch('orchestrator.cli.refresh', ...)` seam) stays exactly where tests/scripts
already look for it.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable, Iterator, Optional

from ..contract import INGEST_STATUS_FILE, PATH_REDACTION_RE, DEFAULT_SWEEP_INTERVAL_SECONDS, INGEST_STATUS_VALUES
from ..record_batch import BatchAppendError, MAX_BATCH_RECORDS, build_record, settle_streams, write_batch
# CALL/SESSION come from `orchestrator.records`, the one definition of granularity vocabulary
# ('call' / 'session'), and are re-exported here because callers outside this module (tests,
# cli.py) import them from `orchestrator.ingest`.
from ..records import CALL, SESSION
from ..runtime import EventStore, default_state_root, read_json, tail_fingerprint, utc_now, write_json, writer_lock
from . import checkpoint as ckpt
from .checkpoint import COUNT_FIELDS, TOKEN_FIELDS, add_totals, empty_totals, totals_equal
from .ledger import IngestLedger
from .parsers import HUMAIN_TERMINAL, PARSERS, detect_runtime, read_calls
from .reconcile import SourceConflict, _reconcile_source_calls, call_id_for

_PATH_RE = PATH_REDACTION_RE


def _redact_paths(text: str) -> str:
    return _PATH_RE.sub('<path>', text)


#: Bound for the one-line ingest error kept in `ingest_status.json` and echoed on stderr.
INGEST_ERROR_LIMIT = 240
#: Characters of the tail kept when a detail must be shortened. Ingest conflict messages end with the
#: remedy sentence ("... Switching to --granularity session cannot establish identity ..."), so the
#: tail carries the actionable part; the head carries what failed.
_INGEST_ERROR_TAIL = 120


def _bound_error(text: str, limit: int = INGEST_ERROR_LIMIT, tail: int = _INGEST_ERROR_TAIL) -> str:
    """Return `text` if it fits in `limit`, else its head and tail joined by ` ... ` at exactly `limit`.

    A plain `text[:limit]` dropped the closing guidance of a long conflict message, leaving the hook
    and launchd logs with the failure but not the fix. Callers redact paths *before* bounding so a
    cut can never expose a partial path and the bound applies to what is actually printed.
    """
    if len(text) <= limit:
        return text
    joiner = ' ... '
    tail = min(tail, (limit - len(joiner)) // 2)
    return text[:limit - tail - len(joiner)] + joiner + text[-tail:]


class GranularityConflict(ValueError):
    """Legacy aggregate coverage cannot be reconciled safely; the message names the missing evidence."""


def _tally(summary: dict[str, Any], record: dict[str, Any]) -> None:
    """Accumulate cost, separating 'no rate configured' from 'harness reported zero tokens'."""
    cost = record.get('cost_usd')
    if cost is not None:
        summary['estimated_cost_usd'] = round(summary['estimated_cost_usd'] + float(cost), 6)
        return
    from ..pricing import load_pricing, rate_for
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


# --- CLI-facing sweep bookkeeping (moved from cli.py) -------------------------------------------

def make_ingest_status(previous: dict[str, Any], result: dict[str, Any], *,
                       materialization_error: Exception | None = None) -> dict[str, Any]:
    failures = result.get('failures') or []
    status = (
        INGEST_STATUS_VALUES['error'] if materialization_error is not None
        else (INGEST_STATUS_VALUES['partial'] if failures else INGEST_STATUS_VALUES['ok'])
    )
    error = _bound_error(_redact_paths(str(materialization_error))) if materialization_error is not None else None
    if error is None and failures:
        first_detail = str(failures[0].get('error') or 'ingest failed')
        error = _bound_error(_redact_paths(f"{len(failures)} file(s) failed; first: {first_detail}"))

    interval = os.environ.get('HUMAIN_ORCHESTRATOR_INGEST_INTERVAL')
    try:
        sweep_interval_seconds = int(interval) if interval is not None else None
        if sweep_interval_seconds is not None and sweep_interval_seconds < 0:
            sweep_interval_seconds = None
    except (TypeError, ValueError):
        sweep_interval_seconds = None
    if sweep_interval_seconds is None:
        previous_interval = previous.get('sweep_interval_seconds')
        if isinstance(previous_interval, int) and not isinstance(previous_interval, bool) and previous_interval >= 0:
            sweep_interval_seconds = previous_interval
        else:
            sweep_interval_seconds = DEFAULT_SWEEP_INTERVAL_SECONDS

    now = utc_now()
    return {
        'version': 1,
        'last_attempt_at': now,
        'last_success_at': now if status == INGEST_STATUS_VALUES['ok'] else previous.get('last_success_at'),
        'status': status,
        'files_scanned': int(result.get('files_scanned', 0)),
        'emitted': int(result.get('emitted', 0)),
        'failure_count': len(failures) + (1 if materialization_error is not None else 0),
        'error': error,
        'sweep_interval_seconds': sweep_interval_seconds,
    }


def process_ingest(paths: list[Path], *, state_root: Path, runtime: str | None,
                   repository: str | None, dry_run: bool, granularity: str,
                   refresh: Callable[[Path], Any],
                   on_file: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Ingest `paths`, then (unless `dry_run`) write `ingest_status.json` and call `refresh(root)`.

    `refresh` is the caller's ledger catch-up + dashboard publish (`cli.refresh`); this module
    stays below `presentation`/`app`/`cli` in the B2 layer order, so it takes that step as a
    parameter instead of importing it (ground rule 4).
    """
    paths = list(paths)
    root = Path(state_root)
    result = ingest_paths(paths, runtime=runtime, repository=repository, state_root=root,
                          dry_run=dry_run, granularity=granularity, on_file=on_file,
                          summarize_files=len(paths) <= 25)
    result['files_scanned'] = len(paths)
    if not dry_run:
        previous = read_json(root / INGEST_STATUS_FILE, {})
        if not isinstance(previous, dict):
            previous = {}
        status = make_ingest_status(previous, result)
        write_json(root / INGEST_STATUS_FILE, status)
        try:
            refresh(root)
        except Exception as error:
            write_json(root / INGEST_STATUS_FILE,
                       make_ingest_status(previous, result, materialization_error=error))
            raise
    return result

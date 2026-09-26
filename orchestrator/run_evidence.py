from __future__ import annotations
"""Complete-run evidence rollups.

Joins the three authoritative JSONL streams by `run_id` so a run can be judged on what
was actually observed: known versus unmetered cost, token provenance, elapsed wall time
recorded at the run's terminal boundary, verification result, retries/rework, delayed
outcomes, and orchestration overhead versus implementation spend.

Rules that keep the numbers honest:
- A model call, a verification marker, and a routing decision are counted separately;
  they are never pooled into one "samples" figure.
- A verification marker is any row that *attests* a verdict (`records.verification_evidence` at
  `ATTESTED` strength: `event: task_verified`/`task_failed`, or an outcomes-style verdict field).
  The verdict itself is read through `records`, so a `task_verified` row whose `result` says
  `fail` (how `engine.Engine.verify_task` reports a failed gate) fails the run here exactly as
  it fails the task on the dashboard and in `history`. A dispatch `result: 'pass'` on a
  `model_call` row is the subprocess exit code, not a verdict, and never makes a run `passed`.
- Task verification is joined per `(run_id, task_id)` across *both* the metrics and outcomes
  streams into one attempt timeline, and the chronologically latest attested verdict for the task
  decides (`_attempt_order`, the same rule `history` applies): a later attested pass is a retry
  that verified, a later attested `outcome: 'fail'` is a task that failed after its gate row.
  Two verdicts at the same instant resolve to the failure, and undated rows sort before every
  dated one and fail among themselves, so a missing timestamp can never upgrade a verdict.
  Run-scoped outcomes (`verification_scope: 'run'`, the bridge's `${run}-qa` gate row, the
  terminal `run-complete`/`run-failed` summaries) decide the run verdict once and are never
  counted as a verified or failed *task*. Outcomes rows joined this way are verdicts only: they
  never add a call, a cost, tokens, or a duration.
- Missing cost, tokens, or duration is reported as missing (`None` / unmetered counts),
  never as zero. A call whose cost is "estimated" from zero tokens at $0 measured nothing
  and is unmetered (`economics.cost_class` is the single classifier shared with the
  dashboard cards, so run rows and summary cards always agree). Elapsed time is only taken
  from explicit start/finish/elapsed fields
  written at the terminal boundary; record `ts` values alone never fabricate a duration,
  and `elapsed_source` is whatever the writer declared (`'reported'` when it declared none).
- Interactive-session ingestion is excluded even when it carries a `run_id`, and never
  establishes a run on its own.
- A run's status is `completed`/`failed`/`cancelled` when a terminal event/outcome names it so,
  else `incomplete` — UNLESS `classify_liveness` can prove, from the `run_started` ownership
  evidence (pid/hostname/process-start identity), that the owning process is confirmed gone, in
  which case it is `interrupted`. This is read-time only (`summarize_runs` never rewrites
  `events.jsonl`) and never derived from age alone: a run with no ownership evidence, or whose
  evidence names a live or unverifiable process, stays `incomplete` no matter how old it is.
- Overhead is every metered call outside `IMPLEMENTATION_ROLES` (lead, architect, review,
  QA, triage...). This is broader than `economics.orchestration_overhead`, which counts a
  fixed set of coordination roles; the dashboard labels the two differently.
- Runs are ordered by the earliest `ts` observed across the three streams (sequence only,
  never duration), so "last N runs" means most recent, not last-appended stream.
- Everything derived from observed metrics is labelled `actual`; a flat-model repricing
  of the observed tokens is labelled `counterfactual` and never yields a savings delta
  unless every call in the run is priced under both views.
"""
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable, Optional
import json
import math
import os
import socket

from . import records
from .economics import REPORTED, ESTIMATED, UNMETERED, cost_class, has_reported_tokens, is_call_row, is_session_ingest, row_cost, unique_records

ACTUAL = 'actual'
COUNTERFACTUAL = 'counterfactual'
TERMINAL_OUTCOME_TASKS = {'run-complete': 'completed', 'run-failed': 'failed', 'run-cancelled': 'cancelled'}
TERMINAL_EVENTS = {'run_completed': 'completed', 'run_failed': 'failed', 'run_cancelled': 'cancelled'}
IMPLEMENTATION_ROLES = {'worker', 'implementer', 'complex_implementer', 'implementation_fast', 'implementation_strong'}
BAD_OUTCOME_KEYS = ('reopened', 'regression', 'rollback', 'human_correction', 'incident', 'major_rewrite')


def _parse_ts(value: Any) -> datetime | None:
    if not value: return None
    try: return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except Exception: return None


def _int_or_none(value: Any) -> int | None:
    if value is None or value == '': return None
    try: return int(float(value))
    except (TypeError, ValueError): return None


def _usd_or_none(value: Any) -> float | None:
    """A finite USD amount, or None when absent/malformed — never a silent 0."""
    if value is None or value == '' or isinstance(value, bool): return None
    try: amount = float(value)
    except (TypeError, ValueError): return None
    return amount if math.isfinite(amount) else None


SPEND_CAP_EVENT = 'spend_cap_exceeded'


def spend_cap_breach(event: dict) -> dict[str, Any]:
    """Normalize one bridge `spend_cap_exceeded` event (bridge/extensions/orchestrator/index.ts).

    `cost_usd` is the dispatch's running cost including its own subagents; `nested_cost_usd` is the
    subagent part. Derived fields are None when an input is missing rather than computed from 0.
    """
    cap = _usd_or_none(event.get('cap_usd'))
    cost = _usd_or_none(event.get('cost_usd'))
    nested = _usd_or_none(event.get('nested_cost_usd'))
    return {
        'run_id': None if event.get('run_id') is None else str(event.get('run_id')),
        'task_id': None if event.get('task_id') is None else str(event.get('task_id')),
        'capability': str(event.get('capability') or 'unknown'), 'model': str(event.get('model') or 'unknown'),
        'action': str(event.get('action') or 'unknown'), 'ts': event.get('ts'),
        'cap_usd': cap, 'cost_usd': cost, 'nested_cost_usd': nested,
        'over_usd': (cost - cap) if cost is not None and cap is not None else None,
        'over_ratio': (cost / cap) if cost is not None and cap else None,
        'nested_share': (nested / cost) if nested is not None and cost else None,
    }


def _role(row: dict) -> str:
    return str(row.get('role') or row.get('capability_class') or 'unknown')


def _attested_verdict(row: dict) -> str | None:
    """The row's attested verdict (`records.VERIFIED`/`FAILED`/`PARTIAL`), or None if it attests nothing.

    One vocabulary: the same `records.verification_evidence` the dashboard and `history` read, so the
    engine's `task_verified` + `result: 'fail'` row is a failure in all three places and a bare
    `task_verified` is a success in all three.
    """
    state, strength = records.verification_evidence(row)
    return state if strength == records.ATTESTED else None


def _is_verification_row(row: dict) -> bool:
    return _attested_verdict(row) is not None


def _verification_passed(row: dict) -> bool:
    return _attested_verdict(row) == records.VERIFIED


def _is_run_scoped(row: dict) -> bool:
    """A run-gate outcome row, never a task attempt: the terminal summaries, and the QA gate the bridge
    writes as `${run}-qa` with `verification_scope: 'run'` (legacy rows lack the marker; the suffix
    is the same contract). These feed the run-level verdict exactly once."""
    tid = str(row.get('task_id') or '')
    return row.get('verification_scope') == 'run' or tid in TERMINAL_OUTCOME_TASKS or tid.endswith('-qa')


#: Phase 3 opt-in Forge live-QA verification stage. Its outcomes row carries `task_id` ending in
#: `-live-qa-stage`, deliberately NOT `-qa`, so `_is_run_scoped` never mistakes it for the bridge's
#: generic `${run}-qa` gate row (see `model_comparison._is_run_scoped_outcome` for the mirrored
#: check on that side).
LIVE_QA_SCOPE = 'live_qa'


def _is_live_qa_scoped(row: dict) -> bool:
    return row.get('verification_scope') == LIVE_QA_SCOPE


def _live_qa_evidence(o: dict) -> dict[str, Any]:
    """Normalize one run's live-QA outcome row into its own evidence item.

    Deliberately NOT joined into the ordinary per-task `verifications`/`outcome_tasks` population:
    a passed live-QA stage must not by itself flip a run's generic verdict to 'passed' when the
    run-complete/generic gate says otherwise, and an 'unavailable' stage (the runner could not run)
    must never read as verified — it is unverified evidence, not a quality verdict. `records.
    verification_evidence` already agrees: 'unavailable' is not a recognised verdict spelling, so it
    resolves to `NO_VERIFICATION` rather than a pass or a fail, exactly the reading this stage needs.
    """
    findings = o.get('findings')
    artifacts = o.get('artifacts')
    return {
        'outcome': o.get('outcome'),
        'evidence_status': o.get('evidence_status'),
        'verdict': o.get('live_qa_verdict'),
        'tested_revision': o.get('tested_revision'),
        'tested_tree': o.get('tested_tree'),
        'checkpoint': o.get('checkpoint'),
        'session_id': o.get('session_id'),
        'findings_count': len(findings) if isinstance(findings, list) else None,
        'artifacts_count': len(artifacts) if isinstance(artifacts, list) else None,
        'required': o.get('required'),
        'outcome_finality': o.get('outcome_finality'),
    }


def _checks_factually_verified(checks: list) -> bool:
    """At least one parsed QA check actually ran to a `pass`/`fail` verdict — not merely `skipped`
    or `unavailable` (Phase 1 review finding T8).

    Independently re-derived here from the `checks` list itself, never trusted from a bridge-
    supplied `evidence_status` string alone (the same "a producer's claim is not proof" rule T3
    applies to `nested_rows_emitted`): an empty list, or a list where every entry is
    `skipped`/`unavailable`, proves nothing was actually executed — a QA dispatch that exits 0
    without running (or fully skipping/erroring on) every check it named is not a factually
    verified gate, whatever the exit code says. This changes NO gate control flow — `passed`,
    `outcome`, and the run verdict computed from them are untouched — it only changes what
    `evidence_coverage` reports as actually-verified evidence versus merely-claimed evidence.
    """
    return any(isinstance(c, dict) and c.get('result') in ('pass', 'fail') for c in checks)


def _attempt_order(row: dict):
    """Sort key for a task's attested attempts: by instant, with ties — and undated rows — failing.

    Sorted ascending, the last row is the deciding attempt. A dated pass after a dated failure is a
    retry that verified; two verdicts at the same instant put the failure last. Rows without a
    parseable `ts` sort before every dated row, so a legacy undated pass never supersedes a dated
    failure and, among undated rows, the failure wins whatever their stream order. Mirrors
    `history._verification_order`; over-counting verified tasks is the error this exists to prevent.
    """
    dt = _parse_ts(row.get('ts'))
    if dt is None: dt = datetime.min.replace(tzinfo=timezone.utc)
    elif dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
    return (dt, not _verification_passed(row))


def _terminal_fields(record: dict) -> dict[str, Any]:
    """Explicit time fields written by a runtime at its run-terminal boundary."""
    return {'started_at': record.get('started_at'), 'finished_at': record.get('finished_at'),
            'elapsed_ms': _int_or_none(record.get('elapsed_ms')), 'elapsed_source': record.get('elapsed_source') or None}


def _elapsed(terminal: dict[str, Any] | None) -> tuple[int | None, str]:
    if not terminal: return None, 'unknown'
    if terminal.get('elapsed_ms') is not None: return max(0, int(terminal['elapsed_ms'])), str(terminal.get('elapsed_source') or 'reported')
    start, finish = _parse_ts(terminal.get('started_at')), _parse_ts(terminal.get('finished_at'))
    if start and finish: return max(0, int((finish - start).total_seconds() * 1000)), 'timestamps'
    return None, 'unknown'


LivenessResult = Optional[bool]  # True = alive (or presumed alive), False = confirmed gone, None = unknown
LivenessCheck = Callable[[dict[str, Any]], LivenessResult]
INTERRUPTED = 'interrupted'


#: `os.kill` raises `OverflowError` (CPython) for a pid outside the platform's signed-int range
#: before it ever reaches the kernel; a pid outside this bound cannot possibly name a real process,
#: so it is treated exactly like any other malformed pid — unknown, never a crash (Phase 1 review
#: finding S6).
_MAX_PLAUSIBLE_PID = 2 ** 31 - 1


def _local_process_alive(pid: Any) -> LivenessResult:
    """Best-effort, dependency-free liveness probe for a pid on THIS host. Never raises: any
    error we cannot interpret (permission denied on the syscall itself, a non-integer pid, a pid
    outside the platform's plausible range, ...) reports `None` (unknown), never `False`. Only a
    definitive `ProcessLookupError` (ESRCH) is read as "confirmed gone" — `os.kill(pid, 0)` sends
    no signal, it only asks the kernel whether the pid exists and this process may signal it.
    """
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0 or pid > _MAX_PLAUSIBLE_PID:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # pid exists (owned by someone else); presume alive rather than guess dead
    except (OSError, OverflowError, ValueError):
        # `OverflowError`/`ValueError` should be unreachable given the range check above, but a
        # future platform-specific `os.kill` behaviour change must still degrade to "unknown"
        # rather than propagate out of a read-time classifier (Phase 1 review finding S6).
        return None
    return True


def default_liveness_check(ownership: dict[str, Any]) -> LivenessResult:
    """Default `LivenessCheck`: only ever confirms a run's owning process is gone when the
    ownership evidence names THIS host (a pid is meaningless on a different machine) and the
    local `os.kill` probe comes back ESRCH. A pid that IS alive on this host is presumed to
    still be the same process — this default has no independent way to confirm the recorded
    `process_started_at_ms` against the live process's actual start time without an extra
    dependency (psutil) or a platform-specific `/proc` read, so a same-pid-different-process
    (pid reuse) case is intentionally left `None`/alive here rather than guessed at; callers
    that can supply a more precise check should inject one instead of relying on this default.
    """
    pid = ownership.get('pid')
    host = ownership.get('hostname')
    if not host or not isinstance(host, str) or host != socket.gethostname(): return None
    return _local_process_alive(pid)


def classify_liveness(ownership: dict[str, Any] | None, *, liveness_check: LivenessCheck = default_liveness_check) -> str | None:
    """Restart reconciliation for a run that has no terminal event.

    Returns `'interrupted'` only when `liveness_check` returns durable evidence (`False`) that
    the run's recorded owning process is confirmed gone; returns `None` (caller keeps the
    existing status, i.e. `'incomplete'`) for every other case — no ownership evidence at all,
    evidence naming a different host, or a pid that is still alive (or whose liveness is
    merely unknown). This is a read-time classification only: it never rewrites `events.jsonl`,
    and a run is never reclassified by age alone, which is the bug this replaces (`104/193`
    runs all read as the same undifferentiated `'incomplete'` regardless of whether the owning
    process was still running).
    """
    if not ownership: return None
    if liveness_check(ownership) is False: return INTERRUPTED
    return None


def _note_json(note: Any) -> dict:
    if isinstance(note, dict): return note
    if isinstance(note, str) and note.startswith('{'):
        try:
            obj = json.loads(note)
            return obj if isinstance(obj, dict) else {}
        except Exception: return {}
    return {}


def _counterfactual(calls: list[dict], baseline_model: str, pricing: dict[str, Any] | None) -> dict[str, Any]:
    from .pricing import estimate_cost_usd, load_pricing
    pricing = load_pricing() if pricing is None else pricing
    total = 0.0; priced = 0; unpriced = 0
    for row in calls:
        est = estimate_cost_usd(model=baseline_model, input_tokens=row.get('input_tokens'), output_tokens=row.get('output_tokens'),
                                cached_input_tokens=row.get('cached_input_tokens'), cache_write_tokens=row.get('cache_write_tokens'), pricing=pricing)
        if est is None: unpriced += 1
        else: total += float(est['cost_usd']); priced += 1
    metered_actual = sum(1 for r in calls if cost_class(r) != UNMETERED)
    actual_known = sum(row_cost(r) for r in calls if cost_class(r) != UNMETERED)
    comparable = bool(calls) and unpriced == 0 and metered_actual == len(calls)
    reason = None
    if not calls: reason = 'no calls observed'
    elif not comparable:
        gaps = []
        if unpriced: gaps.append(f'{unpriced} call(s) lack tokens or a baseline rate')
        if metered_actual != len(calls): gaps.append(f'{len(calls) - metered_actual} actual call(s) unmetered')
        reason = 'incomplete coverage: ' + '; '.join(gaps)
    return {
        'provenance': COUNTERFACTUAL, 'baseline_model': baseline_model, 'basis': 'observed tokens repriced at one flat model; not an observed cohort',
        'cost_usd': total if priced else None, 'priced_calls': priced, 'unpriced_calls': unpriced,
        'comparable': comparable, 'delta_usd': (actual_known - total) if comparable else None, 'reason': reason,
    }


def summarize_runs(metrics: list[dict], events: list[dict], outcomes: list[dict], *, baseline_model: str | None = None,
                   pricing: dict[str, Any] | None = None, liveness_check: LivenessCheck = default_liveness_check) -> list[dict]:
    """One evidence row per run_id joined across metrics, events, and outcomes."""
    calls: dict[str, list[dict]] = defaultdict(list)
    verifications: dict[str, list[dict]] = defaultdict(list)
    decisions: dict[str, int] = defaultdict(int)
    other_rows: dict[str, int] = defaultdict(int)
    excluded: dict[str, int] = defaultdict(int)
    run_ids: list[str] = []
    seen: set[str] = set()
    first_ts: dict[str, str] = {}

    def touch(rid: Any, ts: Any = None) -> str | None:
        """Register a run seen in a real stream. `ts` orders runs; it is never used as a duration."""
        if rid is None: return None
        rid = str(rid)
        if rid not in seen: seen.add(rid); run_ids.append(rid)
        if ts:
            ts = str(ts)
            if rid not in first_ts or ts < first_ts[rid]: first_ts[rid] = ts
        return rid

    for row in unique_records(metrics):
        rid = row.get('run_id')
        if rid is None: continue
        # Session ingest never establishes a run; the count is only reported if a real stream does.
        if is_session_ingest(row): excluded[str(rid)] += 1; continue
        rid = touch(rid, row.get('ts'))
        if row.get('event') == 'adaptive_route_decision': decisions[rid] += 1
        elif is_call_row(row):
            calls[rid].append(row)
            if _is_verification_row(row): verifications[rid].append(row)
        elif _is_verification_row(row): verifications[rid].append(row)
        else: other_rows[rid] += 1

    started_events: dict[str, dict] = {}
    terminal: dict[str, dict[str, Any]] = {}
    status: dict[str, str] = {}
    retry_dispatches: dict[str, set[str]] = defaultdict(set)
    rework_events: dict[str, int] = defaultdict(int)
    cap_hits: dict[str, list[dict]] = defaultdict(list)
    for e in unique_records(events):
        rid = e.get('run_id')
        if rid is None: continue
        rid = touch(rid, e.get('ts')); kind = e.get('event')
        if kind == 'run_started': started_events.setdefault(rid, e)
        elif kind in TERMINAL_EVENTS:
            status[rid] = TERMINAL_EVENTS[kind]; terminal[rid] = {**terminal.get(rid, {}), **{k: v for k, v in _terminal_fields(e).items() if v is not None}}
        elif kind == 'dispatch_started' and e.get('retry_of'): retry_dispatches[rid].add(str(e.get('task_id') or e.get('retry_of')))
        elif kind in {'rework', 'decision_invalidated', 'merge_conflict_resolution'}: rework_events[rid] += 1
        elif kind == SPEND_CAP_EVENT: cap_hits[rid].append(spend_cap_breach(e))

    verification: dict[str, str] = {}
    summary_note: dict[str, dict] = {}
    delayed_bad: dict[str, bool] = defaultdict(bool)
    outcome_tasks: dict[str, set[str]] = defaultdict(set)
    verification_evidence: dict[str, dict[str, Any]] = {}
    live_qa_evidence: dict[str, dict[str, Any]] = {}
    for o in unique_records(outcomes):
        rid = o.get('run_id')
        if rid is None: continue
        rid = touch(rid, o.get('ts')); tid = str(o.get('task_id') or '')
        if any(o.get(k) for k in BAD_OUTCOME_KEYS): delayed_bad[rid] = True
        if tid in TERMINAL_OUTCOME_TASKS:
            status[rid] = TERMINAL_OUTCOME_TASKS[tid]
            terminal[rid] = {**terminal.get(rid, {}), **{k: v for k, v in _terminal_fields(o).items() if v is not None}}
            summary_note[rid] = _note_json(o.get('note'))
            continue
        if _is_live_qa_scoped(o):
            # Its own evidence item (see `_live_qa_evidence`), never joined into the ordinary
            # per-task verification population below: a live-QA verdict alone must not move the
            # run's generic `verification`/`verified_tasks` result.
            live_qa_evidence[rid] = _live_qa_evidence(o)
            continue
        outcome_tasks[rid].add(tid)
        if tid.endswith('-qa') or o.get('verification') is not None:
            passed = o.get('verification') if o.get('verification') is not None else o.get('outcome') == 'verified'
            verification[rid] = 'passed' if passed else 'failed'
        # Factual verification evidence (Phase 1 item 5): the bridge's run-level QA gate row
        # (`${run}-qa`, `verification_scope: 'run'`) is the one place `checks`/`tested_revision`/
        # `review_verdicts` are recorded today. Captured once per run from that row; never derived
        # or guessed from anything else.
        if _is_run_scoped(o) and tid.endswith('-qa'):
            checks = o.get('checks') if isinstance(o.get('checks'), list) else []
            verification_evidence[rid] = {
                'checks': checks,
                'checks_unavailable': o.get('checks_unavailable') if isinstance(o.get('checks_unavailable'), list) else [],
                'check_commands': o.get('check_commands'),
                'tested_revision': o.get('tested_revision'),
                'tested_revision_dirty': o.get('tested_revision_dirty'),
                'review_verdicts': o.get('review_verdicts') if isinstance(o.get('review_verdicts'), list) else [],
                'artifacts': o.get('artifacts') if isinstance(o.get('artifacts'), list) else [],
                'outcome_finality': o.get('outcome_finality'),
                # Phase 1 review finding T8: the bridge's own claim (`bridge/extensions/orchestrator/
                # index.ts`'s `qaVerificationOutcomeFor`), read defensively — and, below,
                # independently re-checked against the `checks` list itself rather than trusted
                # alone. Gate control flow (`outcome`/`verification`) is unchanged either way.
                'evidence_status': o.get('evidence_status') if isinstance(o.get('evidence_status'), str) else None,
                'checks_factually_verified': _checks_factually_verified(checks),
            }
        # An ordinary task outcome is an attested verdict for `(run_id, task_id)`: join it into the same
        # attempt timeline as the metrics-side `task_verified` rows. Run-scoped gate rows were counted
        # above as the run verdict and must not reappear as a task. This adds a verdict, never a call.
        if tid and not _is_run_scoped(o) and _is_verification_row(o): verifications[rid].append(o)

    # Earliest observed ts orders runs (stable on first-seen order for ties or missing ts).
    order = sorted(range(len(run_ids)), key=lambda i: (first_ts.get(run_ids[i]) is None, first_ts.get(run_ids[i]) or '', i))
    result = []
    for rid in (run_ids[i] for i in order):
        rows = calls[rid]
        metered = [r for r in rows if cost_class(r) != UNMETERED]
        reported = sum(row_cost(r) for r in rows if cost_class(r) == REPORTED)
        estimated = sum(row_cost(r) for r in rows if cost_class(r) == ESTIMATED)
        known = reported + estimated if metered else None
        overhead_by_role: dict[str, float] = defaultdict(float)
        implementation = 0.0
        for r in metered:
            role = _role(r)
            if role in IMPLEMENTATION_ROLES: implementation += row_cost(r)
            else: overhead_by_role[role] += row_cost(r)
        overhead = sum(overhead_by_role.values()) if metered else None
        durations = [_int_or_none(r.get('duration_ms')) for r in rows]
        known_durations = [d for d in durations if d is not None]
        tokens_known = sum(1 for r in rows if has_reported_tokens(r))
        # Latest attested attempt per task decides; ties and undated rows fail (`_attempt_order`).
        timeline = sorted((v for v in verifications[rid] if v.get('task_id') is not None), key=_attempt_order)
        latest_verification = {str(v['task_id']): v for v in timeline}
        verified_tasks = {tid for tid,v in latest_verification.items() if _verification_passed(v)}
        retries = len(retry_dispatches[rid]) or sum(1 for r in rows if _int_or_none(r.get('retry')))
        note = summary_note.get(rid, {})
        if retries == 0 and _int_or_none(note.get('retries')): retries = int(note['retries'])
        verdict = verification.get(rid)
        generic_verdict = verdict
        task_level_failed = any(not _verification_passed(v) for v in latest_verification.values())
        terminal_says_failed = note.get('verification_passed') is False
        # T2: a terminal run-complete `verification_passed: false` must never be shadowed by an
        # earlier-set generic `*-qa` PASS row -- it always forces 'failed', not merely when
        # `verdict` was still unset. (Reordered from the original if/elif so the pre-override
        # `generic_verdict`/`task_level_failed` flags above stay available to the live-QA T3
        # correction below; the net verdict computed here is unchanged from before.)
        if verdict is None and note.get('verification_passed') is not None: verdict = 'passed' if note['verification_passed'] else 'failed'
        if task_level_failed: verdict = 'failed'
        if verdict is None and verified_tasks: verdict = 'passed'
        if terminal_says_failed: verdict = 'failed'
        # T2: the live-QA stage's own outcome has run-verdict AUTHORITY over a passed generic
        # reading (never the reverse: a passed live-QA stage must not flip a failed/incomplete
        # generic verdict to passed -- that is still handled entirely by `_live_qa_evidence`
        # staying out of `verifications`/`outcome_tasks` above). A `fail` live-QA verdict always
        # wins; a REQUIRED `unavailable` live-QA verdict reads as unverified ('unknown', the same
        # spelling used everywhere else in this function for "no recognized claim"), unless the
        # run is already 'failed' for an unrelated (independently corroborated) reason.
        live_qa = live_qa_evidence.get(rid)
        if live_qa:
            if live_qa.get('verdict') == 'fail':
                verdict = 'failed'
            elif live_qa.get('verdict') == 'unavailable' and live_qa.get('required'):
                # T3: a required live-QA stage that never produced evidence is unverified, never a
                # pass. When the ONLY reason this run's verdict reads 'failed' is the terminal
                # summary's bare `verification_passed: false` -- NOT corroborated by an
                # independently failed generic `*-qa` gate row or a task-level verification
                # failure -- that terminal false is presumed to be reporting exactly this
                # required-but-unavailable live-QA stage rather than a separate quality failure,
                # so the run reads 'unknown' (unverified) here rather than 'failed'. A genuinely
                # corroborated failure (`generic_verdict == 'failed'` or `task_level_failed`) still
                # wins and keeps this 'failed'; a plain 'unavailable' with no terminal false at all
                # was already 'unknown' via the `verdict != 'failed'` half of this condition.
                only_terminal_false_caused_failure = (
                    terminal_says_failed and generic_verdict != 'failed' and not task_level_failed
                )
                if verdict != 'failed' or only_terminal_false_caused_failure:
                    verdict = 'unknown'
        term = terminal.get(rid)
        elapsed_ms, elapsed_source = _elapsed(term)
        raw_status = status.get(rid, 'incomplete')
        # Restart reconciliation: a run with no terminal event is reclassified 'interrupted'
        # only when the run_started ownership evidence proves the owning process is gone —
        # never merely because the run is old, and never for a run that has no ownership
        # evidence at all (historical runs predating this tracking stay 'incomplete').
        run_status = raw_status if raw_status != 'incomplete' else (classify_liveness(started_events.get(rid), liveness_check=liveness_check) or raw_status)
        result.append({
            'run_id': rid, 'cost_provenance': ACTUAL, 'status': run_status,
            'started_at': (term or {}).get('started_at') or started_events.get(rid, {}).get('started_at'),
            'finished_at': (term or {}).get('finished_at'), 'elapsed_ms': elapsed_ms, 'elapsed_source': elapsed_source,
            'call_rows': len(rows), 'metered_calls': len(metered), 'unmetered_calls': len(rows) - len(metered),
            'cost_coverage': (len(metered) / len(rows)) if rows else None, 'cost_complete': bool(rows) and len(metered) == len(rows),
            'cost_known_usd': known, 'cost_reported_usd': reported if metered else None, 'cost_estimated_usd': estimated if metered else None,
            'overhead_cost_usd': overhead, 'implementation_cost_usd': implementation if metered else None,
            'overhead_ratio': (overhead / known) if known else None, 'overhead_by_role': dict(overhead_by_role),
            'tokens_known_calls': tokens_known, 'tokens_missing_calls': len(rows) - tokens_known,
            'input_tokens': sum(_int_or_none(r.get('input_tokens')) or 0 for r in rows) if tokens_known else None,
            'output_tokens': sum(_int_or_none(r.get('output_tokens')) or 0 for r in rows) if tokens_known else None,
            'cached_input_tokens': sum(_int_or_none(r.get('cached_input_tokens')) or 0 for r in rows) if tokens_known else None,
            'cache_write_tokens': sum(_int_or_none(r.get('cache_write_tokens')) or 0 for r in rows) if tokens_known else None,
            'dispatch_duration_ms_total': sum(known_durations) if known_durations else None, 'duration_missing_calls': len(rows) - len(known_durations),
            'tasks': len({str(r.get('task_id')) for r in rows if r.get('task_id') is not None}),
            'roles': sorted({_role(r) for r in rows}), 'retries': retries, 'rework_events': rework_events[rid],
            'verification': verdict or 'unknown', 'verification_rows': len(verifications[rid]), 'verified_tasks': len(verified_tasks),
            'decision_rows': decisions[rid], 'other_metric_rows': other_rows[rid], 'excluded_session_ingest_rows': excluded[rid],
            'spend_cap_hit': bool(cap_hits[rid]), 'spend_cap_hits': cap_hits[rid],
            'delayed_bad_outcome': delayed_bad[rid] if (outcome_tasks[rid] or delayed_bad[rid]) else None,
            'counterfactual': _counterfactual(rows, baseline_model, pricing) if baseline_model else None,
            # Factual verification evidence (Phase 1 item 5), or None when this run's QA gate
            # (if it ran at all) predates this field set. Never backfilled/guessed.
            'verification_evidence': verification_evidence.get(rid),
            # T1: the `live_qa` KEY itself is present only for a run that actually has a
            # `verification_scope: 'live_qa'` outcome row -- never added (not even as `None`) for
            # the vast majority of runs that never requested live QA, preserving the exact
            # pre-Phase-3 key set for them.
            **({'live_qa': live_qa_evidence[rid]} if rid in live_qa_evidence else {}),
        })
    return result


def evidence_coverage(runs: list[dict]) -> dict[str, Any]:
    """Coverage by runs (not rows): how many runs can honestly be priced, timed, and verified."""
    n = len(runs)
    fully_priced = sum(1 for r in runs if r.get('cost_complete'))
    with_elapsed = sum(1 for r in runs if r.get('elapsed_ms') is not None)
    with_verification = sum(1 for r in runs if r.get('verification') in {'passed', 'failed'})
    # Factual verification evidence coverage (Phase 1 item 5). `evidence` is None for a run whose
    # QA gate (if any ran) predates these fields, or that had no run-scoped QA gate row at all —
    # both read as "not observed", never as zero/failed. This never changes what makes a run
    # verified; it only reports how much of the evidence behind that verdict is on record.
    evidenced = [r.get('verification_evidence') for r in runs if r.get('verification_evidence')]
    with_tested_revision = sum(1 for e in evidenced if e.get('tested_revision'))
    with_check_commands = sum(1 for e in evidenced if e.get('check_commands'))
    with_review_verdict = sum(1 for e in evidenced if e.get('review_verdicts'))
    with_unavailable_checks = sum(1 for e in evidenced if e.get('checks_unavailable'))
    # Phase 1 review finding T8: an exit-0 QA dispatch whose checks are ALL `skipped`/`unavailable`
    # (or that reported no checks at all) is not factually verified evidence, however the gate
    # verdict reads — that verdict is untouched by this count, which exists only so this gap in
    # what a `passed` verdict actually proves is visible instead of silently reading as "verified".
    with_factually_verified_checks = sum(1 for e in evidenced if e.get('checks_factually_verified'))
    return {
        'cost_provenance': ACTUAL, 'runs': n,
        'runs_completed': sum(1 for r in runs if r.get('status') == 'completed'),
        'runs_failed': sum(1 for r in runs if r.get('status') == 'failed'),
        'runs_cancelled': sum(1 for r in runs if r.get('status') == 'cancelled'),
        # Restart-reconciled: no terminal event, but ownership evidence proved the owning
        # process is gone. Disjoint from `runs_incomplete` below (never both).
        'runs_interrupted': sum(1 for r in runs if r.get('status') == INTERRUPTED),
        # Still genuinely unknown: no terminal event, and either no ownership evidence or the
        # owning process could not be shown to be gone. Never inferred from age alone.
        'runs_incomplete': sum(1 for r in runs if r.get('status') == 'incomplete'),
        'runs_fully_priced': fully_priced, 'runs_with_elapsed': with_elapsed, 'runs_with_verification': with_verification,
        'priced_run_coverage': (fully_priced / n) if n else None, 'duration_coverage': (with_elapsed / n) if n else None,
        'verification_coverage': (with_verification / n) if n else None,
        'call_rows': sum(int(r.get('call_rows') or 0) for r in runs), 'unmetered_calls': sum(int(r.get('unmetered_calls') or 0) for r in runs),
        'cost_known_usd': sum(float(r.get('cost_known_usd') or 0) for r in runs),
        'elapsed_ms_total_known': sum(int(r['elapsed_ms']) for r in runs if r.get('elapsed_ms') is not None) if with_elapsed else None,
        'runs_with_verification_evidence': len(evidenced),
        'runs_with_tested_revision': with_tested_revision,
        'runs_with_check_commands': with_check_commands,
        'runs_with_review_verdict': with_review_verdict,
        'runs_with_unavailable_checks_listed': with_unavailable_checks,
        'runs_with_factually_verified_checks': with_factually_verified_checks,
        'factually_verified_checks_coverage': (with_factually_verified_checks / n) if n else None,
        'tested_revision_coverage': (with_tested_revision / n) if n else None,
        'check_commands_coverage': (with_check_commands / n) if n else None,
        'review_verdict_coverage': (with_review_verdict / n) if n else None,
    }

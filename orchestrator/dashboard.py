"""Dashboard data assembly and rendering.

Every number here is read by a human who will act on it, so this module obeys four rules. Each one
is a fix for a metric that was arithmetically derived and semantically false:

* **Per-call statistics run over `records.is_per_call_cost_row` only.** The headline defect was
  `p99/p50 tail ratio 4053665000.0x`: `costs` spanned every orchestrated row, including the ~46% that
  carry no `cost_usd` at all (`route_executed`, `adaptive_route_decision`), so p50 was `$0.0000` and
  the card rendered `p99 x 10^9` via `max(1e-9, p50)`. A ratio with a zero denominator does not
  exist; it is `records.NO_DATA`, and it is never divided by a floor constant.
* **One missing-data contract.** `x / y if y else 0` claimed a measurement nobody made. Anything
  without samples is `records.NO_DATA`, which serializes to `null` through `records.to_json` /
  `records.json_default` and renders as an em-dash. A measured `0` stays a `0` end to end.
* **`not instrumented` is a renderable state.** Six cards showed a confident `0` for fields with no
  producer in this repository (`review_wait_ms`, `context_packet*`, `decision_invalidated`, merge
  conflicts, `shadow_review`). `records.is_instrumented` decides; `INSTRUMENTATION` below maps each
  rendered key to the field whose absence it reports.
* **Rows are not calls.** `len(rows)` understated interactive volume 13-fold (609 session aggregates
  carry `covers_calls` summing ~85k). Row counts and call counts are separate, separately labelled
  fields so nobody can divide a cost by the wrong denominator.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
from typing import Any

from . import records
from .economics import (ESTIMATED, REPORTED, UNMETERED, cost_attribution, cost_class,
                        cost_distribution, fanout_rework, is_call_row, is_session_ingest,
                        orchestration_overhead, quantile, row_cost, waste_cost)
from .features import feature_inventory
from .history import build_route_stats
from .outcomes import outcome_summary
from .run_evidence import summarize_runs, evidence_coverage
from .records import NO_DATA
from .runtime import default_state_root, load_jsonl, read_json
from .verification import flaky_stats

#: A p99/p50 ratio computed from a handful of calls describes the handful, not the workload. Below
#: this many per-call samples the tail ratio is `NO_DATA` rather than a number readers would trust.
MIN_TAIL_SAMPLES = 20

#: Rendered key -> the telemetry field whose absence that key reports. `records.is_instrumented`
#: answers whether a producer exists, so this module never re-derives that judgement; the mapping
#: only records *which* field each card depends on. Keys absent from this map render a plain
#: em-dash when they are `NO_DATA` (no measurement yet), which is the right answer for a field that
#: is instrumented and simply has no samples in this stream.
INSTRUMENTATION: dict[str, str] = {
    'review_wait_p90_s': 'review_wait_ms',
    'context_miss_rate': 'context_packet',
    'fanout_rework': 'decision_invalidated',
    'conflicts': 'merge_conflict',
    'shadow_false_pass_rate': 'shadow_review',
    'shadow_over_reject_rate': 'shadow_review',
    # `quality_evidence_score` has a producer (`Engine.verify_task`) but no live run has ever called
    # it, so it is reported as instrumented-with-zero-samples ("not emitted") rather than as a 0.
    'quality': 'quality_evidence_score',
    'avg_quality_evidence': 'quality_evidence_score',
    'retry_rate': 'retry',
}

#: Provenance notes for fields that neither `records.INSTRUMENTED_FIELDS` nor
#: `records.UNINSTRUMENTED_FIELDS` lists. `records.is_instrumented` already reports them as
#: uninstrumented (it is conservative about unlisted fields); this only supplies the *reason*, so a
#: reader hovering the pill learns why, and a reviewer can tell "checked, absent" from "not
#: considered". Verified by grepping `orchestrator/`, `bridge/`, `scripts/` and `adapters/` for
#: writes: `merge_conflict` / `merge_conflict_resolution` appear only in reader sets
#: (`economics.WASTE_EVENTS`, `economics.COORDINATION_EVENTS`, this module).
_FIELD_NOTES: dict[str, str] = {
    'merge_conflict': 'read by dashboard.build_data and economics.WASTE_EVENTS; no emitter anywhere in this repo',
}

_CONTEXT_MISS_EVENTS = {'context_packet_miss', 'context_refetch'}
_CONFLICT_EVENTS = {'merge_conflict', 'merge_conflict_resolution'}


def _num(value: Any) -> float:
    """Coerce a telemetry value to a float without raising (live rows mix `None`, `''`, strings)."""
    if value is None or isinstance(value, bool):
        return 0.0
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _int(value: Any) -> int:
    return int(_num(value))


def safe(data) -> str:
    """Embed `data` in HTML as JSON, with `NO_DATA` becoming `null`.

    `records.to_json` rewrites the sentinel throughout the nested structure and `json_default` is the
    backstop for anything a nested producer adds later, so a `NO_DATA` can never be silently coerced
    to `0` on its way to the browser — the whole point of having a sentinel.
    """
    payload = json.dumps(records.to_json(data), ensure_ascii=False, default=records.json_default)
    return payload.replace('</', '<\\/')


def tail_ratio(p99: Any, p50: Any, samples: int) -> Any:
    """`p99 / p50` over per-call samples, or `NO_DATA`. Never divides by a floor constant.

    `NO_DATA` in three cases, each of which the old expression answered with a number:
    fewer than `MIN_TAIL_SAMPLES` samples (a ratio nobody should read), a `p50` of zero (the
    `4053665000.0x` card), and a missing percentile.
    """
    if samples < MIN_TAIL_SAMPLES:
        return NO_DATA
    return records.ratio(p99, p50)


def _instrumentation(samples: dict[str, int]) -> dict[str, dict[str, Any]]:
    """Per-key instrumentation state, so the renderer can say *why* a value is missing.

    `label` is what the card shows in place of a number:

    * `not instrumented` — nothing in this repo writes the field (`records.is_instrumented` is
      False). A `0` here would be an invented measurement.
    * `not emitted` — a producer exists but wrote no rows in this stream, so there is still nothing
      to report. Distinguished from `not instrumented` because contradicting the `records` registry
      would create a second, conflicting vocabulary of what is instrumented.
    * `None` — instrumented and sampled; a missing value is an ordinary em-dash.
    """
    state: dict[str, dict[str, Any]] = {}
    for key, field in INSTRUMENTATION.items():
        instrumented = records.is_instrumented(field)
        count = _int(samples.get(key, 0))
        state[key] = {
            'field': field,
            'instrumented': instrumented,
            'samples': count,
            'label': None if instrumented and count > 0 else ('not emitted' if instrumented else 'not instrumented'),
            'note': (records.UNINSTRUMENTED_FIELDS.get(field) or records.INSTRUMENTED_FIELDS.get(field)
                     or _FIELD_NOTES.get(field) or ''),
        }
    return state


#: Relative tolerance for calling bridge-executed spend and `model_call` spend the same aggregate.
#: Both figures are always rendered, so this only decides whether the page *states* the
#: two-rows-per-dispatch relationship. It is relative, not absolute: the two streams are written by
#: separate code paths and drift by fractions of a cent per row as the stream grows, which an
#: absolute cent would turn into a false negative overnight.
EXECUTED_MIRROR_TOLERANCE = .01


def _mirrors(cost: float, paired: float) -> bool:
    """Do these two independently written totals describe the same dispatches?"""
    if cost <= 0 or paired <= 0:
        return False
    return abs(cost - paired) <= EXECUTED_MIRROR_TOLERANCE * max(cost, paired)


def _executed_spend(orchestrated: list[dict]) -> dict[str, Any]:
    """`route_executed.executed_cost_usd` — real spend that reads as `$0` to every cost field.

    The bridge emits two rows per dispatch: a `model_call` with `cost_usd` and a `route_executed`
    with `executed_cost_usd`. Nothing is double counted in `total_cost` (different field names), but
    a reader shown a `$0` dispatch is being misled, so executed spend is surfaced as its own figure
    next to the `model_call` spend of the same runtimes — when the two agree (within
    `EXECUTED_MIRROR_TOLERANCE`), that agreement *is* the evidence that they describe the same
    dispatches. Both figures are always reported; the flag only decides whether the page states the
    relationship.
    """
    rows = [r for r in orchestrated if r.get('event') == 'route_executed']
    by_runtime: defaultdict[str, float] = defaultdict(float)
    for row in rows:
        by_runtime[str(row.get('agent_runtime') or row.get('runtime') or 'unknown')] += _num(row.get('executed_cost_usd'))
    cost = sum(by_runtime.values())
    paired = sum(row_cost(r) for r in orchestrated
                 if r.get('event') == 'model_call'
                 and str(r.get('agent_runtime') or r.get('runtime') or 'unknown') in by_runtime)
    return {
        'cost': cost,
        'rows': len(rows),
        'by_runtime': dict(by_runtime),
        'model_call_cost_same_runtimes': paired,
        'mirrors_model_call_cost': _mirrors(cost, paired),
        'counted_in_total_cost': False,
    }


def _rate_provenance(metrics: list[dict]) -> dict[str, Any]:
    """Which rate-table entries the *estimated* share of spend rests on, and whether any is verified.

    Estimated cost is arithmetic over a rate nobody has confirmed with a provider: one model id
    drives the overwhelming majority of priced rows, so its rate is effectively the whole estimate.
    `cost_rate_source` / `cost_rate_verified_on` are read defensively — they are absent from every
    row written so far and are being added concurrently — so an absent field means "unverified",
    never an error.

    Scope is *all* metric rows, orchestrated and ingested: the ingested side is where the dominant
    rate does most of its work, and splitting it out would hide the exposure.
    """
    by_model: defaultdict[str, dict[str, Any]] = defaultdict(
        lambda: {'rows': 0, 'cost': 0.0, 'source': None, 'verified_on': None})
    verified_rows = 0
    for row in metrics:
        if cost_class(row) != ESTIMATED:
            continue
        entry = by_model[str(row.get('cost_rate_model') or row.get('model') or 'unknown')]
        entry['rows'] += 1
        entry['cost'] += row_cost(row)
        source = row.get('cost_rate_source')
        if source and not entry['source']:
            entry['source'] = str(source)
        verified_on = row.get('cost_rate_verified_on')
        if verified_on:
            entry['verified_on'] = str(verified_on)
            verified_rows += 1
    models = sorted(({'model': name, **entry} for name, entry in by_model.items()),
                    key=lambda m: -m['cost'])
    dominant = models[0] if models else None
    return {
        'scope': 'all metric rows (orchestrated + ingested)',
        'estimated_cost': sum(m['cost'] for m in models),
        'rate_rows': sum(m['rows'] for m in models),
        'verified_rate_rows': verified_rows,
        'unverified_rate_cost': sum(m['cost'] for m in models if not m['verified_on']),
        'dominant_model': dominant['model'] if dominant else NO_DATA,
        'dominant_rows': dominant['rows'] if dominant else NO_DATA,
        'dominant_cost': dominant['cost'] if dominant else NO_DATA,
        'models': models[:8],
    }


def _verification_task_ids(orchestrated: list[dict], outcomes: list[dict]) -> tuple[set[str], set[str]]:
    """Split task ids by *evidence strength*: `(attested_verified, dispatch_pass_only)`.

    Two different claims that must never be pooled. `Verified tasks 174` was reported for a stream
    with 18 attested verifications because a `model_call` row's `result: 'pass'` — the dispatched
    subprocess exited 0 — was counted as a verification verdict. See `records.verification_evidence`.

    * `attested_verified`: something states the task verified (`event: task_verified`, or an
      outcomes-stream verdict field). This is the only population that may be called "verified".
    * `dispatch_pass_only`: a dispatch `result` pass and *no* attestation for that task id. Reported
      alongside, never instead: a task with both kinds of evidence counts once, as attested, so the
      two sets are disjoint and `attested + dispatch_pass` never double counts a task.

    Both streams are joined by `task_id` and both are asked through `records`, because strength comes
    from the row's own shape rather than from which file it was read out of.
    """
    by_task: dict[str, list[dict]] = defaultdict(list)
    for row in list(orchestrated) + list(outcomes):
        task_id = row.get('task_id')
        if task_id is not None:
            by_task[str(task_id)].append(row)

    attested: set[str] = set()
    dispatch: set[str] = set()
    for task_id, rows in by_task.items():
        evidence = records.resolve_task_verification(rows)
        if evidence == records.VerificationEvidence(records.VERIFIED, records.ATTESTED):
            attested.add(task_id)
        elif evidence == records.VerificationEvidence(records.VERIFIED, records.DISPATCH):
            dispatch.add(task_id)
    return attested, dispatch


def build_ingest_status(raw: Any, *, now: datetime) -> dict[str, Any]:
    """Validate persisted ingest health and derive staleness without trusting its contents."""
    unknown = {
        'status': 'unknown', 'last_attempt_at': None, 'last_success_at': None,
        'emitted': 0, 'failure_count': 0, 'error': None, 'stale_after_seconds': 1800,
    }
    if not isinstance(raw, dict):
        return unknown

    interval = raw.get('sweep_interval_seconds', 900)
    if isinstance(interval, bool):
        interval = 900
    try:
        interval = int(interval)
        if interval <= 0:
            interval = 900
    except (TypeError, ValueError, OverflowError):
        interval = 900
    stale_after = interval * 2

    def parse_timestamp(value: Any) -> datetime | None:
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except (TypeError, ValueError, OverflowError):
            return None

    attempt_raw = raw.get('last_attempt_at')
    success_raw = raw.get('last_success_at')
    attempt = parse_timestamp(attempt_raw)
    success = parse_timestamp(success_raw) if success_raw is not None else None
    reported_status = raw.get('status')
    if (not isinstance(reported_status, str) or reported_status not in {'ok', 'partial', 'error'}
            or attempt is None or (success_raw is not None and success is None)
            or (reported_status == 'ok' and success is None)):
        return {**unknown, 'stale_after_seconds': stale_after}

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now_utc = now.astimezone(timezone.utc)
    status = reported_status
    # Future success timestamps represent clock skew, not an old successful check.
    if reported_status == 'ok' and success is not None and (now_utc - success).total_seconds() > stale_after:
        status = 'stale'

    def safe_count(value: Any) -> int:
        if isinstance(value, bool):
            return 0
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError, OverflowError):
            return 0

    error = raw.get('error')
    return {
        'status': status,
        'last_attempt_at': attempt_raw,
        'last_success_at': success_raw,
        'emitted': safe_count(raw.get('emitted')),
        'failure_count': safe_count(raw.get('failure_count')),
        'error': error[:500] if isinstance(error, str) else None,
        'stale_after_seconds': stale_after,
    }


def build_data(root: Path, config: dict | None = None):
    config = config or read_json(Path(__file__).with_name('config.json'), {})
    metrics = load_jsonl(root / 'metrics.jsonl')
    events = load_jsonl(root / 'events.jsonl')
    outcomes = load_jsonl(root / 'outcomes.jsonl')
    ingest_status = build_ingest_status(read_json(root / 'ingest_status.json', {}),
                                        now=datetime.now(timezone.utc))
    ingested = [r for r in metrics if is_session_ingest(r)]
    orchestrated = [r for r in metrics if not is_session_ingest(r)]
    total = sum(row_cost(r) for r in orchestrated)
    waste = waste_cost(orchestrated)
    attribution = cost_attribution(orchestrated)
    # Per-call distribution over `records.is_per_call_cost_row` rows only: session aggregates carry
    # one cost for many calls and event rows carry none at all.
    distribution = cost_distribution(orchestrated)
    verified, dispatch_passed = _verification_task_ids(orchestrated, outcomes)
    # No key named `calls` on either breakdown: that name previously meant *rows* and silently
    # reusing it with a new meaning is the same misread in a different place. `rows`, `call_rows`
    # (cost-accountable rows) and `covered_calls` (real calls, summing `covers_calls`) are distinct.
    role = defaultdict(lambda: {'cost': 0, 'rows': 0, 'call_rows': 0, 'session_rows': 0, 'covered_calls': 0, 'tokens': 0})
    runtime = defaultdict(lambda: {'cost': 0, 'rows': 0, 'call_rows': 0, 'session_rows': 0, 'covered_calls': 0, 'reported_cost': 0.0,
                                   'estimated_cost': 0.0, 'metered_calls': 0, 'unmetered_calls': 0})
    policies = defaultdict(lambda: {'cost': 0, 'rows': 0, 'call_rows': 0, 'verified': set(),
                                    'dispatch_pass': set(), 'quality': [], 'aggr': []})
    adaptive = []
    for r in orchestrated:
        granularity = records.classify(r)
        call_row = is_call_row(r)
        covered = records.covered_calls(r)
        rr = r.get('role') or r.get('capability_class') or 'unknown'
        role[rr]['cost'] += row_cost(r)
        role[rr]['rows'] += 1
        role[rr]['call_rows'] += 1 if call_row else 0
        role[rr]['session_rows'] += 1 if granularity == records.SESSION else 0
        role[rr]['covered_calls'] += covered if call_row else 0
        role[rr]['tokens'] += _int(r.get('input_tokens')) + _int(r.get('output_tokens'))
        # Accept the legacy/alternate `runtime` key so a runtime that mislabels the field does
        # not silently pool into 'unknown'.
        agent_runtime = r.get('agent_runtime') or r.get('runtime') or 'unknown'
        rt = runtime[agent_runtime]
        rt['cost'] += row_cost(r)
        rt['rows'] += 1
        rt['session_rows'] += 1 if granularity == records.SESSION else 0
        if call_row:
            # `rows` counts every orchestrated record; `call_rows` only those accountable for cost.
            # Metered/unmetered are counted here too, so `metered + unmetered == call_rows` holds by
            # construction — the old card read '309 calls · 110 metered · 16 unmetered'.
            rt['call_rows'] += 1
            rt['covered_calls'] += covered
            provenance = cost_class(r)
            if provenance == REPORTED:
                rt['reported_cost'] += row_cost(r)
                rt['metered_calls'] += 1
            elif provenance == ESTIMATED:
                rt['estimated_cost'] += row_cost(r)
                rt['metered_calls'] += 1
            else:
                rt['unmetered_calls'] += 1
        pid = r.get('policy_id') or 'unknown'
        p = policies[pid]
        p['cost'] += row_cost(r)
        p['rows'] += 1
        p['call_rows'] += 1 if call_row else 0
        if r.get('task_id') is not None and str(r['task_id']) in verified:
            p['verified'].add(str(r['task_id']))
        if r.get('task_id') is not None and str(r['task_id']) in dispatch_passed:
            p['dispatch_pass'].add(str(r['task_id']))
        if r.get('quality_evidence_score') is not None:
            p['quality'].append(_num(r['quality_evidence_score']))
        if r.get('cost_aggressiveness') is not None:
            p['aggr'].append(_num(r['cost_aggressiveness']))
        if r.get('event') == 'adaptive_route_decision':
            adaptive.append(r)
    policy_rows = []
    for pid, p in policies.items():
        vn = len(p['verified'])
        policy_rows.append({'policy_id': pid, 'cost': p['cost'], 'rows': p['rows'], 'call_rows': p['call_rows'],
                            # `verified` is attested-only; `dispatch_pass` is the weaker exit-0
                            # signal, carried separately so the column cannot absorb it.
                            'verified': vn, 'verified_cost': records.ratio(p['cost'], vn),
                            'dispatch_pass': len(p['dispatch_pass']),
                            'quality': records.metric(sum(p['quality']) / len(p['quality']) if p['quality'] else None,
                                                      len(p['quality'])),
                            'cost_aggressiveness': records.metric(
                                sum(p['aggr']) / len(p['aggr']) if p['aggr'] else None, len(p['aggr']))})
    context_misses = sum(1 for r in orchestrated if r.get('event') in _CONTEXT_MISS_EVENTS)
    context_packets = sum(1 for r in orchestrated if r.get('event') == 'context_packet')
    conflict_rows = sum(1 for e in events if e.get('event') in _CONFLICT_EVENTS)
    invalidations = sum(1 for e in events if e.get('event') == 'decision_invalidated')
    review_wait = [_num(r.get('review_wait_ms')) / 1000 for r in orchestrated if r.get('review_wait_ms') is not None]
    shadow = [r for r in orchestrated if r.get('event') == 'shadow_review']
    false_pass = sum(1 for r in shadow if r.get('normal_pass') is True and r.get('shadow_pass') is False)
    over_reject = sum(1 for r in shadow if r.get('normal_pass') is False and r.get('shadow_pass') is True)
    quality_samples = sum(1 for r in orchestrated if r.get('quality_evidence_score') is not None)
    retry_samples = sum(1 for r in orchestrated if 'retry' in r)
    outsum = outcome_summary(root)
    runs = summarize_runs(orchestrated, events, outcomes)
    run_cov = evidence_coverage(runs)
    mature30 = [x for x in outsum if x['mature_30d']]
    delayed_bad = sum(1 for x in mature30 if x['bad_outcome'])
    actions = defaultdict(int)
    for r in adaptive:
        actions[str(r.get('route_action', 'unknown'))] += 1

    def action_count(name: str) -> Any:
        """Count of one adaptive action: a real `0` when decisions exist, `NO_DATA` when none do."""
        return actions.get(name, 0) if adaptive else NO_DATA

    overhead = orchestration_overhead(orchestrated)
    summary = {
        'total_cost': total,
        'reported_cost': attribution[REPORTED]['cost'],
        'estimated_cost': attribution[ESTIMATED]['cost'],
        'unmetered_calls': attribution[UNMETERED]['calls'],
        'call_rows': attribution['call_rows'],
        'covered_calls': attribution['covered_calls'],
        'runs': run_cov['runs'],
        'runs_fully_priced': run_cov['runs_fully_priced'],
        'runs_with_elapsed': run_cov['runs_with_elapsed'],
        'priced_run_coverage': run_cov['priced_run_coverage'],
        'duration_coverage': run_cov['duration_coverage'],
        'verification_coverage': run_cov['verification_coverage'],
        'cost_provenance': run_cov['cost_provenance'],
        'cost_coverage': attribution['coverage'],
        # Attested verifications only — a dispatch `result: 'pass'` is a process exit code, not a
        # gate outcome, and counting it here reported 174 verified tasks for 18 real ones.
        # `dispatch_pass_tasks` carries that weaker signal under its own name so both are visible and
        # neither can be mistaken for the other. When nothing is attested this is a real 0 and
        # `verified_cost` is NO_DATA — never a silent substitution of the dispatch figure.
        'verified_tasks': len(verified),
        'verified_cost': records.ratio(total, len(verified)),
        'dispatch_pass_tasks': len(dispatch_passed),
        'dispatch_pass_cost': records.ratio(total, len(dispatch_passed)),
        'waste_cost': sum(waste.values()),
        'waste_rate': records.ratio(sum(waste.values()), total),
        # A dict, not a scalar: coordination and verification are different costs and pooling them
        # answers neither question. Also flattened onto `summary` as `coordination_rate` /
        # `verification_rate` / `coordination_cost` / `verification_cost` for the cards and for
        # `tests/test_v3_engine.py`, which reads these keys directly off `summary` and is owned by a
        # concurrent agent, not this module. Keeping both representations is a drift risk in theory,
        # but they are assigned once, here, from the same `overhead` dict, so they cannot diverge in
        # practice; `test_flattened_overhead_fields_never_drift_from_the_nested_dict` in
        # `tests/test_dashboard_metrics.py` pins that invariant so a future edit that touches one and
        # not the other fails loudly instead of silently.
        'orchestration_overhead': overhead,
        'coordination_rate': overhead['coordination_rate'],
        'verification_rate': overhead['verification_rate'],
        'coordination_cost': overhead['coordination_cost'],
        'verification_cost': overhead['verification_cost'],
        'fanout_rework': fanout_rework(events),
        'context_miss_rate': records.ratio(context_misses, context_packets),
        # A genuine 0 stays 0; with no producer for merge-conflict events at all, the absence is
        # reported as absence and the renderer labels it `not instrumented`.
        'conflicts': conflict_rows if conflict_rows else NO_DATA,
        'review_wait_p90_s': records.metric(quantile(review_wait, .9), len(review_wait)),
        'shadow_reviews': len(shadow),
        'shadow_false_pass_rate': records.ratio(false_pass, len(shadow)),
        'shadow_over_reject_rate': records.ratio(over_reject, len(shadow)),
        'stable_30d_failure_rate': records.ratio(delayed_bad, len(mature30)),
        'per_call_samples': distribution['samples'],
        'per_call_cost': distribution['call_cost'],
        'mean_call_cost': distribution['mean_cost'],
        'p50_cost': distribution['p50_cost'],
        'p90_cost': distribution['p90_cost'],
        'p99_cost': distribution['p99_cost'],
        'max_call_cost': distribution['max_cost'],
        'session_rows': distribution['session_rows'],
        'session_cost': distribution['session_cost'],
        'tail_ratio': tail_ratio(distribution['p99_cost'], distribution['p50_cost'], distribution['samples']),
        'tail_ratio_min_samples': MIN_TAIL_SAMPLES,
        'executed_spend': _executed_spend(orchestrated),
        'rate_provenance': _rate_provenance(metrics),
        'adaptive_decisions': len(adaptive),
        'adaptive_actions': dict(actions),
        'adaptive_action_counts': {name: action_count(name) for name in
                                   ('recommended_only', 'empirical_enforced', 'static_default',
                                    'fallback_insufficient_history')},
        'exploration_rate_observed': records.ratio(sum(1 for x in adaptive if x.get('explored')), len(adaptive)),
        'history_sufficient_rate': records.ratio(sum(1 for x in adaptive if x.get('history_sufficient')), len(adaptive)),
    }
    daily = defaultdict(lambda: {'cost': 0.0, 'rows': 0, 'call_rows': 0, 'verified': set(),
                                 'dispatch_pass': set(), 'quality': [],
                                 'aggr': [], 'retries': 0, 'adaptive': 0})
    for r in orchestrated:
        day = str(r.get('ts', ''))[:10] or 'unknown'
        d = daily[day]
        d['cost'] += row_cost(r)
        d['rows'] += 1
        d['call_rows'] += 1 if is_call_row(r) else 0
        d['retries'] += _int(r.get('retry'))
        if r.get('event') == 'adaptive_route_decision':
            d['adaptive'] += 1
        if r.get('task_id') is not None and str(r['task_id']) in verified:
            d['verified'].add(str(r['task_id']))
        if r.get('task_id') is not None and str(r['task_id']) in dispatch_passed:
            d['dispatch_pass'].add(str(r['task_id']))
        if r.get('quality_evidence_score') is not None:
            d['quality'].append(_num(r['quality_evidence_score']))
        if r.get('cost_aggressiveness') is not None:
            d['aggr'].append(_num(r['cost_aggressiveness']))
    trends = []
    for day, d in sorted(daily.items()):
        vn = len(d['verified'])
        trends.append({'day': day, 'cost': d['cost'], 'rows': d['rows'], 'call_rows': d['call_rows'], 'verified': vn,
                       # Attested-only, matching the summary; the daily Verified column previously
                       # counted dispatch passes too.
                       'verified_cost': records.ratio(d['cost'], vn),
                       'dispatch_pass': len(d['dispatch_pass']),
                       'quality': records.metric(sum(d['quality']) / len(d['quality']) if d['quality'] else None,
                                                 len(d['quality'])),
                       'cost_aggressiveness': records.metric(
                           sum(d['aggr']) / len(d['aggr']) if d['aggr'] else None, len(d['aggr'])),
                       'retries': d['retries'], 'adaptive': d['adaptive']})
    session_ids = {str(r.get('session_id')) for r in ingested if r.get('session_id') is not None}
    interactive_sessions = {
        # `rows` and `calls` are different numbers and both are reported: 609 of these rows are
        # session aggregates carrying `covers_calls`, so `len(rows)` understated calls ~13-fold.
        'rows': len(ingested),
        'calls': sum(records.covered_calls(r) for r in ingested),
        'aggregate_rows': sum(1 for r in ingested if records.classify(r) == records.SESSION),
        'cost': sum(row_cost(r) for r in ingested),
        'tokens': sum(_int(r.get('input_tokens')) + _int(r.get('output_tokens')) for r in ingested),
        'by_runtime': {},
        'sessions': len(session_ids) if session_ids else NO_DATA,
    }
    for r in ingested:
        agent_runtime = r.get('agent_runtime') or r.get('runtime') or 'unknown'
        br = interactive_sessions['by_runtime'].setdefault(agent_runtime, {'rows': 0, 'calls': 0, 'cost': 0.0})
        br['rows'] += 1
        br['calls'] += records.covered_calls(r)
        br['cost'] += row_cost(r)
    last_event_ts = max((str(e.get('ts', '')) for e in events), default=None) or None
    last_metric_ts = max((str(r.get('ts', '')) for r in metrics), default=None) or None
    return {'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'last_event_ts': last_event_ts, 'last_metric_ts': last_metric_ts,
            'event_count': len(events), 'metric_count': len(metrics),
            'summary': summary, 'waste': waste, 'by_role': role, 'by_runtime': runtime,
            'policies': policy_rows, 'trends': trends,
            'instrumentation': _instrumentation({
                'review_wait_p90_s': len(review_wait), 'context_miss_rate': context_packets,
                'fanout_rework': invalidations, 'conflicts': conflict_rows,
                'shadow_false_pass_rate': len(shadow), 'shadow_over_reject_rate': len(shadow),
                'quality': quality_samples, 'avg_quality_evidence': quality_samples,
                'retry_rate': retry_samples}),
            'routes': build_route_stats(orchestrated, outcomes), 'outcomes': outsum,
            'run_evidence': run_cov, 'runs': runs[-200:],
            # flaky_stats only matches rows with event=='verification_result'; session-ingest rows
            # are event=='model_call' and never contribute, but we pass `orchestrated` for
            # consistency with the rest of this function's inputs.
            'flaky': flaky_stats(orchestrated),
            'interactive_sessions': interactive_sessions,
            'ingest_status': ingest_status,
            'features': feature_inventory(config.get('features', {})), 'adaptive': adaptive[-500:],
            'events': events[-500:], 'metrics': metrics[-2000:]}


def generate_dashboard(state_dir=None, config: dict | None = None):
    root = Path(state_dir) if state_dir is not None else default_state_root()
    root.mkdir(parents=True, exist_ok=True)
    data = build_data(root, config)
    # Auto-refresh so a file:// tab left open does not look frozen between orchestrator dispatches.
    doc='''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestrator V3 Dashboard</title><style>
:root{color-scheme:light dark;--bg:#0e1116;--p:#171b22;--b:#2a313c;--t:#edf2f7;--m:#929bab;--a:#7aa7ff;--g:#61c98c;--w:#e9b65e;--r:#e16e6e}@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--p:#fff;--b:#e2e6ec;--t:#111827;--m:#667085}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1320px;margin:auto;padding:22px}h1{margin:0;font-size:25px}.sub{color:var(--m);margin:4px 0 18px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card{background:var(--p);border:1px solid var(--b);border-radius:12px;padding:13px;min-width:0}.k{font-size:12px;color:var(--m)}.v{font-size:22px;font-weight:720;margin-top:3px}.section{margin-top:16px}.section h2{font-size:16px;margin:0 0 10px}table{width:100%;border-collapse:collapse}th,td{padding:7px 8px;border-bottom:1px solid var(--b);text-align:left;white-space:nowrap}th{font-size:12px;color:var(--m)}.scroll{overflow:auto}.bar{height:8px;background:var(--b);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--a)}.small{font-size:12px;color:var(--m)}.risk{display:grid;grid-template-columns:1fr 150px;gap:8px;padding:7px 0;border-bottom:1px solid var(--b)}.risk b{text-align:right}.timeline{max-height:320px;overflow:auto}.event{padding:7px 0;border-bottom:1px solid var(--b)}.pill{display:inline-block;padding:2px 7px;border:1px solid var(--b);border-radius:999px;font-size:12px}.on{color:var(--g)}.off{color:var(--m)}.warn{color:var(--w)}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main><h1>Hierarchical Orchestrator V3</h1><div class="sub">Adaptive routing, empirical economics, feature state, delayed outcomes, and risk observability. Counterfactuals remain estimates. Spend is split by provenance: provider-reported, estimated from reported tokens, or unmetered — unmetered work is never shown as $0. A missing measurement renders as — or <span class="pill off">not instrumented</span>, never as a zero.</div><div class="sub" id="freshness"></div><button id="pause-refresh" type="button" aria-pressed="false">Pause auto-refresh</button><div id="cards" class="grid"></div><div class="sub" id="statsNote"></div>
<div class="section grid" style="grid-template-columns:1.1fr .9fr"><div class="card"><h2>Adaptive routing health</h2><div id="adaptiveHealth"></div></div><div class="card"><h2>Risk observatory</h2><div id="risk"></div></div></div>
<div class="section card" id="rate-provenance"><h2>Cost rate provenance (estimated spend only)</h2><div id="rates"></div></div>
<div class="section card"><h2>V3 feature controls</h2><div class="scroll"><table id="features"></table></div></div>
<div class="section card"><h2>Recent adaptive decisions</h2><div class="scroll"><table id="adaptive"></table></div></div>
<div class="section card"><h2>Policy cohorts</h2><div class="scroll"><table id="policies"></table></div></div>
<div class="section card"><h2>Daily trend</h2><div class="scroll"><table id="trends"></table></div></div>
<div class="section card"><h2>Run evidence (actual, by run)</h2><div class="small">Joined by run_id across metrics, events, and outcomes. Known cost is the sum of metered calls only; unmetered calls and missing durations are shown as gaps, never as $0 or 0s. Elapsed time comes from the run's terminal boundary and is tagged with the source the writer declared. Non-impl. share is the fraction of known cost spent outside implementation roles (lead, architect, review, QA, triage) — broader than the "Orchestration overhead" card, which counts only coordination roles. Any flat-baseline comparison is a counterfactual estimate, not observed savings.</div><div class="scroll"><table id="runs"></table></div></div>
<div class="section card"><h2>Historical route economics</h2><div class="scroll"><table id="routes"></table></div></div>
<div class="section card"><h2>Cost by role</h2><div id="roles"></div></div>
<div class="section card"><h2>Cost by agent runtime</h2><div id="runtimes"></div></div>
<div class="section card"><h2>Session ingest health</h2><div id="ingest-status"></div></div>
<div class="section card"><h2>Interactive sessions (ingested, not orchestrated)</h2><div id="interactive"></div></div>
<div class="section card"><h2>Recent events</h2><div class="timeline" id="events"></div></div>
<script>const D='''+safe(data)+''';const $=s=>document.querySelector(s);const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// One missing-value path. `null` on the wire is `records.NO_DATA`: no measurement exists. It renders
// as an em-dash, or as an explicit `not instrumented` / `not emitted` pill when D.instrumentation
// says the field has no producer or no rows. Nothing coerces a missing value to 0 — that coercion
// (`Number(x||0).toFixed(1)`) is what let a 4-billion-fold tail ratio render as a confident number.
const INST=D.instrumentation||{};const miss=k=>{const i=INST[k];return i&&i.label?`<span class="pill off" title="${esc(i.field+(i.note?': '+i.note:''))}">${esc(i.label)}</span>`:'—'};
const fmt=(k,x,f)=>(x==null||x==='')?miss(k):f(Number(x));
const money=x=>'$'+x.toFixed(4);const pct=x=>(x*100).toFixed(1)+'%';const count=x=>x.toLocaleString();const times=x=>x.toFixed(1)+'×';const secs=x=>x.toFixed(1)+'s';const mult=x=>x.toFixed(2);
const m$=(k,x)=>fmt(k,x,money);const p$=(k,x)=>fmt(k,x,pct);const n$=(k,x)=>fmt(k,x,count);
// Counts that are genuinely zero when absent (event tallies within a rendered row) stay numeric.
const n0=x=>Number(x||0);const nz=x=>n0(x).toLocaleString();
const fmtTs=x=>x?String(x).replace('T',' ').slice(0,19)+' UTC':'—';$('#freshness').textContent=`Rebuilt ${fmtTs(D.generated_at)} · latest event ${fmtTs(D.last_event_ts)} · latest metric ${fmtTs(D.last_metric_ts)} · ${nz(D.event_count)} events, ${nz(D.metric_count)} metric records · page auto-reloads every 5s while visible unless paused`;
const I=D.ingest_status||{status:'unknown',last_attempt_at:null,last_success_at:null,emitted:0,failure_count:0,error:null,stale_after_seconds:1800};
$('#ingest-status').innerHTML=`<div class="risk"><span>State</span><b>${esc(I.status)}</b></div><div class="risk"><span>Last attempt</span><b>${esc(fmtTs(I.last_attempt_at))}</b></div><div class="risk"><span>Last success</span><b>${esc(fmtTs(I.last_success_at))}</b></div><div class="risk"><span>Rows emitted</span><b>${nz(I.emitted)}</b></div><div class="risk"><span>Failures</span><b>${nz(I.failure_count)}</b></div><div class="risk"><span>Stale after</span><b>${nz(I.stale_after_seconds)}s</b></div>${I.error?`<div class="small warn">${esc(I.error)}</div>`:(I.status==='unknown'?'<div class="small">not reported</div>':'')}`;
const S=D.summary;const X=S.executed_spend||{};const RP=S.rate_provenance||{};
// `verified_cost` and `dispatch_pass_cost` share the SAME numerator (`total_cost` — all
// orchestrated spend, including coordination, review, waste, and tasks that were neither verified
// nor passed); they differ only in denominator. Labels below say "total spend per", not "cost of",
// so neither reads as an isolated unit-economics figure, and the explainer card repeats the fact.
const cards=[['Total spend (incl. session aggregates)',m$('total_cost',S.total_cost)],['Provider-reported spend',m$('reported_cost',S.reported_cost)],['Estimated spend (orchestrated rows only, unverified rates)',m$('estimated_cost',S.estimated_cost)],['Unverified-rate exposure — ALL rows incl. ingested (see <a href="#rate-provenance">rate provenance</a> below)','<span class="warn">'+m$('rate_provenance',RP.unverified_rate_cost)+'</span>'],['Unmetered call rows',n$('unmetered_calls',S.unmetered_calls)+' of '+n$('call_rows',S.call_rows)],['Covered calls (rows × covers_calls; legacy session rows count as 1)',n$('covered_calls',S.covered_calls)],['Cost coverage',p$('cost_coverage',S.cost_coverage)],['Verified tasks (attested verdict)',n$('verified_tasks',S.verified_tasks)],['Total spend per attested-verified task (not an isolated unit cost)',m$('verified_cost',S.verified_cost)],['Dispatch passes (exit 0 — NOT gate-verified)',n$('dispatch_pass_tasks',S.dispatch_pass_tasks)],['Total spend per dispatch pass (not an isolated unit cost)',m$('dispatch_pass_cost',S.dispatch_pass_cost)],['Waste rate',p$('waste_rate',S.waste_rate)],['Coordination overhead',p$('coordination_rate',S.coordination_rate)],['Verification spend',p$('verification_rate',S.verification_rate)],['Bridge-executed spend',m$('executed_spend',X.cost)],['30d delayed failure',p$('stable_30d_failure_rate',S.stable_30d_failure_rate)],['p99/p50 tail ratio (per-call rows)',fmt('tail_ratio',S.tail_ratio,times)],['Adaptive decisions',n$('adaptive_decisions',S.adaptive_decisions)]];
$('#cards').innerHTML=cards.map(x=>`<div class="card"><div class="k">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('')+`<div class="card" style="grid-column:1/-1"><div class="k">What “verified” counts here</div><div class="small"><b>Verified tasks</b> counts only tasks with an <b>attested verdict</b> — an emitted <code>task_verified</code>/<code>task_failed</code> event, or a verdict field in <code>outcomes.jsonl</code>. <b>Dispatch passes</b> counts tasks whose only evidence is <code>result: 'pass'</code> on a <code>model_call</code> row, which means <em>the dispatched subprocess exited 0</em> — not that the work cleared its quality gates. The two are disjoint (a task with both counts once, as attested) and are never pooled: pooling them reported ${nz(S.verified_tasks)}+${nz(S.dispatch_pass_tasks)} tasks as “verified”. A dispatch pass is real evidence, but it is weaker evidence, so cost-per-verified-task is ${m$('verified_cost',S.verified_cost)} and is reported as unknown rather than falling back to cost-per-dispatch-pass when nothing is attested. <b>Both “total spend per…” figures divide the exact same numerator</b> — ${m$('total_cost',S.total_cost)} of total orchestrated spend, which includes coordination, review, waste, and work on tasks that were neither verified nor passed — by two different denominators (${nz(S.verified_tasks)} attested-verified tasks vs. ${nz(S.dispatch_pass_tasks)} dispatch passes). Neither is a per-task unit cost for the verified or passed work itself; both are spend-efficiency ratios over the whole workload.</div></div>`;
$('#statsNote').innerHTML=`Per-call statistics (p50/p90/p99, mean, max, tail ratio) use ${nz(S.per_call_samples)} cost-bearing per-call rows totalling ${m$('per_call_cost',S.per_call_cost)}; ${nz(S.session_rows)} whole-session aggregate rows holding ${m$('session_cost',S.session_cost)} are excluded from them but included in total spend. A tail ratio needs at least ${nz(S.tail_ratio_min_samples)} per-call samples and a non-zero p50, otherwise it is reported as unknown. Median call ${m$('p50_cost',S.p50_cost)} · p90 ${m$('p90_cost',S.p90_cost)} · p99 ${m$('p99_cost',S.p99_cost)} · max ${m$('max_call_cost',S.max_call_cost)}. Bridge dispatches also record ${m$('executed_spend',X.cost)} of <code>executed_cost_usd</code> across ${nz(X.rows)} <code>route_executed</code> rows${X.mirrors_model_call_cost?' — matching, to within 1%, the <code>model_call</code> spend of the same runtimes ('+m$('executed_spend',X.model_call_cost_same_runtimes)+'), i.e. two rows per dispatch':' (the <code>model_call</code> spend of the same runtimes is '+m$('executed_spend',X.model_call_cost_same_runtimes)+')'}; it is not added into total spend (different field), and those rows contribute no per-call cost sample.`;
// `S.covered_calls` (`attribution['covered_calls']`) equals `S.call_rows` for this stream because
// the ~89 legacy SESSION rows carry no `covers_calls` and so count as 1 real call each — an unknown
// undercount, not a measured 1 — which is why the card above states that caveat instead of a bare number.
const ah=[['History sufficient',p$('history_sufficient_rate',S.history_sufficient_rate)],['Observed exploration',p$('exploration_rate_observed',S.exploration_rate_observed)],['Recommend only',n$('adaptive_decisions',(S.adaptive_action_counts||{}).recommended_only)],['Empirical enforced',n$('adaptive_decisions',(S.adaptive_action_counts||{}).empirical_enforced)],['Static/fallback',S.adaptive_decisions?nz(n0((S.adaptive_action_counts||{}).static_default)+n0((S.adaptive_action_counts||{}).fallback_insufficient_history)):'—']];$('#adaptiveHealth').innerHTML=ah.map(x=>`<div class="risk"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
const risks=[['Fan-out rework multiplier',fmt('fanout_rework',S.fanout_rework,mult)],['Context packet miss rate',p$('context_miss_rate',S.context_miss_rate)],['Merge/conflict events',n$('conflicts',S.conflicts)],['Shadow false-pass rate',p$('shadow_false_pass_rate',S.shadow_false_pass_rate)],['Shadow over-rejection',p$('shadow_over_reject_rate',S.shadow_over_reject_rate)],['Review wait p90',fmt('review_wait_p90_s',S.review_wait_p90_s,secs)],['p99 per-call cost',m$('p99_cost',S.p99_cost)]];$('#risk').innerHTML=risks.map(x=>`<div class="risk"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
$('#rates').innerHTML=`<div class="small">Estimated spend is arithmetic over rate-table entries in <code>config.json</code>; none is provider-confirmed unless a row carries <code>cost_rate_verified_on</code>. Scope: ${esc(RP.scope||'')}. Dominant rate model <b>${esc(RP.dominant_model??'—')}</b> on ${n$('rate_provenance',RP.dominant_rows)} priced rows (${m$('rate_provenance',RP.dominant_cost)} of ${m$('rate_provenance',RP.estimated_cost)} estimated). Rows with a verified rate: ${nz(RP.verified_rate_rows)} of ${nz(RP.rate_rows)}; ${m$('rate_provenance',RP.unverified_rate_cost)} rests on unverified rates.</div><div class="scroll"><table><thead><tr><th>Rate model</th><th>Priced rows</th><th>Estimated cost</th><th>Rate source</th><th>Verified on</th></tr></thead><tbody>`+(RP.models||[]).map(r=>`<tr><td><code>${esc(r.model)}</code></td><td>${nz(r.rows)}</td><td>${m$('rate_provenance',r.cost)}</td><td>${r.source?esc(r.source):'<span class="pill off">unstated</span>'}</td><td>${r.verified_on?esc(r.verified_on):'<span class="pill warn">unverified</span>'}</td></tr>`).join('')+'</tbody></table></div>';
$('#features').innerHTML='<thead><tr><th>Feature</th><th>State</th><th>Configuration</th></tr></thead><tbody>'+D.features.map(f=>`<tr><td>${esc(f.feature)}</td><td><span class="pill ${f.state==='off'?'off':(f.state==='recommend'||f.state==='observe'?'warn':'on')}">${esc(f.state)}</span></td><td><code>${esc(JSON.stringify(f.config))}</code></td></tr>`).join('')+'</tbody>';
$('#adaptive').innerHTML='<thead><tr><th>Time</th><th>Task</th><th>Risk</th><th>Mode</th><th>Action</th><th>Selected</th><th>Effort</th><th>Verify</th><th>Rows (decayed)</th><th>Verified tasks</th><th>Explore</th><th>Canary</th></tr></thead><tbody>'+D.adaptive.slice().reverse().map(r=>`<tr><td>${esc(r.ts||'')}</td><td>${esc(r.task_class||'')}</td><td>${esc(r.risk||'')}</td><td>${esc(r.adaptive_mode||'')}</td><td>${esc(r.route_action||'')}</td><td>${esc(r.selected_capability||'')}</td><td>${esc(r.selected_effort||'')}</td><td>${esc(r.selected_verification_depth||'')}</td><td>${n$('historical_samples',r.historical_samples)}</td><td>${r.verified_task_samples==null?'—':nz(r.verified_task_samples)}</td><td>${r.explored?'yes':'no'}</td><td>${r.canary?'yes':'no'}</td></tr>`).join('')+'</tbody>';
$('#policies').innerHTML='<thead><tr><th>Policy</th><th>Cost aggr.</th><th>Cost</th><th>Rows (per-call)</th><th>Verified (attested)</th><th>Cost/attested</th><th>Dispatch pass (exit 0)</th><th>Quality evidence</th></tr></thead><tbody>'+D.policies.map(p=>`<tr><td><code>${esc(p.policy_id)}</code></td><td>${p$('cost_aggressiveness',p.cost_aggressiveness)}</td><td>${m$('cost',p.cost)}</td><td>${nz(p.rows)} (${nz(p.call_rows)})</td><td>${nz(p.verified)}</td><td>${m$('verified_cost',p.verified_cost)}</td><td>${nz(p.dispatch_pass)}</td><td>${p$('quality',p.quality)}</td></tr>`).join('')+'</tbody>';
$('#trends').innerHTML='<thead><tr><th>Day</th><th>Cost aggr.</th><th>Spend</th><th>Rows (per-call)</th><th>Verified (attested)</th><th>Cost/attested</th><th>Dispatch pass (exit 0)</th><th>Quality</th><th>Retries</th><th>Adaptive</th></tr></thead><tbody>'+D.trends.map(t=>`<tr><td>${esc(t.day)}</td><td>${p$('cost_aggressiveness',t.cost_aggressiveness)}</td><td>${m$('cost',t.cost)}</td><td>${nz(t.rows)} (${nz(t.call_rows)})</td><td>${nz(t.verified)}</td><td>${m$('verified_cost',t.verified_cost)}</td><td>${nz(t.dispatch_pass)}</td><td>${p$('quality',t.quality)}</td><td>${nz(t.retries)}</td><td>${nz(t.adaptive)}</td></tr>`).join('')+'</tbody>';
$('#routes').innerHTML='<thead><tr><th>Task</th><th>Complexity</th><th>Risk</th><th>Capability</th><th>Effort</th><th>Verify</th><th>Topology</th><th>N</th><th>Verified cost (attested)</th><th>Quality</th><th>Retry</th><th>Delayed fail</th></tr></thead><tbody>'+D.routes.map(r=>`<tr><td>${esc(r.task_class)}</td><td>${esc(r.complexity_bucket)}</td><td>${esc(r.risk)}</td><td>${esc(r.capability)}</td><td>${esc(r.effort)}</td><td>${esc(r.verification_depth)}</td><td>${esc(r.topology_shape||'—')}</td><td>${nz(r.samples)}</td><td>${m$('verified_cost',r.verified_cost_usd)}</td><td>${p$('avg_quality_evidence',r.avg_quality_evidence)}</td><td>${p$('retry_rate',r.retry_rate)}</td><td>${p$('delayed_failure_rate',r.delayed_failure_rate)}</td></tr>`).join('')+'</tbody>';
const dur=x=>x==null?'<span class="warn">unknown</span>':(Number(x)/1000).toFixed(1)+'s';const knownCost=r=>r.cost_known_usd==null?'<span class="warn">unmetered</span>':m$('run_cost',r.cost_known_usd)+(r.unmetered_calls?` <span class="warn">+${nz(r.unmetered_calls)} unmetered</span>`:'');const cf=r=>r.counterfactual?(r.counterfactual.cost_usd==null?'—':m$('run_cost',r.counterfactual.cost_usd)+(r.counterfactual.comparable?'':' <span class="warn">(partial)</span>')):'—';
$('#runs').innerHTML='<thead><tr><th>Run</th><th>Status</th><th>Elapsed (wall)</th><th>Known cost</th><th>Coverage</th><th>Non-impl. share</th><th>Calls</th><th>Tasks</th><th>Retries</th><th>Verification</th><th>Delayed bad</th><th>Counterfactual</th></tr></thead><tbody>'+D.runs.slice().reverse().map(r=>`<tr><td><code>${esc(r.run_id)}</code></td><td>${esc(r.status)}</td><td>${dur(r.elapsed_ms)}</td><td>${knownCost(r)}</td><td>${p$('run_coverage',r.cost_coverage)}</td><td>${p$('run_overhead',r.overhead_ratio)}</td><td>${nz(r.call_rows)}</td><td>${nz(r.tasks)}</td><td>${nz(r.retries)}</td><td>${esc(r.verification)}</td><td>${r.delayed_bad_outcome==null?'—':(r.delayed_bad_outcome?'yes':'no')}</td><td>${cf(r)}</td></tr>`).join('')+'</tbody>';
const R=Object.entries(D.by_role).sort((a,b)=>b[1].cost-a[1].cost),maxR=Math.max(.000001,...R.map(x=>x[1].cost));$('#roles').innerHTML=`<div class="small">Rows are records, not calls: session-aggregate rows each cover many calls, so per-row magnitudes are not per-call magnitudes.</div>`+R.map(([k,v])=>`<div style="display:grid;grid-template-columns:190px 1fr 90px;gap:10px;align-items:center;margin:9px 0"><div><b>${esc(k)}</b><div class="small">${nz(v.rows)} rows · ${nz(v.call_rows)} cost-accountable · ${nz(v.session_rows)} session aggregates${v.covered_calls>v.call_rows?' covering '+nz(v.covered_calls)+' stated calls':''} · ${nz(v.tokens)} tokens</div></div><div class="bar"><i style="width:${(v.cost/maxR*100).toFixed(1)}%"></i></div><div style="text-align:right">${m$('cost',v.cost)}</div></div>`).join('');
const A=Object.entries(D.by_runtime).sort((a,b)=>b[1].cost-a[1].cost),maxA=Math.max(.000001,...A.map(x=>x[1].cost));$('#runtimes').innerHTML=`<div class="small">Metered + unmetered always reconciles against <em>cost-accountable rows</em>, not against total rows: orchestration events (routing decisions, dispatches) are rows that are not calls.</div>`+A.map(([k,v])=>{const unmetered=n0(v.unmetered_calls),metered=n0(v.metered_calls);const label=metered?m$('cost',v.cost):(unmetered?'<span class="warn">unmetered</span>':m$('cost',v.cost));const detail=[nz(v.rows)+' rows',nz(v.call_rows)+' cost-accountable ('+nz(metered)+' metered + '+nz(unmetered)+' unmetered)',n0(v.session_rows)?nz(v.session_rows)+' session aggregates'+(n0(v.covered_calls)>n0(v.call_rows)?' covering '+nz(v.covered_calls)+' stated calls':' (calls per aggregate unstated)'):null,n0(v.estimated_cost)>0?'est. '+money(n0(v.estimated_cost)):null,n0(v.reported_cost)>0?'reported '+money(n0(v.reported_cost)):null].filter(Boolean).join(' · ');return `<div style="display:grid;grid-template-columns:190px 1fr 130px;gap:10px;align-items:center;margin:9px 0"><div><b>${esc(k)}</b><div class="small">${detail}</div></div><div class="bar"><i style="width:${(v.cost/maxA*100).toFixed(1)}%"></i></div><div style="text-align:right">${label}</div></div>`}).join('');
$('#events').innerHTML=D.events.slice().reverse().map(e=>`<div class="event"><span class="small">${esc(e.ts||'')}</span> <b>${esc(e.event||'')}</b><div class="small"><code>${esc(JSON.stringify(e).slice(0,600))}</code></div></div>`).join('');
const IS=D.interactive_sessions||{rows:0,calls:0,cost:0,tokens:0,by_runtime:{},sessions:null};const isRt=Object.entries(IS.by_runtime||{}).sort((a,b)=>b[1].cost-a[1].cost);$('#interactive').innerHTML=`<div class="small">These rows come from interactive-session ingestion, not orchestrated runs, and are excluded from the role/runtime charts above. ${nz(IS.aggregate_rows)} of ${nz(IS.rows)} rows are session aggregates covering many calls each, so cost per call must be divided by <b>calls</b>, never by <b>rows</b>.</div><div class="risk"><span>Ingested rows</span><b>${n$('interactive_rows',IS.rows)}</b></div><div class="risk"><span>Model calls (rows + covered calls)</span><b>${n$('interactive_calls',IS.calls)}</b></div><div class="risk"><span>Cost</span><b class="warn">${m$('interactive_cost',IS.cost)}</b></div><div class="risk"><span>Tokens</span><b>${n$('interactive_tokens',IS.tokens)}</b></div><div class="risk"><span>Distinct sessions</span><b>${n$('interactive_sessions',IS.sessions)}</b></div>`+(isRt.length?isRt.map(([k,v])=>`<div style="display:grid;grid-template-columns:190px 1fr 90px;gap:10px;align-items:center;margin:9px 0"><div><b>${esc(k)}</b><div class="small">${nz(v.rows)} rows · ${nz(v.calls)} calls</div></div><div class="bar"><i style="width:${(v.cost/Math.max(.000001,IS.cost)*100).toFixed(1)}%"></i></div><div style="text-align:right">${m$('cost',v.cost)}</div></div>`).join(''):'<div class="small">No runtime breakdown available.</div>');
const pauseButton=$('#pause-refresh');let paused=false;try{paused=localStorage.getItem('orch-pause')==='1';}catch{}
const syncPauseLabel=()=>{pauseButton.textContent=paused?'Resume auto-refresh':'Pause auto-refresh';pauseButton.setAttribute('aria-pressed',String(paused));};syncPauseLabel();
pauseButton.addEventListener('click',()=>{paused=!paused;try{localStorage.setItem('orch-pause',paused?'1':'0');}catch{}syncPauseLabel();});
try{const savedScroll=sessionStorage.getItem('orch-scroll');if(savedScroll!==null){window.scrollTo(0,Number(savedScroll)||0);sessionStorage.removeItem('orch-scroll');}}catch{}
setInterval(()=>{if(document.visibilityState!=='visible'||paused)return;try{if(localStorage.getItem('orch-pause')==='1')return;}catch{}try{sessionStorage.setItem('orch-scroll',String(window.scrollY));}catch{}window.location.reload();},5000);
</script></main></body></html>'''
    out = root / 'dashboard.html'
    tmp = out.with_name(f'.{out.name}.{secrets.token_hex(8)}.tmp')
    try:
        tmp.write_text(doc, encoding='utf-8')
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)
    return out

"""Dashboard data assembly: per-panel reducers over one pass of the durable streams (B3).

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

`build_data` reads each deduplicated stream exactly once (the `for event in ...` loop below, and the
`metric_rows()` generator), then hands the materialized, deduplicated cohort (`orchestrated`,
`outcomes`, `run_events`, ...) to a set of per-panel reducers — `_role_panel`, `_runtime_panel`,
`_policy_panel`, `_adaptive_panel`, `_risk_panel`, `_daily_trends_panel`, `_lead_sizes`,
`_executed_spend` — each of which takes rows and returns its own panel dict, independent of the
others. `build_data` composes their outputs into the same nested dict this module has always
returned, in the same key order.
"""
from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .. import records
from ..economics import (ESTIMATED, REPORTED, UNMETERED, cost_attribution, cost_class,
                         cost_distribution, fanout_rework, is_call_row, is_session_ingest,
                         orchestration_overhead, quantile, row_cost, unique_records, waste_cost)
from ..features import feature_inventory
from ..history import build_route_stats
from ..outcomes import outcome_summary
from ..records import NO_DATA
from ..core.fs import read_json
from ..core.jsonl import iter_jsonl
from ..run_evidence import evidence_coverage, summarize_runs
from ..verification import flaky_stats
from ..contract import INGEST_STATUS_FILE, STREAMS

#: `orchestrator/config.json`, read relative to the `orchestrator` package root, not this
#: submodule's own directory (`presentation/`).
_CONFIG_PATH = Path(__file__).resolve().parent.parent / 'config.json'

# Display tails only; every aggregate still covers the complete deduplicated history.
RECENT_EVENTS = 500
RECENT_METRICS = 2000
RECENT_ADAPTIVE = 500
RECENT_RUNS = 200

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


def _rate_provenance(metrics: Iterable[dict]) -> dict[str, Any]:
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


LEAD_SIZE_ORDER = ('small', 'standard', 'large')


def _lead_sizes(orchestrated: list[dict], runs: list[dict]) -> list[dict[str, Any]]:
    """Lead cost and run verification grouped by the triage-chosen `lead_size` tag.

    Only rows the bridge tagged with `lead_size` count (Phase A onward); a run is
    attributed to every size it used (an escalated run appears under both).
    """
    verdict = {str(r.get('run_id')): r.get('verification') for r in runs}
    groups: dict[str, dict[str, Any]] = {}
    for row in orchestrated:
        size = row.get('lead_size')
        role = str(row.get('role') or row.get('capability_class') or '')
        if size not in LEAD_SIZE_ORDER or row.get('event') != 'model_call' or not role.startswith('lead'):
            continue
        g = groups.setdefault(size, {'cost': 0.0, 'calls': 0, 'runs': set(), 'self': set()})
        g['cost'] += row_cost(row)
        g['calls'] += 1
        rid = str(row.get('run_id'))
        g['runs'].add(rid)
        if row.get('lead_self_implemented'):
            g['self'].add(rid)
    out = []
    for size in LEAD_SIZE_ORDER:
        g = groups.get(size)
        if not g:
            continue
        verdicts = [verdict.get(rid) for rid in g['runs']]
        out.append({
            'lead_size': size, 'runs': len(g['runs']), 'calls': g['calls'], 'cost': g['cost'],
            'cost_per_run': records.ratio(g['cost'], len(g['runs'])),
            'verified_pass': sum(v == 'passed' for v in verdicts),
            'verified_fail': sum(v == 'failed' for v in verdicts),
            'verification_unknown': sum(v not in ('passed', 'failed') for v in verdicts),
            'self_implemented': len(g['self']),
        })
    return out


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


# --- per-panel reducers -------------------------------------------------------------------------
# Each reducer below takes the already-materialized, deduplicated `orchestrated` cohort (read from
# disk exactly once, in `build_data`) and returns one panel. They are independent of one another —
# none depends on another reducer having run first — so `build_data` can call them in any order.

def _role_panel(rows: list[dict]) -> dict[str, dict]:
    """Cost/rows/tokens grouped by `role`/`capability_class`. Feeds the "Cost by role" card.

    No key named `calls`: that name previously meant *rows* and silently reusing it with a new
    meaning is the same misread in a different place. `rows`, `call_rows` (cost-accountable rows)
    and `covered_calls` (real calls, summing `covers_calls`) are distinct.
    """
    role: dict[str, dict] = defaultdict(lambda: {'cost': 0, 'rows': 0, 'call_rows': 0,
                                                 'session_rows': 0, 'covered_calls': 0, 'tokens': 0})
    for r in rows:
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
    return role


def _runtime_panel(rows: list[dict]) -> dict[str, dict]:
    """Cost/rows/metering grouped by `agent_runtime`. Feeds the "Cost by agent runtime" card.

    Metered/unmetered are counted here too, so `metered + unmetered == call_rows` holds by
    construction — the old card read '309 calls · 110 metered · 16 unmetered'.
    """
    runtime: dict[str, dict] = defaultdict(lambda: {'cost': 0, 'rows': 0, 'call_rows': 0, 'session_rows': 0,
                                                     'covered_calls': 0, 'reported_cost': 0.0,
                                                     'estimated_cost': 0.0, 'metered_calls': 0,
                                                     'unmetered_calls': 0})
    for r in rows:
        granularity = records.classify(r)
        call_row = is_call_row(r)
        covered = records.covered_calls(r)
        # Accept the legacy/alternate `runtime` key so a runtime that mislabels the field does
        # not silently pool into 'unknown'.
        agent_runtime = r.get('agent_runtime') or r.get('runtime') or 'unknown'
        rt = runtime[agent_runtime]
        rt['cost'] += row_cost(r)
        rt['rows'] += 1
        rt['session_rows'] += 1 if granularity == records.SESSION else 0
        if call_row:
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
    return runtime


def _policy_panel(rows: list[dict], verified: set[str], dispatch_passed: set[str]) -> list[dict]:
    """Cost, verification, quality and cost-aggressiveness grouped by `policy_id`."""
    policies: dict[str, dict] = defaultdict(lambda: {'cost': 0, 'rows': 0, 'call_rows': 0, 'verified': set(),
                                                      'dispatch_pass': set(), 'quality': [], 'aggr': []})
    for r in rows:
        p = policies[r.get('policy_id') or 'unknown']
        p['cost'] += row_cost(r)
        p['rows'] += 1
        p['call_rows'] += 1 if is_call_row(r) else 0
        if r.get('task_id') is not None and str(r['task_id']) in verified:
            p['verified'].add(str(r['task_id']))
        if r.get('task_id') is not None and str(r['task_id']) in dispatch_passed:
            p['dispatch_pass'].add(str(r['task_id']))
        if r.get('quality_evidence_score') is not None:
            p['quality'].append(_num(r['quality_evidence_score']))
        if r.get('cost_aggressiveness') is not None:
            p['aggr'].append(_num(r['cost_aggressiveness']))
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
    return policy_rows


def _adaptive_panel(rows: list[dict]) -> dict[str, Any]:
    """The recent-decisions tail plus adaptive-routing health counters."""
    adaptive: deque[dict] = deque(maxlen=RECENT_ADAPTIVE)
    adaptive_total = 0
    explored = 0
    history_sufficient = 0
    actions: dict[str, int] = defaultdict(int)
    for r in rows:
        if r.get('event') == 'adaptive_route_decision':
            adaptive.append(r)
            adaptive_total += 1
            actions[str(r.get('route_action', 'unknown'))] += 1
            explored += bool(r.get('explored'))
            history_sufficient += bool(r.get('history_sufficient'))
    return {'adaptive': adaptive, 'adaptive_total': adaptive_total, 'explored': explored,
            'history_sufficient': history_sufficient, 'actions': actions}


def _risk_panel(rows: list[dict]) -> dict[str, Any]:
    """Context-miss, review-wait, shadow-review and quality/retry sample counts for the risk cards."""
    context_misses = sum(1 for r in rows if r.get('event') in _CONTEXT_MISS_EVENTS)
    context_packets = sum(1 for r in rows if r.get('event') == 'context_packet')
    review_wait = [_num(r.get('review_wait_ms')) / 1000 for r in rows if r.get('review_wait_ms') is not None]
    shadow = [r for r in rows if r.get('event') == 'shadow_review']
    false_pass = sum(1 for r in shadow if r.get('normal_pass') is True and r.get('shadow_pass') is False)
    over_reject = sum(1 for r in shadow if r.get('normal_pass') is False and r.get('shadow_pass') is True)
    quality_samples = sum(1 for r in rows if r.get('quality_evidence_score') is not None)
    retry_samples = sum(1 for r in rows if 'retry' in r)
    return {'context_misses': context_misses, 'context_packets': context_packets, 'review_wait': review_wait,
            'shadow': shadow, 'false_pass': false_pass, 'over_reject': over_reject,
            'quality_samples': quality_samples, 'retry_samples': retry_samples}


def _daily_trends_panel(rows: list[dict], verified: set[str], dispatch_passed: set[str]) -> list[dict]:
    """Per-day (`ts[:10]`) cost/verification/quality/retry/adaptive rollup, sorted by day."""
    daily: dict[str, dict] = defaultdict(lambda: {'cost': 0.0, 'rows': 0, 'call_rows': 0, 'verified': set(),
                                                   'dispatch_pass': set(), 'quality': [], 'aggr': [],
                                                   'retries': 0, 'adaptive': 0})
    for r in rows:
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
    return trends


# --- composition ---------------------------------------------------------------------------------

def build_data(root: Path, config: dict | None = None):
    """Read each deduplicated stream once, retaining only cohorts needed by the panel reducers.

    Interactive rows are folded during iteration; event and display tails are bounded.
    Orchestrated metrics, run events, outcomes, and exact-ID sets still scale with history.
    All metric definitions and verification joins use the full retained cohorts, not the tails.
    """
    config = config or read_json(_CONFIG_PATH, {})
    event_count = 0
    last_event_ts = ''
    conflict_rows = 0
    invalidations = 0
    run_events = []
    recent_events: deque[dict] = deque(maxlen=RECENT_EVENTS)
    for event in unique_records(iter_jsonl(root / STREAMS['event'])):
        event_count += 1
        recent_events.append(event)
        last_event_ts = max(last_event_ts, str(event.get('ts', '')))
        kind = event.get('event')
        conflict_rows += kind in _CONFLICT_EVENTS
        invalidations += kind == 'decision_invalidated'
        if event.get('run_id') is not None or kind == 'decision_invalidated':
            run_events.append(event)
    outcomes = list(unique_records(iter_jsonl(root / STREAMS['outcome'])))
    ingest_status = build_ingest_status(read_json(root / INGEST_STATUS_FILE, {}),
                                        now=datetime.now(timezone.utc))
    metric_count = 0
    last_metric_ts = ''
    orchestrated = []
    recent_metrics: deque[dict] = deque(maxlen=RECENT_METRICS)
    session_ids = set()
    interactive_sessions = {
        'rows': 0, 'calls': 0, 'aggregate_rows': 0, 'cost': 0.0, 'tokens': 0,
        'by_runtime': {}, 'sessions': NO_DATA,
    }

    def metric_rows():
        nonlocal metric_count, last_metric_ts
        for row in unique_records(iter_jsonl(root / STREAMS['metric'])):
            metric_count += 1
            recent_metrics.append(row)
            last_metric_ts = max(last_metric_ts, str(row.get('ts', '')))
            if is_session_ingest(row):
                covered = records.covered_calls(row)
                interactive_sessions['rows'] += 1
                interactive_sessions['calls'] += covered
                interactive_sessions['aggregate_rows'] += records.classify(row) == records.SESSION
                interactive_sessions['cost'] += row_cost(row)
                interactive_sessions['tokens'] += _int(row.get('input_tokens')) + _int(row.get('output_tokens'))
                if row.get('session_id') is not None:
                    session_ids.add(str(row['session_id']))
                agent_runtime = row.get('agent_runtime') or row.get('runtime') or 'unknown'
                br = interactive_sessions['by_runtime'].setdefault(agent_runtime, {'rows': 0, 'calls': 0, 'cost': 0.0})
                br['rows'] += 1
                br['calls'] += covered
                br['cost'] += row_cost(row)
            else:
                orchestrated.append(row)
            # Rate exposure includes ingested spend, without retaining all interactive rows.
            yield row

    rate_provenance = _rate_provenance(metric_rows())
    interactive_sessions['sessions'] = len(session_ids) if session_ids else NO_DATA

    verified, dispatch_passed = _verification_task_ids(orchestrated, outcomes)
    total = sum(row_cost(r) for r in orchestrated)
    waste = waste_cost(orchestrated)
    attribution = cost_attribution(orchestrated)
    # Per-call distribution over `records.is_per_call_cost_row` rows only: session aggregates carry
    # one cost for many calls and event rows carry none at all.
    distribution = cost_distribution(orchestrated)

    role = _role_panel(orchestrated)
    runtime = _runtime_panel(orchestrated)
    policy_rows = _policy_panel(orchestrated, verified, dispatch_passed)
    adaptive_state = _adaptive_panel(orchestrated)
    risk = _risk_panel(orchestrated)
    adaptive = adaptive_state['adaptive']
    adaptive_total = adaptive_state['adaptive_total']
    explored = adaptive_state['explored']
    history_sufficient = adaptive_state['history_sufficient']
    actions = adaptive_state['actions']

    outsum = outcome_summary(root, rows=outcomes)
    mature30 = [x for x in outsum if x['mature_30d']]
    delayed_bad = sum(1 for x in mature30 if x['bad_outcome'])
    runs = summarize_runs(orchestrated, run_events, outcomes)
    run_cov = evidence_coverage(runs)

    def action_count(name: str) -> Any:
        """Count of one adaptive action: a real `0` when decisions exist, `NO_DATA` when none do."""
        return actions.get(name, 0) if adaptive_total else NO_DATA

    overhead = orchestration_overhead(orchestrated)
    summary = {
        'total_cost': total,
        'reported_cost': attribution[REPORTED]['cost'],
        'estimated_cost': attribution[ESTIMATED]['cost'],
        'unmetered_calls': attribution[UNMETERED]['calls'],
        'call_rows': attribution['call_rows'],
        'covered_calls': attribution['covered_calls'],
        'cost_coverage': attribution['coverage'],
        'runs': run_cov['runs'],
        'runs_fully_priced': run_cov['runs_fully_priced'],
        'runs_with_elapsed': run_cov['runs_with_elapsed'],
        'priced_run_coverage': run_cov['priced_run_coverage'],
        'duration_coverage': run_cov['duration_coverage'],
        'verification_coverage': run_cov['verification_coverage'],
        'cost_provenance': run_cov['cost_provenance'],
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
        'fanout_rework': fanout_rework(run_events),
        'context_miss_rate': records.ratio(risk['context_misses'], risk['context_packets']),
        # A genuine 0 stays 0; with no producer for merge-conflict events at all, the absence is
        # reported as absence and the renderer labels it `not instrumented`.
        'conflicts': conflict_rows if conflict_rows else NO_DATA,
        'review_wait_p90_s': records.metric(quantile(risk['review_wait'], .9), len(risk['review_wait'])),
        'shadow_reviews': len(risk['shadow']),
        'shadow_false_pass_rate': records.ratio(risk['false_pass'], len(risk['shadow'])),
        'shadow_over_reject_rate': records.ratio(risk['over_reject'], len(risk['shadow'])),
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
        'rate_provenance': rate_provenance,
        'adaptive_decisions': adaptive_total,
        'adaptive_actions': dict(actions),
        'adaptive_action_counts': {name: action_count(name) for name in
                                   ('recommended_only', 'empirical_enforced', 'static_default',
                                    'fallback_insufficient_history')},
        'exploration_rate_observed': records.ratio(explored, adaptive_total),
        'history_sufficient_rate': records.ratio(history_sufficient, adaptive_total),
    }
    trends = _daily_trends_panel(orchestrated, verified, dispatch_passed)
    return {'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'last_event_ts': last_event_ts or None, 'last_metric_ts': last_metric_ts or None,
            'event_count': event_count, 'metric_count': metric_count,
            'summary': summary, 'waste': waste, 'by_role': role, 'by_runtime': runtime,
            'policies': policy_rows, 'trends': trends,
            'instrumentation': _instrumentation({
                'review_wait_p90_s': len(risk['review_wait']), 'context_miss_rate': risk['context_packets'],
                'fanout_rework': invalidations, 'conflicts': conflict_rows,
                'shadow_false_pass_rate': len(risk['shadow']), 'shadow_over_reject_rate': len(risk['shadow']),
                'quality': risk['quality_samples'], 'avg_quality_evidence': risk['quality_samples'],
                'retry_rate': risk['retry_samples']}),
            'routes': build_route_stats(orchestrated, outcomes), 'outcomes': outsum,
            'run_evidence': run_cov, 'runs': runs[-RECENT_RUNS:],
            'lead_sizes': _lead_sizes(orchestrated, runs),
            # flaky_stats only matches rows with event=='verification_result'; session-ingest rows
            # are event=='model_call' and never contribute, but we pass `orchestrated` for
            # consistency with the rest of this function's inputs.
            'flaky': flaky_stats(orchestrated),
            'interactive_sessions': interactive_sessions,
            'ingest_status': ingest_status,
            'features': feature_inventory(config.get('features', {})), 'adaptive': list(adaptive),
            'events': list(recent_events), 'metrics': list(recent_metrics)}

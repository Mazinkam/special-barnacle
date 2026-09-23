"""Economic metrics: cost provenance, per-call distributions, waste, coordination overhead.

Record classification lives in `orchestrator.records` and nowhere else. This module imports it;
`records` must never import this module, so the dependency stays one-directional (`economics ->
records`) and `from orchestrator import records` can never hit a cycle. `row_cost` is re-exported
from `records` rather than redefined so there is exactly one answer to "what does a row cost?".

Three rules govern everything below, each of them a fix for a metric that was arithmetically
derived but semantically false:

* **Per-call figures run over `records.is_per_call_cost_row`.** 88 live rows are whole-session
  aggregates holding $85.99 of $103.46 orchestrated spend (one claims 33,177,381 input tokens for a
  single "call"), and 195 of 410 rows carry no `cost_usd` at all. Averaging those with real calls is
  what produced a p50 of $0.0000 and a `4053665000.0x` tail ratio.
* **An empty denominator yields `records.NO_DATA`, never `0.0`.** A rate nobody measured is not a
  rate of zero.
* **Coordination and verification are different costs.** Review is the work that makes a result
  trustworthy; pooling it into "orchestration overhead" hides both numbers.
"""
from __future__ import annotations

from collections import defaultdict
from functools import lru_cache
from typing import Any

from . import method
from .records import (
    NO_DATA,
    SESSION,
    VERIFIED,
    classify,
    covered_calls,
    is_per_call_cost_row,
    metric,
    ratio,
    row_cost,
    verification_state,
)

REPORTED = 'reported'
ESTIMATED = 'estimated'
UNMETERED = 'unmetered'
TOKEN_KEYS = ('input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens')


__all__ = [
    'REPORTED', 'ESTIMATED', 'UNMETERED', 'TOKEN_KEYS', 'row_cost', 'has_reported_tokens',
    'cost_class', 'is_call_row', 'is_session_ingest', 'cost_attribution', 'verified_cost',
    'quantile', 'per_call_costs', 'cost_distribution', 'is_unsuccessful_attempt',
    'waste_cost', 'coordination_roles', 'verification_roles', 'orchestration_overhead',
    'fanout_rework', 'topology_regret',
]


def has_reported_tokens(row: dict) -> bool:
    """True only when the row reports a positive token count somewhere.

    All-zero usage measured nothing: HT writes `*_tokens=0` when a child crashes before
    reporting usage, and that must not read as 'this call was free'.
    """
    for key in TOKEN_KEYS:
        try:
            if int(float(row.get(key) or 0)) > 0:
                return True
        except (TypeError, ValueError):
            continue
    return False


def cost_class(row: dict) -> str:
    """Classify a record's cost provenance: provider-reported, estimated, or absent.

    `cost_source` is free text across runtimes (e.g. 'estimated-from-total-tokens-blended-rate',
    'controller-context-not-metered'), so normalize it here rather than trusting exact values.
    A cost with no stated provenance counts as estimated, never as reported: reported is the
    stronger claim and must be explicit.

    A $0 row is metered only when it also reports positive tokens — a genuinely free call was
    measured, whereas `cost_usd=0, cost_source='estimated-from-reported-tokens', *_tokens=0`
    (HT's shape for a child that crashed before reporting usage) is a coverage gap, not spend.
    This is the single classifier for summary cards, per-runtime cards, and run evidence.
    """
    source = str(row.get('cost_source') or '').strip().lower()
    measured = row_cost(row) > 0 or has_reported_tokens(row)
    if 'estimat' in source or 'blended' in source or 'derived' in source:
        return ESTIMATED if measured else UNMETERED
    if source in {'reported', 'provider', 'provider_reported', 'provider-reported', 'metered', 'measured', 'actual'}:
        return REPORTED if measured else UNMETERED
    if 'not_metered' in source or 'not-metered' in source or 'unmetered' in source or 'unknown' in source:
        return ESTIMATED if row_cost(row)>0 else UNMETERED
    return ESTIMATED if row_cost(row)>0 else UNMETERED


def is_call_row(row: dict) -> bool:
    """Rows that are *accountable* for cost — the coverage denominator.

    Deliberately NOT the same population as `records.is_per_call_cost_row`, and the difference is
    the whole point of having both:

    * `is_call_row` asks "should this row appear in the metering-coverage ledger?" A row whose
      `cost_source` says `unmetered` carries no number at all, yet real work happened; dropping it
      would make coverage read 100% by hiding the gap. So it *must* stay in the denominator.
    * `records.is_per_call_cost_row` asks "may this row contribute a per-call cost *sample*?" An
      unmetered row has no measurement to contribute, and a session aggregate's cost covers many
      calls, so both are excluded.

    Rule of thumb: counting *work* (coverage, reconciliation) uses `is_call_row`; computing *cost
    statistics* (percentiles, per-call means, tail ratio) uses `records.is_per_call_cost_row`.
    """
    if row.get('event') == 'model_call':
        return True
    return any(row.get(k) is not None for k in ('cost_usd', 'input_tokens', 'output_tokens', 'model', 'cost_source'))


def is_session_ingest(row: dict) -> bool:
    """Rows ingested from interactive sessions (not orchestrated runs)."""
    return row.get('source') == 'session_ingest' or row.get('role') == 'interactive_session'


def cost_attribution(rows: list[dict]) -> dict[str, Any]:
    """Split spend by provenance so an unmetered runtime never renders as $0 spend.

    The population is `is_call_row` (see its docstring): an explicitly unmetered row stays in the
    denominator. `call_rows` and each bucket's `calls` are therefore *row* counts, not call counts —
    session aggregates are one row each but stand for `records.covered_calls(row)` calls, reported
    separately as `covered_calls` so a caller can reconcile rows against calls instead of conflating
    them. `coverage` is `NO_DATA` when no row is accountable for cost at all, because "no rows" is
    not "0% metered".
    """
    buckets = {k: {'cost': 0.0, 'calls': 0} for k in (REPORTED, ESTIMATED, UNMETERED)}
    calls = 0
    covered = 0
    for row in rows:
        if not is_call_row(row):
            continue
        calls += 1
        covered += covered_calls(row)
        bucket = buckets[cost_class(row)]
        bucket['cost'] += row_cost(row)
        bucket['calls'] += 1
    metered = buckets[REPORTED]['calls'] + buckets[ESTIMATED]['calls']
    return {**buckets, 'call_rows': calls, 'covered_calls': covered,
            'coverage': ratio(metered, calls)}


def verified_cost(rows: list[dict]) -> float:
    """Total dollars across `rows` (model + CI + human), session aggregates included.

    A total, not a per-call figure: every row's spend is real spend regardless of granularity, so
    nothing is excluded here. Use `cost_distribution` for anything per-call.
    """
    return sum(row_cost(r) for r in rows)


# --- per-call cost distribution ---------------------------------------------------------------

def quantile(values: list[float], p: float) -> Any:
    """Linear-interpolated quantile, or `NO_DATA` for an empty population.

    Returning `NO_DATA` rather than `0.0` is what lets a tail ratio refuse to exist instead of
    dividing by a floored epsilon. Exported so percentile logic has one implementation.
    """
    if not values:
        return NO_DATA
    xs = sorted(values)
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(len(xs) - 1, lo + 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def per_call_costs(rows: list[dict]) -> list[float]:
    """Cost samples for per-call statistics: `records.is_per_call_cost_row` rows only.

    Excludes `classify(row) == SESSION` aggregates (their cost covers many calls) and non-cost
    event rows (`route_executed`, `adaptive_route_decision`, … — 195 of 410 live rows). This is the
    only population any percentile, mean or tail ratio may be computed from.
    """
    return [row_cost(r) for r in rows if is_per_call_cost_row(r)]


def cost_distribution(rows: list[dict]) -> dict[str, Any]:
    """Per-call cost distribution over `per_call_costs` — session aggregates excluded.

    Every value is `NO_DATA` when there are no per-call samples, so a caller cannot render a
    fabricated `$0.0000` p50. `session_rows` and `session_cost` are reported alongside so the
    excluded spend stays visible instead of silently disappearing; a consumer that wants a total
    should use `verified_cost`, not the sum of these percentiles.
    """
    costs = per_call_costs(rows)
    samples = len(costs)
    sessions = [r for r in rows if classify(r) == SESSION]
    return {
        'samples': samples,
        'call_cost': sum(costs),
        'mean_cost': metric(sum(costs) / samples if samples else None, samples),
        'p50_cost': metric(quantile(costs, .5), samples),
        'p90_cost': metric(quantile(costs, .9), samples),
        'p99_cost': metric(quantile(costs, .99), samples),
        'max_cost': metric(max(costs) if costs else None, samples),
        'session_rows': len(sessions),
        'session_cost': sum(row_cost(r) for r in sessions),
    }


# --- waste -------------------------------------------------------------------------------------

#: Events that are waste by their nature, whatever the attempt's verdict.
WASTE_EVENTS = frozenset({'branch_abandoned', 'duplicate_work', 'merge_conflict_resolution', 'rework'})

#: `result` spellings that state the attempt itself succeeded. `records.verification_state` already
#: maps both to `VERIFIED`; they are checked explicitly because the plan states the rule in these
#: terms and a future vocabulary change must not silently turn a success into waste.
_SUCCESS_RESULTS = frozenset({'pass', 'success'})


def is_unsuccessful_attempt(row: dict) -> bool:
    """Did *this attempt* fail to produce a usable result?

    `waste_cost` used to charge 100% of a row's cost as waste whenever `retry` was truthy, which
    bills a retry that *worked* as pure waste. A retry is only waste when the attempt it records did
    not succeed — so this asks the row's own verdict, via the one verification vocabulary
    (`records.verification_state`), and treats an unstated verdict as unsuccessful only in the
    context of a retry: `waste_cost` never calls this for a row that is not a retry.
    """
    return verification_state(row) != VERIFIED and row.get('result') not in _SUCCESS_RESULTS


def waste_cost(rows: list[dict]) -> dict[str, float]:
    """Dollars of waste by category.

    Precedence, highest first:

    1. an explicit `waste_reason` — the emitter's own claim, authoritative and unchanged;
    2. `retry` **and** `is_unsuccessful_attempt(row)` — a retry that succeeded is the cost of
       getting the work done, not waste. Only 12 live rows carry a nonzero `retry`, but they include
       expensive session aggregates, so this materially moves the reported 39.1% waste rate;
    3. an inherently wasteful event (`WASTE_EVENTS`).

    Session aggregates are included: their spend is real and a wasted session is wasted money. This
    is a total, not a per-call figure.
    """
    cats: defaultdict[str, float] = defaultdict(float)
    for r in rows:
        cost = row_cost(r)
        reason = r.get('waste_reason')
        if reason:
            cats[reason] += cost
        elif r.get('retry') and is_unsuccessful_attempt(r):
            cats['retry'] += cost
        elif r.get('event') in WASTE_EVENTS:
            cats[r['event']] += cost
    return dict(cats)


# --- coordination vs verification --------------------------------------------------------------

COORDINATION = 'coordination'
VERIFICATION = 'verification'

#: Bare role/capability spellings that actually appear in the live stream but are not in
#: `method.json`'s `roles` map. `lead` alone accounts for $13.07 across 63 rows — the most common
#: coordination role, and the one the previous hardcoded set missed while counting `technical_lead`
#: ($3.98, 8 rows).
STREAM_ROLE_ALIASES = frozenset({
    'lead', 'architect', 'technical_lead',
    'implementation_fast', 'implementation_strong', 'implementer', 'scout',
    'technical_review', 'security_review', 'qa_agent', 'qa', 'qa_worker', 'reviewer',
})

#: Work that is neither coordination nor verification: it *is* the product. Checked first so a name
#: can never be swept into a bucket by a suffix rule.
_PRODUCTION_ROLES = frozenset({
    'implementer', 'complex_implementer', 'implementation_fast', 'implementation_strong',
    'scout', 'worker', 'interactive_session',
})

#: Events whose cost is coordination however the row is labelled.
COORDINATION_EVENTS = frozenset({'coordination', 'merge_conflict_resolution'})


def _role_kind(name: Any) -> str | None:
    """Bucket one role/capability name, or `None` when it is neither coordination nor verification.

    Suffix rules (`*_review`, `*_verifier`, `*_lead`) exist so a capability added to `method.json`
    tomorrow is classified without editing this module; the explicit sets above pin the names whose
    spelling the suffix rules cannot infer (`lead`, `qa`, `reviewer`, `architect`).
    """
    key = str(name or '').strip().lower()
    if not key or key in _PRODUCTION_ROLES:
        return None
    if key in {'lead', 'architect', 'technical_lead'} or key.endswith('_lead'):
        return COORDINATION
    if key in {'qa', 'qa_agent', 'qa_worker', 'reviewer', 'verifier'}:
        return VERIFICATION
    if key.endswith('review') or key.endswith('reviewer') or key.endswith('verifier'):
        return VERIFICATION
    return None


@lru_cache(maxsize=1)
def _role_sets() -> dict[str, frozenset[str]]:
    """Role vocabulary derived from `method.json` plus the live-stream aliases.

    `method.json` is the canonical vocabulary (its `roles` map names both the role keys — `verifier`,
    `integration_verifier`, … — and the capabilities they resolve to), so it is read rather than
    copied: a second hardcoded copy of the role list is how `lead` came to be omitted.
    """
    names = set(STREAM_ROLE_ALIASES)
    roles = method.roles()
    names.update(roles)
    names.update(roles.values())
    return {
        COORDINATION: frozenset(n for n in names if _role_kind(n) == COORDINATION),
        VERIFICATION: frozenset(n for n in names if _role_kind(n) == VERIFICATION),
    }


def coordination_roles() -> frozenset[str]:
    """Role/capability names whose spend is coordination (lead, architect, technical_lead, …)."""
    return _role_sets()[COORDINATION]


def verification_roles() -> frozenset[str]:
    """Role/capability names whose spend is verification (reviews, verifiers, QA)."""
    return _role_sets()[VERIFICATION]


def _row_role_kind(row: dict) -> str | None:
    for key in ('role', 'capability_class', 'capability'):
        kind = _role_kind(row.get(key))
        if kind is not None:
            return kind
    return COORDINATION if row.get('event') in COORDINATION_EVENTS else None


def orchestration_overhead(rows: list[dict]) -> dict[str, Any]:
    """Share of spend that went to coordinating the work and to verifying it — reported separately.

    Returns a dict, not a scalar. Pooling review into "overhead" answers a question nobody asked:
    coordination is the price of the hierarchy and a candidate for reduction, while verification is
    the price of trusting the output and reducing it is a quality decision. A single pooled rate
    cannot support either judgement, and no scalar can be returned without re-pooling, so callers
    must read `coordination_rate` or `verification_rate` explicitly.

    Both rates are `NO_DATA` when total spend is zero: with nothing spent there is no share to
    report. Session aggregates are included — this is a share of total spend, not a per-call figure.
    """
    total = verified_cost(rows)
    costs: defaultdict[str, float] = defaultdict(float)
    for row in rows:
        kind = _row_role_kind(row)
        if kind is not None:
            costs[kind] += row_cost(row)
    return {
        'total_cost': total,
        'coordination_cost': costs[COORDINATION],
        'verification_cost': costs[VERIFICATION],
        'coordination_rate': ratio(costs[COORDINATION], total),
        'verification_rate': ratio(costs[VERIFICATION], total),
    }


def fanout_rework(events: list[dict]) -> Any:
    """Average tasks invalidated per `decision_invalidated` event, or `NO_DATA`.

    Nothing in this repository emits `decision_invalidated` (see `records.UNINSTRUMENTED_FIELDS`),
    so `NO_DATA` is the honest answer for every live stream today; `0.0` claimed a fan-out
    multiplier had been measured at zero.
    """
    invalid = [e for e in events if e.get('event') == 'decision_invalidated']
    affected = sum(int(float(e.get('affected_tasks', 0) or 0)) for e in invalid)
    return ratio(affected, len(invalid))


def topology_regret(current: dict, comparable: list[dict]) -> float | None:
    # Simple, transparent estimate: difference from cheapest comparable topology with no lower stable quality.
    cost = current.get('verified_cost_usd')
    quality = current.get('stable_quality')
    if cost is None or quality is None:
        return None
    candidates = [r for r in comparable if r.get('verified_cost_usd') is not None and (r.get('stable_quality') or 0) >= quality - .005]
    if not candidates:
        return None
    return max(0.0, cost - min(r['verified_cost_usd'] for r in candidates))

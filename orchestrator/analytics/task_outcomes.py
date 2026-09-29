"""One normalized `task_outcome` per run, built on `run_evidence.summarize_runs` (spec §1.1).

This is a view, not a second ledger: every value comes from the existing per-run evidence join
plus the run's own call rows for strata. Missing evidence stays `unknown`/`None`.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from orchestrator import records
from orchestrator.economics import is_session_ingest, quantile
from orchestrator.method import load_method
from orchestrator.run_evidence import summarize_runs

_RISK_ORDER = {'low': 0, 'medium': 1, 'high': 2, 'critical': 3}
_EXECUTION = {'completed', 'failed', 'cancelled', 'interrupted'}
_VERIFICATION = {'passed': 'pass', 'failed': 'fail'}


def _band(complexity: float | None) -> str | None:
    if complexity is None:
        return None
    for b in load_method()['rules']['lead_sizing']['by_complexity']:
        if b['min'] <= complexity <= b['max']:
            return b['size']
    return None


def _strata(rows: list[dict]) -> dict[str, Any]:
    calls = [r for r in rows if records.classify(r) == records.CALL]
    cx = [float(r['complexity']) for r in calls if isinstance(r.get('complexity'), (int, float))]
    risks = [r['risk'] for r in calls if r.get('risk') in _RISK_ORDER]
    classes = Counter(r['task_class'] for r in calls if r.get('task_class'))
    complexity = max(cx) if cx else None
    return {
        'task_class': classes.most_common(1)[0][0] if classes else None,
        'complexity': complexity,
        'complexity_band': _band(complexity),
        'risk': max(risks, key=_RISK_ORDER.__getitem__) if risks else None,
        'usage_partial_calls': sum(1 for r in calls if r.get('usage_scope') == 'partial'),
    }


def task_outcomes(metrics: list[dict], events: list[dict], outcomes: list[dict], **summarize_kwargs) -> list[dict]:
    by_run: dict[str, list[dict]] = defaultdict(list)
    for r in metrics:
        if r.get('run_id') is not None and not is_session_ingest(r):
            by_run[str(r['run_id'])].append(r)
    event_runs = {str(e['run_id']) for e in events if e.get('run_id') is not None}
    outcome_runs = {str(o['run_id']) for o in outcomes if o.get('run_id') is not None}
    blocked = {str(o['run_id']) for o in outcomes
               if o.get('run_id') is not None and o.get('task_id') == 'run-complete' and o.get('outcome') == 'blocked'}
    result = []
    for ev in summarize_runs(metrics, events, outcomes, **summarize_kwargs):
        rid = ev['run_id']
        if not any(records.classify(r) != records.EVENT for r in by_run.get(rid, [])) \
                and rid not in event_runs and rid not in outcome_runs:
            continue  # decision-only evidence never counts as an outcome
        strata = _strata(by_run.get(rid, []))
        is_blocked = rid in blocked
        result.append({
            'run_id': rid,
            'execution_status': ev['status'] if ev['status'] in _EXECUTION else 'unknown',
            'verification': 'unknown' if is_blocked else _VERIFICATION.get(ev['verification'], 'unknown'),
            'blocked': is_blocked,
            **{k: strata[k] for k in ('task_class', 'complexity', 'complexity_band', 'risk')},
            'started_at': ev['started_at'], 'finished_at': ev['finished_at'],
            'elapsed_ms': ev['elapsed_ms'], 'elapsed_source': ev['elapsed_source'],
            'cost_known_usd': ev['cost_known_usd'],
            'cost_complete': bool(ev['cost_complete']) and strata['usage_partial_calls'] == 0,
            'usage_partial_calls': strata['usage_partial_calls'],
            'fix_rounds': ev.get('fix_rounds'),
            'provider_retries': ev.get('provider_retries', 0),
            'delayed_bad_outcome': ev['delayed_bad_outcome'],
        })
    return result


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def _q(xs: list[float], p: float) -> float | None:
    v = quantile(xs, p)
    return None if records.is_no_data(v) else v


def summarize_task_outcomes(rows: list[dict], key: str = 'complexity_band') -> dict[str, dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[str(r.get(key) or 'unknown')].append(r)
    out: dict[str, dict] = {}
    for name, g in groups.items():
        n = len(g)
        passes = sum(1 for r in g if r['verification'] == 'pass')
        fails = sum(1 for r in g if r['verification'] == 'fail')
        elapsed = [float(r['elapsed_ms']) for r in g if r.get('elapsed_ms') is not None]
        all_complete = all(r.get('cost_complete') for r in g)
        costs = [float(r['cost_known_usd']) for r in g if r.get('cost_known_usd') is not None]
        known_cost = sum(costs) if costs else None
        fixes = [float(r['fix_rounds']) for r in g if r.get('fix_rounds') is not None]
        out[name] = {
            'n': n, 'pass': passes, 'fail': fails, 'unknown': n - passes - fails,
            'blocked': sum(1 for r in g if r.get('blocked')),
            'pass_rate_known': passes / (passes + fails) if passes + fails else None,
            'verified_rate_all': passes / n if n else None,
            'elapsed_p50_ms': _q(elapsed, .5), 'elapsed_p90_ms': _q(elapsed, .9),
            'elapsed_coverage': len(elapsed) / n if n else None,
            'cost_known_usd': known_cost,
            'cost_complete_coverage': sum(1 for r in g if r.get('cost_complete')) / n if n else None,
            # Finite only when every run's cost is complete and at least one run verified.
            'cost_per_verified_usd': known_cost / passes if passes and all_complete and known_cost is not None else None,
            'fix_rounds_mean': _mean(fixes),
            'provider_retries_mean': _mean([float(r.get('provider_retries') or 0) for r in g]),
            'delayed_bad': sum(1 for r in g if r.get('delayed_bad_outcome')),
        }
    return out

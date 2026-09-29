"""Paired task-cluster statistics (spec §2.4). Repeats are averaged within a task, never pooled."""
from __future__ import annotations

import random
import statistics
from collections import defaultdict

MIN_TASKS = 10
_FAILED_STATUSES = {'timeout', 'budget_exceeded', 'infra_error', 'failed'}


def task_means(rows: list[dict], arm: str) -> dict[str, dict]:
    by = defaultdict(list)
    for r in rows:
        if r.get('arm') == arm and 'replaced_by' not in r:
            by[r['task_id']].append(r)
    out = {}
    for tid, rs in by.items():
        passes = [r.get('verdict') == 'pass' for r in rs]
        out[tid] = {'pass_frac': sum(passes) / len(rs), 'all_pass': all(passes),
                    'elapsed_ms': statistics.median(r['elapsed_ms'] for r in rs),
                    'cost_usd': sum(r.get('cost_usd') or 0 for r in rs),
                    'cost_complete': all(r.get('cost_complete') for r in rs), 'n': len(rs)}
    return out


def _bootstrap(diffs: list[float], reps: int, seed: int) -> list[float]:
    rng = random.Random(seed); n = len(diffs)
    return sorted(sum(rng.choice(diffs) for _ in range(n)) / n for _ in range(reps))


def paired_lower_bound(diffs: list[float], *, alpha: float = 0.05, reps: int = 10000, seed: int = 0) -> float | None:
    if len(diffs) < MIN_TASKS or len(set(diffs)) == 1:
        return None
    return _bootstrap(diffs, reps, seed)[int(alpha * reps)]


def paired_upper_bound(diffs: list[float], *, alpha: float = 0.05, reps: int = 10000, seed: int = 0) -> float | None:
    if len(diffs) < MIN_TASKS or len(set(diffs)) == 1:
        return None
    return _bootstrap(diffs, reps, seed)[int((1 - alpha) * reps) - 1]


def quality_verdict(control: dict, candidate: dict, *, margin: float = 0.05, seed: int = 0) -> dict:
    tasks = sorted(set(control) & set(candidate))
    d_pass = [candidate[t]['pass_frac'] - control[t]['pass_frac'] for t in tasks]
    d_all = [float(candidate[t]['all_pass']) - float(control[t]['all_pass']) for t in tasks]
    lb_p, ub_p = paired_lower_bound(d_pass, seed=seed), paired_upper_bound(d_pass, seed=seed)
    lb_a = paired_lower_bound(d_all, seed=seed + 1)
    if ub_p is not None and ub_p < -margin:
        verdict, reason = 'fail', 'upper bound of completion difference below -margin'
    elif lb_p is not None and lb_p > -margin and lb_a is not None and lb_a >= 0:
        verdict, reason = 'pass', 'lower bounds satisfy margin and consistency'
    else:
        verdict, reason = 'inconclusive', 'insufficient tasks, zero variance, or bounds straddle the margin'
    return {'verdict': verdict, 'reason': reason, 'n_tasks': len(tasks), 'lb_pass': lb_p, 'ub_pass': ub_p, 'lb_all_pass': lb_a,
            'mean_diff_pass': (sum(d_pass) / len(d_pass)) if d_pass else None}


def efficiency_summary(control: dict, candidate: dict, *, seed: int = 0) -> dict:
    tasks = sorted(set(control) & set(candidate))
    def ratios(key, only_complete=False):
        xs = [candidate[t][key] / control[t][key] for t in tasks
              if control[t][key] and (not only_complete or (control[t]['cost_complete'] and candidate[t]['cost_complete']))]
        if len(xs) < MIN_TASKS:
            return {'n': len(xs), 'median_ratio': statistics.median(xs) if xs else None, 'ci': None}
        rng = random.Random(seed); boots = sorted(statistics.median(rng.choice(xs) for _ in xs) for _ in range(2000))
        return {'n': len(xs), 'median_ratio': statistics.median(xs), 'ci': (boots[50], boots[1949])}
    return {'elapsed': ratios('elapsed_ms'), 'cost': ratios('cost_usd', only_complete=True), 'n_tasks': len(tasks)}

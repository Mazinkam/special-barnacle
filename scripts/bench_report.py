#!/usr/bin/env python3
"""Paired benchmark report (spec §2.4). Descriptive per stratum; verdicts only from bench.stats."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bench.stats import MIN_TASKS, active_rows, efficiency_summary, quality_verdict, task_means  # noqa: E402

STATUSES = ('completed', 'failed', 'timeout', 'budget_exceeded', 'infra_error')


def _groups(rows, by):
    if by == 'all':
        return {'all': rows}
    out: dict = {}
    for r in rows:
        out.setdefault(f'{by}={r.get(by)}', []).append(r)
    return out


def _fmt(v, pct=False):
    if v is None:
        return 'n/a'
    return f'{v * 100:+.1f}pp' if pct else f'{v:.2f}'


def analyse(rows, control, candidates, by):
    result = []
    for dim in by:
        for name, g in sorted(_groups(rows, dim).items()):
            ctrl = task_means(g, control)
            for cand in candidates:
                c = task_means(g, cand)
                status = {arm: Counter(r['execution_status'] for r in active_rows(g) if r['arm'] == arm) for arm in (control, cand)}
                result.append({'group': name, 'control': control, 'candidate': cand, 'status': {k: dict(v) for k, v in status.items()},
                               'quality': quality_verdict(ctrl, c), 'efficiency': efficiency_summary(ctrl, c),
                               'exploratory': len(set(ctrl) & set(c)) < MIN_TASKS})
    return result


def render(rows, control='current', candidates=('tiered', 'direct'), by=('all', 'scope_band', 'risk')) -> str:
    lines = []
    for a in analyse(rows, control, candidates, by):
        q, e = a['quality'], a['efficiency']
        tag = ' [exploratory]' if a['exploratory'] else ''
        lines.append(f"{a['group']}: {a['candidate']} vs {a['control']}{tag}")
        for arm, counts in a['status'].items():
            lines.append('  ' + arm + ': ' + ' '.join(f'{s} {counts.get(s, 0)}' for s in STATUSES))
        lines.append(f"  quality: {q['verdict']} (n={q['n_tasks']}, mean diff {_fmt(q['mean_diff_pass'], True)}, "
                     f"LB {_fmt(q['lb_pass'], True)}, pass^k LB {_fmt(q['lb_all_pass'], True)}) — {q['reason']}")
        lines.append(f"  elapsed ratio {_fmt(e['elapsed']['median_ratio'])} CI {e['elapsed']['ci']}; "
                     f"cost ratio {_fmt(e['cost']['median_ratio'])} CI {e['cost']['ci']} (complete-cost tasks {e['cost']['n']}/{e['n_tasks']})")
    return '\n'.join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--journal', type=Path, required=True)
    p.add_argument('--control', default='current')
    p.add_argument('--candidates', default='tiered,direct')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    rows = [json.loads(l) for l in a.journal.read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r.get('event') != 'started']
    cands = tuple(c for c in a.candidates.split(',') if c)
    if a.json:
        print(json.dumps(analyse(rows, a.control, cands, ('all', 'scope_band', 'risk')), indent=2, default=str))
    else:
        print(render(rows, a.control, cands))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

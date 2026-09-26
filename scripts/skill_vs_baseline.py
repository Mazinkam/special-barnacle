#!/usr/bin/env python3
"""Compare the orchestrator's actual spend against flat single-model baselines.

Reads metrics.jsonl, filters out session-ingest noise, reprices each orchestrated
record at three flat-model brackets (haiku / sonnet / opus), and prints a side-by-
side report: cost, success rate, cost-per-success, retry rate, waste. The intent is
to answer "is the orchestrator earning its keep?" without changing the dashboard or
touching the data stream.

Run from anywhere:
    python3 skill_vs_baseline.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

# Reuse the orchestrator's pricing module so rates stay in sync with config.json.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # .../hierarchical-agent-orchestrator/

from orchestrator.economics import is_session_ingest  # noqa: E402
from orchestrator.pricing import estimate_cost_usd, load_pricing  # noqa: E402

STATE = Path('~/.local/state/coding-agent-orchestrator').expanduser()
METRICS = STATE / 'metrics.jsonl'

# Flat-model counterfactual brackets. Picked to bracket reality: the orchestrator's
# dominant model (sonnet-4-5), the cheapest haiku tier, the most expensive opus tier.
# Repricing uses the SAME token profile the orchestrator actually spent; only the
# per-token rate changes.
BRACKETS = [
    ('haiku-4-5 (budget)', 'claude-haiku-4-5'),
    ('sonnet-4-5 (common)', 'claude-sonnet-4-5'),
    ('opus-4-5 (premium)', 'claude-opus-4-5'),
]

PASS_VALUES = {'pass', 'success', 'ok', 'reported'}


def load_records(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    bad = 0
    with path.open(encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            if isinstance(obj, dict):
                rows.append(obj)
    if bad:
        print(f'warning: {bad} malformed lines skipped', file=sys.stderr)
    return rows


def partition(records: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (orchestrated, interactive_session)."""
    orchestrated, interactive = [], []
    for r in records:
        if is_session_ingest(r):
            interactive.append(r)
        else:
            orchestrated.append(r)
    return orchestrated, interactive


def is_decision_record(r: dict[str, Any]) -> bool:
    """Decisions aren't work — they carry recommended_* estimates but no real cost."""
    return r.get('event') == 'adaptive_route_decision'


def reprice(record: dict[str, Any], model: str, pricing: dict[str, Any]) -> float | None:
    """Cost if the SAME input/output tokens were billed at `model`. None if no rate."""
    est = estimate_cost_usd(
        model=model,
        input_tokens=record.get('input_tokens'),
        output_tokens=record.get('output_tokens'),
        cached_input_tokens=record.get('cached_input_tokens'),
        cache_write_tokens=record.get('cache_write_tokens'),
        pricing=pricing,
    )
    if est is None:
        return None
    return float(est['cost_usd'])


def aggregate(records: list[dict[str, Any]], pricing: dict[str, Any]) -> dict[str, Any]:
    """Compute the headline metrics for one record set."""
    work = [r for r in records if not is_decision_record(r)]
    priced = [r for r in work if (r.get('cost_usd') or 0) > 0]
    cost_actual = sum(float(r.get('cost_usd') or 0) for r in priced)
    pass_count = sum(1 for r in work if str(r.get('result', '')).lower() in PASS_VALUES)
    retry_count = sum(1 for r in work if (r.get('retry') or 0) > 0)
    waste_count = sum(1 for r in work if r.get('waste_reason'))
    input_tokens = sum(int(r.get('input_tokens') or 0) for r in priced)
    output_tokens = sum(int(r.get('output_tokens') or 0) for r in priced)
    complexity = [float(r['complexity']) for r in work if r.get('complexity') is not None]
    duration_ms = [int(r['duration_ms']) for r in work if r.get('duration_ms')]

    bracket_costs: dict[str, float | None] = {}
    bracket_priced = 0
    for label, model in BRACKETS:
        total = 0.0
        priced_here = 0
        for r in priced:
            c = reprice(r, model, pricing)
            if c is None:
                continue
            total += c
            priced_here += 1
        # Only emit a bracket value if we repriced at least half of the priced set;
        # otherwise the number is misleading (some records have unmatched models).
        if priced_here >= max(1, len(priced) // 2):
            bracket_costs[label] = round(total, 4)
        else:
            bracket_costs[label] = None
        bracket_priced = max(bracket_priced, priced_here)

    return {
        'records': len(records),
        'work_records': len(work),
        'decision_records': len(records) - len(work),
        'priced_records': len(priced),
        'cost_actual_usd': round(cost_actual, 4),
        'pass_count': pass_count,
        'fail_count': len(work) - pass_count,
        'success_rate': round(pass_count / len(work), 4) if work else None,
        'retry_count': retry_count,
        'retry_rate': round(retry_count / len(work), 4) if work else None,
        'waste_count': waste_count,
        'waste_rate': round(waste_count / len(work), 4) if work else None,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'complexity_avg': round(sum(complexity) / len(complexity), 2) if complexity else None,
        'duration_ms_total': sum(duration_ms),
        'bracket_costs': bracket_costs,
        'cost_per_success_actual': round(cost_actual / pass_count, 4) if pass_count else None,
        'bracket_cost_per_success': {
            label: (round(bc / pass_count, 4) if (bc is not None and pass_count) else None)
            for label, bc in bracket_costs.items()
        },
    }


def per_breakdown(records: list[dict[str, Any]], key: str, pricing: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Aggregate by a field (role, capability_class, model) with actual + sonnet baseline."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in records:
        if is_decision_record(r):
            continue
        v = r.get(key)
        if v in (None, ''):
            v = '(unset)'
        groups[str(v)].append(r)
    out: dict[str, dict[str, Any]] = {}
    common_model = 'claude-sonnet-4-5'
    for name, rows in groups.items():
        priced = [r for r in rows if (r.get('cost_usd') or 0) > 0]
        cost_actual = sum(float(r.get('cost_usd') or 0) for r in priced)
        pass_count = sum(1 for r in rows if str(r.get('result', '')).lower() in PASS_VALUES)
        baseline = 0.0
        baseline_priced = 0
        for r in priced:
            c = reprice(r, common_model, pricing)
            if c is None:
                continue
            baseline += c
            baseline_priced += 1
        baseline_cost = round(baseline, 4) if baseline_priced >= max(1, len(priced) // 2) else None
        out[name] = {
            'calls': len(rows),
            'priced': len(priced),
            'cost_actual_usd': round(cost_actual, 4),
            'cost_per_call_usd': round(cost_actual / len(priced), 4) if priced else None,
            'pass_count': pass_count,
            'success_rate': round(pass_count / len(rows), 4) if rows else None,
            'baseline_sonnet_4_5_usd': baseline_cost,
            'delta_usd': (
                round(cost_actual - baseline_cost, 4)
                if baseline_cost is not None and cost_actual is not None else None
            ),
        }
    return out


def fmt_money(v: float | None) -> str:
    if v is None:
        return '    n/a'
    return f'${v:>8,.2f}'


def fmt_pct(v: float | None) -> str:
    if v is None:
        return '   n/a'
    return f'{v*100:5.1f}%'


def section(title: str) -> None:
    print()
    print(title)
    print('-' * len(title))


def print_breakdown(name: str, breakdown: dict[str, dict[str, Any]], top: int = 12) -> None:
    items = sorted(breakdown.items(), key=lambda kv: -(kv[1]['cost_actual_usd'] or 0))[:top]
    print(f'  {"group":<28} {"calls":>6} {"priced":>6} {"actual":>10} '
          f'{"@sonnet":>10} {"delta":>10} {"pass":>5} {"rate":>6}')
    print(f'  {"-"*28} {"-"*6} {"-"*6} {"-"*10} {"-"*10} {"-"*10} {"-"*5} {"-"*6}')
    for k, v in items:
        delta = v['delta_usd']
        delta_s = f'${delta:>+9,.2f}' if delta is not None else '      n/a'
        print(f'  {k[:28]:<28} {v["calls"]:>6} {v["priced"]:>6} '
              f'{fmt_money(v["cost_actual_usd"])} '
              f'{fmt_money(v["baseline_sonnet_4_5_usd"])} {delta_s:>10} '
              f'{v["pass_count"]:>5} {fmt_pct(v["success_rate"])}')


def main() -> int:
    if not METRICS.exists():
        print(f'error: no metrics stream at {METRICS}', file=sys.stderr)
        return 1

    pricing = load_pricing()
    if not pricing.get('enabled'):
        print('warning: pricing disabled in config; baselines will be n/a', file=sys.stderr)

    records = load_records(METRICS)
    orchestrated, interactive = partition(records)

    section('Stream volume')
    print(f'  total records:               {len(records):,}')
    print(f'  orchestrated (work):         {len(orchestrated):,}')
    print(f'  interactive_session (ingest):{len(interactive):,}')

    agg_o = aggregate(orchestrated, pricing)
    agg_i = aggregate(interactive, pricing)

    section('Orchestrated work — actual vs flat baselines')
    print(f'  work records:                {agg_o["work_records"]:,}')
    print(f'  priced records:              {agg_o["priced_records"]:,}')
    print(f'  decision events skipped:     {agg_o["decision_records"]}')
    print(f'  total actual cost:           {fmt_money(agg_o["cost_actual_usd"])}')
    print(f'  pass / fail:                 {agg_o["pass_count"]} / {agg_o["fail_count"]}')
    print(f'  success rate:                {fmt_pct(agg_o["success_rate"])}')
    print(f'  retry rate:                  {fmt_pct(agg_o["retry_rate"])}')
    print(f'  waste rate:                  {fmt_pct(agg_o["waste_rate"])}')
    print(f'  tokens in/out:               {agg_o["input_tokens"]:,} / {agg_o["output_tokens"]:,}')
    print(f'  complexity avg:              {agg_o["complexity_avg"]}')
    print(f'  cost per success (actual):   {fmt_money(agg_o["cost_per_success_actual"])}')
    print()
    print(f'  {"bracket":<24} {"flat cost":>12} {"per-call":>10} {"per success":>12}')
    print(f'  {"-"*24} {"-"*12} {"-"*10} {"-"*12}')
    for label, _ in BRACKETS:
        bc = agg_o['bracket_costs'][label]
        cps = agg_o['bracket_cost_per_success'][label]
        per_call = (bc / agg_o['priced_records']) if (bc is not None and agg_o['priced_records']) else None
        print(f'  {label:<24} {fmt_money(bc):>12} {fmt_money(per_call):>10} {fmt_money(cps):>12}')
    # delta vs each bracket
    print()
    print('  delta vs actual (negative = orchestrator cheaper)')
    for label, _ in BRACKETS:
        bc = agg_o['bracket_costs'][label]
        if bc is None or agg_o['cost_actual_usd'] is None:
            print(f'    {label:<24}    n/a')
        else:
            d = agg_o['cost_actual_usd'] - bc
            print(f'    {label:<24} {d:>+10,.2f}')

    section('Interactive ingests (for context — not part of skill performance)')
    print(f'  records:                     {agg_i["work_records"]:,}')
    print(f'  total cost:                  {fmt_money(agg_i["cost_actual_usd"])}')
    print(f'  pass rate (n/a for ingest):  {fmt_pct(agg_i["success_rate"])}')
    print(f'  tokens in/out:               {agg_i["input_tokens"]:,} / {agg_i["output_tokens"]:,}')

    section('Per-role: orchestrated actual vs sonnet-4-5 flat')
    print_breakdown('role', per_breakdown(orchestrated, 'role', pricing))
    section('Per-capability: orchestrated actual vs sonnet-4-5 flat')
    print_breakdown('capability_class', per_breakdown(orchestrated, 'capability_class', pricing))
    section('Per-model: orchestrated actual (no baseline — model is the choice)')
    print_breakdown('model', per_breakdown(orchestrated, 'model', pricing))

    section('Cost-per-success ladder')
    print('  Compares actual cost per successful task against each flat bracket.')
    cps_actual = agg_o['cost_per_success_actual']
    print(f'    actual        : {fmt_money(cps_actual)}')
    for label, _ in BRACKETS:
        cps = agg_o['bracket_cost_per_success'][label]
        print(f'    {label:<14}: {fmt_money(cps)}')
    if cps_actual and all(agg_o['bracket_cost_per_success'][l] is not None for l, _ in BRACKETS):
        sonnet_cps = agg_o['bracket_cost_per_success']['sonnet-4-5 (common)']
        if sonnet_cps:
            print(f'\n  orchestrator vs sonnet-flat: {(cps_actual - sonnet_cps):+.4f} per success '
                  f'({(cps_actual - sonnet_cps) / sonnet_cps * 100:+.1f}%)')

    print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

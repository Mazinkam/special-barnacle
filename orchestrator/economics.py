from __future__ import annotations
from collections import defaultdict
from typing import Any

REPORTED='reported'
ESTIMATED='estimated'
UNMETERED='unmetered'

def row_cost(row:dict)->float:
    return sum(float(row.get(k,0) or 0) for k in ('cost_usd','ci_cost_usd','human_cost_usd'))

def cost_class(row:dict)->str:
    """Classify a record's cost provenance: provider-reported, estimated, or absent.

    `cost_source` is free text across runtimes (e.g. 'estimated-from-total-tokens-blended-rate',
    'controller-context-not-metered'), so normalize it here rather than trusting exact values.
    A cost with no stated provenance counts as estimated, never as reported: reported is the
    stronger claim and must be explicit.
    """
    source=str(row.get('cost_source') or '').strip().lower()
    has_cost=row_cost(row)>0
    if 'estimat' in source or 'blended' in source or 'derived' in source: return ESTIMATED
    if source in {'reported','provider','provider_reported','provider-reported','metered','measured','actual'}:
        return REPORTED if has_cost else UNMETERED
    if 'not_metered' in source or 'not-metered' in source or 'unmetered' in source or 'unknown' in source:
        return ESTIMATED if has_cost else UNMETERED
    return ESTIMATED if has_cost else UNMETERED

def is_call_row(row:dict)->bool:
    """Rows that are accountable for cost.

    A row qualifies by being a model call, by carrying cost/usage fields, or by declaring a
    `cost_source` at all: a runtime that explicitly states 'unmetered' is asserting that real
    work happened without measurement, which must land in the unmetered bucket rather than
    vanishing from the coverage denominator.
    """
    if row.get('event')=='model_call': return True
    return any(row.get(k) is not None for k in ('cost_usd','input_tokens','output_tokens','model','cost_source'))

def cost_attribution(rows:list[dict])->dict[str,Any]:
    """Split spend by provenance so an unmetered runtime never renders as $0 spend."""
    buckets={k:{'cost':0.0,'calls':0} for k in (REPORTED,ESTIMATED,UNMETERED)}
    calls=0
    for row in rows:
        if not is_call_row(row): continue
        calls+=1
        bucket=buckets[cost_class(row)]
        bucket['cost']+=row_cost(row); bucket['calls']+=1
    metered=buckets[REPORTED]['calls']+buckets[ESTIMATED]['calls']
    return {**buckets,'call_rows':calls,'coverage':metered/calls if calls else None}

def verified_cost(rows:list[dict])->float:
    return sum(float(r.get('cost_usd',0) or 0)+float(r.get('ci_cost_usd',0) or 0)+float(r.get('human_cost_usd',0) or 0) for r in rows)

def waste_cost(rows:list[dict])->dict[str,float]:
    cats=defaultdict(float)
    for r in rows:
        cost=float(r.get('cost_usd',0) or 0)+float(r.get('ci_cost_usd',0) or 0)+float(r.get('human_cost_usd',0) or 0)
        reason=r.get('waste_reason')
        if reason: cats[reason]+=cost
        elif r.get('retry'): cats['retry']+=cost
        elif r.get('event') in {'branch_abandoned','duplicate_work','merge_conflict_resolution','rework'}: cats[r['event']]+=cost
    return dict(cats)

def orchestration_overhead(rows:list[dict])->float:
    total=verified_cost(rows)
    if not total: return 0.0
    roles={'architect','technical_lead','technical_review','integration_review'}
    overhead=sum(float(r.get('cost_usd',0) or 0) for r in rows if (r.get('role') or r.get('capability_class')) in roles or r.get('event') in {'coordination','merge_conflict_resolution'})
    return overhead/total

def fanout_rework(events:list[dict])->float:
    invalid=[e for e in events if e.get('event')=='decision_invalidated']
    if not invalid: return 0.0
    affected=sum(int(e.get('affected_tasks',0) or 0) for e in invalid)
    return affected/len(invalid)

def topology_regret(current:dict, comparable:list[dict])->float|None:
    # Simple, transparent estimate: difference from cheapest comparable topology with no lower stable quality.
    cost=current.get('verified_cost_usd'); quality=current.get('stable_quality')
    if cost is None or quality is None: return None
    candidates=[r for r in comparable if r.get('verified_cost_usd') is not None and (r.get('stable_quality') or 0)>=quality-.005]
    if not candidates: return None
    return max(0.0,cost-min(r['verified_cost_usd'] for r in candidates))

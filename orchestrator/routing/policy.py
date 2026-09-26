"""Policy simulation and recommendation, merged from the old `policy_simulation.py` and
`policy_recommendations.py` (B3, `docs/architecture-review.md`: "Remove modules that add
nothing" — `policy_recommendations.recommend_policy` only grid-searched `simulate_policy`, so
the two modules were never independent).
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from ..scheduler import recommend_package
from ..vocab import DEFAULT_MIN_SAMPLES


def simulate_policy(*, stats: list[dict[str, Any]], quality_floor: float, cost_aggressiveness: float,
                    min_samples: int = DEFAULT_MIN_SAMPLES) -> dict[str, Any]:
    """Approximate counterfactual using historical cohort summaries.

    This is intentionally labeled an estimate: it re-selects among routes that were actually observed
    in comparable cohorts. It does not claim to know unobserved model behavior.
    """
    cohorts=defaultdict(list)
    for s in stats:
        cohorts[(s.get('task_class','unknown'),s.get('complexity_bucket','unknown'),s.get('risk','medium'))].append(s)
    total_estimated=0.0
    total_weight=0
    weighted_quality=0.0
    selections=[]
    for (task_class, cb, risk), rows in sorted(cohorts.items()):
        # recover a representative complexity midpoint from the bucket
        try:
            lo,hi=[int(x) for x in cb.split('-')]
            complexity=(lo+hi)/2
        except Exception:
            complexity=5
        rec=recommend_package(task_class=task_class,complexity=complexity,risk=risk,
                              quality_floor=quality_floor,cost_aggressiveness=cost_aggressiveness,
                              stats=rows,min_samples=min_samples)
        ch=rec['choice']
        weight=max(1,sum(int(r.get('verified_tasks',0) or 0) for r in rows))
        total_weight += weight
        total_estimated += float(ch['estimated_verified_cost_usd'] or 0)*weight
        weighted_quality += float(ch['estimated_quality_evidence'] or 0)*weight
        selections.append({'task_class':task_class,'complexity_bucket':cb,'risk':risk,'weight':weight,
                           'choice':ch['package'],'estimated_verified_cost_usd':ch['estimated_verified_cost_usd'],
                           'estimated_quality_evidence':ch['estimated_quality_evidence'],'historical':ch['historical']})
    return {
        'estimated': True,
        'quality_floor': quality_floor,
        'cost_aggressiveness': cost_aggressiveness,
        'cohorts': len(selections),
        'weighted_items': total_weight,
        'estimated_total_verified_cost_usd': total_estimated,
        'estimated_avg_verified_cost_usd': total_estimated/total_weight if total_weight else None,
        'estimated_avg_quality_evidence': weighted_quality/total_weight if total_weight else None,
        'selections': selections,
        'warning': 'Counterfactual estimate from observed comparable cohorts; not a replay of unobserved model behavior.'
    }


def compare_policies(*, stats: list[dict[str, Any]], current: dict[str, float], candidate: dict[str, float], min_samples: int=DEFAULT_MIN_SAMPLES) -> dict[str, Any]:
    a=simulate_policy(stats=stats,quality_floor=current['quality_floor'],cost_aggressiveness=current['cost_aggressiveness'],min_samples=min_samples)
    b=simulate_policy(stats=stats,quality_floor=candidate['quality_floor'],cost_aggressiveness=candidate['cost_aggressiveness'],min_samples=min_samples)
    ac=a['estimated_avg_verified_cost_usd']; bc=b['estimated_avg_verified_cost_usd']
    aq=a['estimated_avg_quality_evidence']; bq=b['estimated_avg_quality_evidence']
    return {
        'estimated': True,
        'current': a,
        'candidate': b,
        'delta': {
            'avg_verified_cost_usd': None if ac is None or bc is None else bc-ac,
            'avg_verified_cost_percent': None if ac in {None,0} or bc is None else (bc-ac)/ac,
            'avg_quality_evidence_points': None if aq is None or bq is None else (bq-aq)*100,
        }
    }


def recommend_policy(*, stats:list[dict[str,Any]], current_quality_floor:float, current_cost_aggressiveness:float,
                     min_samples:int=DEFAULT_MIN_SAMPLES)->dict[str,Any]:
    """Search a small, conservative policy grid and return an estimated recommendation.

    This function never mutates config. It is suitable for the `policy_recommendations` feature;
    automatic tuning/promotion remains a separate opt-in control.
    """
    current=simulate_policy(stats=stats,quality_floor=current_quality_floor,cost_aggressiveness=current_cost_aggressiveness,min_samples=min_samples)
    candidates=[]
    floors=sorted({round(current_quality_floor+d,3) for d in (-.01,0,.01) if .80 <= current_quality_floor+d <= .999})
    aggs=sorted({round(max(0,min(1,current_cost_aggressiveness+d)),2) for d in (-.15,-.05,0,.05,.15)})
    for q in floors:
        for a in aggs:
            sim=simulate_policy(stats=stats,quality_floor=q,cost_aggressiveness=a,min_samples=min_samples)
            candidates.append(sim)
    cur_q=current.get('estimated_avg_quality_evidence')
    feasible=[c for c in candidates if c.get('estimated_avg_verified_cost_usd') is not None and (cur_q is None or c.get('estimated_avg_quality_evidence',0) >= min(current_quality_floor,cur_q))]
    best=min(feasible,key=lambda c:c['estimated_avg_verified_cost_usd'],default=current)
    return {'estimated':True,'current':current,'recommendation':best,'candidates_evaluated':len(candidates),
            'warning':'Recommendation is based on historical cohort estimates and never changes policy automatically.'}

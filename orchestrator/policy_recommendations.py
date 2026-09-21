from __future__ import annotations
from typing import Any
from .policy_simulation import simulate_policy


def recommend_policy(*, stats:list[dict[str,Any]], current_quality_floor:float, current_cost_aggressiveness:float,
                     min_samples:int=12)->dict[str,Any]:
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

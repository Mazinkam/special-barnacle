from __future__ import annotations
from dataclasses import dataclass,asdict
from typing import Any
from .history import bucket_complexity
from .method import effort_levels

EFFORTS=effort_levels()

@dataclass
class ComputePackage:
    capability:str
    effort:str
    context_budget_tokens:int
    verification_depth:str
    reviewer_independence:str='normal'

DEFAULT_PACKAGES=[
 ComputePackage('implementation_fast','low',14000,'targeted','normal'),
 ComputePackage('implementation_fast','standard',20000,'targeted','normal'),
 ComputePackage('implementation_fast','high',26000,'broad','normal'),
 ComputePackage('implementation_strong','standard',26000,'broad','normal'),
 ComputePackage('implementation_strong','high',36000,'full','independent'),
]

def topology_for(complexity:float,coupling:float=.5,parallelizable:float=.5,risk:str='medium')->dict:
    c=float(complexity)
    if c<=3 or coupling>=.8: return {'depth':1,'leads':0,'workers':1,'shape':'direct'}
    if c<=6:
        workers=max(1,min(4,round(1+3*parallelizable))); return {'depth':2,'leads':1,'workers':workers,'shape':'single_lead'}
    leads=max(2,min(4,round(2+2*parallelizable))); workers=max(leads,min(10,round(c*parallelizable+leads)))
    return {'depth':3 if c<9 else 4,'leads':leads,'workers':workers,'shape':'multi_lead'}

def package_history(stats:list[dict], *, task_class:str, complexity:float, risk:str, package:dict)->dict|None:
    """One priced cohort supplies both the estimate and its evidence; never borrow samples."""
    cb=bucket_complexity(complexity)
    matches=[s for s in stats if s.get('task_class')==task_class and s.get('complexity_bucket')==cb
             and s.get('risk')==risk and s.get('capability')==package.get('capability')
             and s.get('effort')==package.get('effort') and s.get('verification_depth')==package.get('verification_depth')
             and s.get('verified_cost_usd') is not None and s.get('avg_quality_evidence') is not None
             and not s.get('unmetered_call_samples')]
    return max(matches,key=lambda s:(s.get('verified_tasks',0),s.get('samples',0)),default=None)


def recommend_package(*,task_class:str,complexity:float,risk:str,quality_floor:float,cost_aggressiveness:float,stats:list[dict],min_samples:int=8)->dict[str,Any]:
    cb=bucket_complexity(complexity)
    candidates=[]
    for p in DEFAULT_PACKAGES:
        hist=package_history(stats,task_class=task_class,complexity=complexity,risk=risk,package=asdict(p))
        samples=(hist.get('effective_samples',hist.get('samples',0)) if hist else 0)
        cost=(hist.get('verified_cost_usd') if hist else None)
        quality=(hist.get('avg_quality_evidence') if hist else None)
        delayed=(hist.get('delayed_failure_rate') if hist else None)
        # conservative priors; stronger packages get higher assurance prior, cheap packages lower cost prior
        if cost is None: cost={'implementation_fast':.05,'implementation_strong':.12}[p.capability]*(1+EFFORTS.index(p.effort)*.18)
        prior_q=.945 if p.capability=='implementation_fast' else .975
        prior_q += max(0,EFFORTS.index(p.effort)-1)*.006
        if quality is None: quality=prior_q
        if delayed is not None: quality=max(0.0,quality-delayed*.20)
        small_penalty=max(0,min_samples-samples)/min_samples*.025
        adjusted_quality=quality-small_penalty
        cost_score=cost*(1.0+max(0,1-cost_aggressiveness)*.15)
        feasible=adjusted_quality>=quality_floor
        candidates.append({'package':asdict(p),'samples':round(samples,3),'estimated_verified_cost_usd':round(cost,6),'estimated_quality_evidence':round(adjusted_quality,4),'feasible':feasible,'historical':bool(hist)})
    feasible=[c for c in candidates if c['feasible']]
    choice=min(feasible,key=lambda x:x['estimated_verified_cost_usd'],default=max(candidates,key=lambda x:x['estimated_quality_evidence']))
    return {'task_class':task_class,'complexity_bucket':cb,'risk':risk,'quality_floor':quality_floor,'cost_aggressiveness':cost_aggressiveness,'choice':choice,'candidates':candidates,'explanation':'Selected lowest estimated verified cost among packages meeting the effective quality floor; if none met it, selected highest estimated assurance.'}

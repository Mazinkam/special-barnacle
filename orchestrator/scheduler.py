from __future__ import annotations
from dataclasses import dataclass,asdict
from typing import Any
from .history import bucket_complexity
from .method import effort_levels
from .records import is_no_data
from .vocab import SCHEDULER_MIN_SAMPLES

#: `EFFORTS` used to be computed at import time (`effort_levels()` reads `method.json`). Kept as a
#: module attribute (some tests do `from orchestrator.scheduler import EFFORTS`), but resolved lazily
#: on first access via `efforts()`/module `__getattr__` so `import orchestrator.scheduler` alone
#: performs no file read.
_EFFORTS: list[str] | None = None

def efforts() -> list[str]:
    global _EFFORTS
    if _EFFORTS is None:
        _EFFORTS = effort_levels()
    return _EFFORTS

def __getattr__(name: str):
    if name == 'EFFORTS':
        return efforts()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def measured(value:Any)->Any:
    """`value`, or None when it is `None` or `records.NO_DATA`.

    `history.build_route_stats` reports an unmeasured aggregate as `NO_DATA` (`avg_quality_evidence`,
    `retry_rate`), which is falsy but *not* `None`: an `is None` guard lets the sentinel through into
    `quality - penalty` and `quality >= floor`, which raise `TypeError` and took `Engine.plan_run`
    down on any history with priced, verified routes and no quality scores. Every optional stat the
    scheduler and `adaptive` read goes through here so the sentinel is treated as the absence it is —
    never as a number, and never as evidence that can be enforced.
    """
    return None if value is None or is_no_data(value) else value

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
    """One priced cohort supplies both the estimate and its evidence; never borrow samples.

    A cohort whose `verified_cost_usd` or `avg_quality_evidence` is unmeasured (`None` or
    `records.NO_DATA`) is not history for this purpose: it cannot price the package or vouch for its
    quality, so it is neither returned here nor allowed to make a route `historical`/enforceable.
    """
    cb=bucket_complexity(complexity)
    matches=[s for s in stats if s.get('task_class')==task_class and s.get('complexity_bucket')==cb
             and s.get('risk')==risk and s.get('capability')==package.get('capability')
             and s.get('effort')==package.get('effort') and s.get('verification_depth')==package.get('verification_depth')
             and measured(s.get('verified_cost_usd')) is not None and measured(s.get('avg_quality_evidence')) is not None
             and not s.get('unmetered_call_samples')]
    return max(matches,key=lambda s:(measured(s.get('verified_tasks')) or 0,measured(s.get('samples')) or 0),default=None)


def recommend_package(*,task_class:str,complexity:float,risk:str,quality_floor:float,cost_aggressiveness:float,stats:list[dict],min_samples:int=SCHEDULER_MIN_SAMPLES)->dict[str,Any]:
    cb=bucket_complexity(complexity)
    candidates=[]
    for p in DEFAULT_PACKAGES:
        hist=package_history(stats,task_class=task_class,complexity=complexity,risk=risk,package=asdict(p))
        # `measured` turns NO_DATA into None so every optional stat falls back to its prior instead of
        # reaching the arithmetic below as a sentinel.
        samples=(measured(hist.get('effective_samples',hist.get('samples',0))) if hist else None) or 0
        cost=(measured(hist.get('verified_cost_usd')) if hist else None)
        quality=(measured(hist.get('avg_quality_evidence')) if hist else None)
        delayed=(measured(hist.get('delayed_failure_rate')) if hist else None)
        # conservative priors; stronger packages get higher assurance prior, cheap packages lower cost prior
        if cost is None: cost={'implementation_fast':.05,'implementation_strong':.12}[p.capability]*(1+efforts().index(p.effort)*.18)
        prior_q=.945 if p.capability=='implementation_fast' else .975
        prior_q += max(0,efforts().index(p.effort)-1)*.006
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

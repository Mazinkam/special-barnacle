"""Feature-driven control decisions: public API.

Every function here is a pure decision derived from a `features` config dict plus a small amount
of call/task state; none of them mutate config or have side effects. This module is exercised
directly by `tests/test_v3_features.py` and is safe to import from other modules that need one of
these decisions without pulling in `engine`. B3 (`docs/architecture-review.md`) considered
merging it elsewhere, but nothing else in the tree imports it, so it stays a standalone module
rather than being folded into a layer it doesn't share a caller with; see the B3 task report for
this note.

Exports:
- `stop_loss_action(*, features, actual_cost=0.0, expected_cost=None, retries=0,
  elapsed_minutes=None) -> str` -- 'continue' or 'replan'.
- `promotion_action(*, features, conceptual_failures=0, mechanical_failures=0) -> str`.
- `independent_review_required(*, features, risk, sampled=False) -> bool`.
- `verification_plan(*, features, risk) -> dict[str, bool]`.
- `specialized_reviews(*, features, risk, tags=None) -> list[str]`.
- `approval_for(*, features, action) -> str`.
- `budget_action(*, features, spent, budget) -> str`.
"""
from __future__ import annotations
from typing import Any

from .vocab import HIGH_RISK


def stop_loss_action(*, features:dict[str,Any], actual_cost:float=0.0, expected_cost:float|None=None,
                     retries:int=0, elapsed_minutes:float|None=None)->str:
    cfg=features.get('stop_loss',{})
    if not cfg.get('enabled',True): return 'continue'
    if retries > int(cfg.get('max_retry_count',3)): return 'replan'
    mult=float(cfg.get('max_cost_multiplier',3.0))
    if expected_cost and actual_cost > expected_cost*mult: return 'replan'
    limit=cfg.get('max_wall_time_minutes')
    if limit is not None and elapsed_minutes is not None and elapsed_minutes > float(limit): return 'replan'
    return 'continue'


def promotion_action(*, features:dict[str,Any], conceptual_failures:int=0, mechanical_failures:int=0)->str:
    cfg=features.get('model_promotion',{})
    if not cfg.get('enabled',True): return 'same_route'
    if conceptual_failures >= int(cfg.get('after_conceptual_failures',1)): return 'promote_capability'
    if mechanical_failures >= int(cfg.get('after_mechanical_failures',2)): return 'increase_effort_or_promote'
    return 'same_route_with_feedback'


def independent_review_required(*, features:dict[str,Any], risk:str, sampled:bool=False)->bool:
    mode=features.get('independent_review',{}).get('mode','off')
    if mode=='always': return True
    if mode=='risk_based': return risk in HIGH_RISK
    if mode=='sampled': return bool(sampled)
    return False


def verification_plan(*, features:dict[str,Any], risk:str)->dict[str,bool]:
    cfg=features.get('deterministic_verification',{})
    out={}
    for key,state in cfg.items():
        if state=='on': out[key]=True
        elif state=='off': out[key]=False
        else:
            out[key] = key not in {'full_test_suite'} or risk in HIGH_RISK
            if key=='integration_tests': out[key]=risk in {'medium','high','critical'}
    return out


def specialized_reviews(*, features:dict[str,Any], risk:str, tags:set[str]|None=None)->list[str]:
    tags=tags or set(); cfg=features.get('specialized_reviews',{}); chosen=[]
    triggers={'security':{'security','auth','authorization','secrets'},'performance':{'performance','latency','memory'},
              'migration':{'migration','database','schema'},'api_contract':{'api','public_api','contract'}}
    for name,state in cfg.items():
        if state=='on' or (state=='adaptive' and (risk in HIGH_RISK or bool(tags & triggers.get(name,set())))):
            chosen.append(name)
    return chosen


def approval_for(*, features:dict[str,Any], action:str)->str:
    if action=='destructive': return features.get('destructive_operations',{}).get('mode','deny')
    if action=='dependency_add': return features.get('dependencies',{}).get('auto_add','ask')
    if action=='dependency_upgrade': return features.get('dependencies',{}).get('auto_upgrade','ask')
    if action=='merge': return 'allow' if features.get('auto_merge',{}).get('enabled',False) else 'ask'
    if action=='deploy': return 'allow' if features.get('auto_deploy',{}).get('enabled',False) else 'ask'
    return 'ask'


def budget_action(*, features:dict[str,Any], spent:float, budget:float|None)->str:
    if budget is None or spent <= budget: return 'continue'
    mode=features.get('budget_enforcement',{}).get('mode','warn')
    return {'monitor':'continue','warn':'warn','enforce':'stop'}[mode]

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any
import hashlib

from .history import bucket_complexity
from .scheduler import DEFAULT_PACKAGES, EFFORTS, recommend_package, topology_for, package_history, measured


def _unit_interval(seed: str) -> float:
    h = hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16]
    return int(h, 16) / float(0xFFFFFFFFFFFFFFFF)


def deterministic_coin(seed: str, probability: float) -> bool:
    return _unit_interval(seed) < max(0.0, min(1.0, float(probability)))


def default_package_for(complexity: float, risk: str, features: dict[str, Any], default_efforts: dict[str, str]) -> dict[str, Any]:
    strong = risk in {'high','critical'} or float(complexity) >= 8
    capability = 'implementation_strong' if strong else 'implementation_fast'
    effort = default_efforts.get(capability, 'standard')
    effort_cfg=features.get('effort_adaptation', {})
    if effort_cfg.get('enabled', True):
        if risk == 'critical':
            effort = 'high'
        elif float(complexity) <= 3 and risk == 'low':
            effort = 'low'
        max_effort=effort_cfg.get('max_effort','maximum')
        if max_effort in EFFORTS and effort in EFFORTS and EFFORTS.index(effort) > EFFORTS.index(max_effort):
            effort=max_effort
    verification = 'full' if risk == 'critical' else ('broad' if risk == 'high' or float(complexity) >= 7 else 'targeted')
    context_budget = 26000 if capability == 'implementation_strong' else 18000
    if float(complexity) >= 8:
        context_budget += 8000
    return {
        'capability': capability,
        'effort': effort,
        'context_budget_tokens': context_budget,
        'verification_depth': verification,
        'reviewer_independence': 'independent' if risk in {'high','critical'} else 'normal',
    }


def _apply_switch_guards(empirical: dict[str, Any], default: dict[str, Any], features: dict[str, Any]) -> dict[str, Any]:
    out = dict(empirical)
    routing = features.get('adaptive_routing', {})
    if not routing.get('allow_model_switching', True):
        out['capability'] = default['capability']
    effort_cfg=features.get('effort_adaptation', {})
    if not routing.get('allow_effort_switching', True) or not effort_cfg.get('enabled', True):
        out['effort'] = default['effort']
    elif out.get('effort') in EFFORTS and default.get('effort') in EFFORTS:
        oi=EFFORTS.index(out['effort']); di=EFFORTS.index(default['effort'])
        if oi > di and not effort_cfg.get('allow_increase',True): out['effort']=default['effort']
        if oi < di and not effort_cfg.get('allow_decrease',True): out['effort']=default['effort']
        mx=effort_cfg.get('max_effort','maximum')
        if mx in EFFORTS and out.get('effort') in EFFORTS and EFFORTS.index(out['effort']) > EFFORTS.index(mx): out['effort']=mx
    if not routing.get('allow_context_budget_changes', True) or not features.get('context_optimization', {}).get('enabled', True):
        out['context_budget_tokens'] = default['context_budget_tokens']
    if not routing.get('allow_verification_changes', True):
        out['verification_depth'] = default['verification_depth']
        out['reviewer_independence'] = default['reviewer_independence']
    return out


def route_evidence(stats: list[dict[str, Any]], *, task_class: str, complexity: float, risk: str, package: dict[str, Any]) -> dict[str, int]:
    """Evidence behind a package recommendation, counted in verified tasks and runs, not metric rows.

    Legacy stats that predate the split fields carry no `verified_tasks`; they count as zero
    evidence so the gate stays conservative rather than trusting a row count. `records.NO_DATA` in
    any of these fields is likewise zero evidence (`scheduler.measured`), never a number.
    """
    hist = package_history(stats, task_class=task_class, complexity=complexity, risk=risk, package=package) or {}
    return {key: int(measured(hist.get(key)) or 0) for key in ('verified_tasks', 'run_samples', 'call_samples')}


def configured_min_samples(features: dict[str, Any], default: int = 12) -> int:
    return int(features.get('historical_learning', {}).get('minimum_samples', default))


def recommend_topology(*, task_class: str, complexity: float, risk: str, coupling: float, parallelizable: float,
                       stats: list[dict[str, Any]], quality_floor: float, features: dict[str, Any],
                       min_samples: int | None = None) -> dict[str, Any]:
    if min_samples is None:
        min_samples = configured_min_samples(features)
    heuristic = topology_for(complexity, coupling, parallelizable, risk)
    if not features.get('dynamic_depth', {}).get('enabled', True):
        heuristic = {'depth':1,'leads':0,'workers':1,'shape':'direct'}
    if features.get('subleads', {}).get('enabled', True) is False and heuristic['depth'] > 3:
        heuristic['depth'] = 3
    max_depth = int(features.get('dynamic_depth', {}).get('max_depth', 4))
    heuristic['depth'] = min(heuristic['depth'], max_depth)
    max_workers = int(features.get('dynamic_parallelism', {}).get('max_workers', 8))
    min_workers = int(features.get('dynamic_parallelism', {}).get('min_workers', 1))
    heuristic['workers'] = max(min_workers, min(max_workers, heuristic['workers']))
    if not features.get('dynamic_parallelism', {}).get('enabled', True):
        heuristic['workers'] = 1

    # Empirical topology learning only activates when topology-tagged data exists, and it must
    # meet the same verified-task evidence threshold as package routing before it can be enforced.
    cb = bucket_complexity(complexity)
    comparable = [s for s in stats if s.get('task_class') == task_class and s.get('complexity_bucket') == cb and s.get('risk') == risk and s.get('topology_shape')]
    candidates=[]
    skipped_missing=0
    for s in comparable:
        # `measured` folds `records.NO_DATA` into None: an unmeasured quality score or verified cost is
        # a gap in the history, not a value to compare against the floor (which raised TypeError).
        quality=measured(s.get('avg_quality_evidence'))
        cost=measured(s.get('verified_cost_usd'))
        if quality is None or cost is None:
            skipped_missing+=1
            continue
        verified_tasks=int(measured(s.get('verified_tasks')) or 0)
        candidates.append({
            'shape':s.get('topology_shape'), 'samples':measured(s.get('samples')) or 0, 'verified_tasks':verified_tasks,
            'run_samples':int(measured(s.get('run_samples')) or 0), 'verified_cost_usd':cost,
            'quality_evidence':quality, 'meets_quality_floor':quality >= quality_floor,
            'sufficient':verified_tasks >= min_samples, 'feasible':quality >= quality_floor and verified_tasks >= min_samples,
            'depth':s.get('topology_depth'), 'workers':s.get('topology_workers'), 'leads':s.get('topology_leads'),
        })
    feasible=[c for c in candidates if c['feasible']]
    learned=min(feasible,key=lambda x:x['verified_cost_usd'],default=None)
    if learned is not None: fallback_reason=None
    elif not comparable: fallback_reason='no_comparable_history'
    # Comparable groups exist but none carries a verified cost or quality score: a data gap in the
    # history, not an absence of history. Naming it keeps operators from hunting for missing tags.
    elif not candidates: fallback_reason='missing_quality_or_cost'
    elif not any(c['meets_quality_floor'] for c in candidates): fallback_reason='below_quality_floor'
    else: fallback_reason='insufficient_history'
    return {'heuristic':heuristic,'empirical':learned,'candidates':candidates,'min_samples':min_samples,'fallback_reason':fallback_reason,
            'comparable_groups':len(comparable),'skipped_missing_quality_or_cost':skipped_missing}


def adaptive_route(*, run_id: str, task_class: str, complexity: float, risk: str, quality_floor: float,
                   cost_aggressiveness: float, stats: list[dict[str, Any]], features: dict[str, Any],
                   default_efforts: dict[str, str], min_samples: int = 12) -> dict[str, Any]:
    default = default_package_for(complexity, risk, features, default_efforts)
    mode = features.get('adaptive_routing', {}).get('mode', 'off')
    if not features.get('adaptive_system', {}).get('enabled', True):
        mode = 'off'
    history_on = features.get('historical_learning', {}).get('enabled', True)

    empirical = recommend_package(
        task_class=task_class, complexity=complexity, risk=risk, quality_floor=quality_floor,
        cost_aggressiveness=cost_aggressiveness, stats=stats if history_on else [], min_samples=min_samples,
    )
    recommended = _apply_switch_guards(empirical['choice']['package'], default, features)

    # History is sufficient only when enough independently verified tasks back the recommended
    # package. Row counts (calls, verification markers, decisions) are not evidence samples.
    evidence = route_evidence(stats if history_on else [], task_class=task_class, complexity=complexity, risk=risk, package=empirical['choice']['package'])
    sufficient = bool(empirical['choice'].get('historical')) and evidence['verified_tasks'] >= min_samples
    selected = dict(default)
    action = 'static_default'
    if mode == 'observe':
        action = 'observed_only'
    elif mode == 'recommend':
        action = 'recommended_only'
    elif mode == 'enforce' and sufficient:
        selected = dict(recommended)
        action = 'empirical_enforced'
    elif mode == 'enforce':
        action = 'fallback_insufficient_history'

    exploration = features.get('exploration', {})
    explored = False
    exploration_candidate = None
    if mode == 'enforce' and exploration.get('enabled', False) and (risk not in {'high','critical'} or not exploration.get('exclude_high_risk_tasks', True)):
        rate=float(exploration.get('rate',0))
        if deterministic_coin(f'explore:{run_id}:{task_class}:{complexity}:{risk}', rate):
            feasible=[c for c in empirical['candidates'] if c.get('feasible')]
            alternatives=[c for c in feasible if c['package'] != selected]
            if alternatives:
                cheapest=min(alternatives,key=lambda c:c['estimated_verified_cost_usd'])
                base_cost=next((c['estimated_verified_cost_usd'] for c in feasible if c['package']==selected), cheapest['estimated_verified_cost_usd'])
                max_extra=float(exploration.get('max_extra_cost_percent',10))/100.0
                if cheapest['estimated_verified_cost_usd'] <= base_cost*(1+max_extra):
                    exploration_candidate=_apply_switch_guards(cheapest['package'],default,features)
                    selected=exploration_candidate
                    explored=True
                    action='controlled_exploration'

    shadow = features.get('shadow_routing', {})
    shadow_selected = False
    if shadow.get('enabled', False):
        shadow_selected = deterministic_coin(f'shadow:{run_id}:{task_class}:{complexity}:{risk}', float(shadow.get('sampling_rate',0)))

    explanation = {
        'mode': mode,
        'action': action,
        'history_sufficient': sufficient,
        'historical_samples': int(empirical['choice'].get('samples',0) or 0),
        'verified_task_samples': evidence['verified_tasks'],
        'run_samples': evidence['run_samples'],
        'call_samples': evidence['call_samples'],
        'min_samples': int(min_samples),
        'quality_floor': quality_floor,
        'cost_aggressiveness': cost_aggressiveness,
        'default': default,
        'recommended': recommended,
        'selected': selected,
        'explored': explored,
        'shadow_selected': shadow_selected,
    }
    return {
        'mode': mode,
        'default': default,
        'recommended': recommended,
        'selected': selected,
        'empirical': empirical,
        'history_sufficient': sufficient,
        'exploration_candidate': exploration_candidate,
        'shadow_selected': shadow_selected,
        'shadow_execute_alternative': bool(shadow_selected and shadow.get('execute_alternative', False)),
        'explanation': explanation,
    }


def should_canary(run_id: str, percentage: float, reproducible: bool = True) -> bool:
    # Always deterministic by run id: reproducibility is desirable for canary assignment even when normal exploration is not.
    return deterministic_coin(f'canary:{run_id}', float(percentage)/100.0)

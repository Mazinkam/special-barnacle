from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

BOOLEAN_FEATURES = {
    'adaptive_system','historical_learning','exploration','shadow_routing','model_promotion','model_demotion',
    'effort_adaptation','dynamic_depth','dynamic_parallelism','subleads','task_fusion','task_splitting',
    'context_optimization','repo_map','shared_discoveries','persistent_leads','verification_cache',
    'flaky_test_detection','semantic_review','shadow_review','cost_optimization','human_cost','compute_cost',
    'stop_loss','risk_adjustment','delayed_outcomes','maintainability','production_feedback','replanning',
    'branch_cancellation','auto_merge','auto_deploy','policy_recommendations','auto_policy_tuning',
    'policy_simulation','policy_canary','auto_policy_promotion','decision_explanations','reproducible_routing'
}
ROUTING_MODES = {'off','observe','recommend','enforce'}
ADAPTIVE_STATES = {'off','on','adaptive'}
REVIEW_MODES = {'off','sampled','risk_based','always'}
APPROVAL_MODES = {'deny','ask','allow'}
BUDGET_MODES = {'monitor','warn','enforce'}


def deep_merge(base: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    out = deepcopy(base)
    if not override:
        return out
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = deepcopy(v)
    return out


def validate_features(features: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for name in BOOLEAN_FEATURES:
        cfg = features.get(name)
        if cfg is not None and 'enabled' in cfg and not isinstance(cfg['enabled'], bool):
            errors.append(f'{name}.enabled must be boolean')
    mode = features.get('adaptive_routing', {}).get('mode', 'off')
    if mode not in ROUTING_MODES:
        errors.append(f'adaptive_routing.mode must be one of {sorted(ROUTING_MODES)}')
    irm = features.get('independent_review', {}).get('mode', 'off')
    if irm not in REVIEW_MODES:
        errors.append(f'independent_review.mode must be one of {sorted(REVIEW_MODES)}')
    bm = features.get('budget_enforcement', {}).get('mode', 'warn')
    if bm not in BUDGET_MODES:
        errors.append(f'budget_enforcement.mode must be one of {sorted(BUDGET_MODES)}')
    dm = features.get('destructive_operations', {}).get('mode', 'deny')
    if dm not in APPROVAL_MODES:
        errors.append(f'destructive_operations.mode must be one of {sorted(APPROVAL_MODES)}')
    dep = features.get('dependencies', {})
    for key in ('auto_add','auto_upgrade'):
        if dep.get(key, 'ask') not in APPROVAL_MODES:
            errors.append(f'dependencies.{key} must be one of {sorted(APPROVAL_MODES)}')
    det = features.get('deterministic_verification', {})
    for key, val in det.items():
        if val not in ADAPTIVE_STATES:
            errors.append(f'deterministic_verification.{key} must be one of {sorted(ADAPTIVE_STATES)}')
    spec = features.get('specialized_reviews', {})
    for key, val in spec.items():
        if val not in ADAPTIVE_STATES:
            errors.append(f'specialized_reviews.{key} must be one of {sorted(ADAPTIVE_STATES)}')
    rate = features.get('exploration', {}).get('rate', 0)
    if not 0 <= float(rate) <= 1:
        errors.append('exploration.rate must be between 0 and 1')
    srate = features.get('shadow_routing', {}).get('sampling_rate', 0)
    if not 0 <= float(srate) <= 1:
        errors.append('shadow_routing.sampling_rate must be between 0 and 1')
    canary = features.get('policy_canary', {}).get('percentage', 0)
    if not 0 <= float(canary) <= 100:
        errors.append('policy_canary.percentage must be between 0 and 100')
    return errors


@dataclass
class FeaturePolicy:
    base: dict[str, Any]

    def resolve(self, repo_overrides: dict[str, Any] | None = None, task_overrides: dict[str, Any] | None = None) -> dict[str, Any]:
        resolved = deep_merge(self.base, repo_overrides)
        resolved = deep_merge(resolved, task_overrides)
        errors = validate_features(resolved)
        if errors:
            raise ValueError('; '.join(errors))
        return resolved

    @staticmethod
    def enabled(features: dict[str, Any], name: str, default: bool = False) -> bool:
        return bool(features.get(name, {}).get('enabled', default))

    @staticmethod
    def mode(features: dict[str, Any], name: str, default: str = 'off') -> str:
        return str(features.get(name, {}).get('mode', default))


def feature_inventory(features: dict[str, Any]) -> list[dict[str, Any]]:
    rows=[]
    for name, cfg in sorted(features.items()):
        if not isinstance(cfg, dict):
            continue
        if 'enabled' in cfg:
            state = 'on' if cfg['enabled'] else 'off'
        elif 'mode' in cfg:
            state = str(cfg['mode'])
        else:
            state = 'configured'
        rows.append({'feature':name,'state':state,'config':cfg})
    return rows

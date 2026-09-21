from __future__ import annotations

from pathlib import Path
from typing import Any

from .runtime import EventStore, Policy, QualityEvidence, default_state_root, read_json, stable_hash
from .state import rebuild
from .history import load_stats
from .adaptive import adaptive_route, recommend_topology, should_canary
from .features import FeaturePolicy, feature_inventory
from .policy_simulation import compare_policies
from .policy_recommendations import recommend_policy as build_policy_recommendation
from .dashboard import generate_dashboard


class OrchestrationEngine:
    """High-level V3 integration surface for coding-agent harnesses.

    The engine remains harness/model agnostic: it chooses abstract topology, capability,
    effort, context, and verification policy. The harness resolves those through an adapter.
    """

    def __init__(self, state_root: str | Path | None = None, config_path: str | Path | None = None):
        self.state_root = Path(state_root) if state_root is not None else default_state_root()
        self.store = EventStore(self.state_root)
        self.config_path = Path(config_path) if config_path else Path(__file__).with_name("config.json")
        self.config = read_json(self.config_path, {})
        self.feature_policy = FeaturePolicy(self.config.get('features', {}))

    def policy(self) -> Policy:
        o = self.config.get("optimization", {})
        return Policy(
            quality_floor=o.get("quality_floor", .95),
            cost_aggressiveness=o.get("cost_aggressiveness", .70),
            latency_weight=o.get("latency_weight", .10),
            human_hour_value_usd=o.get("human_hour_value_usd", 0.0),
            shadow_review_rate=self.config.get('features',{}).get('shadow_review',{}).get('sample_rate',.03),
            risk_quality_floor_delta=o.get("risk_quality_floor_delta", {}),
        )

    def resolve_features(self, *, repo_overrides: dict[str, Any] | None = None,
                         task_overrides: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.feature_policy.resolve(repo_overrides=repo_overrides, task_overrides=task_overrides)

    def plan_run(self, *, run_id: str, task_class: str, complexity: float, risk: str,
                 coupling: float = .5, parallelizable: float = .5,
                 repo_revision: str | None = None, user_overrides: dict[str, Any] | None = None,
                 repo_feature_overrides: dict[str, Any] | None = None,
                 task_feature_overrides: dict[str, Any] | None = None) -> dict[str, Any]:
        policy = self.policy()
        overrides = user_overrides or {}
        features = self.resolve_features(repo_overrides=repo_feature_overrides, task_overrides=task_feature_overrides)
        risk_adjust = features.get('risk_adjustment',{}).get('enabled',True)
        qf = float(overrides.get("quality_floor", policy.effective_quality_floor(risk) if risk_adjust else policy.quality_floor))
        ca = float(overrides.get("cost_aggressiveness", policy.cost_aggressiveness))
        history_cfg=self.config.get('history',{})
        decay = features.get('historical_learning',{}).get('decay_half_life_days') if features.get('historical_learning',{}).get('decay_old_results',False) else None
        stats = load_stats(self.state_root, history_cfg.get("complexity_bucket_width", 2), decay)

        route = adaptive_route(
            run_id=run_id, task_class=task_class, complexity=complexity, risk=risk,
            quality_floor=qf, cost_aggressiveness=ca, stats=stats, features=features,
            default_efforts=self.config.get('effort',{}).get('default_by_role',{}),
            min_samples=int(features.get('historical_learning',{}).get('minimum_samples',history_cfg.get('min_samples_for_empirical_route',12)))
        )
        topo_rec = recommend_topology(
            task_class=task_class, complexity=complexity, risk=risk, coupling=coupling,
            parallelizable=parallelizable, stats=stats, quality_floor=qf, features=features
        )
        topology=topo_rec['heuristic']
        routing_cfg=features.get('adaptive_routing',{})
        if routing_cfg.get('mode')=='enforce' and routing_cfg.get('allow_topology_changes',True) and topo_rec.get('empirical'):
            emp=topo_rec['empirical']
            if emp.get('depth') and emp.get('workers') is not None:
                topology={
                    'depth':int(emp['depth']), 'workers':int(emp['workers']), 'leads':int(emp.get('leads') or 0),
                    'shape':emp['shape'], 'source':'empirical'
                }
        topology.setdefault('source','heuristic')

        snapshot = policy.snapshot()
        canary_cfg=features.get('policy_canary',{})
        canary=bool(canary_cfg.get('enabled',False) and should_canary(run_id,float(canary_cfg.get('percentage',0))))
        plan = {
            "run_id": run_id,
            "task_class": task_class,
            "complexity": complexity,
            "risk": risk,
            "repo_revision": repo_revision,
            "topology": topology,
            "topology_recommendation": topo_rec,
            "route": route,
            "selected_compute_package": route['selected'],
            "policy": snapshot,
            "features": features,
            "feature_inventory": feature_inventory(features),
            "effective_quality_floor": qf,
            "cost_aggressiveness": ca,
            "canary": canary,
        }
        plan["plan_id"] = stable_hash(plan)
        self.store.emit("run_started", **plan)
        self.store.metric(
            event='adaptive_route_decision', run_id=run_id, task_class=task_class, complexity=complexity, risk=risk,
            policy_id=snapshot['policy_id'], cost_aggressiveness=ca, quality_floor=qf,
            adaptive_mode=route['mode'], route_action=route['explanation']['action'],
            selected_capability=route['selected']['capability'], selected_effort=route['selected']['effort'],
            selected_verification_depth=route['selected']['verification_depth'],
            recommended_capability=route['recommended']['capability'], recommended_effort=route['recommended']['effort'],
            history_sufficient=route['history_sufficient'], historical_samples=route['explanation']['historical_samples'],
            recommended_estimated_verified_cost_usd=route['empirical']['choice'].get('estimated_verified_cost_usd'),
            recommended_estimated_quality_evidence=route['empirical']['choice'].get('estimated_quality_evidence'),
            explored=route['explanation']['explored'], shadow_selected=route['shadow_selected'],
            topology_shape=topology['shape'], topology_depth=topology['depth'], topology_workers=topology['workers'], topology_leads=topology['leads'],
            canary=canary
        )
        if features.get('decision_explanations',{}).get('enabled',True):
            self.store.emit('routing_explained', run_id=run_id, explanation=route['explanation'], topology=topo_rec)
        if repo_revision:
            self.store.emit("repo_revision", run_id=run_id, revision=repo_revision)
        self._refresh()
        return plan

    def record_model_call(self, **metric: Any) -> dict[str, Any]:
        metric.setdefault("event", "model_call")
        rec = self.store.metric(**metric)
        generate_dashboard(self.state_root, config=self.config)
        return rec

    def verify_task(self, *, task_id: str, run_id: str | None = None, evidence: QualityEvidence,
                    metric_context: dict[str, Any] | None = None) -> dict[str, Any]:
        score = evidence.evidence_score()
        result = "verified" if evidence.hard_gate_pass() else "fail"
        self.store.emit("task_verified" if result == "verified" else "task_failed", task_id=task_id, run_id=run_id,
                        quality_evidence_score=score, hard_gate_pass=evidence.hard_gate_pass())
        metric = {"event": "task_verified", "task_id": task_id, "run_id": run_id,
                  "result": result, "quality_evidence_score": score, **(metric_context or {})}
        self.store.metric(**metric)
        self._refresh()
        return {"result": result, "quality_evidence_score": score, "hard_gate_pass": evidence.hard_gate_pass()}

    def simulate_policy(self, *, candidate_quality_floor: float, candidate_cost_aggressiveness: float) -> dict[str, Any]:
        if not self.config.get('features',{}).get('policy_simulation',{}).get('enabled',True):
            return {'enabled':False}
        h=self.config.get('features',{}).get('historical_learning',{})
        decay=h.get('decay_half_life_days') if h.get('decay_old_results',False) else None
        stats=load_stats(self.state_root,self.config.get('history',{}).get('complexity_bucket_width',2),decay)
        p=self.policy()
        return compare_policies(
            stats=stats,
            current={'quality_floor':p.quality_floor,'cost_aggressiveness':p.cost_aggressiveness},
            candidate={'quality_floor':candidate_quality_floor,'cost_aggressiveness':candidate_cost_aggressiveness},
            min_samples=self.config.get('history',{}).get('min_samples_for_empirical_route',12)
        )


    def recommend_policy(self) -> dict[str, Any]:
        if not self.config.get('features',{}).get('policy_recommendations',{}).get('enabled',True):
            return {'enabled':False}
        h=self.config.get('features',{}).get('historical_learning',{})
        decay=h.get('decay_half_life_days') if h.get('decay_old_results',False) else None
        stats=load_stats(self.state_root,self.config.get('history',{}).get('complexity_bucket_width',2),decay)
        p=self.policy()
        return build_policy_recommendation(
            stats=stats,current_quality_floor=p.quality_floor,current_cost_aggressiveness=p.cost_aggressiveness,
            min_samples=self.config.get('history',{}).get('min_samples_for_empirical_route',12)
        )

    def complete_run(self, run_id: str, **payload: Any) -> None:
        self.store.emit("run_completed", run_id=run_id, **payload)
        self._refresh()

    def fail_run(self, run_id: str, **payload: Any) -> None:
        self.store.emit("run_failed", run_id=run_id, **payload)
        self._refresh()

    def record_outcome(self, task_id: str, **payload: Any) -> None:
        self.store.outcome(task_id=task_id, **payload)
        generate_dashboard(self.state_root, config=self.config)

    def _refresh(self) -> None:
        rebuild(self.state_root)
        generate_dashboard(self.state_root, config=self.config)

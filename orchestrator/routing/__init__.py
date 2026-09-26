"""Routing layer: policy simulation and recommendation (B3).

`orchestrator.policy_simulation` and `orchestrator.policy_recommendations` added nothing beyond
each other — `policy_recommendations.recommend_policy` just grid-searched
`policy_simulation.simulate_policy` — so both were merged into `routing.policy`
(`docs/architecture-review.md` B3, "Remove modules that add nothing"). The old modules are now
re-export shims; `orchestrator.engine` and everything else imports from here.
"""
from __future__ import annotations

from .policy import compare_policies, recommend_policy, simulate_policy

__all__ = ['compare_policies', 'recommend_policy', 'simulate_policy']

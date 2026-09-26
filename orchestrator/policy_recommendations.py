"""Re-export shim: `policy_recommendations` was merged into `routing.policy` (B3,
`docs/architecture-review.md`).

Kept so existing imports (`from orchestrator.policy_recommendations import recommend_policy`, and
any `mock.patch('orchestrator.policy_recommendations....')`) keep working. New code should import
from `orchestrator.routing.policy`.
"""
from __future__ import annotations

from .routing.policy import recommend_policy

__all__ = ['recommend_policy']

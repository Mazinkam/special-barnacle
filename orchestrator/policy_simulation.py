"""Re-export shim: `policy_simulation` was merged into `routing.policy` (B3, `docs/architecture-review.md`).

Kept so existing imports (`from orchestrator.policy_simulation import simulate_policy`, and any
`mock.patch('orchestrator.policy_simulation....')`) keep working. New code should import from
`orchestrator.routing.policy`.
"""
from __future__ import annotations

from .routing.policy import compare_policies, simulate_policy

__all__ = ['compare_policies', 'simulate_policy']

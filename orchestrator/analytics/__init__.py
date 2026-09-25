"""Analytics layer: derived read-only statistics over metric/event streams (B3).

Today this is just `flaky_stats` (moved out of `orchestrator.verification`, which mixed a stats
function with the on-disk `VerificationCache`, per B3 "Remove modules that add nothing" /
"move `verification.flaky_stats` to analytics" in `docs/architecture-review.md`). Per the B2
layer order, `analytics` sits above `store`/`ingest` and below `routing`/`presentation`; it must
not import `presentation`, `app`, `engine` or `cli` (enforced by `tests/test_layers.py`).
"""
from __future__ import annotations

from .verification import flaky_stats

__all__ = ['flaky_stats']

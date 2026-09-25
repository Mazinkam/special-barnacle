"""Presentation layer: dashboard data reducers, HTML rendering, and publishing (B3).

Split out of `orchestrator/dashboard.py`, which now re-exports every public name here for
backward compatibility. See `docs/architecture-review.md` B2/B3 for the target layer order:
this package may import `core/`, `config/`, `records/`, `store/` and the analytics-ish modules
(`history`, `outcomes`, `economics`, `run_evidence`, `verification`, `features`), but it must
never import `app`, `engine` or `cli` (enforced by `tests/test_layers.py`).
"""
from __future__ import annotations

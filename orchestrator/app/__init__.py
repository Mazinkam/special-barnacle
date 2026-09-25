"""App layer: composes store/presentation primitives into the behaviour the CLI exposes.

Nothing under `record/`, `store/` (today: `record_batch.py`, `runtime.py`, `record_index.py`,
`state.py`) or `engine.py` may import this package or anything under `dashboard.py`
(`presentation/`); this is the layer that is allowed to wire those together, and only
`cli.py` may import this package. See `docs/architecture-review.md` B2.
"""
from __future__ import annotations

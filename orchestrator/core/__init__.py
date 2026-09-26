"""Bottom layer: no `orchestrator` imports except `contract`/`vocab` (see docs/architecture-review.md B2).

`core.fs` (atomic writes, fsync, the writer lock), `core.jsonl` (the one JSONL reader),
`core.env` (state-root/attribution/time, resolved lazily) and `core.layout` (`StateLayout`,
every state-root file path in one place) used to live together in `orchestrator/runtime.py`.
`orchestrator.runtime` still re-exports every name that moved here, so nothing that imported
from it needs to change.
"""
from __future__ import annotations

"""Store layer: durable append/index/ledger facade over the record-batch writer (B2.3).

`store.facade.EventStore` is the one name here today; it must not import `dashboard`/`app`/
`engine`/`cli` (enforced by `tests/test_layers.py`). `orchestrator.runtime` re-exports
`EventStore` for one release.
"""
from __future__ import annotations

from .facade import EventStore

__all__ = ['EventStore']

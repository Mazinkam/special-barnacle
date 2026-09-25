"""`EventStore`: the durable-write facade every engine/CLI/script call goes through.

Moved out of `orchestrator/runtime.py` (B2.3): `EventStore._write` used to lazily import
`record_batch` inside the method ("Imported lazily: `record_batch` depends on this module") to
avoid a cycle. Since B2.2 moved every constant/helper `record_batch` needed out of `runtime`
into `core`/`records.metering`, `record_batch` no longer imports `runtime` at all, so this module
can import it at module scope with no cycle — `orchestrator.runtime` imports *this* module
(`store.facade`), not the other way around.

`EventStore` is now a thin facade over an injected writer (default: `_RecordBatchWriter`, which
does exactly what the old hard-coded `_write` did). A caller that needs a different writer
(tests, a future in-memory store) passes one; nothing about the default construction changed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from ..core.env import default_attribution, utc_now
from ..core.jsonl import append_jsonl, load_jsonl
from ..core.layout import StateLayout
from ..records.metering import meter
from ..record_batch import single_record, write_batch


class Writer(Protocol):
    """What `EventStore` needs from a writer: durable event/metric/outcome append, and the
    separate (non-deduplicated, non-contract-stream) discovery append."""

    def write(self, root: Path, stream: str, payload: dict[str, Any], *, event: str | None = None) -> dict[str, Any]: ...

    def append_discovery(self, path: Path, record: dict[str, Any]) -> None: ...


class _RecordBatchWriter:
    """Default writer: `record_batch.write_batch` for event/metric/outcome.

    `discovery` is NOT routed through `write_batch`: `discoveries.jsonl` is not one of the
    contract streams (no exact-ID dedup entry, no ledger replay, no checkpoint receipt) and
    never has been — a discovery call has always been a plain locked-free append, and routing it
    through the coordinated writer would add deduplication and a writer-lock hold that callers
    have never taken for it, changing both the file's dedup semantics and its durability. See
    docs/architecture-review.md B2.3.
    """

    def write(self, root: Path, stream: str, payload: dict[str, Any], *, event: str | None = None) -> dict[str, Any]:
        result = write_batch(root, [single_record(stream, payload, event=event)], refresh=False)
        return result['records'][0]

    def append_discovery(self, path: Path, record: dict[str, Any]) -> None:
        append_jsonl(path, record)


class EventStore:
    def __init__(self, root: str | Path | None = None, *, writer: Writer | None = None):
        layout = StateLayout(root)  # creates the root dir and touches the four streams below
        self.root = layout.root
        self.events = layout.events
        self.metrics = layout.metrics
        self.discoveries = layout.discoveries
        self.outcomes = layout.outcomes
        self._writer: Writer = writer or _RecordBatchWriter()

    def _write(self, stream: str, payload: dict[str, Any], *, event: str | None = None) -> dict[str, Any]:
        """Route a single record through the coordinated writer (lock + dedup + checkpoint).

        Callers that want the ledger/dashboard refreshed do so explicitly, as before; the writer
        here only guarantees the durable, deduplicated append. The stream (and event name) named
        by the method win over anything in the payload.
        """
        return self._writer.write(self.root, stream, payload, event=event)

    def emit(self, event: str, **payload):
        return self._write('event', payload, event=event)

    def preview_metric(self, **payload):
        """Build the record a `metric()` call would write, without writing it (dry runs)."""
        return {'ts': utc_now(), **default_attribution(), **meter(payload)}

    def metric(self, **payload):
        return self._write('metric', payload)

    def discovery(self, **payload):
        rec = {'ts': utc_now(), **default_attribution(), **payload}
        self._writer.append_discovery(self.discoveries, rec)
        return rec

    def outcome(self, **payload):
        return self._write('outcome', payload)

    def all_events(self):
        return load_jsonl(self.events)

"""Ingest per-call token usage from coding-agent session logs.

An agent writing its own telemetry mid-session cannot know its token counts, so records
emitted by hand arrive unmetered. Every harness already writes usage to disk; this module
reads those logs and emits `model_call` metrics through the coordinated writer
(`record_batch.write_batch`), which prices and labels them.

Ingestion is idempotent and incremental. Each call carries a `call_id` derived from the
harness's own identifiers (also used as the durable `record_id`). Session-level rows aggregate
only unrecorded call IDs and persist those IDs as `covered_call_ids` alongside the usage. A per-source
checkpoint (`ingest_checkpoint`) remembers the verified byte offset of the log, every call id the
log has ever shown, and the `session_ingest` rows already known for its sessions. Unchanged sources
need only edge checks; growth verifies the whole checkpointed prefix before parsing the suffix.
The event stream durably binds fallback identities to their explicit logical sessions, even when
promotion emits no new usage. Initial metrics retain the scanned source's device/inode, so
checkpoint loss cannot turn a replacement file into a fallback promotion. Metrics remain authoritative for paid coverage; every checkpoint is a
rebuildable cache, and settle → check → append → checkpoint runs under the one writer lock so
competing ingesters serialize instead of double counting. Each log is read through one open file
(identity, prefix check, scan and fingerprints all see the same inode). Totals-only legacy history
without matching checkpoint evidence, or a file modified under the reader, is rejected before any
write rather than guessed from numeric usage. Identified calls survive rewrites and checkpoint loss.

This used to be one 967-line module (B3, `docs/architecture-review.md`); it is now a package:

* `parsers/` — per-runtime session log parsers (`humain_terminal.py`, `codex.py`) and the shared
  `read_calls`/`detect_runtime` machinery (`parsers/__init__.py`).
* `discovery.py` — finding session logs on disk (`discover_logs`).
* `reconcile.py` — resolving session-ID drift by exact source call coverage
  (`_reconcile_source_calls`) and `call_id_for`.
* `service.py` — the coordinated ingest write path (`ingest_file`/`ingest_paths`) plus the
  CLI-facing sweep bookkeeping moved out of `cli.py` (`make_ingest_status`/`process_ingest`).

`orchestrator.ingest_checkpoint` (the per-source checkpoint codec/ledger) is unchanged by this
split and still provides `IngestLedger`/`add_totals`/etc.; it splits into `ingest/checkpoint.py`/
`ingest/ledger.py` in a follow-up commit.

Every name that used to be importable from `orchestrator.ingest` (public API, private helpers,
and the stdlib/typing names it imported for its own use) stays importable from here — see
`tests/test_ingest_reexports.py`.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable, Iterator, NamedTuple, Optional

from ..record_batch import BatchAppendError, MAX_BATCH_RECORDS, build_record, settle_streams, write_batch
from ..records import CALL, SESSION
from ..runtime import EventStore, default_state_root, iter_jsonl_from, open_binary, stable_hash, tail_fingerprint, writer_lock
from .. import ingest_checkpoint as ckpt
from ..ingest_checkpoint import COUNT_FIELDS, IngestLedger, TOKEN_FIELDS, add_totals, empty_totals, totals_equal
from .discovery import LOG_GLOBS, _TEMP_MARKERS, discover_logs, is_scratch_log
from .parsers import (
    CODEX,
    HUMAIN_TERMINAL,
    PARSERS,
    READERS,
    Parser,
    _codex_state,
    _codex_state_ok,
    _humain_terminal_state,
    _humain_terminal_state_ok,
    _lines,
    _parse_codex,
    _parse_humain_terminal,
    detect_runtime,
    read_calls,
    read_codex,
    read_humain_terminal,
)
from .parsers._shared import _int, _is_int, _optional_str
from .parsers.humain_terminal import _PROBE_LIMIT, _resolve_encoded_path, log_repository
from .reconcile import SourceConflict, _reconcile_source_calls, call_id_for
from .service import (
    GranularityConflict,
    _base_metric,
    _chunks,
    _conflict,
    _empty_summary,
    _group_key,
    _ingest_open_source,
    _ingest_source,
    _observe,
    _observed_from_json,
    _observed_ids,
    _observed_to_json,
    _paid_call_ids,
    _reconcile_prefix,
    _run,
    _session_rows,
    _tally,
    ingest_file,
    ingest_paths,
    make_ingest_status,
    process_ingest,
)

__all__ = [
    'GranularityConflict', 'SourceConflict',
    'HUMAIN_TERMINAL', 'CODEX', 'LOG_GLOBS',
    'log_repository', 'is_scratch_log',
    'Parser', 'PARSERS', 'READERS',
    'read_calls', 'read_humain_terminal', 'read_codex', 'detect_runtime',
    'discover_logs', 'call_id_for',
    'ingest_file', 'ingest_paths',
    'make_ingest_status', 'process_ingest',
]

"""Backward-compatible re-export shim.

`orchestrator/ingest_checkpoint.py` used to hold the per-source checkpoint codec/validators and
the incremental `session_ingest` dedup ledger in one 585-line module (B3,
`docs/architecture-review.md`). It is now split into `orchestrator/ingest/checkpoint.py` (codec
and validators) and `orchestrator/ingest/ledger.py` (`IngestLedger`); every name that used to be
importable from `orchestrator.ingest_checkpoint` is re-exported here unchanged, so
`orchestrator/ingest/__init__.py`, tests and scripts that import from this module keep working
without modification. See `tests/test_ingest_reexports.py` for the full, enumerated set this
module must keep satisfying.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Optional

from .runtime import TAIL_FINGERPRINT_BYTES, iter_jsonl_from, open_binary, read_json, stable_hash, tail_fingerprint, write_json
from .contract import STREAMS
from .vocab import CALL, SESSION, INGEST_TOKEN_FIELDS
from .ingest.checkpoint import (
    CHECKPOINT_DIR,
    COUNT_FIELDS,
    FORMAT_VERSION,
    GRANULARITIES,
    INGEST_SOURCE,
    MAX_CHECKPOINT_BYTES,
    MAX_TAIL_BYTES,
    PROMOTION_EVENT,
    PROMOTION_VERSION,
    TOKEN_FIELDS,
    _blank_state,
    _int,
    _is_int,
    _state_from_json,
    _state_to_json,
    _valid_hash,
    _valid_identity,
    _valid_observed,
    _valid_recorded,
    _valid_stat,
    _valid_totals,
    add_totals,
    changed_while_reading,
    checkpoint_path,
    empty_totals,
    file_identity,
    head_fingerprint,
    load_checkpoint,
    prefix_fingerprint,
    promotion_record,
    save_checkpoint,
    source_key,
    source_prefix_intact,
    source_signature,
    totals_equal,
    valid_session_provenance,
    verify_prefix,
)
from .ingest.ledger import IngestLedger

__all__ = [
    'CHECKPOINT_DIR', 'COUNT_FIELDS', 'FORMAT_VERSION', 'GRANULARITIES', 'INGEST_SOURCE',
    'MAX_CHECKPOINT_BYTES', 'MAX_TAIL_BYTES', 'PROMOTION_EVENT', 'PROMOTION_VERSION', 'TOKEN_FIELDS',
    'IngestLedger', 'add_totals', 'changed_while_reading', 'checkpoint_path', 'empty_totals',
    'file_identity', 'head_fingerprint', 'load_checkpoint', 'prefix_fingerprint', 'promotion_record',
    'save_checkpoint', 'source_key', 'source_prefix_intact', 'source_signature', 'totals_equal',
    'valid_session_provenance', 'verify_prefix',
]

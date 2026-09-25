"""Compatibility re-export shim (see docs/architecture-review.md B2.2/B2.3).

Every name this module used to define now lives in `orchestrator.core` (`core.fs`/`core.jsonl`/
`core.env`/`core.layout`), `orchestrator.records.metering` (`Policy`/`QualityEvidence`/`meter`),
`orchestrator.store.facade` (`EventStore`) or `orchestrator.contract` (`DEFAULT_STATE_ROOT`/
`STATE_ROOT_ENV_VAR`/`STREAMS`). This module re-exports every public AND private name (and every
stdlib/typing name that used to be importable as a module attribute, e.g. `orchestrator.runtime.
Path`, `orchestrator.runtime.json`) other modules, scripts and tests imported from
`orchestrator.runtime` before the split, so nothing that imports `orchestrator.runtime` needs to
change (ground rule 2). Delete a re-export only once nothing imports it. See
tests/test_runtime_reexports.py for the full, enumerated set this module must keep satisfying.

Every import below is module-level, not function-level: the two lazy imports this module used to
have (`meter`'s `from .economics import ...`/`from .pricing import ...`, and
`EventStore._write`'s `from .record_batch import ...`) existed only to avoid import cycles that no
longer exist now that `record_batch`/`record_index`/`state` import `core`/`records.metering`
directly instead of this module — see each of those modules' own comments.
"""
from __future__ import annotations

# Re-exported stdlib/typing/dataclasses/contextlib/datetime names: this module used to import
# these directly for its own use, and other modules/tests reached them as e.g.
# `orchestrator.runtime.Path`, `orchestrator.runtime.json.dumps(...)`,
# `patch('orchestrator.runtime.fcntl.flock', ...)`. Each is a singleton module (or class) object,
# so re-importing it here under the same name is the same object callers previously got.
import fcntl
import hashlib
import json
import logging
import os
import secrets
import sys
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from .contract import DEFAULT_STATE_ROOT, STATE_ROOT_ENV_VAR, STREAMS
from .core.env import default_attribution, default_state_root, stable_hash, utc_now
from .core.fs import (
    RECORD_INDEX_FILE,
    WRITER_LOCK_FILE,
    _create_exclusive_tmp,
    _LOGGER,
    exclusive_file_lock,
    fsync_directory,
    fsync_directory_ancestry,
    read_json,
    write_json,
    write_text_atomic,
    writer_lock,
)
from .core.jsonl import (
    TAIL_FINGERPRINT_BYTES,
    append_jsonl,
    encode_jsonl,
    iter_jsonl,
    iter_jsonl_from,
    load_jsonl,
    open_binary,
    tail_fingerprint,
)
from .records.metering import Policy, QualityEvidence, meter
from .store.facade import EventStore

# `_handler` was the `logging.StreamHandler` this module (now `core.fs`) attached to `_LOGGER` at
# import time, module-global there for the same reason: nothing in this repo re-imports it, but a
# pre-split `orchestrator.runtime._handler` existed, so it stays importable.
from .core.fs import _handler  # noqa: F401 - re-export only, see comment above

__all__ = [
    'default_attribution', 'default_state_root', 'stable_hash', 'utc_now',
    'RECORD_INDEX_FILE', 'WRITER_LOCK_FILE', 'exclusive_file_lock', 'fsync_directory',
    'fsync_directory_ancestry', 'read_json', 'write_json', 'write_text_atomic', 'writer_lock',
    'TAIL_FINGERPRINT_BYTES', 'append_jsonl', 'encode_jsonl', 'iter_jsonl', 'iter_jsonl_from',
    'load_jsonl', 'open_binary', 'tail_fingerprint',
    'Policy', 'QualityEvidence', 'meter', 'EventStore',
    'DEFAULT_STATE_ROOT', 'STATE_ROOT_ENV_VAR', 'STREAMS',
]

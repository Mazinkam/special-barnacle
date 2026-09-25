"""Compatibility re-export shim (see docs/architecture-review.md B2.2/B2.3).

Every name this module used to define now lives in `orchestrator.core` (`core.fs`/`core.jsonl`/
`core.env`/`core.layout`), `orchestrator.records.metering` (`Policy`/`QualityEvidence`/`meter`)
or `orchestrator.store.facade` (`EventStore`). This module re-exports every public AND private
name other modules, scripts and tests imported from `orchestrator.runtime` before the split, so
nothing that imports `orchestrator.runtime` needs to change (ground rule 2). Delete a re-export
only once nothing imports it.

Every import below is module-level, not function-level: the two lazy imports this module used to
have (`meter`'s `from .economics import ...`/`from .pricing import ...`, and
`EventStore._write`'s `from .record_batch import ...`) existed only to avoid import cycles that no
longer exist now that `record_batch`/`record_index`/`state` import `core`/`records.metering`
directly instead of this module — see each of those modules' own comments.
"""
from __future__ import annotations

import fcntl  # noqa: F401 - unused directly; kept so `patch('orchestrator.runtime.fcntl.flock', ...)`
# (tests/test_concurrent_state_writes.py) still resolves. `fcntl` is a singleton module object, so
# patching the attribute reached through this name patches the same object `core.fs.exclusive_file_lock`
# calls `fcntl.flock` on, wherever it imports `fcntl` from.

from .core.env import default_attribution, default_state_root, stable_hash, utc_now
from .core.fs import (
    RECORD_INDEX_FILE,
    WRITER_LOCK_FILE,
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

__all__ = [
    'default_attribution', 'default_state_root', 'stable_hash', 'utc_now',
    'RECORD_INDEX_FILE', 'WRITER_LOCK_FILE', 'exclusive_file_lock', 'fsync_directory',
    'fsync_directory_ancestry', 'read_json', 'write_json', 'write_text_atomic', 'writer_lock',
    'TAIL_FINGERPRINT_BYTES', 'append_jsonl', 'encode_jsonl', 'iter_jsonl', 'iter_jsonl_from',
    'load_jsonl', 'open_binary', 'tail_fingerprint',
    'Policy', 'QualityEvidence', 'meter', 'EventStore',
]

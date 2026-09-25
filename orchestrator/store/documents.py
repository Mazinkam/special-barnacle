"""One JSON document per file, safe for concurrent read-modify-write (B3).

`ContextRegistry` and `VerificationCache` used to load `self.data` once in `__init__` and write
it back after every mutating call, with no lock: two processes (or two threads sharing one
instance) doing a read-modify-write at the same time can lose whichever write lands second.
`JsonDocument(path)` fixes that by holding an exclusive lock on a sidecar `<path>.lock` file for
the whole read -> update -> atomic-write sequence, reusing `core.fs.exclusive_file_lock` (the
same primitive `store.facade`'s writer lock uses) and `core.fs.write_json` (same-directory temp
file + `os.replace`, so a reader always sees a complete document) for the write itself.

The sidecar lock file lives next to the document (e.g. `context_registry.json.lock`); it holds no
data of its own. Archive (`archive.plan`) only ever lists files inside `runs/<run_id>/`, and
`context_registry.json`/`verification_cache.json` live at the state root, so the lock file next to
them is never seen by archive or by dashboard code (neither lists the state root directory) and
needs no entry in `contract.NEVER_ARCHIVE_FILES`.

This is B3's one intended behaviour change (adding locking); everything else in this refactor is
required to be behaviour-preserving.
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Callable

from ..core.fs import exclusive_file_lock, read_json, write_json


class JsonDocument:
    """A JSON file at `path`, read and updated under an exclusive lock on `<path>.lock`."""

    def __init__(self, path: str | Path, default: Any):
        self.path = Path(path)
        self.default = default

    def _lock_path(self) -> Path:
        return self.path.with_name(self.path.name + '.lock')

    def read(self) -> Any:
        """Unlocked snapshot read. Callers that need the read and the following write to be
        atomic with respect to other readers/writers must use `update` instead."""
        return read_json(self.path, copy.deepcopy(self.default))

    def update(self, fn: Callable[[Any], Any]) -> Any:
        """Read the current document (or the default if it doesn't exist yet), call `fn(data)`
        and atomically write its return value back — all while holding the exclusive lock, so a
        concurrent `update` on the same path cannot interleave with this one. Returns what `fn`
        returned (and wrote).

        If `fn` returns `None`, nothing is written (and the file is not created if it didn't
        already exist) — this is how callers signal a no-op update (e.g. invalidating an artifact
        that isn't present), matching the pre-B3 unlocked code's behaviour of only writing when it
        actually changed something. The current (unwritten) snapshot is returned in that case.
        """
        lock_path = self._lock_path()
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with exclusive_file_lock(lock_path):
            data = read_json(self.path, copy.deepcopy(self.default))
            result = fn(data)
            if result is None:
                return data
            write_json(self.path, result)
            return result

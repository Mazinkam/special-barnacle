"""`StateLayout(root)`: every on-disk path under a state root, gathered in one place.

Before this, the stream/ledger/lock/checkpoint/ingest-status/dashboard file names were scattered
across `runtime.py`, `state.py`, `record_batch.py`, `record_index.py` and `archive.py` as
module-level constants combined with `root/...` at each call site. `StateLayout` is the one
place that combines a root with those names; other modules keep their own constants (this does
not replace them, see B2.2's "keep re-exports" ground rule) but new code should prefer this.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict

from ..contract import INGEST_STATUS_FILE, STREAMS
from .env import default_state_root
from .fs import RECORD_INDEX_FILE, WRITER_LOCK_FILE

#: `record_index.DATABASE_FILE` — duplicated here as a string, not imported, so `core` (bottom of
#: the layer order) never depends on `record_index` (a store-layer module built on top of it).
_INDEX_DATABASE_FILE = 'records.index.sqlite3'
#: `state.LEDGER_FILE`.
_LEDGER_FILE = 'ledger.json'
#: `archive.ARCHIVE_LOCK_FILE` / `archive.RUNS_DIR` / `archive.MANIFEST_FILE`.
_ARCHIVE_LOCK_FILE = 'archive.lock'
_RUNS_DIR = 'runs'
_ARCHIVE_MANIFEST_FILE = 'archive.manifest.json'
#: `context.ContextRegistry` / `verification.VerificationCache` on-disk file names.
_CONTEXT_REGISTRY_FILE = 'context_registry.json'
_VERIFICATION_CACHE_FILE = 'verification_cache.json'


class StateLayout:
    """Resolve a state root and expose every state file's path as an attribute.

    Constructing a layout ensures the root directory and the four always-present JSONL streams
    exist — the same side effect `EventStore.__init__` has always had — so a caller that used to
    build an `EventStore` (or call it) purely to resolve `.root` gets identical behaviour from
    `StateLayout(root).root`.
    """

    def __init__(self, root: str | Path | None = None):
        self.root: Path = Path(root) if root is not None else default_state_root()
        self.root.mkdir(parents=True, exist_ok=True)
        self.streams: Dict[str, Path] = {name: self.root / filename for name, filename in STREAMS.items()}
        self.events: Path = self.streams['event']
        self.metrics: Path = self.streams['metric']
        self.outcomes: Path = self.streams['outcome']
        self.discoveries: Path = self.root / 'discoveries.jsonl'
        for path in (self.events, self.metrics, self.discoveries, self.outcomes):
            if not path.exists():
                path.touch(exist_ok=True)
        self.lock: Path = self.root / WRITER_LOCK_FILE
        self.checkpoint: Path = self.root / RECORD_INDEX_FILE
        self.index_database: Path = self.root / _INDEX_DATABASE_FILE
        self.ledger: Path = self.root / _LEDGER_FILE
        self.ingest_status: Path = self.root / INGEST_STATUS_FILE
        self.dashboard: Path = self.root / 'dashboard.html'
        self.dashboard_version: Path = self.root / 'dashboard.version.json'
        self.archive_lock: Path = self.root / _ARCHIVE_LOCK_FILE
        self.runs_dir: Path = self.root / _RUNS_DIR
        self.context_registry: Path = self.root / _CONTEXT_REGISTRY_FILE
        self.verification_cache: Path = self.root / _VERIFICATION_CACHE_FILE

    def run_dir(self, run_id: str) -> Path:
        return self.runs_dir / run_id

    def archive_manifest(self, run_id: str) -> Path:
        return self.run_dir(run_id) / _ARCHIVE_MANIFEST_FILE

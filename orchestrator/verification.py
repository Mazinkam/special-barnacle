from __future__ import annotations
import threading
from pathlib import Path
from .runtime import default_state_root, stable_hash, utc_now
from .analytics.verification import flaky_stats  # re-exported: moved to analytics (B3)
from .store.documents import JsonDocument

__all__ = ['VerificationCache', 'flaky_stats']

class VerificationCache:
    """Cross-process-safe wrapper around `verification_cache.json` (a `JsonDocument`).

    `.data` is a convenience snapshot for readers (e.g. `get()`), not the source of truth. `put`
    re-reads the document from disk under `JsonDocument`'s file lock, applies its own entry to
    that fresh state, and only then assigns the written result to `.data` — all while holding an
    instance-level `threading.Lock` that also serializes concurrent calls on a *shared* instance
    across threads, so `.data` can never regress to an older snapshot even when several threads
    share one `VerificationCache`.

    One deliberate consequence: if you edit `.data` directly and then call `put` again, that edit
    is **not** merged — `put` starts from a fresh read of disk, not from your edited `.data`.
    Direct edits to `.data` must be persisted explicitly (there is no `save()` here; write
    through `._doc.update(lambda _data: self.data)` if you need that, mirroring
    `ContextRegistry.save()`).
    """
    def __init__(self, root: str|Path|None=None):
        root=Path(root) if root is not None else default_state_root()
        self.path=root/'verification_cache.json'
        self._doc=JsonDocument(self.path, {'schema_version':3,'entries':{}})
        self._lock=threading.Lock()
        self.data=self._doc.read()
    def key(self,command:str,revision:str,environment_fingerprint:str,relevant_inputs:list[str]|None=None):
        return stable_hash({'command':command,'revision':revision,'env':environment_fingerprint,'inputs':sorted(relevant_inputs or [])})
    def get(self,**kwargs): return self.data['entries'].get(self.key(**kwargs))
    def put(self, *, command:str,revision:str,environment_fingerprint:str,result:str,duration_ms:int=0,relevant_inputs:list[str]|None=None,exit_code:int|None=None,expected_count:int|None=None,actual_count:int|None=None,stdout_truncated:bool=False):
        k=self.key(command,revision,environment_fingerprint,relevant_inputs)
        obj={'key':k,'command':command,'revision':revision,'environment_fingerprint':environment_fingerprint,'result':result,'duration_ms':duration_ms,'relevant_inputs':relevant_inputs or [],'exit_code':exit_code,'expected_count':expected_count,'actual_count':actual_count,'stdout_truncated':stdout_truncated,'recorded_at':utc_now()}
        def _apply(data):
            data['entries'][k]=obj; return data
        with self._lock:
            self.data=self._doc.update(_apply)
        return obj

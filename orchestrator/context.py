from __future__ import annotations
import threading
from pathlib import Path
from typing import Any
from .runtime import default_state_root, stable_hash, utc_now
from .store.documents import JsonDocument

class ContextRegistry:
    """Cross-process-safe wrapper around `context_registry.json` (a `JsonDocument`).

    `.data` is a convenience snapshot for readers (e.g. `packet()`), not the source of truth.
    Every mutating method (`put`, `invalidate`, `invalidate_dependents`) re-reads the document
    from disk under `JsonDocument`'s file lock, applies its own change to that fresh state, and
    only then assigns the written result to `.data` — all while holding an instance-level
    `threading.Lock` that also serializes concurrent calls on a *shared* instance across threads,
    so `.data` can never regress to an older snapshot even when several threads share one
    `ContextRegistry`.

    One deliberate consequence: if you edit `.data` directly (as the pre-B3 code allowed) and then
    call another mutating method, that edit is **not** merged — the mutating method starts from a
    fresh read of disk, not from your edited `.data`. Direct edits to `.data` must be persisted
    with `save()`, which writes the current `.data` snapshot verbatim under the lock (same as the
    pre-B3 `save()`).
    """
    def __init__(self, root: str|Path|None=None):
        root=Path(root) if root is not None else default_state_root()
        self.path=root/'context_registry.json'
        self._doc=JsonDocument(self.path, {'schema_version':3,'artifacts':{}})
        self._lock=threading.Lock()
        self.data=self._doc.read()
    def save(self):
        with self._lock:
            self.data=self._doc.update(lambda _data: self.data)
    def put(self, artifact_id:str, content:Any, *, source:str, status:str='observed', repo_revision:str|None=None, dependencies:list[str]|None=None, token_estimate:int|None=None):
        obj={'id':artifact_id,'hash':stable_hash(content),'content':content,'source':source,'status':status,'repo_revision':repo_revision,'dependencies':dependencies or [],'token_estimate':token_estimate,'valid':True,'updated_at':utc_now()}
        def _apply(data):
            data['artifacts'][artifact_id]=obj; return data
        with self._lock:
            self.data=self._doc.update(_apply)
        return obj
    def invalidate(self,artifact_id:str,reason:str):
        def _apply(data):
            if artifact_id not in data['artifacts']:
                return None
            data['artifacts'][artifact_id]['valid']=False; data['artifacts'][artifact_id]['invalid_reason']=reason; data['artifacts'][artifact_id]['invalidated_at']=utc_now()
            return data
        with self._lock:
            self.data=self._doc.update(_apply)
    def invalidate_dependents(self,artifact_id:str,reason:str='dependency invalidated'):
        def _apply(data):
            queue=[artifact_id]; seen=set()
            while queue:
                parent=queue.pop(0)
                if parent in seen: continue
                seen.add(parent)
                for aid,a in data['artifacts'].items():
                    if a.get('valid',True) and parent in a.get('dependencies',[]):
                        a['valid']=False; a['invalid_reason']=reason; a['invalidated_at']=utc_now(); queue.append(aid)
            return data
        with self._lock:
            self.data=self._doc.update(_apply)
    def packet(self, ids:list[str], budget_tokens:int)->dict:
        data=self.data
        selected=[]; used=0; missing=[]
        for aid in ids:
            a=data['artifacts'].get(aid)
            if not a or not a.get('valid',True): missing.append(aid); continue
            est=int(a.get('token_estimate') or max(1,len(str(a.get('content','')))//4))
            if used+est>budget_tokens: continue
            selected.append(a); used+=est
        return {'artifact_ids':[a['id'] for a in selected],'artifacts':selected,'estimated_tokens':used,'budget_tokens':budget_tokens,'missing_or_stale':missing,'packet_hash':stable_hash([(a['id'],a['hash']) for a in selected])}

from __future__ import annotations
from pathlib import Path
from .runtime import default_state_root, stable_hash, utc_now
from .analytics.verification import flaky_stats  # re-exported: moved to analytics (B3)
from .store.documents import JsonDocument

__all__ = ['VerificationCache', 'flaky_stats']

class VerificationCache:
    def __init__(self, root: str|Path|None=None):
        root=Path(root) if root is not None else default_state_root()
        self._doc=JsonDocument(root/'verification_cache.json', {'schema_version':3,'entries':{}})
    def key(self,command:str,revision:str,environment_fingerprint:str,relevant_inputs:list[str]|None=None):
        return stable_hash({'command':command,'revision':revision,'env':environment_fingerprint,'inputs':sorted(relevant_inputs or [])})
    def get(self,**kwargs): return self._doc.read()['entries'].get(self.key(**kwargs))
    def put(self, *, command:str,revision:str,environment_fingerprint:str,result:str,duration_ms:int=0,relevant_inputs:list[str]|None=None,exit_code:int|None=None,expected_count:int|None=None,actual_count:int|None=None,stdout_truncated:bool=False):
        k=self.key(command,revision,environment_fingerprint,relevant_inputs)
        obj={'key':k,'command':command,'revision':revision,'environment_fingerprint':environment_fingerprint,'result':result,'duration_ms':duration_ms,'relevant_inputs':relevant_inputs or [],'exit_code':exit_code,'expected_count':expected_count,'actual_count':actual_count,'stdout_truncated':stdout_truncated,'recorded_at':utc_now()}
        def _apply(data):
            data['entries'][k]=obj; return data
        self._doc.update(_apply); return obj

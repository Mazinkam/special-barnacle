from __future__ import annotations
from pathlib import Path
from typing import Any
from .runtime import default_state_root, stable_hash, read_json, write_json, utc_now

class ContextRegistry:
    def __init__(self, root: str|Path|None=None):
        root=Path(root) if root is not None else default_state_root(); self.path=root/'context_registry.json'; self.data=read_json(self.path,{'schema_version':3,'artifacts':{}})
    def save(self): write_json(self.path,self.data)
    def put(self, artifact_id:str, content:Any, *, source:str, status:str='observed', repo_revision:str|None=None, dependencies:list[str]|None=None, token_estimate:int|None=None):
        obj={'id':artifact_id,'hash':stable_hash(content),'content':content,'source':source,'status':status,'repo_revision':repo_revision,'dependencies':dependencies or [],'token_estimate':token_estimate,'valid':True,'updated_at':utc_now()}
        self.data['artifacts'][artifact_id]=obj; self.save(); return obj
    def invalidate(self,artifact_id:str,reason:str):
        if artifact_id in self.data['artifacts']:
            self.data['artifacts'][artifact_id]['valid']=False; self.data['artifacts'][artifact_id]['invalid_reason']=reason; self.data['artifacts'][artifact_id]['invalidated_at']=utc_now(); self.save()
    def invalidate_dependents(self,artifact_id:str,reason:str='dependency invalidated'):
        queue=[artifact_id]; seen=set()
        while queue:
            parent=queue.pop(0)
            if parent in seen: continue
            seen.add(parent)
            for aid,a in self.data['artifacts'].items():
                if a.get('valid',True) and parent in a.get('dependencies',[]):
                    a['valid']=False; a['invalid_reason']=reason; a['invalidated_at']=utc_now(); queue.append(aid)
        self.save()
    def packet(self, ids:list[str], budget_tokens:int)->dict:
        selected=[]; used=0; missing=[]
        for aid in ids:
            a=self.data['artifacts'].get(aid)
            if not a or not a.get('valid',True): missing.append(aid); continue
            est=int(a.get('token_estimate') or max(1,len(str(a.get('content','')))//4))
            if used+est>budget_tokens: continue
            selected.append(a); used+=est
        return {'artifact_ids':[a['id'] for a in selected],'artifacts':selected,'estimated_tokens':used,'budget_tokens':budget_tokens,'missing_or_stale':missing,'packet_hash':stable_hash([(a['id'],a['hash']) for a in selected])}

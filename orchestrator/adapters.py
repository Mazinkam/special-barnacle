from __future__ import annotations
from pathlib import Path
import json

class Adapter:
    def __init__(self,data:dict): self.data=data
    @classmethod
    def load(cls,path:str|Path): return cls(json.loads(Path(path).read_text()))
    @property
    def name(self): return self.data.get('adapter','unknown')
    def capabilities(self): return sorted(self.data.get('capability_mapping',{}))
    def resolve(self,capability:str,effort:str='standard')->dict:
        model=self.data.get('capability_mapping',{}).get(capability)
        if not model: raise KeyError(f'Capability not mapped: {capability}')
        supports=bool(self.data.get('supports_effort',False))
        resolved=self.data.get('effort_mapping',{}).get(effort) if supports else None
        return {
            'adapter':self.name,'capability':capability,'model':model,'model_family':self.data.get('family_mapping',{}).get(model),
            'requested_effort':effort,'resolved_effort':resolved,'supports_effort':supports,
            'supports_parallel_agents':bool(self.data.get('supports_parallel_agents',False)),
            'supports_usage_telemetry':bool(self.data.get('supports_usage_telemetry',False)),
            'supports_worktrees':bool(self.data.get('supports_worktrees',False)),
        }

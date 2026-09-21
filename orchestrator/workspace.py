from __future__ import annotations
from pathlib import Path
import subprocess, json
from .runtime import default_state_root, read_json, write_json, utc_now

class WorkspaceManager:
    def __init__(self, repo='.', state_root=None):
        self.repo=Path(repo); state_root=Path(state_root) if state_root is not None else default_state_root(); self.lock_path=state_root/'locks.json'; self.locks=read_json(self.lock_path,{'schema_version':3,'resources':{}})
    def git(self,*args):
        return subprocess.run(['git',*args],cwd=self.repo,text=True,capture_output=True,check=True).stdout.strip()
    def revision(self): return self.git('rev-parse','HEAD')
    def create_worktree(self,path:str,branch:str,base:str='HEAD'):
        subprocess.run(['git','worktree','add','-b',branch,path,base],cwd=self.repo,check=True)
        return {'path':path,'branch':branch,'base':base,'created_at':utc_now()}
    def remove_worktree(self,path:str,force:bool=False):
        cmd=['git','worktree','remove'];
        if force: cmd.append('--force')
        cmd.append(path); subprocess.run(cmd,cwd=self.repo,check=True)
    def acquire(self,resource:str,owner:str):
        cur=self.locks['resources'].get(resource)
        if cur and cur.get('owner')!=owner: raise RuntimeError(f'{resource} owned by {cur.get("owner")}')
        self.locks['resources'][resource]={'owner':owner,'acquired_at':utc_now()}; write_json(self.lock_path,self.locks)
    def release(self,resource:str,owner:str):
        cur=self.locks['resources'].get(resource)
        if cur and cur.get('owner')==owner: self.locks['resources'].pop(resource,None); write_json(self.lock_path,self.locks)

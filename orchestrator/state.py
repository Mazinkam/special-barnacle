from __future__ import annotations
from pathlib import Path
from typing import Any
from .runtime import EventStore, write_json, read_json, utc_now

EMPTY={"schema_version":3,"updated_at":None,"runs":{},"tasks":{},"decisions":{},"workstreams":{},"locks":{},"artifacts":{},"verification":{},"repo_revision":None,"adaptive":{}}

def reduce_event(state:dict[str,Any], e:dict[str,Any])->dict[str,Any]:
    t=e.get('event'); rid=e.get('run_id'); tid=e.get('task_id')
    if t=='run_started' and rid:
        state['runs'][rid]={**state['runs'].get(rid,{}),**e,'status':'running'}
    elif t=='run_completed' and rid:
        state['runs'].setdefault(rid,{}) .update({**e,'status':'completed'})
    elif t=='run_failed' and rid:
        state['runs'].setdefault(rid,{}) .update({**e,'status':'failed'})
    elif t=='routing_explained' and rid:
        state['adaptive'].setdefault(rid,{}) .update(e)
    elif t=='task_created' and tid:
        state['tasks'][tid]={**e,'status':'created'}
    elif t in {'task_assigned','task_started','task_completed','task_verified','task_failed','task_escalated','task_cancelled'} and tid:
        obj=state['tasks'].setdefault(tid,{})
        obj.update(e); obj['status']=t.replace('task_','')
    elif t in {'decision_created','decision_resolved','decision_invalidated'}:
        did=e.get('decision_id')
        if did: state['decisions'].setdefault(did,{}).update(e)
    elif t in {'workstream_created','workstream_completed'}:
        wid=e.get('workstream_id')
        if wid: state['workstreams'].setdefault(wid,{}).update(e)
    elif t=='repo_revision': state['repo_revision']=e.get('revision')
    elif t in {'lock_acquired','lock_released'}:
        key=e.get('resource')
        if key:
            if t=='lock_acquired': state['locks'][key]=e
            else: state['locks'].pop(key,None)
    state['updated_at']=e.get('ts',utc_now()); return state

def rebuild(root: str|Path|None=None)->dict[str,Any]:
    store=EventStore(root); root=store.root; state={k:(v.copy() if isinstance(v,dict) else v) for k,v in EMPTY.items()}
    for k in ['runs','tasks','decisions','workstreams','locks','artifacts','verification','adaptive']: state[k]={}
    for e in store.all_events(): reduce_event(state,e)
    write_json(Path(root)/'ledger.json',state); return state

def load_or_rebuild(root: str|Path|None=None):
    root=EventStore(root).root; p=root/'ledger.json'
    obj=read_json(p,None)
    if not obj or obj.get('schema_version')!=3:
        return rebuild(root)
    return obj

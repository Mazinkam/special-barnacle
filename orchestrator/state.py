from __future__ import annotations
from pathlib import Path
from typing import Any
# core.*, not runtime: this module is imported by record_batch, which store.facade.EventStore
# imports; orchestrator.runtime re-exports EventStore, so importing runtime here would cycle
# (see docs/architecture-review.md B2.2/B2.3). state.* build a StateLayout instead of an
# EventStore for the same directory/stream side effects.
from .core.fs import read_json, write_json, writer_lock
from .core.env import utc_now
from .core.jsonl import iter_jsonl_from, tail_fingerprint
from .core.layout import StateLayout
from .contract import STREAMS
from .record_index import discard as discard_record_index

LEDGER_FILE='ledger.json'
LEDGER_CHECKPOINT_VERSION=1
EMPTY={"schema_version":3,"updated_at":None,"runs":{},"tasks":{},"decisions":{},"workstreams":{},"locks":{},"artifacts":{},"verification":{},"repo_revision":None,"adaptive":{},"checkpoint":None}
_SECTIONS=['runs','tasks','decisions','workstreams','locks','artifacts','verification','adaptive']
# Identifier fields `reduce_event` (and the dashboard) use as dict keys. They must be strings: an
# unhashable value raises mid-replay and poisons every later refresh, and a non-string hashable
# (7 vs "7") splits one entity into two keys that collide again after JSON round-tripping.
REDUCER_KEY_FIELDS=('run_id','task_id','decision_id','workstream_id','resource')

def invalid_key_field(record:dict[str,Any])->str|None:
    """Name of the first identifier field that is present but not a string (None is allowed), else None."""
    for field in REDUCER_KEY_FIELDS:
        value=record.get(field)
        if value is not None and not isinstance(value,str): return field
    return None

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

def _empty_state()->dict[str,Any]:
    state={k:(v.copy() if isinstance(v,dict) else v) for k,v in EMPTY.items()}
    for k in _SECTIONS: state[k]={}
    return state

def _checkpoint(events: Path, offset:int, replayed:int)->dict[str,Any]:
    return {'format_version':LEDGER_CHECKPOINT_VERSION,'events_offset':offset,'events_tail_hash':tail_fingerprint(events,offset),'events_replayed':replayed}

def _resumable_checkpoint(ledger:Any, events:Path)->dict[str,Any]|None:
    """Return the ledger's checkpoint if it still describes a complete prefix of `events`, else None."""
    if not isinstance(ledger,dict) or ledger.get('schema_version')!=3: return None
    ck=ledger.get('checkpoint')
    if not isinstance(ck,dict) or ck.get('format_version')!=LEDGER_CHECKPOINT_VERSION: return None
    offset=ck.get('events_offset'); replayed=ck.get('events_replayed')
    if isinstance(offset,bool) or not isinstance(offset,int) or offset<0: return None
    if isinstance(replayed,bool) or not isinstance(replayed,int) or replayed<0: return None
    if not events.exists() or offset>events.stat().st_size: return None
    if tail_fingerprint(events,offset)!=ck.get('events_tail_hash'): return None
    if not all(isinstance(ledger.get(k),dict) for k in _SECTIONS): return None
    return ck

def _replay_into(state:dict[str,Any], events:Path, offset:int, replayed:int, seen_ids:set[str]|None)->tuple[int,int]:
    """Reduce every complete event line from `offset`; return (new_offset, replayed_count)."""
    for record,end in iter_jsonl_from(events,offset):
        offset=end
        if record is None or not isinstance(record,dict): continue
        if invalid_key_field(record) is not None: continue  # legacy poison line; skipped like a malformed one
        rid=record.get('record_id')
        if seen_ids is not None and rid:
            if rid in seen_ids: continue
            seen_ids.add(rid)
        reduce_event(state,record); replayed+=1
    return offset,replayed

def _publish(root:Path, state:dict[str,Any], offset:int, replayed:int)->dict[str,Any]:
    state['checkpoint']=_checkpoint(root/STREAMS['event'],offset,replayed)
    write_json(root/LEDGER_FILE,state); return state

def replay_ledger(root: str|Path, *, full:bool=False)->dict[str,Any]:
    """Bring the ledger up to the complete prefix of events.jsonl. Caller must hold `writer_lock`.

    Incremental replay resumes from the checkpoint stored in ledger metadata when it still
    matches the stream; otherwise (legacy ledger, corrupt or stale checkpoint, rewritten file,
    `full=True`) the whole stream is replayed. Full replay also collapses repeated `record_id`s,
    which is how duplicates that bypassed append-time deduplication are recovered.
    """
    root=Path(root); events=root/STREAMS['event']
    if not full:
        ledger=read_json(root/LEDGER_FILE,None); ck=_resumable_checkpoint(ledger,events)
        if ck is not None:
            offset,replayed=_replay_into(ledger,events,ck['events_offset'],ck['events_replayed'],None)
            return _publish(root,ledger,offset,replayed)
    state=_empty_state()
    offset,replayed=_replay_into(state,events,0,0,set())
    return _publish(root,state,offset,replayed)

def ledger_is_current(root: str|Path, events_offset:int)->bool:
    """Does the published ledger resumably describe exactly the complete prefix ending at `events_offset`?

    Authoritative catch-up test for writers (caller holds `writer_lock`): compares the ledger's
    durable offset with the complete-prefix end the caller derived from `events.jsonl` itself, after
    verifying the offset still lands on a line boundary of the current file. A missing, legacy or
    stale ledger, or one whose prefix was repaired/extended by another writer, is not current.
    """
    root=Path(root); ck=_resumable_checkpoint(read_json(root/LEDGER_FILE,None),root/STREAMS['event'])
    return ck is not None and ck['events_offset']==events_offset

def rebuild(root: str|Path|None=None)->dict[str,Any]:
    """Full recovery replay of events.jsonl into ledger.json (serialized with all writers).

    Every derived file is re-derived from the authoritative JSONL: the ledger is replayed from byte 0
    (collapsing repeated record_ids) and the record-id index is discarded so the next writer rebuilds
    its membership from the streams instead of trusting a cache that may be wrong.
    """
    root=StateLayout(root).root
    with writer_lock(root):
        discard_record_index(root)
        return replay_ledger(root,full=True)

def refresh_ledger(root: str|Path|None=None)->dict[str,Any]:
    """Incremental catch-up of the ledger from its durable event offset (serialized with all writers)."""
    root=StateLayout(root).root
    with writer_lock(root): return replay_ledger(root)

def load_or_rebuild(root: str|Path|None=None):
    root=StateLayout(root).root; p=root/LEDGER_FILE
    obj=read_json(p,None)
    if not obj or obj.get('schema_version')!=3:
        return rebuild(root)
    return obj

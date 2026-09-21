from __future__ import annotations
from pathlib import Path
from collections import defaultdict
from typing import Any
from datetime import datetime, timezone
import math
from .runtime import default_state_root, load_jsonl


def bucket_complexity(x:float,width:int=2)->str:
    x=max(1,min(10,float(x))); lo=int((x-1)//width)*width+1; hi=min(10,lo+width-1); return f'{lo}-{hi}'


def comparable_key(r:dict,width:int=2):
    return (
        r.get('task_class','unknown'),bucket_complexity(r.get('complexity',5),width),r.get('risk','medium'),
        r.get('capability_class') or r.get('role','unknown'),r.get('effort','standard'),r.get('verification_depth','targeted'),
        r.get('topology_shape')
    )


def _weight(ts:str|None, half_life_days:float|None)->float:
    if not half_life_days or not ts: return 1.0
    try:
        dt=datetime.fromisoformat(ts.replace('Z','+00:00'))
        if dt.tzinfo is None: dt=dt.replace(tzinfo=timezone.utc)
        age=max(0.0,(datetime.now(timezone.utc)-dt).total_seconds()/86400)
        return 0.5 ** (age/float(half_life_days))
    except Exception:
        return 1.0


def build_route_stats(metrics:list[dict], outcomes:list[dict]|None=None, width:int=2, decay_half_life_days:float|None=None)->list[dict]:
    groups=defaultdict(list)
    out_by_task=defaultdict(list)
    for o in outcomes or []:
        if o.get('task_id'): out_by_task[o['task_id']].append(o)
    for r in metrics:
        if r.get('event') not in {None,'model_call','task_verified','route_observation','adaptive_route_decision'} and not r.get('cost_usd'):
            continue
        if not (r.get('capability_class') or r.get('role')):
            continue
        groups[comparable_key(r,width)].append(r)
    result=[]
    for key,rows in groups.items():
        weighted=[(r,_weight(r.get('ts'),decay_half_life_days)) for r in rows]
        eff=sum(w for _,w in weighted)
        total=sum((float(x.get('cost_usd',0) or 0)+float(x.get('ci_cost_usd',0) or 0)+float(x.get('human_cost_usd',0) or 0))*w for x,w in weighted)
        task_weights={}
        for x,w in weighted:
            if x.get('result')=='verified' or x.get('event')=='task_verified':
                tid=x.get('task_id')
                if tid: task_weights[tid]=max(task_weights.get(tid,0),w)
        verified_weight=sum(task_weights.values())
        verified=set(task_weights)
        successes=sum(w for x,w in weighted if x.get('result') in {'pass','verified','success'})
        quality_num=sum(float(x['quality_evidence_score'])*w for x,w in weighted if x.get('quality_evidence_score') is not None)
        quality_den=sum(w for x,w in weighted if x.get('quality_evidence_score') is not None)
        retries=sum(int(x.get('retry',0) or 0)*w for x,w in weighted)
        delayed_bad=0; delayed_total=0
        for tid in {x.get('task_id') for x in rows}-{None}:
            os=out_by_task.get(tid,[])
            if os:
                delayed_total+=1
                if any(o.get('reopened') or o.get('regression') or o.get('rollback') or o.get('human_correction') or o.get('incident') for o in os): delayed_bad+=1
        task_class,cb,risk,cap,effort,ver,shape=key
        depths=[int(x.get('topology_depth')) for x in rows if x.get('topology_depth') is not None]
        workers=[int(x.get('topology_workers')) for x in rows if x.get('topology_workers') is not None]
        leads=[int(x.get('topology_leads')) for x in rows if x.get('topology_leads') is not None]
        result.append({
            'task_class':task_class,'complexity_bucket':cb,'risk':risk,'capability':cap,'effort':effort,'verification_depth':ver,
            'topology_shape':shape,'topology_depth':round(sum(depths)/len(depths)) if depths else None,
            'topology_workers':round(sum(workers)/len(workers)) if workers else None,'topology_leads':round(sum(leads)/len(leads)) if leads else None,
            'samples':len(rows),'effective_samples':eff,'total_cost_usd':total,'avg_call_cost_usd':total/eff if eff else None,
            'verified_tasks':len(verified),'verified_cost_usd':total/verified_weight if verified_weight else None,
            'pass_rate':successes/eff if eff else None,'avg_quality_evidence':quality_num/quality_den if quality_den else None,
            'retry_rate':retries/eff if eff else None,'delayed_failure_rate':delayed_bad/delayed_total if delayed_total else None
        })
    return sorted(result,key=lambda x:(x['task_class'],x['risk'],x['complexity_bucket'],x['capability'],x['effort'],str(x.get('topology_shape'))))


def load_stats(root=None,width=2,decay_half_life_days:float|None=None):
    root=Path(root) if root is not None else default_state_root(); return build_route_stats(load_jsonl(root/'metrics.jsonl'),load_jsonl(root/'outcomes.jsonl'),width,decay_half_life_days)

from __future__ import annotations
from pathlib import Path
from collections import defaultdict
from typing import Any
from datetime import datetime, timezone
import math
from .runtime import default_state_root, load_jsonl
from . import records
from .outcomes import bad_signal
from .economics import is_call_row, is_session_ingest


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


def _resolve_verified_task_ids(metrics:list[dict], outcomes:list[dict]|None)->set[str]:
    """task_id -> attested-verified verdict, joined once across ALL metrics + ALL outcomes rows.

    A verification row (`event: task_verified`, or an outcomes-stream verdict field) carries no
    routing context (`task_class`/`complexity`/`risk`/`effort`/`verification_depth`/
    `topology_shape`), so `comparable_key` puts it in a different group than the `model_call` row
    for the same `task_id`. Requiring the verifying row to fall inside a group therefore left the
    per-route "Verified"/"Cost per verified" columns (and `scheduler.recommend_package`, which is
    driven by `verified_cost_usd`) blind to verification even when it was attested — e.g. a
    `model_call(task_class='crud')` plus a same-task_id `task_verified` row credited a phantom
    group instead of the `crud` group that actually holds the cost.

    Resolved once, globally, over the *unfiltered* input (before `comparable_key` grouping and
    before the capability/event pre-filter below drops rows), then looked up per task_id when a
    group is accumulated — mirroring `dashboard._verification_task_ids`, which already joins this
    way across the whole stream rather than per group. This function does not touch
    `comparable_key`/`bucket_complexity`/grouping shape at all; it only changes which task_ids a
    group is allowed to credit.

    Conservative resolution: an attested `failed` verdict for a task_id beats an attested
    `verified` verdict for the same task_id, however/whenever the two are ordered, so contradictory
    evidence never counts as verified — over-counting verified tasks is exactly the failure mode
    this branch exists to eliminate.

    """
    by_task:dict[str,list[dict]] = defaultdict(list)
    for row in list(metrics)+list(outcomes or []):
        tid=row.get('task_id')
        if tid:
            by_task[str(tid)].append(row)
    return {tid for tid, rows in by_task.items() if records.is_task_attested_verified(rows)}


def build_route_stats(metrics:list[dict], outcomes:list[dict]|None=None, width:int=2, decay_half_life_days:float|None=None)->list[dict]:
    """Comparable-route aggregates.

    `samples`/`effective_samples` keep their legacy meaning (every contributing row). The
    sample counts that gate empirical routing are reported separately, because a model call,
    a verification marker, and a decision row are not interchangeable evidence:
    `call_samples`, `verification_samples`, `task_samples`, `run_samples`, `verified_tasks`,
    `verified_runs`. Interactive-session ingestion never contributes to orchestrated routes.
    """
    groups=defaultdict(list)
    out_by_task=defaultdict(list)
    verified_task_ids=_resolve_verified_task_ids(metrics,outcomes)
    for o in outcomes or []:
        if o.get('task_id'): out_by_task[o['task_id']].append(o)
    for r in metrics:
        if is_session_ingest(r):
            continue
        if r.get('event') not in {None,'model_call','task_verified','route_observation','adaptive_route_decision'} and not r.get('cost_usd'):
            continue
        if not (r.get('capability_class') or r.get('role')):
            continue
        groups[comparable_key(r,width)].append(r)
    result=[]
    for key,rows in groups.items():
        task_class,cb,risk,cap,effort,ver,shape=key
        # Groups whose capability could not be resolved (comparable_key's `unknown` fallback,
        # 9 live route_executed rows) carry no meaningful package signal and must not drive
        # `scheduler.recommend_package`. DEFAULT_PACKAGES never declares capability=='unknown',
        # so these rows already fail to match there; excluding them here as well keeps the
        # exclusion visible at the source instead of relying on that coincidence, without any
        # change to scheduler.py.
        if cap == 'unknown':
            continue
        weighted=[(r,_weight(r.get('ts'),decay_half_life_days)) for r in rows]
        eff=sum(w for _,w in weighted)
        total=sum((float(x.get('cost_usd',0) or 0)+float(x.get('ci_cost_usd',0) or 0)+float(x.get('human_cost_usd',0) or 0))*w for x,w in weighted)
        task_weights={}
        for x,w in weighted:
            tid=x.get('task_id')
            if not tid: continue
            # ATTESTED evidence only, resolved globally by `_resolve_verified_task_ids` above (joined
            # by task_id across ALL metrics + ALL outcomes rows, not just this group's own rows) —
            # a task counts as verified when ANY row anywhere attests it, and NOT when a
            # contradicting attested-failed verdict exists for the same task_id.
            #
            # A metrics `result: 'pass'` is deliberately NOT enough: it says the dispatched
            # subprocess exited 0, not that the task cleared its quality gates. Gating on it
            # populated `verified_cost_usd` for 75 of 85 live groups off 164 dispatch-passing task
            # ids while only 18 were ever attested verified, turning cost-per-dispatch-pass into a
            # figure labelled cost-per-verified-task. Expect far fewer groups to carry a
            # non-null `verified_cost_usd` — that is the honest number, not a regression.
            # See records.verification_evidence.
            if str(tid) in verified_task_ids: task_weights[tid]=max(task_weights.get(tid,0),w)
        verified_weight=sum(task_weights.values())
        verified=set(task_weights)
        # Keep dispatch success separate from attested verification; routing thresholds use the
        # explicit sample counts below rather than treating every record as interchangeable.
        verified_runs={x.get('run_id') for x in rows if x.get('run_id') is not None and x.get('task_id') in verified}
        call_samples=sum(1 for x in rows if is_call_row(x))
        verification_samples=sum(1 for x in rows if x.get('result')=='verified' or x.get('event')=='task_verified')
        task_samples=len({x.get('task_id') for x in rows}-{None})
        run_samples=len({x.get('run_id') for x in rows}-{None})
        successes=sum(w for x,w in weighted if x.get('result') in {'pass','verified','success'})
        quality_num=sum(float(x['quality_evidence_score'])*w for x,w in weighted if x.get('quality_evidence_score') is not None)
        quality_den=sum(w for x,w in weighted if x.get('quality_evidence_score') is not None)
        has_retry=any('retry' in x for x,_ in weighted)
        retries=sum(int(x.get('retry',0) or 0)*w for x,w in weighted)
        delayed_bad=0; delayed_total=0
        for tid in {x.get('task_id') for x in rows}-{None}:
            os=out_by_task.get(tid,[])
            if os:
                delayed_total+=1
                if any(bad_signal(o) for o in os): delayed_bad+=1
        depths=[int(x.get('topology_depth')) for x in rows if x.get('topology_depth') is not None]
        workers=[int(x.get('topology_workers')) for x in rows if x.get('topology_workers') is not None]
        leads=[int(x.get('topology_leads')) for x in rows if x.get('topology_leads') is not None]
        result.append({
            'task_class':task_class,'complexity_bucket':cb,'risk':risk,'capability':cap,'effort':effort,'verification_depth':ver,
            'topology_shape':shape,'topology_depth':round(sum(depths)/len(depths)) if depths else None,
            'topology_workers':round(sum(workers)/len(workers)) if workers else None,'topology_leads':round(sum(leads)/len(leads)) if leads else None,
            'samples':len(rows),'effective_samples':eff,'total_cost_usd':total,'avg_call_cost_usd':total/eff if eff else None,
            # Verified metrics are attested-only, while dispatch success remains a separate signal.
            'call_samples':call_samples,'verification_samples':verification_samples,'task_samples':task_samples,'run_samples':run_samples,
            'verified_tasks':len(verified),'verified_runs':len(verified_runs),'verified_cost_usd':total/verified_weight if verified_weight else None,
            'pass_rate':successes/eff if eff else None,
            'avg_quality_evidence':records.metric(quality_num/quality_den if quality_den else None,quality_den),
            'retry_rate':(retries/eff if eff else None) if has_retry else records.NO_DATA,
            'delayed_failure_rate':delayed_bad/delayed_total if delayed_total else None
        })
    return sorted(result,key=lambda x:(x['task_class'],x['risk'],x['complexity_bucket'],x['capability'],x['effort'],str(x.get('topology_shape'))))


def load_stats(root=None,width=2,decay_half_life_days:float|None=None):
    root=Path(root) if root is not None else default_state_root(); return build_route_stats(load_jsonl(root/'metrics.jsonl'),load_jsonl(root/'outcomes.jsonl'),width,decay_half_life_days)

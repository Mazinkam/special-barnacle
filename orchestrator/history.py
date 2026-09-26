from __future__ import annotations
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone
from .runtime import default_state_root, load_jsonl
from . import records
from .outcomes import bad_signal
from .economics import is_call_row, is_session_ingest, cost_class, UNMETERED, unique_records
from .contract import STREAMS
from .vocab import TERMINAL_TASK_IDS


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


#: Route fields a verification row inherits from the model_call it verifies (see `_verdict` and the
#: context join in `build_route_stats`).
_ROUTE_FIELDS=('task_class','complexity','risk','capability_class','role','effort','verification_depth',
               'topology_shape','topology_depth','topology_workers','topology_leads')


def _verdict(row:dict)->str|None:
    """The row's ATTESTED verdict — `records.VERIFIED` / `FAILED` / `PARTIAL` — or None.

    Only attested evidence may make a task "verified" (`records.verification_evidence`): a dispatch
    `result: 'pass'|'verified'` on a `model_call` row says the subprocess exited 0, not that the
    task cleared its gates. Gating on it once populated `verified_cost_usd` for 75 of 85 live groups
    from 164 dispatch-passing task ids when only 18 were ever attested verified. Those rows still
    feed `pass_rate`, which legitimately measures dispatch success.

    `engine.Engine.verify_task` writes *both* verdicts to metrics as `event: 'task_verified'` and
    carries the actual verdict in `result` ('verified' | 'fail'), so on that event an explicit,
    recognised `result` decides — still at attested strength. A bare `task_verified` (no `result`)
    remains an attestation of success, as `records` reads it.
    """
    if row.get('event') == 'task_verified' and row.get('result') is not None:
        state, _ = records.verification_evidence({**row, 'event': None})
        if state is not None:
            return state
    state, strength = records.verification_evidence(row)
    return state if strength == records.ATTESTED else None


def _verification_order(row:dict):
    """Order cross-stream evidence by instant; ties — and undated rows — fail conservatively.

    Dated verdicts are chronological: a later attested pass supersedes an earlier attested failure
    (a retry that verified), and vice versa. Two verdicts at the same instant resolve to the failure.
    Undated legacy rows sort before every dated one and, among themselves, the failure wins whatever
    their stream order: without a timestamp nothing can establish that a projected success came
    *after* the failure, and over-counting verified tasks is the failure mode this resolution exists
    to eliminate (`records.resolve_task_verification` breaks the same tie the same way).
    """
    passed=_verdict(row) == records.VERIFIED
    try:
        dt=datetime.fromisoformat(row['ts'].replace('Z','+00:00'))
        if dt.tzinfo is None: dt=dt.replace(tzinfo=timezone.utc)
        return (dt, not passed)
    except (KeyError, TypeError, ValueError, AttributeError):
        return (datetime.min.replace(tzinfo=timezone.utc), not passed)


def build_route_stats(metrics:list[dict], outcomes:list[dict]|None=None, width:int=2, decay_half_life_days:float|None=None)->list[dict]:
    """Comparable-route aggregates.

    `samples`/`effective_samples` keep their legacy meaning (every contributing row). The
    sample counts that gate empirical routing are reported separately, because a model call,
    a verification marker, and a decision row are not interchangeable evidence:
    `call_samples`, `priced_call_samples`, `unmetered_call_samples`, `verification_samples`,
    `task_samples`, `run_samples`, `verified_tasks`, `verified_runs`. Interactive-session
    ingestion never contributes to orchestrated routes, and duplicate `record_id`s count once.

    Verification is joined per `(run_id, task_id)`: an outcomes-stream verdict is projected onto the
    metrics side, a verdict row that carries no route context inherits the route of the *single*
    model_call it verifies (a task retried on two packages awards neither), and the chronologically
    latest attested verdict decides (`_verdict`, `_verification_order`). Cost figures come from
    priced call rows only — a route with unmetered calls has no `avg_call_cost_usd`/`verified_cost_usd`
    rather than an understated one. Aggregates with no measurement are `records.NO_DATA`.
    """
    groups=defaultdict(list)
    out_by_task=defaultdict(list)
    identity=lambda r: (r.get('run_id'), r.get('task_id'))
    for o in unique_records(outcomes or []):
        if o.get('task_id'): out_by_task[identity(o)].append(o)
    metrics=[r for r in unique_records(metrics) if not is_session_ingest(r)]
    # Independent task outcomes may be separate from metric-side verification. Run-terminal
    # outcomes are never task evidence. Keep this a verification projection, not a second bill.
    # The verdict is read through `records` (`outcome`/`success`/`kind`, plus the bridge's boolean
    # `verification`), so `outcome: 'failed'` contradicts `outcome: 'verified'` here exactly as it
    # does on the dashboard.
    for task_outcomes in out_by_task.values():
        for o in task_outcomes:
            if o.get('task_id') in TERMINAL_TASK_IDS: continue
            verdict=_verdict(o)
            if verdict is None and isinstance(o.get('verification'), bool):
                verdict=records.VERIFIED if o['verification'] else records.FAILED
            if verdict is not None:
                fields=('run_id','task_id','ts','quality_evidence_score')+_ROUTE_FIELDS
                metrics.append({**{k:o[k] for k in fields if k in o}, 'event':'task_verified', 'result':verdict})
    contexts=defaultdict(dict)
    for r in metrics:
        if is_call_row(r) and r.get('task_id') and (r.get('capability_class') or r.get('role')):
            contexts[identity(r)][comparable_key(r,width)]=r
    for r in metrics:
        # Ordinary verify_task emits no route context. Join only an unambiguous task route;
        # retries on different packages must not award the same verification to both.
        if _verdict(r) is not None and not (r.get('capability_class') or r.get('role')):
            matches=contexts.get(identity(r),{})
            if len(matches) == 1:
                context=next(iter(matches.values()))
                r={**{k:context[k] for k in _ROUTE_FIELDS if k in context}, **r}
        if r.get('event') not in {None,'model_call','task_verified','task_failed','route_observation','adaptive_route_decision'} and not r.get('cost_usd'):
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
        priced=[(x,w) for x,w in weighted if is_call_row(x) and cost_class(x)!=UNMETERED]
        total=sum((float(x.get('cost_usd',0) or 0)+float(x.get('ci_cost_usd',0) or 0)+float(x.get('human_cost_usd',0) or 0))*w for x,w in priced)
        unpriced=any(is_call_row(x) and cost_class(x)==UNMETERED for x in rows)
        # ATTESTED verdicts only (`_verdict`), latest per (run_id, task_id) wins. A `result: 'pass'`
        # on a model_call is deliberately NOT an attempt: expect far fewer groups to carry a
        # non-null `verified_cost_usd` than the dispatch signal would give — that is the honest
        # number, not a regression. See `records.verification_evidence`.
        attempts=sorted(((x,w) for x,w in weighted if x.get('task_id') and _verdict(x) is not None),
                        key=lambda pair:_verification_order(pair[0]))
        latest={identity(x):(x,w) for x,w in attempts}
        task_weights={tid:w for tid,(x,w) in latest.items() if _verdict(x) == records.VERIFIED}
        verified_weight=sum(task_weights.values())
        verified=set(task_weights)
        verified_runs={rid for rid,tid in verified if rid is not None}
        call_samples=sum(1 for x in rows if is_call_row(x))
        verification_samples=sum(1 for x in rows if _verdict(x) == records.VERIFIED)
        task_samples=len({identity(x) for x in rows if x.get('task_id') is not None})
        run_samples=len({x.get('run_id') for x in rows}-{None})
        # `pass_rate` intentionally keeps the DISPATCH-level signal: it measures how often a
        # dispatched attempt succeeded, which is exactly what `result` reports, so `pass` belongs
        # here. It is NOT a verification rate and must not be read as one — compare `verified_tasks`
        # for that.
        successes=sum(w for x,w in weighted if x.get('result') in {'pass','verified','success'})
        quality_num=sum(float(x['quality_evidence_score'])*w for x,w in weighted if x.get('quality_evidence_score') is not None)
        quality_den=sum(w for x,w in weighted if x.get('quality_evidence_score') is not None)
        # `records.metric` wants the population size, not the decayed weight sum: with decay on, a
        # single fresh sample weighs 0.98 and `int(0.98) == 0` would report NO_DATA for a real score.
        quality_samples=sum(1 for x,_ in weighted if x.get('quality_evidence_score') is not None)
        has_retry=any('retry' in x for x,_ in weighted)
        retries=sum(int(x.get('retry',0) or 0)*w for x,w in weighted)
        delayed_bad=0; delayed_total=0
        for tid in {identity(x) for x in rows if x.get('task_id') is not None}:
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
            # Cost is priced call rows only; a group with any unmetered call has no per-call or
            # per-verified figure rather than an understated one.
            'samples':len(rows),'effective_samples':eff,'total_cost_usd':total if priced else None,'avg_call_cost_usd':total/sum(w for _,w in priced) if priced and not unpriced else None,
            'call_samples':call_samples,'priced_call_samples':len(priced),'unmetered_call_samples':call_samples-len(priced),
            'verification_samples':verification_samples,'task_samples':task_samples,'run_samples':run_samples,
            # `verified_tasks`/`verified_cost_usd` are attested-only; None (NO_DATA) when a group has
            # dispatch passes but nothing attested, rather than a cost-per-dispatch-pass wearing the
            # cost-per-verified-task label.
            'verified_tasks':len(verified),'verified_runs':len(verified_runs),'verified_cost_usd':total/verified_weight if verified_weight and priced and not unpriced else None,
            # Dispatch-level success rate (see `successes` above), not a verification rate.
            'pass_rate':successes/eff if eff else None,
            # `quality_evidence_score` is written only by Engine.verify_task, never by a live run
            # (0 of 410 rows) — NO_DATA distinguishes "no producer yet" from "measured zero".
            'avg_quality_evidence':records.metric(quality_num/quality_den if quality_den else None,quality_samples),
            # NO_DATA when no row in the group carries `retry` at all (a fabricated 0.0 otherwise);
            # a real 0.0 is kept when rows do carry retry==0.
            'retry_rate':(retries/eff if eff else None) if has_retry else records.NO_DATA,
            'delayed_failure_rate':delayed_bad/delayed_total if delayed_total else None
        })
    return sorted(result,key=lambda x:(x['task_class'],x['risk'],x['complexity_bucket'],x['capability'],x['effort'],str(x.get('topology_shape'))))


def load_stats(root=None,width=2,decay_half_life_days:float|None=None):
    root=Path(root) if root is not None else default_state_root(); return build_route_stats(load_jsonl(root/STREAMS['metric']),load_jsonl(root/STREAMS['outcome']),width,decay_half_life_days)

from __future__ import annotations

from pathlib import Path
from collections import defaultdict
import json

from .runtime import default_state_root, load_jsonl, read_json
from .history import build_route_stats
from .economics import waste_cost, orchestration_overhead, fanout_rework, cost_attribution, cost_class, is_call_row, is_session_ingest, row_cost, REPORTED, ESTIMATED, UNMETERED
from .outcomes import outcome_summary
from .verification import flaky_stats
from .features import feature_inventory


def quantile(xs,p):
    if not xs:return 0.0
    xs=sorted(xs); k=(len(xs)-1)*p; lo=int(k); hi=min(len(xs)-1,lo+1); return xs[lo]+(xs[hi]-xs[lo])*(k-lo)

def safe(data): return json.dumps(data,ensure_ascii=False).replace('</','<\\/')


def build_data(root:Path, config:dict|None=None):
    config=config or read_json(Path(__file__).with_name('config.json'),{})
    metrics=load_jsonl(root/'metrics.jsonl'); events=load_jsonl(root/'events.jsonl'); outcomes=load_jsonl(root/'outcomes.jsonl')
    ingested=[r for r in metrics if is_session_ingest(r)]
    orchestrated=[r for r in metrics if not is_session_ingest(r)]
    costs=[float(r.get('cost_usd',0) or 0)+float(r.get('ci_cost_usd',0) or 0)+float(r.get('human_cost_usd',0) or 0) for r in orchestrated]
    verified={r.get('task_id') for r in orchestrated if r.get('result')=='verified' or r.get('event')=='task_verified'}-{None}
    total=sum(costs); waste=waste_cost(orchestrated)
    attribution=cost_attribution(orchestrated)
    role=defaultdict(lambda:{'cost':0,'calls':0,'tokens':0})
    runtime=defaultdict(lambda:{'cost':0,'calls':0,'reported_cost':0.0,'estimated_cost':0.0,'metered_calls':0,'unmetered_calls':0})
    policies=defaultdict(lambda:{'cost':0,'calls':0,'verified':set(),'quality':[],'aggr':[]})
    adaptive=[]
    for r in orchestrated:
        rr=r.get('role') or r.get('capability_class') or 'unknown'
        role[rr]['cost']+=float(r.get('cost_usd',0) or 0); role[rr]['calls']+=1
        role[rr]['tokens']+=int(r.get('input_tokens',0) or 0)+int(r.get('output_tokens',0) or 0)
        # Accept the legacy/alternate `runtime` key so a runtime that mislabels the field does
        # not silently pool into 'unknown'.
        agent_runtime=r.get('agent_runtime') or r.get('runtime') or 'unknown'; rt=runtime[agent_runtime]
        rt['cost']+=float(r.get('cost_usd',0) or 0); rt['calls']+=1
        if is_call_row(r):
            provenance=cost_class(r)
            if provenance==REPORTED: rt['reported_cost']+=float(r.get('cost_usd',0) or 0); rt['metered_calls']+=1
            elif provenance==ESTIMATED: rt['estimated_cost']+=float(r.get('cost_usd',0) or 0); rt['metered_calls']+=1
            else: rt['unmetered_calls']+=1
        pid=r.get('policy_id') or 'unknown'; p=policies[pid]
        p['cost']+=float(r.get('cost_usd',0) or 0); p['calls']+=1
        if r.get('result')=='verified' or r.get('event')=='task_verified': p['verified'].add(r.get('task_id'))
        if r.get('quality_evidence_score') is not None:p['quality'].append(float(r['quality_evidence_score']))
        if r.get('cost_aggressiveness') is not None:p['aggr'].append(float(r['cost_aggressiveness']))
        if r.get('event')=='adaptive_route_decision': adaptive.append(r)
    policy_rows=[]
    for pid,p in policies.items():
        vn=len(p['verified']); policy_rows.append({'policy_id':pid,'cost':p['cost'],'calls':p['calls'],'verified':vn,
            'verified_cost':p['cost']/vn if vn else None,'quality':sum(p['quality'])/len(p['quality']) if p['quality'] else None,
            'cost_aggressiveness':sum(p['aggr'])/len(p['aggr']) if p['aggr'] else None})
    context_misses=sum(1 for r in orchestrated if r.get('event') in {'context_packet_miss','context_refetch'})
    context_packets=sum(1 for r in orchestrated if r.get('event')=='context_packet')
    conflicts=sum(1 for e in events if e.get('event') in {'merge_conflict','merge_conflict_resolution'})
    review_wait=[float(r.get('review_wait_ms',0) or 0)/1000 for r in orchestrated if r.get('review_wait_ms') is not None]
    shadow=[r for r in orchestrated if r.get('event')=='shadow_review']
    false_pass=sum(1 for r in shadow if r.get('normal_pass') is True and r.get('shadow_pass') is False)
    over_reject=sum(1 for r in shadow if r.get('normal_pass') is False and r.get('shadow_pass') is True)
    outsum=outcome_summary(root); mature30=[x for x in outsum if x['mature_30d']]
    delayed_bad=sum(1 for x in mature30 if x['bad_outcome'])
    actions=defaultdict(int)
    for r in adaptive: actions[str(r.get('route_action','unknown'))]+=1
    summary={'total_cost':total,'reported_cost':attribution[REPORTED]['cost'],'estimated_cost':attribution[ESTIMATED]['cost'],
        'unmetered_calls':attribution[UNMETERED]['calls'],'call_rows':attribution['call_rows'],'cost_coverage':attribution['coverage'],
        'verified_tasks':len(verified),'verified_cost':total/len(verified) if verified else None,
        'waste_cost':sum(waste.values()),'waste_rate':sum(waste.values())/total if total else 0,
        'orchestration_overhead':orchestration_overhead(orchestrated),'fanout_rework':fanout_rework(events),
        'context_miss_rate':context_misses/context_packets if context_packets else 0,'conflicts':conflicts,
        'review_wait_p90_s':quantile(review_wait,.9),'shadow_false_pass_rate':false_pass/len(shadow) if shadow else None,
        'shadow_over_reject_rate':over_reject/len(shadow) if shadow else None,
        'stable_30d_failure_rate':delayed_bad/len(mature30) if mature30 else None,
        'p50_cost':quantile(costs,.5),'p90_cost':quantile(costs,.9),'p99_cost':quantile(costs,.99),
        'tail_ratio':quantile(costs,.99)/max(1e-9,quantile(costs,.5)) if costs else 0,
        'adaptive_decisions':len(adaptive),'adaptive_actions':dict(actions),
        'exploration_rate_observed':sum(1 for x in adaptive if x.get('explored'))/len(adaptive) if adaptive else None,
        'history_sufficient_rate':sum(1 for x in adaptive if x.get('history_sufficient'))/len(adaptive) if adaptive else None}
    daily=defaultdict(lambda:{'cost':0.0,'calls':0,'verified':set(),'quality':[],'aggr':[],'retries':0,'adaptive':0})
    for r in orchestrated:
        day=str(r.get('ts',''))[:10] or 'unknown'; d=daily[day]; d['cost']+=float(r.get('cost_usd',0) or 0); d['calls']+=1; d['retries']+=int(r.get('retry',0) or 0)
        if r.get('event')=='adaptive_route_decision': d['adaptive']+=1
        if r.get('result')=='verified' or r.get('event')=='task_verified': d['verified'].add(r.get('task_id'))
        if r.get('quality_evidence_score') is not None: d['quality'].append(float(r['quality_evidence_score']))
        if r.get('cost_aggressiveness') is not None: d['aggr'].append(float(r['cost_aggressiveness']))
    trends=[]
    for day,d in sorted(daily.items()):
        vn=len(d['verified']); trends.append({'day':day,'cost':d['cost'],'calls':d['calls'],'verified':vn,
            'verified_cost':d['cost']/vn if vn else None,'quality':sum(d['quality'])/len(d['quality']) if d['quality'] else None,
            'cost_aggressiveness':sum(d['aggr'])/len(d['aggr']) if d['aggr'] else None,'retries':d['retries'],'adaptive':d['adaptive']})
    interactive_sessions={
        'calls':len(ingested),
        'cost':sum(row_cost(r) for r in ingested),
        'tokens':sum(int(r.get('input_tokens',0) or 0)+int(r.get('output_tokens',0) or 0) for r in ingested),
        'by_runtime':{},
        'sessions':len({str(r.get('session_id')) for r in ingested if r.get('session_id') is not None}) or None,
    }
    for r in ingested:
        agent_runtime=r.get('agent_runtime') or r.get('runtime') or 'unknown'
        br=interactive_sessions['by_runtime'].setdefault(agent_runtime,{'calls':0,'cost':0.0})
        br['calls']+=1; br['cost']+=row_cost(r)
    return {'summary':summary,'waste':waste,'by_role':role,'by_runtime':runtime,'policies':policy_rows,'trends':trends,
        'routes':build_route_stats(orchestrated,outcomes),'outcomes':outsum,
        # flaky_stats only matches rows with event=='verification_result'; session-ingest rows
        # are event=='model_call' and never contribute, but we pass `orchestrated` for
        # consistency with the rest of this function's inputs.
        'flaky':flaky_stats(orchestrated),
        'interactive_sessions':interactive_sessions,
        'features':feature_inventory(config.get('features',{})),'adaptive':adaptive[-500:],
        'events':events[-500:],'metrics':metrics[-2000:]}


def generate_dashboard(state_dir=None, config:dict|None=None):
    root=Path(state_dir) if state_dir is not None else default_state_root(); root.mkdir(parents=True,exist_ok=True); data=build_data(root,config)
    doc='''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestrator V3 Dashboard</title><style>
:root{color-scheme:light dark;--bg:#0e1116;--p:#171b22;--b:#2a313c;--t:#edf2f7;--m:#929bab;--a:#7aa7ff;--g:#61c98c;--w:#e9b65e;--r:#e16e6e}@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--p:#fff;--b:#e2e6ec;--t:#111827;--m:#667085}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1320px;margin:auto;padding:22px}h1{margin:0;font-size:25px}.sub{color:var(--m);margin:4px 0 18px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card{background:var(--p);border:1px solid var(--b);border-radius:12px;padding:13px;min-width:0}.k{font-size:12px;color:var(--m)}.v{font-size:22px;font-weight:720;margin-top:3px}.section{margin-top:16px}.section h2{font-size:16px;margin:0 0 10px}table{width:100%;border-collapse:collapse}th,td{padding:7px 8px;border-bottom:1px solid var(--b);text-align:left;white-space:nowrap}th{font-size:12px;color:var(--m)}.scroll{overflow:auto}.bar{height:8px;background:var(--b);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--a)}.small{font-size:12px;color:var(--m)}.risk{display:grid;grid-template-columns:1fr 110px;gap:8px;padding:7px 0;border-bottom:1px solid var(--b)}.timeline{max-height:320px;overflow:auto}.event{padding:7px 0;border-bottom:1px solid var(--b)}.pill{display:inline-block;padding:2px 7px;border:1px solid var(--b);border-radius:999px;font-size:12px}.on{color:var(--g)}.off{color:var(--m)}.warn{color:var(--w)}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main><h1>Hierarchical Orchestrator V3</h1><div class="sub">Adaptive routing, empirical economics, feature state, delayed outcomes, and risk observability. Counterfactuals remain estimates. Spend is split by provenance: provider-reported, estimated from reported tokens, or unmetered — unmetered work is never shown as $0.</div><div id="cards" class="grid"></div>
<div class="section grid" style="grid-template-columns:1.1fr .9fr"><div class="card"><h2>Adaptive routing health</h2><div id="adaptiveHealth"></div></div><div class="card"><h2>Risk observatory</h2><div id="risk"></div></div></div>
<div class="section card"><h2>V3 feature controls</h2><div class="scroll"><table id="features"></table></div></div>
<div class="section card"><h2>Recent adaptive decisions</h2><div class="scroll"><table id="adaptive"></table></div></div>
<div class="section card"><h2>Policy cohorts</h2><div class="scroll"><table id="policies"></table></div></div>
<div class="section card"><h2>Daily trend</h2><div class="scroll"><table id="trends"></table></div></div>
<div class="section card"><h2>Historical route economics</h2><div class="scroll"><table id="routes"></table></div></div>
<div class="section card"><h2>Cost by role</h2><div id="roles"></div></div>
<div class="section card"><h2>Cost by agent runtime</h2><div id="runtimes"></div></div>
<div class="section card"><h2>Interactive sessions (ingested, not orchestrated)</h2><div id="interactive"></div></div>
<div class="section card"><h2>Recent events</h2><div class="timeline" id="events"></div></div>
<script>const D='''+safe(data)+''';const $=s=>document.querySelector(s);const money=x=>x==null?'—':'$'+Number(x).toFixed(4);const pc=x=>x==null?'—':(Number(x)*100).toFixed(1)+'%';const n=x=>Number(x||0).toLocaleString();const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S=D.summary;const cards=[['Provider-reported spend',money(S.reported_cost)],['Estimated spend',money(S.estimated_cost)],['Unmetered calls',n(S.unmetered_calls)+' of '+n(S.call_rows)],['Cost coverage',pc(S.cost_coverage)],['Verified tasks',n(S.verified_tasks)],['Verified cost/task',money(S.verified_cost)],['Waste rate',pc(S.waste_rate)],['Orchestration overhead',pc(S.orchestration_overhead)],['30d delayed failure',pc(S.stable_30d_failure_rate)],['p99/p50 tail ratio',Number(S.tail_ratio||0).toFixed(1)+'×'],['Adaptive decisions',n(S.adaptive_decisions)]];$('#cards').innerHTML=cards.map(x=>`<div class="card"><div class="k">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');
const ah=[['History sufficient',pc(S.history_sufficient_rate)],['Observed exploration',pc(S.exploration_rate_observed)],['Recommend only',n((S.adaptive_actions||{}).recommended_only)],['Empirical enforced',n((S.adaptive_actions||{}).empirical_enforced)],['Static/fallback',n(n0((S.adaptive_actions||{}).static_default)+n0((S.adaptive_actions||{}).fallback_insufficient_history))]];function n0(x){return Number(x||0)}$('#adaptiveHealth').innerHTML=ah.map(x=>`<div class="risk"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
const risks=[['Fan-out rework multiplier',Number(S.fanout_rework||0).toFixed(2)],['Context packet miss rate',pc(S.context_miss_rate)],['Merge/conflict events',n(S.conflicts)],['Shadow false-pass rate',pc(S.shadow_false_pass_rate)],['Shadow over-rejection',pc(S.shadow_over_reject_rate)],['Review wait p90',Number(S.review_wait_p90_s||0).toFixed(1)+'s'],['p99 call cost',money(S.p99_cost)]];$('#risk').innerHTML=risks.map(x=>`<div class="risk"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
$('#features').innerHTML='<thead><tr><th>Feature</th><th>State</th><th>Configuration</th></tr></thead><tbody>'+D.features.map(f=>`<tr><td>${esc(f.feature)}</td><td><span class="pill ${f.state==='off'?'off':(f.state==='recommend'||f.state==='observe'?'warn':'on')}">${esc(f.state)}</span></td><td><code>${esc(JSON.stringify(f.config))}</code></td></tr>`).join('')+'</tbody>';
$('#adaptive').innerHTML='<thead><tr><th>Time</th><th>Task</th><th>Risk</th><th>Mode</th><th>Action</th><th>Selected</th><th>Effort</th><th>Verify</th><th>N</th><th>Explore</th><th>Canary</th></tr></thead><tbody>'+D.adaptive.slice().reverse().map(r=>`<tr><td>${esc(r.ts||'')}</td><td>${esc(r.task_class||'')}</td><td>${esc(r.risk||'')}</td><td>${esc(r.adaptive_mode||'')}</td><td>${esc(r.route_action||'')}</td><td>${esc(r.selected_capability||'')}</td><td>${esc(r.selected_effort||'')}</td><td>${esc(r.selected_verification_depth||'')}</td><td>${n(r.historical_samples)}</td><td>${r.explored?'yes':'no'}</td><td>${r.canary?'yes':'no'}</td></tr>`).join('')+'</tbody>';
$('#policies').innerHTML='<thead><tr><th>Policy</th><th>Cost aggr.</th><th>Cost</th><th>Verified</th><th>Verified cost</th><th>Quality evidence</th></tr></thead><tbody>'+D.policies.map(p=>`<tr><td><code>${esc(p.policy_id)}</code></td><td>${pc(p.cost_aggressiveness)}</td><td>${money(p.cost)}</td><td>${p.verified}</td><td>${money(p.verified_cost)}</td><td>${pc(p.quality)}</td></tr>`).join('')+'</tbody>';
$('#trends').innerHTML='<thead><tr><th>Day</th><th>Cost aggr.</th><th>Spend</th><th>Verified</th><th>Verified cost</th><th>Quality</th><th>Retries</th><th>Adaptive</th></tr></thead><tbody>'+D.trends.map(t=>`<tr><td>${t.day}</td><td>${pc(t.cost_aggressiveness)}</td><td>${money(t.cost)}</td><td>${t.verified}</td><td>${money(t.verified_cost)}</td><td>${pc(t.quality)}</td><td>${t.retries}</td><td>${t.adaptive}</td></tr>`).join('')+'</tbody>';
$('#routes').innerHTML='<thead><tr><th>Task</th><th>Complexity</th><th>Risk</th><th>Capability</th><th>Effort</th><th>Verify</th><th>Topology</th><th>N</th><th>Verified cost</th><th>Quality</th><th>Retry</th><th>Delayed fail</th></tr></thead><tbody>'+D.routes.map(r=>`<tr><td>${esc(r.task_class)}</td><td>${esc(r.complexity_bucket)}</td><td>${esc(r.risk)}</td><td>${esc(r.capability)}</td><td>${esc(r.effort)}</td><td>${esc(r.verification_depth)}</td><td>${esc(r.topology_shape||'—')}</td><td>${r.samples}</td><td>${money(r.verified_cost_usd)}</td><td>${pc(r.avg_quality_evidence)}</td><td>${pc(r.retry_rate)}</td><td>${pc(r.delayed_failure_rate)}</td></tr>`).join('')+'</tbody>';
const R=Object.entries(D.by_role).sort((a,b)=>b[1].cost-a[1].cost),maxR=Math.max(.000001,...R.map(x=>x[1].cost));$('#roles').innerHTML=R.map(([k,v])=>`<div style="display:grid;grid-template-columns:190px 1fr 90px;gap:10px;align-items:center;margin:9px 0"><div><b>${esc(k)}</b><div class="small">${n(v.calls)} calls · ${n(v.tokens)} tokens</div></div><div class="bar"><i style="width:${(v.cost/maxR*100).toFixed(1)}%"></i></div><div style="text-align:right">${money(v.cost)}</div></div>`).join('');
const A=Object.entries(D.by_runtime).sort((a,b)=>b[1].cost-a[1].cost),maxA=Math.max(.000001,...A.map(x=>x[1].cost));$('#runtimes').innerHTML=A.map(([k,v])=>{const unmetered=Number(v.unmetered_calls||0),metered=Number(v.metered_calls||0);const label=metered?money(v.cost):(unmetered?'<span class="warn">unmetered</span>':money(0));const detail=[n(v.calls)+' calls',metered?n(metered)+' metered':null,unmetered?n(unmetered)+' unmetered':null,Number(v.estimated_cost||0)>0?'est. '+money(v.estimated_cost):null,Number(v.reported_cost||0)>0?'reported '+money(v.reported_cost):null].filter(Boolean).join(' · ');return `<div style="display:grid;grid-template-columns:190px 1fr 130px;gap:10px;align-items:center;margin:9px 0"><div><b>${esc(k)}</b><div class="small">${detail}</div></div><div class="bar"><i style="width:${(v.cost/maxA*100).toFixed(1)}%"></i></div><div style="text-align:right">${label}</div></div>`}).join('');
$('#events').innerHTML=D.events.slice().reverse().map(e=>`<div class="event"><span class="small">${esc(e.ts||'')}</span> <b>${esc(e.event||'')}</b><div class="small"><code>${esc(JSON.stringify(e).slice(0,600))}</code></div></div>`).join('');
const IS=D.interactive_sessions||{calls:0,cost:0,tokens:0,by_runtime:{},sessions:null};const isRt=Object.entries(IS.by_runtime||{}).sort((a,b)=>b[1].cost-a[1].cost);$('#interactive').innerHTML=`<div class="small">These rows come from interactive-session ingestion, not orchestrated runs, and are excluded from the role/runtime charts above.</div><div class="risk"><span>Calls</span><b>${n(IS.calls)}</b></div><div class="risk"><span>Cost</span><b class="warn">${money(IS.cost)}</b></div><div class="risk"><span>Tokens</span><b>${n(IS.tokens)}</b></div>`+(IS.sessions!=null?`<div class="risk"><span>Distinct sessions</span><b>${n(IS.sessions)}</b></div>`:'')+(isRt.length?isRt.map(([k,v])=>`<div style="display:grid;grid-template-columns:190px 1fr 90px;gap:10px;align-items:center;margin:9px 0"><div><b>${esc(k)}</b><div class="small">${n(v.calls)} calls</div></div><div class="bar"><i style="width:${(v.cost/Math.max(.000001,IS.cost)*100).toFixed(1)}%"></i></div><div style="text-align:right">${money(v.cost)}</div></div>`).join(''):'<div class="small">No runtime breakdown available.</div>');</script></main></body></html>'''
    out=root/'dashboard.html'; out.write_text(doc,encoding='utf-8'); return out

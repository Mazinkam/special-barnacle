from __future__ import annotations
import argparse,json,os,sys
import re as _re_path
from pathlib import Path
from typing import Any, Callable
from .runtime import EventStore,QualityEvidence,default_state_root,read_json,utc_now,write_json
from .state import rebuild,refresh_ledger,load_or_rebuild
from .dashboard import generate_dashboard
from .record_batch import write_batch,single_record,BatchValidationError,BatchAppendError,STREAMS,RETRY_SAME_IDS
from .history import load_stats
from .scheduler import recommend_package,topology_for
from .context import ContextRegistry
from .features import FeaturePolicy, feature_inventory
from .engine import OrchestrationEngine
from .ingest import discover_logs, ingest_paths
from .dynamic_adapter import resolve_adapter

_PATH_RE = _re_path.compile(r"(/Users/[^ \t\n|]+|/home/[^ \t\n|]+|~/[^ \t\n|]+)")
def _redact_paths(text):
    return _PATH_RE.sub("<path>", text)

ROOT=default_state_root()
def cfg(): return read_json(Path(__file__).with_name('config.json'),{})
def refresh(state_root: Path = ROOT) -> Path:
    """Incrementally catch up the durable ledger and atomically republish the dashboard."""
    root = Path(state_root)
    refresh_ledger(root)
    return generate_dashboard(root, config=cfg())


def make_ingest_status(previous: dict[str, Any], result: dict[str, Any], *,
                       materialization_error: Exception | None = None) -> dict[str, Any]:
    failures = result.get('failures') or []
    status = 'error' if materialization_error is not None else ('partial' if failures else 'ok')
    error = _redact_paths(str(materialization_error))[:240] if materialization_error is not None else None
    if error is None and failures:
        first_detail = str(failures[0].get('error') or 'ingest failed')
        error = _redact_paths(f"{len(failures)} file(s) failed; first: {first_detail}")[:240]

    interval = os.environ.get('HUMAIN_ORCHESTRATOR_INGEST_INTERVAL')
    try:
        sweep_interval_seconds = int(interval) if interval is not None else None
        if sweep_interval_seconds is not None and sweep_interval_seconds < 0:
            sweep_interval_seconds = None
    except (TypeError, ValueError):
        sweep_interval_seconds = None
    if sweep_interval_seconds is None:
        previous_interval = previous.get('sweep_interval_seconds')
        if isinstance(previous_interval, int) and not isinstance(previous_interval, bool) and previous_interval >= 0:
            sweep_interval_seconds = previous_interval
        else:
            sweep_interval_seconds = 900

    now = utc_now()
    return {
        'version': 1,
        'last_attempt_at': now,
        'last_success_at': now if status == 'ok' else previous.get('last_success_at'),
        'status': status,
        'files_scanned': int(result.get('files_scanned', 0)),
        'emitted': int(result.get('emitted', 0)),
        'failure_count': len(failures) + (1 if materialization_error is not None else 0),
        'error': error,
        'sweep_interval_seconds': sweep_interval_seconds,
    }


def process_ingest(paths: list[Path], *, state_root: Path, runtime: str | None,
                   repository: str | None, dry_run: bool, granularity: str,
                   on_file: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    paths = list(paths)
    root = Path(state_root)
    result = ingest_paths(paths, runtime=runtime, repository=repository, state_root=root,
                          dry_run=dry_run, granularity=granularity, on_file=on_file,
                          summarize_files=len(paths) <= 25)
    result['files_scanned'] = len(paths)
    if not dry_run:
        previous = read_json(root / 'ingest_status.json', {})
        if not isinstance(previous, dict):
            previous = {}
        status = make_ingest_status(previous, result)
        write_json(root / 'ingest_status.json', status)
        try:
            refresh(root)
        except Exception as error:
            write_json(root / 'ingest_status.json',
                       make_ingest_status(previous, result, materialization_error=error))
            raise
    return result

# Exit codes for the durable-write commands (`batch`, `event`, `metric`, `outcome`). The JSON body on
# stdout always carries `persisted`/`duplicates`/`retry`; `retry == 'same_ids'` (exit 2 or 3) means the
# durable records are fine and resubmitting the same ids finishes the work without appending twice.
EXIT_OK=0; EXIT_INVALID=1; EXIT_APPEND_FAILED=2; EXIT_REFRESH_FAILED=3

def _parse_json(text:str,what:str):
    try: return json.loads(text)
    except json.JSONDecodeError as exc: raise BatchValidationError(f'{what} is not valid JSON: {exc}')

def _batch_payload(raw:str|None):
    return _parse_json(raw if raw not in (None,'-') else sys.stdin.read(),'batch payload')

def _failure(status:str,error:str,persisted:dict|None=None,retry:str|None=None)->dict:
    empty={s:0 for s in STREAMS}
    return {'ok':False,'status':status,'error':error,'persisted':persisted or empty,'duplicates':empty,'ledger_updated':False,'dashboard_updated':False,'retry':retry}

def _write(records)->tuple[int,dict]:
    """Run the coordinated writer; return (exit code, JSON body) without printing.

    Every CLI path that appends (`batch`, `event`, `metric`, `outcome`, `init`) reports the writer's
    outcome through this one function, so a rejected batch or an interrupted append is always a
    structured body with `persisted`/`retry` and never an uncaught traceback.
    """
    try: result=write_batch(ROOT,records,config=cfg())
    except BatchValidationError as exc: return EXIT_INVALID,_failure('invalid',str(exc))
    except BatchAppendError as exc: return EXIT_APPEND_FAILED,_failure('append_failed',str(exc),exc.persisted,RETRY_SAME_IDS)
    return (EXIT_OK if result['ok'] else EXIT_REFRESH_FAILED),{k:v for k,v in result.items() if k!='records'}

def write_records(records)->int:
    """Run the coordinated writer for the CLI and print its JSON result; return the exit code."""
    code,body=_write(records); print(json.dumps(body)); return code

def _single(stream:str,payload_text:str,event:str|None=None)->int:
    """One-record form of `write_records`: the command names the stream (and event); the payload cannot override them."""
    try: record=single_record(stream,_parse_json(payload_text,'payload'),event=event)
    except BatchValidationError as exc: print(json.dumps(_failure('invalid',str(exc)))); return EXIT_INVALID
    return write_records([record])

def main():
    ap=argparse.ArgumentParser(prog='orchestrator'); sp=ap.add_subparsers(dest='cmd',required=True)
    sp.add_parser('init'); sp.add_parser('status'); sp.add_parser('dashboard'); sp.add_parser('rebuild'); sp.add_parser('features'); sp.add_parser('recommend-policy')
    e=sp.add_parser('event'); e.add_argument('event'); e.add_argument('payload',nargs='?',default='{}')
    m=sp.add_parser('metric'); m.add_argument('payload')
    o=sp.add_parser('outcome'); o.add_argument('payload')
    b=sp.add_parser('batch',help='append an ordered batch of event/metric/outcome records (JSON array on stdin or as argument) and refresh once')
    b.add_argument('payload',nargs='?',default=None,help="JSON array of {stream, record_id, ...} records, or '-'/omitted to read stdin")
    r=sp.add_parser('route'); r.add_argument('task_class'); r.add_argument('complexity',type=float); r.add_argument('risk'); r.add_argument('--run-id',default='cli-route'); r.add_argument('--quality-floor',type=float); r.add_argument('--cost-aggressiveness',type=float)
    p=sp.add_parser('plan'); p.add_argument('run_id'); p.add_argument('task_class'); p.add_argument('complexity',type=float); p.add_argument('risk'); p.add_argument('--coupling',type=float,default=.5); p.add_argument('--parallelizable',type=float,default=.5); p.add_argument('--repo-revision')
    sim=sp.add_parser('simulate-policy'); sim.add_argument('--quality-floor',type=float,required=True); sim.add_argument('--cost-aggressiveness',type=float,required=True)
    t=sp.add_parser('topology'); t.add_argument('complexity',type=float); t.add_argument('--coupling',type=float,default=.5); t.add_argument('--parallelizable',type=float,default=.5); t.add_argument('--risk',default='medium')
    ing=sp.add_parser('ingest'); ing.add_argument('paths',nargs='*'); ing.add_argument('--runtime'); ing.add_argument('--repository'); ing.add_argument('--dry-run',action='store_true')
    ra=sp.add_parser('resolve-adapter'); ra.add_argument('--json',action='store_true',help='emit JSON'); ra.add_argument('--explain',action='store_true',help='include selection reasoning'); ra.add_argument('--model-family',default=None,help="override model-family preference (default: anthropic via CODING_AGENT_ORCHESTRATOR_MODEL_FAMILY; pass 'none'/'cost' to disable)")
    ing.add_argument('--granularity',choices=['call','session'],default='call'); ing.add_argument('--discover',action='store_true'); ing.add_argument('--since-days',type=float); ing.add_argument('--limit',type=int); ing.add_argument('--quiet',action='store_true'); ing.add_argument('--include-scratch',action='store_true')
    q=sp.add_parser('quality'); q.add_argument('payload')
    c=sp.add_parser('context-put'); c.add_argument('id'); c.add_argument('content'); c.add_argument('--source',required=True); c.add_argument('--status',default='observed'); c.add_argument('--revision')
    cp=sp.add_parser('context-packet'); cp.add_argument('ids'); cp.add_argument('--budget',type=int,default=18000)
    args=ap.parse_args(); store=EventStore(ROOT); C=cfg(); eng=OrchestrationEngine(ROOT)
    if args.cmd=='init':
        # One coordinated write: durable append -> incremental ledger -> atomic dashboard, instead of
        # an append followed by a full history replay that also discards the record-id cache. A
        # rejected or interrupted write is reported exactly like `batch` (JSON body, exit 1/2/3,
        # `retry == 'same_ids'`), so callers can resubmit `init` safely instead of parsing a traceback.
        code, body = _write([single_record('event', {'schema_version': 3}, event='orchestrator_initialized')])
        if code != EXIT_OK:
            print(json.dumps(body))
            raise SystemExit(code)
        print('Initialized V3 state')
        return
    if args.cmd=='status': print(json.dumps(load_or_rebuild(ROOT),indent=2)); return
    if args.cmd=='dashboard': print(generate_dashboard(ROOT,config=C)); return
    if args.cmd=='rebuild': print(json.dumps(rebuild(ROOT),indent=2)); generate_dashboard(ROOT,config=C); return
    if args.cmd=='features':
        f=FeaturePolicy(C.get('features',{})).resolve(); print(json.dumps(feature_inventory(f),indent=2)); return
    if args.cmd=='recommend-policy': print(json.dumps(eng.recommend_policy(),indent=2)); return
    if args.cmd=='event': raise SystemExit(_single('event',args.payload,event=args.event))
    if args.cmd=='metric': raise SystemExit(_single('metric',args.payload))
    if args.cmd=='outcome': raise SystemExit(_single('outcome',args.payload))
    if args.cmd=='batch':
        try: records=_batch_payload(args.payload)
        except BatchValidationError as exc: print(json.dumps(_failure('invalid',str(exc)))); raise SystemExit(EXIT_INVALID)
        raise SystemExit(write_records(records))
    if args.cmd=='route':
        overrides={}
        if args.quality_floor is not None: overrides['quality_floor']=args.quality_floor
        if args.cost_aggressiveness is not None: overrides['cost_aggressiveness']=args.cost_aggressiveness
        plan=eng.plan_run(run_id=args.run_id,task_class=args.task_class,complexity=args.complexity,risk=args.risk,user_overrides=overrides)
        print(json.dumps(plan['route'],indent=2)); return
    if args.cmd=='plan':
        print(json.dumps(eng.plan_run(run_id=args.run_id,task_class=args.task_class,complexity=args.complexity,risk=args.risk,coupling=args.coupling,parallelizable=args.parallelizable,repo_revision=args.repo_revision),indent=2)); return
    if args.cmd=='simulate-policy':
        print(json.dumps(eng.simulate_policy(candidate_quality_floor=args.quality_floor,candidate_cost_aggressiveness=args.cost_aggressiveness),indent=2)); return
    if args.cmd=='topology': print(json.dumps(topology_for(args.complexity,args.coupling,args.parallelizable,args.risk),indent=2)); return
    if args.cmd=='resolve-adapter':
        a = resolve_adapter(model_family=args.model_family)
        # --json and --explain are aliases: both emit machine-readable JSON.
        # The table form is the default when neither is set for human reading.
        if args.json or args.explain:
            import json as _json
            print(_json.dumps(a, indent=2))
        else:
            # Default: print a compact capability -> provider/model table.
            print(f'{"capability":<24} {"tier":<12} {"provider":<20} {"model":<35} {"in$/M":>8} {"out$/M":>8}')
            print('-' * 110)
            for cap, info in sorted(a.items()):
                if cap.startswith('_'): continue
                print(f'{cap:<24} {info["tier"]:<12} {info.get("provider","-"):<20} '
                      f'{info["model"]:<35} {(info.get("input_cost_per_m") or 0):>8.2f} '
                      f'{(info.get("output_cost_per_m") or 0):>8.2f}')
        return
    if args.cmd=='ingest':
        if args.discover or args.since_days is not None:
            paths=discover_logs(since_days=args.since_days,runtimes=[args.runtime] if args.runtime else None,include_scratch=args.include_scratch)
        else:
            paths=args.paths or [p for p in [os.environ.get('HUMAIN_TERMINAL_SESSION_FILE')] if p]
        if args.paths and (args.discover or args.since_days is not None): paths=[*args.paths,*paths]
        if args.limit: paths=paths[:args.limit]
        if not paths: raise SystemExit('No session logs found. Pass paths, use --discover, or set HUMAIN_TERMINAL_SESSION_FILE')
        done=[0]
        def progress(summary):
            done[0]+=1
            runtime_label=str(summary.get('runtime') or '?')
            print(f"[{done[0]}/{len(paths)}] {runtime_label:16} +{summary.get('emitted',0):<5} dup={summary.get('duplicates',0):<4} ${summary.get('estimated_cost_usd',0.0):.4f}  {Path(summary['file']).name}",file=sys.stderr,flush=True)
        result=process_ingest(paths, state_root=ROOT, runtime=args.runtime,
                              repository=args.repository, dry_run=args.dry_run,
                              granularity=args.granularity,
                              on_file=progress if not args.quiet else None)
        print(json.dumps(result,indent=2))
        if result.get('failures') and not args.dry_run:
            first_detail = ' '.join(str(result['failures'][0].get('error') or 'ingest failed').split())
            print(_redact_paths(f"{len(result['failures'])} file(s) failed; first: {first_detail}")[:240], file=sys.stderr, flush=True)
            raise SystemExit(1)
        return
    if args.cmd=='quality':
        ev=QualityEvidence(**json.loads(args.payload)); print(json.dumps({'hard_gate_pass':ev.hard_gate_pass(),'quality_evidence_score':ev.evidence_score()},indent=2)); return
    if args.cmd=='context-put': print(json.dumps(ContextRegistry(ROOT).put(args.id,args.content,source=args.source,status=args.status,repo_revision=args.revision),indent=2)); return
    if args.cmd=='context-packet': print(json.dumps(ContextRegistry(ROOT).packet([x.strip() for x in args.ids.split(',') if x.strip()],args.budget),indent=2)); return
if __name__=='__main__': main()

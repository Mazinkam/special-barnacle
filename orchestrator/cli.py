from __future__ import annotations
import argparse,json,os,sys
from pathlib import Path
from typing import Any, Callable
from .runtime import EventStore,QualityEvidence,default_state_root,read_json,utc_now,write_json
from .state import rebuild,refresh_ledger,load_or_rebuild
from .dashboard import generate_dashboard
from .record_batch import write_batch,single_record,BatchValidationError,BatchAppendError,STREAMS,RETRY_SAME_IDS
from .app.refresh import refresh_after_write
from .history import load_stats
from .scheduler import recommend_package,topology_for
from .context import ContextRegistry
from .features import FeaturePolicy, feature_inventory
from .app.engine import build_engine
from .ingest import discover_logs, ingest_paths
from .dynamic_adapter import resolve_adapter
from .archive import archive_runs, restore_run, DEFAULT_OLDER_THAN_DAYS, RESTORE_COMMAND
from .contract import (
    EXIT_APPEND_FAILED as CONTRACT_EXIT_APPEND_FAILED,
    EXIT_INVALID as CONTRACT_EXIT_INVALID,
    EXIT_OK as CONTRACT_EXIT_OK,
    EXIT_REFRESH_FAILED as CONTRACT_EXIT_REFRESH_FAILED,
    INGEST_STATUS_FILE,
    PATH_REDACTION_RE,
    STATUS_APPEND_FAILED,
    STATUS_INVALID,
)

_PATH_RE = PATH_REDACTION_RE
def _redact_paths(text):
    return _PATH_RE.sub("<path>", text)

#: Bound for the one-line ingest error kept in `ingest_status.json` and echoed on stderr.
INGEST_ERROR_LIMIT = 240
#: Characters of the tail kept when a detail must be shortened. Ingest conflict messages end with the
#: remedy sentence ("... Switching to --granularity session cannot establish identity ..."), so the
#: tail carries the actionable part; the head carries what failed.
_INGEST_ERROR_TAIL = 120

def _bound_error(text: str, limit: int = INGEST_ERROR_LIMIT, tail: int = _INGEST_ERROR_TAIL) -> str:
    """Return `text` if it fits in `limit`, else its head and tail joined by ` ... ` at exactly `limit`.

    A plain `text[:limit]` dropped the closing guidance of a long conflict message, leaving the hook
    and launchd logs with the failure but not the fix. Callers redact paths *before* bounding so a
    cut can never expose a partial path and the bound applies to what is actually printed.
    """
    if len(text) <= limit:
        return text
    joiner = ' ... '
    tail = min(tail, (limit - len(joiner)) // 2)
    return text[:limit - tail - len(joiner)] + joiner + text[-tail:]

ROOT=default_state_root()
def cfg(): return read_json(Path(__file__).with_name('config.json'),{})
def refresh(state_root: Path = ROOT) -> Path:
    """Catch the ledger up from its durable checkpoint and republish the dashboard; return its path.

    Not a recovery: records reach the streams through the coordinated writer (deduplicated by
    record id), so an incremental replay is exact and the record-id cache stays trusted. A full
    `rebuild` (replay from byte 0, cache discarded) remains the explicit `rebuild` command.
    """
    root = Path(state_root)
    refresh_ledger(root)
    return generate_dashboard(root, config=cfg())


def make_ingest_status(previous: dict[str, Any], result: dict[str, Any], *,
                       materialization_error: Exception | None = None) -> dict[str, Any]:
    failures = result.get('failures') or []
    status = 'error' if materialization_error is not None else ('partial' if failures else 'ok')
    error = _bound_error(_redact_paths(str(materialization_error))) if materialization_error is not None else None
    if error is None and failures:
        first_detail = str(failures[0].get('error') or 'ingest failed')
        error = _bound_error(_redact_paths(f"{len(failures)} file(s) failed; first: {first_detail}"))

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
        previous = read_json(root / INGEST_STATUS_FILE, {})
        if not isinstance(previous, dict):
            previous = {}
        status = make_ingest_status(previous, result)
        write_json(root / INGEST_STATUS_FILE, status)
        try:
            refresh(root)
        except Exception as error:
            write_json(root / INGEST_STATUS_FILE,
                       make_ingest_status(previous, result, materialization_error=error))
            raise
    return result

# Exit codes for the durable-write commands (`batch`, `event`, `metric`, `outcome`). The JSON body on
# stdout always carries `persisted`/`duplicates`/`retry`; `retry == 'same_ids'` (exit 2 or 3) means the
# durable records are fine and resubmitting the same ids finishes the work without appending twice.
EXIT_OK=CONTRACT_EXIT_OK; EXIT_INVALID=CONTRACT_EXIT_INVALID; EXIT_APPEND_FAILED=CONTRACT_EXIT_APPEND_FAILED; EXIT_REFRESH_FAILED=CONTRACT_EXIT_REFRESH_FAILED

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
    try: result=write_batch(ROOT,records)
    except BatchValidationError as exc: return EXIT_INVALID,_failure(STATUS_INVALID,str(exc))
    except BatchAppendError as exc: return EXIT_APPEND_FAILED,_failure(STATUS_APPEND_FAILED,str(exc),exc.persisted,RETRY_SAME_IDS)
    result=refresh_after_write(ROOT,result,config=cfg())
    return (EXIT_OK if result['ok'] else EXIT_REFRESH_FAILED),{k:v for k,v in result.items() if k!='records'}

def write_records(records)->int:
    """Run the coordinated writer for the CLI and print its JSON result; return the exit code."""
    code,body=_write(records); print(json.dumps(body)); return code

def _single(stream:str,payload_text:str,event:str|None=None)->int:
    """One-record form of `write_records`: the command names the stream (and event); the payload cannot override them."""
    try: record=single_record(stream,_parse_json(payload_text,'payload'),event=event)
    except BatchValidationError as exc: print(json.dumps(_failure(STATUS_INVALID,str(exc)))); return EXIT_INVALID
    return write_records([record])

def _add_policy_override_flags(subparser):
    """Add the shared --quality-floor/--cost-aggressiveness override flags.

    Both `route` and `plan` resolve their effective policy from the same config-derived
    defaults, with these two flags as optional per-invocation overrides (see how `route`
    and `plan` build `overrides`/`user_overrides` in `main()`). Defining them once keeps
    the type, default (None = no override) and absence of extra validation identical on
    both subparsers, so a flag accepted by one is always accepted by the other.
    """
    subparser.add_argument('--quality-floor',type=float,default=None)
    subparser.add_argument('--cost-aggressiveness',type=float,default=None)

def build_parser():
    """Construct the argparse parser without executing any command.

    Kept separate from `main()` so tests can call `parse_args` directly against the real
    parser (catching argument mismatches with the TS bridge) without running a command.
    """
    ap=argparse.ArgumentParser(prog='orchestrator'); sp=ap.add_subparsers(dest='cmd',required=True)
    sp.add_parser('init'); sp.add_parser('status'); sp.add_parser('dashboard'); sp.add_parser('rebuild'); sp.add_parser('features'); sp.add_parser('recommend-policy')
    e=sp.add_parser('event'); e.add_argument('event'); e.add_argument('payload',nargs='?',default='{}')
    m=sp.add_parser('metric'); m.add_argument('payload')
    o=sp.add_parser('outcome'); o.add_argument('payload')
    b=sp.add_parser('batch',help='append an ordered batch of event/metric/outcome records (JSON array on stdin or as argument) and refresh once')
    b.add_argument('payload',nargs='?',default=None,help="JSON array of {stream, record_id, ...} records, or '-'/omitted to read stdin")
    r=sp.add_parser('route'); r.add_argument('task_class'); r.add_argument('complexity',type=float); r.add_argument('risk'); r.add_argument('--run-id',default='cli-route'); _add_policy_override_flags(r)
    p=sp.add_parser('plan'); p.add_argument('run_id'); p.add_argument('task_class'); p.add_argument('complexity',type=float); p.add_argument('risk'); p.add_argument('--coupling',type=float,default=.5); p.add_argument('--parallelizable',type=float,default=.5); p.add_argument('--repo-revision'); _add_policy_override_flags(p)
    sim=sp.add_parser('simulate-policy'); sim.add_argument('--quality-floor',type=float,required=True); sim.add_argument('--cost-aggressiveness',type=float,required=True)
    t=sp.add_parser('topology'); t.add_argument('complexity',type=float); t.add_argument('--coupling',type=float,default=.5); t.add_argument('--parallelizable',type=float,default=.5); t.add_argument('--risk',default='medium')
    ing=sp.add_parser('ingest'); ing.add_argument('paths',nargs='*'); ing.add_argument('--runtime'); ing.add_argument('--repository'); ing.add_argument('--dry-run',action='store_true')
    ra=sp.add_parser('resolve-adapter'); ra.add_argument('--json',action='store_true',help='emit JSON'); ra.add_argument('--explain',action='store_true',help='include selection reasoning'); ra.add_argument('--model-family',default=None,help="override model-family preference (default: anthropic via CODING_AGENT_ORCHESTRATOR_MODEL_FAMILY; pass 'none'/'cost' to disable)")
    ing.add_argument('--granularity',choices=['call','session'],default='call'); ing.add_argument('--discover',action='store_true'); ing.add_argument('--since-days',type=float); ing.add_argument('--limit',type=int); ing.add_argument('--quiet',action='store_true'); ing.add_argument('--include-scratch',action='store_true')
    q=sp.add_parser('quality'); q.add_argument('payload')
    c=sp.add_parser('context-put'); c.add_argument('id'); c.add_argument('content'); c.add_argument('--source',required=True); c.add_argument('--status',default='observed'); c.add_argument('--revision')
    cp=sp.add_parser('context-packet'); cp.add_argument('ids'); cp.add_argument('--budget',type=int,default=18000)
    ar=sp.add_parser('archive-runs',formatter_class=argparse.RawDescriptionHelpFormatter,
        help='list (dry run) or, with --execute, losslessly gzip the diagnostics of completed runs older than N days',
        description=(
            'Archive completed run diagnostics under <state root>/runs/<run_id>/ reversibly.\n\n'
            'Default is a dry run: prints, per run, whether it is eligible or why it is skipped, each file, its exact\n'
            '<name>.gz destination, raw bytes and the estimated compressed bytes. Nothing is written, not even a lock file.\n'
            'With --execute each eligible file is gzip-compressed into a same-directory temporary file, decompressed again\n'
            'and checked against its SHA-256; digests are committed incrementally to archive.manifest.json.\n'
            'Only new HT runs with a durable writer seal can replace raw files, after all producers and descriptors drain.\n'
            'Legacy uncoordinated runs are snapshot-only (zero reclaimed bytes); managed unsealed runs are skipped.\n'
            'Retries validate/adopt matching orphan gzip files without overwrite. Prior manifest generations and unknown\n'
            'archives/temporary files are preserved for recovery. Storage reports include manifest overhead.\n\n'
            'Never archived: active runs and runs without a durable run-complete/run-failed outcome in outcomes.jsonl,\n'
            'runs completed or modified inside the window, run.log (the progress-board timeline stays readable), and the\n'
            'authoritative streams events.jsonl / metrics.jsonl / outcomes.jsonl with their ledger/checkpoint/index metadata.\n'
            'Nothing is deleted by default and no retention timer exists; confirmed sealed raw files are replaced by\n'
            'verified gzip, not lost audit evidence. Read with `gunzip -c <file>.gz`, or restore with `restore-run <run_id>`.\n'
            'Exit status 1 if any planned file could not be archived.'))
    ar.add_argument('--older-than-days',type=float,default=DEFAULT_OLDER_THAN_DAYS,metavar='N',help=f'only runs whose terminal outcome and files are older than N days (default {DEFAULT_OLDER_THAN_DAYS})')
    ar.add_argument('--execute',action='store_true',help='actually archive; without it this is a dry run that writes nothing')
    ar.add_argument('--json',action='store_true',help='machine-readable output instead of the table')
    rr=sp.add_parser('restore-run',formatter_class=argparse.RawDescriptionHelpFormatter,
        help='restore the archived diagnostics of one run byte-for-byte from its .gz files and manifest',
        description=(
            'Restore every archived file of <state root>/runs/<run_id>/ exactly as it was: each .gz is decompressed into a\n'
            'same-directory temporary file, its SHA-256 and byte count are checked against archive.manifest.json, the\n'
            'original mtime is restored and the file is atomically installed only if its name is still absent. The .gz and\n'
            'manifest are retained for recovery. An invalid manifest or symlink is rejected before mutation. A file that\n'
            'fails verification is reported; existing content is never overwritten, even if a writer creates the file\n'
            'during restore. --dry-run only lists the archived files and their .gz paths.'))
    rr.add_argument('run_id',help='run directory name under <state root>/runs (as shown in the progress board log path)')
    rr.add_argument('--dry-run',action='store_true',help='list what would be restored without writing')
    rr.add_argument('--json',action='store_true',help='machine-readable output')
    return ap

def _format_adapter_table(a: dict) -> str:
    """Render the `resolve-adapter` capability table; a `None` field (e.g. a model with no known
    provider) renders as `-` instead of breaking the `:<N` format spec.
    """
    lines=[f'{"capability":<24} {"tier":<12} {"provider":<20} {"model":<35} {"in$/M":>8} {"out$/M":>8}', '-'*110]
    for cap, info in sorted(a.items()):
        if cap.startswith('_'): continue
        tier=info.get('tier') or '-'; provider=info.get('provider') or '-'; model=info.get('model') or '-'
        lines.append(f'{cap:<24} {tier:<12} {provider:<20} '
                      f'{model:<35} {(info.get("input_cost_per_m") or 0):>8.2f} '
                      f'{(info.get("output_cost_per_m") or 0):>8.2f}')
    return '\n'.join(lines)

def main():
    ap=build_parser()
    args=ap.parse_args(); C=cfg()
    # A dry run must leave the state root untouched (not even created), so the root and its streams are
    # only ensured for commands that write or read them; the engine is built where a command needs it.
    # The archive commands never touch the streams at all, so they do not create them either.
    if not (args.cmd=='ingest' and args.dry_run) and args.cmd not in ('archive-runs','restore-run'): EventStore(ROOT)
    def eng(): return build_engine(ROOT)
    if args.cmd=='init':
        # One coordinated write: durable append -> incremental ledger -> atomic dashboard, instead of
        # an append followed by a full history replay that also discards the record-id cache. A
        # rejected or interrupted write is reported exactly like `batch` (JSON body, exit 1/2/3,
        # `retry == 'same_ids'`), so callers can resubmit `init` safely instead of parsing a traceback.
        code,body=_write([single_record('event',{'schema_version':3},event='orchestrator_initialized')])
        if code!=EXIT_OK: print(json.dumps(body)); raise SystemExit(code)
        print('Initialized V3 state'); return
    if args.cmd=='status': print(json.dumps(load_or_rebuild(ROOT),indent=2)); return
    if args.cmd=='dashboard': print(generate_dashboard(ROOT,config=C)); return
    if args.cmd=='rebuild': print(json.dumps(rebuild(ROOT),indent=2)); generate_dashboard(ROOT,config=C); return
    if args.cmd=='features':
        f=FeaturePolicy(C.get('features',{})).resolve(); print(json.dumps(feature_inventory(f),indent=2)); return
    if args.cmd=='recommend-policy': print(json.dumps(eng().recommend_policy(),indent=2)); return
    if args.cmd=='event': raise SystemExit(_single('event',args.payload,event=args.event))
    if args.cmd=='metric': raise SystemExit(_single('metric',args.payload))
    if args.cmd=='outcome': raise SystemExit(_single('outcome',args.payload))
    if args.cmd=='batch':
        try: records=_batch_payload(args.payload)
        except BatchValidationError as exc: print(json.dumps(_failure(STATUS_INVALID,str(exc)))); raise SystemExit(EXIT_INVALID)
        raise SystemExit(write_records(records))
    if args.cmd=='route':
        overrides={}
        if args.quality_floor is not None: overrides['quality_floor']=args.quality_floor
        if args.cost_aggressiveness is not None: overrides['cost_aggressiveness']=args.cost_aggressiveness
        plan=eng().plan_run(run_id=args.run_id,task_class=args.task_class,complexity=args.complexity,risk=args.risk,user_overrides=overrides)
        print(json.dumps(plan['route'],indent=2)); return
    if args.cmd=='plan':
        overrides={}
        if args.quality_floor is not None: overrides['quality_floor']=args.quality_floor
        if args.cost_aggressiveness is not None: overrides['cost_aggressiveness']=args.cost_aggressiveness
        print(json.dumps(eng().plan_run(run_id=args.run_id,task_class=args.task_class,complexity=args.complexity,risk=args.risk,coupling=args.coupling,parallelizable=args.parallelizable,repo_revision=args.repo_revision,user_overrides=overrides),indent=2)); return
    if args.cmd=='simulate-policy':
        print(json.dumps(eng().simulate_policy(candidate_quality_floor=args.quality_floor,candidate_cost_aggressiveness=args.cost_aggressiveness),indent=2)); return
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
            print(_format_adapter_table(a))
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
        # Failures (unreadable log, granularity conflict, interrupted append) are actionable: one bounded,
        # path-redacted line on stderr even with --quiet, so the HT hook log and the launchd log show them
        # without unbounded or identifying detail; the full list is in the JSON body on stdout. Bounding
        # keeps the message tail, where the conflict remedy (`--granularity session`) lives. The
        # ledger/dashboard refresh and ingest_status.json were already handled by `process_ingest`.
        if result.get('failures') and not args.dry_run:
            first_detail = ' '.join(str(result['failures'][0].get('error') or 'ingest failed').split())
            print(_bound_error(_redact_paths(f"{len(result['failures'])} file(s) failed; first: {first_detail}")), file=sys.stderr, flush=True)
            raise SystemExit(EXIT_INVALID)
        return
    if args.cmd=='quality':
        ev=QualityEvidence(**json.loads(args.payload)); print(json.dumps({'hard_gate_pass':ev.hard_gate_pass(),'quality_evidence_score':ev.evidence_score()},indent=2)); return
    if args.cmd=='context-put': print(json.dumps(ContextRegistry(ROOT).put(args.id,args.content,source=args.source,status=args.status,repo_revision=args.revision),indent=2)); return
    if args.cmd=='context-packet': print(json.dumps(ContextRegistry(ROOT).packet([x.strip() for x in args.ids.split(',') if x.strip()],args.budget),indent=2)); return
    if args.cmd=='archive-runs': raise SystemExit(_archive_runs_command(args))
    if args.cmd=='restore-run': raise SystemExit(_restore_run_command(args))

def _fmt_bytes(n:int)->str: return f'{n:,}'

def _archive_runs_command(args)->int:
    try: entries=archive_runs(ROOT,older_than_days=args.older_than_days,execute=args.execute)
    except (ValueError,OSError) as exc: print(f'archive-runs: {exc}',file=sys.stderr); return EXIT_INVALID
    planned=[e for e in entries if e['files']]
    skipped=[e for e in entries if e['status']=='skipped']
    summary={'executed':args.execute,'older_than_days':args.older_than_days,'state_root':str(ROOT),'runs':entries,
             'originals_retained':all(e.get('originals_retained',True) for e in planned),
             'reclaimed_bytes':max(0,-sum(e.get('storage_delta_bytes',0) for e in planned)),
             'storage_delta_bytes':sum(e.get('storage_delta_bytes',0) for e in planned),
             'raw_bytes_removed':sum(e.get('raw_bytes_removed',0) for e in planned),
             'eligible_runs':len(planned),'skipped_runs':len(skipped),
             'eligible_raw_bytes':sum(e['raw_bytes'] for e in planned),
             'eligible_estimated_compressed_bytes':sum(e['estimated_compressed_bytes'] for e in planned),
             'archived_files':sum(1 for e in planned for f in e['files'] if f['status']=='archived'),
             'archived_raw_bytes':sum(f['raw_bytes'] for e in planned for f in e['files'] if f['status']=='archived'),
             'compressed_bytes':sum(e.get('compressed_bytes',0) for e in planned),
             'not_archived_files':sum(1 for e in planned for f in e['files'] if f['status']!='archived')}
    failed=args.execute and summary['not_archived_files']>0
    if args.json: print(json.dumps(summary,indent=2,default=str)); return EXIT_INVALID if failed else EXIT_OK
    if not args.execute: print(f'DRY RUN — nothing written. Re-run with --execute to archive. (runs under {ROOT/"runs"}, older than {args.older_than_days:g} days)')
    for e in entries:
        if e['status']=='skipped' and not e['files']: print(f"skipped  {e['run_id']}  {e['reason']}: {e['detail']}"); continue
        size=f"{_fmt_bytes(e['raw_bytes'])} raw bytes -> "+(f"{_fmt_bytes(e['compressed_bytes'])} compressed" if args.execute else f"~{_fmt_bytes(e['estimated_compressed_bytes'])} estimated compressed")
        print(f"{e['status']:<8} {e['run_id']}  {len(e['files'])} file(s)  {size}  [{e['detail']}]")
        for f in e['files']:
            note=f"  ({f['status']}: {f['reason']} — {f['detail']})" if f.get('reason') else ''
            print(f"    {f['name']} -> {f['destination']}  {_fmt_bytes(f['raw_bytes'])} bytes{note}")
    verb='archived' if args.execute else 'eligible'
    print(f"Total: {summary['eligible_runs']} run(s) {verb}, {_fmt_bytes(summary['archived_raw_bytes'] if args.execute else summary['eligible_raw_bytes'])} raw bytes, "
          f"{_fmt_bytes(summary['compressed_bytes']) if args.execute else '~'+_fmt_bytes(summary['eligible_estimated_compressed_bytes'])} {'compressed' if args.execute else 'estimated compressed'} bytes; "
          f"{summary['skipped_runs']} run(s) skipped. {summary['raw_bytes_removed']} raw bytes removed; "
          f"{summary['reclaimed_bytes']} net logical bytes reclaimed (including recovery metadata); "
          f"storage delta {summary['storage_delta_bytes']:+d} bytes. Unsealed originals retained; no audit evidence is freed.")
    if failed: print(f"{summary['not_archived_files']} planned file(s) were not archived; see the notes above. Recovery copies are retained.",file=sys.stderr)
    return EXIT_INVALID if failed else EXIT_OK

def _restore_run_command(args)->int:
    try: result=restore_run(ROOT,args.run_id,execute=not args.dry_run)
    except (ValueError,OSError) as exc: print(f'restore-run: {exc}',file=sys.stderr); return EXIT_INVALID
    if args.json: print(json.dumps(result,indent=2,default=str)); return EXIT_OK if not result['errors'] else EXIT_INVALID
    print(result['message'])
    for name in result.get('would_restore',[]):
        info=result['files'][name]; print(f"    {name} <- {info['archive_path']}  {_fmt_bytes(info['raw_bytes'])} bytes  sha256 {info['sha256'][:16]}…")
    for err in result['errors']: print(f"    FAILED {err['name']}: {err['reason']} — {err['detail']}",file=sys.stderr)
    return EXIT_OK if not result['errors'] else EXIT_INVALID
if __name__=='__main__': main()

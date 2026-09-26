"""`orchestrator.cli` — the argparse entry point (`python3 -m orchestrator.cli`).

This package's `__init__.py` is the one module every command module and every existing test
imports/patches as `orchestrator.cli` (ground rule 2: nothing that used to be importable from the
old single-file `cli.py` may stop being importable). It holds every name a test does
`mock.patch.object(cli, 'X', ...)` or `patch('orchestrator.cli.X')` on (`ROOT`, `refresh`,
`archive_runs`, ...) plus the small helpers (`_write`, `_single`, `eng`, `cfg`, ...) those patch
targets are read through, so patching here reliably changes what every command module observes —
the command modules always resolve those names by looking them up on this module at call time
(`from orchestrator import cli` inside the function body), never by capturing them at their own
import time. See `docs/architecture-review.md` B3 for the split rationale.

Each command group lives in its own module (`records_cmds`, `routing_cmds`, `ingest_cmds`,
`context_cmds`, `archive_cmds`); `build_parser()` asks each to `register()` its subparsers, and
`main()` dispatches through the `HANDLERS` table each module exposes.
"""
from __future__ import annotations
import argparse,json,os,sys
from pathlib import Path
from typing import Any, Callable
from ..runtime import EventStore,QualityEvidence,default_state_root,read_json
from ..state import rebuild,refresh_ledger,load_or_rebuild
from ..dashboard import generate_dashboard
from ..record_batch import write_batch,single_record,BatchValidationError,BatchAppendError,STREAMS,RETRY_SAME_IDS
from ..app.refresh import refresh_after_write
from ..history import load_stats
from ..scheduler import recommend_package,topology_for
from ..context import ContextRegistry
from ..features import FeaturePolicy, feature_inventory
from ..app.engine import build_engine
from ..ingest import discover_logs, ingest_paths
from ..ingest.service import INGEST_ERROR_LIMIT, _bound_error, _redact_paths, make_ingest_status
from ..ingest.service import process_ingest as _ingest_process_ingest
from ..dynamic_adapter import resolve_adapter
from ..archive import DEFAULT_OLDER_THAN_DAYS, RESTORE_COMMAND, archive_runs, restore_run
from ..archive.execute import summarize_archive_results
from ..contract import (
    EXIT_APPEND_FAILED as CONTRACT_EXIT_APPEND_FAILED,
    EXIT_INVALID as CONTRACT_EXIT_INVALID,
    EXIT_OK as CONTRACT_EXIT_OK,
    EXIT_REFRESH_FAILED as CONTRACT_EXIT_REFRESH_FAILED,
    PATH_REDACTION_RE,
    STATUS_APPEND_FAILED,
    STATUS_INVALID,
)

_PATH_RE = PATH_REDACTION_RE

#: Override for the state root, set only by tests via `mock.patch.object(cli, 'ROOT', ...)`.
#: `None` (the default at import time) means "resolve from the environment lazily"; see `_root()`.
#: Importing this module must never read `CODING_AGENT_ORCHESTRATOR_HOME`/`HOME` or touch the
#: filesystem, so nothing here calls `default_state_root()` at module scope.
ROOT: Path | None = None

def _root() -> Path:
    """The effective state root: the `ROOT` override if a test set one, else resolved from the
    environment right now (once per call, never cached at import time)."""
    return ROOT if ROOT is not None else default_state_root()

#: `orchestrator/config.json` lives one directory up from this package (`orchestrator/cli/`), same
#: file `engine.py`/`pricing.py`/`presentation/dashboard_data.py` read; resolved relative to this
#: file so cfg() doesn't care what the caller's cwd is.
_CONFIG_PATH = Path(__file__).resolve().parent.parent / 'config.json'
def cfg(): return read_json(_CONFIG_PATH,{})
def refresh(state_root: Path | None = None) -> Path:
    """Catch the ledger up from its durable checkpoint and republish the dashboard; return its path.

    Not a recovery: records reach the streams through the coordinated writer (deduplicated by
    record id), so an incremental replay is exact and the record-id cache stays trusted. A full
    `rebuild` (replay from byte 0, cache discarded) remains the explicit `rebuild` command.
    """
    root = Path(state_root) if state_root is not None else _root()
    refresh_ledger(root)
    return generate_dashboard(root, config=cfg())


def process_ingest(paths: list[Path], *, state_root: Path, runtime: str | None,
                   repository: str | None, dry_run: bool, granularity: str,
                   on_file: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Thin cli.py wrapper around `ingest.service.process_ingest`, injecting `refresh` (ledger
    catch-up + dashboard publish) as the dependency that module cannot import directly (it stays
    below `presentation`/`app`/`cli` in the B2 layer order — see `docs/architecture-review.md` B3).
    `refresh` is looked up by name here, not captured at import time, so
    `unittest.mock.patch('orchestrator.cli.refresh', ...)` still takes effect on every call.
    """
    return _ingest_process_ingest(paths, state_root=state_root, runtime=runtime, repository=repository,
                                  dry_run=dry_run, granularity=granularity, on_file=on_file, refresh=refresh)

# Exit codes for the durable-write commands (`batch`, `event`, `metric`, `outcome`). The JSON body on
# stdout always carries `persisted`/`duplicates`/`retry`; `retry == 'same_ids'` (exit 2 or 3) means the
# durable records are fine and resubmitting the same ids finishes the work without appending twice.
EXIT_OK=CONTRACT_EXIT_OK; EXIT_INVALID=CONTRACT_EXIT_INVALID; EXIT_APPEND_FAILED=CONTRACT_EXIT_APPEND_FAILED; EXIT_REFRESH_FAILED=CONTRACT_EXIT_REFRESH_FAILED

def _parse_json(text:str,what:str):
    try: return json.loads(text)
    except json.JSONDecodeError as exc: raise BatchValidationError(f'{what} is not valid JSON: {exc}') from exc

def _batch_payload(raw:str|None):
    return _parse_json(raw if raw not in (None,'-') else sys.stdin.read(),'batch payload')

def _failure(status:str,error:str,persisted:dict|None=None,retry:str|None=None)->dict:
    empty={s:0 for s in STREAMS}
    return {'ok':False,'status':status,'error':error,'persisted':persisted or empty,'duplicates':empty,'ledger_updated':False,'dashboard_updated':False,'retry':retry}

def _write(root:Path|None,records)->tuple[int,dict]:
    """Run the coordinated writer; return (exit code, JSON body) without printing.

    Every CLI path that appends (`batch`, `event`, `metric`, `outcome`, `init`) reports the writer's
    outcome through this one function, so a rejected batch or an interrupted append is always a
    structured body with `persisted`/`retry` and never an uncaught traceback. `root` is the state
    root already resolved by the caller (`main()` resolves it once per invocation); pass `None` to
    resolve it here instead, for callers outside `main()`.
    """
    root=root if root is not None else _root()
    try: result=write_batch(root,records)
    except BatchValidationError as exc: return EXIT_INVALID,_failure(STATUS_INVALID,str(exc))
    except BatchAppendError as exc: return EXIT_APPEND_FAILED,_failure(STATUS_APPEND_FAILED,str(exc),exc.persisted,RETRY_SAME_IDS)
    result=refresh_after_write(root,result,config=cfg())
    return (EXIT_OK if result['ok'] else EXIT_REFRESH_FAILED),{k:v for k,v in result.items() if k!='records'}

def write_records(records,root:Path|None=None)->int:
    """Run the coordinated writer for the CLI and print its JSON result; return the exit code."""
    code,body=_write(root,records); print(json.dumps(body)); return code

def _single(stream:str,payload_text:str,event:str|None=None,root:Path|None=None)->int:
    """One-record form of `write_records`: the command names the stream (and event); the payload cannot override them."""
    try: record=single_record(stream,_parse_json(payload_text,'payload'),event=event)
    except BatchValidationError as exc: print(json.dumps(_failure(STATUS_INVALID,str(exc)))); return EXIT_INVALID
    return write_records([record],root)

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

    Delegates to each command group's `register(subparsers)` (see `records_cmds`, `routing_cmds`,
    `ingest_cmds`, `context_cmds`, `archive_cmds`) so this function lists only which groups exist,
    not every flag; the groups are imported lazily here (not at module import time) because they
    each do `from orchestrator import cli` inside their own function bodies, which would otherwise
    be a circular import while this package is still initializing.
    """
    from . import records_cmds, routing_cmds, ingest_cmds, context_cmds, archive_cmds
    ap=argparse.ArgumentParser(prog='orchestrator'); sp=ap.add_subparsers(dest='cmd',required=True)
    records_cmds.register(sp)
    routing_cmds.register(sp)
    ingest_cmds.register(sp)
    context_cmds.register(sp)
    archive_cmds.register(sp)
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

def eng(root: Path):
    """Build a wired `OrchestrationEngine` for `root`. Module-level now (used to be a closure
    defined inside `main()`) so `routing_cmds` handlers can call `cli.eng(root)` the same way they
    call every other cli-level helper, and so it stays importable as `orchestrator.cli.eng`
    (ground rule 2: this was part of the old `cli.py`'s implicit surface even as a local name).
    """
    return build_engine(root)

def _command_table() -> dict[str, Callable[[argparse.Namespace, Path, dict], None]]:
    """cmd name -> handler(args, root, config); built lazily for the same reason as `build_parser`
    imports its command modules lazily (avoids a circular import at package-init time).
    """
    from . import records_cmds, routing_cmds, ingest_cmds, context_cmds, archive_cmds
    table: dict[str, Callable[[argparse.Namespace, Path, dict], None]] = {}
    for module in (records_cmds, routing_cmds, ingest_cmds, context_cmds, archive_cmds):
        table.update(module.HANDLERS)
    return table

def main():
    ap=build_parser()
    args=ap.parse_args(); C=cfg()
    # Resolve the state root exactly once per invocation (honouring a test-patched `ROOT`), then
    # thread it explicitly through every helper below instead of each one calling `_root()` again.
    root=_root()
    # A dry run must leave the state root untouched (not even created), so the root and its streams are
    # only ensured for commands that write or read them; the engine is built where a command needs it.
    # The archive commands never touch the streams at all, so they do not create them either.
    if not (args.cmd=='ingest' and args.dry_run) and args.cmd not in ('archive-runs','restore-run'): EventStore(root)
    _command_table()[args.cmd](args, root, C)

def _fmt_bytes(n:int)->str: return f'{n:,}'

def _archive_runs_command(args,root:Path|None=None)->int:
    root=root if root is not None else _root()
    try: entries=archive_runs(root,older_than_days=args.older_than_days,execute=args.execute)
    except (ValueError,OSError) as exc: print(f'archive-runs: {exc}',file=sys.stderr); return EXIT_INVALID
    summary=summarize_archive_results(entries,executed=args.execute,older_than_days=args.older_than_days,state_root=root)
    failed=args.execute and summary['not_archived_files']>0
    if args.json: print(json.dumps(summary,indent=2,default=str)); return EXIT_INVALID if failed else EXIT_OK
    if not args.execute: print(f'DRY RUN — nothing written. Re-run with --execute to archive. (runs under {root/"runs"}, older than {args.older_than_days:g} days)')
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

def _restore_run_command(args,root:Path|None=None)->int:
    root=root if root is not None else _root()
    try: result=restore_run(root,args.run_id,execute=not args.dry_run)
    except (ValueError,OSError) as exc: print(f'restore-run: {exc}',file=sys.stderr); return EXIT_INVALID
    if args.json: print(json.dumps(result,indent=2,default=str)); return EXIT_OK if not result['errors'] else EXIT_INVALID
    print(result['message'])
    for name in result.get('would_restore',[]):
        info=result['files'][name]; print(f"    {name} <- {info['archive_path']}  {_fmt_bytes(info['raw_bytes'])} bytes  sha256 {info['sha256'][:16]}…")
    for err in result['errors']: print(f"    FAILED {err['name']}: {err['reason']} — {err['detail']}",file=sys.stderr)
    return EXIT_OK if not result['errors'] else EXIT_INVALID
if __name__=='__main__': main()

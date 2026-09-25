"""`ingest`: the log-ingestion command (B3, `docs/architecture-review.md`). See `records_cmds.py`'s
module docstring for why every handler resolves cli-level helpers through `from orchestrator import
cli` inside the function body instead of importing them at module scope.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

#: `--granularity`'s choices, sourced from `orchestrator.records`'s own granularity constants
#: rather than hardcoded strings (B3 asks for `records.GRANULARITIES`). `records.GRANULARITIES`
#: also includes `EVENT` (used for row *classification*, not for this flag), which the ingest CLI
#: has never accepted and the bridge/scripts never send, so restricting choices to it verbatim
#: would be a behaviour change; only `CALL`/`SESSION` (the two values `--granularity` already
#: accepted before this split) are used here. See docs/architecture-review.md B3 notes.
from ..records import CALL, SESSION


def register(sp) -> None:
    ing = sp.add_parser('ingest', help='parse HUMAIN Terminal/Codex session logs into metric/event records and append them')
    ing.add_argument('paths', nargs='*', help='session log file paths (default: $HUMAIN_TERMINAL_SESSION_FILE, or use --discover)')
    ing.add_argument('--runtime', help="override the detected runtime, e.g. 'humain-terminal' or 'codex'")
    ing.add_argument('--repository', help='repository label to attach to every ingested record')
    ing.add_argument('--dry-run', action='store_true', help='parse and report without appending or touching the state root')
    ing.add_argument('--granularity', choices=[CALL, SESSION], default=CALL,
                      help=f"how to roll up ingested rows: '{CALL}' (one row per model call, default) or '{SESSION}' (one aggregate row per session)")
    ing.add_argument('--discover', action='store_true', help='discover session logs automatically instead of taking explicit paths')
    ing.add_argument('--since-days', type=float, help='with --discover, only logs modified within the last N days')
    ing.add_argument('--limit', type=int, help='ingest at most this many discovered/given files')
    ing.add_argument('--quiet', action='store_true', help='suppress the per-file progress line on stderr')
    ing.add_argument('--include-scratch', action='store_true', help='with --discover, also include scratch/throwaway session directories')


def handle_ingest(args, root, C) -> None:
    from orchestrator import cli
    if args.discover or args.since_days is not None:
        paths = cli.discover_logs(since_days=args.since_days, runtimes=[args.runtime] if args.runtime else None,
                                   include_scratch=args.include_scratch)
    else:
        paths = args.paths or [p for p in [os.environ.get('HUMAIN_TERMINAL_SESSION_FILE')] if p]
    if args.paths and (args.discover or args.since_days is not None):
        paths = [*args.paths, *paths]
    if args.limit:
        paths = paths[:args.limit]
    if not paths:
        raise SystemExit('No session logs found. Pass paths, use --discover, or set HUMAIN_TERMINAL_SESSION_FILE')
    done = [0]

    def progress(summary):
        done[0] += 1
        runtime_label = str(summary.get('runtime') or '?')
        print(f"[{done[0]}/{len(paths)}] {runtime_label:16} +{summary.get('emitted', 0):<5} "
              f"dup={summary.get('duplicates', 0):<4} ${summary.get('estimated_cost_usd', 0.0):.4f}  "
              f"{Path(summary['file']).name}", file=sys.stderr, flush=True)

    result = cli.process_ingest(paths, state_root=root, runtime=args.runtime, repository=args.repository,
                                 dry_run=args.dry_run, granularity=args.granularity,
                                 on_file=progress if not args.quiet else None)
    print(json.dumps(result, indent=2))
    # Failures (unreadable log, granularity conflict, interrupted append) are actionable: one bounded,
    # path-redacted line on stderr even with --quiet, so the HT hook log and the launchd log show them
    # without unbounded or identifying detail; the full list is in the JSON body on stdout. Bounding
    # keeps the message tail, where the conflict remedy (`--granularity session`) lives. The
    # ledger/dashboard refresh and ingest_status.json were already handled by `process_ingest`.
    if result.get('failures') and not args.dry_run:
        first_detail = ' '.join(str(result['failures'][0].get('error') or 'ingest failed').split())
        print(cli._bound_error(cli._redact_paths(f"{len(result['failures'])} file(s) failed; first: {first_detail}")),
              file=sys.stderr, flush=True)
        raise SystemExit(cli.EXIT_INVALID)


HANDLERS = {
    'ingest': handle_ingest,
}

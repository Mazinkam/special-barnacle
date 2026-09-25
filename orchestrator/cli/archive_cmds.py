"""`archive-runs`/`restore-run`: the run-diagnostics archive commands (B3,
`docs/architecture-review.md`). The heavy lifting (`cli._archive_runs_command`/
`cli._restore_run_command`) stays defined on `orchestrator.cli` itself, not here, because it reads
the bare names `archive_runs`/`restore_run` from its own module globals, and
`tests/test_archive_sealed.py`/`tests/test_archive_security.py` replace those with
`mock.patch.object(cli, 'archive_runs', ...)` — a patch that only takes effect for code whose own
module globals are `orchestrator.cli`'s. These handlers just resolve the state root and call
through.
"""
from __future__ import annotations

import argparse

from ..archive import DEFAULT_OLDER_THAN_DAYS


def register(sp) -> None:
    ar = sp.add_parser(
        'archive-runs', formatter_class=argparse.RawDescriptionHelpFormatter,
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
    ar.add_argument('--execute', action='store_true', help='actually archive; without it this is a dry run that writes nothing')
    ar.add_argument('--json', action='store_true', help='machine-readable output instead of the table')
    rr = sp.add_parser(
        'restore-run', formatter_class=argparse.RawDescriptionHelpFormatter,
        help='restore the archived diagnostics of one run byte-for-byte from its .gz files and manifest',
        description=(
            'Restore every archived file of <state root>/runs/<run_id>/ exactly as it was: each .gz is decompressed into a\n'
            'same-directory temporary file, its SHA-256 and byte count are checked against archive.manifest.json, the\n'
            'original mtime is restored and the file is atomically installed only if its name is still absent. The .gz and\n'
            'manifest are retained for recovery. An invalid manifest or symlink is rejected before mutation. A file that\n'
            'fails verification is reported; existing content is never overwritten, even if a writer creates the file\n'
            'during restore. --dry-run only lists the archived files and their .gz paths.'))
    rr.add_argument('run_id', help='run directory name under <state root>/runs (as shown in the progress board log path)')
    rr.add_argument('--dry-run', action='store_true', help='list what would be restored without writing')
    rr.add_argument('--json', action='store_true', help='machine-readable output')


def handle_archive_runs(args, root, C) -> None:
    from orchestrator import cli
    raise SystemExit(cli._archive_runs_command(args, root))


def handle_restore_run(args, root, C) -> None:
    from orchestrator import cli
    raise SystemExit(cli._restore_run_command(args, root))


HANDLERS = {
    'archive-runs': handle_archive_runs,
    'restore-run': handle_restore_run,
}

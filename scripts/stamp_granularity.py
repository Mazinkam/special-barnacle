#!/usr/bin/env python3
"""Stamp `granularity` on existing metrics.jsonl rows that predate the field.

Every row `orchestrator.ingest` emits today already carries an explicit `granularity`
(`call` | `session`). Rows written before that seam existed do not, and a downstream consumer
has to re-derive their granularity from `covers_calls`/`legacy_source` — exactly the kind of
per-consumer re-derivation `orchestrator.records.classify` exists to replace. This script backfills
the field on old rows using that same classifier, so the ledger becomes self-describing without
anyone having to reason about legacy shapes again.

Classification, per row missing `granularity`:
  * `session`  when the row carries `covers_calls` or `legacy_source` (matches
                `records.classify`'s own precedence for session aggregates).
  * `call`/`event` otherwise, exactly as `orchestrator.records.classify` would return for the row.

Rows that already carry `granularity` are left untouched — this script only fills a gap, it
never overrides a value a runtime (or a prior run of this script) already stated.

Safety posture, matching `scripts/audit_and_clean_metrics.py`:
  * Defaults to a dry run: prints a summary of what *would* change and writes nothing.
  * Writing requires the explicit `--write` flag.
  * The read and the write happen under the package's writer lock
    (`orchestrator.runtime.writer_lock`), the same lock `record_batch`/`EventStore` take before
    appending or checkpointing, so a concurrent append from the running package between this
    script's read and its replace is never lost.
  * Every write is preceded by a timestamped backup of the untouched file
    (`metrics.pre-stamp-granularity-<UTC>Z.jsonl`), copied before metrics.jsonl is touched.
  * The rewrite itself is atomic: the new stream is written to a temp file in the *same*
    directory, flushed and fsynced, then `os.replace`d onto metrics.jsonl. metrics.jsonl is never
    opened for truncation in place, so a kill / OOM / disk-full mid-write leaves the original
    stream intact rather than truncating the shared ledger and relying on a human to notice the
    backup. The temp file is removed if anything fails before the replace.
  * Idempotent: a row already carrying `granularity` is never re-classified, so running this
    script twice in `--write` mode produces byte-identical output on the second run (a fresh
    backup is still taken each time, matching the audit script's unconditional-backup posture).

Usage:
    python3 scripts/stamp_granularity.py [state_dir] [--write]

Without `--write`, nothing on disk is modified. This must not be run against the live state
directory (~/.local/state/coding-agent-orchestrator) as part of an unattended task; run it
by hand, review the dry-run summary first, then re-run with `--write`.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# Make `orchestrator` importable regardless of cwd/PYTHONPATH when this script is invoked
# directly (`python3 scripts/stamp_granularity.py`), matching how `python3 -m scripts.x` or a
# `PYTHONPATH=.` invocation would resolve it.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator.records import CALL, EVENT, SESSION, classify  # noqa: E402
from orchestrator.runtime import writer_lock  # noqa: E402


def _default_state_dir() -> Path:
    return Path(os.path.expanduser(os.environ.get(
        'CODING_AGENT_ORCHESTRATOR_HOME', '~/.local/state/coding-agent-orchestrator')))


def _parse_args(argv: list[str]) -> tuple[Path, bool]:
    write = '--write' in argv
    positional = [a for a in argv if a != '--write']
    state_dir = Path(os.path.expanduser(positional[0])) if positional else _default_state_dir()
    return state_dir, write


def classify_for_stamping(row: dict) -> str:
    """What `granularity` this row should carry, per `records.classify`.

    Delegates entirely to `records.classify` rather than re-implementing its session/event/call
    precedence, so this script and every runtime consumer agree by construction. `covers_calls`
    and `legacy_source` are exactly the two conditions `classify` checks (alongside an explicit
    `granularity=='session'`, moot here since this function is only ever called on rows that
    don't have one) to decide `SESSION`; anything else falls through to `EVENT`/`CALL` the same
    way it would for a freshly emitted row.
    """
    return classify(row)


def plan(records: list[dict]) -> tuple[list[dict], Counter]:
    """Return (rewritten_records, counts) without mutating the input list's dicts in place."""
    counts: Counter = Counter()
    out: list[dict] = []
    for rec in records:
        if 'granularity' in rec and rec['granularity']:
            counts['already_stamped'] += 1
            out.append(rec)
            continue
        granularity = classify_for_stamping(rec)
        counts[f'stamped_{granularity}'] += 1
        out.append({**rec, 'granularity': granularity})
    return out, counts


def _write_atomic(target: Path, records: list[dict]) -> None:
    """Replace `target` with `records`, atomically.

    Rewriting `target` in place (open('w') then write line by line) truncates the shared metric
    stream the instant it opens, so any interruption before the last line lands destroys data that
    was never re-written. Writing a sibling temp file and `os.replace`ing it means readers see
    either the whole old stream or the whole new one, never a half-written one. The temp file is
    created in the target's own directory so the replace is a same-filesystem rename.
    """
    handle = tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=str(target.parent),
                                         prefix=f'.{target.name}.', suffix='.tmp', delete=False)
    temp_path = Path(handle.name)
    try:
        with handle:
            for rec in records:
                handle.write(json.dumps(rec, sort_keys=True) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    except BaseException:
        # Leave no debris and, above all, leave the original stream untouched.
        temp_path.unlink(missing_ok=True)
        raise


def main(argv: list[str]) -> int:
    state_dir, write = _parse_args(argv)
    metrics_path = state_dir / 'metrics.jsonl'
    if not metrics_path.exists():
        print(f'error: no metrics stream at {metrics_path}', file=sys.stderr)
        return 1

    # Hold the package's single writer lock across read→write so a concurrent append from the
    # running package between this script's read and its atomic replace is never lost. The
    # existing atomic-replace-via-temp-file already protects against a truncated stream on a
    # crash mid-write; the lock closes the remaining window where a row appended *between* the
    # read and the replace would simply be overwritten by the older snapshot this script read.
    with writer_lock(state_dir):
        records: list[dict] = []
        bad = 0
        with metrics_path.open(encoding='utf-8', errors='replace') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    bad += 1
        if bad:
            print(f'warning: {bad} malformed lines skipped', file=sys.stderr)

        rewritten, counts = plan(records)
        changed = sum(v for k, v in counts.items() if k != 'already_stamped')

        print(f'stamp_granularity summary (total {len(records)} rows, state_dir={state_dir}):')
        print(f'  already stamped: {counts.get("already_stamped", 0)}')
        print(f'  stamped call:    {counts.get(f"stamped_{CALL}", 0)}')
        print(f'  stamped session: {counts.get(f"stamped_{SESSION}", 0)}')
        print(f'  stamped event:   {counts.get(f"stamped_{EVENT}", 0)}')
        print(f'  total changed:   {changed}')

        if not write:
            print()
            print('dry run: nothing written. Re-run with --write to apply.')
            return 0

        ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = state_dir / f'metrics.pre-stamp-granularity-{ts}.jsonl'
        shutil.copy2(metrics_path, backup)

        _write_atomic(metrics_path, rewritten)

    print()
    print(f'backup: {backup}')
    print(f'clean:  {metrics_path} ({len(rewritten)} records, {changed} changed)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Backfill per-call nested-subagent-cost `model_call` rows from historical dispatch event logs.

Phase 1 items 2-3 (docs/superpowers/goals/2026-09-25-all-in-one.md; confirmed defect 1 in
docs/superpowers/audits/2026-09-25-phase1-audit.md), updated for the Phase 1 review's T1/T2/T3
identity/reconciliation fixes, the follow-on review of THIS script (R4, S1-S5), and a THIRD round
(F1-F5) that replaced in-place `--state-root`/`--apply`/`--rollback` mutation with a strictly
copy-then-backfill contract: before
`bridge/extensions/orchestrator/nested-cost.ts` grew per-task detail (`NestedCallDetail`,
`nestedModelCallRowsFor`), a dispatch's nested subagent spend only ever reached `metrics.jsonl` as
one aggregate number on the `dispatch_finished` EVENT (`nested_cost_usd`) — no per-call row existed
at all. That aggregate is still reconcilable at read time
(`orchestrator.economics.nested_reconciliation`, invoked from `orchestrator.dashboard.build_data`),
which books a shortfall as a clearly-labelled `role='unknown_nested'` residual whenever durable
per-task detail rows don't fully cover a dispatch's claimed aggregate. This script tries to do
BETTER than that residual, for runs where the raw evidence still exists: each dispatch wrote its
own child's raw JSON event stream to `runs/<run_id>/<task_id>.events.jsonl`
(`bridge/extensions/orchestrator/index.ts`, `diagnosticWriter`), and a dispatch that itself called
the `subagent` tool has `tool_execution_end`/`tool_execution_update` events in that exact file with
`toolName: "subagent"` and `result.details.results[]` — the SAME shape `NestedCostTracker.observe`
(nested-cost.ts) reads live. Replaying that file recovers the real per-task rows (real role, model,
tokens, cost) instead of one anonymous `unknown_nested` number.

THE CONTRACT (Phase 1 review round 3, F1-F5): this script NEVER modifies `--source`, in dry-run OR
`--apply`. There is no in-place mode and no rollback-by-manifest:

    python3 scripts/backfill_nested_costs.py --source /path/to/state-root
        Dry-run (the default): read-only analysis of --source. Writes nothing at all — no lock
        file, no output directory, no backup. Prints the plan exactly as `--apply` would compute
        it, without ever writing it.

    python3 scripts/backfill_nested_costs.py --source /path/to/state-root --output /path/to/fresh-dir --apply
        1. Refuses if `--output` already exists (created fresh with `os.mkdir(..., 0o700)`; never
           overwrites or reuses a directory).
        2. Refuses if the REALPATH of either `--source` or `--output` equals, is inside, or
           contains the conventional production root (`~/.local/state/coding-agent-orchestrator`)
           or the runtime-resolved default (`orchestrator.runtime.default_state_root()`, which
           honours `CODING_AGENT_ORCHESTRATOR_HOME`) — checked both directions, both paths. There
           is no override flag.
        3. Refuses if `--output`'s realpath (resolved against its parent, since `--output` does not
           exist yet — Phase 1 review B1) equals, is inside, or contains `--source`'s realpath, in
           EITHER direction — a chained `--apply` pointing `--output` back inside its own `--source`
           (or vice versa) is caught before anything is created, not after a self-referential copy
           has already started.
        4. Scans `--source` with this script's OWN lstat-based walker (`scan_source_tree`) BEFORE
           reading a single byte of it for hashing or copying (Phase 1 review B3): if ANY symlink or
           special file (fifo/socket/device/unreadable entry) exists ANYWHERE in the tree, or the
           tree exceeds the configured copy budget (file count or `--max-copy-bytes`, Phase 1 review
           W2), the run aborts with a report naming every unsafe entry found — before `--output` is
           touched at all beyond the empty directory `os.mkdir` already created.
        5. Hashes `--source`'s canonical streams, then copies `--source` into `--output` — never
           `shutil.copytree`/`os.walk`, which follow symlinks by default. Every source file this
           script opens for hashing or copying is opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and
           `fstat`-verified `S_ISREG` immediately after open (Phase 1 review B3): a FIFO is refused
           instantly (never blocks waiting for a writer that will never come) and a symlink or
           special file that slipped past the lstat scan via a TOCTOU race is still refused at open
           time, never silently read. The total bytes copied is checked against `--max-copy-bytes`
           again DURING the copy (Phase 1 review W2), not only from the pre-copy scan's tally, so a
           source file growing mid-copy still triggers the budget.
        6. Re-hashes `--output`'s just-copied canonical streams and compares them to the hashes taken
           BEFORE the copy started (Phase 1 review W4): a mismatch means `--source` changed while
           this run was reading it, and the run aborts rather than backfilling against streams that
           no longer match what `--source` claimed to contain.
        7. Pre-scans every stream in the OUTPUT copy that `orchestrator.record_batch.write_batch`,
           `orchestrator.record_index.RecordIndex` and `orchestrator.state.rebuild`'s ledger replay
           read (`events.jsonl`, `metrics.jsonl`, `outcomes.jsonl`) with this script's own bounded
           parser (`iter_physical_jsonl`), INCLUDING a final line with no trailing newline (Phase 1
           review W1) — `RecordIndex._scan` parses that torn/in-progress-write tail too (unlike the
           general replayable-prefix readers elsewhere in this script), so a hazard hiding only in
           an unterminated final line must be caught here or it would reach `_scan` unguarded. Those
           three shared modules are never modified here: they use the standard library's unbounded
           `for line in handle`/`json.loads` and do not catch `RecursionError` themselves. If any
           stream has an oversized line or a pathologically deep value, the run aborts with a report
           BEFORE ever calling into `write_batch`/`rebuild`.
        8. Plans against the OUTPUT copy (never `--source`) with the exact same `plan_backfill`
           dry-run uses, and appends the planned rows there through the existing
           `orchestrator.record_batch.write_batch` lock/atomic-append/dedup path (the writer lock
           lives in `--output`, never touching `--source`).
        9. Rebuilds derived state (`orchestrator.state.rebuild`) in `--output`.
        10. Writes a uniquely-named manifest (`backfill-manifest-<suffix>.json`, never a fixed name —
           a chained `--apply` copies a previous run's own manifest along with everything else) in
           `--output`: `--source`'s path, sha256 of its `events.jsonl`/`metrics.jsonl`/
           `outcomes.jsonl`, `--output`'s path, rows added, and this script's version.
        ANY failure after `--output` is created (unsafe source tree, a copy-budget breach, a
        post-copy hash mismatch, a pre-scan hazard, a plan-size abort, a write/rebuild error) NEVER
        deletes `--output` (Phase 1 review B2 — this script previously `shutil.rmtree`'d it on every
        failure path, which is itself a destructive, unattended action against a directory that may
        already hold a partial but forensically useful copy). Instead `--output` is left in place
        exactly as it stood at the moment of failure, a best-effort `INCOMPLETE` marker file is
        written inside it (via the directory's own file descriptor, opened right after `os.mkdir`,
        so the marker still lands in the actual created directory even across a TOCTOU path swap),
        and the error report names `--output`'s path for a human to inspect or remove themselves
        (`rm -rf <output>`) — this script itself never recursively deletes anything, on any path.

    Rollback: delete `--output` yourself (`rm -rf <output>`) if you decide the run's failure or
    result should not be kept. `--source` was never touched, so there is nothing to restore there
    and nothing else to undo.

    Idempotency: running `--apply` a second time with `--source` set to a PREVIOUS run's `--output`
    and a fresh `--output` adds ZERO rows — the previous run's own backfilled rows are durably
    present in that copy, so `existing_nested_coverage` (below) finds them and skips re-booking.

TRUST CONTRACT (Phase 1 review round 4, B1-B4/W1-W4): `--source` must be a TRUSTED, IMMUTABLE
snapshot copy, not a live, concurrently-written production state root — this script defends against
`--source` changing WHILE IT RUNS (the post-copy hash re-check, item 6 above) but a residual
TOCTOU window between an ancestor directory of `--source` being swapped out from under this process
and the moment `--source` is first resolved is accepted risk under that contract, not something
every read in this script re-verifies from scratch. `--output`'s PARENT directory must likewise be
a trusted directory: this script creates `--output` itself (`os.mkdir(..., 0o700)`) and never
follows a symlink while writing into it, but it does not defend against a hostile actor with write
access to `--output`'s parent racing this process. Neither guarantee is a substitute for running
this script against filesystems you already trust; the symlink/special-file/TOCTOU defenses above
exist to catch MISTAKES and DATA CORRUPTION in an otherwise-trusted `--source`, not to make an
adversarial `--source` or `--output` parent safe to point this script at. Failure never deletes:
see item "ANY failure after `--output` is created" above.

Identity scheme — mirrors the bridge EXACTLY (Phase 1 review T1/T2; see
`bridge/extensions/orchestrator/index.ts`'s `dispatchParallel`/`nestedModelCallRowsFor` and
`orchestrator/economics.py`'s `nested_reconciliation`), so a run later re-processed by the live code
path (replay/redispatch) can never double-book against what this script wrote:

- `dispatch_attempt` (0 = original, 1 = the codex -> Bedrock quota-fallback retry) is read off each
  `dispatch_finished` event explicitly, and VALIDATED (Phase 1 review F4): a finite, integral value
  in `[0, 16]`, or treated as absent otherwise (Infinity/NaN, a non-integral float, a string, a
  bool, or an out-of-range value never crashes and is never trusted as a distinct identity).
  ABSENT (or malformed) reads as 0 for the single-event case — every dispatch that never hit the
  fallback path has no reason to carry the field, which is exactly the same thing as attempt 0 —
  but see "Old-bug cumulative sums" below for why two events sharing a `(run_id, task_id)` are not
  always this simple.
- The reconciliation key is `(run_id, task_id, dispatch_attempt)`, never `(run_id, task_id)` alone.
- Backfilled detail-row `record_id`s are
  `nested:{run_id}:{parent_task_id}:{dispatch_attempt}:{toolCallId}:{taskId}:{nested_attempt}` —
  byte-for-byte the same scheme `nestedModelCallRowsFor` writes.

Old-bug cumulative sums (Phase 1 review T1, historical data only): before that fix, a quota
fallback's SECOND `dispatch_finished` event carried the SUM of both attempts' nested cost, not
just its own — and pre-T1 events may not carry `dispatch_attempt` at all, so "two events, same
`(run_id, task_id)`" cannot always be told apart into "two provably separate attempts" versus "one
old-bug cumulative pair". This script only ever treats a `(run_id, task_id)` pair with more than
one `dispatch_finished` event as two SEPARATE, independently-reconcilable attempts when EVERY event
in the group carries an explicit, VALIDATED `dispatch_attempt` field and those values are pairwise
distinct (exactly what the fixed bridge always does going forward). Any other shape (attempt
missing or malformed on any event, duplicate attempt values, more than two events) is booked
NOTHING and reported as ambiguous — provably separating a cumulative old-bug sum back into its two
attempts is not possible from the event stream alone. `orchestrator.economics.nested_reconciliation`
applies the identical rule dynamically at dashboard-build time (Phase 1 review F1), so live data
gets the same protection this script gives historical data.

Reconciliation rule per (run_id, task_id, dispatch_attempt), deliberately conservative:

- Existing coverage first (Phase 1 review R4): before anything else, `metrics.jsonl` itself is
  scanned for rows that already cover this run/parent's nested work — any row carrying
  `nested: true` for the same `(run_id, parent_task_id)`, or a `record_id` with the
  `nested:{run_id}:{parent_task_id}:` prefix. If any such row exists, this dispatch's nested work
  already has SOME durable detail (live bridge, a prior backfill run, or a partial write) and
  nothing is booked here — never trust a producer's claim (`nested_rows_emitted`) as proof by
  itself (the same "a claim is not proof" rule as `economics.nested_reconciliation`'s T3 fix); only
  the streams' own content decides overlap. This is also the mechanism that makes a repeat
  `--apply` against a previous run's own `--output` add zero rows.
- If the event has NO `nested_cost_usd` key at all (pre-tracking: this run predates the
  `nested_cost_usd` commit), whatever detail this script recovers from the log is booked AS-IS —
  there is no aggregate to reconcile against — but tagged `backfill_evidence:
  'event_log_only_no_aggregate'` and reported in its own "unverifiable total" bucket, separate from
  the per-call-reconciled rows: there is no independent number anywhere this recovery can be
  checked against, only the raw log itself.
- If `nested_cost_usd` is present but not a finite, non-negative number (inf/nan/a negative value),
  the aggregate itself is unusable for reconciliation; nothing is booked, reported ambiguous.
- Otherwise (a usable aggregate, possibly `0.0`) the reconstructed per-task sum is compared against
  it within a small tolerance: within tolerance -> booked, tagged `backfill_evidence:
  'reconciled_with_aggregate'`; outside tolerance -> AMBIGUOUS, nothing booked (a partial detail-row
  set could double-book against the runtime's own dynamic residual, which keys off *presence* of
  any detail row for a dispatch, not the reconstructed amount, so non-overlap is not provable here).
- If the log has no `subagent` tool events at all, there is nothing to recover; reported
  informationally (not an error) and the dispatch's aggregate (if any) keeps being reconciled the
  existing way, dynamically, by `economics.nested_reconciliation` at dashboard-build time.

Every per-task cost (`usage.cost` in the raw log) and every event aggregate (`nested_cost_usd`) is
required to be a finite, non-negative number to count as a real measurement; inf/nan/negative
values read as unknown (never as zero, never as "the dispatch had no cost") — the same honesty
rule `economics.cost_class`/`has_reported_tokens` already applies to every other row. A later
observation for the same nested-call key that carries no valid cost NEVER erases an earlier valid
one (Phase 1 review T5/F2, mirrors `NestedCostTracker.observe` exactly): the last VALID cost wins,
never merely the last observation.

Safety (Phase 1 review S1-S5, updated for the copy-then-backfill contract):

- Dry-run by default; nothing is written without `--apply`, and even `--apply` writes only to a
  freshly created `--output`, never to `--source`.
- The protected-root guard (Phase 1 review S2) has no override flag and checks BOTH `--source` and
  `--output`, by realpath, in BOTH directions (candidate inside protected root, or protected root
  inside candidate) — a symlink or relative path aimed at, containing, or contained by either the
  conventional production root or the runtime-resolved default is caught the same way.
- The state root's canonical streams/index/lock/`runs/` are rejected outright if any of them is a
  symlink resolving outside the state root (`reject_symlink_escape`), checked on `--source` before
  reading it and again on `--output` immediately after the copy, before planning or writing.
- The copy itself never follows a symlink and never copies a special file (Phase 1 review F-round-3
  design change): `copy_source_tree`'s own lstat-based walker (`scan_source_tree`) aborts BEFORE
  copying a single byte rather than silently skipping or, worse, following one; a failed abort
  leaves `--output` in place with an `INCOMPLETE` marker (Phase 1 review B2 - see the module-level
  contract above), it is never recursively deleted by this script.
- The copy is bounded (Phase 1 review W2): `--source`'s regular-file count and total bytes are
  checked against a configured budget (an internal file-count cap, and `--max-copy-bytes`,
  default 20 GiB) both during the pre-copy scan AND again while bytes are actually being copied, so
  a `--source` that grows mid-copy is still caught, not just a `--source` that was already too big
  at scan time.
- Run ids are validated as a single, strict path component before ever being joined onto `runs/`;
  the resulting path's realpath must stay contained under `runs/`, and a symlinked run directory or
  event log is never followed (skipped and reported, not silently traversed).
- Every JSONL line (this script's own two streams: the run's raw event log, and `events.jsonl`/
  `metrics.jsonl`) is read through a bounded physical-line reader: an oversized line (default cap
  4 MiB) is skipped and counted rather than read in full; malformed JSON, invalid UTF-8 and
  RecursionError (pathologically deep nesting) are all caught per line, never crash the run.
  Physical line numbers are preserved even across skipped/blank/malformed lines, so
  `backfill_source_line` always names the real line in the source file. The OUTPUT pre-scan
  (`prescan_output_streams`) additionally parses a final line with no trailing newline (Phase 1
  review W1), because `orchestrator.record_index.RecordIndex._scan` does the same - unlike the
  general replayable-prefix readers this script otherwise mirrors, `_scan` does not skip a
  torn/in-progress-write tail, so a hazard hiding only there must be caught before `_scan` ever
  sees it.
- Every file this script opens for hashing or copying (`--source`'s own regular files) is opened
  `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and `fstat`-verified `S_ISREG` immediately after open (Phase 1
  review B3), run BEFORE any hashing begins: a FIFO is refused instantly rather than hanging this
  process waiting for a writer that will never come, and a symlink or special file slipping past
  the lstat scan via a TOCTOU race is still refused at open time.
- After the copy, `--output`'s canonical streams are re-hashed and compared to the hashes taken of
  `--source` BEFORE the copy started (Phase 1 review W4); a mismatch aborts the run - `--source`
  changed while being read, so continuing would backfill against a copy that no longer matches what
  `--source` claimed to contain at the start.
- Planning is capped (`MAX_RETAINED_RECORDS`, `MAX_EVENTS_PER_GROUP`): caps are enforced BEFORE a
  new entry is ever inserted into the replay `latest` dict, a dispatch group, the existing-coverage
  index, or the planned `rows_to_add` list (Phase 1 review F3/W3), never after. A `(run_id,
  task_id)` group already past `MAX_EVENTS_PER_GROUP` collapses into a bounded summary (an event
  COUNT, not the full retained event list) rather than growing without bound; the total number of
  dispatch groups tracked, dispatch_finished events retained across all groups, the
  existing-coverage index, one dispatch's replayed nested-call entries, and the final row count are
  all capped independently. Exceeding any of them aborts the run with a clear message and writes
  nothing (and, under `--apply`, leaves `--output` in place with an `INCOMPLETE` marker rather than
  deleting it - Phase 1 review B2), rather than growing an unbounded plan in memory.
- `--source` is trusted to be an immutable snapshot and `--output`'s parent a trusted directory
  (Phase 1 review round 4 TRUST CONTRACT, stated in full above); this script defends against
  mistakes and corruption in an otherwise-trusted `--source`, not against an adversarial one.

Usage:
    python3 scripts/backfill_nested_costs.py --source /path/to/state-root
    python3 scripts/backfill_nested_costs.py --source /path/to/state-root --output /path/to/fresh-dir --apply
    rm -rf /path/to/fresh-dir   # rollback: --source above was never touched; on FAILURE this
                                # script leaves --output in place itself (never deletes it) with an
                                # INCOMPLETE marker inside it - rm -rf it yourself once you are done
                                # inspecting it, or re-run --apply again with a fresh --output path.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import re
import stat
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator.record_batch import MAX_BATCH_RECORDS, write_batch  # noqa: E402
from orchestrator.record_index import STREAMS  # noqa: E402
from orchestrator.runtime import default_state_root, fsync_directory, writer_lock  # noqa: E402
from orchestrator.state import rebuild as rebuild_derived_state  # noqa: E402

BACKFILL_VERSION = 3
COST_TOLERANCE_ABS = 0.005
COST_TOLERANCE_REL = 0.005

# --- bounds (Phase 1 review S5/F3) --------------------------------------------------------------

#: A single JSONL line larger than this is skipped (and counted), never read in full.
MAX_LINE_BYTES = 4 * 1024 * 1024

#: Cap on retained planning state: distinct `(run_id, task_id)` dispatch groups tracked, entries in
#: the existing-coverage index built from `metrics.jsonl`, one dispatch's replayed nested-call
#: entries, the total number of `dispatch_finished` events retained across all groups, and the
#: final row count. Exceeding any of these aborts the run with a clear message and writes nothing,
#: rather than growing an unbounded plan in memory from a hostile or corrupt state root.
MAX_RETAINED_RECORDS = 20_000

#: Cap on `dispatch_finished` events retained PER `(run_id, task_id)` group (Phase 1 review F3).
#: Generously above the real maximum (2 — the codex -> Bedrock fallback design never produces
#: more) so it never fires on legitimate data; exists only to bound memory against a hostile or
#: corrupt `events.jsonl` with many events sharing one key. A group already past this cap collapses
#: into a bounded summary (an event count) rather than retaining every event.
MAX_EVENTS_PER_GROUP = 8

#: Cap on the number of regular files `--apply` will copy from `--source` (Phase 1 review W2).
#: Enforced during the pre-copy lstat scan, before a single byte is read; not configurable via a
#: flag (unlike the byte budget below) — a state root with more than this many files is already an
#: unusual shape worth a human's attention rather than a bigger number.
MAX_COPY_FILES = 200_000

#: Default cap on total bytes `--apply` will copy from `--source` (Phase 1 review W2), overridable
#: with `--max-copy-bytes`. Enforced twice: once from the pre-copy lstat scan's size tally (so an
#: already-too-big `--source` never starts a copy at all), and again as bytes are actually copied
#: (so a `--source` file that grows mid-copy is still caught, not just a `--source` that was
#: already too big at scan time).
DEFAULT_MAX_COPY_BYTES = 20 * 1024 ** 3  # 20 GiB


class PlanTooLargeError(RuntimeError):
    """Planning would retain more records than a configured cap; nothing was written."""


class CopyBudgetExceededError(RuntimeError):
    """`--source`'s tree exceeds the configured copy budget (`MAX_COPY_FILES` or
    `--max-copy-bytes`, Phase 1 review W2); `--apply` aborts rather than growing an unbounded copy.
    """


class SourceOutputOverlapError(RuntimeError):
    """`--source` and `--output` overlap by realpath (Phase 1 review B1): one equals, is inside, or
    contains the other. Checked BEFORE `--output` is created — a chained `--apply` pointing
    `--output` back inside its own `--source` (or vice versa) must never be allowed to start a
    self-referential copy."""


class SourceChangedDuringCopyError(RuntimeError):
    """`--output`'s copied canonical streams do not hash-match `--source`'s streams as hashed
    BEFORE the copy started (Phase 1 review W4): `--source` changed while this run was reading it.
    """


class SymlinkEscapeError(RuntimeError):
    """A canonical state-root path is a symlink resolving outside the state root."""


class NotARegularFileError(RuntimeError):
    """A file opened for hashing or copying (Phase 1 review B3) turned out, via `fstat` immediately
    after `open(..., O_NOFOLLOW|O_NONBLOCK)`, not to be a regular file — a FIFO, device, socket, or
    (on a platform without `O_NOFOLLOW`) a symlink that slipped past the lstat scan via a TOCTOU
    race. Never silently read; the caller decides how to report it."""


class UnsafeSourceTreeError(RuntimeError):
    """`--source` contains a symlink or special file somewhere in its tree; `--apply` refuses to
    copy it (never silently skipped or followed). Carries every unsafe entry found."""

    def __init__(self, unsafe: list[tuple[str, str]]):
        self.unsafe = unsafe
        shown = '; '.join(f'{rel} ({kind})' for rel, kind in unsafe[:20])
        more = '' if len(unsafe) <= 20 else f' (and {len(unsafe) - 20} more)'
        super().__init__(f'{len(unsafe)} unsafe entr{"y" if len(unsafe) == 1 else "ies"} in the '
                        f'source tree: {shown}{more}')


class OutputStreamHazardError(RuntimeError):
    """A stream copied into `--output` has a line the shared readers this script never modifies
    (`orchestrator.record_batch.write_batch`'s `RecordIndex`, `orchestrator.state.rebuild`'s ledger
    replay) would crash on or read unbounded. Carries the hazard counts per stream."""

    def __init__(self, hazards: dict[str, dict[str, int]]):
        self.hazards = hazards
        shown = '; '.join(f'{stream}: {counts}' for stream, counts in hazards.items())
        super().__init__(shown)


# --- production guard (Phase 1 review S2/F-round-3) ---------------------------------------------

#: The conventional production root, checked literally regardless of environment: the guard is
#: about the caller's intent toward THIS specific well-known directory, not about whatever
#: `CODING_AGENT_ORCHESTRATOR_HOME` happens to be set to right now.
CONVENTIONAL_PRODUCTION_ROOT = (Path.home() / '.local' / 'state' / 'coding-agent-orchestrator').expanduser()

# Mirrors `CAPABILITY_AGENT_ALIASES` / `roleForAgentName` in
# `bridge/extensions/orchestrator/index.ts`. Kept as a small, explicitly-labelled duplicate here
# (a script, not a runtime module) rather than importing TypeScript; if the bridge's alias table
# changes, update both. Several capabilities share one persona (all lead sizes ->
# "orchestrator-lead"; four review capabilities -> "orch-technical-review"); this mirrors the
# bridge's own last-one-wins resolution for the same reason documented there: it is a cosmetic
# label choice, not a correctness gap, because `economics.py`'s coordination/verification buckets
# key off role name suffixes and treat every alias in a collision identically.
_AGENT_NAME_TO_ROLE = {
    'orchestrator-lead': 'lead_large',
    'orch-technical-lead': 'analysis_mid',
    'orch-architect': 'analysis_strong',
    'orch-technical-review': 'api_contract_review',
}


def role_for_agent_name(agent: str | None) -> str:
    if not agent:
        return 'unknown'
    if agent in _AGENT_NAME_TO_ROLE:
        return _AGENT_NAME_TO_ROLE[agent]
    if agent.startswith('orch-') and len(agent) > len('orch-'):
        return agent[len('orch-'):].replace('-', '_')
    return 'unknown'


# --- bounded, provenance-preserving JSONL reading (Phase 1 review S5) ---------------------------

def _parse_physical_line(stripped: bytes) -> tuple[dict[str, Any] | None, str | None]:
    """`(record_or_None, skip_reason_or_None)` for one already-newline-stripped physical line's
    bytes: blank -> `(None, None)`; deeply nested JSON -> `(None, 'deep_nesting')` (catches
    `RecursionError`, the json module's own recursive descent); malformed JSON/invalid UTF-8 ->
    `(None, 'malformed_json')`; a non-object JSON value -> `(None, 'not_object')`; otherwise the
    parsed dict. Shared by `iter_physical_jsonl` and `_iter_physical_jsonl_from_handle` so both
    readers classify a line identically.
    """
    if not stripped.strip():
        return None, None
    try:
        record = json.loads(stripped)
    except RecursionError:
        return None, 'deep_nesting'
    except (ValueError, UnicodeDecodeError):
        return None, 'malformed_json'
    if not isinstance(record, dict):
        return None, 'not_object'
    return record, None


def iter_physical_jsonl(path: Path, *, max_line_bytes: int = MAX_LINE_BYTES,
                        include_final_unterminated: bool = False
                        ) -> Iterator[tuple[int, dict[str, Any] | None, str | None]]:
    """Yield `(line_no, record_or_None, skip_reason_or_None)` for every PHYSICAL line of `path`.

    `line_no` is 1-based and counts every line — blank, malformed, oversized — so a caller's
    provenance (`backfill_source_line`) always names the real line in the file, never the index of
    the Nth successfully-parsed record. Bounded: a line longer than `max_line_bytes` is never read
    in full (`skip_reason='oversized_line'`), just drained so line counting stays correct for what
    follows. Never raises: malformed JSON, invalid UTF-8, and pathologically deep nesting
    (`RecursionError`, the json module's own recursive descent) are all caught and reported per
    line instead of aborting the whole file.

    A final line with no trailing newline (torn/in-progress write) is NOT yielded by default,
    matching `orchestrator.runtime.iter_jsonl_from`'s replayable-prefix contract — most callers of
    this reader (existing-coverage indexing, dispatch-event grouping) intentionally mirror that
    same "only a complete, replayable prefix counts" rule. Pass `include_final_unterminated=True`
    (Phase 1 review W1) to ALSO parse that trailing line: `orchestrator.record_index.RecordIndex.
    _scan` does exactly this (it does not skip a torn tail), so the OUTPUT pre-scan
    (`prescan_output_streams`) must examine it too, or a hazard hiding only in an unterminated
    final line — a `RecursionError` `_scan` itself does not catch — would sail through undetected
    and crash `write_batch`'s `RecordIndex` rebuild later.
    """
    if not path.exists():
        return
    cap = max_line_bytes + 1
    with path.open('rb') as f:
        line_no = 0
        while True:
            chunk = f.readline(cap)
            if not chunk:
                return
            line_no += 1
            if len(chunk) > max_line_bytes:
                # Oversized: drain the rest of this physical line without ever holding it whole.
                while chunk and not chunk.endswith(b'\n'):
                    chunk = f.readline(cap)
                yield line_no, None, 'oversized_line'
                continue
            if not chunk.endswith(b'\n'):
                if include_final_unterminated:
                    record, reason = _parse_physical_line(chunk)
                    yield line_no, record, reason
                return  # torn/in-progress trailing line
            record, reason = _parse_physical_line(chunk[:-1])
            yield line_no, record, reason


# --- symlink-escape guard (Phase 1 review S1) ----------------------------------------------------

def _realpath(path: Path) -> Path:
    return Path(os.path.realpath(path))


def reject_symlink_escape(state_root: Path) -> None:
    """Refuse a state root whose canonical streams/index/lock/`runs/` escape it via a symlink.

    Checked eagerly, once, for the small set of well-known top-level paths this script itself
    reads or writes: `metrics.jsonl`, `events.jsonl`, the record-id index checkpoint, the writer
    lock file, and the `runs/` directory itself. Individual run directories/logs INSIDE `runs/`
    are checked lazily, per access, by `safe_run_log_path` (S4) — walking every file in a
    potentially 1.5 GB `runs/` tree eagerly here would be its own resource-exhaustion risk. A
    symlinked ANCESTOR of the state root itself would already have been resolved by
    `Path.resolve()` when `state_root` was built, so a mismatch here always means one of these
    specific entries, not the root itself.
    """
    from orchestrator.runtime import RECORD_INDEX_FILE, WRITER_LOCK_FILE
    root_real = _realpath(state_root)
    for label, rel in (('metrics.jsonl', 'metrics.jsonl'), ('events.jsonl', 'events.jsonl'),
                       (RECORD_INDEX_FILE, RECORD_INDEX_FILE), (WRITER_LOCK_FILE, WRITER_LOCK_FILE),
                       ('runs/', 'runs')):
        path = state_root / rel
        if not path.exists() and not path.is_symlink():
            continue
        real = _realpath(path)
        try:
            real.relative_to(root_real)
        except ValueError:
            raise SymlinkEscapeError(
                f'{label} ({path}) resolves outside the state root ({root_real}): -> {real}. '
                'Refusing to read or write a state root with a symlink escape.') from None


# --- run-id / run-log path safety (Phase 1 review S4) --------------------------------------------

#: A run id must be exactly one path component: no `/`, no leading `.` (blocks `.`/`..` and hidden
#: names), alphanumeric-first, then alnum/`.`/`_`/`-`. Matches the bridge's own run id shape
#: (`ht-orch-<timestamp>-<rand>`) without hardcoding it — any single safe component is accepted.
RUN_ID_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$')


def valid_run_id(run_id: Any) -> bool:
    if not isinstance(run_id, str) or not run_id:
        return False
    if '/' in run_id or '\\' in run_id or '\x00' in run_id:
        return False
    return bool(RUN_ID_PATTERN.match(run_id))


def safe_run_log_path(runs_dir: Path, run_id: str, safe_task_id: str) -> tuple[Path | None, str | None]:
    """Resolve `runs/<run_id>/<safe_task_id>.events.jsonl` without ever following a symlink.

    Returns `(path, None)` when the log exists and is safe to open, `(None, reason)` otherwise —
    `reason` is `None` specifically for "the log just doesn't exist" (not an error, handled by the
    caller as `no_evidence`), and a string for every unsafe case: an untrusted/traversal-shaped run
    id, a symlinked run directory or log file, or a resolved path that escapes `runs/` entirely.
    """
    if not valid_run_id(run_id):
        return None, 'invalid_run_id'
    if not runs_dir.exists():
        return None, None
    runs_dir_real = _realpath(runs_dir)
    run_dir = runs_dir / run_id
    if run_dir.is_symlink():
        return None, 'symlinked_run_dir'
    log_path = run_dir / f'{safe_task_id}.events.jsonl'
    if log_path.is_symlink():
        return None, 'symlinked_run_log'
    if not log_path.exists():
        return None, None
    try:
        resolved = log_path.resolve(strict=True)
    except OSError:
        return None, 'unresolvable_run_log'
    try:
        resolved.relative_to(runs_dir_real)
    except ValueError:
        return None, 'run_log_escapes_runs_dir'
    return log_path, None


def _open_no_follow(path: Path):
    """Open for reading, refusing to follow a symlink at the final path component (belt-and-
    suspenders on top of `safe_run_log_path`'s lstat checks — closes the TOCTOU window between
    that check and this open)."""
    flags = os.O_RDONLY
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    return os.fdopen(fd, 'rb')


def _open_regular_nofollow(path: Path):
    """Open `path` for reading with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, `fstat`-verify `S_ISREG`, and
    return a normal buffered binary file object (Phase 1 review B3).

    Used for every `--source` file this script reads for HASHING or COPYING (never for the run
    event logs `replay_nested_calls` reads — those use `_open_no_follow` above): `O_NOFOLLOW`
    refuses a symlink at the final path component (defense in depth on top of `scan_source_tree`'s
    lstat scan, which already ran and aborted on any unsafe entry BEFORE this is ever called —
    closing the TOCTOU window between that check and this open); `O_NONBLOCK` makes opening a FIFO
    for reading return immediately instead of blocking forever waiting for a writer that will never
    come (a FIFO in `--source` must be rejected FAST, never hang the whole run); the `fstat`
    immediately after open confirms what actually got opened is `S_ISREG` — never a FIFO, device,
    socket, or (on a platform without `O_NOFOLLOW`) a symlink that slipped through. Raises
    `NotARegularFileError` for anything that fails the `S_ISREG` check, and ordinary `OSError` for
    an open failure — never blocks, never silently reads a non-regular stream. `O_NONBLOCK` is
    cleared again once the `fstat` confirms a plain regular file, so the returned handle's actual
    reads behave exactly like a normal blocking `open()`.
    """
    flags = os.O_RDONLY | os.O_NONBLOCK
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise NotARegularFileError(f'{path} is not a regular file (mode={oct(st.st_mode)})')
        os.set_blocking(fd, True)
    except Exception:
        os.close(fd)
        raise
    return os.fdopen(fd, 'rb')


# --- dispatch_attempt validation (Phase 1 review F4) ----------------------------------------------

def _valid_dispatch_attempt(value: Any) -> int | None:
    """`value` as a validated `dispatch_attempt`: a finite, integral number in `[0, 16]`, or `None`
    for anything else — Infinity/NaN, a non-integral float (`1.5`), a string, a bool, or an
    out-of-range value. Malformed data must read as "cannot be trusted as a distinct identity",
    never crash (a bare `int(float('inf'))` raises `OverflowError`) and never masquerade as
    provably distinct from another malformed value. Mirrors `orchestrator.economics`'s
    `_valid_dispatch_attempt` exactly — keep both updated together. 16 is generously above any real
    fallback depth (attempt is 0 or 1 today); the cap exists only so a corrupted or hostile value
    is never trusted as a distinct attempt.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return None
        value = int(value)
    if not (0 <= value <= 16):
        return None
    return value


# --- replaying one dispatch's raw event log -------------------------------------------------------

def _results_of(event: dict) -> list[dict] | None:
    if event.get('type') == 'tool_execution_update':
        payload = event.get('partialResult')
    elif event.get('type') == 'tool_execution_end':
        payload = event.get('result')
    else:
        return None
    if not isinstance(payload, dict):
        return None
    details = payload.get('details')
    if not isinstance(details, dict):
        return None
    results = details.get('results')
    return results if isinstance(results, list) else None


def _number_or_none(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _finite_nonneg_or_none(value: Any) -> float | None:
    """A finite, non-negative number, or `None` — inf/nan/negative are unknown, never zero."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(amount) or amount < 0:
        return None
    return amount


def replay_nested_calls(path: Path, *, skip_counts: dict[str, int] | None = None,
                        max_entries: int = MAX_RETAINED_RECORDS) -> dict[str, dict]:
    """Replay one dispatch's raw event log the same way `NestedCostTracker.observe` does.

    Latest observation per `(toolCallId, taskId, attempt)` key wins — cumulative `tool_execution_
    update` snapshots are not double-counted, matching the live tracker exactly. A later
    observation that carries no valid cost NEVER erases an earlier valid one (Phase 1 review
    T5/F2): the last VALID cost (and the `costReported` it earned) is preserved across any later
    observation reporting none of its own, while every other field (model, exitCode, stopReason,
    `source_line`, …) still refreshes to the latest observation unconditionally — exactly
    `NestedCostTracker.observe`'s own merge rule (`bridge/extensions/orchestrator/nested-cost.ts`).

    Returns `{key: {..detail.., 'source_line': int}}`; `source_line` is the 1-based PHYSICAL line in
    `path` where that key's FINAL kept state was observed (via `iter_physical_jsonl`, so it is never
    off by the count of blank/malformed lines skipped along the way). A malformed/oversized line is
    skipped and tallied into `skip_counts` (when given) rather than aborting the replay.

    Bounded (Phase 1 review F3): the cap is enforced BEFORE a brand-new key is ever inserted into
    `latest` — a key already tracked keeps being refreshed (an existing entry never counts against
    the cap again), but the `max_entries`th *distinct* key raises `PlanTooLargeError` rather than
    silently growing this one dispatch's replay without bound.
    """
    latest: dict[str, dict] = {}
    counts = skip_counts if skip_counts is not None else defaultdict(int)
    try:
        handle = _open_no_follow(path)
    except OSError:
        counts['symlinked_run_log'] += 1
        return latest
    try:
        for line_no, event, reason in _iter_physical_jsonl_from_handle(handle):
            if reason:
                counts[reason] += 1
                continue
            if event is None or event.get('toolName') != 'subagent':
                continue
            results = _results_of(event)
            if results is None:
                continue
            call_id = event.get('toolCallId') if isinstance(event.get('toolCallId'), str) else '?'
            for index, result in enumerate(results):
                if not isinstance(result, dict):
                    continue
                task_id = (result.get('taskId') if isinstance(result.get('taskId'), str) and result.get('taskId')
                          else str(index))
                attempt = (result.get('attempt') if isinstance(result.get('attempt'), (int, float))
                          and not isinstance(result.get('attempt'), bool) else 0)
                key = f'{call_id}:{task_id}:{attempt}'
                if key not in latest and len(latest) >= max_entries:
                    raise PlanTooLargeError(
                        f'{path} has more than max_entries ({max_entries}) distinct nested-call keys; '
                        'aborting rather than growing an unbounded replay in memory.')
                usage = result.get('usage') if isinstance(result.get('usage'), dict) else {}
                cost = _finite_nonneg_or_none(usage.get('cost'))
                cost_reported = cost is not None
                next_entry = {
                    'key': key, 'toolCallId': call_id, 'taskId': task_id, 'attempt': result.get('attempt'),
                    'agent': result.get('agent') if isinstance(result.get('agent'), str) else None,
                    'model': result.get('model') if isinstance(result.get('model'), str) else None,
                    'depth': result.get('depth') if isinstance(result.get('depth'), (int, float)) and not isinstance(result.get('depth'), bool) else None,
                    'exitCode': result.get('exitCode') if isinstance(result.get('exitCode'), (int, float)) and not isinstance(result.get('exitCode'), bool) else None,
                    'stopReason': result.get('stopReason') if isinstance(result.get('stopReason'), str) else None,
                    'parentTaskId': result.get('parentTaskId') if isinstance(result.get('parentTaskId'), str) else None,
                    'usage': {
                        'input': _number_or_none(usage.get('input')), 'output': _number_or_none(usage.get('output')),
                        'cacheRead': _number_or_none(usage.get('cacheRead')), 'cacheWrite': _number_or_none(usage.get('cacheWrite')),
                        'cost': cost,
                    },
                    'costReported': cost_reported,
                    'source_line': line_no,
                }
                prev_entry = latest.get(key)
                if next_entry['usage']['cost'] is None and prev_entry is not None:
                    # T5/F2: the last VALID cost wins, never merely the last observation.
                    next_entry = {
                        **next_entry,
                        'usage': {**next_entry['usage'], 'cost': prev_entry['usage']['cost']},
                        'costReported': next_entry['costReported'] or prev_entry['costReported'],
                    }
                latest[key] = next_entry
    finally:
        handle.close()
    return latest


def _iter_physical_jsonl_from_handle(handle, *, max_line_bytes: int = MAX_LINE_BYTES
                                     ) -> Iterator[tuple[int, dict[str, Any] | None, str | None]]:
    """Same contract as `iter_physical_jsonl` (default, no `include_final_unterminated`), over an
    already-open binary file object."""
    cap = max_line_bytes + 1
    line_no = 0
    while True:
        chunk = handle.readline(cap)
        if not chunk:
            return
        line_no += 1
        if len(chunk) > max_line_bytes:
            while chunk and not chunk.endswith(b'\n'):
                chunk = handle.readline(cap)
            yield line_no, None, 'oversized_line'
            continue
        if not chunk.endswith(b'\n'):
            return
        record, reason = _parse_physical_line(chunk[:-1])
        yield line_no, record, reason


def build_detail_rows(*, run_id: str, parent_task_id: str, dispatch_depth: int, dispatch_attempt: int,
                      entries: dict[str, dict], source_file: str, backfill_evidence: str) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for entry in entries.values():
        role = role_for_agent_name(entry['agent'])
        model = entry['model'] or 'unknown'
        provider = model.split('/')[0] if '/' in model else 'unknown'
        depth = entry['depth'] if entry['depth'] is not None else dispatch_depth + 1
        usage = entry['usage']
        row: dict[str, Any] = {
            'event': 'model_call', 'run_id': run_id, 'task_id': f'{parent_task_id}:{entry["taskId"]}',
            'parent_task_id': parent_task_id, 'role': role, 'capability_class': role,
            'agent_runtime': 'humain-terminal', 'provider': provider, 'model': model,
            'input_tokens': (usage['input'] or 0) + (usage['cacheRead'] or 0),
            'cached_input_tokens': usage['cacheRead'] or 0, 'cache_write_tokens': usage['cacheWrite'] or 0,
            'output_tokens': usage['output'] or 0,
            'result': 'pass' if entry['exitCode'] == 0 else 'fail',
            'nested': True, 'nesting_depth': depth, 'nested_call_id': entry['key'],
            # Explicit, always stamped (never omitted at the default 0), matching the bridge's own
            # `nestedModelCallRowsFor` row shape byte-for-byte — see the module docstring.
            'dispatch_attempt': dispatch_attempt,
            'backfilled': True, 'backfill_version': BACKFILL_VERSION, 'backfill_evidence': backfill_evidence,
            'backfill_source_file': source_file, 'backfill_source_line': entry['source_line'],
            'ts': now,
            'record_id': f'nested:{run_id}:{parent_task_id}:{dispatch_attempt}:{entry["key"]}',
        }
        if entry['costReported']:
            row['cost_usd'] = usage['cost']
            row['cost_source'] = 'reported'
        if entry['stopReason']:
            row['stop_reason'] = entry['stopReason']
        if entry['attempt'] is not None:
            row['attempt'] = entry['attempt']
        rows.append(row)
    return rows


# --- existing-coverage index (Phase 1 review R4) -------------------------------------------------

def _record_id_nested_key(record_id: str) -> tuple[str, str] | None:
    """`(run_id, parent_task_id)` from a `nested:{run_id}:{parent_task_id}:...` record_id, else None.

    `maxsplit=3` deliberately stops after the third colon: everything after it (the dispatch-attempt
    tag and the nested call's own `toolCallId:taskId:attempt` key) can itself contain colons, and
    only the first two segments are ever needed to identify the run/parent.
    """
    if not record_id.startswith('nested:'):
        return None
    parts = record_id.split(':', 3)
    if len(parts) < 4 or not parts[1] or not parts[2]:
        return None
    return (parts[1], parts[2])


def existing_nested_coverage(metrics_path: Path, *, skip_counts: dict[str, int],
                             cap: int = MAX_RETAINED_RECORDS) -> set[tuple[str, str]]:
    """`(run_id, parent_task_id)` pairs `metrics.jsonl` already has SOME nested detail for.

    Matches either shape a durable row can carry: an explicit `nested: true` flag alongside
    `run_id`/`parent_task_id`, or (defensively, for a row that for any reason lacks those fields) a
    `record_id` with the `nested:{run_id}:{parent_task_id}:` prefix. Any such row — from the live
    bridge, a prior run of this script, or a partial write the live bridge's own claim
    (`nested_rows_emitted`) cannot be trusted to fully describe — means this run/parent's nested
    work is not this script's to book: see the module docstring's "Existing coverage first" rule.
    This is also what makes a repeat `--apply` against a previous run's own `--output` idempotent.
    """
    covered: set[tuple[str, str]] = set()
    for _line_no, row, reason in iter_physical_jsonl(metrics_path):
        if reason:
            if reason == 'oversized_line':
                skip_counts['oversized_lines_metrics'] += 1
            continue
        if row is None:
            continue
        key: tuple[str, str] | None = None
        run_id, parent = row.get('run_id'), row.get('parent_task_id')
        nested_flag = row.get('nested') is True or str(row.get('nested')).strip().lower() == 'true'
        if isinstance(run_id, str) and isinstance(parent, str) and nested_flag:
            key = (run_id, parent)
        else:
            rid = row.get('record_id')
            if isinstance(rid, str):
                key = _record_id_nested_key(rid)
        if key is not None:
            if key not in covered:
                # W3: the cap is enforced BEFORE a new key is ever inserted, never after — a key
                # already tracked keeps being idempotently re-added at zero marginal cost.
                if len(covered) >= cap:
                    raise PlanTooLargeError(
                        f'existing-coverage index built from {metrics_path} exceeds '
                        f'MAX_RETAINED_RECORDS ({cap}); aborting rather than growing an unbounded '
                        'plan in memory.')
                covered.add(key)
    return covered


# --- planning --------------------------------------------------------------------------------------

def _aggregate_info(event: dict) -> tuple[bool, float | None]:
    """`(present, value)` for `dispatch_finished.nested_cost_usd`.

    `present=False` means the key is absent or null: pre-tracking, nothing to reconcile against.
    `present=True, value=None` means the key IS present but is not a finite, non-negative number
    (inf/nan/negative/non-numeric) — an unusable aggregate, never treated as "no aggregate".
    """
    if 'nested_cost_usd' not in event or event.get('nested_cost_usd') is None:
        return False, None
    return True, _finite_nonneg_or_none(event.get('nested_cost_usd'))


def _dispatch_attempt_field(event: dict) -> int | None:
    """The event's own explicit, VALIDATED `dispatch_attempt`, or `None` when the field is absent
    or malformed (Infinity/NaN, a non-integral float, a string, a bool, or a value outside
    `[0, 16]` — Phase 1 review F4). Malformed data must read as "cannot tell these apart", never
    crash and never be trusted as a distinct identity.
    """
    if 'dispatch_attempt' not in event:
        return None
    return _valid_dispatch_attempt(event.get('dispatch_attempt'))


def _dispatch_attempt_default_zero(event: dict) -> int:
    """The attempt identity to key reconciliation on: absent/malformed reads as 0 (see docstring)."""
    value = _dispatch_attempt_field(event)
    return value if value is not None else 0


def _group_dispatch_finished_events(events_path: Path, *, cap: int,
                                    max_events_per_group: int = MAX_EVENTS_PER_GROUP,
                                    max_total_events: int | None = None
                                    ) -> tuple[dict[tuple[str, str], list[tuple[int, dict]]],
                                              dict[tuple[str, str], int], dict[str, int]]:
    """Group `dispatch_finished` events by `(run_id, task_id)`, bounded three independent ways
    (Phase 1 review F3), each cap enforced BEFORE the record it would gate is ever inserted:

    - At most `cap` DISTINCT `(run_id, task_id)` keys are tracked at all (checked before a new key
      is added to `groups`); exceeding it raises `PlanTooLargeError`.
    - At most `max_events_per_group` events are RETAINED per key; once a key hits that cap, further
      events for the SAME key are not appended to its list but still counted in `overflow` — a
      bounded summary (a count) rather than an unbounded list. `max_events_per_group` is generously
      above the real maximum (2), so a legitimate two-attempt pair is never affected; only a
      hostile/corrupt file with many events sharing one key is.
    - At most `max_total_events` events are retained ACROSS ALL groups combined (checked before an
      event is appended to any group's list); exceeding it raises `PlanTooLargeError` rather than
      growing total memory use without bound even when no single group is individually huge.

    Returns `(groups, overflow, skip_counts)`; `overflow[key]` is the count of events for `key`
    beyond `max_events_per_group`, absent (via `.get(key, 0)`) for a key that never overflowed.
    """
    max_total_events = cap if max_total_events is None else max_total_events
    groups: dict[tuple[str, str], list[tuple[int, dict]]] = {}
    overflow: dict[tuple[str, str], int] = {}
    skip_counts: dict[str, int] = defaultdict(int)
    total_retained = 0
    for line_no, event, reason in iter_physical_jsonl(events_path):
        if reason:
            if reason == 'oversized_line':
                skip_counts['oversized_lines_events'] += 1
            continue
        if event is None or event.get('event') != 'dispatch_finished':
            continue
        run_id, task_id = event.get('run_id'), event.get('task_id')
        if not isinstance(run_id, str) or not isinstance(task_id, str):
            continue
        key = (run_id, task_id)
        existing = groups.get(key)
        if existing is None:
            if len(groups) >= cap:
                raise PlanTooLargeError(
                    f'{events_path} has more than MAX_RETAINED_RECORDS ({cap}) distinct dispatch '
                    '(run_id, task_id) pairs; aborting rather than growing an unbounded plan in memory.')
            existing = []
            groups[key] = existing
        if len(existing) >= max_events_per_group:
            overflow[key] = overflow.get(key, 0) + 1
            continue
        if total_retained >= max_total_events:
            raise PlanTooLargeError(
                f'{events_path} has more than {max_total_events} total dispatch_finished events '
                'retained across all groups; aborting rather than growing an unbounded plan in memory.')
        existing.append((line_no, event))
        total_retained += 1
    return groups, overflow, skip_counts


def _separate_attempts(group: list[tuple[int, dict]]) -> list[tuple[int, int, dict]] | None:
    """Split a `(run_id, task_id)` group's events into provably-separate `(line_no, attempt, event)`
    units, or `None` when they cannot be told apart (old-bug cumulative sum candidate — see the
    module docstring's "Old-bug cumulative sums" section)."""
    if len(group) == 1:
        line_no, event = group[0]
        return [(line_no, _dispatch_attempt_default_zero(event), event)]
    if len(group) > 2:
        return None  # more attempts than the fallback design ever produces: not provable
    attempts = [_dispatch_attempt_field(event) for _line_no, event in group]
    if any(a is None for a in attempts) or len(set(attempts)) != len(attempts):
        return None
    return [(line_no, attempt, event) for (line_no, event), attempt in zip(group, attempts)]


def _extend_rows_checked(rows_to_add: list[dict], rows: list[dict], *, cap: int) -> None:
    """`rows_to_add.extend(rows)`, but the cap is checked BEFORE the extend happens (Phase 1 review
    W3), never after - a plan that would exceed `MAX_RETAINED_RECORDS` never actually holds the
    over-cap rows in memory even momentarily."""
    if len(rows_to_add) + len(rows) > cap:
        raise PlanTooLargeError(
            f'planned rows_to_add would exceed MAX_RETAINED_RECORDS ({cap}); aborting rather than '
            'growing an unbounded plan in memory.')
    rows_to_add.extend(rows)


def plan_backfill(state_root: Path) -> dict[str, Any]:
    """Scan `state_root` and return the plan: rows to add, per dispatch attempt, and why any were
    skipped. Never writes. Raises `PlanTooLargeError` (never partially plans) if the state root
    would make this script retain more than the configured caps allow."""
    reject_symlink_escape(state_root)

    events_path = state_root / 'events.jsonl'
    groups, overflow, skip_counts = _group_dispatch_finished_events(
        events_path, cap=MAX_RETAINED_RECORDS, max_events_per_group=MAX_EVENTS_PER_GROUP,
        max_total_events=MAX_RETAINED_RECORDS)

    covered = existing_nested_coverage(state_root / 'metrics.jsonl', skip_counts=skip_counts,
                                       cap=MAX_RETAINED_RECORDS)

    runs_dir = state_root / 'runs'
    rows_to_add: list[dict] = []
    reconciled: list[dict[str, Any]] = []       # per-call, matched a usable aggregate
    unverifiable_total: list[dict[str, Any]] = []  # per-call, no aggregate existed to check against
    ambiguous: list[dict[str, Any]] = []
    no_evidence: list[dict[str, Any]] = []
    already_covered: list[dict[str, Any]] = []
    skipped_unsafe: list[dict[str, Any]] = []

    for (run_id, task_id), group in sorted(groups.items()):
        group_overflow = overflow.get((run_id, task_id), 0)
        units = None if group_overflow else _separate_attempts(group)
        if units is None:
            total_events = len(group) + group_overflow
            reason = (f'{len(group)} dispatch_finished events share (run_id, task_id) without '
                     'a provable, pairwise-distinct dispatch_attempt on every one of them — this '
                     'is exactly the shape a pre-fix quota-fallback cumulative-sum bug produces '
                     '(the second event summing both attempts), and it cannot be separated back '
                     'into independent attempts from the event stream alone; nothing booked.')
            if group_overflow:
                reason += (f' {group_overflow} further dispatch_finished event(s) sharing this same '
                          'key were beyond the per-group retention cap and were collapsed into this '
                          'bounded summary rather than held in memory (Phase 1 review F3).')
            ambiguous.append({
                'run_id': run_id, 'task_id': task_id, 'events': total_events,
                'line_nos': [ln for ln, _ in group],
                'reason': reason,
            })
            continue

        for line_no, attempt, event in units:
            if (run_id, task_id) in covered:
                already_covered.append({'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt,
                                        'events_line': line_no,
                                        'reason': 'metrics.jsonl already has nested detail for this run/parent'})
                continue

            # The bridge's codex -> Bedrock fallback retry (attempt 1) writes its diagnostic log
            # under `${taskId}-fallback.events.jsonl`, a DIFFERENT file from attempt 0's own
            # `${taskId}.events.jsonl` (`bridge/extensions/orchestrator/index.ts`'s `dispatchParallel`
            # calls `runOn(twin, \`${input._taskId}-fallback\`, ...)` for the retry) — never the same
            # file two attempts' logs could be conflated by reading.
            raw_log_task_id = task_id if attempt == 0 else f'{task_id}-fallback'
            safe_task_id = ''.join(c if (c.isalnum() or c in '._-') else '_' for c in raw_log_task_id)
            log_path, unsafe_reason = safe_run_log_path(runs_dir, run_id, safe_task_id)
            if unsafe_reason is not None:
                skipped_unsafe.append({'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt,
                                       'events_line': line_no, 'reason': unsafe_reason})
                continue
            if log_path is None:
                no_evidence.append({'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt,
                                    'events_line': line_no,
                                    'reason': f'no run log at runs/{run_id}/{safe_task_id}.events.jsonl'})
                continue

            entries = replay_nested_calls(log_path, skip_counts=skip_counts, max_entries=MAX_RETAINED_RECORDS)
            if not entries:
                no_evidence.append({'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt,
                                    'events_line': line_no,
                                    'reason': f'no subagent tool events found in {log_path}'})
                continue

            aggregate_present, aggregate_value = _aggregate_info(event)
            detail_sum = sum(e['usage']['cost'] for e in entries.values() if e['costReported'])

            if aggregate_present and aggregate_value is None:
                ambiguous.append({
                    'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt, 'events_line': line_no,
                    'entries': len(entries), 'detail_sum_usd': detail_sum,
                    'reason': (f'dispatch_finished.nested_cost_usd={event.get("nested_cost_usd")!r} is not a '
                               'finite, non-negative number; the aggregate is unusable for reconciliation, '
                               'nothing booked'),
                })
                continue

            source_file = str(log_path.relative_to(state_root))

            if not aggregate_present:
                rows = build_detail_rows(run_id=run_id, parent_task_id=task_id, dispatch_depth=0,
                                         dispatch_attempt=attempt, entries=entries, source_file=source_file,
                                         backfill_evidence='event_log_only_no_aggregate')
                _extend_rows_checked(rows_to_add, rows, cap=MAX_RETAINED_RECORDS)
                unverifiable_total.append({'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt,
                                           'events_line': line_no, 'detail_sum_usd': detail_sum, 'rows': len(rows)})
            else:
                tolerance = max(COST_TOLERANCE_ABS, COST_TOLERANCE_REL * aggregate_value)
                gap = abs(detail_sum - aggregate_value)
                if gap <= tolerance:
                    rows = build_detail_rows(run_id=run_id, parent_task_id=task_id, dispatch_depth=0,
                                             dispatch_attempt=attempt, entries=entries, source_file=source_file,
                                             backfill_evidence='reconciled_with_aggregate')
                    _extend_rows_checked(rows_to_add, rows, cap=MAX_RETAINED_RECORDS)
                    reconciled.append({'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt,
                                       'events_line': line_no, 'aggregate_usd': aggregate_value,
                                       'detail_sum_usd': detail_sum, 'rows': len(rows)})
                else:
                    ambiguous.append({
                        'run_id': run_id, 'task_id': task_id, 'dispatch_attempt': attempt, 'events_line': line_no,
                        'aggregate_usd': aggregate_value, 'detail_sum_usd': detail_sum, 'entries': len(entries),
                        'reason': (f'reconstructed per-task sum ${detail_sum:.4f} does not reconcile with '
                                   f'dispatch_finished.nested_cost_usd=${aggregate_value:.4f}; non-overlap is '
                                   'not provable from the log alone, so nothing is booked for this attempt'),
                    })

    return {
        'rows_to_add': rows_to_add, 'reconciled': reconciled, 'unverifiable_total': unverifiable_total,
        'ambiguous': ambiguous, 'no_evidence': no_evidence, 'already_covered': already_covered,
        'skipped_unsafe': skipped_unsafe, 'skip_counts': dict(skip_counts),
    }


def _print_plan(plan: dict[str, Any]) -> None:
    unverifiable_total_usd = sum(i['detail_sum_usd'] for i in plan['unverifiable_total'])
    print(f'per-call reconciled (matched an aggregate): {len(plan["reconciled"])} dispatch(es), '
         f'{sum(i["rows"] for i in plan["reconciled"])} row(s)')
    print(f'event-log-only recovered (no aggregate to verify against — "unverifiable total"): '
         f'{len(plan["unverifiable_total"])} dispatch(es), {sum(i["rows"] for i in plan["unverifiable_total"])} '
         f'row(s), ${unverifiable_total_usd:.4f} of known per-task cost with no independent total to check it '
         'against')
    print(f'ambiguous (skipped, unprovable):        {len(plan["ambiguous"])}')
    print(f'already covered (skipped, overlap):     {len(plan["already_covered"])}')
    print(f'no log evidence (informational):        {len(plan["no_evidence"])}')
    print(f'skipped (unsafe run id/path/symlink):    {len(plan["skipped_unsafe"])}')
    if plan['skip_counts']:
        print(f'lines skipped while scanning (oversized/malformed/deep-nesting): {plan["skip_counts"]}')
    if plan['ambiguous']:
        print('\nambiguous (not booked; reconciled dynamically as before):')
        for item in plan['ambiguous'][:20]:
            print(f'  - {item["run_id"]}/{item["task_id"]} attempt={item.get("dispatch_attempt")}: {item["reason"]}')
        if len(plan['ambiguous']) > 20:
            print(f'  ... and {len(plan["ambiguous"]) - 20} more')
    if plan['skipped_unsafe']:
        print('\nskipped as unsafe:')
        for item in plan['skipped_unsafe'][:20]:
            print(f'  - {item["run_id"]}/{item["task_id"]} attempt={item.get("dispatch_attempt")}: {item["reason"]}')


# --- production guard (Phase 1 review S2/F-round-3) ------------------------------------------------

def _protected_production_roots() -> list[Path]:
    """Realpaths of both roots `--apply` must never target, contain, or be contained by — the
    conventional default AND whatever `orchestrator.runtime.default_state_root()` resolves to right
    now (which honours `CODING_AGENT_ORCHESTRATOR_HOME`). There is no override.
    """
    return [_realpath(CONVENTIONAL_PRODUCTION_ROOT), _realpath(default_state_root())]


def _contains_or_equal(a: Path, b: Path) -> bool:
    """`True` iff `a == b`, `a` is inside `b`, or `b` is inside `a` — a bidirectional containment
    check so a caller pointing `--output` (or `--source`) AT an ancestor of the protected root is
    caught exactly as surely as pointing it INSIDE the protected root would be."""
    if a == b:
        return True
    try:
        a.relative_to(b)
        return True
    except ValueError:
        pass
    try:
        b.relative_to(a)
        return True
    except ValueError:
        return False


def refused_protected_root(source: Path, output: Path) -> tuple[str, Path, Path] | None:
    """`(label, candidate_real, protected_real)` for the FIRST protected-root collision across
    `--source`/`--output` x (conventional production root, runtime-resolved default state root),
    by realpath, checked BOTH directions (Phase 1 review F-round-3): `--output` covers "never
    write into or over production"; `--source` covers "never let a symlinked/aliased --source
    secretly BE production" even though this script only ever reads it. `None` when neither
    candidate collides with either protected root.
    """
    for label, candidate in (('--source', source), ('--output', output)):
        candidate_real = _realpath(candidate)
        for protected in _protected_production_roots():
            if _contains_or_equal(candidate_real, protected):
                return label, candidate_real, protected
    return None


def _prospective_realpath(path: Path) -> Path:
    """Realpath of `path`, tolerating that it may not exist yet (Phase 1 review B1): resolves the
    PARENT's realpath and re-appends `path`'s own basename, so a not-yet-created `--output` can
    still be compared for overlap against `--source` BEFORE `--output` (or even its parent) exists.
    """
    return _realpath(path.parent) / path.name


def refused_source_output_overlap(source: Path, output: Path) -> tuple[Path, Path] | None:
    """`(source_real, output_real)` if `--output`'s realpath equals, is inside, or contains
    `--source`'s realpath, checked BOTH directions (Phase 1 review B1) — `None` when they do not
    overlap at all. Checked BEFORE `--output` is created: `--output` need not exist yet
    (`_prospective_realpath` resolves its parent instead), so a chained `--apply` aimed at putting
    `--output` inside its own `--source` (or vice versa) is caught before a single byte of a
    self-referential copy is ever written, not after `os.mkdir` already ran.
    """
    source_real = _realpath(source)
    output_real = _prospective_realpath(output)
    if _contains_or_equal(output_real, source_real):
        return source_real, output_real
    return None


# --- copying --source into a fresh --output (Phase 1 review F-round-3/B2/B3/W2) ------------------

def scan_source_tree(source: Path, *, max_files: int | None = None, max_bytes: int | None = None
                     ) -> tuple[list[Path], list[Path], list[tuple[str, str]]]:
    """Lstat-walk `source` (never following symlinks), returning `(dirs, files, unsafe)`.

    `dirs`/`files` are paths RELATIVE to `source`, in a stable (sorted, depth-first) order safe to
    replay onto a fresh output directory — every directory appears before anything inside it.
    `unsafe` is `(relpath, kind)` for every symlink/fifo/socket/device/unreadable entry found
    ANYWHERE in the tree; `kind` is `'symlink'`, `'special'`, or `'unlstatable:<errno message>'`/
    `'unreadable_directory:<errno message>'`. Never raises for what it finds in THAT sense; the
    caller decides that a non-empty `unsafe` means abort — no path through this maintenance script
    ever silently skips or follows a symlink. This runs, and must complete (or abort), BEFORE this
    script ever hashes or copies a single byte of `--source` (Phase 1 review B3): the lstat check
    on every entry is the cheapest, earliest opportunity to refuse a hazardous tree.

    `max_files`/`max_bytes` (Phase 1 review W2) bound the copy this scan is planning: exceeding
    either raises `CopyBudgetExceededError` IMMEDIATELY, from inside the walk, rather than finishing
    the walk and reporting after the fact — the walk does not keep growing `dirs`/`files` past a
    budget breach, bounding how much of a pathologically huge tree this script ever holds in
    memory. `None` (the default for both) means no budget is enforced, for callers (and the tests
    exercising this function directly) that only care about the lstat safety classification.
    """
    dirs: list[Path] = []
    files: list[Path] = []
    unsafe: list[tuple[str, str]] = []
    total_bytes = 0

    def walk(rel: Path) -> None:
        nonlocal total_bytes
        current = source / rel
        try:
            entries = sorted(current.iterdir())
        except OSError as exc:
            unsafe.append((str(rel) if str(rel) != '.' else '.', f'unreadable_directory:{exc.strerror or exc}'))
            return
        for entry in entries:
            entry_rel = entry.name if str(rel) == '.' else str(rel / entry.name)
            entry_rel_path = Path(entry_rel)
            try:
                st = entry.lstat()
            except OSError as exc:
                unsafe.append((entry_rel, f'unlstatable:{exc.strerror or exc}'))
                continue
            mode = st.st_mode
            if stat.S_ISLNK(mode):
                unsafe.append((entry_rel, 'symlink'))
            elif stat.S_ISDIR(mode):
                dirs.append(entry_rel_path)
                walk(entry_rel_path)
            elif stat.S_ISREG(mode):
                if max_files is not None and len(files) + 1 > max_files:
                    raise CopyBudgetExceededError(
                        f'{source} contains more than the configured max file count ({max_files}); '
                        'aborting the scan rather than growing an unbounded copy plan.')
                total_bytes += st.st_size
                if max_bytes is not None and total_bytes > max_bytes:
                    raise CopyBudgetExceededError(
                        f"{source}'s regular files total more than the configured max-copy-bytes "
                        f'budget ({max_bytes}); aborting the scan rather than growing an unbounded '
                        'copy plan.')
                files.append(entry_rel_path)
            else:
                unsafe.append((entry_rel, 'special'))

    walk(Path('.'))
    return dirs, files, unsafe


def _copy_regular_file(src: Path, dst: Path) -> int:
    """Copy one regular file, refusing to follow a symlink or read a non-regular file at either
    path's final component (Phase 1 review B3: `_open_regular_nofollow` on the source — defense in
    depth on top of `scan_source_tree`'s lstat check, closing the TOCTOU window between that check
    and this open, and never blocking if `src` turns out to be a FIFO), fsynced before returning.
    Returns the number of bytes copied, for the caller's running copy-budget tally (Phase 1 review
    W2).
    """
    total = 0
    with _open_regular_nofollow(src) as source_handle:
        dst_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, 'O_NOFOLLOW'):
            dst_flags |= os.O_NOFOLLOW
        dst_fd = os.open(dst, dst_flags, 0o600)
        with os.fdopen(dst_fd, 'wb') as dest_handle:
            while True:
                chunk = source_handle.read(1024 * 1024)
                if not chunk:
                    break
                dest_handle.write(chunk)
                total += len(chunk)
            dest_handle.flush()
            os.fsync(dest_handle.fileno())
    return total


def copy_source_tree(source: Path, output: Path, *, dirs: list[Path], files: list[Path],
                     max_bytes: int | None = None) -> None:
    """Copy the pre-scanned `dirs`/`files` (both relative to `source`, from a `scan_source_tree`
    call the caller already ran and found safe) into the freshly, exclusively created `output`.

    Never re-validates lstat safety itself — the caller is responsible for scanning `source` and
    aborting on any unsafe entry BEFORE this function is ever called (Phase 1 review B3: the lstat
    walk must finish, or abort, before this script reads a single byte of `source` for hashing OR
    copying). Still refuses to follow a symlink or read a non-regular file at open time
    (`_copy_regular_file`'s `_open_regular_nofollow`), defense in depth against a TOCTOU race
    between that scan and this copy.

    `max_bytes` (Phase 1 review W2) is enforced AGAIN here, against bytes actually copied so far,
    not only against the pre-copy scan's size tally — a `source` file that grows between the scan
    and this copy is still caught mid-copy, raising `CopyBudgetExceededError`.

    NEVER removes `output` on failure (Phase 1 review B2): this function raises and leaves whatever
    partial copy exists in place; the caller decides what to do with it (see the module docstring's
    TRUST CONTRACT / "ANY failure after `--output` is created" section).
    """
    for rel in dirs:
        target = output / rel
        os.mkdir(target, 0o700)
        fsync_directory(target.parent)
    total_bytes = 0
    for rel in files:
        total_bytes += _copy_regular_file(source / rel, output / rel)
        if max_bytes is not None and total_bytes > max_bytes:
            raise CopyBudgetExceededError(
                f'copied {total_bytes} bytes from {source}, exceeding the configured max-copy-bytes '
                f'budget ({max_bytes}); aborting mid-copy rather than growing --output without bound.')
    fsync_directory(output)


# --- pre-scanning the OUTPUT copy's streams (Phase 1 review F-round-3/W1) -------------------------

def prescan_output_streams(output: Path) -> dict[str, dict[str, int]]:
    """Scan every stream `orchestrator.record_batch.write_batch`'s `RecordIndex` and
    `orchestrator.state.rebuild`'s ledger replay read (`events.jsonl`, `metrics.jsonl`,
    `outcomes.jsonl` — `orchestrator.record_index.STREAMS`) with THIS script's own bounded parser
    (`iter_physical_jsonl`, `include_final_unterminated=True` — Phase 1 review W1) before ever
    calling into that shared code. `include_final_unterminated` matters here specifically: unlike
    the general replayable-prefix readers this script otherwise mirrors, `RecordIndex._scan`
    (`orchestrator/record_index.py`) parses a final line with no trailing newline too (it does not
    skip a torn/in-progress-write tail) — so a hazard hiding ONLY in that unterminated tail must be
    caught here or it would reach `_scan` unguarded. Neither shared module is modified here:
    `RecordIndex._scan` and `iter_jsonl_from`/`_replay_into` (`orchestrator/runtime.py`,
    `orchestrator/state.py`) use the standard library's unbounded `for line in handle`/`json.loads`
    and do not themselves catch `RecursionError` — an oversized line or a pathologically deep value
    would be read/parsed there WITHOUT any of the bounds this script applies everywhere else it
    reads JSONL.

    Returns `{stream_filename: {'oversized_line': N, 'deep_nesting': N}}` for any stream where
    either hazard was found (an empty dict when none were, across every stream). A plain
    malformed-JSON/non-object line is NOT a hazard here — `write_batch`/`iter_jsonl_from` already
    catch `(ValueError, UnicodeDecodeError)` themselves and skip it gracefully; only the two hazard
    kinds those shared readers do NOT already guard against are reported.
    """
    hazards: dict[str, dict[str, int]] = {}
    for stream_name in STREAMS.values():
        counts: dict[str, int] = defaultdict(int)
        for _line_no, _record, reason in iter_physical_jsonl(output / stream_name, include_final_unterminated=True):
            if reason in ('oversized_line', 'deep_nesting'):
                counts[reason] += 1
        if counts:
            hazards[stream_name] = dict(counts)
    return hazards


# --- manifest (Phase 1 review F-round-3) -----------------------------------------------------------

def _create_exclusive(path: Path):
    """`os.open` with `O_CREAT|O_EXCL`: never overwrites an existing file. Raises `FileExistsError`."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, 'wb')


def _unique_manifest_path(output: Path) -> Path:
    """A `backfill-manifest-<suffix>.json` path inside `output` guaranteed not to already exist.

    NEVER a fixed filename: `--source` for one `--apply` run may itself be a PREVIOUS run's own
    `--output` (the documented idempotency chain), in which case that prior run's own manifest is
    copied into this run's `output` verbatim as part of the tree copy — a fixed name would collide
    with it. Each manifest names a DIFFERENT backfill (a different `--source`), so the old one is
    never overwritten or removed, only ever added alongside. The suffix (UTC timestamp + pid +
    nanosecond) mirrors the uniqueness scheme the pre-round-3 backup files used.
    """
    for _ in range(50):
        suffix = f'{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}-{os.getpid()}-{time.time_ns()}'
        candidate = output / f'backfill-manifest-{suffix}.json'
        if not candidate.exists():
            return candidate
    raise RuntimeError('could not choose a unique manifest filename after 50 attempts')


def _sha256_file(path: Path) -> str | None:
    """sha256 of `path`'s bytes, or `None` when it does not exist — never a crash, never a false
    hash for an absent stream (a state root need not have every stream file).

    Opened via `_open_regular_nofollow` (Phase 1 review B3): a FIFO refuses instantly (never hangs
    this process reading a canonical stream that turned out not to be a regular file), and a
    symlink at the final path component is refused rather than silently followed — defense in
    depth on top of the caller's own prior `scan_source_tree` lstat scan.
    """
    if not path.exists():
        return None
    hasher = hashlib.sha256()
    with _open_regular_nofollow(path) as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def hash_source_streams(source: Path) -> dict[str, str | None]:
    """sha256 of `--source`'s canonical streams (`events.jsonl`/`metrics.jsonl`/`outcomes.jsonl`),
    computed BEFORE the copy starts, for the manifest's provenance record — proof of exactly what
    `--source` contained at the moment this run read it, independent of anything read afterward.

    Callers must run `scan_source_tree` (and abort on any unsafe entry) BEFORE calling this (Phase
    1 review B3): the lstat walk is the primary defense, this function's own `_sha256_file` open is
    the defense-in-depth backstop.
    """
    return {name: _sha256_file(source / name) for name in STREAMS.values()}


def verify_copied_stream_hashes(output: Path, source_hashes: dict[str, str | None]) -> None:
    """Re-hash `output`'s just-copied canonical streams and compare them to `source_hashes` (Phase
    1 review W4), raising `SourceChangedDuringCopyError` on the first mismatch.

    `source_hashes` must have been computed from `--source` BEFORE `copy_source_tree` ran. A
    mismatch means `--source` was modified while this run was reading it — the copy this script is
    about to plan/backfill against no longer matches what `--source` claimed to contain at the
    start, so continuing would silently backfill against a moving target.
    """
    output_hashes = hash_source_streams(output)
    for name, expected in source_hashes.items():
        actual = output_hashes.get(name)
        if actual != expected:
            raise SourceChangedDuringCopyError(
                f'{name}: source hash {expected!r} (taken before the copy) does not match the '
                f'copied output hash {actual!r} — --source changed while this run was reading it.')


def write_manifest(output: Path, *, source: Path, source_hashes: dict[str, str | None],
                   rows_added: int, plan: dict[str, Any]) -> Path:
    """Write `backfill-manifest.json` into the freshly backfilled `output`: `--source`'s path and
    stream hashes, `output`'s own path, how many rows this run added, this script's version, and a
    small summary of the plan buckets — durable, provenance evidence living entirely inside
    `output`, never touching `--source`."""
    manifest = {
        'format_version': 1,
        'script_version': BACKFILL_VERSION,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'source_path': str(source),
        'source_sha256': source_hashes,
        'output_path': str(output),
        'rows_added': rows_added,
        'plan_summary': {
            'reconciled': len(plan['reconciled']),
            'unverifiable_total': len(plan['unverifiable_total']),
            'ambiguous': len(plan['ambiguous']),
            'no_evidence': len(plan['no_evidence']),
            'already_covered': len(plan['already_covered']),
            'skipped_unsafe': len(plan['skipped_unsafe']),
        },
    }
    manifest_path = _unique_manifest_path(output)
    handle = _create_exclusive(manifest_path)
    with handle:
        handle.write(json.dumps(manifest, indent=2, sort_keys=True).encode('utf-8'))
        handle.flush()
        os.fsync(handle.fileno())
    fsync_directory(manifest_path.parent)
    return manifest_path


# --- leaving a failed --output in place (Phase 1 review B2) --------------------------------------

def _open_directory_fd(path: Path) -> int:
    """Open `path` (a directory) for use as `dir_fd` in a later `os.open` — lets a marker be
    written into the SAME directory that was created even if the path string were somehow replaced
    in between (closes a TOCTOU window), and does not require `O_DIRECTORY` (not universally
    available): a plain `O_RDONLY` open of a directory is a valid `dir_fd` on every POSIX platform
    this script targets, even though the fd cannot be `read()` from directly.
    """
    return os.open(path, os.O_RDONLY)


def _write_incomplete_marker(output: Path, output_dirfd: int | None, message: str) -> None:
    """Best-effort marker left inside `output` on ANY failure after it was created (Phase 1 review
    B2): `--output` is NEVER recursively deleted on failure, no matter the cause — only a partial,
    known-incomplete artifact is left behind for a human to inspect or remove (`rm -rf <output>`)
    themselves.

    Written via `output`'s OWN directory file descriptor (`output_dirfd`, opened right after
    `os.mkdir` succeeded), not by path, so the marker still lands inside the actual directory that
    was created even if the path on disk were somehow replaced in between. Falls back to a plain
    path-based create if no dirfd is available (e.g. `_open_directory_fd` itself failed). Failure to
    write the marker itself is swallowed — it is a courtesy, never a requirement for `--output` to
    stay in place; `--output` is left alone either way.
    """
    payload = f'{message}\n'.encode('utf-8')
    try:
        if output_dirfd is not None:
            fd = os.open('INCOMPLETE', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=output_dirfd)
        else:
            fd = os.open(output / 'INCOMPLETE', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
    except OSError:
        pass


# --- CLI -------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', type=Path, required=True,
                       help='Read-only state directory to analyze/backfill FROM. Never modified by '
                            'this script, in dry-run or --apply. Must be a trusted, immutable '
                            'snapshot copy — see the module docstring TRUST CONTRACT.')
    parser.add_argument('--output', type=Path,
                       help='Required with --apply: a directory that must NOT already exist, whose '
                            'realpath must not overlap --source\'s. Created fresh (os.mkdir, mode '
                            '0o700) as a byte-for-byte copy of --source (regular files/directories '
                            'only), then backfilled in place. On success, rollback = delete this '
                            'directory; --source is never touched. On FAILURE this script leaves '
                            '--output in place itself (never deletes it) with an INCOMPLETE marker.')
    parser.add_argument('--apply', action='store_true',
                       help='Copy --source to --output and write the plan there. Default is dry-run: '
                            'read-only analysis of --source, writes nothing at all.')
    parser.add_argument('--max-copy-bytes', type=int, default=DEFAULT_MAX_COPY_BYTES,
                       help='Abort --apply if --source\'s regular files would copy more than this '
                            f'many bytes (default {DEFAULT_MAX_COPY_BYTES} = 20 GiB). Enforced both '
                            'from the pre-copy scan\'s size tally and again while bytes are actually '
                            'copied (Phase 1 review W2).')
    args = parser.parse_args(argv)

    source = args.source.expanduser().resolve()
    if not (source / 'events.jsonl').exists():
        print(f'error: {source} has no events.jsonl; is this an orchestrator state root?', file=sys.stderr)
        return 1

    try:
        reject_symlink_escape(source)
    except SymlinkEscapeError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1

    if not args.apply:
        try:
            plan = plan_backfill(source)
        except PlanTooLargeError as exc:
            print(f'error: {exc}', file=sys.stderr)
            return 3
        _print_plan(plan)
        print('\ndry-run only; nothing written (no --output was created). Re-run with --apply '
             '--output <fresh-dir> to write a backfilled COPY; --source is never modified.')
        return 0

    if not args.output:
        parser.error('--output is required with --apply')
    output = args.output.expanduser().resolve()

    collision = refused_protected_root(source, output)
    if collision is not None:
        label, candidate, protected = collision
        print(f'refusing to --apply: {label} ({candidate}) equals, is inside, or contains a protected '
             f'production root ({protected}). There is no override flag: --apply only ever runs '
             'against a fresh --output copy, and --source must never be production either.',
             file=sys.stderr)
        return 2

    overlap = refused_source_output_overlap(source, output)
    if overlap is not None:
        source_real, output_real = overlap
        print(f'refusing to --apply: --output ({output_real}) equals, is inside, or contains --source '
             f'({source_real}). There is no override flag: --output must be a directory entirely '
             'separate from --source, never an ancestor or descendant of it (Phase 1 review B1).',
             file=sys.stderr)
        return 2

    if output.exists():
        print(f'error: --output {output} already exists; refusing to overwrite or reuse it. Choose a '
             'fresh directory path (to roll back a previous --apply, delete that directory instead: '
             f'rm -rf {output}).', file=sys.stderr)
        return 2

    try:
        os.mkdir(output, 0o700)
    except OSError as exc:
        print(f'error: could not create --output {output}: {exc}', file=sys.stderr)
        return 2

    try:
        output_dirfd: int | None = _open_directory_fd(output)
    except OSError:
        output_dirfd = None

    try:
        # Phase 1 review B3: the lstat walker/validation runs, and completes (or aborts), BEFORE
        # this script reads a single byte of --source for hashing or copying.
        dirs, files, unsafe = scan_source_tree(source, max_files=MAX_COPY_FILES,
                                               max_bytes=args.max_copy_bytes)
        if unsafe:
            raise UnsafeSourceTreeError(unsafe)

        source_hashes = hash_source_streams(source)
        copy_source_tree(source, output, dirs=dirs, files=files, max_bytes=args.max_copy_bytes)
        # Phase 1 review W4: catch --source changing while this run was reading it.
        verify_copied_stream_hashes(output, source_hashes)
        reject_symlink_escape(output)  # re-validate the copy itself, immediately before planning/writing
        hazards = prescan_output_streams(output)
        if hazards:
            raise OutputStreamHazardError(hazards)

        plan = plan_backfill(output)
        _print_plan(plan)

        records = [{'stream': 'metric', **row} for row in plan['rows_to_add']]
        persisted_total = 0
        duplicates_total = 0
        if records:
            with writer_lock(output):
                for start in range(0, len(records), MAX_BATCH_RECORDS):
                    chunk = records[start:start + MAX_BATCH_RECORDS]
                    result = write_batch(output, chunk, lock=False, refresh=False)
                    persisted_total += result['persisted'].get('metric', 0)
                    duplicates_total += result['duplicates'].get('metric', 0)
                    if not result['ok']:
                        raise RuntimeError(f'write_batch reported an error: {result["error"]}')

        rebuild_derived_state(output)
        manifest_path = write_manifest(output, source=source, source_hashes=source_hashes,
                                       rows_added=persisted_total, plan=plan)
    except UnsafeSourceTreeError as exc:
        _write_incomplete_marker(output, output_dirfd, f'unsafe source tree entries found: {exc}')
        print(f'error: {source} contains a symlink or special file this script refuses to follow or '
             f'copy; --output left in place (NOT deleted — Phase 1 review B2) at {output} for manual '
             f'inspection/removal (rm -rf {output}); wrote {output / "INCOMPLETE"} as a marker. {exc}',
             file=sys.stderr)
        return 6
    except (CopyBudgetExceededError, SourceChangedDuringCopyError) as exc:
        _write_incomplete_marker(output, output_dirfd, str(exc))
        print(f'error: {exc}; --output left in place (NOT deleted — Phase 1 review B2) at {output} '
             f'for manual inspection/removal (rm -rf {output}); wrote {output / "INCOMPLETE"} as a '
             'marker.', file=sys.stderr)
        return 7
    except OutputStreamHazardError as exc:
        _write_incomplete_marker(output, output_dirfd, f'output stream hazard: {exc}')
        print(f'error: the copied streams in --output contain a hazard the shared readers '
             f'(write_batch/record index/ledger replay) would crash on; --output left in place (NOT '
             f'deleted — Phase 1 review B2) at {output} for manual inspection/removal '
             f'(rm -rf {output}); wrote {output / "INCOMPLETE"} as a marker. Hazards: {exc}',
             file=sys.stderr)
        return 5
    except PlanTooLargeError as exc:
        _write_incomplete_marker(output, output_dirfd, f'plan too large: {exc}')
        print(f'error: {exc}; --output left in place (NOT deleted — Phase 1 review B2) at {output} '
             f'for manual inspection/removal (rm -rf {output}); wrote {output / "INCOMPLETE"} as a '
             'marker.', file=sys.stderr)
        return 3
    except Exception as exc:  # noqa: BLE001 - deliberate: never delete --output on any failure (B2)
        _write_incomplete_marker(output, output_dirfd, f'unexpected error: {exc}')
        print(f'error: {exc}; --output left in place (NOT deleted — Phase 1 review B2) at {output} '
             f'for manual inspection/removal (rm -rf {output}); wrote {output / "INCOMPLETE"} as a '
             'marker.', file=sys.stderr)
        return 4
    finally:
        if output_dirfd is not None:
            with contextlib.suppress(OSError):
                os.close(output_dirfd)

    print(f'\nmanifest written: {manifest_path}')
    print(f'applied: {persisted_total} row(s) newly written to {output} ({duplicates_total} already '
         f'present — idempotent re-run). {source} was never modified.')
    print(f'rollback: rm -rf {output}   # {source} is untouched')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

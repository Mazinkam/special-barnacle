# Hierarchical Agent Orchestrator V3

A portable, model-agnostic orchestration scaffold for using coding agents as a default software-development workflow.

V3 includes V1 + V2 and adds **toggleable empirical adaptive routing**.

## Core model

```text
request / goal
   -> risk + complexity classification
   -> architect / authoritative event log + ledger
   -> dynamic DAG / hierarchy
   -> leads + bounded workers
   -> deterministic verification
   -> semantic / specialized review
   -> integration
   -> delayed outcomes
   -> empirical routing + economics dashboard
```

Hierarchy depth and worker count are dynamic: "many workers" always means only as many as are economically useful.

## What V3 adds

- adaptive routing modes: `off | observe | recommend | enforce`
- model/capability adaptation
- effort-level adaptation when supported by the harness
- topology, context-budget and verification adaptation switches
- historical learning with minimum evidence thresholds
- controlled exploration
- shadow routing
- model promotion and demotion
- deterministic canary assignment
- policy simulation against historical cohorts
- feature inheritance: global -> repo -> task
- feature-state validation
- decision explanations and replayable telemetry
- V3 dashboard sections for feature state and adaptive-routing behavior

Automatic policy tuning, automatic policy promotion, auto-merge and auto-deploy remain **off by default**.

## Important design boundary

The orchestrator never needs to know concrete model names. It asks for capabilities such as:

- `architect`
- `technical_lead`
- `implementation_fast`
- `implementation_strong`
- `technical_review`
- `security_review`

The active harness adapter maps those capabilities and abstract effort levels to concrete models/settings.

For HUMAIN Terminal the mapping lives in named profiles (`bridge/orchestrator-profiles.json`, installed by `install.sh`): `premium` (default, mixed vendor), `anthropic`, `openai` and `oss`. Tiers are `cheap < mid < premium < frontier`. Triage picks a lead size — `lead_small` (mid), `lead` (premium) or `lead_large` (frontier) — from complexity and risk (`method.json` `rules.lead_sizing`; `--lead-size` overrides), and the lead delegates implementation instead of editing files itself. A per-dispatch spend cap (`rules.dispatch_spend_cap`, `warn` by default) and a one-shot codex → Bedrock retry on provider quota errors bound cost and outages.

## Quick start

```bash
python -m orchestrator.cli init
python -m orchestrator.cli features
python -m orchestrator.cli plan run-001 backend_refactor 6 medium
python -m orchestrator.cli dashboard
./install.sh           # optional: wire the HT bridge into ~/.humain-terminal/agent/
```

Open:

```text
~/.local/state/coding-agent-orchestrator/dashboard.html
```

In HUMAIN Terminal, the bridge exposes `/orchestrate`, `/orchestrator-roi`,
and `/cross-review-demo` (after `/reload`). Saved interactive usage is ingested from
`~/.humain-terminal/agent/sessions/<project>/*.jsonl` after settled turns; the login/15-minute
sweep catches missed hooks. Message text and ephemeral `--no-session` work are excluded from
this session-log path. The dashboard refreshes every five seconds while visible, restores scroll,
and offers a pause/resume control. Run `/reload` or restart an already-running HUMAIN Terminal
to load changed extension hooks.

## Adaptive rollout

Default V3 policy is deliberately conservative:

```text
adaptive routing       recommend
historical learning    on
controlled exploration 2%
shadow routing          on
policy simulation       on
auto policy tuning      off
auto policy promotion   off
auto merge              off
auto deploy             off
```

A recommended progression is:

```text
off -> observe -> recommend -> enforce
```

Only move to `enforce` once route cohorts have enough samples and delayed quality signals are acceptable.

## Cost / quality objective

The scheduler is designed around **verified economic cost**, not token price alone:

```text
model spend
+ retries/rework
+ verification compute
+ orchestration overhead
+ optional human attention
+ delayed failure / maintenance signals
```

subject to hard correctness gates and an effective quality floor.

## V2 capabilities retained

- event-sourced persistent state
- rebuildable ledger
- dynamic DAG/hierarchy
- effort-aware compute packages
- context registry and bounded context packets
- context invalidation/refetch observability
- verification caching
- flaky-test telemetry
- worktree/ownership hooks
- delayed 7/30/90-day outcomes
- risk observability
- route economics
- self-contained HTML dashboard

## Archiving old run diagnostics (opt-in, reversible)

Every `/orchestrate` run leaves its diagnostics under
`~/.local/state/coding-agent-orchestrator/runs/<run_id>/` (`run.log`, each child's
`<task>.events.jsonl` / `<task>.prompt.md` / `<task>.stderr.log`, `lead-report.md`). The raw
child event streams are by far the largest thing in the state root. Nothing ever removes them
automatically. With explicit `--execute`, old **sealed** runs replace raw diagnostics with verified,
lossless gzip. **Legacy uncoordinated runs remain snapshot-only, retain raw inodes and reclaim zero
bytes; managed runs without a seal are skipped.**
A terminal outcome or final file stat alone never proves that diagnostic writers have closed.

```bash
python3 -m orchestrator.cli archive-runs                      # dry run: what would be archived, where, and how many bytes
python3 -m orchestrator.cli archive-runs --older-than-days 60  # same, with a wider window (default 30 days)
python3 -m orchestrator.cli archive-runs --execute            # actually archive (asks for nothing else; exit 1 if any file failed)
python3 -m orchestrator.cli restore-run <run_id> --dry-run    # list a run's archived files and their .gz paths
python3 -m orchestrator.cli restore-run <run_id>              # put the raw files back, byte-for-byte
```

What the dry run shows is exactly what `--execute` does, nothing more: per run, `eligible` with
each file's `<name>.gz` destination, raw bytes and *estimated* compressed bytes, or `skipped`
with a reason (`no_terminal_outcome`, `recent`, `recently_modified`, `age_unknown`,
`already_archived`, `nothing_to_archive`). The dry run writes nothing at all — no lock file, no
manifest, no state root if there is none. `--json` gives the same data machine-readably. It also
reports `ownership: sealed|uncoordinated` for eligible runs, `writers_unsealed` for incomplete
managed ownership, and `snapshot_only` reasons for legacy/unowned files; only files in the sealed
owner's inventory may be removed.

A run is eligible only when `outcomes.jsonl` holds a durable terminal outcome for it
(`run-complete` or `run-failed`, which the HT bridge records for completion, failure,
cancellation and crash alike), that outcome is older than the window, and no diagnostic file
in the directory was modified inside the window. Active runs, runs without a terminal outcome
and anything ambiguous are skipped and say why.

### Writer ownership and sealing (new HT runs only)

`RunSession` exclusively creates a fresh private run directory and `.diagnostics-owner.json`
(protocol `ht-run-diagnostics-v1`, version 1, run/owner IDs). Existing directories are never
adopted or reopened. All timeline, prompt, event, stderr and lead-report writes use its owning
writer. File descriptors are private, synchronous and closed in `finally`; child-producer leases
remain active until stdio **close**, even when timeout/error resolves the dispatch earlier.
Closing rejects new writers and gives existing leases plus the terminal telemetry acknowledgement
up to **two seconds** to drain. A successful drain fsyncs and hashes the owned files and publishes
`.diagnostics-sealed.json` durably. If the drain deadline expires (for example, a detached descendant
keeps an inherited pipe open), terminal cleanup warns that the run is **UNSEALED and archive-ineligible**,
releases the UI and admits the next run. Existing leases are **not** forcibly released: they may still
append until stdio closes. Even a later close does not retry or publish a seal for that run; raw files
and the managed owner marker remain, with no claim of lossless archival.
The seal binds the owner ID to each file's SHA-256/byte count. Late callbacks and new sessions cannot reopen
these files through the bridge, including after extension reload. Failed writes, failed terminal
acknowledgement, interrupted shutdown and killed processes leave an unsealed managed run: it is
skipped as `writers_unsealed`, since producers may still be active. Do not manually fabricate seals
for legacy directories or reuse sealed paths for new work.

`--execute` compresses each eligible file into a private (0600), same-directory gzip temporary
file, decompresses it and verifies SHA-256 and byte count, and checks for observed source changes.
It publishes `<name>.gz` with an atomic **no-overwrite** operation, then durably commits that file's
entry in `archive.manifest.json`. **Only then**, if the owner seal matches, is raw unlinked and the
directory fsynced. Unowned or seal-diverged files are never removed. `run.log` stays readable.
Disk-full, modified-file and I/O failures are reported per file and cause execute to exit nonzero,
including when all eligible files were skipped.

### Interruption and recovery

Re-run the same archive command after ENOSPC/interruption. Progress commits per file: a matching
existing gzip is reused (same inode), including a crash orphan not yet in the manifest, but only
after its full decompressed bytes match raw. A corrupt/differing orphan is **never overwritten**.
A manifest-plus-raw interruption resumes removal only for a matching sealed owner. Valid manifest
updates can only add entries: previous generations are retained as private content-addressed
`.archive.manifest.<sha256>.json` recovery copies before atomic publication. Invalid manifests,
symlinks, unsafe paths, and unknown temp files are never overwritten or cleaned up. If metadata
is invalid, preserve all files and use the prior generation to inspect/recover; automatic recovery
never guesses which untrusted metadata to replace. All entries are validated before mutation.

Storage reporting separates `raw_bytes_removed`, gzip bytes, `storage_delta_bytes` (positive means
more storage), and `reclaimed_bytes` (nonnegative net reduction), including manifest/recovery-copy
overhead. These are **logical file bytes**, not allocated filesystem blocks; snapshot-only runs
consume additional space. Archives and recovery metadata stay local indefinitely.

Never archived, wherever they appear: `run.log` (the timeline the progress board links to stays
readable in place), the authoritative streams `events.jsonl`, `metrics.jsonl`, `outcomes.jsonl`,
`discoveries.jsonl`, and the ledger/checkpoint/index recovery metadata. There is no retention
timer or archive deletion: archives stay recoverable indefinitely, and compressing a file does not
free any audit evidence — the storage report always distinguishes raw from compressed bytes.

To read one archived file without restoring the run: `gunzip -c <file>.gz`. `restore-run`
decompresses each archive to a private (0600) temporary file, verifies the manifest digest and
byte count, restores the original mtime, and atomically installs it **only if the raw path is still
absent**. This also restores legacy archives made by earlier versions that removed originals.
The `.gz` and manifest remain intact as recovery copies after success; corrupt archives are
reported, and existing raw files are never overwritten, even if created during restore. An
existing raw file with matching content is already restored. If HT shows a missing raw path from
an archived run, the message names the `.gz` and restore command instead of a broken link.

Deployment: this worktree is not live. After review/merge, reload/restart the HT extension before
new runs can acquire ownership and seal; already running or historical sessions stay uncoordinated.
Python CLI spawns load the merged code on their next invocation. Test/benchmark only temporary
roots with `HUMAIN_ORCHESTRATOR_SKILL_ROOT` set to this checkout, never the live shared root.

## Durable telemetry and recovery

`event`, `metric`, `outcome`, and `init` remain available. `batch` accepts an ordered JSON
array on stdin (or as one argument), with **1–500** records of the form
`{"stream":"event|metric|outcome","record_id":"stable-unique-id", ...payload}`. Event
records also need `event`; reuse the original IDs on retry. IDs must not identify different
payloads: an already recorded ID is treated as a duplicate, not an update. The HT bridge
coalesces related records and awaits terminal flushes; every successful batch invocation
publishes the dashboard. Validation precedes append, but a multi-stream I/O failure can leave a
durable prefix: this is recoverable, **not** an atomic transaction across three JSONL files.

The write-command JSON response includes `persisted`, `duplicates`, `ledger_updated`,
`dashboard_updated`, and `retry`. Exit codes:

- **0:** durable records (including duplicate retries), dashboard refreshed.
- **1 + `status: invalid`:** validation failed; no records appended.
- **2:** append interrupted; retry the **whole original batch with the same IDs**.
- **3:** durable records, but checkpoint/ledger/dashboard refresh failed; same-ID replay
  catches up derived views without charging twice.
- A missing response, spawn failure, or other ambiguous exit is **not** proof that nothing
  persisted. Preserve the payload/IDs and replay them; do not manufacture new IDs.

`events.jsonl`, `metrics.jsonl`, and `outcomes.jsonl` stay authoritative. Batch response format
is version 1; ledger schema 3 carries a version-1 event-offset checkpoint. The version-2
`records.checkpoint.json` receipt validates `records.index.sqlite3`, a rebuildable exact-ID
cache, **not a SQLite migration of history**. Normal CLI and engine refreshes incrementally
catch up; `python3 -m orchestrator.cli rebuild` is explicit full event replay and invalidates
the ID cache so the next writer re-derives it. Never remove canonical streams or integrity/
recovery metadata to resolve a retry. A failed dashboard render keeps the previous complete
HTML page; `dashboard` republishes it after the underlying problem is corrected. Render/publication
is serialized by `dashboard.lock`, separate from the canonical writer lock. `dashboard.version.json`
is a version-1 rebuildable stream-identity/size/mtime receipt; a write during rendering leaves it stale.
An unchanged-source `ingest` retry still repairs a missing/stale dashboard or event ledger.

On orderly shutdown HT first cancels the active run and waits for producer completion and the
terminal batch, then drains session ingestion. Each shutdown hook has a two-second wait bound;
timeout is reported, does not certify late telemetry, and leaves diagnostics unsealed. A timed-out
Python operation may still finish later; repeat the original IDs/session import after restart.
These bounded waits cannot guarantee capture of unsent records after a hard kill.

Session ingestion uses version-3 files under `ingest-checkpoints/`. Unchanged settled sources
use checkpoints, while growth/rewrite/rotation validates history before reconciling IDs. Retry
the same source on interruption. Granularity changes with unprovable legacy aggregate coverage
are rejected with a diagnostic instead of guessing and double billing; preserve the source,
metrics, and checkpoint for reconciliation. Do not use `--discover` for benchmark fixtures.

## Isolated verification and before/after measurements

The skill-root override chooses **code**, not state. Set both Python and HT state-root variables
as well; merely running inside a worktree does not redirect the installed bridge or shared state.
This example creates a deterministic frozen fixture and benchmarks **copies** of it at 1x/2x/4x;
it never opens the live state root, installs an extension, or launches agents:

```bash
CHECKOUT=$(pwd -P)
SCRATCH=$(mktemp -d)
export HUMAIN_ORCHESTRATOR_SKILL_ROOT="$CHECKOUT"
export CODING_AGENT_ORCHESTRATOR_HOME="$SCRATCH/state"
export HUMAIN_ORCHESTRATOR_STATE_ROOT="$SCRATCH/state"
export CODING_AGENT_RUNTIME=benchmark
export CODING_AGENT_REPOSITORY="$CHECKOUT"
export PYTHONPATH="$CHECKOUT" PYTHONDONTWRITEBYTECODE=1

python3 -B - "$SCRATCH/frozen" <<'PY'
import sys
from pathlib import Path
from tests.test_dashboard_refresh import write_synthetic_history
write_synthetic_history(Path(sys.argv[1]), runs=500, seed=7)
PY
mkdir "$SCRATCH/before"
git archive 1141a3c | tar -x -C "$SCRATCH/before"  # pre-program baseline, not a deployment
python3 -B scripts/benchmark_refresh.py --source "$SCRATCH/frozen" \
  --compare-legacy "$SCRATCH/before" --checkout "$CHECKOUT" \
  --repeat 5 --scales 1,2,4 --json > "$SCRATCH/comparison.json"

python3 -B -m pytest -p no:cacheprovider -q
bun test ./bridge  # when Bun is available; fake/test workers only
# Keep the JSON reports and frozen inputs for comparison; remove only your scratch directory later.
```

An **already frozen external copy** may replace `$SCRATCH/frozen`; never point a workload at
live state. The driver always copies the three streams into disposable roots. At 1x it preserves
complete source-line bytes; at larger scales it suffixes identifiers to replicate histories.
This multiplication is a size stress test, **not** additional independent evidence. Compare
`fixture_sha256` before drawing conclusions. `--compare-legacy` runs the archived checkout's
per-record CLI against final batched writes of the **same records**, alternating trial order,
with a cold trial excluded from five medians. Each pair must preserve identical canonical bytes,
ledger entities and common dashboard accounting (counts, total/waste costs, conflicts,
role/runtime/session aggregates). Corrected verification/route/evidence fields are deliberately
not an old-output equality gate; they have separate regression tests.

The existing `--checkout`-only mode remains available for comparing two batch-capable revisions;
its `per_record_legacy` means that revision's single-record interface, not old code. Both modes
report median wall time, median per-operation peak child RSS and logical/physical I/O. Logical
Python I/O excludes SQLite's native I/O and interpreter startup; physical I/O is cache-dependent.
The paired mode with defaults runs 36 children per scale (30 measured + 6 cold), 108 total.

Fresh copied-fixture results, **1141a3c → final**, five-record operation:

| Scale | Subprocesses | Median seconds | Median peak child RSS MiB | Logical read bytes | Logical write bytes |
|---|---|---|---|---|---|
| 1x | 5 → 1 | 1.3552 → 0.2967 | 74.8 → 64.4 | 33,711,777 → 7,358,299 | 10,466,827 → 2,994,073 |
| 2x | 5 → 1 | 1.9864 → 0.4843 | 132.4 → 105.8 | 67,794,731 → 14,779,836 | 12,452,089 → 4,016,576 |
| 4x | 5 → 1 | 3.2909 → 0.8734 | 244.4 → 191.8 | 135,960,639 → 29,622,904 | 16,262,146 → 6,028,987 |

These are instrumented macOS/Python 3.9.6 measurements of **refresh/write overhead**, not HT
end-to-end latency, supported-Python/Linux validation, or model-spend savings. New code also adds
durability guarantees absent in the old per-record code. Memory still grows with history; the
final correctness joins cost memory compared with the earlier Task-7-only measurements. No
confidence intervals or real matched cohort were measured. This comparison supersedes the
narrower `e8bb998` → Task-7 measurement as the program baseline.

### Evidence and release checklist

Reports distinguish all-call billing (including interactive sessions) from orchestrated run
coverage. Missing prices/tokens stay **unmetered**; missing elapsed time stays **unknown**, not
zero. Known spend is only a lower bound when calls are unmetered. Count priced calls, fully
priced runs, timed runs, and verified outcomes separately. The synthetic fixture above has
84.35% priced orchestrated calls but only 31.2% fully priced runs; 100% synthetic timing and
verification coverage does not validate a real cohort or authorize a savings claim. HT no longer
labels a missing price as an estimate: the Python pricing table must resolve it, otherwise it is
unmetered. Historical zero placeholder estimates without rate provenance are conservatively
unmetered, not silently rewritten. Triage belongs to its real run's overhead, including malformed
classifier replies. Routing joins use `(run_id, task_id)`; ambiguous multi-package tasks without
explicit verification context remain ineligible rather than crediting both routes. Stable
historical IDs are deduplicated per stream in run/route evidence and dashboard/billing aggregates;
distinct ID-less rows remain distinct, and canonical files are never rewritten to remove duplicates.

Before release:

- [ ] Full Python and bridge tests pass; run strict TypeScript checking against the installed
  HT API where available and explicitly list any unresolved diagnostics (there is no checked-in
  package/tsconfig runner). Do not equate passing runtime tests with a clean typecheck.
  **This gate is currently red.** Full strict checking over `bridge/**/*.ts` reports **6
  pre-existing demo diagnostics**, reproduced byte-identically at the pre-program baseline
  `1141a3c` after normalizing the checkout prefix. Production `bridge/extensions/orchestrator/**/*.ts`
  (tests excluded) typechecks clean. Fix or explicitly accept the demo debt before release:
  - `bridge/extensions/cross-review-demo.ts:73`, `:105`, `:138` — TS2352: `AgentToolResult<SubagentDetails>`
    asserted to `SubagentDetails`.
  - `bridge/extensions/cross-review-demo.ts:78`, `:110`, `:143` — TS2554: five arguments passed;
    the installed API accepts 2–4.
  The three TS2683 implicit-`this` errors formerly at `orchestrator/index.test.ts:722,723,733`
  were **introduced on this branch**, not pre-program debt; typed mocks now fix them.
- [ ] Installed-HT reload/shutdown smoke, supported Python (>=3.10), and Linux checks remain
  **unverified** here. Synthetic child tests do not replace those release gates.
- [ ] Same-input hashes, billing/duration/verification coverage, retry byte equality, and
  ledger/dashboard totals agree. Compare latency, RSS, subprocesses and I/O together.
- [ ] Archive dry-run/restore on a **copy** is lossless; active diagnostics remain untouched.
  Use `restore-run <run_id> --dry-run`, then `restore-run <run_id>`; gzip/manifests stay recoverable.
- [ ] Real matched cohorts have adequate priced coverage, comparable independently verified
  outcomes, and total lead/review/rework/verification overhead before claiming observed savings.
  Flat-model token-profile comparisons remain **counterfactual estimates**.
- [ ] Routing remains **`recommend`** by default; no automatic `enforce` promotion or quality-gate
  relaxation. Empirical routing/topology needs the configured verified-task evidence threshold.
- [ ] Review and merge before deployment; retain a consistent backup and previous code revision.

### Merge, reload, and rollback

The worktree is **not installed**: the shared skill symlink still targets the main checkout.
After review/merge, verify that the deployed Python and bridge paths resolve to the same merged
revision. Finish/cancel current runs and wait for their terminal telemetry/diagnostic drain
before using HT **`/reload`** (or exiting/restarting HT). Python subprocesses pick up merged
code on their next invocation; already loaded TypeScript does not. Start new runs only after
reload. Never reload mid-run to force a diagnostic seal; an interrupted/unsealed run stays raw
and archive-ineligible. Unsent in-memory records cannot be recovered after a hard process kill.

If rollback is needed, stop new dispatches, let outstanding writes drain, preserve a consistent
copy of the entire state root (including archives and recovery metadata), and restore the
previous **paired** Python/bridge code revision, then reload/restart HT. Preserve canonical JSONL;
do not overwrite it with an older snapshot or delete newer evidence. On a copy first, use
`rebuild` followed by `dashboard` to verify derived-state recovery, and inspect missing-price,
source-conflict, or archive errors before resuming. Checkpoints/indexes are disposable caches,
not a reason to destroy history; keep unknown/corrupt metadata for diagnosis rather than
manually fabricating a receipt or seal. Archive restoration is described above and never
silently overwrites existing raw files.

## Files

```text
orchestrator/             Python reference runtime (CLI + EventStore + scheduler; archive.py = opt-in run-diagnostic archival)
bridge/                    HUMAIN Terminal integration (paired with orchestrator/)
  extensions/              orchestrator.ts + cross-review-demo.ts
  agents/                  one .md per capability + orchestrator-lead.md
  README.md                install + adapter notes
install.sh                 symlinks bridge/ into ~/.humain-terminal/agent/
adapters/                  example adapter configs (claude-code, codex, generic)
docs/                      V3 features, adaptive routing, integration, telemetry
scripts/                   init / rebuild-ledger / regenerate-dashboard / dynamic_adapter
tests/                     Python tests for the reference runtime
~/.local/state/coding-agent-orchestrator/   runtime state (events, ledger, dashboard)
```

The HT integration lives under `bridge/` and is deployed with `./install.sh`,
which symlinks the bridge into the user's `~/.humain-terminal/agent/`
runtime directory. One `git pull && ./install.sh` keeps both the Python
runtime and the HT bridge in lockstep.

## Notes

This is an orchestration scaffold rather than a provider-specific agent launcher. A Codex, Claude Code, or other harness should use `OrchestrationEngine.plan_run()` and then resolve the returned capability + effort package through its adapter.

Historical/counterfactual outputs are explicitly estimates. The system should never treat a dashboard assurance score as a literal probability that code is correct.

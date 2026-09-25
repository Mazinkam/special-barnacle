# Phase 1 audit — orchestrator telemetry allegations vs current code (2026-09-25)

Scope: Phase 1, step 1 of `docs/superpowers/goals/2026-09-25-all-in-one.md`. Classifies the
A1–A4 allegations from the superseded `2026-09-25-run1-telemetry-fixes.md` against **HEAD**
(`d6bf43d`, branch `feat/orchestrator-optimization`) using a single read-only snapshot of
production state. No source was changed to produce this report.

## Snapshot

- Path: `/tmp/orch-snapshot-20260925T102729Z`
- Snapshot start: `2026-09-25T10:27:29Z`; copy order was `outcomes.jsonl` → `events.jsonl` →
  `metrics.jsonl` (smallest-to-largest) → small JSON state files → `runs/` (1.5 GB, copied
  whole; below the 5 GB skip threshold). Snapshot end: `2026-09-25T10:27:51Z` (22s total).
- Live production run was in progress during the copy; line counts were checked immediately
  before and after each of the three append-only files and did not change between the pre-copy
  check and the post-copy hash (metrics 8286, events 1109, outcomes 136 both times), so this
  snapshot is internally consistent as of `2026-09-25T10:27:3x Z`.
- No writes were made to `~/.local/state/coding-agent-orchestrator`. All analysis ran with
  `CODING_AGENT_ORCHESTRATOR_HOME=/tmp/orch-snapshot-20260925T102729Z`.

| file | bytes | sha256 | lines |
|---|---|---|---|
| metrics.jsonl | 6679134 | 3c5a392c828e8d1979e5a8f52cf03af474ae28e9211baa869ed8e5fae229c3f3 | 8286 |
| events.jsonl | 2295318 | f23147a4c95dd529587a7a72a4e80299a35ac1a0c68c124452de311c7db177b9 | 1109 |
| outcomes.jsonl | 184380 | 8f18fa433a33e2ebd1c9b58be7c0271b5984a8a6152f80a74c04296d6e75c1bc | 136 |
| ledger.json | 2783965 | bb00d61c0393a10e2b0bc099d9178fea67ae01b343966c951cbc33bc052b52ef | — |
| records.checkpoint.json | 98 | 2b86970f14e8224c58f346b28583dee06b5c819b04b88af0664f1d5df59b81e6 | — |
| ingest_status.json | 260 | fa46cbc53731a872c88744751f56cf1585b8f2d24ecc02041bd5df2e468e492b | — |
| policy_overlay.json | 3925 | 5d6f986945a5bb143b6968f8ffcaed1898a8a57ce34432520ac519a7f17e0042 | — |
| dashboard.version.json | 393 | ee4c8ddea6f02a4769f61f96250968e87271ea505d1ba658576af6d420cf07c4 | — |
| runs/ | 1.5 GB, 71 run directories | (not hashed individually) | — |

Regenerated with `PYTHONPATH=. CODING_AGENT_ORCHESTRATOR_HOME=<snapshot> python3
scripts/regenerate_dashboard.py` → `dashboard.html` written inside the snapshot only.

## Baseline figures (HEAD code, this snapshot)

| metric | value |
|---|---|
| total_cost | $280.72 |
| reported_cost | $208.13 |
| estimated_cost | $72.59 |
| cost_coverage | 85.6% |
| runs (total) | 194 |
| runs_completed / failed / incomplete | 85 / 5 / **104** |
| incomplete runs at $0 known cost | **46** |
| runs_with_elapsed / duration_coverage | 18 / **9.28%** |
| verification_coverage | 38.1% |
| coordination_rate | **72.27%** |
| verification_rate | 18.4% |
| adaptive_decisions | 123, all `recommended_only` (100%) |
| history_sufficient_rate | **0.0%** |
| cost by role (top) | lead $132.92, lead_large $48.64, technical_review $29.34, implementation_strong $24.44, architect $17.28, qa_agent $16.08 |
| model_call cost by (runtime, source) | codex/session_ingest $7865.82 (6661 rows) · humain-terminal/session_ingest $780.37 (717 rows) · **humain-terminal/live $194.72 (351 rows)** · claude-code/live $85.99 (88 rows) |
| dispatch_finished rows with nested_cost_usd > 0 | 19 rows, sum **$156.69** |

`$194.72` (own-only, currently-orchestrated HT-bridge spend) + `$156.69` (nested subagent
spend recorded on `dispatch_finished` but never turned into a row) ≈ **$351.41**, i.e. current
data reproduces the historical "$194 vs ~$350" and "$154.65 missing" claims almost exactly.

## Cumulative / incremental / own-only classification

| source | field | classification | evidence |
|---|---|---|---|
| `dispatch_finished.cost_usd` (bridge) | own dispatch cost | **own-only** (excludes what its own subagents cost) | `bridge/extensions/orchestrator/nested-cost.ts` docstring: "grandchildren... cost never reaches the child's own `message_end` usage"; `run_evidence.py:89` |
| `dispatch_finished.nested_cost_usd` | sum of a dispatch's own subagent tool calls | **cumulative snapshot, deduped** — `NestedCostTracker.observe` keeps the *latest* cost per `(toolCallId, taskId/index)` key and `total()` sums the latest values only, so tool-update replays don't double count | `bridge/extensions/orchestrator/nested-cost.ts:18-35` |
| `model_call.cost_usd` (own dispatch) | per-call, own-only | **own-only** | `dispatchRecordsFor` in `index.ts:3466-3495`, explicit "Exactly two rows... deliberately not a third" |
| `route_executed.executed_cost_usd` | mirrors `model_call.cost_usd` for the same dispatch | **own-only**, duplicate-by-design pairing (asserted equal by `dashboard.py:172-196`), not summed into total spend | `dashboard.py:157,175-196` |
| nested subagent spend as its own row | — | **does not exist**: no per-call row is ever written for a nested subagent call; `nested_cost_usd` is an aggregate number attached to the parent's `dispatch_finished` event only | grep for `parent_task_id` across `metrics.jsonl`: 0 hits; `dispatchRecordsFor` never reads `nested_cost_usd` |
| `economics.verified_cost` / `orchestration_overhead` / `dashboard` cost-by-role | totals | **parent-inclusive is claimed by comment, but code only sums `model_call`/session rows** — nested spend is excluded | `economics.py:143` `verified_cost`; `dashboard.py:509-524` `by_role` both iterate `row_cost(r)` over ordinary rows, never `nested_cost_usd` |
| spend-cap breach nested share (`dashboard.py` "Spend-cap breaches" card, `run_evidence.py:89-103`) | per-breach | uses `nested_cost_usd` correctly, but only inside this one card — isolated from totals | `orchestrator/run_evidence.py:89-103`; `dashboard.py:800-801` |
| pricing estimate (`pricing.estimate_cost_usd`) | per-call | **own-only**, deterministic function of token counts, no accumulation | `pricing.py:43-92` |

## Lifecycle paths lacking terminal events

- Only two terminal event kinds are ever emitted: `run_completed` and `run_failed`
  (`index.ts:2721,2730`; `run_evidence.py:58` `TERMINAL_EVENTS = {'run_completed':'completed',
  'run_failed':'failed'}`). There is **no `run_cancelled` event** anywhere in the bridge.
- Signal handling (`SIGINT`/`SIGTERM`/`SIGHUP`, `index.ts:355-370`) only calls
  `ACTIVE_RUN?.cancel("signal")` and a best-effort `recordQueue.flush()` from inside a
  synchronous signal handler; it does not itself write a terminal event. Whether a terminal
  event is later written depends on the cancellation exception being caught further up the
  call stack (`index.ts:5097`) and `failRun` running to completion before the process actually
  exits — explicitly documented as "best effort" in the surrounding comment.
- There is no dead-process / stale-run classifier on the Python side. Any run with no matching
  key in `TERMINAL_EVENTS` or `TERMINAL_OUTCOME_TASKS` defaults to `status='incomplete'`
  (`run_evidence.py:311`), regardless of whether the run is old-but-dead or genuinely still
  running. No pid/lock/heartbeat evidence is consulted to distinguish the two.
- `outcomes.jsonl` carries a second terminal path (`task_id in {'run-complete','run-failed'}`,
  written by `completeRun`/`failRun` via `recordOutcome`) that duplicates but does not extend
  the events-side classification — no cancellation-specific state exists on either stream.

## Audit table — A1–A4 and the evidence paragraph

| # | Allegation | Classification | Evidence |
|---|---|---|---|
| A1a | `dispatch_finished` events carry `nested_cost_usd` totalling ~$154.65 that never appears as a `metrics.jsonl model_call` row | **Reproduced** | Snapshot: 19 `dispatch_finished` rows with `nested_cost_usd>0`, sum **$156.69**; `grep -c parent_task_id metrics.jsonl` → 0; `dispatchRecordsFor` (`index.ts:3466`) emits exactly `model_call`+`route_executed`, never a nested row |
| A1b | humain-terminal dashboard spend $194 vs true ~$350 | **Reproduced** | `humain-terminal/live` model_call cost = **$194.72** (351 rows); + nested $156.69 = **$351.41** |
| A1c | "coordination 72%" is an artifact of the missing-nested-cost gap | **Reproduced** | `coordination_rate = 72.27%` from `regenerate_dashboard.py` on this snapshot; `economics.orchestration_overhead`/`dashboard.by_role` both compute totals from `row_cost()` over `model_call`/session rows only (`economics.py:358-371`, `dashboard.py:509-524`) — nested spend never enters the denominator, so adding it would materially change the ratio |
| A1d | run `ht-orch-1790193397618-nmac8d`: lead's own per-turn usage sums exactly to its recorded `cost_usd`, none of its subagent calls recorded | **Reproduced** | `run_evidence` row for this run: `implementation_cost_usd: 0.0`, `overhead_cost_usd: 17.24097975`, `overhead_ratio: 1.0`, `roles: [architect, lead]`; its own `dispatch_finished` events all have `nested_cost_usd: null` (nested-cost tracking, commit `e26e003`, was added 2026-09-24, one day **after** this run's 2026-09-23 timestamp); `lead-0`'s own event log shows a `subagent` tool call reporting `usage.cost` up to $4.19 that is invisible to any metric/event stream — confirms the underlying gap even predates the current (partial) nested-cost fix |
| A2 | 104/193 runs "incomplete" (46 at $0); no cancellation/abandoned classifier | **Reproduced** (counts), classifier **missing (confirmed defect)** | Snapshot: `runs=194`, `runs_incomplete=104`, of which **46** have `cost_known_usd==0`; `run_evidence.py:58,311` — only `run_completed`/`run_failed` map to a terminal status, no `run_cancelled` event type exists, no liveness/pid/heartbeat evidence is consulted |
| A3 | `quality_evidence_score` never emitted by live runs; `history_sufficient=0%`, all decisions `recommended_only` | **Reproduced, and already documented as such in the code** | `dashboard.py:69-72` docstring: "`quality_evidence_score` has a producer (`Engine.verify_task`) but no live run has ever called it"; grep across the repo finds zero non-test callers of `verify_task(`; snapshot: `history_sufficient_rate=0.0`, `adaptive_decisions=123` all `recommended_only` (matches "122" almost exactly — small drift from a live run since the historical report) |
| A4 | rate provenance `source=null` for `gpt-5.6-sol`, `gpt-5.6-terra`, `sonnet` despite `config.json` defining rates | **Already fixed at HEAD; historical-data gap only** | `config.json` entries for these models all carry `source: 'unverified-local-catalog'`; snapshot shows **100% null `cost_rate_source`** on every row naming these models, but the max timestamp among them is `2026-09-23T12:50:13Z`, before the provenance field was added in commit `d57b327` (`2026-09-23T21:42:05+03:00`); calling `pricing.estimate_cost_usd(model='gpt-5.6-sol', ...)` against HEAD now returns `cost_rate_source: 'unverified-local-catalog'` directly, confirming new writes are already correct |
| — | EVIDENCE paragraph totals ($154.65 nested, $194 vs ~$350, 72%, 104/193, 9%, `quality_evidence_score`/`history_sufficient=0%`, rate source null) | **All individually reproduced** except the rate-provenance item, which is historical-only | See rows above |

## Confirmed defects (for Phase 1 items 2–6)

1. **Nested subagent spend is invisible to totals, cost-by-role and coordination rate.**
   - Location: `orchestrator/economics.py:143` (`verified_cost`), `orchestrator/economics.py:358-380`
     (`orchestration_overhead` / `coordination_rate`), `orchestrator/dashboard.py:509-524`
     (`by_role`). None reads `nested_cost_usd`; it is consumed only by the isolated
     spend-cap-breach card (`orchestrator/run_evidence.py:89-103`, `dashboard.py:800-801`).
   - Minimal regression test idea: feed `economics.verified_cost`/`orchestration_overhead` a
     synthetic `dispatch_finished`-derived row set (or a `model_call` row plus a sibling
     nested-cost carrier) with a known non-zero `nested_cost_usd`, assert the total and
     `coordination_rate` change when it is present versus absent — today they do not.
   - Proposed fix direction (Phase 1 item 2, not implemented here): give each nested subagent
     call a stable identity (`parent_task_id`, `run_id`, capability derived from the agent
     name) and record it as its own `model_call` row tagged `cost_source` distinct from the
     parent's own-only cost, so existing per-role/per-runtime aggregation picks it up for free
     without special-casing `nested_cost_usd` in every consumer. Never also keep booking the
     aggregate `nested_cost_usd` once per-call rows exist for the same dispatch (would double
     count).

2. **No `run_cancelled` event and no dead/abandoned classifier.**
   - Location: `bridge/extensions/orchestrator/index.ts:2719-2733` (`completeRun`/`failRun` —
     only two terminal event kinds emitted), `index.ts:355-370` (signal handler is best-effort,
     does not itself write a terminal record), `orchestrator/run_evidence.py:58,311`
     (`TERMINAL_EVENTS` map, default status `'incomplete'`).
   - Minimal regression test idea: synthesize an `events.jsonl` for a run that only has
     `run_started` (no `run_completed`/`run_failed`), and one where a `dispatch_started` process
     is confirmed dead (no matching pid/lock); assert `run_evidence` currently reports both as
     `'incomplete'` with no way to distinguish them — this should change once a liveness signal
     exists.
   - Proposed fix direction: emit an explicit `run_cancelled` event from the Esc/Ctrl+C,
     `/orchestrate-cancel`, and session-shutdown paths (all of which already call
     `ACTIVE_RUN?.cancel(...)`), and add a Python-side classifier that only marks a run
     `'abandoned'` when there is durable evidence it is not live (no matching pid/lock/heartbeat
     record), never purely from age.

3. **`quality_evidence_score` has a producer with zero live callers.**
   - Location: `orchestrator/engine.py:128-144` (`Engine.record_model_call` /
     `verify_task`); no caller in `bridge/extensions/orchestrator/*.ts` or `orchestrator/cli.py`.
     Self-documented at `orchestrator/dashboard.py:69-72` and `orchestrator/history.py:204`.
   - Minimal regression test idea: run the existing adaptive-history test suite and assert that
     at least one recorded verification event carries `quality_evidence_score` when a real
     verification completes — currently no such assertion exists because no code path produces
     one outside `engine.py`'s own unit tests.
   - Proposed fix direction (per plan: "Reuse a score only if its semantics and inputs are
     already established and valid"): wire the run's actual verification completion (review +
     QA verdicts + test results already available via `runVerification`/`recordOutcome`) to call
     `Engine.verify_task`'s existing scoring logic and persist the score on the verification
     event, without inventing a new scale and without manufacturing a score from a dispatch exit
     code alone.

4. **Rate provenance nulls are historical, not a live-code bug — confirm and close, don't refix.**
   - Location: `orchestrator/pricing.py:43-92` (already emits `cost_rate_source`), commit
     `d57b327` (2026-09-23T21:42+03) added the field. No code change is warranted here; the
     Phase 1 gate should instead add a regression test pinning `estimate_cost_usd` to always
     populate `cost_rate_source` for any model with a `config.json` rate entry, so a future
     refactor cannot silently drop it again, and clearly label the historical null-source rows
     as "predates provenance tracking" rather than re-pricing them.

## Not directly verified in this pass (flag, not a claim)

- Whether `orchestrator/ingest.py`'s session-ingest write path (`_tally`, `_base_metric`,
  around line 495-533) independently sets `cost_rate_source` for estimated interactive-session
  rows, or relies on a shared `_priced`-style merge — not confirmed either way; the
  `codex/session_ingest` and `humain-terminal/session_ingest` cost buckets are large ($7865.82,
  $780.37) and deserve their own pricing-provenance check before Phase 1 item 6 is closed.
- Exact wall-clock/monotonic semantics of `elapsed_ms` for the 18 runs that do have a duration
  were not independently re-derived; `duration_coverage=9.28%` is taken from `run_evidence.py`
  as coded, not re-derived from raw timestamps.
- `verification_coverage=38.1%` was read off the dashboard summary; the underlying
  ATTESTED-vs-DISPATCH split (`records.py:139-147`) looks already correct based on code reading,
  but was not independently recomputed row-by-row in this pass.

## Nested cost semantics (Phase 1 item 2)

Determined by reading the coding-agent package's own `subagent` tool
(`/Users/abdulkarim/Documents/Projects/humain-terminal/packages/coding-agent/src/core/tools/subagent.ts`),
the type it reports (`SubagentSingleResult`), and how the bridge consumes it
(`bridge/extensions/orchestrator/nested-cost.ts`, `index.ts`).

- **`SubagentSingleResult.usage.cost` is own-only at every depth, never parent-inclusive.**
  `subagent.ts:706` accumulates it the exact same way the bridge accumulates its own dispatch
  usage: `currentResult.usage.cost += usage.cost?.total || 0` off each `message_end` that specific
  agent loop produced. It is *not* a rollup of anything that agent itself delegated further — if
  that agent also calls the `subagent` tool, the cost of ITS children is computed identically (own
  turns only) one level down, and is never folded back into the parent's number. There is no level
  in this chain where a reported cost includes a descendant's spend; every level only ever reports
  itself. This matches — and generalizes — the existing docstring on `NestedCostTracker`
  ("grandchildren... cost never reaches the child's own `message_end` usage").
- **Per-task fields available on each result**: `agent` (persona name, e.g. `orch-implementation-strong`),
  `agentSource`, `task`, `taskId` (stable per child; defaults to `${toolCallId}-${index}`),
  `parentTaskId`, `depth` (absolute recursion depth as the runtime computed it), `thinking`,
  `attempt`, `exitCode`, `model`, `stopReason`, `errorMessage`, `step`, and `usage` (`input`,
  `output`, `cacheRead`, `cacheWrite`, `cost`, `contextTokens`, `turns`). No field on this shape
  is parent-inclusive; `taskId`/`attempt`/`toolCallId` together are the only stable identity the
  runtime provides for one nested call.
- **The bridge sees only ONE hop of nesting.** `NestedCostTracker` (attached per bridge dispatch,
  i.e. per direct child process) only observes `tool_execution_*` events on *that* child's own
  stdout. If the dispatch's child (say, a lead) calls `subagent` itself, those calls (absolute
  depth = dispatch depth + 1) are visible here as `toolName: "subagent"` events. If ONE OF THOSE
  children calls `subagent` again (depth + 2), that call happens inside a process the bridge never
  reads from directly — it is invisible to this vantage point entirely, not merely uncounted. Each
  per-task row `nestedModelCallRowsFor` builds is tagged `nesting_depth` from the runtime's own
  `depth` field when present (else `dispatch depth + 1`), specifically so a consumer never assumes
  coverage deeper than what was actually observed.
- **No double counting is possible by construction**: because every level's own cost figure is
  own-only, a dispatch's own `cost_usd` (its own turns) and its nested per-task rows (its own
  immediate children's own turns) are costs at two different, non-overlapping tree nodes. The one
  place a double count COULD happen is booking both the coarse aggregate
  (`dispatch_finished.nested_cost_usd`, still emitted unchanged for backward compatibility/UI) and
  the new per-task detail rows for the same dispatch. `index.ts` prevents this by construction: the
  detail rows are emitted exactly once, immediately before the dispatch's own `dispatch_finished`,
  and `nested_rows_emitted` is stamped on that event so `economics.nested_residual_rows` (Python
  side) can tell "this dispatch already has detail rows" from "this dispatch only ever produced
  the old aggregate" and never re-derive a residual for the former.
- **Role/capability attribution is agent-name-derived only, and collapses in two known, harmless
  ways.** `roleForAgentName` maps `orch-<capability>` (and `CAPABILITY_AGENT_ALIASES`) back to a
  capability name; an unrecognized name is the explicit role `"unknown"`, never guessed. Two
  personas are shared by several capabilities (`orchestrator-lead` by all three lead sizes;
  `orch-technical-review` by four review capabilities), so the reverse mapping necessarily picks
  one representative capability per persona. This is cosmetic, not a correctness gap:
  `orchestrator/economics.py`'s coordination/verification buckets key off role name *suffixes*
  (`*_lead`, `*_review`) and treat every alias in a collision identically.

## Before/after (same snapshot) — updated for round 3 (F1-F5: copy-then-backfill contract,
dynamic ambiguity mirror, bounded retention, dispatch_attempt validation)

**Superseded numbers, and why (now twice).** The table that used to live here was produced by the
FIRST cut of `scripts/backfill_nested_costs.py`, before its own Phase 1 review (R4, S1-S5 — see
"Backfill-script review fixes" below). That review found the script planned by `(run_id, task_id)`
only (collapsing a quota-fallback's two attempts and never checking `metrics.jsonl` for rows that
already covered a dispatch), had no symlink/path-traversal/production-root/backup/rollback/
bounded-parsing hardening, and did not require costs to be finite/non-negative. A SECOND review
round (F1-F5, its own section near the end of this document) then found the R4/S1-S5 script's
in-place `--state-root [--apply|--rollback]` design was itself the residual risk: any bug in the
backup/restore path could still corrupt the ONLY copy of production-shaped data a human keeps
around for exactly this kind of recovery work. Round 3 replaces that with a `--source`/`--output`/
`--apply` contract that NEVER writes to `--source` at all, in dry-run or `--apply` — rollback is
simply deleting `--output`. Round 3 also fixed a correctness gap in `orchestrator/economics.py`:
`nested_reconciliation` now applies the SAME old-bug-cumulative-sum ambiguity rule the backfill
script already applied to historical data (F1), dynamically, at dashboard-build time — so a LIVE
run hitting the same historical shape (two `dispatch_finished` events sharing a `(run_id, task_id)`
without a provable, pairwise-distinct `dispatch_attempt`) gets the same protection, not just a
historical backfill.

Re-running the full snapshot workflow below on **fresh** `--output` copies with the round-3 script
(never the original `/tmp/orch-snapshot-20260925T102729Z`, which is untouched — verified below by
sha256) reproduces the SAME final totals as the R4/S1-S5 round ($596.68 total, $30.92 residual, 76
dispatches recovered, 540 rows) — round 3's contract/validation changes affect NOTHING about what
this specific snapshot's numbers are, only how safely they are produced and (for
`nested_reconciliation_ambiguous`, see below) how completely the risk is surfaced. Round 3's pass
also caught and corrects one arithmetic error in the PREVIOUS version of the table below
(`by_role.implementation_strong` for state C: this round's fresh `by_role` sum reconciles to
`total_cost` to the cent; the previous round's $202.49 figure did not — see the table note).

Three states, same read-only source (`/tmp/orch-snapshot-20260925T102729Z`), never modified in
place, this time via the round-3 `--source`/`--output` contract (no `--state-root`, no in-place
`--apply`, no `--rollback`):

- **State A — HEAD before this work** (recorded earlier in this document, unchanged): the
  pre-existing defect. `dispatch_finished.nested_cost_usd` was never read by any aggregator.
- **State B — after the economics/bridge fix (item 2/3, T1-T3 review, plus round 3's F1 dynamic
  ambiguity mirror), same snapshot, no backfill run**: `PYTHONPATH=. CODING_AGENT_ORCHESTRATOR_HOME=/tmp/orch-snapshot-B
  python3 scripts/regenerate_dashboard.py` against `/tmp/orch-snapshot-B`, a plain `cp -a` copy of
  the untouched original snapshot (this round's own scratch, disposable, not this script's output —
  `economics.nested_reconciliation` reconciles every `dispatch_finished` event's `nested_cost_usd`
  against durable per-task detail rows at dashboard-build time; zero files rewritten by this step).
- **State C — after the round-3 `scripts/backfill_nested_costs.py --source /tmp/orch-snapshot-20260925T102729Z
  --output /tmp/orch-backfill-out-1 --apply`**: dry-run first against the untouched original
  snapshot (unsafe-run-id/symlink/oversized-line/protected-root/output-stream-hazard guards all
  exercised with zero rejections on this snapshot — it is a plain, non-hostile state root), then
  `--apply` (creates `/tmp/orch-backfill-out-1` fresh, copies the snapshot into it with the script's
  own lstat-based walker, 540 rows written, a `backfill-manifest-*.json` written inside the output),
  then a SECOND, chained `--apply --source /tmp/orch-backfill-out-1 --output /tmp/orch-backfill-out-2`
  (0 new rows — idempotent, via the R4 existing-coverage check finding the first apply's own rows
  already durable in what is now ITS `--source`; `/tmp/orch-backfill-out-1` itself provably
  untouched by this second run), then `regenerate_dashboard.py` against `/tmp/orch-backfill-out-1`
  (state C below). `/tmp/orch-snapshot-20260925T102729Z` was re-verified byte-for-byte unchanged
  after all of the above (sha256 of `metrics.jsonl`/`events.jsonl`/`outcomes.jsonl` match the
  "Snapshot" table at the top of this document exactly: `3c5a392c...`/`f23147a4...`/`8f18fa43...`,
  8286/1109/136 lines, 6679134/2295318/184380 bytes — identical before and after this entire pass).

| metric | A (HEAD-before) | B (fix, no backfill) | C (fix + backfill) |
|---|---|---|---|
| total_cost | $280.72 | $437.40 | $596.68 |
| reported_cost | $208.13 | $364.81 | $524.08 |
| estimated_cost | $72.59 | $72.59 | $72.59 |
| cost_coverage | 85.6% | 86.1% | 73.0% |
| unmetered call rows | — | 64 | 266 |
| call_rows | — | 462 | 986 |
| coordination_rate | 72.27% | 46.38% | 34.00% |
| verification_rate | n/a (not its own card entry yet) | 11.78% | 30.13% |
| nested_reconciliation_ambiguous | n/a (mechanism didn't exist) | **16** (was reported `0` before round 3's F1 fix) | **16** (was reported `0`) |
| runs / completed / failed / incomplete | 194 / 85 / 5 / 104 | 194 / 85 / 5 / 104 | 194 / 85 / 5 / 104 |
| runs_cancelled / runs_interrupted | n/a (status didn't exist) | 0 / 0 | 0 / 0 |
| duration_coverage | 9.28% | 9.28% | 9.28% |
| verification_coverage | 38.1% | 38.1% | 38.1% |
| `by_role.unknown_nested` | absent | $156.68 (19 rows) | $30.92 (1 row) |
| `by_role.lead` | $132.92 | $132.92 | $132.92 |
| `by_role.lead_large` | $48.64 | $48.64 | $48.64 |
| `by_role.technical_review` | $29.34 | $29.34 | $29.34 |
| `by_role.implementation_strong` | $24.44 | $24.44 | **$178.05** (corrected; previously reported $202.49 — see note) |
| `by_role.architect` | $17.28 | $17.28 | $17.28 |
| `by_role.qa_agent` | $16.08 | $16.08 | $19.07 |
| `by_role.api_contract_review` | absent | absent | $94.13 |
| `by_role.security_review` | $6.12 (bare `security_review` alias not yet counted) | $6.12 | $37.21 |
| `by_runtime['humain-terminal']` | $194.72 (351 rows, own-only) | $351.41 (824 rows) | $510.68 (1348 rows) |

**`by_role.implementation_strong` correction (round 3).** The previous round's table reported
$202.49 for state C. This round's fresh `by_role` dict (read directly off `build_data`, and
cross-checked against a raw `cost_usd` sum over `metrics.jsonl` — both agree) gives **$178.05**.
Evidence this round's figure, not the previous one, is correct: summing EVERY `by_role` entry for
state C (including the small roles omitted from this table for brevity — `technical_lead` $3.98,
`implementation_fast` $1.79, `scout` $1.58, `analysis_mid` $1.64, `worker` $0.06,
`headless_reproduction`/`triage` $0.01 each) reconciles to `total_cost` ($596.68) to the cent;
substituting the previous round's $202.49 would overshoot `total_cost` by exactly $24.44 — i.e. by
exactly state B's OWN (pre-backfill) `implementation_strong` figure, consistent with the previous
round's delta prose ("`implementation_strong` +$178.05") having been added to the $24.44 baseline
a SECOND time rather than reported as the state's own absolute total. The backfilled DELTA itself
(summed directly off the 540 `backfilled: true` rows' own `cost_usd`) is **+$153.61** for
`implementation_strong` ($24.44 + $153.61 = $178.05), not +$178.05.

Duration/verification coverage and run status counts are unchanged across all three states on this
snapshot: the nested-cost fix and its backfill add/relabel `model_call` rows, never `run_*` events
or `outcomes.jsonl` rows, so nothing `run_evidence.summarize_runs`/`evidence_coverage` reads moves.

**`nested_reconciliation_ambiguous` correction (round 3, F1).** Both B and C were previously
reported as `0`. With round 3's F1 fix (`orchestrator/economics.py`'s `nested_reconciliation` now
groups every `dispatch_finished` event by `(run_id, task_id)` and refuses to book ANYTHING for a
group that cannot be proven separable — see "Round 3 review fixes" below), both B and C now
correctly report **16**. This does not change `by_role`/`total_cost` for THIS snapshot: every one
of the 16 flagged groups has `nested_cost_usd: null` and `nested_rows_emitted: null` on EVERY event
in it (independently re-verified against the raw `events.jsonl` for this exact update) — there was
never a positive dollar amount at stake for any of them here, so the pre-F1 code's `if aggregate <=
0: continue` guard already skipped them before the ambiguity question was ever asked, and F1 does
not change that outcome. What changes is visibility: these 16 dispatches' unprovable-attempt shape
was previously invisible to `nested_reconciliation_ambiguous` entirely (it only existed for the
separate "durable rows exist but don't add up" case); it is now surfaced, matching the backfill
script's own long-standing ambiguity report for the same 16 dispatches, and would prevent a real
double-booking on a DIFFERENT snapshot where one of these groups' events actually carried a
nonzero, unequal `nested_cost_usd` pair (the historical failure mode T1 fixed forward, but which
could still exist unaddressed on older, not-yet-backfilled data before round 3). The one dispatch
whose aggregate doesn't reconcile with backfilled detail (`ht-orch-1790283610002-wbouqc-lead-2`,
$30.92 vs a reconstructed $31.19) still does NOT appear in `nested_reconciliation_ambiguous` in
either B or C: it is a single-event group (trivially separable), has NO durable detail rows in
either state (the backfill correctly declined to book it — outside tolerance, see below), so its
full aggregate is booked as the `unknown_nested` residual in both B and C, and the backfill
script's OWN, separate ambiguous report (not this dynamic mechanism) is what names it — see the
"Backfill counts" table below and "17 vs 16" correction.

**Backfill counts (per-call reconciled vs event-log-only recovered vs skipped/ambiguous), this
rewrite of the script, same snapshot:**

| bucket | dispatches | rows | notes |
|---|---|---|---|
| per-call reconciled (`backfill_evidence=reconciled_with_aggregate`) | 18 | 167 | had a usable `nested_cost_usd` aggregate; reconstructed per-task sum matched within tolerance |
| event-log-only recovered (`backfill_evidence=event_log_only_no_aggregate`, "unverifiable total") | 58 | 373 | no `nested_cost_usd` key at all (pre-dates commit `e26e003`); booked from the raw log alone, **$159.27** of per-task cost with no independent number to check it against |
| already covered (skipped, overlap) | 0 | — | none of this snapshot's rows were already covered by an existing `nested`-flagged/`nested:`-prefixed row — the live bridge never re-ran against this history |
| ambiguous — aggregate/detail mismatch | 1 | — | `ht-orch-1790283610002-wbouqc-lead-2`: reconstructed $31.19 vs aggregate $30.92 (Δ$0.27, ~0.9%); non-overlap not provable, nothing booked, stays covered by the dynamic residual (`by_role.unknown_nested`'s $30.92 in state C is exactly this one dispatch) |
| ambiguous — old-bug cumulative-sum candidates | **16** (corrected; previously reported 17 — see note) | — | `(run_id, task_id)` groups with 2-3 `dispatch_finished` events that do NOT all carry a distinct explicit `dispatch_attempt` (task-level retries predating that field, not necessarily the T1 quota-fallback bug specifically) — cannot be proven separable from the event stream alone, so nothing booked, by either the backfill or (round 3, F1) `economics.nested_reconciliation` at dashboard-build time. Independently re-verified against the raw `events.jsonl` for this update: EVERY event in EVERY one of these 16 groups has `nested_cost_usd: null` AND `nested_rows_emitted: null` — there was never any claim at all, satisfied or otherwise (the previous round's "these dispatches' `nested_rows_emitted` claims happened to already be satisfied on this snapshot" was unsupported by the data and is corrected here: there is no claim to satisfy, only an absent field) |

**"17 vs 16" correction (round 3).** The previous round's table reported `17` for this bucket. That
figure conflated TWO different mechanisms that this script's own `_print_plan` happens to print
under one combined `ambiguous (skipped, unprovable): N` line: the 16 `(run_id, task_id)`-GROUP
candidates above (unprovable attempt separability — this row), plus the SEPARATE, single-dispatch
aggregate/detail-MISMATCH candidate (`ht-orch-1790283610002-wbouqc-lead-2`, the row immediately
above this one) — 16 + 1 = 17 printed lines, but only 16 belong to "old-bug cumulative-sum
candidates." Neither correction changes what was booked (still 76 dispatches, 540 rows, $596.68
total) — only which of the two existing rows in this table each of the 17 printed lines belongs to,
and (see the table above) that round 3's F1 fix now makes the 16 group-ambiguous dispatches visible
to `nested_reconciliation_ambiguous` too, not only to this script's own report.

| no log evidence (informational) | 135 | — | no `runs/<run>/<task>.events.jsonl` at all, or no `subagent` tool events in it |
| skipped — unsafe (run id/path/symlink) | 0 | — | this snapshot has no symlinked/traversal-shaped run directories; the S1/S4 guards fired zero times here (see the dedicated hostile-input tests in `tests/test_backfill_nested_costs.py` for coverage of the guards themselves) |
| lines skipped while scanning | oversized_line: 6 | — | six physical lines across the run logs exceeded `MAX_LINE_BYTES` (4 MiB) and were skipped+counted rather than read whole; S5 |

**76 dispatches recovered, 540 rows, same total as before round 3** (18 reconciled + 58
event-log-only). **Why $596.68 is not a corrected version of "~$155" and must not be targeted**:
the historical estimate only ever summed the 19 `dispatch_finished` rows that happened to carry a
`nested_cost_usd` field. $159.27 of what this backfill found (the 58-dispatch, event-log-only
group) has no aggregate to compare against at all — there is no independent number anywhere that
recovery can be checked against, only the raw event log itself; it is reported as its own
"unverifiable total" bucket for exactly that reason, never silently merged into the reconciled
figure. This "unverifiable total" label means specifically that the RECOVERED PER-TASK COST has no
aggregate to check against — it does NOT mean the recovery was checked for overlap against every
cost row that exists anywhere in this state root. `existing_nested_coverage` (this script's overlap
check) only ever looks at rows carrying `nested: true` or a `record_id` with the `nested:{run_id}:
{parent_task_id}:` prefix in `metrics.jsonl` — i.e. rows shaped like the live bridge's own or a
prior backfill's. It never compares against `session_ingest` rows or any other cost row by dollar
amount or by any other identity; non-overlap with THOSE is asserted, not proven, from this pass
alone. In practice this is not expected to matter here: every subagent dispatch runs the coding-
agent CLI with `--no-session` (`bridge/extensions/orchestrator/index.ts:1787`,
`args: string[] = ['--mode', 'json', '-p', '--no-session']`), so no session-log file is ever
written for one of these processes, and `orchestrator/ingest.py`'s session-ingest path
(`LOG_GLOBS`-based directory scanning) has nothing under those paths to ever find for them — but
that is a structural reason to expect no overlap, not a proof that none exists (a bug in `--no-
session` handling, a differently-configured runtime, or a session file written by some other means
entirely would not be caught by anything this pass checked). Completeness depends entirely on
`runs/` retention: any dispatch whose log was rotated, deleted, or never captured contributes to
`no_evidence` (135 here, plus the 16 old-bug-cumulative-sum-ambiguous groups and the 1
aggregate/detail-mismatch dispatch above) rather than to a number anyone can audit. Coverage and
coordination/verification rates moved for the same reason the underlying row population moved, not
because any number was previously "wrong": `cost_coverage` dropped (73.0% vs 86.1%) because many
newly recovered rows report tokens/cost partially or not at all (a real subagent call that crashed
before reporting usage, same honesty rule `economics.cost_class`/`has_reported_tokens` already
applies to every other row); `coordination_rate` dropped (34.0% vs 46.4%) and `verification_rate`
rose (30.1% vs 11.8%) because most of the recovered spend is real production/review work
(`implementation_strong` +$153.61 — corrected, previously misreported as +$178.05; see the
`by_role.implementation_strong` correction note above — `api_contract_review` +$94.13,
`security_review` +$31.09, `qa_agent` +$2.99 in `by_role`), which was previously not just
uncounted but entirely unattributed.

**Re-run discipline for this table (round 3)**: `/tmp/orch-snapshot-20260925T102729Z` itself was
never modified — re-verified by sha256 (not just byte count) of `metrics.jsonl`/`events.jsonl`/
`outcomes.jsonl` before and after this round's ENTIRE workflow (dry-run against it directly, then
two chained `--apply` runs reading FROM copies of it, never writing back to it): all three hashes
match the "Snapshot" table at the top of this document exactly. round 3's scratch state —
`/tmp/orch-backfill-out-1` (state C's `--output`), `/tmp/orch-backfill-out-2` (the idempotency-
check chained `--apply`'s `--output`, confirmed 0 new rows and byte-identical `metrics.jsonl` to
`/tmp/orch-backfill-out-1`'s), and `/tmp/orch-snapshot-B` (state B's plain `cp -a` copy) — is
disposable working state, not a durable artifact of this repo, and may be deleted once this
document is reviewed (`rm -rf /tmp/orch-backfill-out-1 /tmp/orch-backfill-out-2 /tmp/orch-snapshot-B`;
`/tmp/orch-snapshot-20260925T102729Z` itself should stay untouched for any future re-run of this
exact workflow). The previous round's scratch copy, `/tmp/orch-snapshot-20260925T102729Z-backfill2`
(an in-place `--state-root` copy from the R4/S1-S5 contract, superseded by round 3's `--source`/
`--output` contract), no longer exists — removed at the start of this round's re-run per the round-3
workflow instructions, since the in-place-mutation contract it exercised no longer exists either.


## Lifecycle after fix (Phase 1 item 4)

Implemented on top of the nested-cost work (item 2, already in this worktree, untouched here):

- Bridge (`bridge/extensions/orchestrator/index.ts`): a new `run_cancelled` event/`run-cancelled`
  outcome, written by a new `cancelRun()` (mirrors `completeRun`/`failRun`'s timing/draining
  contract), replacing the old behaviour where every cancellation path (Esc/Ctrl+C → `SIGINT`
  → `signal`, `/orchestrate-cancel` → `orchestrate_cancel`, `session_shutdown` →
  `session_shutdown`) recorded itself as `run_failed`/`run-failed`. `cancelReasonLabel()` maps the
  existing `RunSession.cancelReason` (`"user" | "shutdown" | "signal"`, already set by the existing
  `ACTIVE_RUN.cancel()` plumbing) onto these labels — Esc has no dedicated extension hook distinct
  from Ctrl+C in this runtime, so both surface as `signal`, which is documented at the call site.
  `completeRun`/`failRun`/`cancelRun` all now go through a `claimTerminalEvent()` guard so a run_id
  can only ever get ONE terminal event/outcome row, even if two terminal paths race (a crash
  unwinding after a cancel was already recorded is a no-op, not a second row) — covered by a new
  bun test that races `cancelRun` then `failRun` for the same run and asserts exactly one event and
  one outcome row survive. `RunSession.terminalTiming()` (unchanged) already guarantees
  `started_at`/`finished_at`/monotonic `elapsed_ms` whenever a session exists; when a terminal
  function is called without a session/timing (no test or production path does this for a real
  run), the timing fields are omitted entirely rather than defaulted to `0`, which
  `orchestrator/run_evidence.py` already read as "elapsed unknown" (`_elapsed`/`_terminal_fields`).
- Liveness evidence: a new `recordRunStarted()` emits `run_started` (previously never emitted by
  the bridge at all — only the separate Python `engine.py` path had one) with durable ownership
  evidence: `pid` (`process.pid`), `hostname` (`os.hostname()`), a cheap `process_started_at_ms`
  (`Date.now() - process.uptime()*1000`, no `/proc` read, no new dependency), and the bridge
  session file when available. No new timer/heartbeat: this is one fact recorded once, at the run's
  start boundary, reusing the existing `recordEvent`/batched record queue.
- Python (`orchestrator/run_evidence.py`): `TERMINAL_EVENTS`/`TERMINAL_OUTCOME_TASKS` now include
  `run_cancelled`/`run-cancelled` → `'cancelled'`. A new injectable `classify_liveness()` +
  `default_liveness_check()` (dependency-free `os.kill(pid, 0)`, hostname-gated) reclassify a
  non-terminal run `'interrupted'` ONLY when the `run_started` ownership evidence proves the owning
  process is gone (`ProcessLookupError`/ESRCH on the same host); a run with no ownership evidence,
  evidence naming a different host, or a pid that is alive (or whose liveness is merely unknown,
  e.g. a same-pid-different-process case a smarter injected checker could catch) stays
  `'incomplete'`. This is read-time only — `summarize_runs` never rewrites `events.jsonl` — and
  never derived from age alone. `evidence_coverage()` now reports `runs_cancelled` and
  `runs_interrupted` alongside the existing `runs_completed`/`runs_failed`/`runs_incomplete`, and
  `orchestrator/state.py` (ledger), `orchestrator/history.py` and `orchestrator/archive.py` all
  recognize `run_cancelled`/`run-cancelled` as a third terminal kind (ledger status `'cancelled'`,
  excluded from task-level verification like the other two terminal outcomes, and archivable).
- Tests: bun — `run_cancelled`/`run-cancelled` emission for a direct `cancelRun()` call and for
  each of the three cancellation reasons through the full `/orchestrate` → shutdown/`-cancel`
  integration paths (updated the three existing shutdown/cancel integration tests that asserted
  the old `run-failed`/`"failed"` shape, since that was the exact defect being fixed), the single-
  terminal-event race guard, `recordRunStarted`'s ownership fields, and `elapsed_ms`
  present-vs-omitted-never-zero. Python — `cancelled` status join-through (event-side and
  outcome-side), run-scoped exclusion from task verdicts, `evidence_coverage` mutual exclusivity,
  and the restart-reconciliation matrix (dead pid + same host → `interrupted`; alive pid → stays
  `incomplete`; unknown/mismatched identity → stays `incomplete`; different host → stays
  `incomplete`; old run with zero ownership evidence → stays `incomplete`, never reclassified by
  age), plus an end-to-end `build_data` dashboard-status-counts test.

### Dashboard regenerated on the backfill snapshot copy

`PYTHONPATH=. CODING_AGENT_ORCHESTRATOR_HOME=/tmp/orch-snapshot-20260925T102729Z-backfill python3
scripts/regenerate_dashboard.py` (same read-only-source-then-copy snapshot as the nested-cost
before/after table above; never the live state dir).

| metric | before (State C, this doc) | after (same snapshot, lifecycle fix) |
|---|---|---|
| runs (total) | 194 | 194 |
| runs_completed | 85 | 85 |
| runs_failed | 5 | 5 |
| runs_cancelled | n/a (status did not exist) | **0** |
| runs_interrupted | n/a (status did not exist) | **0** |
| runs_incomplete | 104 | **104** |
| runs_with_elapsed / duration_coverage | 18 / 9.28% | 18 / 9.28% |

The completed/failed/incomplete/duration figures are unchanged, and `runs_cancelled` /
`runs_interrupted` are both `0` on this snapshot — expected, not a bug: every run in `runs/` here
predates both the `run_cancelled` event (no run in this history was ever cancelled through the new
path) and the `run_started` ownership evidence (no run in this history carries a `pid`/`hostname`
on its `run_started` event, because the bridge did not emit `run_started` at all before this fix).
`classify_liveness()` requires that evidence to reclassify anything, and explicitly refuses to
infer liveness from a run's age alone, so all 104 historical incomplete runs correctly stay
`'incomplete'` here — the fix changes what NEW runs will report, not what this historical snapshot
says. The next Phase 1 gate should look for `runs_interrupted > 0` on a snapshot taken after this
fix has been live across at least one real process restart, and for `runs_cancelled` counts to
track observed Esc/Ctrl+C/`/orchestrate-cancel`/shutdown events going forward.

## Verification evidence and pricing provenance (Phase 1 items 5–6)

### Item 5 — factual verification evidence

**What was fixed.** The bridge's one QA gate outcome row (`${runId}-qa`, `verification_scope:
'run'`, written by `runVerification` through `recordOutcome`/`qaVerificationOutcomeFor` in
`bridge/extensions/orchestrator/index.ts`) now carries factual verification evidence additively,
alongside its existing `outcome`/`quality`/`note` fields — nothing existing was removed or
renamed:

- `checks`: every check the QA agent's own output reported a status for (`pass`/`fail`/`skipped`/
  `unavailable`), parsed by a new `parseCheckResults` (generalizes the existing
  `parseFailedChecks`, which only extracted failures). The `environment` check name is normalized
  from `fail` to `unavailable` — `QA_SCOPE_RULES` already tells the QA agent to report a broken
  test environment that way, and a check that never ran is not the same claim as one that ran and
  failed.
- `checks_unavailable`: the subset of `checks` that are `unavailable`/`skipped`, named explicitly
  rather than left to be inferred from an absent row.
- `check_commands` / `check_commands_unavailable_reason`: always `null` with an explicit reason
  today (`"QA agent output has no structured command field..."`). The QA agent's free-text output
  has no structured field for the literal shell command each check ran; recording a guessed
  command would be a fabrication, so this stays an honest, explained gap rather than invented data.
  This is the one piece of the item 5 checklist genuinely **not yet available**, and is real
  future work (extend the QA prompt/output format to report a command per check), not something
  papered over here.
- `tested_revision` / `tested_revision_dirty` (+ `tested_revision_unavailable_reason` when null):
  a new `testedRevisionFor(cwd)` reuses the existing `gitHead`/`gitDirtySnapshot` helpers (same
  cheap, already-used `git` subprocess calls) to capture the exact commit and dirty state the QA
  dispatch actually ran against. `null` always comes with a reason (non-Git checkout); it is never
  a bare, unexplained missing value.
- `review_verdicts`: `[{role: 'qa_agent', verdict: 'pass'|'fail'}]` — the one reviewer this code
  path actually dispatches. Not extended to other review capabilities (`technical_review`,
  `security_review`, ...) in this pass: those dispatches don't flow through `runVerification`, and
  attaching a verdict to them would need their own call sites, out of this item's scope.
- `artifacts`: `[]` today — no artifact storage exists for QA transcripts; an explicit empty list,
  not an omitted field.
- `outcome_finality: 'immediate'`: names this row as the immediate QA verdict, distinct from a
  later `reopened`/`regression`/`rollback`/`human_correction` signal on a *separate* outcomes row
  for the same task (already tracked by `orchestrator/outcomes.py`'s `bad_signal` +
  `outcome_summary`'s 7/30/90-day maturity windows) — this field does not change that mechanism,
  it just names which kind of row this is.

Python: `orchestrator/run_evidence.py`'s `summarize_runs` now captures this evidence once per run
from its `-qa` gate row into a new `verification_evidence` field on the run-evidence row (`None`
when no QA gate ran for that run, or it predates this field — never guessed, never a failure).
`evidence_coverage` reports `runs_with_verification_evidence` / `runs_with_tested_revision` /
`runs_with_check_commands` / `runs_with_review_verdict` / `runs_with_unavailable_checks_listed`
and their `*_coverage` ratios, all denominated over **every** run (not just verified ones), so a
run with no QA gate correctly counts against coverage rather than being excluded from the
denominator. `orchestrator/dashboard.py` surfaces the same numbers as three new summary cards.
None of this changes what makes a run/task "verified" — `records.verification_evidence` and
`history._verdict` are untouched.

**Is `quality_evidence_score` emitted? No — and it still should not be.** `Engine.verify_task`
(`orchestrator/engine.py:134`) remains the only producer, still with zero live callers. Its input,
`runtime.QualityEvidence`, needs `acceptance_pass`, `deterministic_checks_pass`, `tests_pass`,
`semantic_review_pass`, `architecture_review_pass`, `shadow_review_pass`,
`unresolved_high_risk_findings`, `uncertainty`, and four delayed-signal flags
(`reopened`/`regression`/`rollback`/`human_correction`). `runVerification` has, at most,
`passed: bool` (from `qaResult.exitCode === 0 && failedChecks.length === 0`, itself derived from
a regex-parsed markdown table over free text) and a list of check names. That supports *at most*
one of eight weighted inputs (`deterministic_checks_pass`, loosely); the other seven — semantic
review, architecture review, shadow review, acceptance, risk findings, uncertainty, and every
delayed-signal flag — have no live source at this call site at all. Populating them with anything
(`True`, `None`, a guessed default) to produce a number would be exactly the fabrication the Phase
1 goal explicitly forbids ("Do not manufacture a numeric quality score from passing tests"), not a
scoring decision this bridge call site is actually positioned to make. So `qaVerificationOutcomeFor`
deliberately never sets `quality_evidence_score`, and a new regression test
(`bridge/extensions/orchestrator/index.test.ts`, "records factual evidence additively, without a
manufactured score") pins `outcome).not.toHaveProperty('quality_evidence_score')` so a future edit
cannot slip one in silently.

**Adaptive routing stays insufficiently supported without it — already true by construction, now
pinned by a test.** `scheduler.package_history` (`orchestrator/scheduler.py:47-58`) requires a
cohort to have *both* a measured `verified_cost_usd` **and** a measured `avg_quality_evidence`
before it can be `historical`; `adaptive_route`'s `sufficient` flag
(`orchestrator/adaptive.py:154`) requires `empirical['choice'].get('historical')` to be true at
all before it even checks `verified_tasks >= min_samples`. Recording factual evidence (checks,
tested revision, review verdicts) on an outcome row populates the task-level *verdict*
(`records.verification_evidence` reads `outcome: 'verified'`/`'fail'` regardless of which other
fields ride along on the same row) but never touches `quality_evidence_score`, so
`avg_quality_evidence` stays `records.NO_DATA` for that cohort no matter how many verified tasks
accumulate. A new test,
`test_factual_verification_evidence_without_a_quality_score_keeps_routing_insufficient`
(`tests/test_history_scheduler.py`), synthesizes 20 verified tasks (well over `min_samples=12`)
whose outcome rows carry every new factual-evidence field and confirms `avg_quality_evidence` is
still `NO_DATA` and `adaptive_route(..., mode='enforce', min_samples=12)` still returns
`history_sufficient=False`, `action='fallback_insufficient_history'`, `selected==default` — i.e.
identical to having no history at all. This was already true of the existing code; the test exists
so it cannot regress silently now that outcome rows carry more (non-score) fields than before.

**Historical coverage, same backfill-snapshot copy
(`/tmp/orch-snapshot-20260925T102729Z-backfill`, `PYTHONPATH=. CODING_AGENT_ORCHESTRATOR_HOME=<that>
python3 scripts/regenerate_dashboard.py`, same command/snapshot as the item 2/4 before/after
tables above):** `runs=194`, `runs_with_verification_evidence=39` (runs whose `-qa` gate row
exists at all), but `runs_with_tested_revision` / `runs_with_check_commands` /
`runs_with_review_verdict` / `runs_with_unavailable_checks_listed` are all **0** — expected, not a
bug: every run in this history predates this fix, so none of their `-qa` rows carry these new
fields. The next Phase 1 gate should look for these to move above 0 once at least one real
`/orchestrate` run with verification has executed against this fix.

### Item 6 — pricing provenance

**Regression tests added, no rate/pricing logic changed.** `tests/test_pricing.py` (new) pins,
for every model `config.json`'s `pricing.models` actually defines today (19 entries), that
`pricing.estimate_cost_usd` returns a non-null `cost_rate_source` matching that entry's `source`
(and `cost_rate_verified_on` matching its `verified_on`), plus dedicated cases for the aliases the
goal and audit name explicitly: `gpt-5.6-sol`, `gpt-5.6-terra`, four `sonnet` spellings
(`claude-sonnet-4-5`, `claude-sonnet-5`, `claude-sonnet-4-20250514`, `claude-sonnet-4-6`), and four
provider-prefixed ids (`bedrock/claude-sonnet-4-5`, `us.anthropic.claude-sonnet-5`,
`anthropic/claude-opus-4-5`, `openai/gpt-5.6-sol`) exercising `rate_for`'s substring/suffix match.
A future refactor that drops the field for any of these silently fails this suite.

**`ingest.py`'s session-ingest pricing path — confirmed already correct, not a defect (closes the
audit's "not directly verified" flag).** `_base_metric`/`_tally` (`orchestrator/ingest.py:495-533`)
never call `pricing.estimate_cost_usd` themselves — they build a plain metric dict and hand it to
`write_batch` as a `stream: 'metric'` record. Every such record, orchestrated or ingested, passes
through the *same* `record_batch.build_record` → `runtime.meter` → `pricing.estimate_cost_usd`
pipeline (`orchestrator/record_batch.py:117`, `orchestrator/runtime.py:250-271`) before it is
written, so an estimated interactive-session row gets the identical `cost_rate_model` /
`cost_rate_source` / `cost_rate_verified_on` provenance a live orchestrated row does, for free,
with no ingest-specific code path to maintain or drift. A new test,
`test_estimated_session_ingest_rows_carry_pricing_provenance` (`tests/test_ingest.py`), ingests a
real HUMAIN Terminal session log through `ingest_file` and asserts the estimated row it writes to
`metrics.jsonl` carries the same provenance triple a direct `estimate_cost_usd` call for the same
model/tokens would produce. This confirms the "not directly verified" flag from the first pass of
this audit resolves to **already correct**, not a defect requiring a fix.

**Dashboard labelling.** `dashboard.py`'s rate-provenance table (`#rates`) previously labelled a
rate-table group with no `cost_rate_source` on any of its rows as `unstated`. That wording did not
distinguish "a live write genuinely omitted the field" from "every row in this group predates
commit `d57b327` (2026-09-23T21:42+03), before `cost_rate_source` existed at all" — the latter is
the only case that occurs today (see the `gpt-5.6-sol`/`gpt-5.6-terra`/`sonnet` rows below). The
pill now reads `predates provenance tracking` with a title attribute explaining why, and the
section's prose states explicitly that rows are never repriced against today's `config.json` — the
table already only ever reads `cost_rate_source`/`cost_rate_verified_on`/`cost_usd` off the stored
row, so no repricing logic needed to change, only the label a reader sees. `_rate_provenance`
(`orchestrator/dashboard.py:202-239`) itself is unchanged: `scope` covers all metric rows
(orchestrated + ingested) so the exposure is never hidden by narrowing scope.

**Authoritative price-verification work still needed** (every entry in `config.json`'s
`pricing.models` today, confirmed by `test_no_config_rate_entry_is_verified_yet`): all 19 rate
entries carry `source: 'unverified-local-catalog'` and no `verified_on` date —
`claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-sonnet-5`, `claude-opus-4-5`, `claude-opus-5`,
`gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-5.3-codex-spark`,
`claude-sonnet-4-20250514`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-8`,
`claude-fable-5`, `amazon.nova-pro`, `amazon.nova-2-lite`, `minimax-m2`. None of these rates has
ever been confirmed against a provider's published price list; closing this gap means someone
with access to each provider's current pricing page recording a real `verified_on` date per
entry, not a code change.

**Regenerated-dashboard coverage, same backfill-snapshot copy
(`/tmp/orch-snapshot-20260925T102729Z-backfill`):** `rate_rows=7134`, `verified_rate_rows=0`,
`unverified_rate_cost=$8718.79` (100% of estimated cost on this snapshot rests on an unverified
rate — unchanged by this pass, since no rate became verified). By rate model (all
`unverified-local-catalog` except the three below):

| model | priced rows | estimated cost | source |
|---|---|---|---|
| gpt-6-astra | 6396 | $6191.01 | unverified-local-catalog |
| gpt-5.6-sol | 98 | $1503.85 | **null (predates provenance tracking)** |
| claude-opus-5 | 145 | $312.57 | unverified-local-catalog |
| global.anthropic.claude-fable-5-1 | 63 | $310.16 | unverified-local-catalog |
| eu.anthropic.claude-opus-5-5 | 87 | $116.02 | unverified-local-catalog |
| gpt-5.6-terra | 95 | $108.48 | **null (predates provenance tracking)** |
| gpt-5.6-luna | 112 | $80.16 | unverified-local-catalog |
| sonnet | 58 | $44.62 | **null (predates provenance tracking)** |

The three null-source groups (`gpt-5.6-sol`, `gpt-5.6-terra`, `sonnet`; 251 of 7134 rate rows,
3.5%) are exactly the ones the first pass of this audit already classified as historical-only
(defect 4 — "confirm and close, don't refix"): every row in each group predates commit `d57b327`.
Calling `estimate_cost_usd` for these exact model strings against HEAD today already returns
`cost_rate_source: 'unverified-local-catalog'` (pinned by `test_pricing.py`), confirming this
snapshot's null rows are a historical artifact this pass correctly leaves alone rather than
backfilling with a repriced guess.

## Review fixes (independent technical + security review, bridge + aggregation pass)

A follow-on technical + security review of the Phase 1 nested-cost work (item 2/3 above) found
seven defects in the bridge/aggregation half of that work and one adjacent hardening gap. All are
fixed on this branch, each with a bun/pytest regression test; none changes routing, model
primaries, review requirements, verification depth/gate control flow, or spend-cap actions.

**T1 (blocking) — a quota fallback's two `dispatch_finished` events double-booked attempt 0's
nested cost.** `dispatchParallel`'s codex → Bedrock retry wrote a `superseded_by_fallback: true`
event for the original attempt carrying its own `nested_cost_usd`, then a second, final
`dispatch_finished` carrying the SUM of both attempts' nested cost. Any reconciliation summing
`nested_cost_usd` across a task's `dispatch_finished` events (or a future one that did) would count
attempt 0's spend twice. Fixed: every `dispatch_finished` now carries a `dispatch_attempt` field (0
= original, 1 = the fallback retry) and ONLY that attempt's own nested cost/rows — never a running
sum. The `DispatchResult` returned to callers (used for the dispatch's own billable row via
`dispatchRecordsFor`) still reports the true cross-attempt total; only the per-event telemetry
stream changed. `orchestrator/economics.nested_reconciliation` now keys reconciliation on
`(run_id, task_id, dispatch_attempt)`, not `(run_id, task_id)`.

**T2 (blocking) — nested detail rows from two fallback attempts could collide and drop a paid
call.** `nestedModelCallRowsFor`'s `record_id` was `nested:{run}:{parent}:{toolCallId}:{taskId}:
{attempt}`. The two fallback attempts are independent child processes with independently-numbered
tool-call ids, so a coincidental `(toolCallId, taskId, attempt)` collision across attempts could
dedup away one attempt's real nested-call row (`orchestrator.economics.unique_records` collapses
rows by `record_id`). Fixed: `record_id` now includes the SAME `dispatch_attempt` tag as T1:
`nested:{run_id}:{parent_task_id}:{dispatch_attempt}:{key}` (`key` unchanged —
`{toolCallId}:{taskId}:{nested-attempt}`), and every nested detail row also carries an explicit
`dispatch_attempt` field for reconciliation. **This is the exact scheme the pending backfill-script
update (`scripts/backfill_nested_costs.py`, out of scope for this pass) must mirror.**

**T3 (blocking) — `nested_residual_rows` suppressed the ENTIRE aggregate on any partial write.**
The old rule was "any `nested_rows_emitted > 0` or one matching detail row ⇒ book nothing": a
crash between writing detail row 1 and row 2 of a claimed 2 lost the second row's dollars forever,
silently. Replaced with `economics.nested_reconciliation`, which sums the KNOWN cost of durable
detail rows actually present for `(run_id, task_id, dispatch_attempt)` and compares against the
aggregate: detail sum covers the aggregate (within a small epsilon) ⇒ nothing to book; a real gap
WITH affirmative evidence some rows are missing (no `nested_rows_emitted` claim at all — a legacy
event — or the claim exceeds how many rows are durably present) ⇒ book exactly the shortfall, never
the full aggregate when detail rows partially cover it; a real gap where the claimed row count IS
fully durable yet the dollars still don't add up ⇒ book nothing (a guess would be fabricated
attribution) but report it back as `ambiguous`, surfaced in `dashboard.build_data` as
`summary.nested_reconciliation_ambiguous` (count) and `nested_reconciliation_ambiguous` (detail
list) — visible, never silently dropped and never added to any total. `nested_residual_rows`
remains as a thin wrapper returning just the rows, for callers that don't need the ambiguous
report.

**T5 — a later update lacking a valid cost overwrote an earlier reported cost.**
`NestedCostTracker.observe` (`bridge/extensions/orchestrator/nested-cost.ts`) fully replaced a
key's stored detail on every observation, including when the new observation's `usage.cost` was
missing/invalid (e.g. a final `tool_execution_end` with incomplete usage after an earlier
`tool_execution_update` already reported the real cost) — erasing a real number with "unknown".
Fixed: the last VALID cost (and the `costReported` it earned) is preserved across any later
observation that carries none of its own; every other field (model, exitCode, stopReason, …) still
refreshes to the latest observation unconditionally.

**T7 — the dashboard labelled every sourceless rate-model group "predates provenance tracking",
whatever its age.** `cost_rate_source` was introduced in commit `d57b327`
(2026-09-23T18:42:05Z); a group with no `cost_rate_source` on any row is only actually explained by
age when EVERY row in it is timestamped strictly before that instant. `dashboard._rate_provenance`
now tracks each group's rows against `PROVENANCE_INTRODUCED_AT` and returns
`source_predates_provenance` per model; the `#rates` table renders "predates provenance tracking"
only when that holds, and "source unknown" otherwise (a sourceless row timestamped on/after the
commit, or with no usable timestamp at all, is an unexplained omission, not an age artifact).

**T8 — an exit-0 QA gate with only skipped/unavailable checks recorded a passing gate with no
factual backing.** Per this task's explicit scope, **gate control flow is unchanged**: `passed`
(`qaResult.exitCode === 0 && failedChecks.length === 0`) and the `outcome`/`verification_scope`
row it produces are untouched, so an all-skipped QA run still passes the gate exactly as before —
fixing that is a **Phase 3 follow-up**, not this pass. What changed: `qaVerificationOutcomeFor`
now stamps an additive `evidence_status` field (`"verified"` when at least one parsed check
actually ran to a `pass`/`fail` verdict, `"unverified_checks_unavailable"` when every parsed check
was `skipped`/`unavailable` or none were parsed at all), and `orchestrator.run_evidence` reads it
defensively AND independently re-derives the same judgement from the `checks` list itself
(`_checks_factually_verified`, never trusting the bridge's claim alone — the same "a producer's
claim is not proof" rule T3 applies to `nested_rows_emitted`). `evidence_coverage` now reports
`runs_with_factually_verified_checks` / `factually_verified_checks_coverage` alongside the existing
(unchanged) `runs_with_verification_evidence`, so a run whose gate passed on no real check
evidence is counted as unverified evidence, never verified evidence, without changing whether that
run's gate itself passed.

**S6 — an oversized PID (`2**100`) crashed the restart-liveness classifier.**
`os.kill(pid, 0)` raises `OverflowError` on CPython for a pid outside the platform's signed C-long
range, before it ever reaches the kernel — `run_evidence._local_process_alive` did not catch it.
Fixed: a `_MAX_PLAUSIBLE_PID` (`2**31 - 1`) range check rejects an implausible pid before the
syscall, and `OverflowError`/`ValueError` are now caught alongside `OSError` as an additional
safety net, both returning "unknown" (never `False`/a crash) — consistent with how every other
malformed pid (non-int, negative, boolean) already degrades.

**Review note — `recordRunStarted` recorded an absolute session-file path.** The ownership
evidence `run_started` event included the bridge's session file as a full absolute filesystem
path (`session_id`), which can embed the OS username / home-directory layout into a durable,
shared telemetry log for no functional benefit: `run_evidence.classify_liveness` /
`default_liveness_check` read only `pid`/`hostname` from this evidence, never `session_id`. Fixed:
only the basename is recorded; hostname/pid/`process_started_at_ms` are unchanged.

All fixes: `bridge/extensions/orchestrator/index.ts`, `bridge/extensions/orchestrator/
nested-cost.ts`, `orchestrator/economics.py`, `orchestrator/dashboard.py`,
`orchestrator/run_evidence.py`, with regression tests in `bridge/extensions/orchestrator/
index.test.ts`, `bridge/extensions/orchestrator/nested-cost.test.ts`, `tests/test_economics.py`,
`tests/test_dashboard_metrics.py`, `tests/test_dashboard_refresh.py`, `tests/test_run_evidence.py`.
`scripts/backfill_nested_costs.py` and `tests/test_backfill_nested_costs.py` are deliberately
UNTOUCHED here — a separate follow-up task updates the backfill script to mirror the new
`record_id`/`dispatch_attempt` scheme (T2) and the new reconciliation rule (T3).

## Backfill-script review fixes (R4, S1-S5 — follow-up to T2/T3 above)

> **Superseded by round 3 (F1-F5, its own section below).** The `--state-root`/`--apply`/
> `--rollback` in-place contract this section describes (S2's `refused_production_root`, S3/T6's
> `create_backup`/`--rollback`) no longer exists in `scripts/backfill_nested_costs.py` — round 3
> replaced it with a `--source`/`--output`/`--apply` contract that never writes to `--source` at
> all; rollback is deleting `--output`. R4/S1/S4/S5's SUBSTANCE (group-by-`(run_id, task_id)`
> planning, symlink-escape/run-id/bounded-JSONL defenses, `MAX_RETAINED_RECORDS`) is unchanged and
> still described accurately below; only the S2/S3/T6 material below is fully superseded. Read this
> section for the history of WHY those defenses exist, then read "Round 3 review fixes" for the
> CURRENT contract.

A separate follow-on review of `scripts/backfill_nested_costs.py` itself (the script this document's
"Before/after" table's State C runs) found one correctness gap and four blocking security gaps. All
are fixed on this branch, each with regression tests in `tests/test_backfill_nested_costs.py`
(53 tests; see also the updated "Before/after" table above, which re-derives the same $596.68/76-
dispatch result with the rewritten script). No routing, model, verification, or bridge behaviour is
touched by any of these fixes — they are entirely inside the offline maintenance script.

**R4 (blocking) — planning kept only the LAST event per `(run_id, task_id)` and never inspected
existing `metrics.jsonl` rows before booking.** The original script's `dispatches[(run_id, task_id)]
= event` silently discarded every `dispatch_finished` event but the last for a task, which both (a)
cannot distinguish "two independent, provably-separate quota-fallback attempts" from "an old-bug
event pair where the second event's `nested_cost_usd` is a cumulative sum of both attempts" (T1's
exact historical failure mode), and (b) trusted the LAST event's `nested_rows_emitted` claim alone
to decide "already live" without ever reading what `metrics.jsonl` actually contains. Fixed:
`plan_backfill` now groups by `(run_id, task_id)`, splits into independent `dispatch_attempt`
units only when EVERY event in the group carries an explicit, pairwise-distinct `dispatch_attempt`
(exactly what the fixed bridge always emits going forward — anything else is reported ambiguous,
never booked), and scans `metrics.jsonl` once (`existing_nested_coverage`) for rows that already
cover a `(run_id, parent_task_id)` — by `nested: true` flag or by `nested:{run}:{parent}:` record_id
prefix — before ever attempting to book anything for it. Dispatches recovered with NO
`nested_cost_usd` aggregate to check against are booked but labelled `backfill_evidence:
'event_log_only_no_aggregate'` and reported in their own "unverifiable total" bucket, separate from
`backfill_evidence: 'reconciled_with_aggregate'` — never conflated into one recovered-dollar figure.

**S1 (blocking) — no defense against a symlinked canonical stream/index/lock/`runs/`.** The
original script read/wrote `metrics.jsonl`/`events.jsonl`/`runs/<run>/<task>.events.jsonl` by path
alone; any of them being a symlink to somewhere outside the state root (accidental or adversarial)
would have this script read or overwrite arbitrary filesystem content while believing it was
operating on an isolated copy. Fixed: `reject_symlink_escape` refuses a state root outright if
`metrics.jsonl`, `events.jsonl`, the record-id index checkpoint, the writer-lock file, or `runs/`
itself resolves (by realpath) outside the state root — checked once at start, and again immediately
before the backup/write step (defense against a TOCTOU symlink swap). Individual run
directories/logs inside `runs/` get their own, per-access check (S4, below) rather than an eager
walk of a potentially 1.5 GB tree.

**S2 (blocking) — `--i-understand-production` let `--apply` target the real production root, and
only ever checked ONE of the two paths that mean "production."** The override flag existed
specifically to bypass the guard, and the guard itself only compared against the literal
`~/.local/state/coding-agent-orchestrator` path — never `orchestrator.runtime.default_state_root()`,
which honours `CODING_AGENT_ORCHESTRATOR_HOME` — so an operator with that variable set to anything
else entirely (e.g. a shared or CI-configured "default" state root) got no protection at all. Fixed:
the override flag is REMOVED entirely (there is no way to `--apply` against a protected root, ever);
`refused_production_root` compares the resolved `--state-root` by realpath against BOTH the
conventional root and whatever `default_state_root()` resolves to right now. Dry-run against a
protected root is still allowed (it writes nothing); only `--apply` is refused.

**S3/T6 (blocking) — no backup/rollback safety net for a script whose whole purpose is a batch
`metrics.jsonl` write.** The original script's backup was a plain `shutil.copy2` (no exclusivity,
no fsync, no manifest, no way to verify later that the backup still matches what was actually
backed up) and there was no rollback command at all — undoing an apply meant a human manually
`cp`-ing a backup file by filename convention, with nothing checking whether `metrics.jsonl` had
changed since. Fixed: `create_backup` copies+hashes `metrics.jsonl` into an exclusively-created
(`O_CREAT|O_EXCL`, pid+nanosecond-timestamped name, never overwrites) backup file, fsyncs it, and
writes a manifest (pre-apply sha256 + size) — all under the writer lock, with `write_batch`
called via `lock=False` inside that SAME lock hold (never re-entering `writer_lock`, which the
runtime module documents as unsafe). `--rollback <manifest>` takes the writer lock, refuses unless
`metrics.jsonl`'s current bytes up to the recorded pre-apply size still hash to the recorded
pre-apply sha256 (i.e. nothing but this script's own appended rows changed the file since the
apply), restores the exact pre-apply bytes atomically (temp file + `os.replace`), and rebuilds the
derived record index + ledger via `orchestrator.state.rebuild` — the same rebuild
`scripts/rebuild_ledger.py` invokes.

**S4 (blocking) — run ids and the resulting `runs/<run_id>/<task>.events.jsonl` paths were never
validated.** A `run_id`/`task_id` string read from `events.jsonl` (an append-only log, but not
one this script's own trust model should extend unconditional path-construction trust to) was
joined directly onto `runs/` with only cosmetic character substitution on the task-id half; a
crafted `run_id` of `..` or containing `/` could have escaped `runs/` entirely, and a symlinked
run directory or event-log file would have been followed transparently. Fixed: `valid_run_id`
requires a single safe path component (alnum-first, then alnum/`.`/`_`/`-`, no `/`, no `.`/`..`);
`safe_run_log_path` additionally lstat-checks the run directory and the log file for symlinks
(never followed, reported as `symlinked_run_dir`/`symlinked_run_log` and skipped) and verifies the
resolved path stays contained under `runs/`; `replay_nested_calls` opens the final file with
`O_NOFOLLOW` as a second, TOCTOU-closing layer on top of the lstat checks.

**S5 (blocking) — unbounded line/nesting/plan size.** The original script read every JSONL line
through `orchestrator.runtime.iter_jsonl`, which has no line-size cap (a single pathological line
would be read into memory whole) and no `RecursionError` handling (a deeply-nested JSON value would
crash the whole run), and kept no cap at all on how many dispatches/rows a plan could grow to.
Fixed: `iter_physical_jsonl`/`_iter_physical_jsonl_from_handle` bound every line to `MAX_LINE_BYTES`
(4 MiB; longer lines are drained without being held in memory and counted as `oversized_line`),
catch `RecursionError`/`ValueError`/`UnicodeDecodeError` per line (reported as `deep_nesting`/
`malformed_json`, never a crash), and preserve the PHYSICAL line number for every skip so
`backfill_source_line` always names the real line in the file (the original script's line counter
only incremented once per successfully-parsed record — off by however many blank/malformed lines
preceded it). `MAX_RETAINED_RECORDS` caps the number of tracked dispatch groups, the
existing-coverage index built from `metrics.jsonl`, and the final row count; exceeding any of them
raises `PlanTooLargeError` and aborts with nothing written, rather than growing an unbounded plan
in memory from a hostile or corrupt state root.

**Also fixed, same pass**: every cost value (a nested call's `usage.cost`, and the event's own
`nested_cost_usd` aggregate) is now required to be a finite, non-negative number
(`_finite_nonneg_or_none`) to count as a real measurement — inf/nan/negative read as unknown
(never as zero, never as "the dispatch had no cost"), matching the same honesty rule
`economics.cost_class`/`has_reported_tokens` already applies everywhere else in this codebase. An
aggregate that IS present but fails this check is reported ambiguous, never silently treated as "no
aggregate at all."

**Verification, this snapshot (R4/S1-S5 round; superseded numbers — see "Round 3 review fixes"
below for the current pass's verification run)**: `CODING_AGENT_ORCHESTRATOR_HOME=$(mktemp -d)
python3 -B -m pytest -p no:cacheprovider -q` → 766 passed; `bun test ./bridge` → 431 pass, 0 fail
(bridge untouched by this pass; unaffected); `./scripts/typecheck-bridge.sh --all` → PASS, 0
diagnostics.

## Round 3 review fixes (F1-F5 — follow-up to R4/S1-S5 above; escalated)

A third review round, this time of the R4/S1-S5 script itself and of `orchestrator/economics.py`'s
`nested_reconciliation`, found the in-place `--state-root [--apply|--rollback]` design was itself
the residual risk for a script whose whole purpose is preparing to mutate `metrics.jsonl`, plus one
dynamic-reconciliation gap and three hardening gaps in the script. All are fixed on this branch,
each with regression tests (`tests/test_backfill_nested_costs.py`, rewritten — 78 tests; 13 new
tests in `tests/test_economics.py`, now 59). No routing, model, verification, or bridge behaviour
is touched by any of these fixes.

**Design change — copy-then-backfill, never in-place (eliminates the backup/restore risk
entirely).** The R4/S1-S5 script's safety net for an in-place `--apply` was a backup + a
content-hash-checked `--rollback`: robust, but it means a bug ANYWHERE in that backup/restore path
could still corrupt the one copy of production-shaped data a human keeps around for exactly this
kind of recovery work — the failure mode the whole Phase 1 backfill rule ("backfills run only on a
copy, always") exists to avoid, just moved one level down into this script's own machinery instead
of requiring the operator to remember it. Fixed: the CLI is now `--source <state-root> [--output
<fresh-dir> --apply]`. `--source` is NEVER written to, in dry-run or `--apply` — there is no
in-place mode and no `--rollback` flag at all:

- Dry-run (default) reads `--source` directly and prints the plan; nothing is written, no lock
  file, no output directory.
- `--apply` refuses if `--output` already exists (created fresh with `os.mkdir(..., 0o700)`, never
  reused/overwritten) and refuses if the REALPATH of EITHER `--source` or `--output` equals, is
  inside, or contains the conventional production root or the runtime-resolved default — checked
  both directions (`refused_protected_root`), so an `--output` that is an ANCESTOR of production is
  caught exactly as surely as one pointed directly at it, and a `--source` that IS (or aliases)
  production is refused even though this script only ever reads `--source`.
- `--apply` then copies `--source` into the freshly created `--output` with the script's OWN
  lstat-based walker (`copy_source_tree`/`scan_source_tree`) — never `shutil.copytree`/`os.walk`,
  both of which follow symlinks by default unless every call site remembers not to. Only regular
  files and directories are ever copied; a symlink or special file (fifo/socket/device/unreadable
  entry) ANYWHERE in the source tree removes the entire partial `--output` this call created and
  aborts with a report naming every unsafe entry found (`UnsafeSourceTreeError`).
- Before ever calling `orchestrator.record_batch.write_batch` or `orchestrator.state.rebuild`,
  `prescan_output_streams` scans every stream those two shared modules read (`events.jsonl`,
  `metrics.jsonl`, `outcomes.jsonl` — `orchestrator.record_index.STREAMS`) with this script's own
  bounded parser. Neither shared module is modified: `RecordIndex._scan`
  (`orchestrator/record_index.py`) and `iter_jsonl_from`/`_replay_into`
  (`orchestrator/runtime.py`/`orchestrator/state.py`) use the standard library's unbounded `for
  line in handle`/`json.loads` and do not themselves catch `RecursionError`. An oversized line or a
  pathologically deep value in ANY of those three streams removes `--output` and aborts BEFORE
  either shared module is ever called (`OutputStreamHazardError`).
- Planning then runs against the OUTPUT copy (never `--source`) with the exact same `plan_backfill`
  dry-run uses, rows are appended through `write_batch`'s existing lock/atomic-append/dedup path
  (the writer lock lives entirely inside `--output`), and `orchestrator.state.rebuild` rebuilds the
  derived ledger/record index there.
- A manifest (`backfill-manifest-<timestamp>-<pid>-<nanoseconds>.json`, NEVER a fixed filename — a
  chained `--apply` copies a previous run's own manifest along with everything else, and a fixed
  name would collide with it) records `--source`'s path, sha256 of its three canonical streams,
  `--output`'s path, rows added, and the script's version, written inside `--output`.
- ANY failure after `--output` is created removes the entire directory before returning non-zero:
  either the run produces a complete, backfilled, verifiable `--output`, or `--output` does not
  exist at all — never a partial one.
- **Rollback is `rm -rf <output>`.** `--source` was never touched, so there is nothing else to undo.
- **Idempotency**: `--apply` with `--source` set to a PREVIOUS run's `--output` and a fresh
  `--output` adds ZERO rows — `existing_nested_coverage` finds the prior run's own durable rows in
  what is now its `--source` and skips re-booking them; verified end-to-end below (0 new rows,
  `metrics.jsonl` byte-identical to the first `--output`, two distinct manifests present — the
  first apply's own, carried over by the copy, plus this second apply's own).

**F1 (correctness, `orchestrator/economics.py`'s `nested_reconciliation`) — the dynamic
reconciler had NO equivalent of the backfill script's own "unprovable pair" ambiguity rule.** R4
taught the OFFLINE backfill script to refuse booking anything for a `(run_id, task_id)` group of
`dispatch_finished` events that cannot be proven separable into independent attempts (the exact
shape a pre-T1 quota-fallback cumulative-sum bug produces), but `nested_reconciliation` — which
runs dynamically, at EVERY dashboard build, over LIVE data — never got the same rule: it processed
events independently by `(run_id, task_id, dispatch_attempt)` with attempt defaulting to `0` when
absent, which is exactly what would let two events of an unprovable pair each independently claim
(or fail to claim) a residual against the SAME defaulted key, double-booking or otherwise
mis-attributing the gap if either event's aggregate happened to be a genuine, nonzero, unequal
number. Fixed: `nested_reconciliation` now groups every `dispatch_finished` event by `(run_id,
task_id)` FIRST, via a new `_separable_dispatch_group` that mirrors the backfill script's
`_separate_attempts` exactly (a single event is always separable; more than two is never provable;
exactly two is provable only when EVERY event carries an explicit, validated, pairwise-distinct
`dispatch_attempt`). A group that fails this test has NOTHING booked for ANY event in it, and is
reported once as a single `ambiguous` entry naming the event count and the total aggregate dollars
at stake (`'events'`, `'aggregate_usd'`) — a different shape from the pre-existing per-attempt
dollar-mismatch ambiguous entries, which both remain unchanged. On THIS document's snapshot this
changes `nested_reconciliation_ambiguous` from `0` to `16` in both states B and C (see the
Before/after table above) without moving any dollar total, because every flagged group here happens
to have `nested_cost_usd: null` on every event — but the fix exists for a snapshot where that is
NOT true. Tests: `tests/test_economics.py`'s `DynamicAmbiguityGroupingTests` (six cases: missing
attempt on both events, an old-bug-shaped cumulative pair with otherwise-complete detail coverage,
duplicate explicit attempts, more than two events, a malformed attempt on one event of a pair, and
a sanity check that the single-event majority case is unaffected).

**F2 (correctness, `replay_nested_calls`) — a later invalid cost observation could erase an
earlier valid one, unlike the live tracker it mirrors.** T5 fixed this exact bug in
`NestedCostTracker.observe` (the live bridge component) but the backfill script's own replay of
the SAME raw event shape had not been updated to match: `replay_nested_calls` unconditionally
overwrote a nested-call key's stored detail with each new observation, including when the new
observation's `usage.cost` was missing/invalid after an earlier one already reported a real number.
Fixed: the last VALID cost (and the `costReported` it earned) is now preserved across any later
observation carrying none of its own, while every other field (model, exitCode, stopReason,
`source_line`, …) still refreshes to the latest observation unconditionally — byte-for-byte the
same merge rule `NestedCostTracker.observe` applies. Test:
`ReplayNestedCallsTests.test_a_later_update_with_no_valid_cost_never_erases_an_earlier_reported_one`
(plus a sibling asserting two VALID costs never sum — the later one simply wins).

**F3 (hardening) — planning caps were enforced AFTER growing a structure, not before, and an
over-cap group retained every event rather than collapsing.** `replay_nested_calls`'s `latest` dict
and `_group_dispatch_finished_events`'s per-key event lists both grew without any cap of their own
(only the SEPARATE checks in `existing_nested_coverage`/the distinct-group count enforced a cap,
and even that checked `len(groups) >= cap` only for a key not yet present, which is correct but was
the ONLY cap in that function). Fixed: three independent caps, each enforced immediately BEFORE the
record it would gate is inserted, never after: (1) `replay_nested_calls(..., max_entries=...)`
raises `PlanTooLargeError` before a `max_entries`-th DISTINCT nested-call key is ever added to
`latest` (refreshing an already-tracked key never counts against the cap again); (2)
`_group_dispatch_finished_events(..., max_events_per_group=MAX_EVENTS_PER_GROUP)` (new constant,
default 8 — generously above the real maximum of 2) collapses a `(run_id, task_id)` key past that
cap into a bounded summary: further events for the SAME key are counted in a separate `overflow`
dict rather than appended to its list, and `plan_backfill`'s ambiguous entry for that key reports
the TRUE total event count (`len(group) + overflow[key]`) while never having held more than
`max_events_per_group` of them in memory; (3) `max_total_events` bounds the SUM of events retained
across ALL groups combined, independent of the per-group and distinct-group caps, so many
moderately-sized groups cannot exhaust memory even when no single one is individually huge.
Exceeding any of the three raises `PlanTooLargeError` and (under `--apply`) removes the partial
`--output`. Tests: `BoundedRetentionTests` (six cases, all using SMALL caps passed directly as
arguments rather than patched module constants, per-key refresh not counting against the cap, the
per-group collapse producing a correct total in the resulting ambiguous entry via `plan_backfill`,
and both the per-group and total-events caps firing before insertion).

**F4 (correctness/hardening) — `dispatch_attempt` was cast with a bare, uncaught-overflow
`int(...)`, and a non-integral float silently truncated into a false identity.** The old
`_dispatch_attempt_field`/`_dispatch_attempt` (`orchestrator/economics.py`) and their backfill-
script equivalents accepted anything `int()` would not raise on: `int(float('inf'))` actually
raises `OverflowError`, which neither function's `except (TypeError, ValueError)` caught — a
hostile or corrupted `Infinity` value would CRASH reconciliation rather than degrade to ambiguous.
`int(1.5)` truncates to `1` silently — a non-integral float would be trusted as a valid, distinct
attempt identity it was never entitled to be. Fixed: a new `_valid_dispatch_attempt` (defined
identically in both `orchestrator/economics.py` and `scripts/backfill_nested_costs.py` — keep both
updated together) accepts only a finite, integral number in `[0, 16]` (booleans excluded despite
Python's `bool`-is-an-`int` subtyping; an integral float like `1.0` is accepted as `1`; NaN,
±Infinity, `1.5`, strings, and anything outside `[0, 16]` all return `None`, never raise). Every
caller that used to default straight to `0` on ANY falsy/absent value now goes through this
validator first. Tests: `DispatchAttemptValidationTests` in both test files (ints/integral floats
in range accepted; out-of-range, non-integral float, Infinity/NaN, string, bool all rejected without
raising; a malformed value on one event of an otherwise-distinct pair makes the WHOLE pair
unprovable, not just that one event's identity).

**F5 (documentation correctness — this document).** Three claims in the R4/S1-S5-era "Before/after"
and "Backfill counts" material above did not hold up to direct re-verification and are corrected in
place (with the evidence for each right where the correction lives, not just asserted here): the
"17 old-bug cumulative-sum candidates" figure was actually 16 GROUPS plus one unrelated,
separately-tracked dollar-MISMATCH dispatch that this script's own `_print_plan` happens to print
under the same combined counter; the claim that those 16 groups' `nested_rows_emitted` "claims
happened to already be satisfied" is unsupported by the raw data (every event in every one of the
16 groups has `nested_rows_emitted: null` — there was never a claim, satisfied or not); and
`by_role.implementation_strong` for state C was arithmetically wrong ($202.49; corrected to
$178.05, cross-checked two independent ways — see the table note). The "unverifiable total" label
on the 58-dispatch event-log-only recovery bucket is now stated precisely: it means those rows have
no INDEPENDENT AGGREGATE to check the recovered per-task sum against, not that non-overlap with
EVERY cost row in the state root (in particular `session_ingest` rows) was proven — it was not;
`existing_nested_coverage` only ever checks overlap against rows shaped like a nested detail row
(`nested: true` or a `nested:{run_id}:{parent_task_id}:` `record_id` prefix), never against dollar
amounts or any other identity a `session_ingest` row might carry. Session-ingest overlap is not
EXPECTED here (every dispatched subagent runs with `--no-session`, so no session-log file the
session-ingest path scans for is ever written for one of these processes — see the "Why $596.68 is
not a corrected version of ~$155" paragraph above for the code citations) but that is a structural
reason to expect none, not a proof that none exists.

**Verification, this snapshot**: `CODING_AGENT_ORCHESTRATOR_HOME=$(mktemp -d) python3 -B -m pytest
-p no:cacheprovider -q` → 804 passed; `bun test ./bridge` → 431 pass, 0 fail (bridge untouched by
this pass; unaffected); `./scripts/typecheck-bridge.sh --all` → PASS, 0 diagnostics. Same-snapshot
re-run (this round's contract): dry-run against `/tmp/orch-snapshot-20260925T102729Z` directly,
`--apply --output /tmp/orch-backfill-out-1` (540 rows), chained `--apply --source
/tmp/orch-backfill-out-1 --output /tmp/orch-backfill-out-2` (0 rows — idempotent, `metrics.jsonl`
byte-identical to `/tmp/orch-backfill-out-1`'s), then `regenerate_dashboard.py` against a plain
`cp -a` copy (`/tmp/orch-snapshot-B`, state B) and against `/tmp/orch-backfill-out-1` (state C) —
see the Before/after table above for the resulting numbers.

## Round 4 review fixes (B1-B4/W1-W4 — follow-up to F1-F5 above)

A fourth review round, narrowly scoped to `scripts/backfill_nested_costs.py` and
`orchestrator/dashboard.py`'s `_parse_row_ts`, found four blocking gaps in the copy-then-backfill
contract itself plus four hardening gaps. All are fixed on this branch, each with regression tests
(`tests/test_backfill_nested_costs.py`, now 107 tests across 24 classes; `tests/test_dashboard_metrics.py`,
5 new tests). No routing, model, or bridge behaviour is touched by any of these fixes.

**TRUST CONTRACT (stated in full in the script's own module docstring — read it there for the
authoritative version).** `--source` must be a TRUSTED, IMMUTABLE snapshot copy, not a live,
concurrently-written production state root: this script now defends against `--source` changing
WHILE IT RUNS (W4's post-copy hash re-check), but a residual TOCTOU window between an ancestor
directory of `--source` being swapped out from under this process and the moment `--source` is
first resolved is ACCEPTED RISK under that contract, not something every read in this script
re-verifies from scratch. `--output`'s PARENT directory must likewise be a trusted directory: this
script creates `--output` itself (`os.mkdir(..., 0o700)`) and never follows a symlink while writing
into it, but does not defend against a hostile actor with write access to `--output`'s parent
racing this process. The symlink/special-file/TOCTOU defenses throughout this script exist to catch
MISTAKES and DATA CORRUPTION in an otherwise-trusted `--source`, not to make an adversarial
`--source` or `--output` parent safe to point this script at. Failure never deletes `--output` (see
B2 below) — a human is always able to inspect what a failed run left behind.

**B1 (blocking) — `--source`/`--output` overlap was never checked.** Nothing stopped a chained
`--apply` (or a plain mistake) from pointing `--output` back INSIDE its own `--source`, or
`--source` inside `--output`, which would start a self-referential copy: `copy_source_tree` walking
`--source` while ALSO writing into a directory that is itself part of `--source`'s own tree. Fixed:
`refused_source_output_overlap` computes `--output`'s realpath tolerantly (`_prospective_realpath`
resolves the PARENT's realpath and re-appends the basename, since `--output` does not exist yet)
and rejects, in `main()`, BEFORE `--output` is created, if it equals, is inside, or contains
`--source`'s realpath in EITHER direction. Tests: `SourceOutputOverlapTests` (output inside source
rejected before anything is created; source inside output rejected before anything new is written;
equal paths rejected; disjoint paths NOT flagged; `--source` verified untouched — its directory
listing is identical before and after the refusal in every case).

**B2 (blocking) — every failure path `shutil.rmtree`'d the partial `--output`, itself a destructive,
unattended action.** The round-3 design's safety promise ("either a complete `--output` or none at
all") was implemented by recursively DELETING `--output` on any failure, which is itself a
destructive action against a directory that may hold a partial but forensically useful copy, run
with no confirmation, on every single error path including ones with nothing to do with `--output`'s
own contents (e.g. a plan-size cap firing during `plan_backfill`). Fixed: this script NEVER
recursively deletes `--output`, on ANY failure path — all `shutil.rmtree` calls are removed
entirely (the `shutil` import itself is gone). On failure, `--output` is left in place exactly as it
stood at the moment of failure; a best-effort `INCOMPLETE` marker file is written inside it via the
directory's OWN file descriptor (`_open_directory_fd`, opened right after `os.mkdir` succeeded, kept
open in a `finally`), so the marker still lands in the actual created directory even across a
TOCTOU path swap; and the error message names `--output`'s path for a human to inspect or
`rm -rf` themselves. Writing the marker is itself best-effort (`_write_incomplete_marker` swallows
`OSError`) — it is a courtesy, never a requirement for `--output` to stay in place. Tests: every
existing "...and removes the partial output" test in `OutputCopySemanticsTests`/`PlanTooLargeTests`
is rewritten to assert the OPPOSITE (`output.exists()` is `True`, `(output / "INCOMPLETE").exists()`
is `True`), plus a new `SourceChangedDuringCopyTests` CLI case exercising the same marker behaviour
for the new W4 failure path.

**B3 (blocking) — the lstat walker ran interleaved with hashing/copying, and file opens for
hashing/copying used plain `open()`/`os.open(O_RDONLY)`, which can HANG on a FIFO with no writer.**
The round-3 `copy_source_tree` scanned (`scan_source_tree`) and copied in the same call, and
`_sha256_file`/`_copy_regular_file` opened `--source` files with a plain (or merely `O_NOFOLLOW`)
open — neither refused a FIFO, and opening the READ side of a FIFO with no writer connected blocks
INDEFINITELY under a normal blocking open. A `--source` containing a FIFO named exactly like one of
the three canonical streams (`events.jsonl`/`metrics.jsonl`/`outcomes.jsonl`) could hang this script
forever during hashing, before the lstat scan's own 'special' classification was ever consulted for
that specific call ordering. Fixed: (1) `main()` now runs `scan_source_tree` (with the W2 copy
budgets) to completion — and aborts on `unsafe` — BEFORE calling `hash_source_streams` or
`copy_source_tree` at all; (2) every file this script opens for hashing or copying now goes through
a new `_open_regular_nofollow` (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, immediate `fstat`+`S_ISREG` check,
`O_NONBLOCK` cleared again once confirmed regular): a FIFO is refused via the `fstat` check
INSTANTLY, without ever attempting to read it, and a symlink/special file that slipped past the
lstat scan via a TOCTOU race is still refused at open time. `_sha256_file` and `_copy_regular_file`
both use it now. Tests: `ScanBeforeHashingOrderingTests` (mocks `hash_source_streams` and asserts it
is NEVER called when the tree is unsafe); `SafeOpenForHashingAndCopyingTests` (a FIFO open on a
daemon thread joined with a 5s timeout — the thread must not still be alive, proving no hang;
`NotARegularFileError` raised; a symlink raises `OSError`; a plain regular file still reads
normally); `SourceStreamFifoAndSymlinkRejectionTests` (CLI-level: a FIFO named `outcomes.jsonl`
rejected within a 5s subprocess timeout, marker present; a same-tree, non-escaping symlinked
`outcomes.jsonl` — which `reject_symlink_escape` does NOT itself check, since it only names
`events.jsonl`/`metrics.jsonl`/the index/lock files/`runs/` — rejected via the lstat scan, marker
present).

**B4 (blocking, `orchestrator/dashboard.py`) — an offset-naive `ts` crashed the WHOLE dashboard
build comparing it against the aware `PROVENANCE_INTRODUCED_AT`.** `_parse_row_ts` parsed
`datetime.fromisoformat(...)` and returned whatever it got, aware or naive, depending on whether the
row's own `ts` string carried an offset. `_rate_provenance` then compares that value against the
aware `PROVENANCE_INTRODUCED_AT` (`ts > entry['_max_ts']`, `e['_max_ts'] < PROVENANCE_INTRODUCED_AT`)
— Python raises `TypeError: can't compare offset-naive and offset-aware datetimes` for exactly this
mix, taking down the ENTIRE dashboard build over one malformed row, not just that row's own
provenance label. Fixed: `_parse_row_ts` now returns `None` for a parsed-but-offset-naive
`datetime` (`parsed.tzinfo is None`), the same "unknown, never guessed" treatment it already gives
an absent/malformed `ts` — a naive-timestamped row's group reads `_ts_unknown=True`, which yields
`source_predates_provenance=False` (rendered as "source unknown", never "predates provenance
tracking", since that label requires an aware instant this function has none to justify it with).
Tests: `ParseRowTsOffsetNaiveTests` (naive ISO strings return `None`; aware ones still parse;
missing/malformed still return `None`; a `build_data` call over a fixture mixing a naive, an aware,
and an invalid `ts` in the SAME rate-model group must not raise, and must label that group "source
unknown").

**W1 (hardening) — the OUTPUT pre-scan skipped a final unterminated line that
`orchestrator.record_index.RecordIndex._scan` does NOT skip.** `iter_physical_jsonl` (correctly, for
its OTHER callers) never yields a final line with no trailing newline, matching the general
replayable-prefix contract `orchestrator.runtime.iter_jsonl_from` uses. But `RecordIndex._scan`
(never modified by this script) parses that torn/in-progress-write tail too — and does not itself
catch `RecursionError`. A hazard (deeply nested JSON) hiding ONLY in an unterminated final line of a
copied stream would sail through `prescan_output_streams` undetected under the old default, then
crash `write_batch`'s `RecordIndex` rebuild later, unguarded. Fixed: `iter_physical_jsonl` gained an
`include_final_unterminated` parameter (default `False`, preserving every other caller's existing
behaviour byte-for-byte); `prescan_output_streams` passes `True`. Tests: `FinalUnterminatedLineTests`
(default skips the final unterminated line; `include_final_unterminated=True` parses it; a deeply
nested unterminated tail is a hazard only when requested; `prescan_output_streams` itself catches
one; a full CLI `--apply` against a `--source` with a deep-nested unterminated tail in
`metrics.jsonl` aborts with a hazard report and an `INCOMPLETE` marker, never a crash).

**W2 (hardening) — no aggregate limit on how much `--apply` would copy.** A pathologically large or
hostile `--source` had no ceiling on total files or bytes copied. Fixed: `scan_source_tree` gained
`max_files`/`max_bytes` parameters (both `None`/unbounded by default, for the tests and any caller
that only wants the lstat classification), raising the new `CopyBudgetExceededError` immediately
from inside the walk — never finishing the walk first — the instant either budget is exceeded;
`copy_source_tree` enforces `max_bytes` AGAIN against bytes actually copied so far, so a `--source`
file that grows between the scan and the copy is still caught mid-copy. `main()` passes an internal
`MAX_COPY_FILES` constant (200,000, not flag-configurable) and a new `--max-copy-bytes` CLI flag
(default `DEFAULT_MAX_COPY_BYTES` = 20 GiB) to both. Tests: `CopyBudgetTests` (scan-time file-count
and byte-budget aborts; a budget-free scan still succeeds; `copy_source_tree`'s OWN running byte
check fires mid-copy even when the scan that produced its file list had no byte budget at all; CLI
`--apply --max-copy-bytes 5` aborts with a marker; CLI `--apply` with the generous default succeeds).

**W3 (hardening) — two remaining caps were checked AFTER inserting, not before.**
`existing_nested_coverage` added a key to `covered` and THEN checked `len(covered) > cap`; the two
`rows_to_add.extend(rows)` call sites in `plan_backfill` extended THEN checked
`len(rows_to_add) > MAX_RETAINED_RECORDS` afterward — both let an over-cap insertion happen
momentarily before raising, unlike every other cap in this script (F3's `replay_nested_calls`/
`_group_dispatch_finished_events`, already check-before-insert). Fixed: `existing_nested_coverage`
now checks `len(covered) >= cap` for a NOT-YET-tracked key before `covered.add(key)`; a new
`_extend_rows_checked(rows_to_add, rows, cap=...)` helper checks
`len(rows_to_add) + len(rows) > cap` before `rows_to_add.extend(rows)`, replacing both raw
`.extend()`+after-the-fact-check call sites. Tests: `CapsCheckedBeforeInsertionTests`
(`existing_nested_coverage` raises before an over-cap key is added, succeeds exactly at the cap;
`_extend_rows_checked` raises before extending — and leaves `rows_to_add` UNTOUCHED by the failed
attempt — and succeeds exactly at the cap).

**W4 (hardening) — nothing verified the COPY actually matches what was hashed before it started.**
`hash_source_streams(source)` ran before the copy for the manifest's provenance record, but nothing
re-checked that `output`'s just-copied streams still matched those hashes afterward — a `--source`
that changed WHILE this run was reading it (a residual risk even for a nominally "immutable"
snapshot, e.g. another process still finishing a write) would silently backfill against a copy that
no longer matches what the manifest claims `--source` contained. Fixed: a new
`verify_copied_stream_hashes(output, source_hashes)` re-hashes `output`'s canonical streams
immediately after `copy_source_tree` and raises the new `SourceChangedDuringCopyError` on the first
mismatch — before planning, before `reject_symlink_escape(output)`, before anything else touches the
copy. Tests: `SourceChangedDuringCopyTests` (direct mismatch/match unit tests on
`verify_copied_stream_hashes`; a CLI-level test that monkeypatches `copy_source_tree` to tamper with
the copied `metrics.jsonl` immediately after a real copy, simulating a mid-copy source change, and
confirms `--apply` aborts with `--output` left in place and an `INCOMPLETE` marker present).

**Verification, this round**: `CODING_AGENT_ORCHESTRATOR_HOME=$(mktemp -d) python3 -B -m pytest
-p no:cacheprovider -q` → 837 passed (up from 804: 107 in
`tests/test_backfill_nested_costs.py`, up from 78; 5 new in `tests/test_dashboard_metrics.py`); `bun
test ./bridge` → 431 pass, 0 fail (bridge untouched by this pass; unaffected);
`./scripts/typecheck-bridge.sh --all` → PASS, 0 diagnostics. Same-snapshot re-run (this round's
contract, unchanged): dry-run against `/tmp/orch-snapshot-20260925T102729Z` directly (18 reconciled
dispatches/167 rows, 58 unverifiable-total dispatches/373 rows, 17 ambiguous, 540 total planned
rows — unchanged from round 3), `--apply --output /tmp/orch-backfill-out-r4` (540 rows,
`source_sha256` in the manifest byte-identical to a direct sha256 of `--source`'s three streams both
BEFORE and AFTER the apply — `--source` verified untouched), scratch output removed
(`rm -rf /tmp/orch-backfill-out-r4`) afterward per this round's own housekeeping.

# Progress-Aware Dispatch Timeout — Contract

**Scope:** `bridge/extensions/orchestrator/` (HT extension bridge). Replaces the fixed
90-minute wall clock for orchestrating capabilities (`lead`, `architect`,
`technical_lead`) with (a) a meaningful-progress inactivity timeout and (b) a
separate, configurable absolute safety ceiling. Leaf dispatches keep their
existing fixed wall clock.

**Out of scope:** per-turn dashboard synchronization (separate plan, not implemented here).

## 1. Configuration

All values are read from `process.env` **at dispatch time** (not module load), so
tests and operators can change them without reloading the extension. Invalid
values (non-numeric, ≤ 0, NaN) fall back to the default and produce a note.

| Variable | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS` | leaf | 20 min | Unchanged. Fixed wall clock; no inactivity rule. |
| `HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS` | orchestrating | 20 min | Kill when no *meaningful progress* for this long. |
| `HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS` | orchestrating | 6 h | Absolute ceiling measured from spawn. Never resets. |
| `HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS` | orchestrating (legacy) | — | If set and `LEAD_MAX_TIMEOUT_MS` is unset, it becomes the absolute ceiling (compat). A note is logged. |

Validation rules:
- `absoluteMs` must be ≥ `inactivityMs`. If not, `inactivityMs` is clamped down to
  `absoluteMs` and a note is recorded. The ceiling is never raised implicitly.
- Leaf dispatches retain `inactivityMs = Infinity`, `absoluteMs = DISPATCH_TIMEOUT_MS`, and a fixed wall-clock `setTimeout`; the progress tracker still observes them for UI reporting but does not control their timeout.

## 2. Meaningful progress (resets the inactivity clock)

Only **validated, novel work** counts. Everything else is heartbeat/noise.

| Child event | Counts as progress when | Does NOT count when |
| --- | --- | --- |
| `tool_execution_start` | Fingerprint `toolName + stable JSON(args)` is not a loop-suspect (see §3). | Fingerprint is a loop-suspect. Malformed (missing `toolName`). |
| `tool_execution_end` | `isError !== true` **and** the matching `toolCallId` (or, absent id, the most recent start) was counted — i.e. successful completion of counted work. Also: subagent tool end (nested child finished). | `isError === true` (failed tool call is a heartbeat only). |
| `message_end` (assistant) | Text content hash differs from the previous assistant text hash **and** text is non-empty. | Identical text as previous assistant message; empty text; usage/token growth alone. |
| `message_start` / `tool_execution_update` (non-nested) | — | Never. Pure heartbeat. |
| `tool_execution_update` with `partialResult.details.results[]` (nested workers) | For some nested result `r` (keyed by `r.taskId`): first sighting; `r.usage.turns` increased; `r.exitCode` transitioned from `-1` (running) to terminal; `latestText` hash changed. | Snapshot identical to the previous one for every taskId; only `usage.input/output/cost/contextTokens` changed. |
| `agent_end`, `agent_settled`, `turn_end`, unknown types, unparseable lines | — | Never (terminal events resolve the dispatch anyway). |

Definitions:
- **Heartbeat**: any well-formed event — proves the process is alive, does not reset inactivity.
- **Token growth**: increases in usage counters without a new turn or new text. Not progress.
- **Repeated output**: assistant text or nested `latestText` identical (by hash) to the immediately previous value for that identity. Not progress.

## 3. Loop detection

Keep a rolling window of the last **12** tool-call fingerprints per dispatch. A
new fingerprint is a **loop-suspect** if it already appears **≥ 3 times** in the
window. Loop-suspects are recorded (`kind: "loop"`) but do not reset inactivity.
Rationale: `edit → bun test → edit → bun test` alternates fingerprints and stays
under threshold; `bash ls` × 4 with nothing in between does not.

Nested workers: a `tool_execution_update` whose per-taskId snapshot is byte-identical
to the previous snapshot is `kind: "duplicate"`. Duplicates never invent progress
and never create new worker rows.

## 4. Absolute ceiling

- Measured from spawn (`startedAt`). Never reset by any event.
- Expiry reason `"absolute"`; message: `dispatch exceeded absolute ceiling <duration> (capability=…)`, with durations below 60 seconds in seconds and longer durations in whole minutes.

## 5. Inactivity expiry

- Expiry reason `"inactivity"`; message: `dispatch timed out after <duration> without meaningful progress (last progress: <detail> <duration> ago; capability=…)`, with durations below 60 seconds in seconds and longer durations in whole minutes.
- Both reasons exit `124` and classify as `timed_out` (existing `classifyDispatchOutcome`). The result gains `timeoutReason?: "inactivity" | "absolute"`.

## 6. Warnings (rate-limited, actionable)

- Inactivity warning when `inactiveMs ≥ 0.75 × inactivityMs` — fires **once per inactivity period** (re-arms after the next progress reset).
- Absolute warning when `elapsed ≥ 0.9 × absoluteMs` — fires **once per dispatch**.
- `TimeoutCheck.warnings` contains structured `{ kind: "inactivity" | "absolute", text }` values. Text names the limit, remaining time, and the env var that raises it, e.g.
  `⚠ no meaningful progress for 23min (limit 30min; 7min remaining; raise HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS) — last: bash bun test`.
- Durations below 60 seconds render in seconds (`34s`); durations of 60 seconds or more render as whole minutes (`30min`).
- Surfaced via `session.log(...)` and the dispatch's UI row (`DispatchProgressView.warning`); no dashboard sync.

## 7. Cancellation

User cancellation (`RunCancellation`) remains immediate: process-group kill, timers cleared, dispatch status `cancelled`, **no timeout note**. Cancellation is passed to `classifyDispatchOutcome` as `cancelled: true`, which wins before recovery and returns status `cancelled` with effective exit code `137`. The explicitly `UNVERIFIED PARTIAL WORK — cancelled` interruption report is still recorded once. Cancellation wins over any timer that fires concurrently (`settled` guard).

## 8. Interruption report (partial work, unverified)

On `timed_out` or `cancelled`, the dispatch result keeps whatever assistant text was
captured (`stdout`, `finalText`) and the run's lead report puts a blockquote marker
`> UNVERIFIED PARTIAL WORK — <reason>` immediately above the `### taskId` header.
Interrupted leads never count toward `succeededLeads`, and verification verdict is never
`PASS` on their evidence alone. Reasons stay distinct: `cancelled`, `inactivity`, and
`absolute`.

## 9. Timer semantics (integration)

- Leads use the progress-aware tracker timer, armed to `min(inactivityRemaining, absoluteRemaining)`.
- Leaves use a fixed wall-clock `setTimeout`; their tracker is used for UI reporting only.
- On a lead timer fire: query the tracker with the real clock; if expired → kill + `finish(124)`; otherwise re-arm (progress happened since arming). This is robust to event bursts and never leaves a stale timer.
- `finish()` clears the timer and the cancellation listener exactly once (existing `settled` guard).
- Child-tree teardown continues to use `killProcessTree` (process-group kill).

## 9a. Reconciliation with `docs/superpowers/plans/2026-09-23-progress-aware-timeout.md`

A parallel lead drafted a sibling contract plus integration tests in `index.test.ts`. Merged decisions:
- `runSubagentProcess` accepts test seams `leadTimeouts?: { inactivityMs: number; maxMs: number }` (overrides env for orchestrating capabilities) and `session?: RunSession` (overrides `ACTIVE_RUN`).
- Interruption notes/log lines start with `UNVERIFIED PARTIAL WORK — <inactivity|absolute|cancelled>` and include `repeatedToolCalls: N` (count of loop-suspect tool calls) — see the plan doc's `buildInterruptionReport` schema; it lives in `dispatch-progress.ts`.
- Nested worker UI summary format: `N worker(s) (T turns)` counted by distinct `taskId`.
- Final merged decisions where the two differed: **20 min** inactivity default (sibling plan; equals the former leaf clock); ceiling is **never raised implicitly** — inactivity is clamped down to it (this document); warning thresholds 75 % / 90 %; loop window 12 / ≥3 occurrences. `resolveLeadTimeoutConfig` and `applyLeadTimeoutOverride` are thin wrappers over the single resolver `resolveDispatchTimeoutPolicy`.

## 10. Test matrix (fake clock unless noted)

| Case | Expectation |
| --- | --- |
| active | Progress every 10 min for 3 h → survives 90 min; expires only at the ceiling (`absolute`). |
| idle | No events after spawn → expires at `inactivityMs` (`inactivity`); warning at 75 %. |
| looping | Same tool fingerprint ×4, identical assistant text → not progress → `inactivity` expiry. |
| cancelled | Cancel at t+5 min → immediate kill, no timeout, timers cleared, status `cancelled`. |
| nested | Snapshot with new turns → progress; identical snapshot → duplicate; two taskIds → two workers, not four. |
| config | Legacy `LEAD_TIMEOUT_MS` honoured as ceiling; garbage → defaults; inactivity > ceiling → clamped. |
| leaf | Unchanged fixed clock. |
| process (real, short) | Fixture child that goes silent is killed at a 300 ms inactivity limit with the `inactivity` note; a chatty fixture is killed at a 700 ms ceiling with the `absolute` note. |

## 11. Progress reporting (Lead B — run UI + run.log; NO dashboard sync)

Ownership: `bridge/extensions/orchestrator/run-ui.ts` (pure view-model + formatters, no
runtime imports) and the `RunSession` class region of `index.ts` (`DispatchProgress`,
`recordProgress`, `render`). The tracker (`dispatch-progress.ts`) stays the single source of
truth for what counts as progress; the UI never re-derives progress from raw events.

### Integration hook (Worker A2 must call this)

```ts
// index.ts — RunSession
recordProgress(taskId: string, observation: ProgressObservation, check: TimeoutCheck, now = Date.now()): void
```

Call once per parsed child event, right after `tracker.observe(event, now)` and
`tracker.check(now)` (and also from the re-armed timer tick with a synthetic
`{ kind: "heartbeat", detail: "timer" }` observation so warnings surface even when the
child is silent). `onChildEvent(taskId, event)` remains as-is for tool/turn counters.

### View-model (`run-ui.ts`)

```ts
interface NestedWorkerRow { taskId; agent; depth; turns; exitCode; finished; costUsd; latestText; firstSeenAt; lastChangedAt }
interface DispatchProgressView {
  lastProgressAt: number; lastProgressDetail: string;
  loopSuspects: number; duplicateSnapshots: number;
  warning?: { text: string; at: number; kind: "inactivity" | "absolute" };
  nested: Map<string, NestedWorkerRow>;   // keyed by nested taskId — stable identity
}
applyObservation(view, observation, now): void
applyWarnings(view, warnings: TimeoutWarning[], now, log: (line: string) => void): void
formatProgressLine(view, now, indent): string | undefined
formatNestedWorkerRows(view, now, parentDepth): string[]
formatWarningLine(view, now, indent): string | undefined
```

Rules:
- Nested rows are upserted by `snapshot.taskId`. A snapshot with `changed === false` MUST NOT
  create a row, bump `lastChangedAt`, or alter turns/text (dedup contract). Turns never regress;
  empty-text/lower-turn snapshots and terminal-to-running snapshots are placeholders, ignored
  without progress. Latest text replaces stored text only when non-empty and its hash differs.
  `taskEvents` completion (`type: "complete"`; leniently also `completed`/`done`/`end`) marks
  an existing worker `finished: true`, and that transition is progress. Finished is also true
  when `exitCode !== -1` and never regresses. Keep at most 32 rows, evicting oldest first;
  re-sighting an evicted identity does not count as progress.
- `lastProgressAt/Detail` update only on `kind === "progress"`. `loop` and `duplicate`
  increment counters only. `heartbeat`/`ignored` change nothing.
- Warnings: the tracker already rate-limits (§6). `applyWarnings` uses the structured kind,
  additionally suppresses logging identical warning text within 5 min, keeps only the latest
  warning per dispatch, and clears the inactivity warning on the next `progress` observation.
  Warning text is whitespace-collapsed before it is logged. `DispatchProgressView.warning` is
  the single UI warning source. Warning and expiry durations share one formatter: under 60
  seconds renders as seconds; 60 seconds or more as whole minutes. Elapsed UI ages retain their
  compact `3m12s` style.
- Rendered evidence (running rows only): `↳ progress 3m12s ago: bash bun test · 2 loop-suspect
  calls`; nested rows `⠋ orch-scout            t12   $0.0210  latest: …`; `✓` for success or
  task-event completion, `✗` for terminal failure; warnings as `⚠ …` under the row. Text
  truncated to keep rows < 120 cols.
- Nothing here writes to the dashboard, metrics, or Python state — run UI and run.log only.

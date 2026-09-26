# Progress-Aware Orchestration Timeout — Contract

**Status: completed.** Merged into `main` via `4ab0fba` (`feat/progress-aware-timeout`, `cb9f51e`).

**Goal:** Replace the lead's fixed 90-minute cancellation (`LEAD_DISPATCH_TIMEOUT_MS` in
`bridge/extensions/orchestrator/index.ts`) with (a) a meaningful-progress inactivity timeout and
(b) a separate, configurable absolute safety ceiling. Report active worker progress and
warnings. Preserve an accurate, explicitly *unverified* partial-work report on interruption.

**Out of scope:** per-turn dashboard sync (`2026-09-23-per-turn-dashboard-sync.md`). Leaf
dispatch timeout (`HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS`, 20 min fixed wall clock) is
unchanged.

## Module layout

- `bridge/extensions/orchestrator/dispatch-progress.ts` (new, pure, clock-injected) — config
  parsing, `DispatchProgressTracker`, interruption report builder.
- `bridge/extensions/orchestrator/dispatch-progress.test.ts` (new) — unit tests.
- `bridge/extensions/orchestrator/index.ts` — wire tracker into `runSubagentProcess` for
  orchestrating capabilities (`lead`, `architect`, `technical_lead`); extend `RunSession`
  (`DispatchProgress`, `onChildEvent`, `render`) with progress/warning display.
- `bridge/extensions/orchestrator/index.test.ts` — integration tests (active, idle, looping,
  cancelled, nested-worker).

## Configuration (env, all validated via `positiveIntEnv`-style parsing; invalid → default)

| Env | Meaning | Default |
| --- | --- | --- |
| `HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS` | Kill an orchestrating dispatch after this long with **no meaningful progress**. | `20 * 60 * 1000` (same as leaf timeout) |
| `HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS` | Absolute wall-clock ceiling; never reset by progress. | `HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS` if set (legacy compat), else `6h` |
| `HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS` | **Legacy.** Previously the fixed lead deadline. Now only seeds the absolute ceiling default. | unset |

Validation: if ceiling < inactivity, the inactivity window is clamped down to the ceiling (the
safety ceiling is never raised implicitly) and a one-line note is emitted on the dispatch stderr
capture / run log. See `docs/superpowers/specs/2026-09-24-progress-aware-timeout-contract.md` §9a
for the reconciled decisions (warning thresholds 75 %/90 %, loop window 12/≥3).

## Meaningful progress and nested workers

The reconciled behavior is defined by `docs/superpowers/specs/2026-09-24-progress-aware-timeout-contract.md` §§2, 3, and 9a; that contract is authoritative over this planning draft. Its relevant values are a rolling 12-fingerprint window with loop suspicion at ≥3 occurrences, assistant-text comparison against the previous-text hash, 32 nested worker rows with monotonic placeholder/finished-state merging, and warning thresholds at 75% / 90%.

## Timing semantics

- `inactivityDeadline = lastProgressAt + inactivityMs`; `absoluteDeadline = startedAt + maxMs`.
- Expiry reason: `"inactivity"` when `now >= inactivityDeadline`; `"absolute"` when
  `now >= absoluteDeadline`. Absolute checked first if both.
- Warning and nested-row limits follow contract spec §9a (75% inactivity / 90% absolute; 32 rows).
- Cancellation (`RunCancellation`) remains immediate and independent of the tracker.
- Timers/listeners are cleaned up exactly once in `finish()`; `killProcessTree` semantics
  unchanged.

## Interruption report schema (`buildInterruptionReport`)

Emitted on `timed_out` (inactivity or absolute), and on cancellation, as the dispatch note /
stderr capture and into `run.log`. Fields (all present, never fabricated):

```ts
interface InterruptionReport {
  taskId: string;
  reason: "inactivity_timeout" | "absolute_timeout" | "cancelled";
  elapsedMs: number;
  sinceLastProgressMs: number;
  turns: number;
  toolCalls: number;
  repeatedToolCalls: number;
  lastProgress: string | undefined;   // short human description, e.g. "tool read index.ts"
  nestedWorkers: Array<{ id: string; turns: number; finished: boolean }>;
  partialText: string;               // last assistant text, truncated to 2000 chars, may be ""
  verified: false;                   // literal false — never claims completion
}
```

Rendered on stderr and recorded in `run.log` and `result.interruption`; the one-line `summarizeInterruption` output is used as the `endDispatch` note.

## Test commands

```bash
cd bridge && bun test extensions/orchestrator            # all bridge tests (baseline 134 pass)
cd bridge && bun test extensions/orchestrator/dispatch-progress.test.ts
cd bridge && bunx tsc --noEmit -p . 2>/dev/null || true  # only if a tsconfig exists
```

## Working-tree protection

Implementation lives in worktree `.worktrees/progress-aware-timeout` on branch
`feat/progress-aware-timeout`. The main checkout's pre-existing changes (modified
`2026-09-23-headless-dispatch-shutdown-recovery.md`, untracked `2026-09-23-per-turn-dashboard-sync.md`)
must not be touched. Do not merge or push.

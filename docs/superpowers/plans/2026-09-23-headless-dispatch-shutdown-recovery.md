# Headless Dispatch Shutdown Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make headless orchestrator dispatch preserve an authoritative completed child result while accurately reporting later process/cleanup failures, and fix the confirmed HUMAIN Terminal shutdown defect when reproducible.

**Architecture:** Use separate feature worktrees for the orchestrator skill and HUMAIN Terminal. First preserve and review the existing in-progress bridge diff, then use three read-only reconnaissance workers and the bridge's bounded stderr capture to localize the child failure. Keep task completion separate from process health; only change HT at a reproduced failure site, and test both sides of the child-process boundary.

**Tech Stack:** TypeScript, Bun tests in the orchestrator bridge, Vitest and npm package scripts in HUMAIN Terminal, HT `--mode json` child process protocol.

**Spec:** `docs/superpowers/specs/2026-09-23-headless-dispatch-shutdown-recovery-design.md`

## Status: EXECUTED AND MERGED — root cause still unverified

Tasks 1, 2, 3, 4 and 6 are complete; **Task 5 is not applicable**. Merged into skill
`main` as `67b78c7` (`Merge branch 'fix/headless-dispatch-shutdown-recovery'`). The
conflict in `bridge/extensions/orchestrator/index.ts` was resolved by keeping both
main's `depth?: number` UI option and the feature's `spawnChild?: ChildSpawner` seam.

Verification recorded at merge time: bridge suite 65/65, Python suite 79/79. On
current `main` the same code is covered by 353 bridge tests and 637 Python tests,
all passing, with `./scripts/typecheck-bridge.sh --all` clean.

**What this work did *not* establish.** The originally reported HT shutdown/silent-exit
behaviour **did not reproduce** against the rebuilt current HT runtime (Task 4: bounded
probe exited 0 with terminal success events and empty stderr). So Task 5 made no HT
source change, by design. The root cause remains **unverified** — not fixed, not
confirmed absent. What shipped is the bridge-side contract: a completed child result
survives a later non-zero exit, while the process failure stays visible. If the symptom
recurs, reopen at Task 4 with a fresh probe rather than treating this plan as closed.

Full evidence: `.superpowers/sdd/2026-09-23-headless-dispatch-shutdown-recovery/`
(`progress.md`, `final-fix-report.md`, `final-review-report.md`) — untracked, local only.

## Global Constraints

> **Historical.** These governed execution and are kept as the record of what the work
> was allowed to touch. The worktree and baseline constraints below are now obsolete:
> see the re-baseline note at the end of this section.

- A non-zero process exit is recoverable only when the child proves final assistant text, `stopReason: "stop"`, and `agent_settled`, without timeout or spawn failure.
- A failure before authoritative completion, a timeout, a spawn failure, or an error/aborted stop reason remains a failed dispatch.
- Do not add a process-global uncaught exception or unhandled rejection handler.
- Treat the bridge fixes in commit `39db7ec` as the current skill-side baseline; do not reimplement or overwrite them.
- Preserve any concurrent staged, unstaged, or untracked changes in the skill main checkout; do not overwrite, stage, or transfer them into this branch. At latest check its only local change is the plan document; other commits are already on main.
- Preserve untracked `packages/coding-agent/test-prod-loader.mjs` in the HT main checkout; do not copy, edit, or clean it. **Discharged:** that file was committed by its owner in HT `81a6676b4` ("include usage spec and loader smoke test") and is now tracked and clean, so there is no longer an untracked file to preserve.
- Do not delete or modify unrelated scratch files or other worktrees.
- Do not make speculative HUMAIN Terminal source changes if the reported shutdown failure cannot be reproduced. **This constraint decided the outcome** — see Task 5.
- Use one separate worktree per repository and keep changes/commits on the feature branches, not the main checkouts.

### Re-baseline (superseded constraints)

The constraint "the skill feature branch is based at `39db7ec`; the skill main checkout
has since advanced to `fbdd610` … do not merge or rebase onto those commits until the
user chooses integration" is **discharged**. The user chose local merge; the branch was
merged as `67b78c7`. It is removed rather than left in place, because as written it now
reads as a standing prohibition on integrating work that is already integrated.

Current state, for anyone reopening this:

- `39db7ec`, `fbdd610`, `391051f`, `cc9836d` and the branch tip `4ee638b` are **all
  reachable from `main`**. `git log main..fix/headless-dispatch-shutdown-recovery` is
  empty — the branch has nothing unmerged and exists only as a label.
- `main` has since advanced well past `fbdd610`, absorbing parent-owned recon
  (`feat/enforced-worker-topology`), orchestrator efficiency/evidence, progress-aware
  lead timeouts, and economics phase A. The `ChildSpawner` seam and
  `dispatch-outcome` recovery introduced here survived every one of those merges.
- **Both `.worktrees/headless-dispatch-shutdown-recovery` worktrees are gone.** At merge
  time cleanup was blocked by Supacode 0.10.8 locks and deliberately not forced; they
  were removed later by their lock owner. `git worktree list` now shows only the main
  checkout in each repo. Re-create them per the map below if this work reopens.
- HT main is at `81a6676b4`, far past the recorded `c67014b9d` baseline (Pi 0.87.1 sync
  and later). Any new HT-side probe must rebuild before drawing conclusions.

## Review Focus

- Final assistant text with successful stop but no `agent_settled` must still fail — pin in the bridge event/outcome integration test (Task 3).
- `agent_settled` after an error/aborted stop must not be treated as successful completion — pin in the bridge event/outcome integration test (Task 3).
- A child timeout after partial output must remain `timed_out`, not recovered — retain/add classifier and process fixture coverage (Task 3).
- Disposal or stdout-flush failure after a successful JSON result must remain observable and must not erase the task response — pin at the reproduced HT shutdown seam (Task 5).
- Malformed or oversized child events/stderr must not throw from a stream listener or cause unbounded capture — pin with the existing bridge stream/capture tests after reconciling the user diff (Task 3).

---

## File and Worktree Map

Create worktrees at execution time using `superpowers:using-git-worktrees`. **Both were
created, used, and have since been removed** — the paths below are the recipe to
recreate, not a description of the current filesystem.

- Orchestrator skill source: `/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator`
  - New worktree: `/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery`
  - Branch: `fix/headless-dispatch-shutdown-recovery`
  - Relevant bridge implementation/tests: `bridge/extensions/orchestrator/index.ts`, `index.test.ts`, `dispatch-outcome.ts`, and `dispatch-outcome.test.ts`.
- HUMAIN Terminal source: `/Users/abdulkarim/Documents/Projects/humain-terminal`
  - New worktree: `/Users/abdulkarim/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery`
  - Branch: `fix/headless-dispatch-shutdown-recovery`
  - Likely lifecycle implementation/test: `packages/coding-agent/src/modes/print-mode.ts`, `packages/coding-agent/test/print-mode.test.ts`, and only the additional source/test files identified by reproduction.

The bridge edits originally present in the skill checkout were committed as `39db7ec` during setup. The HT progress-payload changes were committed on main as `c67014b9d` while the worktree was prepared. Both commits are baselines already included in their respective feature worktrees, not uncommitted changes to port. The skill main checkout retains the untracked plan file; the HT main checkout retains the untracked `packages/coding-agent/test-prod-loader.mjs`.

**Since execution:** neither preserved file is untracked any more. This plan document was
deliberately kept out of the `67b78c7` merge and is now committed on its own;
`test-prod-loader.mjs` was committed by its owner in HT `81a6676b4`. Both preservation
constraints are therefore discharged rather than still binding.

## Task 1: Establish isolated worktrees and preserve current state

**Files:** No product source changes. Worktree metadata only.

- [x] **Step 1: Record both repository baselines**

```bash
for repo in "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator" "$HOME/Documents/Projects/humain-terminal"; do
  git -C "$repo" status --short
  git -C "$repo" rev-parse HEAD
  git -C "$repo" worktree list
 done
```

Expected: record the current skill and HT main checkout states, including any staged/unstaged concurrent changes and untracked files; do not stash, reset, or clean either checkout.

- [x] **Step 2: Verify committed bridge work was incorporated**

```bash
SKILL="$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator"
SKILL_WT="$SKILL/.worktrees/headless-dispatch-shutdown-recovery"
git -C "$SKILL" show --stat --oneline 39db7ec
git -C "$SKILL_WT" merge-base --is-ancestor 39db7ec HEAD
```

Expected: commit `39db7ec` is present in the feature worktree; the earlier saved bridge patch hash in the SDD ledger matches the committed `ffb02fe..39db7ec` changes, so no duplicate patch is applied.

- [x] **Step 3: Create two independent feature worktrees**

Invoke `superpowers:using-git-worktrees` and create a new branch/worktree in each repository at the paths in the File and Worktree Map. Base each on its current committed `HEAD`; do not use `git stash` or alter the main checkout.

Expected: `git worktree list` shows both isolated paths and both main-checkout `git status --short` outputs are unchanged.

- [x] **Step 4: Confirm repository baselines are current**

Run `git -C "$SKILL_WT" log -1 --oneline` and `git -C "$HT_WT" log -1 --oneline`. If either main checkout advanced after worktree creation, compare the new commits to the recorded baseline; fast-forward the feature worktree only when the changes are already committed and there are no feature-branch conflicts. Never transfer uncommitted user changes without evidence and explicit direction.

Expected: skill worktree contains `39db7ec`; HT worktree contains `c67014b9d`; original checkouts and their untracked files remain unchanged.

## Task 2: Reconnaissance before implementation

**Files:** Read-only inspection in both worktrees; no product edits.

- [x] **Step 1: Dispatch three independent read-only reconnaissance workers in parallel**

Use the orchestrator's `analysis_mid` or `implementation_fast` capability at low/medium effort. Give each a single bounded question and require a structured evidence packet capped at 2,000 tokens:

1. HT lifecycle: trace `runPrintMode()` through `runtimeHost.dispose()` and `flushRawStdout()`, locate tests and identify plausible failure sites only from code evidence.
2. Bridge child protocol: trace stdout/stderr callbacks, JSON event extraction, settlement criteria, process close/timeout paths, and current tests; compare the preserved diff against these flows.
3. Reproduction/build: identify the exact CLI entry/build path used by orchestrator dispatch, the recorded old run artifacts still available, and a safe minimal headless repro command using existing local configuration.

Expected: three packets with paths, facts, tests, and uncertainty; workers make no edits. Lead synthesizes the packets before implementation begins.

- [x] **Step 2: Run focused baseline tests in the two worktrees**

```bash
cd "$HOME/Documents/Projects/forge" && bun test "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/dispatch-outcome.test.ts" "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/index.test.ts"
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery/packages/coding-agent" && npm run test -- test/print-mode.test.ts
```

Expected: establish a clean baseline. Record any pre-existing failures exactly; do not fix unrelated tests here.

## Task 3: Prove bridge process/event handling conservatively

**Files:**
- Modify if needed: `bridge/extensions/orchestrator/index.ts`, `bridge/extensions/orchestrator/dispatch-outcome.ts`
- Test: `bridge/extensions/orchestrator/index.test.ts`, `bridge/extensions/orchestrator/dispatch-outcome.test.ts`
- Create: `bridge/extensions/orchestrator/fixtures/child-exit-after-settle.mjs`

**Interfaces:**
- Consumes: existing `classifyDispatchOutcome()` input/status contract and current child event parsing.
- Produces: testable process/event handling that preserves valid completion and reports process-health errors without loosening the terminal evidence predicate.

- [x] **Step 1: Add a failing process/event regression test and deterministic child fixture**

Add a deterministic local child fixture and write an `index.test.ts` regression test first. The test should call the dispatch runner with an optional injected child-spawn dependency (the dependency does not exist yet; do not add production code in this step). Assert returned final text, `processExitCode: 1`, `outcome: "completed_after_process_error"`, and `stderr` containing `fixture shutdown failure`.

Fixture contents:

```js
const events = [
  {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "fixture task completed" }],
    },
  },
  { type: "agent_end", messages: [] },
  { type: "agent_settled" },
];

for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
process.stderr.write("fixture shutdown failure\n");
process.exitCode = 1;
```

Add adjacent negative cases using the same runner for missing settlement, missing final text, `stopReason: "error"`, and spawn failure. Keep timeout behavior covered by `classifyDispatchOutcome.test.ts`; only add a runner timeout case if the injected test seam supports a short test timeout without changing production timeout policy.

- [x] **Step 2: Run the bridge regression before implementation**

```bash
cd "$HOME/Documents/Projects/forge" && bun test "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/index.test.ts" "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/dispatch-outcome.test.ts"
```

Expected: the regression fails because the dispatch runner does not yet accept the injected child launcher or expose its process outcome to the test; existing pure classifier tests pass or expose a specific regression.

- [x] **Step 3: Add the minimal test seam and bridge behavior**

Add the optional `spawnChild` dependency to the internal `runSubagentProcess()` options, defaulting to the existing `spawn`, and export that runner from the extension module for its direct unit test (it is not a registered terminal command or public package API). Route the real child stream/event/close handling through the tested dispatch function. Reuse `BoundedCapture`, `classifyDispatchOutcome()`, and existing stream safety helpers where they satisfy the spec. Do not duplicate the classifier, broaden completion conditions, or remove process-health diagnostics. If the reconciled in-progress changes already provide the behavior, keep only their tested form and make no redundant implementation edit.

- [x] **Step 4: Re-run focused bridge tests and inspect logs**

```bash
cd "$HOME/Documents/Projects/forge" && bun test "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/index.test.ts" "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/dispatch-outcome.test.ts"
```

Expected: valid post-settlement non-zero exit is retained with warning; every negative case remains failed/timed out; malformed event lines do not corrupt the protocol state; stderr capture remains bounded and preserves the distinguishing tail.

## Task 4: Reproduce the original HT headless shutdown symptom

**Files:** No HT source changes before the reproduction result is reviewed. Store repro logs in a newly-created `~/.local/state/coding-agent-orchestrator/runs/headless-dispatch-shutdown-recovery-<timestamp>/` directory; never overwrite the historical run logs.

- [x] **Step 1: Build the isolated HUMAIN Terminal workspace**

The coding-agent bundle step requires generated outputs from workspace packages (for example, `packages/ai/dist/api/bedrock-converse-stream.js`), which a clean worktree does not contain. Build the repository from its root so package build order is honored:

```bash
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery" && npm run build
```

Expected: dependent workspace packages and coding-agent bundle build successfully in this worktree only.

- [x] **Step 2: Run one bounded headless JSON-mode reproduction**

Use the same local provider/profile and orchestrator extension setup recorded for `ht-orch-1790153054042-gf3ar0`. Issue one minimal prompt with tools disabled where possible; do not retry automatically. Capture the bridge's bounded head/tail stderr diagnostic, stdout JSONL, exit code, HT build revision, and command line into separate run-local files; do not route stderr through a shell pipeline that can replace or truncate the useful tail.

Expected: either reproduce a child that emits terminal success then fails, with the final diagnostic visible, or document that the original path no longer reproduces against the current build. Do not infer a source fault from bundle text alone.

- [x] **Step 3: Pin the failure stage from evidence**

Correlate the last JSON event, assistant stop reason, stderr tail, and exit code. Trace the exact failing source path/line using the current source map/bundle or a source-level test seam. If no concrete site is identified, stop HT source implementation and report the unresolved evidence rather than adding a global handler.

## Task 5: Fix the confirmed HT cleanup fault test-first (conditional) — NOT APPLICABLE

> **Not executed, and its four steps are deliberately left unticked.** Task 4's bounded
> probe exited 0 with terminal success events and empty stderr against the rebuilt HT
> runtime, so no concrete failure site was ever identified. Per the Global Constraint
> "do not make speculative HUMAIN Terminal source changes if the reported shutdown
> failure cannot be reproduced", and the standing ruling not to port the HT
> `subagent.ts` progress-payload diff unless a reproduced fault points at it, there was
> nothing to change test-first. **No HT source was touched.**
>
> Ticking these steps would assert an HT fix that does not exist. The steps below remain
> the correct procedure if the symptom is ever reproduced — re-enter at Task 4 first.

**Files:**
- Test first: `packages/coding-agent/test/print-mode.test.ts` or the narrower existing test file at the identified source boundary.
- Modify only the source file identified by Task 4 (likely `packages/coding-agent/src/modes/print-mode.ts`, but choose from evidence).

**Interfaces:** Keep `runPrintMode()` return/error behavior and JSON event protocol stable except for the specifically reproduced lifecycle defect.

- [ ] **Step 1: Add a failing regression at the actual failure seam**

Use the existing fake runtime host in `print-mode.test.ts` when the failure is in print-mode disposal/flush; otherwise add the test beside the actual failing helper. Assert the successful assistant result is emitted before cleanup, the precise cleanup diagnostic is surfaced, and the process/command status remains nonzero when cleanup genuinely fails. Do not assert speculative error text or intercept global process errors.

- [ ] **Step 2: Run the focused test and verify it fails for the reproduced reason**

```bash
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery/packages/coding-agent" && npm run test -- test/print-mode.test.ts
```

Expected: the new case fails at the confirmed lifecycle behavior, not due to missing dependencies/configuration.

- [ ] **Step 3: Implement the minimal local lifecycle correction**

Change only the confirmed failure site. Preserve the original error and nonzero status when cleanup fails; do not convert cleanup failure into a clean HT process or install global error handlers.

- [ ] **Step 4: Re-run the focused HT test**

```bash
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery/packages/coding-agent" && npm run test -- test/print-mode.test.ts
```

Expected: the regression passes and existing text/JSON/assistant-error cases stay green.

If Task 4 does not reproduce or identify a concrete defect, mark this task not applicable, make no speculative HT source change, and record the reason in the final report.

## Task 6: Cross-repository verification and handoff

**Files:** Only the regression/fix files named above; no unrelated worktree or scratch changes.

- [x] **Step 1: Run the complete bridge extension test set**

```bash
cd "$HOME/Documents/Projects/forge" && bun test "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator"
```

Expected: all bridge extension tests pass.

- [x] **Step 2: Build and run focused HT tests**

```bash
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery/packages/coding-agent" && npm run test -- test/print-mode.test.ts
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery" && npm run build
```

Expected: print-mode/lifecycle tests and the full workspace-ordered coding-agent bundle build pass.

- [x] **Step 3: Repeat the single headless dispatch against the rebuilt HT bundle**

Use the same one-shot command and local profile as Task 4. Assert the event sequence, final response, raw process exit, effective orchestration outcome, and stderr warning are consistent. Do not trigger orchestrator retries; any provider call is one low-cost smoke call only.

- [x] **Step 4: Inspect final worktree changes and commit only reviewed source/test files**

```bash
git -C "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery" status --short
git -C "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery" status --short
```

Expected: no changes outside the named bridge and HT fix/test paths. Preserve the original main-checkout diffs/untracked files. Commit the bridge and HT work separately in their feature worktrees after tests; if the HT root cause was not reproducible, do not create an empty HT fix commit.

## Self-Review

- **Spec coverage:** Reproduction/localization is Task 4; bridge process/event recovery and strict failure behavior are Task 3; the conditional HT local fix is Task 5; two-repository verification and process-health reporting are Task 6; isolation and preservation are Task 1. Every acceptance criterion in the spec has a corresponding task.
- **Placeholder scan:** No unresolved placeholder text or open-ended handling instructions. HT code edits are conditional on a concrete reproduced source site by design.
- **Type consistency:** The existing `classifyDispatchOutcome()` status contract is reused. The bridge retains raw process health separately from recovered effective dispatch status; no new external protocol shape is required.
- **Review Focus:** All five risk cases are assigned to concrete tests in Tasks 3 or 5.
- **Scope:** The plan remains one coupled repair: the bridge must retain evidence and classify the result while HT owns its shutdown lifecycle. HT's progress-payload commit `c67014b9d` is part of the baseline, not a new change in this plan. No unrelated dashboard, scratch-file, TUI, or policy work is included.

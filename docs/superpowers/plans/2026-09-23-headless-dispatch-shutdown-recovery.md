# Headless Dispatch Shutdown Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make headless orchestrator dispatch preserve an authoritative completed child result while accurately reporting later process/cleanup failures, and fix the confirmed HUMAIN Terminal shutdown defect when reproducible.

**Architecture:** Use separate feature worktrees for the orchestrator skill and HUMAIN Terminal. First preserve and review the existing in-progress bridge diff, then use three read-only reconnaissance workers and the bridge's bounded stderr capture to localize the child failure. Keep task completion separate from process health; only change HT at a reproduced failure site, and test both sides of the child-process boundary.

**Tech Stack:** TypeScript, Bun tests in the orchestrator bridge, Vitest and npm package scripts in HUMAIN Terminal, HT `--mode json` child process protocol.

**Spec:** `docs/superpowers/specs/2026-09-23-headless-dispatch-shutdown-recovery-design.md`

## Global Constraints

- A non-zero process exit is recoverable only when the child proves final assistant text, `stopReason: "stop"`, and `agent_settled`, without timeout or spawn failure.
- A failure before authoritative completion, a timeout, a spawn failure, or an error/aborted stop reason remains a failed dispatch.
- Do not add a process-global uncaught exception or unhandled rejection handler.
- Treat the bridge fixes in commit `39db7ec` as the current skill-side baseline; do not reimplement or overwrite them.
- Preserve any concurrent uncommitted changes in the skill main checkout (currently `bridge/extensions/orchestrator/index.ts` and `index.test.ts`) and the untracked plan document; do not overwrite, stage, or transfer them into this branch.
- Preserve untracked `packages/coding-agent/test-prod-loader.mjs` in the HT main checkout; do not copy, edit, or clean it.
- Do not delete or modify unrelated scratch files or other worktrees.
- Do not make speculative HUMAIN Terminal source changes if the reported shutdown failure cannot be reproduced.
- Use one separate worktree per repository and keep changes/commits on the feature branches, not the main checkouts.

## Review Focus

- Final assistant text with successful stop but no `agent_settled` must still fail — pin in the bridge event/outcome integration test (Task 3).
- `agent_settled` after an error/aborted stop must not be treated as successful completion — pin in the bridge event/outcome integration test (Task 3).
- A child timeout after partial output must remain `timed_out`, not recovered — retain/add classifier and process fixture coverage (Task 3).
- Disposal or stdout-flush failure after a successful JSON result must remain observable and must not erase the task response — pin at the reproduced HT shutdown seam (Task 5).
- Malformed or oversized child events/stderr must not throw from a stream listener or cause unbounded capture — pin with the existing bridge stream/capture tests after reconciling the user diff (Task 3).

---

## File and Worktree Map

Create worktrees at execution time using `superpowers:using-git-worktrees`:

- Orchestrator skill source: `/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator`
  - New worktree: `/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery`
  - Branch: `fix/headless-dispatch-shutdown-recovery`
  - Relevant bridge implementation/tests: `bridge/extensions/orchestrator/index.ts`, `index.test.ts`, `dispatch-outcome.ts`, and `dispatch-outcome.test.ts`.
- HUMAIN Terminal source: `/Users/abdulkarim/Documents/Projects/humain-terminal`
  - New worktree: `/Users/abdulkarim/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery`
  - Branch: `fix/headless-dispatch-shutdown-recovery`
  - Likely lifecycle implementation/test: `packages/coding-agent/src/modes/print-mode.ts`, `packages/coding-agent/test/print-mode.test.ts`, and only the additional source/test files identified by reproduction.

The bridge edits originally present in the skill checkout were committed as `39db7ec` during setup. The HT progress-payload changes were committed on main as `c67014b9d` while the worktree was prepared. Both commits are baselines already included in their respective feature worktrees, not uncommitted changes to port. The skill main checkout retains the untracked plan file; the HT main checkout retains the untracked `packages/coding-agent/test-prod-loader.mjs`.

## Task 1: Establish isolated worktrees and preserve current state

**Files:** No product source changes. Worktree metadata only.

- [ ] **Step 1: Record both repository baselines**

```bash
for repo in "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator" "$HOME/Documents/Projects/humain-terminal"; do
  git -C "$repo" status --short
  git -C "$repo" rev-parse HEAD
  git -C "$repo" worktree list
 done
```

Expected: record skill main at `39db7ec` with only this untracked plan document, and HT main at `c67014b9d` with only untracked `test-prod-loader.mjs`; do not stash, reset, or clean either checkout.

- [ ] **Step 2: Verify committed bridge work was incorporated**

```bash
SKILL="$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator"
SKILL_WT="$SKILL/.worktrees/headless-dispatch-shutdown-recovery"
git -C "$SKILL" show --stat --oneline 39db7ec
git -C "$SKILL_WT" merge-base --is-ancestor 39db7ec HEAD
```

Expected: commit `39db7ec` is present in the feature worktree; the earlier saved bridge patch hash in the SDD ledger matches the committed `ffb02fe..39db7ec` changes, so no duplicate patch is applied.

- [ ] **Step 3: Create two independent feature worktrees**

Invoke `superpowers:using-git-worktrees` and create a new branch/worktree in each repository at the paths in the File and Worktree Map. Base each on its current committed `HEAD`; do not use `git stash` or alter the main checkout.

Expected: `git worktree list` shows both isolated paths and both main-checkout `git status --short` outputs are unchanged.

- [ ] **Step 4: Confirm repository baselines are current**

Run `git -C "$SKILL_WT" log -1 --oneline` and `git -C "$HT_WT" log -1 --oneline`. If either main checkout advanced after worktree creation, compare the new commits to the recorded baseline; fast-forward the feature worktree only when the changes are already committed and there are no feature-branch conflicts. Never transfer uncommitted user changes without evidence and explicit direction.

Expected: skill worktree contains `39db7ec`; HT worktree contains `c67014b9d`; original checkouts and their untracked files remain unchanged.

## Task 2: Reconnaissance before implementation

**Files:** Read-only inspection in both worktrees; no product edits.

- [ ] **Step 1: Dispatch three independent read-only reconnaissance workers in parallel**

Use the orchestrator's `analysis_mid` or `implementation_fast` capability at low/medium effort. Give each a single bounded question and require a structured evidence packet capped at 2,000 tokens:

1. HT lifecycle: trace `runPrintMode()` through `runtimeHost.dispose()` and `flushRawStdout()`, locate tests and identify plausible failure sites only from code evidence.
2. Bridge child protocol: trace stdout/stderr callbacks, JSON event extraction, settlement criteria, process close/timeout paths, and current tests; compare the preserved diff against these flows.
3. Reproduction/build: identify the exact CLI entry/build path used by orchestrator dispatch, the recorded old run artifacts still available, and a safe minimal headless repro command using existing local configuration.

Expected: three packets with paths, facts, tests, and uncertainty; workers make no edits. Lead synthesizes the packets before implementation begins.

- [ ] **Step 2: Run focused baseline tests in the two worktrees**

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

- [ ] **Step 1: Add a failing process/event regression test and deterministic child fixture**

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

- [ ] **Step 2: Run the bridge regression before implementation**

```bash
cd "$HOME/Documents/Projects/forge" && bun test "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/index.test.ts" "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/dispatch-outcome.test.ts"
```

Expected: the regression fails because the dispatch runner does not yet accept the injected child launcher or expose its process outcome to the test; existing pure classifier tests pass or expose a specific regression.

- [ ] **Step 3: Add the minimal test seam and bridge behavior**

Add the optional `spawnChild` dependency to the internal `runSubagentProcess()` options, defaulting to the existing `spawn`, and export that runner from the extension module for its direct unit test (it is not a registered terminal command or public package API). Route the real child stream/event/close handling through the tested dispatch function. Reuse `BoundedCapture`, `classifyDispatchOutcome()`, and existing stream safety helpers where they satisfy the spec. Do not duplicate the classifier, broaden completion conditions, or remove process-health diagnostics. If the reconciled in-progress changes already provide the behavior, keep only their tested form and make no redundant implementation edit.

- [ ] **Step 4: Re-run focused bridge tests and inspect logs**

```bash
cd "$HOME/Documents/Projects/forge" && bun test "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/index.test.ts" "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator/dispatch-outcome.test.ts"
```

Expected: valid post-settlement non-zero exit is retained with warning; every negative case remains failed/timed out; malformed event lines do not corrupt the protocol state; stderr capture remains bounded and preserves the distinguishing tail.

## Task 4: Reproduce the original HT headless shutdown symptom

**Files:** No HT source changes before the reproduction result is reviewed. Store repro logs in a newly-created `~/.local/state/coding-agent-orchestrator/runs/headless-dispatch-shutdown-recovery-<timestamp>/` directory; never overwrite the historical run logs.

- [ ] **Step 1: Build the isolated HUMAIN Terminal workspace**

The coding-agent bundle step requires generated outputs from workspace packages (for example, `packages/ai/dist/api/bedrock-converse-stream.js`), which a clean worktree does not contain. Build the repository from its root so package build order is honored:

```bash
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery" && npm run build
```

Expected: dependent workspace packages and coding-agent bundle build successfully in this worktree only.

- [ ] **Step 2: Run one bounded headless JSON-mode reproduction**

Use the same local provider/profile and orchestrator extension setup recorded for `ht-orch-1790153054042-gf3ar0`. Issue one minimal prompt with tools disabled where possible; do not retry automatically. Capture the bridge's bounded head/tail stderr diagnostic, stdout JSONL, exit code, HT build revision, and command line into separate run-local files; do not route stderr through a shell pipeline that can replace or truncate the useful tail.

Expected: either reproduce a child that emits terminal success then fails, with the final diagnostic visible, or document that the original path no longer reproduces against the current build. Do not infer a source fault from bundle text alone.

- [ ] **Step 3: Pin the failure stage from evidence**

Correlate the last JSON event, assistant stop reason, stderr tail, and exit code. Trace the exact failing source path/line using the current source map/bundle or a source-level test seam. If no concrete site is identified, stop HT source implementation and report the unresolved evidence rather than adding a global handler.

## Task 5: Fix the confirmed HT cleanup fault test-first (conditional)

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

- [ ] **Step 1: Run the complete bridge extension test set**

```bash
cd "$HOME/Documents/Projects/forge" && bun test "$HOME/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/headless-dispatch-shutdown-recovery/bridge/extensions/orchestrator"
```

Expected: all bridge extension tests pass.

- [ ] **Step 2: Build and run focused HT tests**

```bash
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery/packages/coding-agent" && npm run test -- test/print-mode.test.ts
cd "$HOME/Documents/Projects/humain-terminal/.worktrees/headless-dispatch-shutdown-recovery" && npm run build
```

Expected: print-mode/lifecycle tests and the full workspace-ordered coding-agent bundle build pass.

- [ ] **Step 3: Repeat the single headless dispatch against the rebuilt HT bundle**

Use the same one-shot command and local profile as Task 4. Assert the event sequence, final response, raw process exit, effective orchestration outcome, and stderr warning are consistent. Do not trigger orchestrator retries; any provider call is one low-cost smoke call only.

- [ ] **Step 4: Inspect final worktree changes and commit only reviewed source/test files**

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

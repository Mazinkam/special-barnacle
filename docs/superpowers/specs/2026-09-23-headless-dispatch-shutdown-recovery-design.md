# Headless Dispatch Shutdown Recovery Design

## Purpose

Make `/orchestrate` preserve a genuinely completed child result when a child process fails during shutdown, while keeping the shutdown failure visible and fixing its cause in HUMAIN Terminal when it can be reproduced.

The goal is not to make non-zero child exits generally successful. A child that fails before it provides an authoritative terminal result must remain a failed dispatch.

## Current Evidence and State

The original run `ht-orch-1790153054042-gf3ar0` produced valid triage JSON and its child event stream ended with `agent_end` and `agent_settled`. The associated `triage.stderr.log` was exactly 65,536 bytes and showed the beginning of a compiled HUMAIN Terminal bundle, so the actual terminating diagnostic was unavailable. The corresponding built bundle is no longer available for source-level inspection.

Since that run, the skill bridge has gained bounded stderr retention and a pure `classifyDispatchOutcome()` helper. It classifies a non-zero process exit as `completed_after_process_error` only when the child was not spawn-failed or timed out and the JSON event stream proves `agent_settled`, final assistant text, and `stopReason: "stop"`. Existing bridge tests exercise the pure classification logic, but do not by themselves reproduce the HT shutdown failure or prove the full child-process/event-parsing behavior.

The HT source currently routes print-mode cleanup through `runtimeHost.dispose()` and `flushRawStdout()` in `packages/coding-agent/src/modes/print-mode.ts`. The original exception site remains unknown. Reproduce against the current HT source/build before making a speculative runtime change.

At design time, the skill working tree contains uncommitted changes in the four bridge files `dispatch-outcome.ts`, `dispatch-outcome.test.ts`, `index.ts`, and `index.test.ts`. The HUMAIN Terminal working tree also has an unrelated untracked `packages/coding-agent/test-prod-loader.mjs`. These are pre-existing user state and must be preserved; review them before implementation and do not overwrite, stage, or discard them as part of this work without explicit direction.

## Scope

This is one cross-repository repair with two cooperating layers:

1. Reproduce and fix the specific HUMAIN Terminal headless/print-mode shutdown failure, if reproducible.
2. Keep the orchestrator bridge's conservative terminal-result recovery and validate it at the process/event boundary.

Do not include unrelated orchestrator changes, scratch-file cleanup, TUI work, global runtime error-handler installation, or broad bridge recovery changes.

## Approaches Considered

### Global uncaught-error logger

Rejected. Installing process-global handlers risks changing Node's default fatal-error behavior and can obscure the real fault without fixing it.

### Bridge-only recovery expansion

Rejected. The bridge already has a conservative recovery path. Relaxing its conditions further could turn incomplete work into apparent success and would mask the HT defect.

### Reproduce, repair the local lifecycle cause, and test both boundaries (recommended)

Use the current bridge diagnostics to reproduce the headless child exit. Fix only the confirmed HT lifecycle failure. Preserve bridge outcome semantics and add integration coverage around event parsing, process close, and diagnostic capture.

## Architecture and Outcome Contract

Task completion and process health are separate observations:

- A task is authoritatively complete only when the child emits successful final assistant text (`stopReason: "stop"`) and reaches `agent_settled` in the expected protocol sequence.
- Process health records whether the child exited normally or encountered a later shutdown/cleanup error.
- A proven completed result remains usable if a subsequent process error occurs. The non-zero raw process exit and its diagnostic remain visible as a post-completion warning/status.
- A failure before authoritative completion, a timeout, a spawn failure, or an error/aborted stop reason remains a failed dispatch.

The existing `completed_after_process_error` status/effective-exit behavior is the bridge safety net; it must not be mistaken for a clean HT process exit. Do not weaken the terminal evidence required for recovery.

## Reproduction and Fix Flow

1. Reproduce the original headless JSON-mode dispatch using the current HT source/build and the applicable extension/configuration setup.
2. Capture the complete retained stderr diagnostic tail, actual child exit code, final assistant stop reason, and terminal event sequence. Identify whether failure occurs during extension/runtime disposal, stdout flush, or another lifecycle step.
3. If reproducible, correct the confirmed local HT lifecycle defect. Preserve the real error and non-zero status when shutdown genuinely fails; do not globally swallow or intercept fatal errors.
4. If not reproducible, do not make speculative HT changes. Report the reproduction attempts and the remaining uncertainty; the existing bridge recovery remains in place.

## Test Design

### HUMAIN Terminal

Extend the existing print-mode tests or add a focused lifecycle test at the narrowest confirmed failure seam. Cover cleanup/disposal or output-flush rejection as applicable. Verify that a cleanup error is diagnosable and does not silently convert a failed runtime shutdown into a clean process result. Keep successful print-mode and JSON-mode behavior unchanged.

A test for a hypothesized failure is not a substitute for reproducing the source-level failure. The exact regression case is determined by the identified failing site.

### Orchestrator bridge

Keep the pure outcome classifier tests. Add or extend a process/event-level test that feeds the actual JSON protocol sequence through dispatch handling and then closes the child non-zero:

- successful final assistant result + successful stop + `agent_settled` + non-zero close => result retained and post-completion error visible;
- missing terminal settlement, missing final text, non-success stop reason, timeout, or spawn error => dispatch remains failed.

Verify stderr head/tail capture remains bounded and includes the useful final diagnostic, and verify event-log handling cannot throw away an otherwise valid child result. Preserve any existing uncommitted work and review it before deciding how tests should be composed.

## Verification and Acceptance Criteria

1. The original symptom is reproduced against current HT, or the report records a bounded, concrete explanation for why it cannot currently be reproduced.
2. If reproduced, a regression test covers the actual HT failure site and the local fix addresses that site rather than adding a global handler.
3. A completed result followed by a non-zero shutdown exit remains available with a visible process-health warning and useful diagnostic.
4. A failure before authoritative completion remains a failed dispatch.
5. Focused HT print-mode/lifecycle tests and focused bridge tests pass.
6. Relevant coding-agent typecheck/build and bridge checks pass; the headless dispatch is rerun against the rebuilt HT runtime when the environment permits.
7. No unrelated files are changed, and pre-existing working-tree changes remain intact.

## Error Handling and Reporting

Keep raw process exit, effective dispatch outcome, and post-completion diagnostic distinct in logs/results. Bound memory used for stderr capture while preserving its start and tail. If reproduction fails, stop before speculative source edits and report that the root cause remains unverified.

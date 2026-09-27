# Failed-Run Recovery UX Design

## Problem

A failed orchestration can leave useful partial work in the workspace while dependent leads never start. The current failure summary exposes diagnostic paths, but does not clearly explain what completed, what remains, or how to recover. A long inactivity timeout can therefore leave a user with substantial elapsed time and cost, uncertain whether it is safe to try again.

The orchestrator already retries some transient provider failures within a run. That automatic retry is distinct from the user-initiated continuation designed here: inactivity timeouts and other eligible failed runs should be recoverable after the run has reached a terminal state.

## Goals

- Make failures understandable and actionable in the immediate run summary.
- Let a user deliberately continue an eligible failed run without repeating successful work.
- Preserve the original run and its evidence; represent continuation as a new, linked run.
- Make workspace state and accumulated cost visible before and after continuation.
- Prevent overlapping or unsafe continuation attempts.

## Non-goals

- Resuming a still-running or cancelled run.
- Rolling back partial workspace edits.
- Replanning completed work or silently changing the original task/plan.
- Replacing automatic in-run transient-provider retries.
- Guaranteeing recovery when required run artifacts or workspace state cannot be validated.

## User experience

### Failure summary

For a failed run, the summary should lead with a concise failure diagnosis and identify the affected task(s). It should distinguish among failed, successful, and not-started leads, and state whether verification ran. It should provide direct, copyable paths to the run log, lead report, and relevant task stderr log when available. The summary should clearly label partial workspace changes as unverified.

When continuation is supported, show an actionable instruction (initial interface may be a slash command) such as `/orchestrate-continue <run_id>`. If unavailable, explain the reason instead of presenting a dead-end action. Do not claim that the run can continue merely because some files changed.

### Continuation preview and confirmation

Before dispatching any work, show a preview containing:

- Parent run ID and original task/plan identity.
- Workspace path and repository identity (including branch/worktree where available).
- Work to reuse, retry, and skip, including dependency-blocked work that becomes eligible.
- Existing partial changes that will remain in place and may be overwritten or affected.
- Whether verification will run after recovery.
- Cost already incurred and the fact that continuation incurs additional cost.

Require explicit confirmation before dispatch. If the repository/workspace identity differs from the original run, refuse automatic continuation by default and explain how to return to the original workspace; do not silently run against a different checkout. If the workspace has changed since failure, surface that fact and require confirmation. Confirmation authorizes continuing with those workspace changes; it does not imply rollback or isolation.

### Continuation result

Create a fresh run ID and retain a parent-run link. The parent run's status and artifacts remain unchanged. The new summary reports the parent ID, what was reused/retried/skipped, this attempt's cost and cumulative known cost across the chain, and verification outcome. Logs and reports remain individually addressable by run ID.

## Recovery semantics

1. Load and validate the terminal parent run's manifest/metadata and required plan, task prompts/results, and workspace identity. Missing or invalid essential evidence makes continuation unavailable with a specific reason.
2. Derive a recovery plan from recorded task outcomes. Reuse successful lead outcomes; retry eligible failed leads and leads that did not start because dependencies failed or were blocked. Do not rerun successful leads by default.
3. Preserve the original task and plan as the recovery basis. The continuation run records any user-confirmed workspace divergence. Partial filesystem changes are not treated as proof that a lead succeeded.
4. Re-evaluate dependency eligibility from recorded outcomes plus retried results. Do not start a dependent task until its prerequisites have succeeded.
5. After recovery, run verification under the existing rules for the resulting work. If no lead succeeds, report verification as not run; never imply partial work was verified.
6. Enforce a single active continuation per parent (or otherwise acquire an equivalent atomic claim) to prevent duplicate concurrent recovery. A failed continuation can itself be continued, forming a traceable parent chain; cumulative cost sums known recorded costs without double-counting.

Continuation eligibility must be explicit and conservative. Terminal failed runs are candidates only if all required evidence is readable, the workspace is available and validated, and no cancellation/crash state makes task outcomes ambiguous. Cancelled runs are not continuable in this design. A later implementation must define a complete allowlist of terminal outcomes rather than treating every non-success as recoverable.

## Components and boundaries

- **Summary/reporting:** Render diagnosis, outcome breakdown, artifact links, partial-work warning, and continuation availability/reason. Keep report generation based on recorded run data.
- **Run evidence/recovery planner:** Read and validate parent artifacts; produce a pure recovery plan that classifies each task as reused, retried, or skipped and explains ineligibility. It must not dispatch work.
- **Continuation command/orchestration entry point:** Resolve a parent run, present the preview, obtain confirmation, claim the parent against concurrent continuation, then launch a new run using the validated recovery plan.
- **Run session/telemetry:** Record parent linkage, recovery actions, workspace identity, per-attempt cost, and cumulative chain cost in the new run's own evidence and telemetry.

These boundaries keep UX formatting, recovery decisions, and side-effecting dispatch independently testable. Reuse existing run-session evidence and orchestration/prompt infrastructure where suitable; do not mutate or overwrite parent artifacts.

## Failure handling and safety

- Unknown, malformed, incomplete, or inconsistent parent evidence: do not dispatch; report the missing/conflicting artifacts.
- Workspace mismatch or unavailable repository: do not dispatch automatically; explain the expected identity.
- Parent already has an active continuation: do not start another; identify the active child if known.
- User declines confirmation: exit without creating dispatches or changing parent state.
- Continuation crashes or fails: record a terminal outcome for the new run, preserve its evidence, and leave the parent unchanged.
- Cost data missing: label cumulative cost as incomplete rather than presenting a false precise total.
- No successful lead after recovery: clearly report that verification was not run and identify remaining failed/not-started work.

## Validation and acceptance criteria

- A failure summary for a timed-out lead identifies the timeout, lead, unverified partial work, diagnostic artifact paths, and an available continuation command.
- A non-continuable failure states why, without offering an unusable action.
- Declining the preview causes no dispatch and no parent mutation.
- Continuing a valid failed run creates a distinct child run linked to its parent; parent files/outcome remain unchanged.
- Successful leads are reused and not dispatched again; failed eligible leads are retried; dependent leads run only after prerequisites succeed.
- A changed or mismatched workspace is never silently accepted; the preview exposes divergence and enforces the specified confirmation/refusal behavior.
- Concurrent attempts cannot dispatch twice from the same parent.
- The child summary distinguishes attempt cost from cumulative known cost, reports recovery actions, and reflects actual verification state.
- Missing/corrupt evidence and continuation failures produce actionable diagnostics and leave prior evidence intact.
- Tests cover the recovery planner, command/confirmation flow, filesystem/repository mismatch, concurrency claim, artifact immutability, dependency ordering, cost accounting, and summary output.

## Open implementation decisions

- Exact command name and whether a later UI action should supplement it.
- Exact persisted schema for parent linkage and recovery-action records, preserving compatibility with existing run directories.
- The terminal-outcome eligibility allowlist and the specific evidence required for each outcome.
- How workspace divergence is measured robustly (for example, repository identity plus a recorded baseline and current diff), without blocking ordinary uncommitted partial work from being continued after explicit confirmation.
- How cumulative cost is computed across chains when some historical dispatch costs are unknown.

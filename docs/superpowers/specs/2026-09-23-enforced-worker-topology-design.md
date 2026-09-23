# Enforced Worker Topology Design

## Purpose

Make `/orchestrate` run and report the worker topology it plans. A complexity-5-or-higher implementation must no longer rely on an LLM lead to remember to create its required reconnaissance workers. Operators must see actual child dispatches, costs, and completion state rather than an optimistic statement that workers will fan out.

## Scope

This design changes the HUMAIN Terminal bridge in `bridge/extensions/orchestrator/`. It preserves the existing lead as the owner of synthesis and downstream implementation/review decisions. It also completes the already-started child-process outcome recovery so valid triage and architect results are not discarded when a child crashes during teardown.

A full redesign that parses architect output into parent-owned implementation tasks is intentionally out of scope. That needs a versioned structured-plan protocol and is a separate change.

## Current Failure

`dispatchHierarchical()` dispatches an architect and then one or more leads. Its progress message claims that workers fan out inside each lead, but the outer bridge returns an empty `workerResults` collection and has no evidence that nested `subagent` calls happened or completed. The lead has unrestricted repository tools, so it often performs discovery and implementation itself. If triage or architect subprocesses exit non-zero after emitting a terminal answer, their valid output is currently treated as failed, further increasing lead work.

## Architecture

### Parent-owned required reconnaissance

Before dispatching leads, `dispatchHierarchical()` will determine whether Rule 2 applies:

- Apply only when `complexity >= method.rules.pre_implementation_recon.min_complexity`.
- Skip task classes named in `skip_for_task_classes`.
- Derive the required worker count from `workers_by_complexity`, not from the planner's advisory topology count.
- Dispatch that many independent, cheap, read-only reconnaissance tasks through the existing parent `dispatchParallel()` path.
- Give each worker one bounded question from a deterministic rotation: affected flow/files, existing tests and verification commands, recent related changes, and dependency/constraint surface. Additional workers repeat the most relevant bounded categories with distinct scopes.

Each dispatch is a normal bridge dispatch: it receives its own prompt/events/stderr files, progress row, completion result, cost capture, and EventStore metrics. Recon workers must not edit source, commit, push, change branches, or create worktrees.

### Evidence handoff

The bridge will summarize completed recon results into compact, clearly delimited evidence packets and include them in every lead prompt. It will bound each packet and the aggregate handoff so a noisy worker cannot crowd out the original goal. Failed workers will be recorded and represented as unavailable evidence; they do not silently disappear.

The lead prompt will state that it must synthesize the supplied evidence and must not repeat broad repository discovery before acting. It may still use its tools to validate a material uncertainty or integrate worker findings.

### Honest progress and accounting

Progress phases will be based on actual parent dispatches:

- `recon: 0/N starting`
- `recon: N/N completed; dispatching lead(s)`
- `lead(s) executing with N completed recon packet(s)`

The final billed-results collection will include recon, architect, lead, QA, and escalation results. A completed run can therefore report real worker calls and cost. The README will describe recon as parent-owned and explicitly label any lead-created children as nested and not part of the bridge’s authoritative worker accounting.

### Child-process terminal-result recovery

`dispatch-outcome.ts` remains a pure module. It retains bounded stderr, extracts usable diagnostics, and classifies a child as `completed_after_process_error` only if it emitted a settled terminal `stop` result with final text before a non-zero teardown exit. The bridge records the raw process exit and recovery note while using effective exit code zero for a recovered dispatch. Timeouts, spawn errors, aborted/error stop reasons, and absent terminal results remain failures.

## Data and Interfaces

`dispatchHierarchical()` will return actual `workerResults` for parent-owned reconnaissance. Its caller will include these results in metrics, totals, and final reporting.

A small pure helper module may be added for recon planning/evidence formatting if it enables direct Bun tests without importing terminal runtime APIs. It must consume the method rule as input rather than duplicating complexity thresholds.

## Error Handling

- A failed recon worker is logged and surfaced in the evidence handoff; other independent workers continue.
- If every recon worker fails, the run proceeds in an explicit degraded state and the lead prompt says no evidence was available.
- Architect failure remains visible and does not erase successful recon evidence.
- Recovered child teardown errors remain visible in `stderr` logs and progress notes without invalidating an already-settled result.

## Verification

Tests must prove:

1. Rule-2 worker count selection at complexity bands 5–6, 7–8, and 9–10, including configured skip classes.
2. Recon prompts are bounded, read-only, and cover distinct evidence questions.
3. Completed and failed recon output produces bounded evidence handoff with failure visibility.
4. Parent-owned recon results are returned for billing/reporting rather than an empty worker result array.
5. Terminal child result recovery and stderr truncation behavior remain covered by `dispatch-outcome.test.ts`.
6. The full bridge Bun suite and the Python test suite pass.

## Acceptance Criteria

- A complexity-5 implementation run launches three observable parent-owned recon workers before its lead.
- Each worker has a run-local event log, prompt, completion status, and captured cost.
- The lead receives bounded recon evidence and is instructed to synthesize it rather than re-discover the repository.
- Run progress and final totals report actual recon-worker state/cost; no phase claims fan-out merely because it was planned.
- A valid settled child response survives a subsequent non-zero teardown exit, while real failure modes remain failed.

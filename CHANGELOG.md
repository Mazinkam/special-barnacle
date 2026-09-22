# Changelog

## [Unreleased]

### Fixed

- `dispatchParallel` in the HT bridge no longer produces all-`"unknown"` model_call events when the subagent tool returns a sparse `details.results` array (cancellation, mid-dispatch reconcile, harness interruption). Previously, `.map()` on a sparse array skipped the callback for each hole AND returned a sparse array, so the downstream `for (const r of leadResults)` iteration yielded `undefined` and `captureDispatchCost` recorded events with `task_id "unknown-{runId}"` (no `-i` suffix), `model/provider/capability "unknown"`, duration 0, cost $0, and the run reported `0/0 leads succeeded` with `verification: PASS` (the orchestrator's own structural check, not code verification). `dispatchParallel` now uses `flatMap` to drop sparse slots and out-of-range entries so callers only see dense, index-aligned results. The scheduler-side defense in `runDag` additionally guarantees the resolved array is always dense by filling any unset slot with the `skip`-callback stub.

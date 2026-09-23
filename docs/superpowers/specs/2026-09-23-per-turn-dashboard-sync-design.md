# Per-Turn Session Capture and Dashboard Sync Design

## Purpose

Make interactive HUMAIN Terminal usage visible in the orchestrator dashboard shortly after every settled turn, without requiring a manual ingest, dashboard command, or browser refresh. A missed hook or interrupted refresh must be recoverable, and repeated ingestion must not double-count usage.

## User requirement

- Capture session usage after each turn settles.
- Show the update in an already-open dashboard without manual action.
- Avoid losing usage when the extension hook, CLI, process, or dashboard generation fails.
- Keep interactive-session metrics distinct from orchestrated-run metrics.

## Current behavior and evidence

The bridge already registers `agent_settled` and `session_shutdown` hooks in `bridge/extensions/orchestrator/index.ts`. The settled-turn hook debounces for three seconds and invokes `orchestrator.cli ingest` on the active session file. A launchd sweep, installed by `install.sh`, runs at login and periodically as a fallback. Session-granularity ingestion computes deltas and stable call IDs to prevent double counting.

There are two visible gaps in the current flow:

1. `orchestrator.cli ingest` rebuilds the ledger and dashboard only when it emitted new metrics. If ingestion persists metrics but materialization fails, a later duplicate-only retry does not regenerate the dashboard.
2. The dashboard is a static HTML file. Regenerating it does not update a browser tab that already has the old page loaded.

The current extension logs hook errors, but the dashboard does not surface a structured last-success/failure status. This design does not assume the hook is absent; it makes delivery, recovery, and visibility observable.

## Approaches considered

### Periodic sweep only

Rejected as the primary mechanism. It is robust as a fallback but can leave a settled turn invisible until the next sweep.

### New independent per-turn poller

Rejected. A second ingestion mechanism would duplicate existing lifecycle behavior and increase state/race complexity.

### Harden the existing event path and retain reconciliation (recommended)

Use `agent_settled` as the fast path, `session_shutdown` as a flush, and launchd startup/periodic discovery as reconciliation. Preserve idempotent session-delta ingestion. Regenerate materialized state after every completed non-dry-run ingest batch, including duplicate-only and partial-failure batches, and have the dashboard page reload the generated HTML automatically.

## Architecture and data flow

1. **Turn settles:** The installed HT extension receives `agent_settled`, schedules the current session file after the existing short debounce, and serializes/coalesces overlapping ingestion work. `session_shutdown` flushes outstanding work before exit.
2. **Ingest:** The CLI reads saved usage from the session JSONL and appends only unrecorded deltas. Stable call IDs and current session-delta accounting remain authoritative; no prompt or assistant message text is added to telemetry.
3. **Materialize:** After every completed non-dry-run ingest batch, rebuild the ledger and regenerate the dashboard, even if it emitted no new metric rows or some discovered files failed. Record partial failures in status while still materializing any rows successfully appended. This makes a retry repair a stale materialized view after a partial failure.
4. **Failure and recovery:** Record a structured latest attempt/result in the shared state directory. Report hook/CLI failures; retry transient failures a small bounded number of times. The existing login/periodic launchd sweep remains the durable catch-up path for missed turns and process crashes. Re-ingestion stays idempotent.
5. **Already-open dashboard:** The generated HTML automatically reloads on a short interval while its tab is visible, preserves scroll position, and provides a pause control. It displays the last successful ingestion time and the latest error/stale status. The default HTML-file workflow remains supported; no always-running web server is introduced.

The status indicator must distinguish “no new usage” from failure: a successful duplicate-only ingest is still a successful check and refresh. A stale warning is based on elapsed time since the latest successful check relative to the configured reconciliation interval, not on the age of the last model call.

## Error handling and safety

- Ingestion remains at-least-once; stable IDs/delta accounting provide exactly-once effects in the metrics stream.
- Do not advance any new checkpoint before the metric append succeeds. Existing session logs remain the source of truth for reconciliation.
- A failed dashboard render must not truncate the last usable dashboard; write the replacement atomically, and retry materialization on the next ingest/sweep even when there are no new rows. Partial ingestion failures remain visible and are retried through the settled-turn retry or later sweep.
- A final hook failure is visible in logs and the dashboard status; the periodic sweep retries independently.
- Ephemeral `--no-session` work has no saved interactive session log and remains outside this ingestion path. Orchestrator-dispatched child usage continues to use its direct metric-capture path.

## Scope

In scope:

- HT settled/shutdown hook reliability and bounded retry/serialization behavior.
- CLI ingest materialization and structured ingest health status.
- Dashboard status display and automatic refresh for an open local HTML dashboard.
- Regression tests for ingestion idempotence, retry/recovery, and page refresh behavior.

Out of scope:

- Uploading session logs or message contents to a remote service.
- Replacing the launchd sweep or changing the dashboard into a hosted/web-server product.
- Changing orchestrator dispatch telemetry, pricing, routing policy, or dashboard metric definitions.

## Verification and acceptance criteria

1. A settled-turn event for a persisted HT session causes its new usage delta to appear in `metrics.jsonl` and regenerates ledger/dashboard without a manual command.
2. The dashboard regeneration completes promptly after settle (target: within ten seconds under normal local conditions, including the existing debounce).
3. Replaying the same settled event emits no duplicate usage but still refreshes materialized state and records a successful check.
4. If metric append succeeds but dashboard generation fails, the next retry or duplicate-only sweep regenerates the dashboard without adding duplicate metrics.
5. If the extension misses a turn or is unavailable, the login/periodic sweep discovers and ingests it idempotently.
6. A visible dashboard tab picks up a changed generated file within the configured refresh interval, preserves scroll position, and can pause automatic reload.
7. The dashboard status shows latest success time and surfaces failure/staleness; a successful empty check is not shown as an error.
8. No user/assistant message text is added to the dashboard or telemetry by this change.
9. `session_shutdown` flushes pending ingestion; `--no-session` remains explicitly excluded from session-log ingestion.

## Test design

- **Bridge scheduler tests:** settled-turn debounce, overlapping turns/coalescing, bounded retry, failure reporting, and shutdown flush.
- **CLI tests:** always materialize after a completed non-dry-run ingest batch, including zero-new-row and partial-failure batches; verify recovery after a simulated render failure and no duplicate metrics.
- **Status tests:** success, failure, recovery, and stale calculation against the sweep interval.
- **Dashboard tests:** generated auto-refresh behavior, pause control, scroll preservation, and visible status text.
- **Integration test:** append a fixture assistant usage entry to a session log, dispatch a settled event, and assert metric, ledger, dashboard timestamp/status update; replay it and assert no duplicate metric.
- **Sweep test:** skip the event hook, run discovery, and assert the same final state as the event path.

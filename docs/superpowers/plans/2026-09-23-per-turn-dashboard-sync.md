# Per-Turn Dashboard Sync Implementation Plan

**Status: completed.** Landed on `main` (`618e033` design, `6e10020` tests/implementation).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture persisted HUMAIN Terminal usage after every settled turn and show the updated, recoverable state in an already-open dashboard without manual commands or reloads.

**Architecture:** Harden the existing `agent_settled` / `session_shutdown` ingestion path instead of adding another poller. Keep session-delta ingestion idempotent, always rebuild materialized state after completed ingest batches, persist ingestion health, and retain launchd discovery as a catch-up path. Align the extension and Python CLI state-root environment so both writers update the same files. The static dashboard will expose health and reload itself every five seconds while visible, preserving scroll and allowing auto-refresh to be paused.

**Tech Stack:** Python 3.10+, stdlib `unittest`/`pytest`-compatible tests, TypeScript, Bun test runner, generated static HTML/JavaScript, existing HUMAIN Terminal extension lifecycle hooks and macOS launchd sweep.

**Spec:** `docs/superpowers/specs/2026-09-23-per-turn-dashboard-sync-design.md`

## Global Constraints

- Preserve the existing session-delta/stable-ID ingestion semantics; repeated turns and sweeps must not double-count.
- Keep message contents out of telemetry and dashboard status; usage remains separate from orchestrated-run metrics.
- Continue to treat the session JSONL as the reconciliation source of truth; do not add a checkpoint that can get ahead of the metric append.
- Keep `session_shutdown` flushing and the login/periodic launchd sweep as recovery paths.
- Keep the generated dashboard usable as a local HTML file; do not add a web server or dependency.
- Preserve the existing 30-second auto-refresh behavior while replacing it with the approved five-second, pausable refresh that restores scroll position.
- Use a feature branch in a separate git worktree. Do not stage, overwrite, or otherwise touch unrelated uncommitted files, especially the pre-existing modified `docs/superpowers/plans/2026-09-23-headless-dispatch-shutdown-recovery.md`.

## Review Focus

1. **A metric append succeeds but rendering fails:** the next duplicate-only ingest must rebuild without adding metrics again. Pin in Task 1's render-failure recovery test.
2. **Partial batch or malformed/truncated session input:** valid rows still materialize, failures are visible/retried, and a truncated trailing JSONL record does not erase earlier usage. Pin in Task 1's partial-batch and trailing-record tests.
3. **Overlapping settled events while ingestion is in flight:** later appended usage must be picked up after the current ingest, without losing the event or duplicating rows. Pin in Task 2's scheduler test and Task 4's repeated-ingest integration test.
4. **Missing, malformed, or clock-skewed health status:** the dashboard must render a safe unknown/stale state rather than crash or claim a healthy sync. Pin in Task 3's status parsing tests.
5. **An open dashboard is paused, backgrounded, or scrolled:** it must not reload while paused/hidden, and it must restore position after a foreground reload. Pin the generated-page contract in Task 3 and exercise the actual behavior in the browser smoke check.

---

## Worktree Setup

Run implementation from an isolated feature worktree; keep the current checkout (including its modified shutdown-recovery plan) untouched:

```bash
git worktree add .worktrees/per-turn-dashboard-sync -b feat/per-turn-dashboard-sync
cd .worktrees/per-turn-dashboard-sync
```

Expected: the new worktree is on `feat/per-turn-dashboard-sync`, and the original checkout status is unchanged. All implementation paths and test commands below are relative to that worktree.

---

## File Structure

- `orchestrator/cli.py` — ingest command orchestration, status write, and unconditional materialization after a completed non-dry-run batch.
- `orchestrator/dashboard.py` — load/render ingest health, atomic HTML replacement, and pausable five-second refresh behavior.
- `install.sh` — preserve the existing `com.humain.orchestrator-ingest` sweep and pass its configured interval to CLI invocations.
- `bridge/extensions/orchestrator/ingest.ts` — bounded transient retry and serialization/coalescing for turn ingestion.
- `bridge/extensions/orchestrator/index.ts` — wire settled/shutdown hooks to the hardened scheduler and surface final failures.
- `tests/test_cli_ingest.py` — new CLI-level tests for status/materialization and recovery.
- `tests/test_ingest.py` — extend session-log edge and reconciliation coverage.
- `tests/test_dashboard_metrics.py` — ingest-health payload and generated HTML checks.
- `tests/test_v3_engine.py` — update its existing generated-dashboard refresh assertion.
- `bridge/extensions/orchestrator/ingest.test.ts` — scheduler retry/concurrency/shutdown tests.
- `bridge/extensions/orchestrator/index.test.ts` — hook registration/wiring integration test.
- `tests/test_install_sweep.py` — verify the generated temporary plist preserves the sweep and forwards the configured interval.
- `docs/TELEMETRY.md`, `docs/INTEGRATION.md`, and `README.md` — describe turn-level update timing, status, and fallback behavior.

## Status Contract

Store `ingest_status.json` under the existing shared state root using `orchestrator.runtime.write_json` (atomic sibling-temp replacement). Version 1 has these fields:

```json
{
  "version": 1,
  "last_attempt_at": "UTC ISO-8601 timestamp",
  "last_success_at": "UTC ISO-8601 timestamp or null",
  "status": "ok | partial | error",
  "files_scanned": 1,
  "emitted": 1,
  "failure_count": 0,
  "error": null,
  "sweep_interval_seconds": 900
}
```

A fully processed duplicate-only batch is `ok` and refreshes `last_success_at`. A batch with per-file failures is `partial` and keeps the previous `last_success_at`. A materialization failure is `error` and also keeps the previous success time. `error` is a bounded, path-redacted summary (at most 240 characters), never a session message. Set `sweep_interval_seconds` from `HUMAIN_ORCHESTRATOR_INGEST_INTERVAL` when present; otherwise retain the previous status value, falling back to `900` seconds only before any configured value is available. Staleness is computed as more than two configured sweep intervals since `last_success_at`; missing/invalid timestamps are `unknown`, and a future timestamp is clamped to non-stale rather than raising.

### Task 1: CLI ingest status and recoverable materialization

**Files:**
- Modify: `orchestrator/cli.py`
- Create: `tests/test_cli_ingest.py`
- Modify: `tests/test_ingest.py`

**Interfaces:**
- Consumes: `ingest_paths(paths, ..., dry_run, granularity)` and the existing atomic `runtime.write_json(path, value)`.
- Produces: `process_ingest(paths: list[Path], *, state_root: Path, runtime: str | None, repository: str | None, dry_run: bool, granularity: str) -> dict[str, Any]`; it writes `ingest_status.json` following the Status Contract and refreshes after every completed non-dry-run batch, even if `emitted == 0`.
- Status writer interface: `make_ingest_status(previous: dict[str, Any], result: dict[str, Any], *, materialization_error: Exception | None = None) -> dict[str, Any]`; preserve `previous["last_success_at"]` for partial/error results, including a dashboard-render failure after ingestion.
- `refresh(state_root: Path = ROOT) -> Path` rebuilds the ledger and renders the dashboard for the given root; `process_ingest` calls it after the ingest batch.
- CLI behavior: preserve dry-run as side-effect-free; report partial file failures with a non-zero process exit only after successfully materializing the rows that did append.

- [ ] **Step 1: Add a failing duplicate-only refresh test.** Create a temporary state root and fixture session, ingest it once, then invoke `process_ingest` again with that same path while spying on `refresh`.

```python
with patch("orchestrator.cli.refresh") as refresh:
    result = cli.process_ingest([session], state_root=root, runtime="humain-terminal",
                                repository=None, dry_run=False, granularity="session")
assert result["emitted"] == 0
assert len(load_jsonl(root / "metrics.jsonl")) == 1
refresh.assert_called_once_with(root)
```
- [ ] **Step 2: Run the focused test and verify it fails.** Run: `python3 -m pytest tests/test_cli_ingest.py::test_duplicate_only_ingest_still_refreshes -q`. Expected: FAIL because the current CLI skips `refresh()` when `emitted` is zero.
- [ ] **Step 3: Add failing status and failure-recovery tests.** Cover (a) an `ok` status on a duplicate-only batch, (b) a `partial` status and non-zero command result when one path is unreadable but another has valid usage, (c) no status or refresh writes in dry-run mode, and (d) renderer failure after metric append followed by a duplicate-only retry that regenerates without appending a second metric. Assert exact status fields and preserved `last_success_at`; force the materialization failure after capturing the pre-attempt status so the failed render cannot become the recorded last success.
- [ ] **Step 4: Run the status tests and verify they fail for the missing behavior.** Run: `python3 -m pytest tests/test_cli_ingest.py -q`. Expected: failures for absent status, partial-batch result handling, and skipped duplicate-only recovery.
- [ ] **Step 5: Implement the status/materialization path.** Factor the `ingest` branch into `process_ingest` with the signature above; import `write_json` from `.runtime` and use it for status replacement; call `refresh(state_root)` after every completed non-dry-run batch; preserve the pre-attempt success timestamp on partial/error. Write a provisional current status before refresh so generated HTML can display the latest result; retain the pre-attempt status in memory and use it when rewriting the status as `error` if materialization fails. For `failures`, materialize successful rows, save `partial`, then return non-zero so the hook can retry. Do not write status or materialize for `--dry-run`.

```python
previous = read_json(state_root / "ingest_status.json", {})
result = ingest_paths(paths, runtime=runtime, repository=repository,
                      state_root=state_root, dry_run=dry_run, granularity=granularity)
if not dry_run:
    status = make_ingest_status(previous, result)
    write_json(state_root / "ingest_status.json", status)
    try:
        refresh(state_root)
    except Exception as error:
        write_json(state_root / "ingest_status.json",
                   make_ingest_status(previous, result, materialization_error=error))
        raise
return result
```
- [ ] **Step 6: Add the malformed trailing-record regression.** Extend the existing HUMAIN Terminal fixture with one valid assistant usage line followed by a truncated JSON line; assert the valid call is emitted and the attempt is not misreported as total loss.
- [ ] **Step 7: Run focused Python tests.** Run: `python3 -m pytest tests/test_cli_ingest.py tests/test_ingest.py -q`. Expected: PASS, including duplicate-only refresh, partial status, render recovery, dry-run purity, and truncated-tail retention.
- [ ] **Step 8: Commit the CLI/status unit.** Stage only `orchestrator/cli.py`, `tests/test_cli_ingest.py`, and `tests/test_ingest.py`; commit as `fix: refresh dashboard after every ingest batch`.

### Task 2: Reliable settled-turn scheduler and hook reporting

**Files:**
- Modify: `bridge/extensions/orchestrator/ingest.ts`
- Modify: `bridge/extensions/orchestrator/ingest.test.ts`
- Modify: `bridge/extensions/orchestrator/index.ts`
- Modify: `bridge/extensions/orchestrator/index.test.ts` — required hook-registration/wiring test.

**Interfaces:**
- Consumes: `SessionIngestScheduler` and `ingestArgs(sessionFile)`; the runner continues to call `orchestrator.cli ingest <file> --runtime humain-terminal --granularity session --quiet`.
- `runModule` must set `CODING_AGENT_ORCHESTRATOR_HOME` to the extension's resolved `STATE_ROOT`; this ensures Python ingestion and TypeScript hook reporting write to the same state root even when `HUMAIN_ORCHESTRATOR_STATE_ROOT` is customized.
- Hook seam: `type SessionIngestContext = { sessionManager: { getSessionFile(): string | undefined } }`; `registerSessionIngestHooks(host: { on(event: "agent_settled" | "session_shutdown", handler: (event: unknown, ctx: SessionIngestContext) => void | Promise<void>): void }, scheduler: SessionIngestScheduler): void`.
- Scheduler options add `maxAttempts?: number` (default `3`), `retryDelayMs?: number` (default `250`), and `waitForRetry?: (ms: number) => Promise<void>`; attempt `n` waits `retryDelayMs * 2 ** (n - 1)` before retry. Production `waitForRetry` uses `setTimeout`; tests inject a deterministic resolver.
- `index.ts` writes `ingest_status.json` through `recordHookFailure(stateRoot: string, detail: string): void` when the final scheduler retry fails, preserving the previous success timestamp and using atomic temp-file replacement. The status error is bounded and omits session text and absolute file paths. This covers failures before the Python CLI can update status; CLI-reported errors continue to use the same schema.
- Produces: one serialized ingest stream per session file; successful transient retry is silent, final failure is logged and remains recoverable by the next settled event/sweep; `flush()` resolves only after its current run and any queued rerun complete.

- [ ] **Step 1: Add a failing transient-retry test.** Use the existing fake timers and a runner that returns `{ok:false}` twice then `{ok:true}`; assert there are exactly three attempts, no final error notification, and `flush()` waits through the retry sequence.

```ts
let attempts = 0;
const errors: string[] = [];
const waits: number[] = [];
const scheduler = new SessionIngestScheduler({
  run: async () => (++attempts < 3 ? { ok: false } : { ok: true }),
  onError: (message) => errors.push(message),
  waitForRetry: async (ms) => { waits.push(ms); },
  maxAttempts: 3,
  retryDelayMs: 250,
  ...timers,
});
await scheduler.flush("/s/a.jsonl");
expect(attempts).toBe(3);
expect(waits).toEqual([250, 500]);
expect(errors).toEqual([]);
```
- [ ] **Step 2: Run the focused Bun test and verify it fails.** Run: `bun test bridge/extensions/orchestrator/ingest.test.ts`. Expected: FAIL because the scheduler currently reports the first failure without retrying.
- [ ] **Step 3: Add failing permanent-failure and overlap tests.** Assert permanent failure reports one final error after three attempts; a second settled event while the first ingest is in flight triggers exactly one rerun after the first completes; a shutdown `flush()` cancels the debounce and waits through queued work; missing session-file behavior remains a no-op.
- [ ] **Step 4: Implement bounded retry without breaking coalescing.** Add configurable `maxAttempts` (default 3), `retryDelayMs` (default 250, exponential per attempt), and `waitForRetry` (default implementation wraps `setTimeout`). Keep one in-flight runner and one rerun marker per scheduler; report through `onError` only after final failure. Ensure thrown errors and `{ok:false}` results share the same retry policy and skip delay after the final failure.

```ts
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    const result = await run(file);
    if (result.ok) return;
    if (attempt === maxAttempts) onError(result.detail ?? "failed");
  } catch (error) {
    if (attempt === maxAttempts) onError(error instanceof Error ? error.message : String(error));
  }
  if (attempt < maxAttempts) await waitForRetry(retryDelayMs * 2 ** (attempt - 1));
}
```
- [ ] **Step 5: Make hook wiring observable/testable.** Keep `agent_settled` as the debounced fast path and `session_shutdown` as the awaited flush. Export a narrow `registerSessionIngestHooks(host, scheduler)` seam that registers only those two events; default extension activation calls it with `pi` and the real scheduler, while tests capture the registered handlers. In `runModule`, pass `CODING_AGENT_ORCHESTRATOR_HOME: STATE_ROOT` so the Python CLI and extension cannot write to different state roots when the HUMAIN override is set. Export/test `recordHookFailure(stateRoot, detail)`: on final retry exhaustion, retain the prior `last_success_at`, atomically write status `error` with a bounded safe message, and keep appending to `ingest-hook.log`. Verify the dashboard can consume this status even when no CLI process starts.
- [ ] **Step 6: Run scheduler and extension tests.** Run: `bun test bridge/extensions/orchestrator/ingest.test.ts bridge/extensions/orchestrator/index.test.ts`. Expected: PASS, with no regression to existing orchestrator dispatch tests.
- [ ] **Step 7: Commit the hook/scheduler unit.** Stage only the four bridge files above; commit as `fix: retry settled-session ingestion failures`.

### Task 3: Dashboard health, safe rendering, and pausable auto-refresh

**Files:**
- Modify: `orchestrator/dashboard.py`
- Modify: `tests/test_dashboard_metrics.py`
- Modify: `tests/test_v3_engine.py`
- Modify: `install.sh` — `LAUNCHD_INTERVAL` and `render_launchd_plist()`.
- Create: `tests/test_install_sweep.py`

**Interfaces:**
- Consumes: `ingest_status.json` from the shared state root and the version 1 fields in the Status Contract.
- Produces: `build_data(...)["ingest_status"]` with `{status: str, last_attempt_at: str | None, last_success_at: str | None, emitted: int, failure_count: int, error: str | None, stale_after_seconds: int}`; status is `ok`, `partial`, `error`, `stale`, or `unknown`. The helper interface is `build_ingest_status(raw: Any, *, now: datetime) -> dict[str, Any]`. Generated HTML shows this without changing metric definitions.
- Refresh behavior: visible, unpaused tabs reload every five seconds; store/restore scroll position; a pause control disables the timer for the current page; do not reload hidden tabs.

- [ ] **Step 1: Add failing payload, atomic-write, and sweep-interval tests.** In `tests/test_dashboard_metrics.py`, write fixture `ingest_status.json` cases for current success, partial/error, missing/malformed status, stale success older than two sweep intervals, and a future timestamp. Assert `build_data` produces the documented states without raising; assert the status panel uses escaped status/error strings and never includes session message content. Add an atomic-generation regression that saves existing `dashboard.html` bytes, forces the replacement step to fail, and asserts the prior bytes remain intact and the temporary file is removed. In `tests/test_install_sweep.py`, run `install.sh` with temporary `HOME`, state/agent directories, an interval override, and a `launchctl` shim; inspect the generated plist without touching the real user LaunchAgents directory.
- [ ] **Step 2: Run the focused dashboard and installer tests and verify they fail.** Run: `python3 -m pytest tests/test_dashboard_metrics.py tests/test_install_sweep.py -q`. Expected: FAIL because `build_data` currently does not read ingest status, dashboard output is written directly to its destination, and the launchd plist does not currently forward the configured interval.
- [ ] **Step 3: Add failing auto-refresh behavior assertions.** Assert generated HTML no longer uses the 30-second meta refresh; includes a five-second timer, a pause control, visibility check, and scroll save/restore; update the existing assertion in `tests/test_v3_engine.py` that currently requires `<meta http-equiv="refresh">`.
- [ ] **Step 4: Run the refresh assertions and verify they fail.** Run: `python3 -m pytest tests/test_dashboard_metrics.py tests/test_v3_engine.py -q`. Expected: FAIL for the absent status UI and changed refresh controls.
- [ ] **Step 5: Implement status assembly and visible UI.** Load status with `runtime.read_json` and a conservative default; compute stale only from valid timestamps and the recorded interval; render a clear “not reported” state when absent. Escape status text using the existing `esc` helper. In `install.sh` `render_launchd_plist()`, include `HUMAIN_ORCHESTRATOR_INGEST_INTERVAL` in the existing `EnvironmentVariables` without changing the label, discovery arguments, `RunAtLoad`, or `StartInterval`. Keep status distinct from interactive-session cost/usage panels.

In `build_data`, add this entry to the existing return mapping:

```python
'ingest_status': build_ingest_status(
    read_json(root / "ingest_status.json", {}), now=datetime.now(timezone.utc)
),
```

`build_ingest_status(raw: Any, *, now: datetime) -> dict[str, Any]` returns the exact fields in the Task 3 interface; malformed input returns `unknown` with null timestamps rather than raising. Render that field in the HTML freshness/status section.
- [ ] **Step 6: Implement five-second pauseable refresh and atomic HTML replacement.** Replace unconditional meta refresh with one client-side timer that runs only when the page is visible and refresh is not paused. Save scroll position immediately before navigation, restore it once on page load, and toggle pause for the current page. Write generated HTML to a unique sibling temporary file and replace `dashboard.html` atomically (for example, via `os.replace`) so a failed render leaves the previous page intact.

```javascript
const refreshMs = 5_000;
let refreshPaused = false;
try {
  const savedY = sessionStorage.getItem("orch-scroll");
  if (savedY !== null) {
    window.scrollTo(0, Number(savedY) || 0);
    sessionStorage.removeItem("orch-scroll");
  }
} catch { /* sessionStorage may be unavailable for local files; keep refresh working */ }
setInterval(() => {
  if (document.visibilityState !== "visible" || refreshPaused) return;
  try { sessionStorage.setItem("orch-scroll", String(window.scrollY)); } catch { /* best-effort */ }
  window.location.reload();
}, refreshMs);
```

```python
html = doc
tmp = out.with_name(f".{out.name}.{secrets.token_hex(8)}.tmp")
try:
    tmp.write_text(html, encoding="utf-8")
    tmp.replace(out)
finally:
    tmp.unlink(missing_ok=True)
```

Wire the pause button to toggle the page-local `refreshPaused` boolean and update its accessible label. Avoid requiring localStorage; some browsers restrict web storage for `file://` URLs.
- [ ] **Step 7: Run focused dashboard and installer tests.** Run: `python3 -m pytest tests/test_dashboard_metrics.py tests/test_v3_engine.py tests/test_install_sweep.py -q`. Expected: PASS for status cases, escaped error display, atomic replacement, preservation of the original launchd sweep/configuration, interval/pause/visibility/scroll markup, and existing dashboard metrics.
- [ ] **Step 8: Commit the dashboard/status unit.** Stage only `orchestrator/dashboard.py`, `install.sh`, `tests/test_dashboard_metrics.py`, `tests/test_v3_engine.py`, and `tests/test_install_sweep.py`; commit as `feat: show session sync health in dashboard`.

### Task 4: End-to-end catch-up verification and operator documentation

**Files:**
- Modify: `tests/test_cli_ingest.py`
- Modify: `tests/test_ingest.py`
- Modify: `bridge/extensions/orchestrator/index.test.ts` — capture and invoke the actual registered lifecycle callbacks.
- Modify: `docs/TELEMETRY.md`
- Modify: `docs/INTEGRATION.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the CLI status/materialization behavior from Task 1, scheduler behavior from Task 2, and dashboard status contract from Task 3.
- Produces: an executable regression proving event-path and discovery/sweep paths converge on the same metrics/dashboard state without duplication; docs explain expected update latency, status interpretation, and recovery.

- [ ] **Step 1: Add a failing event-path and sweep integration test.** In `bridge/extensions/orchestrator/index.test.ts`, invoke the actual default extension export with a fake `ExtensionAPI` whose `pi.on` captures lifecycle callbacks and whose `registerCommand` is a no-op; default activation must route through `registerSessionIngestHooks`. Point the registered callbacks at a temporary HT session JSONL and isolated state root, invoke `agent_settled`, and verify the existing three-second debounce plus CLI path update `metrics.jsonl`, `ledger.json`, `dashboard.html`, and `ingest_status.json` within ten seconds. Assert a usage delta is emitted without any session text, replay the settled callback, and assert zero new metrics but a fresh successful check/dashboard generation; invoke and await `session_shutdown` to prove flush behavior. In `tests/test_cli_ingest.py`, create a temporary home with an HT session JSONL containing two assistant usage records, run actual CLI discovery against that home/state root, assert idempotent ingest, then simulate a skipped hook, append a third assistant usage record, and verify discovery catches it up exactly once.

```python
# Sweep-only recovery: deliberately do not dispatch agent_settled.
proc = subprocess.run(
    [sys.executable, "-m", "orchestrator.cli", "ingest", "--discover", "--since-days", "2",
     "--granularity", "session", "--quiet"],
    env={**os.environ, "HOME": str(home), "CODING_AGENT_ORCHESTRATOR_HOME": str(state),
         "PYTHONPATH": str(repo_root)}, check=False, capture_output=True, text=True,
)
assert proc.returncode == 0
assert sum(row["covers_calls"] for row in load_jsonl(state / "metrics.jsonl")) == 3
```
- [ ] **Step 2: Run the event and sweep integration tests.** Run: `HUMAIN_ORCHESTRATOR_SKILL_ROOT="$PWD" bun test bridge/extensions/orchestrator/index.test.ts` and `python3 -m pytest tests/test_cli_ingest.py -k 'settled_ingest or sweep' -q`. Expected after Tasks 1–3: event and discovery paths converge on the same metrics/dashboard/status state; any failure is isolated to the integration seam and is fixed test-first in Step 3.
- [ ] **Step 3: Pin remaining recovery/privacy cases and fix only a failing integration seam.** Add a same-session append during an in-flight scheduler run and assert the queued rerun sees it; add malformed/corrupt status JSON and assert dashboard generation produces `unknown`, not a traceback. Assert the fixture's distinctive message-text marker appears in none of `metrics.jsonl`, `ingest_status.json`, or generated HTML. If an integration assertion fails, retain it as the failing regression, make the smallest correction at the existing hook/CLI boundary, and rerun it. These tests map to Review Focus items 2–4 and acceptance criterion 8.
- [ ] **Step 4: Document operational behavior.** Update `docs/TELEMETRY.md` to state that settled HT turns ingest within the debounce/retry window, `ingest_status.json` drives dashboard health, message text is not ingested, and startup/periodic sweep reconciliation uses the configured interval (900 seconds by default). Update `docs/INTEGRATION.md` and `README.md` to state the dashboard refresh interval, pause control, session-log path, and that `--no-session` work is excluded from this path.
- [ ] **Step 5: Run all deterministic suites.** Run: `python3 -m pytest tests -q` and `HUMAIN_ORCHESTRATOR_SKILL_ROOT="$PWD" bun test bridge/extensions/orchestrator`. Expected: all Python and bridge tests pass.
- [ ] **Step 6: Verify deployment/reload instructions.** Confirm `~/.humain-terminal/agent/extensions/orchestrator` resolves to the updated bridge via the existing install symlink; document that a running HUMAIN Terminal session needs `/reload` or restart to load changed extension hooks. Do not reinstall launchd unless its existing label/config is absent.
- [ ] **Step 7: Commit integration/docs.** Stage only the integration tests and the three documentation files; commit as `test: verify per-turn session dashboard recovery`.

## Acceptance Mapping and Completion Check

- **AC 1:** Task 4's captured `agent_settled` hook test asserts metrics, ledger, dashboard, and status update with no manual command.
- **AC 2:** Task 4 asserts the real debounced event path completes within ten seconds (target); Task 2 retains the existing three-second debounce.
- **AC 3:** Tasks 1 and 4 assert duplicate replay emits no new metric while status and generated dashboard advance.
- **AC 4:** Tasks 1 and 3 assert a failed render preserves the prior HTML and duplicate-only retry repairs it without another metric.
- **AC 5:** Task 4 skips the event hook and invokes the actual CLI `--discover` path, asserting idempotent catch-up.
- **AC 6:** Task 3 tests visible-only five-second reload, scroll restore, and pause/resume.
- **AC 7:** Tasks 1 and 3 cover latest success/error, stale interval, recovery, and successful empty/duplicate checks.
- **AC 8:** Tasks 1 and 4 assert session message text never enters telemetry, status, or dashboard output.
- **AC 9:** Task 2 tests `session_shutdown` awaited flush and a missing session file (`--no-session`) no-op; Task 2/4 preserve sweep fallback.

- **Existing-code grounding gaps:** No current `ingest_status.json` path/schema, stale-state calculation, browser pause/scroll behavior, atomic HTML output, or launchd-to-process interval propagation exists; these are specified as new implementation work above. The extension/Python state-root values can also diverge when only `HUMAIN_ORCHESTRATOR_STATE_ROOT` is set, so Task 2 makes the CLI's `CODING_AGENT_ORCHESTRATOR_HOME` explicit. The spec does not prescribe the status filename/schema or exact stale multiplier/refresh interval; this plan defines `ingest_status.json`, the listed v1 fields, stale-after-two-sweep-intervals, and a five-second visible refresh. Scroll preservation is best-effort when a browser disables session storage for local files; the refresh itself must continue.

- Re-run the actual session-ingest command against a temporary fixture and verify: new delta → metric append → ledger/dashboard regeneration → status success; replay → no duplicate → dashboard still regenerates.
- Open the generated local HTML in a browser, leave it visible, append a new fixture delta, and verify the page updates within five seconds, retains scroll, and pauses/resumes correctly.
- Simulate an unavailable extension by skipping event delivery, run the discovery sweep, and verify the same final metrics and dashboard status.
- Confirm `git status --short` shows no changes to the pre-existing shutdown-recovery plan.

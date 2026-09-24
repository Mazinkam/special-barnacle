# Orchestrator Efficiency and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce measured subprocess/time/memory overhead without losing durable audit evidence, while making cost, duration, and routing evaluations trustworthy.

**Architecture:** Keep JSONL authoritative. Add a single coordinated write-and-refresh module behind the existing CLI, stream or checkpoint derived views, then migrate the HT bridge to bounded batches. Improve independent ingestion and diagnostic archival behind their own interfaces; retain backwards-compatible single-record operations.

**Tech Stack:** Python stdlib (fcntl, json, pathlib, gzip, hashlib), TypeScript HT extension, pytest and TS tests.

**Spec:** `docs/superpowers/specs/2026-09-23-orchestrator-efficiency-and-evidence-design.md`

## Global Constraints

- No deletion of authoritative `events.jsonl`, `metrics.jsonl`, `outcomes.jsonl`, or their integrity metadata; preserve old CLI commands and historical JSONL compatibility.
- Default run archive is dry-run; archives are lossless and indefinitely restorable; do not archive active/incomplete runs or silently break log lookup.
- Benchmarks and archive tests operate only on copies or temporary roots, never live shared state; no SQLite canonical migration.
- No automatic switch to routing `enforce`, no weakening quality/safety gates; use existing `premium` profile for orchestrated workers/reviewers.
- Every successful batch invocation persists its records and refreshes the dashboard; interrupted publication retains last complete view; ambiguous retries are idempotent.
- Deploy from worktree only after review/integration; never assume HT's installed extension updates in a running process.

## Review Focus

- A subprocess dies after append but before response: retry with the same record IDs must not double charge or lose a completion (Task 2).
- Another runtime writes during a dashboard rebuild: published snapshot stays complete and next acknowledged write catches up (Tasks 2–3).
- A source session rotates or truncates while importing: resumed ingestion must neither skip lines nor duplicate costs (Task 5).
- A run looks old but has no durable completed marker: archival skips it and explains why (Task 6).
- Several calls have no tokens, cost, or finish time: reports show missing coverage instead of zero cost/duration (Task 1).

---

### Task 1: Evaluation and routing evidence

**Files:** Modify `orchestrator/history.py`, `orchestrator/adaptive.py`, `orchestrator/dashboard.py`, `bridge/extensions/orchestrator/index.ts` (time fields only); create `orchestrator/run_evidence.py`, `tests/test_run_evidence.py`, extend `tests/test_history_scheduler.py`, `tests/test_v3_engine.py` and `bridge/extensions/orchestrator/index.test.ts`.

**Interfaces:** `run_evidence.summarize_runs(metrics,events,outcomes) -> list[dict]` reports actual/counterfactual provenance, known-cost and unmetered counts, elapsed wall time or `None`, verification and rework. `build_route_stats` continues to return existing fields, with meaningful task/run sample counts. `adaptive_topology` uses the configured route min_samples.

- [ ] Write failing fixtures for separate cost and verification rows of a task, session-ingest exclusion, one-sample enforce topology, absent tokens/cost/duration, and elapsed time spanning parallel workers. Assert actual run cost equals sum of observed calls and unknown is not zero.
- [ ] Run `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -p no:cacheprovider -q tests/test_run_evidence.py tests/test_history_scheduler.py tests/test_v3_engine.py` and see targeted failures, not import errors.
- [ ] Implement the smallest task/run join and min-samples gate; capture start/finish timestamps and monotonic elapsed time at HT run terminal boundary. Keep existing metric attribution and show coverage in dashboard/report. Label flat-baseline comparisons counterfactual.
- [ ] Re-run targeted tests, bridge tests and full Python suite; commit only this task's files as `feat: report complete orchestrator run evidence`.

### Task 2: Coordinated durable batches and incremental ledger

**Files:** Create `orchestrator/record_batch.py`, `tests/test_record_batch.py`; modify `orchestrator/runtime.py`, `orchestrator/state.py`, `orchestrator/cli.py`; extend `tests/test_concurrent_state_writes.py`.

**Interfaces:** `write_batch(root, records: list[dict]) -> dict` validates a bounded ordered batch with stable record IDs and returns per-stream persisted counts, `ledger_updated`, `dashboard_updated`; `rebuild(root)` remains full-recovery replay, and incremental replay keeps a durable event offset within ledger metadata. Existing `event`, `metric`, `outcome`, `rebuild` CLI commands remain accepted.

- [ ] Add failing subprocess and cross-process tests: batch order, unsupported stream, malformed record (all-or-nothing validation), repeated IDs, process interrupted between append and response, append concurrent with rebuild, malformed checkpoint/trailing partial line recovery, and legacy ledger without offset.
- [ ] Run `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -p no:cacheprovider -q tests/test_record_batch.py tests/test_concurrent_state_writes.py` to capture failures caused by missing behavior.
- [ ] Implement one process-safe append/checkpoint lock and reusable record ID deduplication, preserving JSONL as authoritative and ordering append before acknowledging. Advance checkpoint only after a full replayable prefix; recover ambiguous failures by replay/dedup. Wire CLI `batch` and single-record commands into the common writer; keep full `rebuild` as recovery path.
- [ ] Run targeted and full Python suite; commit task files as `feat: batch durable orchestrator records`.

### Task 3: Bounded-memory and atomic dashboard refresh

**Files:** Modify `orchestrator/runtime.py`, `orchestrator/dashboard.py`, `orchestrator/outcomes.py`, `orchestrator/cli.py`; create `tests/test_dashboard_refresh.py`, `scripts/benchmark_refresh.py`.

**Interfaces:** `iter_jsonl(path)` yields valid complete records without holding all bytes; `generate_dashboard(root)` atomically publishes a complete HTML document and returns the same path. Preserve full-history aggregates and UI fields while bounding recent-record retention. The benchmark script reads only copied fixtures and prints subprocess count, median elapsed seconds, peak child RSS, and throughput at 1x/2x/4x.

- [ ] Write failing tests comparing dashboard aggregates at large synthetic histories to current output, interrupted render retaining previous HTML, recent-row cap, and a metric with invalid trailing JSONL; capture the pre-change benchmark on a copied root.
- [ ] Run targeted test red; implement streaming aggregate/reuse where possible, one sorted cost array, bounded recent rows, and same-directory atomic HTML replacement without removing durable rows. Use the new batch CLI refresh path rather than per-record redundant scans.
- [ ] Run targeted/full Python tests and compare benchmark; if peak RSS/elapsed time regress materially, record the result and revert that optimization while retaining correctness changes. Commit as `perf: stream and atomically publish orchestrator dashboard`.

### Task 4: HT bridge bounded batch integration

**Files:** Modify `bridge/extensions/orchestrator/index.ts`, `bridge/extensions/orchestrator/ingest.ts` only if shutdown coordination requires it; create `bridge/extensions/orchestrator/record-queue.ts`, `bridge/extensions/orchestrator/record-queue.test.ts`; extend `bridge/extensions/orchestrator/index.test.ts`.

**Interfaces:** `RecordQueue.enqueue(stream, record)` assigns stable IDs and schedules a bounded flush; `flush()` waits for acknowledged Python `batch`, serializes overlapping flushes, retries only same IDs after ambiguous failure, and drains on run completion/cancel/crash/shutdown. Error states visible to caller/UI; legacy single-record helpers remain available for other runtimes.

- [ ] Write failing integration tests for at least two records requiring one Python spawn, malformed batch error, an ambiguous exit replay using same IDs, no delayed terminal status, cancellation and shutdown drain, and progress staying responsive.
- [ ] Run the actual repository TS test command for these files and confirm red; implement queue, use `batch` once per bounded dispatch/run boundary, keep prompt updates non-blocking but terminal flush awaited.
- [ ] Run TS tests/typecheck when available and full Python suite; count spawns in an instrumented test versus baseline. Commit as `perf: batch HT orchestrator telemetry`.

### Task 5: Concurrent incremental session ingestion

**Files:** Modify `orchestrator/ingest.py`, `orchestrator/cli.py`; create `orchestrator/ingest_checkpoint.py`, `tests/test_ingest_checkpoint.py`; extend `tests/test_ingest.py`.

**Interfaces:** `ingest_paths(..., state_root=...)` retains existing return shape and `dry_run`; checkpoint stores source identity, verified byte offset, granularity, and dedup state that can be reconstructed from authoritative metrics. Competing ingesters serialize check/append/checkpoint, and granularity transitions either reconcile explicitly or fail with an actionable error.

- [ ] Benchmark repeated unchanged-session ingestion on temporary copied streams; add failing tests for second import doing no source replay, rotations, truncation, partial last lines, crash between append and checkpoint, competing processes, and changing session/call granularity.
- [ ] Run `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -p no:cacheprovider -q tests/test_ingest.py tests/test_ingest_checkpoint.py` to see red.
- [ ] Implement checkpoint/reconciliation only when benchmark shows benefit; coordinate dedup under the common writer lock. Retry same call IDs; keep old log readers as fallback on checkpoint mismatch and never advance checkpoint before durable append.
- [ ] Re-run tests/full suite and 1x/2x/4x benchmark; commit as `perf: checkpoint and serialize session ingestion`.

### Task 6: Opt-in reversible archive and operator guidance

**Files:** Create `orchestrator/archive.py`, `tests/test_archive.py`; modify `orchestrator/cli.py`, `README.md`, `bridge/extensions/orchestrator/index.ts` (archived-path UX only).

**Interfaces:** `archive_runs(root, *, older_than_days, execute=False) -> list[dict]` prints paths and estimated space; execute requires explicit flag and stores verified gzip plus SHA-256 manifest. `restore_run(root, run_id)` validates and restores exact bytes. Discovery returns a helpful archived-path message. No calls from background timers or automatic cleanup.

- [ ] Write failing tests for dry-run leaves files untouched; active, missing-status and recently completed skips; archive→restore byte identity; disk-full/interrupted compression retaining raw; repeated execution; existing progress path and recovery metadata.
- [ ] Run targeted tests red; implement same-directory temporary compressed file, verify decompress/hash before replacing raw, durable manifest, and clear CLI `archive-runs` and `restore-run` help; leave event/metric/outcome stream names explicitly excluded.
- [ ] Run targeted/full Python and available TS tests. On a copied state show dry-run estimated bytes and verified round-trip without executing on live state. Commit as `feat: archive completed run diagnostics losslessly`.

### Task 7: End-to-end measurement and rollout documentation

**Files:** Modify `README.md`, `scripts/benchmark_refresh.py`; create `tests/test_efficiency_regression.py`.

**Interfaces:** A reproducible command against copied 1x/2x/4x data emits comparable before/after timings and RSS; release checklist records whether priced coverage and verified outcomes support a saving claim.

- [ ] Write end-to-end tests for legacy JSONL → batch append → crash/replay → consistent ledger/dashboard; missing prices remain unmetered; active diagnostics untouched; new commands visible in CLI help.
- [ ] Run tests red; add only needed integration glue, document HT extension reload after merge, no-live-state benchmark steps, restoration, pricing coverage, and routing `recommend` default.
- [ ] Run `PYTHONDONTWRITEBYTECODE=1 python3 -B -m pytest -p no:cacheprovider -q`, TS tests/typecheck if present, `git diff --check`, and copied-fixture benchmark; report measured outcomes and any unimplemented spec requirements explicitly. Commit as `test: verify orchestrator efficiency and recovery`.

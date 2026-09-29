# Model Failover Modular Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the existing model-backup and provider-failover feature onto current `main`'s modular orchestrator without restoring its superseded `index.ts` architecture.

**Architecture:** Keep pure model qualification and candidate selection behind the adapter/model-routing boundary; reuse current `core/transient-error.ts` for provider signal detection; run retry orchestration in a focused dispatch module called by `dispatch/parallel.ts`. Store run-scoped candidates and model health on `RunContext`, and preserve the current public command/pipeline seams. Keep Python method rules and TS bridge behavior sourced from `orchestrator/method.json`.

**Tech Stack:** TypeScript, Bun tests, Python/pytest, strict bridge typecheck.

**Spec:** `docs/superpowers/specs/2026-09-25-model-failover-design.md`; original implementation and reasoned deviations: `docs/superpowers/plans/2026-09-25-model-failover.md`.

## Global Constraints

- Work from this `main`-based worktree; do not copy or merge the old branch's monolithic `index.ts` wholesale.
- Preserve modular boundaries: `dispatch/*` must not import `index.ts`; `core/*` stays pure and receives I/O as parameters; `run/*` must not import `index.ts`.
- Never fail over to a lower capability tier; backups must meet the declared context/output requirements; explicit primary bindings remain usable with warnings.
- Never classify model-generated prose as provider failure; use harness errors/stderr and `core/transient-error.ts`'s guarded semantics.
- Retry only quota, transient provider, and no-progress stall failures. Task errors and cancellation return without model switching.
- Preserve cumulative spend-cap accounting, including nested worker cost, across all attempts.
- Use only fake/injected model attempts in tests; no live provider calls or writes to the real state root.
- Run Python tests, Bun tests, and typecheck separately; run lint before completion.

## Review Focus

1. A normal task error, user cancellation, spend-cap stop, or model prose that mentions an outage must not trigger provider fallback.
2. A backup with unknown/insufficient context or output facts must be excluded; a primary must remain usable with a warning.
3. Every attempt, including superseded attempts, must be billed once and included in the cumulative spend cap.
4. Parallel dispatches must share health state within one run without persisting it across runs.
5. A failed attempt after real work must pass a bounded, redacted handoff; retries must not silently discard partial work.

---

### Task 1: Configuration schema and model qualification

**Files:**
- Modify `bridge/extensions/orchestrator/models.ts` and `models.test.ts` for profile backup schema and model facts on `AvailableModel`.
- Modify `bridge/extensions/orchestrator/adapters/model-registry.ts` and its test to pass registry context/output/reasoning facts through.
- Create `bridge/extensions/orchestrator/adapters/model-catalog.ts` and test for validated override parsing and catalog construction.
- Modify `orchestrator/method.json`, `orchestrator/method.py`, and `tests/test_method.py` for requirement and failover rules.

- [ ] Add failing tests for profile backup validation (tier/capability keys, string-array values), model facts parsing/override precedence, and Python validation of positive requirement/failover bounds.
- [ ] Run only the focused Bun/Python tests and confirm failures identify the absent schema/behavior.
- [ ] Implement the schema, registry facts pass-through, pure model catalog, and Python rule validation.
- [ ] Run focused tests and `bash scripts/typecheck-bridge.sh --all`.

### Task 2: Candidate qualification, ordering, and per-run health

**Files:**
- Create `bridge/extensions/orchestrator/adapters/model-router.ts` and its tests.
- Create `bridge/extensions/orchestrator/model-health.ts` and its tests.
- Modify `bridge/extensions/orchestrator/run/context.ts` and related tests to hold candidates and shared health state for the active run.
- Modify `bridge/extensions/orchestrator/adapters/adapter-resolver.ts` and tests to calculate candidates after adapter precedence is resolved.

- [ ] Add failing tests for primary/twin/configured backup/higher-tier ordering, deduplication, alias resolution, missing facts, minimum qualification, and no lower-tier fallback.
- [ ] Add failing tests proving health cooldown is shared in-run, expires by injected time, and does not leak across RunContext instances.
- [ ] Implement pure candidate resolution, candidate formatting/warnings, health tracking, and resolution outputs.
- [ ] Run focused adapter/model/run-context tests and typecheck.

### Task 3: Failure classification and failover loop

**Files:**
- Create `bridge/extensions/orchestrator/core/failure-class.ts` and tests, integrating `core/transient-error.ts` and `provider-fallback.ts` without broadening unsafe status-code matching.
- Create `bridge/extensions/orchestrator/dispatch/failover-policy.ts` and tests.
- Create `bridge/extensions/orchestrator/dispatch/failover.ts` and tests.
- Create `bridge/extensions/orchestrator/dispatch/handoff.ts` and tests.
- Reuse and extend `bridge/extensions/orchestrator/event-scan.ts` only if current child events do not already expose the needed signal; do not duplicate existing event parsing unnecessarily.

- [ ] Add failing classification tests for provider quota/transient/stall, task failures, cancelled work, spend-cap stops, orchestrator diagnostics, and untrusted model prose.
- [ ] Add failing policy tests for same-model retry after real work, immediate switching when no work, region preference, bounded waits, max switches, and cancellation.
- [ ] Add failing handoff tests for changed files, nested workers, bounded text, path redaction, and prompt reconstruction.
- [ ] Implement injected-dependency failover loop and pure policy; bill each attempt and accumulate nested cost in the returned result.
- [ ] Run focused dispatch/core tests and typecheck.

### Task 4: Dispatch, triage, prompt, telemetry, and command integration

**Files:**
- Modify `bridge/extensions/orchestrator/dispatch/parallel.ts` and `parallel.test.ts` to use the resolved candidate list, shared model health, failover loop, and cumulative spend cap.
- Modify `bridge/extensions/orchestrator/index.ts` only as composition/wiring: candidate resolution, probes, event and final summary integration.
- Modify `bridge/extensions/orchestrator/commands/orchestrator-models.ts` and tests for backup display/qualification and optional live probing.
- Modify `bridge/extensions/orchestrator/core/prompts.ts` and tests to include nested-worker backup guidance and handoff context where the existing prompt builder owns those responsibilities.
- Modify `bridge/extensions/orchestrator/core/records.ts` / dispatch telemetry only where needed to record actual model attempts without false attestation or double billing.
- Modify the lead persona documentation to require nested worker backups via the existing `onFailure.retryWith` contract.

- [ ] Add failing integration tests proving dispatches switch candidates on provider failure, do not switch on task/cancel failures, retain spend-cap offsets including nested cost, and share model health across later dispatches.
- [ ] Add failing tests that command output lists qualified/excluded backups and route/final summaries include visible switches.
- [ ] Wire failover through the current modular seams; ensure triage, recon, architect, leads, QA, and escalation dispatches all use the same dispatch boundary.
- [ ] Run `bun test bridge/extensions/orchestrator/dispatch`, relevant command/adapter/pipeline tests, and typecheck.

### Task 5: Shipped profiles, docs, full verification, and merge

**Files:**
- Modify `bridge/orchestrator-profiles.json`, `bridge/README.md`, `bridge/extensions/orchestrator-README.md`, and the existing failover design/plan docs to match current modular paths.
- Add/adjust `orchestrator/method.json` / Python tests only if final parity checks reveal schema drift.

- [ ] Add qualifying backups to shipped profiles and ensure custom user profiles are not silently rewritten by install/update paths.
- [ ] Document candidate qualification, facts overrides, failure classes, cooldown/wait bounds, nested backup expectations, and upgrade-only tier behavior.
- [ ] Run the complete verification separately: `python3 -B -m pytest -p no:cacheprovider -q`; `bun test ./bridge`; `bash scripts/typecheck-bridge.sh --all`; `bash scripts/lint.sh`; then `git diff --check` and confirm clean working-tree state before integration.
- [ ] Review current-main diff for spec gaps and architecture violations, fix any findings, and repeat affected checks.
- [ ] Merge the finished branch into `main` only after verification is green. Do not push unless separately requested.

## Spec coverage review

This plan covers profile schema, model requirements and facts, qualifying ordered backups, bounded failover/classification, handoff, all bridge dispatch entry points, nested worker guidance, telemetry/summary visibility, shipped profiles, docs, Python parity, and validation. The port intentionally adapts the old implementation to the modular architecture and reuses the current transient provider classifier. Live provider operations and persistent health state remain out of scope as specified.

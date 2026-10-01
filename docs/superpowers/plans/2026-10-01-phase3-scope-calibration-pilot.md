# Phase 3 — Scope Resolution, Routing Calibration and the Pilot Evaluation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tiered workflow able to route real, user-phrased goals (today it never can), prove the routing is right offline for cents, then run a budgeted, parallel pilot of `direct` vs `current` vs `tiered` and decide — with a sample-size calculation — whether a confirmatory run is worth paying for.

**Architecture:** A bounded, read-only *scope scout* (the existing `orch-scout` persona on the cheap tier) runs inside `/orchestrate` only when the deterministic signals find no candidate files; its file list feeds the existing router. A `--route-only` flag stops a run right after routing, so routing can be measured on the benchmark suite through the exact production path. The harness gains per-attempt state roots and `--jobs N` parallelism, a routing-calibration script that compares the scout's files and level with an oracle derived from each task's reference patch, and a power script. Spending steps are explicit human gates.

**Tech Stack:** TypeScript on Bun (bridge), Python 3.9+ (harness), the pinned tools under `~/orch-bench/tools`.

**Spec:** `docs/superpowers/specs/2026-09-29-tiered-workflows-and-eval-design.md` (§2.4, §3.2, §4). Builds on the Phase 0–2 plans and `docs/BENCHMARK.md`.

## Evidence this plan responds to (2026-10-01)

| Finding | Number |
|---|---|
| Live observe-mode runs routed (19 runs) | `led` 10, `full` 9, `direct`/`checked` 0 |
| Router candidates found on the 20 benchmark goals | **0 / 20** (all `led`/`full`): goals describe behaviour, not paths |
| Router with oracle files (reference-patch paths) | `direct` 2, `checked` 10, `led` 4, `full` 4 — 12/20 would run flat |
| "no adjacent tests" with oracle files | the sole reason for 8 of the 10 oracle-`checked` tasks (tests live in `test/`/`tests/` folders, not next to the source) |
| Signal collection overhead (live, 19 runs) | p50 24 ms, max 57 ms |
| Smoke (2 tiny tasks, all pass): current vs direct | ~8–10× cost, 5–160× time, 2 fix rounds each |
| Current-arm escalations in smoke | caused by pre-existing failures (base-commit test, >5 min bridge suite vs QA's own timeout) and benchmark-environment noise (nested `sandbox-exec`, humain-terminal typecheck drift: 833 → 40 errors after `hydrate:model-data`) |

Conclusion: running the `tiered` arm before scope resolution exists would measure `current` plus overhead. Part A comes first; nothing in Part C spends money until Part A's calibration gate passes.

## Global Constraints

- `workflow_policy.mode` on `main` is now `observe` (changed by commit `31e6eb4` in another session). The benchmark always sets the mode per arm (`current` = `off`, `tiered` = `enforce`); do not depend on the method default.
- The scope scout runs **only** when deterministic signals are ambiguous (zero candidates), at most **once** per run, read-only tools (`read,grep,find,ls`), cheap tier, its own timeout, and its cost is captured like every dispatch. A scout failure, timeout or unparseable reply leaves the signals ambiguous (→ `led`); it never aborts a run and never lowers a floor.
- Scout-proposed paths are evidence, not instructions: keep only repo-relative paths that exist in `git ls-files`, reject unsafe paths, cap the list.
- In `observe` mode the scout adds real (small) cost to live runs; it is recorded in `workflow_level_planned` (`scout.cost_usd`, `scout.ms`) and must be visible, never silent.
- Hidden checks, reference patches and oracle files are never shown to any agent; the oracle is computed by the harness only.
- Every spending step prints an estimate and requires `--approve-usd`; tuning uses the `dev` split only; the `holdout` split runs once, after thresholds are frozen.
- Rebuild the pinned tools (`scripts/bench_tools.py --force`) after Part A merges: `~/orch-bench/tools/skill` is pinned at `80d4556`, which has no scout.
- Never `git add -A`/`commit -a`; never write the live state root; tests use temp dirs and the fake agent.

## Review Focus

1. A scout reply that names files outside the repo, absolute paths, `..` segments or nonexistent files must contribute nothing — Task A2.
2. A scout that times out or crashes must leave the run on its original (ambiguous → `led`) route and record `scout.error` — Task A4.
3. A risk-path file proposed by the scout must raise the floor to `full` exactly as a goal-named one does (the scout can only add evidence, never remove a floor) — Task A3/A4.
4. Two concurrent orchestrated attempts must never see each other's cost or run rows — Task B1.
5. `--route-only` must not count as a pass, a fail or a blocked run in any analysis — Task A5.

---

## Part A — Scope resolution in the bridge

### Task A1: `workflow_policy.scope_scout` in `method.json`, validated in both runtimes

**Files:** `orchestrator/method.json`, `orchestrator/method.py` (`_validate` workflow_policy block), `bridge/extensions/orchestrator/models.ts` (`WorkflowPolicy`), tests `tests/test_method.py`, `bridge/extensions/orchestrator/models.test.ts`.

**Interfaces:** `WorkflowPolicy.scope_scout?: { enabled: boolean; max_candidates: number; timeout_ms: number }`; JSON default `{ "enabled": true, "max_candidates": 25, "timeout_ms": 120000 }`.

- [ ] Failing tests: Python — missing block is allowed; `enabled` must be bool; `max_candidates`/`timeout_ms` positive ints (mutate and expect `ValueError` naming the key, mirroring the existing workflow_policy mutation test). Bun — `METHOD.rules.workflow_policy!.scope_scout` equals the default.
- [ ] Implement: add the JSON block; in `_validate`, `ss = wf.get("scope_scout")`; if not None: `isinstance(ss, dict)`, `isinstance(ss.get("enabled"), bool)`, `_positive_int` for the two ints, each with a message containing `workflow_policy.scope_scout.<key>`; add the optional TS field.
- [ ] Run `python3 -m pytest -q tests/test_method.py` and `cd bridge/extensions/orchestrator && bun test models.test.ts` — PASS; commit `feat(method): workflow_policy.scope_scout (bounded read-only scope scout)`.

### Task A2: `core/scope-scout.ts` — task builder and strict reply parser

**Files:** create `bridge/extensions/orchestrator/core/scope-scout.ts` and `core/scope-scout.test.ts`.

**Interfaces:**

```ts
export const SCOPE_SCOUT_TOOLS = ["read", "grep", "find", "ls"] as const;
export function buildScopeScoutTask(runId: string, goal: string, maxCandidates: number): DispatchTask;
export function parseScopeCandidates(reply: string, repoFiles: string[], maxCandidates: number): string[];
```

`buildScopeScoutTask` returns `{ taskId: `${runId}-scope-scout`, capability: "scout", tools: [...SCOPE_SCOUT_TOOLS], task }`, where `task` asks the scout to find the files a change for the goal would most likely edit (source files first, then their tests), to not edit anything, and to end with a `## Candidate files` section of at most `maxCandidates` bullets, one repo-relative path per bullet, no prose in bullets.

`parseScopeCandidates` reads only the bullets under the **last** `## Candidate files` heading (until the next `## ` or end), strips backticks/leading `./`/trailing punctuation, rejects absolute paths, `..` segments, NUL and backslashes, keeps only paths present in `repoFiles` (exact match), de-duplicates preserving order, caps at `maxCandidates`.

- [ ] Failing tests (table-driven): happy path; paths outside the repo, absolute, `..`, nonexistent → dropped; a quoted/fenced fake `## Candidate files` earlier in the reply is ignored in favour of the last real heading; duplicates collapse; cap honoured; no heading → `[]`; the task string contains the goal, `## Candidate files` and the read-only instruction; `tools` equals the four read-only tools.
- [ ] Implement; run `bun test core/scope-scout.test.ts`; typecheck; commit `feat(bridge): scope scout task builder and strict candidate parser`.

### Task A3: signals accept scout candidates; package-level test rule

**Files:** modify `bridge/extensions/orchestrator/core/workflow-signals.ts` and its test.

**Interfaces:** `collectWorkflowSignals(input & { extraCandidates?: string[] })`; `WorkflowSignals.candidateSource: "goal" | "scout" | "goal+scout" | "none"`. `ambiguous` stays `candidates.length === 0` after merging.

Test rule broadening (`hasAdjacentTest`): in addition to the current same-directory/`tests/test_<stem>.py` rules, a candidate counts as tested when any repo file under `test/`, `tests/` or `__tests__/` **inside the same package** (nearest `package.json`/`pyproject.toml` dir) has basename `<stem>.test.<ext>`, `<stem>.spec.<ext>` or `test_<stem>.py`.

- [ ] Failing tests: extra candidates merge, de-dup and set `candidateSource`; a scout-proposed `src/auth/x.ts` produces a `riskPathHits` entry (so the router floors `full`); `packages/coding-agent/src/cli/args.ts` with `packages/coding-agent/test/args.test.ts` → `testsNearby` true; a same-stem test in a *different* package does not count.
- [ ] Implement; `bun test core/workflow-signals.test.ts core/workflow-router.test.ts`; commit `feat(bridge): workflow signals take scout candidates; package-level test discovery`.

### Task A4: run the scout inside `runOrchestration` when signals are ambiguous

**Files:** modify `bridge/extensions/orchestrator/pipeline/run-orchestration.ts` (the workflow block after `lead_sized`, ~line 524) and `pipeline/run-orchestration.test.ts`.

**Behaviour:** inside the existing `if ((workflowMode.mode !== "off" || carry) && workflowPolicy)` block, after the first `collectWorkflowSignals` call: when `signals.ambiguous && !carry && workflowPolicy.scope_scout?.enabled`, dispatch `buildScopeScoutTask(runId, parsed.goal, max)` through `deps.dispatchParallel(cwd, runId, [task], adapter, ctx, claimed)` raced against `scope_scout.timeout_ms`, bill it with `deps.captureDispatchCost(captureOptsForScout, result, claimed)`, parse with `parseScopeCandidates(result.stdout, files, max)`, and if non-empty recompute signals with `extraCandidates`. Record on `workflow_level_planned`: `candidate_source`, and `scout: { ran, candidates, ms, cost_usd, error }` (`error` set on timeout, non-zero exit or empty parse). The scout result is included in the run's billed results so `total_cost_usd` covers it.

`captureDispatchCost` needs `CaptureOpts`, which today is built later (Step 2). Build the scout's `CaptureOpts` from the values already known at this point (`runId`, `plan.plan_id`, `effectiveTaskClass`, `effectiveComplexity`, `effectiveRisk`, `plan.route.recommended`, `plan.route.mode`) — the same fields Step 2 uses.

- [ ] Failing tests (fake deps, as the existing observe-mode tests do): ambiguous goal + scout reply naming one existing low-risk file with an adjacent test and a discovered check → `workflow_level_planned.level === "direct"`, `candidate_source === "scout"`, `scout.ran === true`, and exactly one `scout` dispatch billed; scout timeout → level `led`, `scout.error` contains `timeout`; scout naming `src/auth/a.ts` → `full`; `off` mode → no scout dispatch; goal that already names a file → no scout dispatch; `carry` (escalated inner run) → no scout dispatch.
- [ ] Implement; full `bun test`; typecheck; commit `feat(workflow): bounded scope scout when routing signals are ambiguous`.

### Task A5: `--route-only`

**Files:** `core/args.ts` (+test), `pipeline/run-orchestration.ts` (+test), `core/records.ts` (`runCompletionOutcomeFor`, +test), `orchestrator/run_evidence.py`, `orchestrator/analytics/task_outcomes.py` (+tests).

**Behaviour:** `--route-only` (boolean) makes `runOrchestration` stop immediately after `workflow_level_planned` is recorded: `deps.completeRun(runId, { route_only: true, workflow: {...}, total_cost_usd: <triage + scout>, verification_passed: null, retries: 0, fix_rounds: 0 }, timing, baseline)` and return `{ kind: "completed", report }` with a minimal report. It forces signal collection even when the resolved mode is `off` (it is a measurement command). `runCompletionOutcomeFor` returns `outcome: "route_only"` when `summary.route_only === true`. Python: `summarize_runs` maps a `route_only` run-complete to `status: completed`, `verification: unknown`, and adds `route_only: true`; `task_outcomes` carries `route_only` and `summarize_task_outcomes` excludes route-only rows from every pass/fail/cost aggregate.

- [ ] Failing tests at each layer (argument parsing; pipeline stops before `dispatch_plan_confirmed` and no lead is dispatched; outcome row; evidence/task-outcome exclusion).
- [ ] Implement; `python3 -m pytest -q`, `bun test`, typecheck, lint; commit `feat(orchestrate): --route-only stops after routing for measurement`.

---

## Part B — Harness for calibration and a parallel pilot

### Task B1: per-attempt orchestrator state roots

**Files:** `bench/arms.py`, `bench/runner.py`, `bench/contamination.py` call sites, tests.

**Behaviour:** `arm_invocation(..., state_root: Path)` takes the state directory explicitly; the runner passes `root / 'state' / attempt_id`. `_run_cost`, `_outcome_rows`, `_run_dirs` and the contamination scan read that attempt's own state dir, so concurrent attempts cannot see each other's rows. `injected_env_keys()` is unchanged (same variable names).

- [ ] Failing test: two attempts of the same task run with the fake agent each record only their own `run_id` and cost (`0.01` each), and each attempt's `state/` contains exactly one run.
- [ ] Implement; bench tests; commit `fix(bench): per-attempt orchestrator state roots`.

### Task B2: `--jobs N` with a shared budget guard

**Files:** `bench/runner.py`, `scripts/bench_run.py`, tests.

**Behaviour:** `run_experiment(..., jobs=1)` runs up to `jobs` attempts concurrently (`concurrent.futures.ThreadPoolExecutor`; each attempt already has its own tree, state root, marker and cleanup). Journal writes take a `threading.Lock`. Before launching an attempt, the runner checks `spent_so_far + running_attempts × per_run_usd_cap + per_run_usd_cap <= approve_usd`; if not, it stops launching and records nothing for the unlaunched attempts (they remain resumable). Prepared trees are built before the pool starts (one per task, sequentially) so installs never race. SIGTERM still kills every marked process of every running attempt.

- [ ] Failing tests: `jobs=3` with 6 fake attempts completes faster than 6 × the fake sleep and journals 6 rows; a budget of `2 × cap` with `jobs=3` launches only 2; SIGTERM mid-run kills all running attempts' detached children (extend the existing orphan test).
- [ ] Implement; bench tests; commit `feat(bench): --jobs N parallel attempts under a shared budget guard`.

### Task B3: routing calibration (`scripts/bench_route_check.py`)

**Files:** create `scripts/bench_route_check.py`, `bench/route_oracle.ts`, `tests/test_bench_route_check.py`.

**Behaviour:**
- Oracle per task (harness-only, never shown to agents): `oracle_files` = paths in `reference.patch` (`diff --git a/<p>`); `oracle_level` = `bun bench/route_oracle.ts <skill_root> <tree> <risk> <task_class> <files...>` which calls `collectWorkflowSignals` (with `extraCandidates: oracle_files`) and `routeWorkflow` from the pinned skill copy and prints JSON.
- Observed per task: clone the prepared tree, run the pinned binary `--mode json -p --no-session --no-extensions -e <skill>/bridge/extensions/orchestrator "/orchestrate --route-only <flags> <goal>"` under the same sandbox, agent dir and clean environment as an attempt (reuse `arm_invocation` with a `route` pseudo-arm, or factor its env construction), then read `workflow_level_planned` from that attempt's state.
- Metrics per task and overall: scout recall and precision vs `oracle_files`; level agreement; **under-route** (observed level lower than oracle — the dangerous direction) and over-route counts; scout cost and latency; `candidate_source`.
- Output: a table plus `--json`; requires `--approve-usd` (estimate = tasks × triage+scout cap, default cap $0.25/task); `--split dev|holdout`.

- [ ] Failing tests with the fake agent (a `routeonly:<json>` behaviour that writes a `workflow_level_planned` event and a run-complete) and a fake oracle (inject the oracle runner): metric computation, under-route detection, budget refusal, holdout refusal unless `--split holdout` is explicit.
- [ ] Implement; tests; lint; commit `feat(bench): routing calibration against reference-patch oracles`.

### Task B4: pilot power and sample size (`scripts/bench_power.py`)

**Files:** create `scripts/bench_power.py`, `tests/test_bench_power.py`.

**Behaviour:** from a pilot journal, per comparison (`tiered` vs `current`, `tiered` vs `direct`): per-task paired completion differences (same definition as `bench/stats.py`), their mean and SD; the number of **independent tasks** needed so the one-sided 95% lower bound clears the agreed −5 pp margin with 80% power, using a normal approximation on task-level differences and a Holm-adjusted alpha across the declared primary comparisons; also the tasks needed to detect a 30% median cost/time ratio change. Reports "pilot too small to estimate" when fewer than 5 tasks have non-degenerate differences. Never claims power the data cannot support.

- [ ] Failing tests on synthetic journals (known SD → known n within ±1; degenerate all-pass → "too small"; Holm alpha for 2 comparisons).
- [ ] Implement; tests; commit `feat(bench): pilot-based sample size for the confirmatory run`.

---

## Part C — Running it (human-gated; each step needs explicit approval)

### Task C1: rebuild pinned tools and refresh the suite

- [ ] `python3 scripts/bench_tools.py --dest ~/orch-bench/tools --skill-repo <repo> --skill-rev main --ht-repo ~/Documents/Projects/humain-terminal --ht-rev main --force`; update `~/orch-bench/config.json` only if paths changed; re-run the preflight (0 problems).
- [ ] Confirm the humain-terminal re-validation with `hydrate:model-data` setup passed (`~/orch-bench/validate-ht-v2/validation.json`); record the suite hash change in `docs/BENCHMARK.md`.
- [ ] Record known benchmark-environment noise in `docs/BENCHMARK.md`: nested `sandbox-exec` test failure on this repo's tasks; ~40 residual humain-terminal type errors from live model-catalog drift; base-commit test failures (e.g. `test_cli_rejects_tiered` at orch-001's base).

### Task C2: calibration run and gate (dev split; ~$5 cap)

- [ ] `python3 scripts/bench_route_check.py --suite ~/orch-bench/suite --split dev --config ~/orch-bench/config.json --prepared-cache ~/orch-bench/prepared --approve-usd 5`.
- [ ] **Gate (all must hold on dev):** scout recall ≥ 0.8 averaged over tasks; level agreement with oracle ≥ 70%; under-route ≤ 1 task; no scout run without a recorded cost; scout p90 latency ≤ 60 s.
- [ ] If the gate fails: adjust only the scout prompt, `max_candidates`, the test rule or router thresholds (`method.json`), re-run on dev, and record each iteration. After 3 failed iterations, stop and report instead of tuning further. Never look at holdout tasks while tuning.
- [ ] Freeze: commit the final policy, rebuild tools (C1), record the frozen skill revision and policy hash in `docs/BENCHMARK.md`.

### Task C3: pilot run (dev split, 3 arms, k=3)

- [ ] Estimate: 14 dev tasks × 3 arms × 3 = 126 attempts. From the smoke, `direct` ≈ $0.07 and `current` ≈ $0.6 per tiny task; larger tasks cost more. Set `per_run_usd_cap` (suggest $5) and approve the runner's printed estimate (126 × cap is the worst case; expected far lower).
- [ ] `python3 scripts/bench_run.py --suite ~/orch-bench/suite --split dev --experiment-root ~/orch-bench/exp-pilot --config ~/orch-bench/config.json --arms direct,current,tiered --jobs 3 --approve-usd <approved> --prepared-cache ~/orch-bench/prepared` under `caffeinate -dimsu`. The run is resumable; re-run the same command after any interruption.
- [ ] After completion: `bench_report.py --journal ~/orch-bench/exp-pilot/journal.jsonl` and `--json`; check every attempt has a journal row, `infra_error` count, contamination count, live state untouched.

### Task C4: analysis and decision

- [ ] `python3 scripts/bench_power.py --journal ~/orch-bench/exp-pilot/journal.jsonl`.
- [ ] Write `docs/superpowers/reports/<date>-pilot-results.md`: per arm and stratum the quality verdict (pass/fail/inconclusive with bounds), cost and time ratios with CIs and coverage, fix rounds, escalations, routing distribution of the `tiered` arm, contamination and infra counts, and the sample size needed for a confirmatory run.
- [ ] Decision (human): (a) stop — tiered not worth it; (b) adjust and re-pilot; (c) run the holdout split once with the frozen configuration (6 tasks × 3 × 3 = 54 attempts) and, if the power analysis demands it, plan a larger suite; (d) proceed to the Phase 4 live A/B plan.

---

## Spec coverage

| Spec item | Task |
|---|---|
| §3.2 bounded read-only scout resolves ambiguous scope; cost/time counted; reuse evidence | A1, A2, A4 |
| §3.2 missing evidence never lowers risk; scout can only add evidence | A3, A4 |
| §3.4 observe overhead measured and labelled | A4 (`scout.cost_usd/ms`) |
| §2.3 isolated, resumable, budgeted runs; equivalent concurrency across arms | B1, B2, C3 |
| §2.4 paired task-cluster analysis, inconclusive verdicts, sample size before confirmatory spend, Holm | B4, C4 |
| §2.1 dev/holdout separation; tuning only on dev | C2, C4 |
| §4 promotion is explicit and human | C4 |

Deferred with reason: lower-level exploration (needs live traffic; Phase 4); an "ignore pre-existing failures" QA baseline for the current pipeline (a product change to `current`, out of scope for a fair evaluation of today's behaviour — record its effect in the report instead).

# Tiered Workflows and Orchestration Evaluation — Design

## Purpose

Answer, with evidence, whether orchestration improves or worsens **time, cost, quality and
iterations**, and change the orchestrator so each task gets the lightest workflow that can succeed.
Success means we can state the four metrics for today's behaviour ("before"), for a no-orchestration
baseline, and for the new tiered workflows ("after"), per complexity band, with confidence intervals
— and that the tiered workflows pass a quality gate while improving time and cost.

This extends the 2026-09-24 Orchestration Economics Program (`2026-09-24-orchestration-economics-program-design.md`):
it supplies the matched-cohort evidence that program's Phase E called for, and replaces
"triage complexity picks lead size" as the top-level routing decision with "observable signals
pick a workflow tier". Lead sizing remains in force inside the `led` and `full` tiers.

## Decisions agreed with the user

1. Target all four metrics: elapsed time, cost, verified quality (incl. escaped defects), iterations.
2. Evidence source: **both** a fixed benchmark suite (decides changes) and live A/B telemetry (confirms over time).
3. Fix every measurement gap first (Phase 0) before any workflow change.
4. Historical metrics are **rewritten in place** (with backup, idempotent migration, provenance stamps).
5. Benchmark tasks: **mix** — mostly replayed real tasks, a few synthetic gap-fillers.
6. Decision rule: **quality gate, then cost × time Pareto**, iterations as tie-break; k=3 runs per task; paired comparison; per-band reporting with confidence intervals.
7. Routing: **deterministic observable signals choose the starting tier**, with a monotonic
   escalation ratchet that carries work forward; high risk always starts at `full`; triage score is logged, not used to route.

## Evidence this design responds to (2026-09-29 snapshot)

From `~/.local/state/coding-agent-orchestrator/` and `scripts/skill_vs_baseline.py`:

| Finding | Number |
|---|---|
| Orchestrated "work" records / priced | 1,718 / 904 (≈53% priced) |
| Unpriced `route_executed` events (routing decisions, not calls) counted as work | 633 |
| Unpriced real `model_call` rows (mostly failed dispatches, `model: unknown` or `$0`) | 176 |
| Reported success rate | 50.6% — but 635 of 844 "fails" have **no result**; only ~134 are recorded fails |
| Outcomes with end-to-end `elapsed_ms` | 65 / 224 |
| Escaped-defect (delayed outcome) records | 0 |
| No-orchestration baseline with pass/fail | none (interactive ingests carry cost only) |
| Average triaged complexity | 6.78 (routing skews heavy) |
| Lead + lead_large share of priced spend | ≈$273 of $547 |

Conclusion: today's numbers cannot support any before/after claim; Phase 0 is a prerequisite.

## Section 1 — Phase 0: Trustworthy measurement

Reuses: `bridge/extensions/orchestrator/run-outcome.ts`, `orchestrator/outcomes.py`,
`orchestrator/run_evidence.py`, `pipeline/run-orchestration.ts` (existing `elapsed_ms`), the
`scripts/backfill_*` family, and the existing live-state guard.

### 1.1 `task_outcome` record (the unit of analysis)

Exactly one per orchestrated run **and** per direct/baseline run, appended to `outcomes.jsonl`:

- Identity: `run_id`, `workflow_tier_planned`, `workflow_tier_final`, `task_class`, `complexity`, `risk`, `routing_signals`, `bench_id?`, `workflow?`, `k?`.
- Time: `started_at`, `finished_at`, `elapsed_ms`, `phase_ms` (`signals`, `recon`, `lead`, `implement`, `review`, `qa`, `waiting` — retry/backoff/failover waits).
- Cost: `cost_usd`, `cost_coverage` (`reported` / `estimated` / `unknown` call counts), token totals.
- Quality: `result ∈ {pass, fail, blocked, cancelled, timeout, unknown}`, plus verification evidence (`checks`, `tested_revision`).
- Iterations: `fix_rounds`, `retries`, `escalations`, `dispatch_count`.

Dispatch-level metrics and routing events are drill-down only, joined by `run_id`.

### 1.2 Cost for failed/cancelled dispatches

On failure, persist any provider-reported usage; otherwise estimate from tokens seen in progress
events (`cost_source=estimated-from-partial-tokens`); otherwise `cost_source=unknown` with
`cost_usd=null`. A real call is never recorded as `$0`. Reports show unknown-cost coverage as a percentage.

### 1.3 Escaped defects

`defect_link` follow-up record referencing the original `run_id`, `type ∈ {revert, reopened, bug_traced, hotfix}`.
Written manually via a CLI subcommand, and automatically when a later commit reverts files the
run changed. Linked defects count against the original run's quality.

### 1.4 Analysis correctness

`skill_vs_baseline.py`, dashboard data and shared helpers:
- exclude `route_executed` (and all decision events) from work counts;
- treat missing results as `unknown`, never `fail`;
- compute headline metrics from `task_outcome`, not dispatch rows.

### 1.5 Historical rewrite (in place)

One migration script:
- timestamped backup of every stream first; refuses to run on live state without the existing guard's opt-in;
- idempotent; stamps changed rows with `migration_id`;
- relabels missing results `unknown`, marks decision events, reconstructs `task_outcome` for past runs where events contain start/end;
- never guesses: unrecoverable fields are tagged `unrecoverable`;
- emits a before/after migration report with counts per fix.

### 1.6 Corrected baseline report

"Current behaviour" four metrics per complexity band, with data-coverage percentages. This is the "before" snapshot.

### 1.7 Tests

Unit tests for record emission and cost fallbacks; golden migration tests on fixture streams;
regression test that `route_executed` no longer affects success rate.

## Section 2 — Benchmark and live A/B harness

`scripts/benchmark_refresh.py` measures engine/dashboard performance only and is not reused for this.
Reuses: git worktrees, `model-canary.ts` deterministic run-id hashing, optional Forge live QA, the `task_outcome` schema.

### 2.1 Task suite (`bench/tasks/*.json`, ≈20 tasks)

- ≈16 replayed real tasks (forge, humain-terminal, this skill): repo, parent commit, original goal
  text, hidden acceptance checks (tests changed/added by the real commit, grader-only), oracle diff
  (analysis-only, never shown to agents), expected band tags.
- ≈4 synthetic gap-fillers: high-risk auth/secrets, cross-module interface change.
- ≈5 tasks per band: tiny, small, multi-file, cross-system/high-risk.
- Prefer recent commits to limit contamination.

### 2.2 Arms

- `direct`: one strong agent, no orchestration (baseline).
- `current`: today's `/orchestrate` at the pinned pre-change revision ("before").
- `tiered`: the new router, auto-selected tier ("after").
- Diagnostic only: `tiered@forced-<tier>`, each tier on every task (or a subset) to map where tiers succeed/fail.

### 2.3 Runner (`scripts/bench_run.py`)

For each task × arm × k=1..3: fresh worktree at parent commit → run arm headless → grade with hidden
checks + repo lint/typecheck + diff-scope check (no unrelated files) → write `task_outcome` tagged
`bench_id/workflow/k` to a **separate bench stream** (live metrics are not polluted).
Same model profile and pricing for all arms; randomized run order; per-run wall/cost caps (cap hit ⇒
`result=timeout`); resumable. Prints a cost estimate and requires confirmation before spending.

### 2.4 Report (`scripts/bench_report.py`)

Paired by task. Per arm × band: pass rate with confidence interval, pass^k (all k passed), median
and p90 elapsed, median cost, fix rounds, escalations; cost × time Pareto plot; quality-gate verdict.
For `tiered`, routing accuracy: under-route (escalated) rate and over-route (forced lower tier also passed) rate.

### 2.5 Live A/B

Feature-flagged: a configurable share (initially 20%) of real `/orchestrate` runs assigned `tiered` vs `current` by
deterministic `run_id` hash. High risk excluded initially. Same `task_outcome`, same report, live
stream. Escaped defects accrue via `defect_link`.

### 2.6 Tests

Fake-agent adapter so runner, grader and report run in CI with zero model spend; golden tests for report statistics.

## Section 3 — Workflow tiers and router

Reuses: `core/triage.ts`, `pipeline/triage-step.ts`, `lead-sizing.ts`, `recon.ts`, `escalation.ts`,
`pipeline/verify-loop.ts`, `method.json` as single source of truth.

### 3.1 Tiers (`method.json` `rules.workflow_tiers`)

| Tier | Topology | Gates |
|---|---|---|
| `direct` | one `implementation_strong` implementer; no architect/lead/recon | deterministic checks (tests, lint, typecheck) |
| `checked` | direct + one independent `technical_review` | checks + review (re-review obeys `review_after_fix`) |
| `led` | recon (per existing rule) → sized lead → implementers → review | checks + review + QA |
| `full` | architect → multi-lead DAG → review + security + QA | everything today, incl. security for high risk |

Hard gates are never removed by any tier: deterministic checks, destructive-ops deny, security review for high risk.

### 3.2 Signals (`core/workflow-signals.ts`)

Deterministic first; one cheap scout only if ambiguous.
- Scope: candidate files from goal-mentioned paths/symbols + repo search; count of modules/packages.
- Interface change: candidate files match export/schema/API/migration patterns (configurable).
- Risk paths: auth, secrets, payments, CI, dependency manifests, data deletion (configurable globs).
- Test proximity: candidate files have adjacent tests.
- Spec presence: goal links a spec/plan or is multi-part.
- Ambiguity: zero candidates or vague goal ⇒ one scout resolves scope, then signals are recomputed.

### 3.3 Router (`core/workflow-router.ts`)

Pure function `signals → {tier, reasons}`; thresholds in `method.json`. Rules, first match wins:
1. Any risk-path hit, or explicit high/critical risk ⇒ `full`.
2. Cross-module interface change or multi-part spec ⇒ `full`.
3. More than 3 files, more than 2 modules, or scope still ambiguous after the scout ⇒ `led`.
4. 2–3 files with tests, or 1 file without tests ⇒ `checked`.
5. Otherwise (1 file, tests present, no interface change, low risk) ⇒ `direct`.

`--tier` overrides (logged as override). Triage complexity is recorded but not used to route.

### 3.4 Escalation ratchet

Monotonic `direct → checked → led → full`. Triggers: failure persisting after one fix round; actual
changed files exceed the tier's scope envelope; unexpected risk-path touch; agent-reported hidden
complexity. The next tier receives the original goal plus the prior diff, findings and failing
checks as bounded feedback (the `escalation.ts` pattern) — prior work is carried forward, not
discarded. Per-tier spend caps reuse `dispatch_spend_cap`.

### 3.5 Observability

`task_outcome` carries signals, planned/final tier, escalation path and reasons, override and
exploration flags. Exploration reuses the existing 2% low/medium-risk mechanism, running one tier
lower to detect over-routing.

### 3.6 Rollout toggle

`workflow_tiers: off | observe | enforce`. `off` = today. `observe` = compute and log the planned
tier, run today's pipeline (free routing data). `enforce` = run the chosen tier.
Order: observe → benchmark → live A/B → enforce.

### 3.7 Tests

Table-driven router tests; signal tests on fixture repos; escalation monotonicity and
carry-forward tests; a test asserting hard gates exist in every tier.

## Section 4 — Phasing, success criteria, risks

### 4.1 Phases and exit gates

| Phase | Deliverables | Exit gate |
|---|---|---|
| 0 Measurement | §1 in full | ≥95% of new runs emit a complete `task_outcome`; decision events excluded; migration idempotent and backed up; corrected baseline report produced |
| 1 Harness | §2 suite, runner, grader, report, fake-agent CI | CI green on fake agent; one-task real smoke run; `direct` and `current` arms captured ("before") |
| 2 Tiers | §3 signals, router, tier pipelines, ratchet, `observe` | tests green; observe logs planned tiers on live runs with no behaviour change |
| 3 Evaluate | full bench: `direct`, `current`, `tiered` × k=3, plus forced-tier diagnostics | report shows quality-gate verdict and Pareto position per band |
| 4 Rollout | live A/B with `enforce` on 20% of low/medium-risk runs | 2–4 weeks of live data consistent with bench and no escaped-defect regression ⇒ default-on |

### 4.2 Success criteria (per complexity band)

- **Quality gate:** `tiered` verified pass rate ≥ `current` − 5 percentage points; no added high-risk escaped defects; pass^k not worse.
- **Time and cost:** `tiered` not Pareto-dominated by `current`; expected to dominate on tiny/small bands.
- **Iterations:** median fix rounds and escalations reported; under-route (escalation) rate below ~20%.
- **Baseline honesty:** if `direct` matches or beats `tiered` in a band, `direct` becomes that band's default.

### 4.3 Statistical limits

≈20 tasks × k=3 detects large effects (30–50% time/cost differences), not small quality deltas.
Small quality regressions are caught by the live A/B and `defect_link`, not the bench. Reports show
confidence intervals and never claim more than the sample supports.

### 4.4 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Replayed tasks contaminated or easy | recent commits; hidden checks and oracle diffs |
| Sample too small for small quality deltas | bench for large effects; live A/B + defect links for the rest; honest CIs |
| Signal rules misroute | observe mode, forced-tier diagnostics, exploration; thresholds in `method.json` |
| Cheap tier misses a defect | hard gates in every tier; high risk always `full`; defect links |
| Migration corrupts history | backup, live-state guard, `migration_id`, migration report, golden tests before live run |
| Bench spend | pre-run estimate + confirmation, per-run caps, resumable runner |
| Provider/time-of-day confounders | same profile, randomized order, provider recorded on each outcome |

### 4.5 Non-goals

- No learned router until bench plus live data is sufficient.
- No automatic policy mutation; tier thresholds change only by explicit `method.json` edits.
- No change to hard safety policy (destructive ops, dependency approvals, auto-merge).

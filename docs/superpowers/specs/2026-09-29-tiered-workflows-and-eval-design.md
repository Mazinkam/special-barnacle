# Tiered Workflows and Orchestration Evaluation — Design

## Status and purpose

Revised after code-grounded review on 2026-09-29. Design only; no production migration,
model-spending benchmark or workflow change is authorized by this document alone.
The revised statistical, safety and rollout details require user review before implementation planning.

Measure **elapsed time, cost, verified quality and iterations** for the current orchestrator,
a direct-agent baseline and candidate tiered workflows. Prefer the lightest workflow that meets
quality requirements; do not assume orchestration or four tiers will win.

This extends [Orchestration Economics Program](2026-09-24-orchestration-economics-program-design.md),
especially Phase E. Preserve its existing safety requirements and model-routing vocabulary.
Lead sizing remains inside coordinated workflows; workflow selection becomes a separate policy.

## Agreed direction

1. Repair measurement before changing workflow behavior.
2. Rewrite historical records in place, with backups, provenance and reversible migration.
3. Use a mixture of real replay tasks and synthetic tasks, followed by live controlled evaluation.
4. Evaluate quality first, then time/cost trade-offs, with iteration counts visible.
5. Start with approximately 20 pilot tasks and three independent attempts per task and arm.
6. Route using observable evidence and conservative rules; escalate while preserving useful work.
7. No automatic policy promotion or learned router in this scope.

## Review corrections and evidence limits

The previous draft overstated several findings. The exploratory queries ran against a changing
stream, used different record populations, and did not establish a complete baseline:

- One script invocation counted 1,708 work rows, of which 898 were priced, and labeled 844 as
  failures. A later query counted 1,718 work rows and 814 unpriced rows: 633 `route_executed`,
  176 `model_call`, and five other rows. These snapshots must not be combined into one denominator.
- The approximately 134 recorded failures came from the **unpriced subset**, not all failures.
  The earlier claim that only 134 failures existed overall was unsupported.
- Decision rows without prices do not imply missing bills. Classify actual billable attempts first.
- A search for the word `delayed` does not establish zero escaped defects. Existing
  `orchestrator/outcomes.py::bad_signal` reads `reopened`, `regression`, `rollback`,
  `human_correction`, `major_rewrite`, and `incident`, including JSON in note fields.
- `orchestrator/run_evidence.py::summarize_runs` already joins one evidence row per run and
  separates dispatch duration from elapsed time. Extend it rather than adding a competing truth.
- `orchestrator/economics.py` already contains cost provenance classification, record deduplication
  and nested-cost reconciliation. Audit and reuse these helpers.
- A mean complexity of 6.78 does not prove inflated triage; difficult tasks may be selected into
  orchestration. Large lead spend is not proof of waste without matched tasks and outcomes.
- Existing exploration configuration concerns adaptive routing, not an implemented lower-workflow
  experiment. Reusing its rate does not mean workflow exploration already exists.

Phase 0 captures a frozen, hashed snapshot and produces reproducible population counts before
making numerical claims. Historical analysis is descriptive, not causal evidence of savings.

## Section 1 — Phase 0: Trustworthy measurement

### 1.1 Audit and shared contract

Trace writers, adapters, ingestion, persistence, aggregation and presentation across both the Python
engine and TypeScript bridge. Produce a coverage matrix for normal completion, blocked work,
provider failure, cancellation, quota failover, process crash, resumed work and nested agents.
Separate accounting defects, genuinely missing provider usage and unrecoverable legacy evidence.

Reuse `run-outcome.ts`, `orchestrator/run_evidence.py`, `orchestrator/outcomes.py`,
`orchestrator/economics.py`, and shared contract/versioning mechanisms. Define one normalized
logical `task_outcome` per top-level execution, not per subagent task. Existing outcome records
remain compatible; the normalized outcome is the shared reporting contract, not a second ledger.

Identifiers and provenance:
- `task_instance_id`: the user goal across continuation/resume runs; benchmark task identity separately.
- `run_id`: one execution; `parent_run_id` / continuation links when applicable.
- `record_id`, schema version, revision and supersession metadata: retries in emission are deduplicated;
  late usage may revise an outcome without creating a second sample.
- workflow arm, planned/final tier, routing reasons/signals and uncertainty, override/exploration flags.
- repository/base revision, runtime, policy/profile hashes, actual models/providers/efforts, pricing
  snapshot, check-set version and experiment assignment.

Record a start before dispatch. Terminal records separate execution status
(`completed | failed | blocked | cancelled | interrupted | timeout | budget_exceeded | unknown`)
from verification (`pass | fail | unavailable | unknown`). A completed process is not a verified pass.
Checks bind to the tested tree/diff digest as well as commit ID; a dirty tree is not identified by HEAD alone.
Missing evidence never becomes an inferred pass. Use existing liveness ownership evidence for crash
reconciliation, not age alone. Recover orphan starts; do not silently omit them from denominators.

### 1.2 Cost and timing semantics

Cost includes all workflow-owned calls: signal scouts, planning, implementations, reviews, QA,
retries, failed attempts, fallback providers and nested agents. External experimental grading cost
is recorded separately and included in the overall experiment budget, not hidden in one arm.

- Reconcile stable call IDs, parent aggregates, child details, covered-call IDs and dispatch attempts
  before summing. Do not count parent and child spend twice; do not deduplicate genuine retries.
- Preserve reported, complete-token-estimated, partial-token-estimated and unknown provenance.
  Cumulative progress usage is not additive; reconcile to final usage instead of summing snapshots.
- Partial-token cost is an incomplete estimate/lower bound, not a fully priced call. Preserve cache
  reads/writes and actual model/provider rate provenance. Unknown rates stay unknown.
- Proven zero-cost usage and a proven pre-dispatch failure may be zero. Unreported usage must not
  become zero. This preserves existing legitimate zero-cost semantics.
- Expose known spend, complete-total availability and coverage counts separately. Unknown spend
  is not zero and may invalidate an economic comparison. A low known subtotal is not a win.

Measure end-to-end wall time from request acceptance, before routing, to terminal delivery after
required checks. Include routing, queueing, provider waits, retries, integration and verification.
Use monotonic timers within a process and persisted timestamps with provenance across restarts.
Record human-wait time separately without deleting it from gross user-visible elapsed time.

Store phase/dispatch spans, per-phase elapsed unions and summed agent execution duration as separate
quantities. Parallel phase durations can overlap and must not be added to obtain end-to-end time.
Unobserved intervals remain unknown. Resumption reports both execution time and goal-level time;
reports must not hide failed earlier runs by showing only the final successful continuation.

### 1.3 Iterations and outcomes

Use distinct counters with stable attempt/round IDs:
- `fix_rounds`: a changeset revision prompted by verification/review failure, followed by rechecking;
- `provider_retries`: transport/quota/failover retries, not quality fixes;
- `escalations`: increases in workflow tier, distinct from model/effort escalation;
- `human_interventions`, `dispatch_count`, and conversational/model turns as separate diagnostics.

Nested events roll up once. Unknown historical counts are null, not zero. More internal checking is
not automatically worse; distinguish useful defect detection from repeated failed repairs.

Extend existing delayed-outcome handling with `defect_link`: original run/task identity, evidence,
severity, discovery time, source, attribution confidence and confirmation status. Reuse
`outcomes.py::bad_signal` through a compatible shared adapter rather than introducing inconsistent
quality definitions across history, dashboard and experiment reports.

A revert or reopened issue is a **candidate**, not proof of a defect. Exact reverted-commit lineage
or human-confirmed causality is stronger than file overlap. Require confirmed attribution to count
an escaped defect. Deduplicate the same incident. Preserve the immediate verification result and
report later defects separately, with 7/30-day maturity and follow-up coverage. Unobserved follow-up
is unknown, not defect-free; nothing here proves zero risk from a small sample.

### 1.4 Analysis and safe historical rewrite

Replace script-local work/pass counting with shared, tested classification. Decision events remain
available for audit but do not count as calls or task outcomes. Same-token repricing remains a
clearly labeled cost sensitivity analysis, not a no-orchestration experiment.

Migration requirements:
1. Dry-run against a frozen copy first. Record source hashes, schema versions, population counts,
   planned field changes and unrecoverable evidence. Do not infer missing task identities or verdicts.
2. Quiesce writers and ingestion; use the existing shared writer lock across validation, backup and
   replacement. An opt-in/live-state flag is not permission to race active writers. Refuse if writer
   quiescence cannot be established.
3. Take verified timestamped backups and write a recovery manifest with hashes, original fields,
   migration ID, planned replacements and progress. Preserve malformed rows in quarantine with
   original bytes and positions; never silently drop them.
4. Write/fsync sibling temporary files and atomically replace streams, following the existing
   `audit_and_clean_metrics.py` pattern. Multi-file replacement is not atomic: a journal and reader
   maintenance barrier must prevent a half-migrated view and support complete restore/resume.
5. Rebuild/invalidate ledger, index, checkpoints and dashboard as appropriate. Preserve ingestion
   source identities so replay does not duplicate or resurrect corrected rows.
6. Check cost reconciliation, call/run cardinality, ID uniqueness, links, and classified outcomes.
   A second migration pass must be a no-op. Validate restoration on fixtures before production use.

Stamp corrections, not fictional historical facts. Reconstruct elapsed time only from credible
lifecycle evidence, never first/last arbitrary metric timestamps. Unknown fields retain provenance.
Historical corrections change how data is interpreted, not the original runtime's behavior.

### 1.5 Exit gate and tests

Produce a corrected historical report and freeze a prospective instrumented-current baseline
before workflow changes. Record revision, policy, models, prices, snapshot hashes and coverage.
At least 95% of new executions in a predefined validation window must have observed terminal timing
and evidence-backed verification; all starts must be accounted for, including unknown/interrupted.
Report cost and outcome coverage separately per status and arm; unknown-heavy cohorts cannot pass
an economic gate merely because they have a structurally valid outcome record.

Test duplicate/late records, nested/fallback costs, genuine zero cost, partial usage, overlapping
spans, process death/resumption, delayed defects, migration crash recovery and rollback. Add
cross-runtime fixtures proving script, dashboard and normalized outcomes agree.

## Section 2 — Benchmark and live experiment

### 2.1 Suite and leakage control

Start with approximately 16 replayed tasks from forge, humain-terminal and this skill plus four
synthetic gap-fillers. This is a **pilot**, not a powered 5-percentage-point non-inferiority trial.
Task class, scope/complexity and risk are separate labels, fixed before running any arm. Do not
combine risk and size into one band. Include tightly coupled hard tasks, independent parallel work,
ambiguous bugs and small high-risk changes, not just file-count variations.

Each manifest records base commit/tree, original goal, trusted setup/check commands, dependency
lockfiles, environment/toolchain, task/risk labels and acceptance contract. Validate that the base
fails the intended acceptance check and the reference solution passes; quarantine broken/flaky
tasks before assignment using documented rules. Existing tests alone may miss the requested change.
Reference diffs are diagnostic only; correct alternative implementations must pass.

Keep visible development tests; private holdout checks are controlled by the grader. Separate tuning
tasks from a sealed evaluation set before changing router thresholds. With only 20 tasks, report
holdout results as exploratory and expand before promotion. Repeated tuning on a holdout retires it.

**Worktrees are not a leakage or security boundary:** they expose shared Git history, including the
future solution. Provision disposable restricted snapshots/repositories containing only allowed
base content/history, no host checkout access, remotes, future commits, oracle diffs, shared agent
memory or solution logs. Restrict network and credentials. Repo tests/setup execute as untrusted code
inside the sandbox. A worktree may be a staging mechanism only, not the agent's isolation boundary.

Grade the submitted tree in a separate trusted environment; private tests must not be editable by
the agent. Check policy violations/test tampering, not equality to the oracle's changed-file list.
Human review may adjudicate legitimate scope changes under a preregistered rubric, blinded to arm.

### 2.2 Arms and frozen configuration

- `direct`: one `implementation_strong` agent with the same visible tools and required safety checks,
  no coordination agents. It still runs protected-area security verification when required.
- `current`: the frozen current workflow with measurement repairs but no tier changes. This is the
  causal control; an uninstrumented old version is not a fair measurement comparator.
- `tiered`: frozen candidate router and policies, including routing/scout overhead.
- Forced tiers: diagnostic on a safety-eligible subset, not a promotion test or justification to
  bypass high-risk floors. They inform tuning, not the sealed evaluation set.

Pin exact code/tree hashes (including any dirty patch), model bindings and effort, prompts, tool
versions, environment, cache policy, concurrency, dependency artifacts and pricing snapshot.
Use the same capability-to-model profile, not necessarily the same model for every role. Report
actual billed cost and a common-price sensitivity separately. Record provider/version changes and
fallbacks; do not silently substitute configurations mid-comparison.

### 2.3 Runner and budgets

For each task × arm × k=1..3, use a fresh isolated environment and independent context. Randomize
blocked run order across arms/tasks to reduce provider-load effects; use equivalent concurrency and
cache conditions. The common external grader sees only the submitted artifact and fixed rubric.

Store benchmark data under an explicitly isolated experiment root, excluded by default from live
learning, routing history and dashboards. Keep an experiment registry linking manifests and results.
Reuse state abstractions only after verifying they respect this root across every child and writer.

Reserve distinct task-attempt IDs. Resume interrupted execution journals without overwriting or
cherry-picking failed attempts; record replacement attempts and reasons. Apply preregistered handling
for external infrastructure incidents; report intention-to-treat results as well as sensitivity views.

Require estimated-cost approval before spending. Enforce whole-experiment, per-run and dispatch
budgets, timeouts and process-tree cancellation. Existing warn-only dispatch caps are insufficient.
Polling/usage latency can cause bounded overshoot; report enforcement limits and stop launching new
work when usage becomes unobservable. Cost caps yield `budget_exceeded`, time caps `timeout`.
All failed and capped attempts count in spend and primary completion denominators.

Main pilot: 20 tasks × 3 arms × 3 attempts = 180 runs, plus explicitly budgeted diagnostics/grading.
`scripts/bench_run.py` and `scripts/bench_report.py` are proposed names, not existing implementations.

### 2.4 Metrics and statistical decision rule

Report per arm and preregistered task strata:
- Verified completions / all assigned executions, with blocked, cancelled, interrupted and unknown
  statuses broken out. Missing verification is not labeled a known defect, but cannot count as success.
- Pass^3: fraction of tasks for which all three attempts pass. Repeats are not independent new tasks.
- Gross elapsed p50/p90 and budget-censored observations; success-only timings are secondary.
- Known/complete spend, total spend divided by verified completions, and coverage/sensitivity views.
  Zero completions means no finite cost per success, not zero. Cheap failures must not win.
- Fix rounds, provider retries, escalations and human interventions, including failures, plus confirmed
  defects and follow-up maturity. Escalation rate alone is not evidence of a bad routing decision.

Use paired task-level differences and confidence intervals; cluster repetitions by task (and live
continuations by task instance). Use a documented task-cluster bootstrap for time/cost, recording seed and method. Quality bounds
must handle paired, clustered binary observations and boundary cases; a degenerate all-pass
bootstrap interval is not evidence of zero uncertainty. Validate the selected method against
simulated null/boundary cases before use, or return inconclusive. Very small strata remain explicitly
exploratory; repeated runs do not substitute for independent tasks.

Quality verdicts are `pass | fail | inconclusive`. Preserve the agreed 5 percentage-point margin,
but **point estimates alone cannot pass**: the preregistered one-sided 95% lower confidence bound
for candidate-minus-control completion probability must exceed -0.05. Apply the agreed no-worse
consistency requirement to a lower bound of at least zero for pass^3; this is deliberately stringent
and may remain inconclusive. Do not relax either threshold after observing results. Any later margin
change requires explicit approval and a new evaluation. Confirmed candidate-attributable severe
regression blocks promotion; zero observed incidents is not statistical proof of no increase.

Compute required independent task counts from pilot variance, baseline completion rate and the
agreed margin before the confirmatory trial. Predeclare primary comparisons and account for
multiple strata/comparisons (e.g. Holm-adjusted tests). Twenty tasks cannot be asserted to detect
30–50% improvements or exclude 5-point quality loss without a power analysis.

Only quality-eligible workflows enter the time/cost frontier. Merely being non-dominated is not
proof of improvement. Report uncertain trade-offs explicitly; promote only when credible efficiency
improvement or an explicitly accepted time-versus-cost trade-off exists. Direct is a legitimate
winner, but adopting it still obeys risk floors and explicit human promotion.

### 2.5 Live confirmation

Use a versioned experiment with initial candidate share 20%, control share 80%, among eligible
low/medium-risk tasks. Assign by a salted stable **task-instance** key within task/risk strata,
not a new run ID on every retry. Preserve assignment through resumptions and analyze by assigned
arm even after escalation. Record exclusions and imbalance. Do not change thresholds/models or
run lower-tier exploration during the main trial; version or stop the trial if configuration changes.

Timebox 2–4 weeks for an interim operational review, not automatic statistical approval. Continue
until the predefined sample size and defect follow-up window mature, or report inconclusive.
Define completion and severity monitoring, budget stop and immediate rollback to current workflow;
never bypass required verification during rollback. High-risk candidate policy needs its own evidence
and explicit approval, not extrapolation from low-risk traffic.

### 2.6 Tests

Fake-agent CI covers runner, sandbox/leakage checks, acceptance/reference validation, tampering,
assignment stability, failure/cap/crash accounting and golden statistical reports. Test current and
candidate instrumentation parity. A paid smoke test is a separate approved action.

## Section 3 — Workflow tiers and router

### 3.1 Workflows and hard floors

Use `method.json` as canonical policy and extend existing triage, recon, lead-sizing, escalation and
verification components, rather than duplicating a pipeline per tier.

| Tier | Topology | Required checks |
|---|---|---|
| direct | one implementer; no architect/lead/recon | trusted applicable deterministic checks |
| checked | direct plus independent technical review | deterministic checks and review |
| led | bounded recon when warranted, sized lead, implementers | checks, review and QA |
| full | architect, lead(s), implementers, specialized review | all required checks/QA, security for high risk |

Full does not force multiple leads or parallel execution on tightly coupled work. Add branches only
when dependency/ownership analysis supports independent tasks. A small high-risk task requires full
verification policy, not automatically a large implementation fan-out.

Separate coordination tier from risk-required verification. No tier, forced benchmark arm, CLI
override or exploration can disable protected-area review, dependency approvals, destructive-action
restrictions or existing required live-QA. Explicit high/critical risk and unresolved potential
protected-area risk set a full floor. Task-class-specific acceptance contracts apply to investigations
and QA-only tasks; initial code-edit tier enforcement excludes these classes until separately validated.

### 3.2 Signals and initial conservative router

A bounded deterministic pre-pass extracts candidate files/packages, dependency coupling, likely public
interface/schema changes, configured risk-path matches and relevant checks. These are **evidence with
confidence**, not ground truth: nearby tests do not prove coverage, and an exported file does not
prove an interface change. Spec presence or number of bullet points alone must not force full.

One bounded read-only scout may resolve uncertainty. Count its cost/time; reuse its packet downstream
rather than repeating recon. If scope remains unknown, use led; if safety risk remains unresolved,
use full or block for clarification. Missing paths/config/checks are not evidence of low risk.

Pure router returns tier, hard floor, evidence/reasons and uncertainty. Initial rules, first match:
1. High/critical or unresolved protected-area risk: full.
2. Likely cross-package public-contract/data migration needing coordinated design: full.
3. More than three candidate files, more than two packages, or unresolved scope after scout: led.
4. Exactly one localized file, confirmed low risk, no public contract change and relevant runnable
   checks: direct.
5. Other bounded scopes (including 2–3 files without tests, local interface changes and medium-risk
   work): checked, subject to risk floors and required acceptance checks.
6. Anything not classified: led, never an implicit direct fallback.

Thresholds are initial hypotheses to tune only on development tasks. File count is a proxy; record
coupling and parallelism separately to evaluate whether these thresholds are useful.

`--tier` may select any tier at/above the safety floor; reject lower overrides with reasons. Record
triage complexity for analysis but do not use it as the primary tier selector.

### 3.3 Escalation, caps and policy compatibility

Within each tier allow at most one bounded quality-fix round before escalation for persistent
verification failure. Provider faults use existing bounded retry/fallback policy rather than increasing
coordination complexity. Ambiguous requirements may block for clarification instead of spawning agents.

Escalate to at least the newly required floor, skipping intermediate tiers when appropriate. Unexpected
high risk pauses unsafe work and jumps to full before proceeding. Monitor changed scope during work;
validate new files and diff content against protected policies before completion.

Preserve original goal, provenance, validated working tree/checkpoint, findings and failing checks.
Treat agent summaries as evidence, not new trusted instructions. Reverify after changes. Existing
re-review minimum model tier remains enforced independently of workflow tier.

At full, exhausted repair/budget limits yield explicit failed/blocked status, not an infinite loop.
Introduce run/tier aggregate budgets in addition to existing per-dispatch limits; those existing
limits alone do not bound total tier spend. Escalation never resets the run budget.

Update both runtime consumers and method documentation/tests together. Workflow policy replaces
unconditional complexity-based recon only for tiered mode; off/current retain legacy behavior.
Lead delegation rules apply to actual lead personas, not direct implementers. Reuse available recon
evidence without blindly re-running the legacy 3–5 scout fan-out.

### 3.4 Modes and exploration

`workflow_tiers: off | observe | enforce`:
- off: no new signal collection; current behavior.
- observe: compute proposed tier, execute current workflow. Signal/scout work costs time and money;
  cap and label that overhead, reuse evidence where compatible, and do not call it free or treat an
  observe run as an untouched control.
- enforce: execute chosen tier under hard floors.

Reuse experiment-assignment primitives after verifying their contract. Lower-workflow exploration is
a **new**, separately disabled-by-default experiment, not automatically provided by existing adaptive
model exploration. After the main trial, an explicitly approved <=2% safety-eligible sample may test
one tier lower above the hard floor with bounded extra spend. Disable for high/critical risk.

Tests cover every routing combination/fallback, floor-preserving overrides, missing evidence,
provider-vs-quality failures, skipped-tier safety escalation, full-tier exhaustion and off-mode parity.

## Section 4 — Delivery and promotion

| Phase | Deliverable | Exit condition |
|---|---|---|
| 0 | audit, unified evidence, repair, migration and historical report | dry-run/restore/idempotence tests; all starts accounted for; prospective coverage gate; frozen instrumented-current baseline |
| 1 | pilot suite, isolated runner/grader, reports | zero-spend CI; separately approved paid smoke test; task validity and leakage checks; frozen experiment manifest |
| 2 | tier primitives, router, floors, observe mode | tests pass; current/off compatibility; measured observe overhead; thresholds frozen for evaluation |
| 3 | paired pilot and confirmatory design | all three arms run under comparable conditions; pass/fail/inconclusive report; sample-size plan before confirmatory spending |
| 4 | eligible live trial, follow-up and rollback | mature quality evidence and acceptable efficiency trade-off; explicit human approval to promote |

Pilot controls may be exercised in Phase 1, but the main comparison runs all arms interleaved in
Phase 3, not current weeks before candidate. Historical replay and live evidence are separate panels.

Deliver a before/current/candidate report with coverage, configuration, task strata, confidence
intervals, all-run outcomes, successful-run diagnostics, budget use and unresolved evidence gaps.
Under-routing/over-routing labels are diagnostics, not a universal <20% acceptance target: escalation
can be economically optimal and a single forced-tier success does not establish reliable superiority.

Rollback disables candidate selection, preserves evidence and restores current workflow for future
work. In-flight work stops safely or finishes under its existing required gates, with assignment intact.
Promotion is per validated scope/risk stratum; no automatic default-on after an elapsed calendar period.

### Risks and non-goals

Risks: missing usage, overlapping cost aggregates, contaminated replay tasks, untrusted test execution,
small sample size, changing providers, delayed defects, classifier false negatives and migration races.
The safeguards above are acceptance requirements, not optional implementation polish.

No learned router, automatic policy mutation, automatic promotion, safety-policy relaxation or
unapproved model spend. Do not migrate live history as part of writing/reviewing this spec.

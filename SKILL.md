---
name: hierarchical-agent-orchestrator
description: Use when executing coding tasks that benefit from hierarchical agent orchestration, dynamic agent DAGs, cost and quality routing, or persistent orchestration state.
---

# Hierarchical Agent Orchestration Skill — V3

## Mission

Execute coding work through a dynamic, model-agnostic hierarchy while minimizing verified economic cost subject to correctness gates, risk policy, and a configurable quality floor.

## Fundamental rules

1. Hierarchical orchestration is the execution model, but a hierarchy may be as shallow as architect -> worker.
2. Spawn only as many agents and levels as the work justifies.
3. Ownership may be hierarchical; dependencies are a DAG.
4. Orchestration logic requests capabilities, never concrete model names.
5. If the harness supports effort/reasoning levels, resolve abstract effort through the adapter.
6. Structured state outside model context is authoritative.
7. Every invocation creates/updates persistent state and regenerates the dashboard.
8. Run deterministic validation before expensive semantic review when applicable.
9. Escalate the smallest failing subproblem.
10. Cost optimization must never bypass hard quality/safety gates.
11. Every adaptive choice must be observable and explainable.
12. Automatic policy mutation is distinct from adaptive routing and is off by default.

## V3 adaptive routing modes

`off`: use deterministic defaults.

`observe`: calculate empirical alternatives and record them; execute defaults.

`recommend`: surface empirical recommendations and evidence; execute defaults.

`enforce`: execute empirical recommendations when the minimum evidence threshold is met; otherwise fall back to defaults.

If `adaptive_system.enabled=false`, telemetry and learning may continue but adaptive execution is frozen.

## Compute package

Route work using a package containing:

- capability
- effort
- context budget
- verification depth
- reviewer independence

Do not equate model strength with quality; evaluate the whole implementation + verification route.

## Routing policy overlay

The orchestrator maintains a routing policy overlay at `~/.local/state/coding-agent-orchestrator/policy_overlay.json`. The overlay is the source of truth for routing decisions that the orchestrator recommends and (eventually) enforces. Lead agents read the overlay before dispatching review or exploration work. The dashboard generator reads it to track compliance. Three rules govern routing; they were calibrated against the orchestrator's first 13 runs and validated against the metric stream.

### Rule 1: Review after a fix uses at least the original reviewer's tier

A re-review is any review call following a fix-round on the same `task_id`, including explicit `*-rereview` task IDs and any `technical_review`/`security_review` with `retry > 0` that passed. The cheapest model tier (haiku / `implementation_fast`) **MUST NOT** re-review code that has changed since the original review. The minimum tier is `implementation_strong` at standard effort with targeted verification; the re-review model must be at or above the model that produced the original review.

Rationale: after a fix, the code under review has changed. Haiku confirmed 4/4 re-reviews in current data, but downstream tasks proceeded without issue only because the fixes were small. A single regression missed by haiku costs more in rework and escaped defects than the entire haiku re-review savings to date ($0.31 across all runs).

Escalation by risk:

| Risk | Capability | Model tier min | Verification depth |
|---|---|---|---|
| low | `implementation_strong` | sonnet | targeted |
| medium | `technical_review` | sonnet | targeted |
| high | `security_review` | opus | full |
| critical | `security_review` + independent | opus | full |

When the lead agent itself fixes and re-reviews, the re-review must still use a model tier at or above the original reviewer. The lead may delegate the re-review to a peer at the same tier or higher.

### Rule 2: Pre-implementation recon for complexity ≥ 5

Tasks with `complexity >= 5` get a parallel fan-out of cheap reconnaissance workers before any implementer touches the code. The workers use `analysis_mid` or `implementation_fast` at low/medium effort with targeted verification — they research and summarize, they do not modify source. Worker count scales with complexity:

| Complexity | Recon workers |
|---|---|
| 5–6 | 3 |
| 7–8 | 4 |
| 9–10 | 5 |

Each worker answers one bounded question: affected files, existing tests, recent related changes, relevant ADRs, dependency surface, observed constraints. Workers return structured evidence packets capped at 2,000 tokens each. The lead (capability `technical_lead` or `architect`) digests the packets into an implementation plan with task boundaries and ownership.

Skip recon for `task_class = investigation` or `qa_verification`; those have their own evidence-gathering topology.

Rationale: `implementation_strong`-class tasks with 150K–400K input tokens cost $0.55–$2.38 because the implementer reads raw repository context. A $0.05 sonnet scout pre-digesting that context into a 2K-token evidence packet saves $1+ on the most expensive opus implementer calls and improves focus.

### Rule 3: Exploration uses the cheapest sufficient model

Investigation, recon, and digest tasks go to the cheapest capability that can produce the needed evidence. The topology is one capable lead plus 3–5 parallel cheap recon workers. The lead synthesizes; the workers gather. Cost ceiling per recon: $0.50; the orchestrator flags any single exploration run that exceeds this.

| Task class | Worker capability | Lead capability |
|---|---|---|
| Issue triage | `analysis_mid` | `technical_lead` |
| Plan audit | `analysis_mid` | `technical_lead` |
| Codebase recon | `implementation_fast` | `technical_lead` |
| Security audit | `security_review` (full), no separate lead | n/a |
| Spec synthesis | `analysis_strong` | `architect` |

Rationale: the ht-codex-modularization-status run proved this topology — 4 parallel sonnet-5 scouts produced complete evidence packets at near-zero cost, and a single opus-5 synthesis produced the status report. Sending opus to do the investigation itself would have cost 5–10× more.

### Compliance tracking

The dashboard surfaces violations of these rules. `re_review_violations` lists every re-review call whose model tier falls below the policy floor. `recon_coverage` reports the fraction of high-complexity runs that used pre-implementation recon. `enforcement_readiness` tracks whether the orchestrator has gathered enough empirical data to flip `adaptive_routing` from `recommend` to `enforce`. Until enforcement is ready, the dashboard is the audit; after enforcement, the same policies gate every dispatch.



For unfamiliar or multi-file work, start with small, bounded reconnaissance workers before planning. Each worker answers one question—such as the affected flow, callers, existing tests, or recent related changes—and returns file paths, observed facts, and unresolved uncertainty.

The highest-capability lead receives those compact evidence packets and owns synthesis, task boundaries, and risk decisions. It should not repeat repository discovery. Escalate to the lead when worker findings conflict, material uncertainty remains, or the task is high risk.

Skip reconnaissance for a low-risk, well-localized change. Use only the workers needed to remove a specific uncertainty; they do not make implementation decisions.

## Toggle classes

Use consistent state types:

- boolean: on/off
- adaptive mechanism: `off | on | adaptive`
- learning/autonomy: `off | observe | recommend | enforce`
- review: `off | sampled | risk_based | always`
- approval: `deny | ask | allow`
- budget: `monitor | warn | enforce`

Features resolve global -> repository -> task.

## Historical adaptation

Compare only reasonably similar work:

- task class
- complexity bucket
- risk
- capability
- effort
- verification depth
- topology where available

Require minimum samples before empirical enforcement. Include delayed outcomes when judging route quality.

## Controlled exploration

Exploration exists to avoid self-confirming routing data. Keep it low-rate, bounded by extra expected cost, observable, and disabled for high-risk work by default.

## Shadow routing

Shadow routing can estimate an alternative route without executing it. Actual alternative execution must be separately enabled because it consumes additional cost.

## Effort adaptation

When supported by the harness, effort is an independent scheduling axis. Escalation can increase effort before switching models if history shows that is economically effective. Do not assume higher effort is always better.

## Verification

Verification mechanisms may be always on, off, or adaptive depending on policy. High-risk work may require independent or specialized review. Cached verification is valid only under its configured revision/environment/input rules.

## Policy simulation and canaries

Candidate policies should be simulated against historical cohorts before rollout. Counterfactual results must be labeled estimated. Canary assignment is deterministic by run ID. Automatic promotion is off by default.

## State

Maintain one event-sourced state directory at `~/.local/state/coding-agent-orchestrator/`. It is shared by every coding-agent runtime; never create a per-repository or per-agent state directory. The event stream is the durable history; the ledger and dashboard are rebuildable materialized views.

Before emitting records, set `CODING_AGENT_RUNTIME` to the active runtime and `CODING_AGENT_REPOSITORY` to the canonical repository root. The default writer adds both fields to every event, metric, discovery, and outcome.

## Dashboard

Regenerate `~/.local/state/coding-agent-orchestrator/dashboard.html` after use. It should show:

- spend and verified cost
- cost/quality trends
- waste and orchestration overhead
- adaptive route actions
- exploration and history sufficiency
- active feature states
- route economics by capability/effort/topology
- delayed outcomes
- risk observatory metrics
- cost and calls by coding-agent runtime

### Performance evidence

To evaluate whether the orchestrator is earning its keep, run `scripts/skill_vs_baseline.py`. It reads `metrics.jsonl`, partitions orchestrated work from session-log ingests, reprices orchestrated records at flat single-model baselines (haiku-4-5, sonnet-4-5, opus-4-5), and reports cost, success rate, cost-per-success, retry rate, and waste — for the orchestrator and each bracket. The script is observational: it writes nothing to the stream and does not change the dashboard.

The most recent calibrated numbers live in `policy_overlay.json` under `history.measured_performance` and are refreshed as new orchestrated runs are sampled. The durable finding as of the first measurement: the orchestrator's routing savings come from reviews (routed to haiku / sonnet) paying for `implementation_strong` (routed to opus), with the current mix running materially cheaper per success than a sonnet-4-5 flat baseline at the same token profile. The `policy_overlay.json` `enforcement.measured_roi` block carries the headline ratio.

## Safe defaults

- adaptive routing: recommend
- exploration: 2%, excluding high/critical risk
- shadow routing: on, estimate-only
- policy simulation: on
- automatic policy tuning: off
- automatic policy promotion: off
- auto merge/deploy: off
- destructive operations: deny
- dependency changes: ask
- re-review minimum tier: sonnet (see Routing policy overlay)
- pre-implementation recon: required at complexity ≥ 5
- exploration cheapest sufficient: enforce via topology

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

## Routing policy

The routing method — capability vocabulary, cost tiers, default efforts, role aliases and the three routing rules below — is defined **once** in `orchestrator/method.json`. The Python engine (`orchestrator/method.py`) and the HT bridge (`bridge/extensions/orchestrator/models.ts`, via a symlink to the same file) both read it, so the two runtimes cannot drift. **Edit `method.json` to change the method; the tables below are a human summary and must match it** (`tests/test_method.py` checks the thresholds quoted here). Lead agents follow these rules when dispatching review or exploration work; the dashboard tracks compliance. The rules were calibrated against the orchestrator's first 13 runs and validated against the metric stream.

Runtime state — measured ROI, enforcement readiness, history — lives in `~/.local/state/coding-agent-orchestrator/policy_overlay.json` and is not part of the method.

### Rule 1: Review after a fix uses at least the original reviewer's tier

A re-review is any review call following a fix-round on the same `task_id`, including explicit `*-rereview` task IDs and any `technical_review`/`security_review` with `retry > 0` that passed. The cheap tier (`implementation_fast`, `scout`, `worker`) **MUST NOT** re-review code that has changed since the original review. The minimum tier is `implementation_strong` at standard effort with targeted verification; the re-review model must be at or above the model that produced the original review.

Rationale: after a fix, the code under review has changed. The cheap tier confirmed 4/4 re-reviews in early data, but downstream tasks proceeded without issue only because the fixes were small. A single regression missed by a cheap re-reviewer costs more in rework and escaped defects than the entire cheap re-review savings to date ($0.31 across all runs).

Escalation by risk:

| Risk | Capability | Model tier min | Verification depth |
|---|---|---|---|
| low | `implementation_strong` | mid | targeted |
| medium | `technical_review` | mid | targeted |
| high | `security_review` | premium | full |
| critical | `security_review` + independent | frontier | full |

When the lead agent itself fixes and re-reviews, the re-review must still use a model tier at or above the original reviewer. The lead may delegate the re-review to a peer at the same tier or higher.

### Rule 2: Pre-implementation recon for complexity ≥ 5

Tasks with `complexity >= 5` get a parallel fan-out of cheap reconnaissance workers before any implementer touches the code. The workers use `scout` (the `orch-scout` persona) at low effort with targeted verification — they research and summarize, they do not modify source. The orchestrator extension dispatches this fan-out itself, before any lead starts, so each worker is a billed, observable dispatch; leads receive the resulting packet and must not re-run their own recon. Worker count scales with complexity:

| Complexity | Recon workers |
|---|---|
| 5–6 | 3 |
| 7–8 | 4 |
| 9–10 | 5 |

Each worker answers one bounded question: affected files, existing tests, established conventions and prior art, dependency surface, risks and edge cases. Workers run under a hard read-only tool allow-list (`read,grep,find,ls`), so questions needing shell access — notably "recent related changes", which requires `git log` — are deliberately out of scope: an unbypassable read-only boundary is worth more than one extra question. `evidence_packet_max_tokens` (2,000) is the **aggregate** cap on the single combined packet handed to each lead, shared equally between the N workers — not 2,000 tokens per worker. The lead (capability `technical_lead` or `architect`) digests the packet into an implementation plan with task boundaries and ownership.

Skip recon for `task_class = investigation` or `qa_verification`; those have their own evidence-gathering topology.

Rationale: `implementation_strong`-class tasks with 150K–400K input tokens cost $0.55–$2.38 because the implementer reads raw repository context. Cheap scouts pre-digesting that context into one 2K-token evidence packet save $1+ on the most expensive implementer calls and improve focus.

### Rule 3: Exploration uses the cheapest sufficient model

Investigation, recon, and digest tasks go to the cheapest capability that can produce the needed evidence. The topology is one capable lead plus 3–5 parallel cheap recon workers. The lead synthesizes; the workers gather. Cost ceiling per recon: $0.50; the orchestrator flags any single exploration run that exceeds this.

| Task class | Worker capability | Lead capability |
|---|---|---|
| Issue triage | `analysis_mid` | `technical_lead` |
| Plan audit | `analysis_mid` | `technical_lead` |
| Codebase recon | `implementation_fast` | `technical_lead` |
| Security audit | `security_review` (full), no separate lead | n/a |
| Spec synthesis | `analysis_strong` | `architect` |

Rationale: the ht-codex-modularization-status run proved this topology — 4 parallel mid-tier scouts produced complete evidence packets at near-zero cost, and a single premium synthesis produced the status report. Sending the premium model to do the investigation itself would have cost 5–10× more.

### Rule 4: Lead sizing

Triage classifies complexity and risk; `method.json` `rules.lead_sizing` turns them into a lead size. Orchestration asks for a size, never a model; the active profile binds each size through a tier.

| Size | Complexity band | Capability | Tier |
|---|---|---|---|
| small | 1–3 | `lead_small` | mid |
| standard | 4–6 | `lead` | premium |
| large | 7–10 | `lead_large` | frontier |

Size = max(complexity band, risk floor). Risk floors: medium ≥ standard, high and critical = large; an unknown risk is treated as medium. `--lead-size small|standard|large` overrides both. A lead that fails verification is retried one size up per retry, capped at large.

Rationale: on 2026-09-24 the frontier lead (fable-5-1) was $90.71 of $184.11 orchestrated spend over 17 runs with 11 verified passes, while sonnet-5 leads cost $1.04 over 21 runs with 19 verified passes.

### Rule 5: The lead delegates

The lead persona has no `write` or `edit` tools. It plans, dispatches `orch-implementation-*` implementers, reviewers and QA, and verifies. A lead that reports changed files without dispatching an implementer is tagged `lead_self_implemented` on its metric row. Every lead report ends with `STATUS: completed|partial|blocked`; when every lead is blocked the run is reported as **BLOCKED**, QA does not run, and the run outcome is `blocked` (neither a pass nor a route failure).

Several leads need the architect's `## Lead assignments` (scope + `depends on`). Dependent leads run in later waves; a lead whose dependency failed or was blocked is not started. Without valid assignments one lead runs with the whole goal.

### Spend cap and provider fallback

`rules.dispatch_spend_cap` sets a USD ceiling per dispatch (`lead_small` $1.50, `lead` $4, `lead_large` $10, `architect` $2, default $1). `warn` notifies once and records `spend_cap_exceeded`; `enforce` also stops the dispatch; `off` disables. It ships as `warn`.

A dispatch on an `openai-codex/*` model that fails with a usage-limit, quota or rate-limit error is retried once on the same model id under `amazon-bedrock` and recorded as `route_degraded`. Both attempts are billed.

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

To evaluate whether the orchestrator is earning its keep, run `scripts/skill_vs_baseline.py`. It reads `metrics.jsonl`, partitions orchestrated work from session-log ingests, reprices orchestrated records at flat single-model baselines, and reports cost, success rate, cost-per-success, retry rate, and waste — for the orchestrator and each bracket. The script is observational: it writes nothing to the stream and does not change the dashboard.

The most recent calibrated numbers live in `policy_overlay.json` under `history.measured_performance` and are refreshed as new orchestrated runs are sampled. The durable finding as of the first measurement: the orchestrator's routing savings came from reviews routed to cheaper tiers paying for stronger implementers. That measurement predates the 2026-09-24 finding that a frontier lead doing its own implementation was 49% of orchestrated spend; treat `policy_overlay.json` `enforcement.measured_roi` as historical until it is re-measured on matched cohorts (plan Phase E).

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
- re-review minimum tier: mid (see Routing policy, `method.json` `rules.review_after_fix`)
- lead sizing: on (`rules.lead_sizing`); `--lead-size` overrides
- per-dispatch spend cap: warn (`rules.dispatch_spend_cap`)
- OpenAI routing: `openai-codex` first, one Bedrock retry on quota errors
- active profile: `premium` (shipped in `bridge/orchestrator-profiles.json`)
- pre-implementation recon: required at complexity ≥ 5
- exploration cheapest sufficient: enforce via topology

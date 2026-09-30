# Adaptive Routing in V3

Adaptive routing chooses a **compute package**, not merely a model.

A package contains:

- capability class
- effort level
- context budget
- verification depth
- reviewer-independence requirement

The routing objective is the lowest estimated verified cost that satisfies the effective quality floor, subject to risk and feature constraints.

## Evidence

Historical comparisons are grouped by:

- task class
- complexity bucket
- risk
- capability
- effort
- verification depth
- topology shape when available

Delayed outcomes can reduce confidence in routes that look good at completion but later cause regressions, rollbacks, reopens, or human corrections.

## Rollout

Recommended rollout:

1. `observe`
2. `recommend`
3. `enforce` for low/medium-risk classes with sufficient data
4. expand scope only after delayed outcomes mature

Do not enable automatic policy tuning simply because adaptive routing is trusted. Adaptive routing chooses within an approved policy; policy tuning changes the policy itself.

## Exploration

Without controlled exploration, the system can become self-confirming: a route never tried on harder tasks can never accumulate evidence. Exploration therefore exists, but should be bounded by:

- sample rate
- risk exclusion
- maximum incremental estimated cost
- explicit telemetry

## Reproducibility

Canary assignment is deterministic. Normal exploration is also seeded deterministically by run/task identity in the reference scaffold so the same plan can be explained and replayed. A harness may choose stronger reproducibility guarantees when `reproducible_routing.enabled` is true.

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

Compare only reasonably similar work (task class, complexity bucket, risk, capability, effort, verification depth, topology where available). Require minimum samples before empirical enforcement, and include delayed outcomes when judging route quality.

## Shadow routing, effort and verification

- Shadow routing can estimate an alternative route without executing it. Actually executing the alternative must be enabled separately because it consumes extra cost.
- When the harness supports it, effort is an independent scheduling axis. Escalation can raise effort before switching models if history shows that is economically effective; higher effort is not always better.
- Verification mechanisms may be always on, off, or adaptive depending on policy. High-risk work may require independent or specialized review. Cached verification is valid only under its configured revision/environment/input rules.

## Policy simulation and canaries

Candidate policies should be simulated against historical cohorts before rollout. Counterfactual results must be labeled estimated. Canary assignment is deterministic by run ID. Automatic promotion is off by default.

## Rule rationale and history

The routing rules in `SKILL.md` are defined in `orchestrator/method.json`; the rationale below was calibrated against the orchestrator's first runs and validated against the metric stream.

- **Rule 1 (review after a fix).** After a fix the code under review has changed. The cheap tier confirmed 4/4 re-reviews in early data, but downstream tasks proceeded without issue only because the fixes were small. A single regression missed by a cheap re-reviewer costs more in rework and escaped defects than the entire cheap re-review savings to date ($0.31 across all runs). When the lead itself fixes and re-reviews, the re-review must still use a model tier at or above the original reviewer; it may delegate to a peer at the same tier or higher.
- **Rule 2 (pre-implementation recon).** `implementation_strong`-class tasks with 150K-400K input tokens cost $0.55-$2.38 because the implementer reads raw repository context. Cheap scouts pre-digesting that context into one 2K-token evidence packet save $1+ on the most expensive implementer calls and improve focus. Workers run under a hard read-only allow-list (`read,grep,find,ls`), so questions that need a shell, notably "recent related changes" (`git log`), are deliberately out of scope: an unbypassable read-only boundary is worth more than one extra question. `evidence_packet_max_tokens` (2,000) is the aggregate cap on the combined packet handed to each lead, shared between the N workers. Skip recon for `task_class = investigation` or `qa_verification`; those have their own evidence-gathering topology. For unfamiliar or multi-file work the lead receives the compact packets, owns synthesis, task boundaries and risk decisions, and should not repeat discovery; escalate to it when worker findings conflict or material uncertainty remains.
- **Rule 3 (cheapest sufficient exploration).** The ht-codex-modularization-status run proved the topology: 4 parallel mid-tier scouts produced complete evidence packets at near-zero cost, and a single premium synthesis produced the status report. Sending the premium model to investigate would have cost 5-10x more. `max_recon_cost_usd` ($0.50) documents an intended ceiling but nothing reads it; it is advisory only. Task-class table: issue triage and plan audit use `analysis_mid` workers with a `technical_lead`; codebase recon uses `implementation_fast` with a `technical_lead`; security audit uses `security_review` (full) with no separate lead; spec synthesis uses `analysis_strong` with an `architect`.
- **Rule 4 (lead sizing).** On 2026-09-24 the frontier lead (fable-5-1) was $90.71 of $184.11 orchestrated spend over 17 runs with 11 verified passes, while sonnet-5 leads cost $1.04 over 21 runs with 19 verified passes.
- **Rule 5 (the lead delegates).** A frontier-tier lead that implements directly was the single largest cost in the orchestrator's history. A lead that reports changed files without dispatching an implementer is tagged `lead_self_implemented`. Several leads need the architect's `## Lead assignments` (scope + `depends on`); dependent leads run in later waves and a lead whose dependency failed or was blocked is not started. Without valid assignments one lead runs with the whole goal.
- **Spend cap and fallback.** `rules.dispatch_spend_cap` ships as `warn`. The dashboard's Spend-cap breaches table groups every breach by capability and model, the Risk observatory shows the total, and the run evidence table flags each capped run. A dispatch on an `openai-codex/*` model that fails with a usage-limit, quota or rate-limit error is retried once on the same model id under `amazon-bedrock` and recorded as `route_degraded`; both attempts are billed.

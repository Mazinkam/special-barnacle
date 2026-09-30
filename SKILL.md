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

Route on a compute package: capability, effort, context budget, verification depth, reviewer independence. Model strength is not quality; evaluate the whole implementation + verification route.

Rationale and history: `docs/ADAPTIVE_ROUTING.md`. State, dashboard, compliance, performance evidence: `docs/TELEMETRY.md`.

## Routing policy

The method (capability vocabulary, cost tiers, default efforts, role aliases, routing rules) is defined **once** in `orchestrator/method.json`, read by the Python engine and, via symlink, the HT bridge. **Edit `method.json` to change the method; the tables below are a human summary and must match it** (`tests/test_method.py` checks the thresholds quoted here). Rule rationale and history live in `docs/ADAPTIVE_ROUTING.md`.

### Rule 1: Review after a fix uses at least the original reviewer's tier

A re-review is any review following a fix-round on the same `task_id` (including `*-rereview` IDs and any `technical_review`/`security_review` with `retry > 0` that passed). The cheap tier (`implementation_fast`, `scout`, `worker`) **MUST NOT** re-review changed code; the re-review model must be at or above the model that produced the original review.

| Risk | Capability | Model tier min | Verification depth |
|---|---|---|---|
| low | `implementation_strong` | mid | targeted |
| medium | `technical_review` | mid | targeted |
| high | `security_review` | premium | full |
| critical | `security_review` + independent | frontier | full |

### Rule 2: Pre-implementation recon for complexity ≥ 5

Tasks with `complexity >= 5` get a parallel fan-out of cheap, read-only `scout` workers (`read,grep,find,ls`) before any implementer runs. The orchestrator dispatches them itself, before any lead starts, so each is a billed, observable dispatch; leads receive the packet and must not re-run recon. Skipped for `investigation` and `qa_verification`. `evidence_packet_max_tokens` (2,000) caps the combined packet.

| Complexity | Recon workers |
|---|---|
| 5–6 | 3 |
| 7–8 | 4 |
| 9–10 | 5 |

### Rule 3: Exploration uses the cheapest sufficient model

Investigation, recon and digest go to the cheapest capability that yields the evidence: one capable lead plus 3–5 cheap parallel workers; the lead synthesizes. `max_recon_cost_usd` ($0.50) is advisory only; nothing enforces it. Task-class table: `docs/ADAPTIVE_ROUTING.md`.

### Rule 4: Lead sizing

Triage classifies complexity and risk; `rules.lead_sizing` turns them into a size. Orchestration asks for a size, never a model; the active profile binds each size through a tier.

| Size | Complexity band | Capability | Tier |
|---|---|---|---|
| small | 1–3 | `lead_small` | mid |
| standard | 4–6 | `lead` | premium |
| large | 7–10 | `lead_large` | frontier |

Size = max(complexity band, risk floor). Risk floors: medium ≥ standard, high and critical = large; unknown risk is medium. `--lead-size small|standard|large` overrides both. A lead that fails verification is retried one size up per retry, capped at large.

### Rule 5: The lead delegates

The lead has no `write`/`edit` tools: it plans, dispatches `orch-implementation-*` implementers and reviewers, and verifies. A lead reporting changed files without dispatching an implementer is tagged `lead_self_implemented`. Every lead report ends with `STATUS: completed|partial|blocked`; when every lead is blocked the run is **BLOCKED**, QA does not run, and the outcome is `blocked`.

### Spend cap and provider fallback

`rules.dispatch_spend_cap` sets a USD ceiling per dispatch (`lead_small` $1.50, `lead` $4, `lead_large` $10, `architect` $2, default $1): `warn` notifies and records `spend_cap_exceeded`; `enforce` also stops the dispatch; `off` disables. Ships as `warn`. An `openai-codex/*` dispatch failing on usage-limit/quota/rate-limit is retried once on the same model id under `amazon-bedrock` and recorded as `route_degraded`; both attempts are billed.

### Rule 6: Workflow levels

`method.json` `rules.workflow_policy` picks a workflow level from observable repository evidence, not from triage complexity. Levels: `direct` (one implementer + deterministic checks), `checked` (direct + one independent review), `led` and `full` (the coordinated pipeline; `full` is a floor nothing can lower). A repo with no discovered checks is never routed `direct`.

| Evidence | Level |
|---|---|
| explicit high/critical risk, or any `risk_path_globs` hit | full (hard floor) |
| interface change across packages | full (hard floor) |
| unresolved scope (no candidate files) | led (hard floor) |
| 4 or more candidate files or 3 or more packages | led |
| exactly one low-risk file with adjacent tests and discovered checks, no interface change | direct |
| anything else | checked |

`mode` is `observe` by default: it records `workflow_level_planned` and runs today's pipeline. `enforce` runs `direct`/`checked` with `fix_rounds_per_level` repair rounds, then escalates to `led` (`workflow_level_escalated`); `off` disables. Persist a per-user mode with `/orchestrator-models workflow off|observe|enforce` (`workflow default` removes it). Precedence: `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE` env > saved setting (`workflow_mode` in `~/.humain-terminal/agent/orchestrator-profiles.json`) > `method.json`. `--workflow <level>` may raise the level, never lower it below the floor. `investigation` and `qa_verification` are never run flat.

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
- re-review minimum tier: mid (`rules.review_after_fix`)
- lead sizing: on (`rules.lead_sizing`); `--lead-size` overrides
- per-dispatch spend cap: warn (`rules.dispatch_spend_cap`)
- workflow levels: observe (`rules.workflow_policy.mode`)
- OpenAI routing: `openai-codex` first, one Bedrock retry on quota errors
- active profile: `premium` (shipped in `bridge/orchestrator-profiles.json`)
- pre-implementation recon: required at complexity ≥ 5
- exploration cheapest sufficient: enforce via topology

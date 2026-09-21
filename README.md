# Hierarchical Agent Orchestrator V3

A portable, model-agnostic orchestration scaffold for using coding agents as a default software-development workflow.

V3 includes V1 + V2 and adds **toggleable empirical adaptive routing**.

## Core model

```text
request / goal
   -> risk + complexity classification
   -> architect / authoritative event log + ledger
   -> dynamic DAG / hierarchy
   -> leads + bounded workers
   -> deterministic verification
   -> semantic / specialized review
   -> integration
   -> delayed outcomes
   -> empirical routing + economics dashboard
```

Hierarchy depth and worker count are dynamic: "many workers" always means only as many as are economically useful.

## What V3 adds

- adaptive routing modes: `off | observe | recommend | enforce`
- model/capability adaptation
- effort-level adaptation when supported by the harness
- topology, context-budget and verification adaptation switches
- historical learning with minimum evidence thresholds
- controlled exploration
- shadow routing
- model promotion and demotion
- deterministic canary assignment
- policy simulation against historical cohorts
- feature inheritance: global -> repo -> task
- feature-state validation
- decision explanations and replayable telemetry
- V3 dashboard sections for feature state and adaptive-routing behavior

Automatic policy tuning, automatic policy promotion, auto-merge and auto-deploy remain **off by default**.

## Important design boundary

The orchestrator never needs to know concrete model names. It asks for capabilities such as:

- `architect`
- `technical_lead`
- `implementation_fast`
- `implementation_strong`
- `technical_review`
- `security_review`

The active harness adapter maps those capabilities and abstract effort levels to concrete models/settings.

## Quick start

```bash
python -m orchestrator.cli init
python -m orchestrator.cli features
python -m orchestrator.cli plan run-001 backend_refactor 6 medium
python -m orchestrator.cli dashboard
```

Open:

```text
~/.local/state/coding-agent-orchestrator/dashboard.html
```

## Adaptive rollout

Default V3 policy is deliberately conservative:

```text
adaptive routing       recommend
historical learning    on
controlled exploration 2%
shadow routing          on
policy simulation       on
auto policy tuning      off
auto policy promotion   off
auto merge              off
auto deploy             off
```

A recommended progression is:

```text
off -> observe -> recommend -> enforce
```

Only move to `enforce` once route cohorts have enough samples and delayed quality signals are acceptable.

## Cost / quality objective

The scheduler is designed around **verified economic cost**, not token price alone:

```text
model spend
+ retries/rework
+ verification compute
+ orchestration overhead
+ optional human attention
+ delayed failure / maintenance signals
```

subject to hard correctness gates and an effective quality floor.

## V2 capabilities retained

- event-sourced persistent state
- rebuildable ledger
- dynamic DAG/hierarchy
- effort-aware compute packages
- context registry and bounded context packets
- context invalidation/refetch observability
- verification caching
- flaky-test telemetry
- worktree/ownership hooks
- delayed 7/30/90-day outcomes
- risk observability
- route economics
- self-contained HTML dashboard

## Files

```text
orchestrator/
  adaptive.py             V3 adaptive route/topology logic
  features.py             toggle inheritance + validation
  policy_simulation.py    historical counterfactual estimator
  engine.py               high-level harness API
  scheduler.py            compute packages and base topology
  history.py              empirical cohort aggregation
  context.py              context registry / packets
  verification.py         verification cache / flaky signals
  workspace.py            git worktree + ownership hooks
  outcomes.py             delayed outcome summaries
  dashboard.py            self-contained V3 HTML dashboard
  config.json             default V3 policy
  feature_schema.json     feature-state reference
adapters/
docs/
tests/
~/.local/state/coding-agent-orchestrator/
```

## Notes

This is an orchestration scaffold rather than a provider-specific agent launcher. A Codex, Claude Code, or other harness should use `OrchestrationEngine.plan_run()` and then resolve the returned capability + effort package through its adapter.

Historical/counterfactual outputs are explicitly estimates. The system should never treat a dashboard assurance score as a literal probability that code is correct.

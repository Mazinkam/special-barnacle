# Hierarchical Agent Orchestrator — HUMAIN Terminal Integration

## Install

```bash
cd ~/.local/share/agent-skills/hierarchical-agent-orchestrator
./install.sh           # idempotent; safe to re-run
./install.sh --uninstall
```

The script symlinks the contents of `../bridge/extensions/` into
`~/.humain-terminal/agent/extensions/` and `../bridge/agents/` into
`~/.humain-terminal/agent/agents/`. Edit in `bridge/` and the runtime sees it
immediately — no copy step.

After install, restart HT (or `/reload`):

```
/reload
/orchestrate <goal> [--task-class T] [--complexity N] [--risk R] [--fan-out] [--max-retries N]
/orchestrator-roi
/cross-review-demo
```

## Files this installs

| runtime path (under ` ~/.humain-terminal/agent/`) | source in this repo |
|---|---|
| `extensions/orchestrator.ts` | `bridge/extensions/orchestrator.ts` |
| `extensions/orchestrator-README.md` | `bridge/extensions/orchestrator-README.md` |
| `extensions/cross-review-demo.ts` | `bridge/extensions/cross-review-demo.ts` |
| `agents/orchestrator-lead.md` | `bridge/agents/orchestrator-lead.md` |
| `agents/orch-{architect,implementation-strong,implementation-fast,worker,scout,technical-lead,technical-review,security-review,qa-agent}.md` | `bridge/agents/` |

## Use

```
/orchestrate Refactor app/admin/tabs/metrics/orchestration-cohort-panel.tsx \
  --task-class backend_refactor --complexity 6 --risk medium
```

With pre-built parallelism (skip the lead agent and fan out directly):

```
/orchestrate "Fix these 3 typos in parallel" --fan-out --complexity 2 --risk low
```

Without `--task-class` / `--complexity` / `--risk`, the extension triages via the
cheapest configured model (gpt-5.6-luna / haiku tier) and confirms the inferred
values with you before dispatching.

Show ROI anytime:

```
/orchestrator-roi
```

## How it works

1. `/orchestrate` spawns `python3 -m orchestrator.cli plan <args>` to get a `PlanResponse` (topology + selected/recommended route + quality floor).
2. The extension resolves abstract capabilities → concrete `provider/model` strings via the dynamic adapter. The dynamic adapter intersects HT's `models-store.json` with the skill's `data/humain_node_catalog.json` (cheapest/mid/expensive per tier), so it picks whatever the user has configured. Falls back to the bundled FALLBACK_ADAPTER if the resolve fails.
3. Fan-out by topology depth:
   - `depth ≤ 2`: dispatch one `orchestrator-lead` agent. The lead handles its own worker fan-out via HT's `subagent` tool.
   - `depth ≥ 3`: dispatch the architect first, then `leads` orchestrator-lead agents in parallel. Each lead owns its worker fan-out.
4. After leads finish, the extension runs `orch-qa-agent` against the union of changed files. Verdict is PASS or FAIL based on parsing `FAIL`/`✗`/`failed` markers from QA output.
5. On FAIL, escalate per `policy_overlay.json` Rule 1: re-dispatch reviews at bumped tier (mid → premium for re-reviews; never stay at cheap on retry). Bounded by `--max-retries` (default 2).
6. Every dispatch writes two records back via `python3 -m orchestrator.cli metric`:
   - `model_call`: the actual model call with tokens + cost. `cost_source: reported` if HT reported a non-zero cost, otherwise `estimated-from-reported-tokens`.
   - `route_executed`: joins the executed model/cost with the plan-time recommendation. Closes the (recommended, executed, observed) triple so the skill's history can learn from real outcomes.
7. Final summary surfaced via `ctx.ui.notify` and appended to `outcomes.jsonl` via `cli outcome`.

## Model binding

By default the extension resolves models dynamically through the skill's
`scripts/dynamic_adapter.py`:

```
cli resolve-adapter --explain
```

which returns `{capability: {provider, model, tier, ...}}` for all 16
capabilities it recognizes. The cheapest-mid-premium tiers come from
`humain_node_catalog.json` (calibrated against model costs dated 2026-09-21).
The cheapest model the user has configured wins `implementation_fast` /
`scout` / `worker`; mid wins `implementation_strong` / `technical_lead` /
`technical_review` / `lead` / `qa_agent`; premium wins `architect` /
`security_review` / `analysis_strong`.

Override specific capabilities by writing `~/.humain-terminal/agent/orchestrator-adapter.json`:

```json
{
  "implementation_strong": { "model": "amazon-bedrock/anthropic.claude-opus-4-5" },
  "technical_review":     { "model": "openai-codex/gpt-5.6-terra" }
}
```

The first segment of the model id (`amazon-bedrock`, `openai-codex`, `humain-node`) must match one of HT's configured providers (see `~/.humain-terminal/agent/models-store.json`).

## What this integration does NOT do

- It does not build a real-time HT-side dashboard view. The HTML dashboard at `~/.local/state/coding-agent-orchestrator/dashboard.html` is still canonical.
- It does not wire shadow routing to emit per-call counterfactuals. The plan-time `adaptive_route_decision` event already carries `recommended_estimated_*`, but per-call comparison still relies on retrospective `skill_vs_baseline.py` repricing — improved now by the `route_executed` events this extension emits.
- It does not enforce `policy_overlay.json` rules itself — the Python skill's `engine.plan_run()` already does that, and the extension trusts the routing it gets back.
- It does not write persistent orchestrator state itself. The Python `EventStore` does that via `cli metric`/`cli outcome` — the extension only bridges.

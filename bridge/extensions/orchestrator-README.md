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
/orchestrate <goal> [--task-class T] [--complexity N] [--risk R] [--cheap P/M] [--mid P/M] [--premium P/M] [--model cap=P/M] [--max-retries N] [--yes]
/orchestrator-models
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

Precedence, highest first:

1. Per-run flags: `--cheap P/M`, `--mid P/M`, `--premium P/M`, `--model <capability>=P/M`
2. `~/.humain-terminal/agent/orchestrator-adapter.json` → `capabilities`
3. `~/.humain-terminal/agent/orchestrator-adapter.json` → `tiers`
4. Cost-tier resolver (`cli resolve-adapter --explain`, intersects HT's `models-store.json` with `data/humain_node_catalog.json`)
5. Bundled `FALLBACK_ADAPTER`

```json
{
  "tiers": {
    "premium": "amazon-bedrock/global.anthropic.claude-fable-5-1",
    "mid":     "amazon-bedrock/global.anthropic.claude-sonnet-5",
    "cheap":   "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
  },
  "capabilities": {
    "technical_review": { "model": "amazon-bedrock/global.anthropic.claude-opus-5", "effort": "high" }
  }
}
```

Tiers: `cheap` = implementation_fast, worker, scout · `mid` = lead, qa_agent,
implementation_strong, technical_lead, technical_review, analysis_mid,
integration/migration/performance/api_contract_review · `premium` = architect,
security_review, analysis_strong.

Every binding is canonicalized against HT's model registry before dispatch, so
`amazon-bedrock/claude-sonnet-5` becomes the exact id that will run, and an
unresolvable override aborts the run before any money is spent. Inspect with:

```
/orchestrator-models
/orchestrator-models --premium amazon-bedrock/claude-opus-5
```

The lead's task prompt carries the resolved agent→model table and the lead must
pass `model:` on every `subagent` call — HT's subagent tool ignores persona
frontmatter `model:` and otherwise runs children on the parent's model.

## Progress and logs

While a run is live the extension shows a widget above the editor (one row per
dispatch: model, elapsed, turns, tool calls, last tool, cost) and a footer status
line, and emits a phase notification at each stage (triage → plan → architect →
leads → QA → escalation). Each run writes to
`~/.local/state/coding-agent-orchestrator/runs/<runId>/`:

| file | content |
|---|---|
| `run.log` | human-readable timeline: phases, every dispatch start/end, every tool call, verdicts |
| `<taskId>.prompt.md` | the exact prompt sent to that child |
| `<taskId>.events.jsonl` | the child's raw `--mode json` stream |
| `<taskId>.stderr.log` | the child's stderr (only written when non-empty) |
| `lead-report.md` | the lead(s)' final reports |

The Python EventStore additionally receives `dispatch_plan_confirmed`,
`dispatch_started`, and `dispatch_finished` events (with model, cost, exit code,
duration) alongside the existing `model_call` / `route_executed` metrics.

Dispatched agents are non-interactive: they cannot ask you questions mid-run.
Goals that ask for questions get a warning up front; the lead is instructed to
put open questions under `## Open items`, which the completion summary surfaces.

Only one `/orchestrate` may be live per session. `--yes` (or
`HUMAIN_ORCHESTRATOR_ASSUME_YES=1`) skips the two confirmations.

## What this integration does NOT do

- It does not build a real-time HT-side dashboard view. The HTML dashboard at `~/.local/state/coding-agent-orchestrator/dashboard.html` is still canonical.
- It does not wire shadow routing to emit per-call counterfactuals. The plan-time `adaptive_route_decision` event already carries `recommended_estimated_*`, but per-call comparison still relies on retrospective `skill_vs_baseline.py` repricing — improved now by the `route_executed` events this extension emits.
- It does not enforce `policy_overlay.json` rules itself — the Python skill's `engine.plan_run()` already does that, and the extension trusts the routing it gets back.
- It does not write persistent orchestrator state itself. The Python `EventStore` does that via `cli metric`/`cli outcome` — the extension only bridges.

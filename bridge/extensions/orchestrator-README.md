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
/orchestrate <goal> [--task-class T] [--complexity N] [--risk R] [--cheap P/M] [--mid P/M] [--premium P/M] [--model cap=P/M] [--max-retries N] [--interactive]
/orchestrator-models [list|set|use|pick|validate --live]
/orchestrator-roi
/cross-review-demo
```

`install.sh` also installs a launchd agent (`com.humain.orchestrator-ingest`) that sweeps
recent HT and Codex session logs into the ledger every 15 minutes. Together with the
extension's `agent_settled` / `session_shutdown` ingest hooks this keeps interactive
spend logged without any manual step; see `docs/TELEMETRY.md`.

## Files this installs

| runtime path (under ` ~/.humain-terminal/agent/`) | source in this repo |
|---|---|
| `extensions/orchestrator/` (`index.ts`, `models.ts`, `ingest.ts`) | `bridge/extensions/orchestrator/` |
| `~/Library/LaunchAgents/com.humain.orchestrator-ingest.plist` (rendered, macOS) | `install.sh` |
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
3. Parent-owned recon (`orchestrator/method.json` Rule 2, `rules.pre_implementation_recon`). For any run whose task class is not exempt, at complexity ≥ `min_complexity` (5), the extension itself dispatches the Rule-2 recon workers **before any lead starts** — 3 workers at complexity 5–6, 4 at 7–8, 5 at 9–10, always derived from `workers_by_complexity` (never from the plan's `topology.workers`). `investigation` and `qa_verification` runs are exempt (`skip_for_task_classes`), and the phase line says so explicitly instead of reporting `0/0`. Recon workers run as `worker_capability` (`implementation_fast`) with a hard read-only tool allow-list (`read,grep,find,ls`) passed via `--tools`, overriding whatever the bound persona would otherwise permit; the prompt forbids editing, committing, pushing, branch switching, stashing, and worktree changes. Each recon worker is a real, billed dispatch with its own progress row, `<taskId>.prompt.md` / `.events.jsonl` / `.stderr.log`, and `dispatch_started` / `dispatch_finished` events (`<runId>-recon-<n>`). Their output is folded into one bounded **Recon evidence** packet (per-worker and aggregate caps from `evidence_packet_max_tokens`, overridable with `HUMAIN_ORCHESTRATOR_RECON_EVIDENCE_MAX_CHARS`, with explicit `truncated` markers) that every lead receives. A failed recon worker is reported as `<taskId> unavailable` with a summarized stderr rather than dropped, and does not stop the other workers; if **every** recon worker fails the packet is prefixed with a `DEGRADED` notice so the lead and operator cannot mistake it for partial coverage. Cancellation (Esc/Ctrl+C) is checked before recon dispatch, after all finished recon workers have been billed, and before any lead is announced — a cancelled run never starts a lead, and already-finished workers are billed exactly once.
4. Fan-out by topology depth:
   - `depth ≤ 2`: dispatch one `orchestrator-lead` agent.
   - `depth ≥ 3`: dispatch the architect first, then `leads` orchestrator-lead agents in parallel.
   Leads may still use HT's `subagent` tool for implementation, review, and QA fan-out, but those nested children run inside the lead's own context window: the bridge has no visibility into them and they are **not** part of this run's authoritative worker accounting. Only the parent-owned recon workers above are counted and billed as workers.
5. After leads finish, the extension runs `orch-qa-agent` against the union of changed files. Verdict is PASS or FAIL based on parsing `FAIL`/`✗`/`failed` markers from QA output.
6. On FAIL, escalate per `orchestrator/method.json` Rule 1 (`rules.review_after_fix`): re-dispatch reviews at bumped tier (mid → premium for re-reviews; never stay at cheap on retry). Bounded by `--max-retries` (default 2).
7. Every dispatch writes two records back via `python3 -m orchestrator.cli metric`:
   - `model_call`: the actual model call with tokens + cost. `cost_source: reported` if HT reported a non-zero cost, otherwise `estimated-from-reported-tokens`.
   - `route_executed`: joins the executed model/cost with the plan-time recommendation. Closes the (recommended, executed, observed) triple so the skill's history can learn from real outcomes.
8. Final summary surfaced via `ctx.ui.notify` and appended to `outcomes.jsonl` via `cli outcome`. `total cost` covers every dispatch the run paid for — triage, architect, recon workers, leads, QA, and escalations — with each result counted once, and a dedicated `recon workers: N/M completed · $cost` line names any failed recon worker with a summarized diagnostic.

## Model binding

Models are configured in **one file**, `~/.humain-terminal/agent/orchestrator-profiles.json`,
as named profiles. Values are short **aliases** (`fable-5-1`, `sonnet`, `haiku`,
`astra`, `terra`) or explicit `provider/model`. Aliases are derived at runtime from
the models you actually have configured (`models-store.json`) — there is no static
table to go stale.

```json
{
  "version": 1,
  "active_profile": "default",
  "provider_preference": ["openai-codex", "amazon-bedrock"],
  "profiles": {
    "default": {
      "tiers":        { "premium": "fable-5-1", "mid": "sonnet", "cheap": "haiku" },
      "capabilities": { "technical_review": "astra", "security_review": "astra" },
      "effort":       { "technical_review": "high" }
    }
  }
}
```

Precedence, highest first — merged capability by capability:

1. `/orchestrate` flags: `--model <capability>=ALIAS`, `--cheap/--mid/--premium ALIAS`, `--effort LEVEL`
2. profile `capabilities` (active profile, or `--profile NAME`)
3. profile `tiers`
4. cost-tier resolver (`cli resolve-adapter`, intersects `models-store.json` with `data/humain_node_catalog.json`)
5. bundled `FALLBACK_ADAPTER`

Tiers: `cheap` = implementation_fast, worker, scout · `mid` = lead, qa_agent,
implementation_strong, technical_lead, technical_review, analysis_mid,
integration/migration/performance/api_contract_review · `premium` = architect,
security_review, analysis_strong. `effort` values are HT thinking levels
(`off|minimal|low|medium|high|xhigh|max`) and are passed as `--thinking`.

Alias rules: a bare alias that exists on several providers is picked by
`provider_preference` (default codex first) and the choice is reported; write
`provider/alias` (e.g. `amazon-bedrock/astra`) to force one. Family names
(`fable`, `sonnet`) resolve to the newest undated, `global.` variant. Unknown
aliases fail with suggestions, **before** anything is dispatched.

The old `orchestrator-adapter.json` is migrated into profile `default` the first
time it is seen and then ignored.

```
/orchestrator-models                       resolved table for the active profile, with sources
/orchestrator-models list                  every alias you can use + the full catalog
/orchestrator-models set premium fable-5-1 [--profile P]
/orchestrator-models set technical_review astra
/orchestrator-models effort technical_review high
/orchestrator-models new work --from default
/orchestrator-models use work
/orchestrator-models pick                  interactive: three tier picks, then optional per-capability overrides
/orchestrator-models validate [P]          offline: every binding resolves to a configured model
/orchestrator-models check                 validate + live one-turn probe of every distinct model (a few cents)
/orchestrate <goal> --profile work --effort high
```

The lead's task prompt carries the resolved agent→model table and the lead must
pass `model:` on every `subagent` call — HT's subagent tool ignores persona
frontmatter `model:` and otherwise runs children on the parent's model.

## Progress and logs

While a run is live the extension shows a widget above the editor (one row per
dispatch: model, elapsed, turns, tool calls, last tool, cost) and a footer status
line, and emits a phase notification at each stage (triage → plan → architect →
recon → leads → QA → escalation). The recon phase reads `recon: 0/N starting`,
then `recon: K/N completed; dispatching lead(s)`, or
`no parent-owned recon required: <reason>` when Rule 2 does not apply (the reason names either the sub-threshold complexity or the exempt task class). Each run writes to
`~/.local/state/coding-agent-orchestrator/runs/<runId>/`:

| file | content |
|---|---|
| `run.log` | human-readable timeline: phases, every dispatch start/end, every tool call, verdicts |
| `<taskId>.prompt.md` | the exact prompt sent to that child (recon workers are `<runId>-recon-<n>`, leads `<runId>-lead-<n>`) |
| `<taskId>.events.jsonl` | the child's raw `--mode json` stream |
| `<taskId>.stderr.log` | the child's stderr (only written when non-empty) |
| `lead-report.md` | the lead(s)' final reports |

The Python EventStore additionally receives `dispatch_plan_confirmed`,
`dispatch_started`, and `dispatch_finished` events (with model, cost, exit code,
duration) alongside the existing `model_call` / `route_executed` metrics.

Dispatched agents are non-interactive: they cannot ask you questions mid-run.
Goals that ask for questions get a warning up front; the lead is instructed to
put open questions under `## Open items`, which the completion summary surfaces.

Only one `/orchestrate` may be live per session. Runs automatically approve the triage result and dispatch plan by default. Pass `--interactive` to require confirmation after triage and again before dispatch. `--yes` / `-y` remain accepted as no-op compatibility aliases for the new default.

## What this integration does NOT do

- It does not track workers a lead creates through HT's `subagent` tool. Those run inside the lead's context; only the parent-owned Rule-2 recon workers are observable, billed, and reported as workers by this extension.
- It does not build a real-time HT-side dashboard view. The HTML dashboard at `~/.local/state/coding-agent-orchestrator/dashboard.html` is still canonical.
- It does not wire shadow routing to emit per-call counterfactuals. The plan-time `adaptive_route_decision` event already carries `recommended_estimated_*`, but per-call comparison still relies on retrospective `skill_vs_baseline.py` repricing — improved now by the `route_executed` events this extension emits.
- It reads the routing rules from `orchestrator/method.json` (symlinked into the extension dir) and does not re-derive them — the Python skill's `engine.plan_run()` already does that, and the extension trusts the routing it gets back.
- It does not write persistent orchestrator state itself. The Python `EventStore` does that via `cli metric`/`cli outcome` — the extension only bridges.

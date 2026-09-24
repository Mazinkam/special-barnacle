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
cheapest configured model (the cheap tier, gpt-6-luna in the shipped profiles) and
uses the inferred values. Triage also picks the **lead size** (see Lead sizing below);
pass `--lead-size small|standard|large` to override it.

Show ROI anytime:

```
/orchestrator-roi
```

## How it works

1. `/orchestrate` spawns `python3 -m orchestrator.cli plan <args>` to get a `PlanResponse` (topology + selected/recommended route + quality floor).
2. The extension resolves abstract capabilities → concrete `provider/model` strings via the dynamic adapter. The dynamic adapter intersects HT's `models-store.json` with the skill's `data/humain_node_catalog.json` (cheapest/mid/expensive per tier), so it picks whatever the user has configured. Falls back to the bundled FALLBACK_ADAPTER if the resolve fails.
3. Parent-owned recon (`orchestrator/method.json` Rule 2, `rules.pre_implementation_recon`). For any run whose task class is not exempt, at complexity ≥ `min_complexity` (5), the extension itself dispatches the Rule-2 recon workers **before any lead starts** — 3 workers at complexity 5–6, 4 at 7–8, 5 at 9–10, always derived from `workers_by_complexity` (never from the plan's `topology.workers`). `investigation` and `qa_verification` runs are exempt (`skip_for_task_classes`), and the phase line says so explicitly instead of reporting `0/0`. Recon workers run as `worker_capability` (`scout`, i.e. the purpose-built read-only `orch-scout` persona, at the cheap tier) with a hard read-only tool allow-list (`read,grep,find,ls`) passed via `--tools`, overriding whatever the bound persona would otherwise permit — including `orch-scout`'s own `bash`; the prompt forbids editing, committing, pushing, branch switching, stashing, and worktree changes. Because `bash` is withheld, recon questions that would need it (notably "recent related changes", which requires `git log`) are deliberately not asked: the unbypassable boundary is worth more than the extra question. Each recon worker is a real, billed dispatch with its own progress row, `<taskId>.prompt.md` / `.events.jsonl` / `.stderr.log`, and `dispatch_started` / `dispatch_finished` events (`<runId>-recon-<n>`). Their output is folded into one bounded **Recon evidence** packet that every lead receives. `evidence_packet_max_tokens` (2000, × ~4 chars/token, overridable with `HUMAIN_ORCHESTRATOR_RECON_EVIDENCE_MAX_CHARS`) is the **aggregate** cap on that combined packet — not a per-worker allowance — because the cost being bounded is the lead's input prompt; each of the N workers gets an equal `budget / N` share and the assembled packet is re-capped at the total, with explicit `…[truncated]` markers wherever a cut lands (see `method.json` `rules.pre_implementation_recon.evidence_packet_rationale`). A failed recon worker is reported as `<taskId> unavailable` with a summarized stderr rather than dropped, and does not stop the other workers; if **every** recon worker fails the packet is prefixed with a `DEGRADED` notice so the lead and operator cannot mistake it for partial coverage. Cancellation (Esc/Ctrl+C) is checked before recon dispatch, after all finished recon workers have been billed, and before any lead is announced — a cancelled run never starts a lead, and already-finished workers are billed exactly once.
4. Fan-out by topology depth:
   - `depth ≤ 2`: dispatch one `orchestrator-lead` agent.
   - `depth ≥ 3`: dispatch the architect first. With `leads > 1` the architect must return `## Lead assignments` (`Lead N: <scope> (depends on: none|1,2)`); leads then run in dependency **waves**, and a lead whose dependency failed or reported `STATUS: blocked` is not started. Without valid assignments a single lead runs with the whole goal.
   The lead is sized by triage (`lead_small` / `lead` / `lead_large`) and has no `write`/`edit` tools: it delegates implementation to `orch-implementation-*`.
   Leads may still use HT's `subagent` tool for implementation, review, and QA fan-out, but those nested children run inside the lead's own context window: the bridge has no visibility into them and they are **not** part of this run's authoritative worker accounting. Only the parent-owned recon workers above are counted and billed as workers. The `orchestrator-lead` persona therefore forbids leads from dispatching their own `orch-scout` recon round — that would pay for Rule-2 recon twice, invisibly — and `index.test.ts` ("lead persona recon contract") guards the instruction against regression.
5. After leads finish, the extension runs `orch-qa-agent` against the union of changed files. Verdict is PASS or FAIL based on parsing `FAIL`/`✗`/`failed` markers from QA output. Every lead report ends with `STATUS: completed|partial|blocked`: if every lead is blocked the run is **BLOCKED** and QA does not run. If every lead reports `Files Changed: None`, files git shows as changed during the run are treated as another session's edits (`external_changes_detected`) and excluded from QA.
6. On FAIL, escalate per `orchestrator/method.json` Rule 1 (`rules.review_after_fix`): re-dispatch reviews at bumped tier (mid → premium for re-reviews; never stay at cheap on retry). Bounded by `--max-retries` (default 2).
7. Every dispatch writes two records back via `python3 -m orchestrator.cli metric`:
   - `model_call`: the actual model call with tokens + cost. `cost_source: reported` if HT reported a non-zero cost, otherwise `estimated-from-reported-tokens`.
   - `route_executed`: joins the executed model/cost with the plan-time recommendation. Closes the (recommended, executed, observed) triple so the skill's history can learn from real outcomes.
8. Final summary surfaced via `ctx.ui.notify` and appended to `outcomes.jsonl` via `cli outcome`. `total cost` covers every dispatch the run paid for — triage, architect, recon workers, leads, QA, and escalations — with each result counted once, and a dedicated `recon workers: N/M completed · $cost` line names any failed recon worker with a summarized diagnostic.

## Model binding

Models are configured in **one file**, `~/.humain-terminal/agent/orchestrator-profiles.json`,
as named profiles. `install.sh` installs the shipped `bridge/orchestrator-profiles.json`
(backing up a differing file to `orchestrator-profiles.json.bak-<UTC>`); nothing is
written when the extension loads. Values are short **aliases** (`fable-5-1`,
`opus-5-5`, `sonnet-5`, `gpt-6-sol`, `gpt-6-luna`, `astra`) or explicit `provider/model`. Aliases are derived at runtime from
the models you actually have configured (`models-store.json`) — there is no static
table to go stale.

Shipped profiles (`premium` is active):

| Capability | `premium` | `anthropic` | `openai` | `oss` |
|---|---|---|---|---|
| cheap tier (scout, worker, implementation_fast) | gpt-6-luna | sonnet-5 @ low | gpt-6-luna | qwen3.8-27b |
| mid tier (lead_small, implementation_strong, qa, …) | sonnet-5 | sonnet-5 | gpt-6-sol | minimax-m3 |
| premium tier (lead, architect, security_review, …) | opus-5-5 | opus-5-5 | gpt-6-sol @ high | glm-5.2 |
| frontier tier (lead_large) | fable-5-1 | fable-5-1 | astra | glm-5.2 |
| reviews (technical/integration/migration/performance/api-contract) | gpt-6-sol | sonnet-5 | gpt-6-sol | kimi-k3 |
| security_review | astra | opus-5-5 | gpt-6-sol @ high | glm-5.2 |

```json
{
  "version": 1,
  "active_profile": "premium",
  "provider_preference": ["openai-codex", "amazon-bedrock"],
  "profiles": {
    "premium": {
      "tiers": { "cheap": "gpt-6-luna", "mid": "sonnet-5", "premium": "opus-5-5", "frontier": "fable-5-1" },
      "capabilities": { "technical_review": "gpt-6-sol", "security_review": "astra" }
    }
  }
}
```

Precedence, highest first — merged capability by capability:

1. `/orchestrate` flags: `--model <capability>=ALIAS`, `--cheap/--mid/--premium/--frontier ALIAS`, `--effort LEVEL`
2. profile `capabilities` (active profile, or `--profile NAME`)
3. profile `tiers`
4. cost-tier resolver (`cli resolve-adapter`, intersects `models-store.json` with `data/humain_node_catalog.json`)
5. bundled `FALLBACK_ADAPTER`

Tiers: `cheap` = implementation_fast, worker, scout · `mid` = lead_small, qa_agent,
implementation_strong, technical_lead, technical_review, analysis_mid,
integration/migration/performance/api_contract_review · `premium` = lead, architect,
security_review, analysis_strong · `frontier` = lead_large. `effort` values are HT thinking levels
(`off|minimal|low|medium|high|xhigh|max`) and are passed as `--thinking`.

Alias rules: a bare alias that exists on several providers is picked by
`provider_preference` (default codex first) and the choice is reported; write
`provider/alias` (e.g. `amazon-bedrock/astra`) to force one. Family names
(`fable`, `sonnet`) resolve to the newest undated, `global.` variant. Unknown
aliases fail with suggestions, **before** anything is dispatched.

The old `orchestrator-adapter.json` is no longer migrated (the migrated `default`
profile was retired); run `install.sh` to install the shipped profiles.

### Lead sizing, spend cap, provider fallback

- **Lead sizing** (`method.json` `rules.lead_sizing`): complexity 1–3 → `lead_small` (mid),
  4–6 → `lead` (premium), 7–10 → `lead_large` (frontier); medium risk ≥ standard,
  high/critical = large. `--lead-size` overrides. A failed verification retries the lead
  one size up. Each decision is recorded as a `lead_sized` event.
- **Spend cap** (`rules.dispatch_spend_cap`, ships as `warn`): per-dispatch USD ceilings;
  `warn` records `spend_cap_exceeded` once, `enforce` also stops the dispatch.
- **Provider fallback**: an `openai-codex/*` dispatch that fails on a usage/quota/rate limit
  is retried once on the same model under `amazon-bedrock`, recorded as `route_degraded`.
- Every `model_call`/`route_executed` row carries `profile`, `policy_id`
  (`<profile>-<hash of resolved bindings>`) and `lead_size`; the dashboard's **Lead sizing**
  table groups lead cost and verified outcomes by size.

```
/orchestrator-models                       resolved table for the active profile, with sources
/orchestrator-models list                  every alias you can use + the full catalog
/orchestrator-models set premium fable-5-1 [--profile P]
/orchestrator-models set technical_review astra
/orchestrator-models effort technical_review high
/orchestrator-models new work --from premium
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

# Orchestration Economics Program — Design

## Purpose

Cut orchestrated cost and wall time without lowering verified quality, based on the evidence in the
2026-09-24 dashboard (`~/.local/state/coding-agent-orchestrator/dashboard.html`). Success means:
the lead is sized to the task and delegates implementation, cheap scouts carry discovery, context is
short-lived, provider caps no longer fail runs, implementer worktrees are isolated and cleaned up,
and the evidence loop is complete enough to judge every change by real matched cohorts.

## Evidence this design responds to (2026-09-24 snapshot)

| Finding | Number |
|---|---|
| Orchestrated spend / runs | $184.11 / 172 runs |
| `lead` on fable-5-1 | $90.71 (49%), 33 calls, 17 runs, 11/17 verified pass |
| `lead` on sonnet-5 | $1.04, 21 runs, 19/21 verified pass |
| Fable-lead cost split | ~$55 cache writes (4.41M tok @ $12.5), ~$28 output, ~$10 cache reads |
| Lead self-implemented (no implementer) | 20 of 66 complexity ≥ 5 runs |
| Rule-2 recon compliance | 2 of 66 complexity ≥ 5 runs (3%) |
| Calls that hit the 90-minute ceiling | 11 |
| Waste | $22.02 (12%); bad-plan rework $11.28 is the largest item |
| `hier-orch-impl` QA | 2 calls, 33M uncached input tokens, $13.40 |
| Adaptive decisions | 101, all `recommended_only`; history sufficient 0%; exploration 0% |
| Cost coverage / duration coverage / verification coverage | 53% runs fully priced / 0% / 31% |
| `policy_id=unknown` spend | $98.12 |
| Price rates | all from `unverified-local-catalog` |
| Interactive (non-orchestrated) sessions | $8,489.52, of which Codex $7,865.82 (mostly gpt-6-astra) |
| Capacity walls | sonnet-5 weekly cap, openai-codex usage limit, m3 malformed tool call |
| Concurrency incidents | 3 (peer rebase/reset/unstage mid-task) |

The run logs attribute the fable lead to `--profile premium` (`lead: fable-5-1` pinned). The active
profile is `default` (migrated adapter; haiku cheap tier; all reviews on astra).

## Decisions agreed with the user

1. Commit the staged efficiency-and-evidence work on `main` and merge `feat/enforced-worker-topology` first.
2. Four cost tiers: `cheap < mid < premium < frontier`.
3. **No haiku anywhere** (profiles, fallback adapter, personas, dynamic-adapter presets, docs).
4. gpt-6-sol supersedes gpt-5.6-sol; the gpt-5.6 family is not used in profiles.
5. OpenAI route order: `openai-codex` first, automatic fallback to metered Bedrock `global.openai.*`
   on a usage/quota error, recorded as `route_degraded`.
6. `premium` becomes the active profile; `default` is retired. New `anthropic` and `openai` profiles; `oss` kept.
7. Triage chooses a **lead size**, never a model. Profiles bind sizes to models through tiers.
8. Lead delegates implementation; per-dispatch spend cap (warn first, enforce later).
9. Scouts on the cheapest model are the default for discovery, including interactive sessions.
10. Worktree isolation per implementer, with guaranteed cleanup.
11. All price rates verified against provider pricing pages.

## Tier and model catalog

List prices (USD per million tokens) from the local catalog; Phase E verifies them.

| Tier | OpenAI | Anthropic | input / output | cache read / write |
|---|---|---|---|---|
| cheap | gpt-6-luna | — (no haiku) | 0.10 / 0.50 | 0.01 / 0.125 |
| mid | gpt-6-sol | sonnet-5 | 2 / 10 | 0.20 / 2.50 |
| premium | gpt-6-sol @ high effort | opus-5-5 | 2 / 10 (sol), 4 / 20 (opus-5-5) | 0.20 / 5 (opus-5-5) |
| frontier | gpt-6-astra | fable-5-1 | 10 / 50 | astra 1 / 12.5, fable 0.25 / 12.5 |

gpt-6-luna and gpt-6-sol exist only on Bedrock (`global.openai.*`); gpt-6-astra exists on both
`openai-codex` and Bedrock, so the codex-first rule and its Bedrock fallback apply to astra (and any
future codex-hosted model).

## Capabilities (method.json)

| Capability | Tier | Change |
|---|---|---|
| scout, worker, implementation_fast | cheap | unchanged |
| lead_small | mid | **new** |
| lead | premium | **was mid** — now the "standard" lead |
| lead_large | frontier | **new** |
| architect, analysis_strong, security_review | premium | unchanged tier |
| technical_lead, implementation_strong, reviews, qa_agent, analysis_mid | mid | unchanged |

`review_after_fix.escalation_by_risk.critical.tier_min` becomes `frontier`; `high` stays `premium`.

## Profiles (`~/.humain-terminal/agent/orchestrator-profiles.json`)

A canonical copy is versioned in the repo at `bridge/orchestrator-profiles.json` and installed by
`install.sh` (backing up any existing file to `orchestrator-profiles.json.bak-<UTC timestamp>`).

| Capability | `premium` (active) | `anthropic` | `openai` | `oss` |
|---|---|---|---|---|
| cheap tier | gpt-6-luna | sonnet-5 @ low | gpt-6-luna | qwen3.8-27b (worker) |
| mid tier | sonnet-5 | sonnet-5 | gpt-6-sol | minimax-m3 |
| premium tier | opus-5-5 | opus-5-5 | gpt-6-sol @ high | glm-5.2 |
| frontier tier | fable-5-1 | fable-5-1 | astra | glm-5.2 |
| technical/integration/migration/performance/api-contract review | gpt-6-sol | sonnet-5 | gpt-6-sol | kimi-k3 |
| security_review | astra | opus-5-5 | gpt-6-sol @ high | glm-5.2 |
| qa_agent | sonnet-5 (mid) | sonnet-5 | gpt-6-sol | humain-m3-research-preview |

`premium` implements on Anthropic and reviews on OpenAI so review is vendor-independent at mid price.
`provider_preference` is `["openai-codex", "amazon-bedrock"]`.

## Phase 0 — Land in-flight work

Commit the staged efficiency-and-evidence changes on `main` after its tests pass; merge
`feat/enforced-worker-topology` (resolving `index.ts` conflicts against the batched record queue);
remove both locked worktrees under `.worktrees/`. Done: clean `main`, green Python and bridge tests,
no worktrees left.

## Phase A — Tiers, profiles, right-sized delegating lead

**Tiers and profiles.** Add `frontier` to `method.json`, `models.ts` (`Tier`, `isTier`, `TIERS`,
tier-bound parsing), `method.py` (`ADAPTER_TIER_NAMES["frontier"] = "expensive"`), and the Python
dynamic adapter (anthropic preset cheapest = `claude-sonnet`, no haiku). Replace `classifyTier`'s
name regexes with a tier lookup derived from the resolved adapter (a model's tier is the highest tier
of any capability bound to it), with a regex fallback that knows `fable|astra → frontier`,
`opus → premium`, `sonnet|sol|glm|minimax → mid`, `luna|mini|nano → cheap`. Remove haiku from
`FALLBACK_ADAPTER` (cheap → `amazon-bedrock/global.openai.gpt-6-luna`) and from persona `model:` lines.

**Lead sizing (new rule `lead_sizing` in method.json).**

```json
"lead_sizing": {
  "sizes": { "small": "lead_small", "standard": "lead", "large": "lead_large" },
  "by_complexity": [
    { "min": 1, "max": 3,  "size": "small" },
    { "min": 4, "max": 6,  "size": "standard" },
    { "min": 7, "max": 10, "size": "large" }
  ],
  "risk_floor": { "low": "small", "medium": "standard", "high": "large", "critical": "large" },
  "escalate_on_verification_failure": true
}
```

Size = max(complexity band, risk floor). `--lead-size small|standard|large` overrides triage and the
risk floor, and is recorded as `lead_size_source: "flag"`. Each failed-verification escalation of a
lead moves one size up (capped at `large`). Every decision emits `lead_sized` with goal-independent
fields: `run_id`, `complexity`, `risk`, `band_size`, `risk_floor_size`, `size`, `capability`,
`model`, `source` (`triage|heuristic|flag|escalation`).

**Lead delegates.** `orchestrator-lead` persona loses `write` and `edit` (keeps `read, bash, grep,
find, ls, subagent`). The lead prompt states implementation must go to `orch-implementation-strong`
/ `orch-implementation-fast` via `subagent`, and names the child models from the adapter. The lead
may still run commands (tests, git inspection). A lead reporting changed files with no nested
implementer is flagged `lead_self_implemented` in its model_call metric.

**Per-dispatch spend cap (new rule `dispatch_spend_cap`).**

```json
"dispatch_spend_cap": {
  "mode": "warn",
  "usd_by_capability": { "lead_small": 1.5, "lead": 4.0, "lead_large": 10.0, "architect": 2.0 },
  "default_usd": 1.0
}
```

When a live dispatch's running `costUsd` first crosses its cap: `warn` notifies the operator and
emits `spend_cap_exceeded` once; `enforce` additionally cancels that dispatch through the existing
cancellation path (exit recorded as `spend_cap`). `off` disables. Phase C flips to `enforce` after
10 capped runs show no verified-pass regression.

**Codex → Bedrock fallback.** When a dispatch on an `openai-codex/*` model fails and its bounded
stderr/final error matches `/usage limit|quota|rate.?limit|credit cap|\b429\b/i`, the bridge resolves
`amazon-bedrock/<same id>` through the alias table, redispatches once, and emits `route_degraded`
with `from_model`, `to_model`, `reason`. No fallback when no Bedrock equivalent exists.

**Tagging.** Every `model_call` / `route_executed` from the bridge carries `policy_id` (profile name
+ short hash of the resolved adapter), `profile`, `lead_size`, `task_class`, `complexity`, `risk`.

Done: lead cost per run and verified-pass rate reported per size on the dashboard; pass rate for the
new routing ≥ the fable-lead baseline (11/17) over ≥ 10 runs.

## Phase B — Scouts first

- Recon worker capability becomes `scout` (cheap tier → luna in `premium`/`openai`).
- Recon threshold lowers from complexity ≥ 5 to ≥ 3 (2 workers at 3–4); investigation keeps its own
  topology but is also scout-first.
- Plan-review gate: when an architect plan exists, a `technical_review` (mid) dispatch checks it
  against the goal and recon evidence before leads start; a `revise` verdict re-runs the architect
  once with the findings.
- Interactive sessions: a `/scout <question>` command dispatches 1–5 scouts and returns a bounded
  evidence packet; SKILL.md and the HT skill note direct interactive exploration to `/scout`.

Done: recon compliance ≥ 90% of eligible runs; bad-plan rework trending down.

## Phase C — Context, cache, and time

- Implementation goes to fresh short-lived child processes with a bounded context packet (goal,
  acceptance, recon evidence, owned paths) instead of a long lead session.
- Cache-write alert: emit `cache_churn` when a dispatch's cache-write tokens exceed 3× its output
  tokens and 500k absolute; show on the dashboard.
- Target call length ≤ 20 min: leads that exceed the target are reported; tasks are split in plans.
- QA/review context caps: explicit file lists and max-input-token guidance in the persona prompts.
- Opus/astra review only for high/critical risk; deterministic checks run first.
- Flip `dispatch_spend_cap.mode` to `enforce` when the Phase A condition holds.

Done: p90 call duration and cache-write cost per run both reduced vs this spec's snapshot.

## Phase D — Resilience and isolation

- Capacity probe: before a run, a zero-cost/low-cost probe per distinct provider in the adapter;
  unavailable providers are substituted by the tier's fallback chain (`fallback_chains` in
  method.json per tier and vendor) and recorded as `route_degraded`.
- Worktree per implementer: children with mutating tools run in `git worktree add` under
  `<repo>/.worktrees/orch-<run>-<task>`; on completion the branch is merged back (fast-forward or
  patch) and the worktree removed. On failure/cancel the diff is saved to
  `runs/<run_id>/<task>.patch` before removal. A startup sweep removes orphaned `orch-*` worktrees
  whose run is terminal. Cleanup never deletes unmerged work without a saved patch.

Done: a capped provider no longer fails a run; zero orphaned `orch-*` worktrees after a run.

## Phase E — Evidence and pricing

- Emit `quality_evidence_score` at verification; close runs left `incomplete` (sweeper marking them
  `abandoned` after 24h of no events); emit the six uninstrumented fields or remove them from the dashboard.
- Coarsen cohort keys for history lookup (task_class × complexity bucket × risk × capability tier) so
  `min_samples` can be reached; 2% exploration on low-risk work.
- Verify every rate in `orchestrator/config.json` against provider pricing pages; record
  `source_url` and `verified_on`; dashboard flags unverified rates.
- Replace the stale `measured_roi` in `policy_overlay.json` with a matched-cohort comparison
  (before/after this program), labeled with sample sizes.

Done: cost, duration, and verification coverage each ≥ 90% of new runs; every rate verified.

## Cross-cutting rules

- Orchestration code requests capabilities, never model names (SKILL.md rule 4).
- `method.json` is the single source of routing rules for Python and the bridge.
- Tests never touch the live state root; use temp roots.
- Each phase runs in its own worktree that is removed when the phase lands.

## Out of scope

Automatic policy promotion, auto-merge/deploy, changing quality gates, deleting historical data,
SQLite as source of truth.

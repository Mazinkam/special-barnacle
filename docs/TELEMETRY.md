# Telemetry Contract

## Model call metric

Recommended fields:

```json
{
  "event": "model_call",
  "run_id": "R-1",
  "task_id": "T-1",
  "task_class": "backend_refactor",
  "complexity": 6,
  "risk": "medium",
  "role": "implementation_fast",
  "capability_class": "implementation_fast",
  "provider": "...",
  "model": "...",
  "model_version": "...",
  "effort": "low",
  "verification_depth": "targeted",
  "input_tokens": 10000,
  "cached_input_tokens": 8000,
  "output_tokens": 1500,
  "cost_usd": 0.04,
  "ci_cost_usd": 0.0,
  "human_cost_usd": 0.0,
  "duration_ms": 12000,
  "result": "pass",
  "retry": 0,
  "policy_id": "...",
  "cost_aggressiveness": 0.7,
  "quality_evidence_score": 0.97
}
```

## Cost provenance

Every call metric carries `cost_source`. The writer stamps it, so "not measured" and
"measured as zero" never collapse into the same `$0.00` on the dashboard.

| Provenance | When | Requirement |
|---|---|---|
| `reported` | harness exposes provider billing | pass `cost_usd` |
| `estimated-from-reported-tokens` | harness exposes usage but not cost | pass `model` plus `input_tokens` / `output_tokens` / `cached_input_tokens`, and configure a rate |
| `unmetered` | harness exposes neither | nothing to pass |

Rules:

- `reported` is an explicit claim. A `cost_usd` with no `cost_source` is recorded as
  estimated, never promoted to reported.
- Rates live in `config.json` under `pricing.models`, keyed by longest substring match so
  `us.anthropic.claude-sonnet-5` resolves to `claude-sonnet-5`. An unlisted model stays
  `unmetered` rather than being priced by guess.
- Rates are a local snapshot and drift. Refresh them from the provider of record and treat
  every derived figure as an estimate.
- Cached input is priced separately: `input_tokens` is treated as inclusive of
  `cached_input_tokens`.

A runtime that cannot report cost should still report tokens; that alone moves it from
`unmetered` into the comparable cost view.

## Ingesting usage from session logs

A harness that cannot call the orchestrator per model call still writes usage to disk. Ingest
it instead of leaving the runtime unmetered.

**This runs automatically; nobody should need to invoke it.** Two mechanisms, both at
`session` granularity so they never double count each other:

| Mechanism | Trigger | Covers |
|---|---|---|
| HT extension hook (`bridge/extensions/orchestrator/ingest.ts`) | `agent_settled` (debounced 3s) and `session_shutdown` | the live HT session, within seconds |
| launchd sweep `com.humain.orchestrator-ingest` (installed by `install.sh`) | every 15 min + at login | anything the hook missed: crashed sessions, HT without the extension, Codex CLI |

Hook failures are logged to `~/.local/state/coding-agent-orchestrator/ingest-hook.log`, sweep
output to `ingest-launchd.log`. Manual invocation remains available for backfills:

    python3 -m orchestrator.cli ingest <session-log>... [--runtime X] [--repository Y] [--dry-run]

With no paths, `$HUMAIN_TERMINAL_SESSION_FILE` is used. For bulk work:

    ingest --discover --since-days 30 --granularity session

`--discover` finds logs in both harness layouts; `--since-days N` bounds them by mtime;
`--limit N` caps the batch. Test-harness and temp-directory sessions (faux models) are excluded
unless `--include-scratch` is passed.

Granularity:

| Mode | Emits | Use for |
|---|---|---|
| `call` (default) | one `model_call` per response | recent work where per-call detail matters |
| `session` | one row per (session, model) with `covers_calls` | historical backfill; 150k usage rows collapse to a few hundred |

`session` rows are **deltas** against what is already recorded for that (runtime, session, model),
so a session that was partly ingested per call, already aggregated, or has since grown contributes
each token exactly once. Aggregate cost equals the sum of the per-call costs it replaces.

Supported logs:

| Runtime | Log | Per-call usage |
|---|---|---|
| `humain-terminal` | `~/.humain-terminal/agent/sessions/<project>/*.jsonl` | assistant `message.usage`; `input` excludes `cacheRead`, so the reader folds it back in |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_usage_record.payload.usage`; the cumulative `turn_token_usage` / `thread_token_usage` fields are ignored |

Guarantees:

- **Idempotent.** Each call carries `call_id = stable_hash(['model_call', runtime, session_id, native_id])`; ids already in `metrics.jsonl` are skipped, so re-ingesting a resumed session adds only its new calls. No side index to drift.
- **Tolerant of live files.** A truncated trailing record is skipped, not fatal.
- **Attribution precedence.** `--repository`, then the repository the log itself recorded, then env attribution. Never the ingesting process's cwd.
- **Honest.** Ingested rows are `estimated-from-reported-tokens`, never `reported`. An unlisted model stays `unmetered` and is reported in `unpriced_models`.

Known limitation: 1-hour cache writes are priced at the standard cache-write rate.

## Waste attribution

Set `waste_reason` when applicable:

- retry
- bad_plan_rework
- duplicate_work
- stale_context
- context_packet_miss
- merge_conflict
- abandoned_branch
- flaky_check
- tool_failure

## Verification telemetry

Use `event=verification_result` with:

- `check_id`
- `command_hash` or normalized command
- revision
- environment fingerprint
- result
- duration
- expected/actual test count when known
- cache hit/miss
- timeout/truncation flags

## Shadow review

Use `event=shadow_review` and record:

- normal reviewer pass/fail
- shadow reviewer pass/fail
- reviewer families/providers
- finding severity
- incremental cost

## Delayed outcomes

Append to `outcomes.jsonl` via `record_outcome` / CLI:

- reopened
- regression
- rollback
- human_correction
- follow_up_fix
- major_rewrite
- incident
- SLO regression

Recent cohorts must remain labeled immature until the relevant 7/30/90 day window passes.

## Known gaps in the current stream

The metric stream carries production data that is not yet fully separated in the dashboard and not yet fully priced. Three tracking issues limit evaluation quality.

**1. Session-log ingests pollute orchestrator headline metrics.** Codex CLI rollouts at `~/.codex/sessions/*/*/*/rollout-*.jsonl` and HUMAIN Terminal session logs at `~/.humain-terminal/agent/sessions/*/*.jsonl` are ingested with `source: "session_ingest"` and `role: "interactive_session"`. On the current stream the bulk is codex (≈6,600 model calls across ≈92 unique sessions from interactive CLI use) with a thin slice of HT (≈150 calls across ≈22 sessions). These are real model spend, but they are not orchestrated work, and the dashboard's headline tiles and `by_role` / `by_runtime` aggregations merge the two streams. As a result "agent calls", "tokens in/out", and "cost by role" sit dominated by interactive session data. Fix is presentation-side — `scripts/skill_vs_baseline.py` filters them out; the dashboard should treat `interactive_session` as its own panel rather than merging into the orchestrator metrics. See `orchestrator/ingest.py` for the ingest path and `docs/QUARANTINE.md` (historical) for a related attribution bug already fixed.

**2. HT-dispatched work frequently carries `cost_usd: 0`.** On the orchestrated side, ≈33% of orchestrated records have zero or missing cost despite having token counts. These are mostly calls dispatched to `humain-terminal` (roles `worker`, `analysis_mid`, `scout`, `lead`) where the HT runtime emits token usage but does not propagate provider cost the way claude-code does. The orchestrator's actual spend on those calls is missing from totals, cost-per-success ratios, and the route-economics table. Either HT needs to report `cost_usd` directly, or the orchestrator's dispatch layer needs a pricing-table fallback keyed by `model` when `cost_usd` is absent.

**3. Counterfactual emissions are absent on real dispatched work.** The skill has per-call counterfactual fields (`recommended_estimated_verified_cost_usd`, `recommended_estimated_quality_evidence`) intended to record what an alternative route would have cost. On the current stream these fields are populated on only three legacy `adaptive_route_decision` records from a single old claude-code run. None of the ≈110 orchestrated work records carry counterfactuals. `shadow_routing_enabled` is `true` but does not appear to be wired to emit estimates at dispatch time, so the only defensible comparison against a flat baseline is retrospective repricing — which is what `scripts/skill_vs_baseline.py` does. Until counterfactual emission is wired, the retrospective baseline remains valid but coarse.


# Dashboard metric integrity

Branch: `fix/dashboard-metric-integrity`

## Problem

The dashboard reports numbers that are arithmetically derived but semantically false. Audit of
`~/.local/state/coding-agent-orchestrator` (410 orchestrated rows, 7,088 ingested rows) found:

1. `p99/p50 tail ratio` renders `4053665000.0×` — `quantile(costs,.99)/max(1e-9,quantile(costs,.5))`
   where `costs` spans all 410 orchestrated rows including 195 rows that carry no `cost_usd`
   (`route_executed` 111, `adaptive_route_decision` 84). p50 is $0.0000, so the card shows
   `p99 × 10⁹`.
2. `Verified tasks 0` / `Verified cost/task —`. Readers gate on `result=='verified'` or
   `event=='task_verified'` in `metrics.jsonl`; the actual signal is `outcome=='verified'` in
   `outcomes.jsonl` (55 of 77 rows, joined by `task_id`). Key and stream both mismatch. Cascades to
   every Verified/Verified-cost column, all 83 `build_route_stats` groups, and history sufficiency.
3. Per-call percentiles mix granularities: 88 of 210 orchestrated `model_call` rows are whole-session
   aggregates (`legacy_source`), $85.99 of the $103.46 total. One claims 33,177,381 input tokens for
   a single "call".
4. Interactive `Calls 7,084` counts rows, not calls: 609 aggregate rows carry `covers_calls`
   summing 85,246, plus 6,479 per-call rows ≈ 91,700 actual calls. 13× understated.
5. Six cards render `0` for fields with no producer anywhere in the codebase (`review_wait_ms`,
   `context_packet*`, `decision_invalidated`, merge conflicts) — indistinguishable from a measured zero.
6. `orchestration_overhead` counts `technical_lead` ($3.98, 8 calls) but not `lead` ($13.07, 63 calls).
7. `waste_cost` charges 100% of a row's cost as waste whenever `retry` is truthy, even when that
   attempt succeeded.
8. `Cost by agent runtime` does not reconcile: `309 calls · 110 metered · 16 unmetered`.
9. 111 `route_executed` rows carry $17.4636 in `executed_cost_usd` — exactly the humain-terminal
   `model_call` total — but are $0 rows to every percentile and waste calculation.
10. No test asserts numeric correctness for any of these summary keys. 79 tests pass.

Root causes: (a) record vocabulary drift across streams and runtimes, (b) no granularity type, so
per-call rows / session aggregates / event rows share one shape, (c) `0` used as the null, (d) metrics
are untested; only rendering is.

## Approach

Introduce one seam — `orchestrator/records.py` — that owns record classification and vocabulary
normalization, then make every consumer read through it. Do not invent producers for uninstrumented
fields; label them `not instrumented` and make that state renderable.

## Tasks

### T1 · `orchestrator/records.py` — classification seam (blocks all others)

New module, single source of truth:

- `Granularity` = `call | session | event`. `classify(row)`: `session` when `covers_calls`,
  `granularity=='session'`, or `legacy_source` is present; `event` when the row is a
  non-cost-bearing orchestration record (`route_executed`, `adaptive_route_decision`,
  `task_verified`, …); else `call`.
- `covered_calls(row) -> int` — `covers_calls` when present, else 1.
- `is_per_call_cost_row(row)` — `call` granularity and cost-bearing. This, not `is_call_row`, is the
  population for percentiles.
- `verification_state(row) -> 'verified'|'failed'|'partial'|None` — normalizes `outcome`, `result`,
  `success`, `kind` across `metrics.jsonl` and `outcomes.jsonl`. Accepts the historical spellings
  found in live data: `verified`, `pass`, `success`, `fail`, `blocked`, `partial`.
- `NO_DATA` sentinel distinct from `None`/`0`, plus `metric(value, samples)` helper returning
  `NO_DATA` when `samples == 0`.
- `INSTRUMENTED_FIELDS` registry declaring which metric fields have a producer in this repo, so the
  dashboard can say `not instrumented` instead of `0`.

Tests: `tests/test_records.py`. Must cover every real row shape from the live stream (fixtures, not
the live file).

### T2 · `orchestrator/economics.py` (depends T1)

- Percentile/attribution helpers operate on `is_per_call_cost_row`.
- `orchestration_overhead`: derive the coordination role set from `method.json` `roles` plus the
  aliases actually present in the stream (`lead`, `technical_lead`, `architect`). Separate
  *coordination* from *verification* — return both, do not pool review into overhead.
- `waste_cost`: a retry attempt is waste only when that attempt did not succeed
  (`verification_state != 'verified'` and `result != 'pass'`). Keep explicit `waste_reason` rows as-is.
- Every ratio returns `NO_DATA` on an empty denominator instead of `0.0`.

Tests: extend `tests/test_economics.py`.

### T3 · `orchestrator/dashboard.py` (depends T1, T2)

- `p50/p90/p99_cost` over `is_per_call_cost_row` only.
- `tail_ratio`: `NO_DATA` when p50 == 0 or fewer than 20 per-call samples. Never divide by a floor.
- Missing-data contract: one path. `NO_DATA` → `—` plus a `not instrumented` pill where the field has
  no producer per `INSTRUMENTED_FIELDS`.
- `interactive_sessions`: report `rows` and `calls` separately, `calls` summing `covered_calls`.
- `by_runtime`: emit `rows` and `call_rows` so `metered + unmetered == call_rows` always holds, and
  render both.
- JS: remove `Number(x||0).toFixed(...)` from `tail_ratio`, `fanout_rework`, `review_wait_p90_s`; route
  every value through one formatter that can render `—`/`not instrumented`.
- Surface `route_executed.executed_cost_usd` as executed spend rather than letting those rows read as $0.
- Show that estimated spend rests on unverified rate-table entries, naming the dominant rate model.

Tests: new `tests/test_dashboard_metrics.py` asserting numeric correctness for every summary key,
including a regression test that a stream whose p50 is $0 yields `NO_DATA`, not a billion-fold ratio.

### T4 · `orchestrator/history.py`, `orchestrator/outcomes.py` (depends T1)

- `build_route_stats` resolves verification through `records.verification_state`, joining
  `outcomes.jsonl` by `task_id` so `verified_cost_usd` is populated from the signal that exists.
- Exclude `capability == 'unknown'` groups from recommendations, or label them so they cannot drive routing.
- `outcome_summary`: parse the JSON-in-`note` payload that live rows carry, so `bad_outcome` can
  actually become true; keep typed fields authoritative when present.
- `retry_rate` returns `NO_DATA` when no row carries `retry`, rather than a fabricated 0.0.

Tests: extend `tests/test_history_scheduler.py`.

### T5 · `orchestrator/ingest.py`, `orchestrator/pricing.py` (depends T1)

- Dedupe key includes `ingest_source` alongside `(runtime, session_id, model)`, so a session
  re-ingested at a different granularity cannot double count when `session_id` derivation drifts.
  One live source already has both shapes (2 aggregate rows $9.18 + 113 per-call rows $11.32).
- Stamp `granularity` explicitly on every emitted row.
- `pricing.py`: carry rate provenance (`source`, `verified_on`) through to the record so the dashboard
  can mark estimates derived from unverified rates. Do not change any rate value.
- `scripts/stamp_granularity.py`: opt-in, backup-first migration stamping `granularity: session` on
  existing `legacy_source`/`covers_calls` rows, following the `.pre-cleanup-*` convention.

Tests: new `tests/test_ingest_dedupe.py`.

### T6 · `bridge/extensions/orchestrator/index.ts`

- Do **not** emit `task_verified` / `task_failed` from dispatch exit codes. A dispatch `exitCode === 0`
  is only DISPATCH-strength evidence; attested verification requires a real gate verdict that can be
  attributed to the underlying task. The bridge cannot currently map one QA pass over a union of
  files back to individual worker tasks, so the honest behavior is to keep `model_call.result` and
  `route_executed.executed_passes` as dispatch signals and emit no attested per-task record.
- Synthetic run-level outcomes (`${runId}-qa`, `run-complete`, `run-failed`) must carry
  `verification_scope: 'run'`; task-level readers ignore that marker for `verified_tasks` while
  outcome summaries can still display the run-level result.
- `completeRun` must not write a `run-complete` outcome of `verified` when `verification_passed` is
  false; otherwise failed verification is converted into an attested success in `outcomes.jsonl`.
- Populate `review_wait_ms` where the dispatch queue already knows it; if it cannot, leave the field
  absent so the dashboard reports `not instrumented` honestly.

Tests: extend the bridge Bun test suite to assert the full emitted dispatch record set contains no
attested verdict, and that run completion mirrors the final verification verdict.

## Non-goals

- Changing any pricing rate. The `gpt-6-astra` entry ($10/$50 per Mtok) drives 6,388 of 7,494 rows and
  the $8,435 interactive figure; it needs provider confirmation, not a guess. Flag provenance only.
- Inventing producers for `context_packet*`, `decision_invalidated`, or `shadow_review`.

## Verification

- `python3 -m pytest -q` — 79 baseline tests keep passing, new metric tests added.
- Bridge: vitest suite for `bridge/extensions/orchestrator`.
- `python3 scripts/regenerate_dashboard.py` against the live state dir, then re-read the summary and
  confirm: no metric exceeds its plausible range, `tail_ratio` is a real ratio or `—`, verified tasks
  is non-zero, interactive calls ≈ 91,700.

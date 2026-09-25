# Phase 2 — efficiency controls and model canaries

**Audit date:** 2026-09-25  
**Status:** Implemented as independently gated controls and report-only comparison; not activated.

## 1. Scope and status

This documents Phase 2 of [`../goals/2026-09-25-all-in-one.md`](../goals/2026-09-25-all-in-one.md). All efficiency controls default OFF; model-canary candidates have **0% exposure** and activation is unavailable (see §5). No paid or live model experiments were run.

No primary model assignments, review requirements, verification depth, retry-review floors, or spend-cap actions were changed. Controls are independent; enabling one does not implicitly enable another. This document reports current configuration and measurement, not an approval to activate anything.

## 2. Baseline measurement

Counts below come from the read-only copy `/tmp/orch-phase2-snapshot-20260925T194942` of `~/.local/state/coding-agent-orchestrator/runs/`, captured 2026-09-25 at 19:49 +03. Counts are **top-level `toolcall_end` events belonging to each dispatch**, excluding nested child events.

| Dispatches | bash | read | ls | grep | find | subagent | edit | write | other observations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Architects (45) | 162 | 73 | 24 | 8 | 6 | 0 | 0 | 0 | `sleep` bash: 0 |
| Leads (102 dispatch logs) | 2140 | 149 | 4 | 15 | — | 317 | 41 | 5 | bash with `sleep <n>`: 67; `orchestrator_status`: 0 |

Architect dispatch ran before recon in all 16/16 runs that had both logs. Another 29 architect runs had no recon log, so they are not part of that ordering comparison.

Direct lead edit/write calls appear only in runs dated 2026-09-23 11:44 through 2026-09-24 11:20. Commit `b754f25` (2026-09-24 12:03, **“delegation-only lead”**) removed `write` and `edit` from `orchestrator-lead.md`'s `tools:`. The bridge passes persona tools through `--tools`; tests now assert lead and architect dispatches exclude edit/write. No direct edits were observed after that change.

**Measurement pitfall:** an earlier count included nested child events and therefore overstated direct lead edits. Producing code revision for each run is not recorded in these logs (known attribution gap); the date boundary alone does not prove which code revision produced a run.

## 3. Switch table

Each named efficiency control also accepts `HUMAIN_ORCHESTRATOR_EFFICIENCY_<NAME>` (uppercase name). Boolean overrides accept `on/true/1` or `off/false/0`; invalid values leave the config value in effect and report a problem. Config defaults are shown below.

| Name | Default | Behaviour when enabled | Safety / fallback | Tests |
|---|---|---|---|---|
| `recon_before_architect` | `false` | Gather existing recon evidence before architect dispatch, where applicable. | Does not redefine recon eligibility; unavailable evidence must not be fabricated. | `efficiency-flags.test.ts`; dispatch-order tests in `index.test.ts`. |
| `delegation_guidance` | `false`; architect own-tool budget 12, lead 25; targeted reads allowed 8 | Adds bounded own-tool/delegation guidance. | Guidance only; does not change model, verification, or tool behavior. | `efficiency-flags.test.ts`, bridge prompt/dispatch tests. |
| `event_waiting_guidance` | `false` | Guides event-oriented waiting rather than unnecessary polling. | Polling remains counted, not rewritten or blocked by telemetry. | `dispatch-telemetry.test.ts` and bridge tests. |
| `scoped_leads` | `false`; max handoff chars 12,000 | One lead proceeds plan → integrate → report using bounded, validated structured handoffs. | Identity/schema/size validation; fixed-code diagnostics; freshness requires known git `HEAD` plus unchanged bridge-observed dirty-tree snapshot. Any invalid, stale, unknown or changed state falls back to a long-lived lead. | `lead-handoff.test.ts` and scoped-lead tests in `index.test.ts`. |
| `file_ownership` | `off` | `report` emits overlap/undeclared evidence without changing waves. `serialize` splits conflicting parallel waves. | Ownership is parsed from `(owns: path, ...)` on Lead lines. Undeclared/unsafe ownership is conservatively serialized; unsafe paths cannot be considered disjoint. Emits `lead_ownership` and post-run `lead_edit_conflict` evidence. `off` leaves scheduling untouched. | `file-ownership.test.ts`, lead-plan and bridge tests. |

`file_ownership` uses `HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP=off|report|serialize` rather than a boolean. Handoff data is treated as untrusted; diagnostics do not echo model-supplied content. Overlap checks conservatively handle absolute, escaping, empty, NUL-containing, and glob paths.

`scoped_leads`: each of a lead's plan/integrate/report phases is dispatched as its own fresh subprocess (a new HT process with no shared in-memory state with the phase before it); the ONLY continuity between phases is the validated, size-bounded `## Handoff` block carried forward explicitly — nothing else about a prior phase's context, tool state, or reasoning survives to the next one. A scoped lead's final result carries the de-duplicated union of `filesChanged` across every phase it ran (plan, integrate, report, and any fallback dispatch), not just its last phase, because a report phase legitimately says "Files Changed: None" for itself while an earlier phase in the same chain made the real edits; QA scope and the run's external-change classification are computed from that union so those files are never silently dropped.

## 4. Telemetry

Per-dispatch telemetry fields attached to `model_call` rows are: `turns`, `peak_context_tokens`, `context_token_semantics`, `own_tool_calls`, `own_tool_mix`, `delegated_subagent_calls`, `observable_poll_calls`, and optional `dispatch_phase`. Context semantics are explicitly `provider_total_tokens_per_message`; peak is the maximum observed provider-reported per-message total, or `null` when absent. Observable polls count direct `orchestrator_status` calls and bash commands matching a literal `sleep <duration>`; they are counted, not rewritten.

Run summaries distinguish `run_wall_ms` (whole-run elapsed time) from `summed_dispatch_ms` (sum of billed dispatch durations). They measure different things and must not be conflated.

## 5. Model canaries

| Candidate | Eligible capabilities | Configured exposure |
|---|---|---:|
| `premium-gpt-5.6-sol` (`gpt-5.6-sol`) | Premium-tier capabilities, excluding `security_review` | 0% |
| `impl-gpt-6-sol` (`gpt-6-sol`) | `implementation_fast`, `implementation_strong` | 0% |

`CANARY_QUALIFICATION_AVAILABLE=false`: tool/context/reasoning catalog qualification exists only on unmerged `feat/model-failover`. Runtime parsing deliberately ignores config `activation_available=true` while qualification is unavailable. Thus activation is **UNAVAILABLE**, not merely inactive; candidate routing cannot occur. Explicit user `--model` / flag overrides are marked `ineligible` and do not enter an experiment arm. Candidate alias resolution, baseline-tier checks, and exclusion rules are still applied.

Assignment is deterministic per run and candidate: SHA-256 of `canary:${runId}:${candidateId}`, first 16 hex characters converted to a unit interval, matching Python `adaptive._unit_interval`; selection compares that value with percentage / 100. The recorded flat fields are `canary_cohort`, `canary_candidate_id`, `canary_activation`, `canary_reason`, `canary_policy_version`, `baseline_model`, `candidate_model`, `requested_model`, `executed_model`, `canary_attempt_id`, and `canary_deviation`.

**Limitation:** the bridge assigns cohorts only to dispatches it makes itself. Implementers dispatched inside a lead through HT's `subagent` tool are not assigned individually. Until nested dispatch routing supports assignment, implementer canaries cover only bridge-dispatched implementer tasks (nested spend may be attributed to its eligible parent's cohort for comparison; that is not nested assignment).

## 6. Comparison method

`orchestrator/model_comparison.py:compare_canary_cohorts` is offline and report-only. It deduplicates through existing economics/records utilities, groups by candidate and capability, then compares baseline and candidate within strata: task class, risk, complexity bucket, repo, and canary policy version. Rows with any non-empty `experiment_flags` are excluded as confounded by default; `allow_confounded=True` is an explicit analysis override, not a recommended default.

Nested detail rows inherit cohort and stratum from the parent dispatch identified by `(run_id, parent_task_id)`, while retaining their own cost and role. Rows with no matching parent are counted as unattributed, never guessed into an arm. Reported and estimated costs stay distinct; unknown-cost rows are counted, and cost completeness is required for sufficient samples and cost-per-verified-outcome. Cost per verified outcome uses known arm cost across attempts (including failed attempts) divided by attested verified task outcomes; unknown cost prevents that metric. Verification uses `records.resolve_task_verification`; delayed bad signals and immature/missing outcomes are surfaced. Each stratum requires at least 30 attempts per arm by default plus complete cost. The report always sets `claim_supported: false`; sufficient samples are not a savings or equivalence claim.

Run on a **copy** of state, never live state. Example from repository root, adapting the copy path as needed:

```sh
cp -R ~/.local/state/coding-agent-orchestrator /tmp/orch-canary-analysis-copy
python - <<'PY'
import json
from pathlib import Path
from orchestrator.model_comparison import compare_canary_cohorts, format_comparison
root = Path('/tmp/orch-canary-analysis-copy')
# Load the copy's model_call rows and outcome rows using the existing record
# storage format; pass those dictionaries to compare_canary_cohorts.
# print(format_comparison(compare_canary_cohorts(rows, outcomes)))
PY
```

The storage loader is intentionally not guessed in this example: inspect the copied state format and use the repository's existing records loader. The function accepts iterable row dictionaries and outcome dictionaries; it does not read state itself.

## 7. Staged activation plan

Experiments are separate and sequential. **Never combine model and scoped-lead experiments** in one comparison. Any paid/live run requires explicit approval and a defined budget; none is implied here.

1. Establish prerequisites: canary activation requires merging supported catalog qualification (tool/context/reasoning requirements), tests, and confirmation that candidate identifiers resolve. Efficiency experiments require baseline telemetry and a scoped, reversible hypothesis.
2. Select one control and one bounded task population. Keep all other controls off. Record config, code revision, task class, risk, repo, expected sample/budget, verification gates, fallback threshold, and rollback owner before any live run.
3. Start with observation/report-only where available (`file_ownership=report`); for behavior-changing controls, obtain explicit approval before setting a single switch. For a canary only after qualification is available, start at a small approved non-zero percentage, with explicit overrides excluded and all assignment/deviation fields checked.
4. Review each run's verification evidence, cost completeness, fallback/deviation rate, telemetry coverage, delayed outcomes, and run-wall versus dispatch timing. Do not infer success from tool-count reduction alone.
5. Stop on any verification regression, spend-cap hit, fallback rate above the predeclared threshold, material telemetry gap, unsafe/stale handoff, unexpected model/provider substitution, or budget limit. Do not progress to another stage until the isolated experiment is reviewed.

Rollback is immediate: unset the relevant environment override or set its config `enabled` false; set ownership mode to `off`; set canary enabled false and percentage to zero. Existing records remain observational history; no data migration is needed.

## 8. Known gaps and open items

- Per-run producing code revision is absent from baseline dispatch logs; improve revision provenance before causal claims.
- Canary routing qualification is blocked on unmerged model-failover support; config `activation_available` cannot bypass this guard.
- Lead-internal HT subagent implementers do not receive independent cohorts.
- Historical/direct-tool baseline counts are event-log observations, not proof of quality or user impact; nested events must remain excluded when measuring own work.
- The comparison is descriptive and intentionally makes no claims; small or immature cohorts, unknown costs, and unattributed nested rows constrain interpretation.
- No paid/live experiments were performed. Activation requires separate approval, budget, predeclared stopping thresholds, and verified telemetry.

# Model assignment backups and provider failover: design

Status: approved in brainstorming (2026-09-25); spec awaiting review.
Scope: the `/orchestrate` bridge (`bridge/extensions/orchestrator/`), `method.json`, and the profile schema.
Sequencing: implement **after** part B4 of `docs/architecture-review.md` lands (the bridge split). Only the
pure `core/` modules in §6 may be built earlier, since they don't touch `index.ts`.

## 1. Problem

Runs fail because a provider fails, not because the code or the tests fail. Every recent failure had
the same shape: a lead on Bedrock Anthropic dies from a provider or stream error, and nothing takes
over.

| Run | Lead model | What happened |
|---|---|---|
| `ht-orch-1790285243558-5mbi7r` | fable-5-1 | `Service unavailable` (503), then after the harness retry `The pending stream has been canceled`. The lead died after 2 turns, 0 tool calls, $0. Dependent leads were blocked. |
| `ht-orch-1790286025029-hwfp8o` | fable-5-1 | Lead 2: `Bedrock stream ended without a stop reason`, then an inactivity timeout, leaving unverified partial work. |
| `ht-orch-1790283610002-wbouqc` | fable-5-1 | `Service unavailable` ×3 and `fetch failed`. Lead 2 hit the inactivity timeout after $30.92 of nested work. |
| `ht-orch-1790271548655-mho3yr` | fable-5-1 | `Service unavailable` ×4 right after a finished batch of nested work ($3.32). |

Today's behaviour:
- Each profile maps a capability to one model: its own binding, or its tier's binding. There is no
  second choice.
- The only fallback is `provider-fallback.ts`: `openai-codex/*` moves to its Bedrock twin, **only on
  quota errors**, and only once (`index.ts` `dispatchParallel`).
- The harness inside the child retries the same model 3 times with a 2, 4 and 8 s backoff. That is
  far shorter than the outages above, which recurred for about 5.5 hours.
- None of the four error signatures above is recognised as a transient provider failure.

## 2. Goals and non-goals

**Goals**
1. A provider outage doesn't fail a run. The run continues on another model, which may be from any
   vendor, including OSS models on humain-node.
2. **Capability is never reduced.** A backup is at the same tier or higher, and meets the role's
   measurable minimums.
3. Work already done isn't thrown away. The next attempt continues from a handoff summary.
4. Every switch is visible: board, events, final summary, and cost per attempt.

**Non-goals**
- Failover inside HUMAIN Terminal's provider layer, or in interactive sessions (possible later).
- Enforcing nested-worker backups inside the `subagent` tool; that would be a change to HT itself.
- Skipping QA when no lead succeeded. That is item C4 in `docs/architecture-review.md`.
- Choosing models automatically by quality score. Tier equivalence is asserted by the user in the
  profile.

## 3. Decisions (from brainstorming)

| # | Question | Decision |
|---|---|---|
| D1 | What matters most when the primary fails | Finish the run on any vendor, including OSS, but never with reduced capability. |
| D2 | Who decides equivalence | Both: backup lists written by the user, each candidate checked at run time against the role's minimums. If nothing qualifies, wait and retry; never downgrade. |
| D3 | When to switch | Depends on work done: no real work → switch immediately; real work → retry the same model once, then switch. |
| D4 | What the next attempt receives | The original prompt plus a handoff summary built from the dead attempt's event log. |
| D5 | Nested workers | Put backups in the lead's model table; require `onFailure.retryWith`; check afterwards. |
| D6 | Where the logic lives | A routing module in the bridge (not the Python planner, not HT's provider layer). |
| D7 | Models without effort control (all of humain-node) | Allowed for every role, planning and review included, if they meet the context and output minimums. The dropped effort is reported. |

## 4. Configuration

### 4.1 Backup lists (`orchestrator-profiles.json`, per profile)

A new optional `backups` object inside a `ProfileSpec`. Keys are tier names (`cheap`, `mid`,
`premium`, `frontier`) or capability names. Values are ordered lists of model specs, using the same
syntax as `tiers`/`capabilities`: a bare alias, or `provider/id`. Listing a model under a tier is the
user's statement that the model is at that tier.

```jsonc
"premium": {
  "tiers":        { "cheap": "gpt-6-luna", "mid": "sonnet-5", "premium": "opus-5-5", "frontier": "fable-5-1" },
  "capabilities": { "lead_large": "opus-5-5", "security_review": "astra" },
  "backups": {
    "frontier": ["amazon-bedrock/eu.anthropic.claude-fable-5", "astra", "humain-node/claude-fable-5", "humain-node/glm-5.2"],
    "premium":  ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "astra", "humain-node/claude-opus-5"],
    "mid":      ["amazon-bedrock/eu.anthropic.claude-sonnet-5", "gpt-6-sol", "humain-node/claude-sonnet-5", "humain-node/kimi-k3"],
    "cheap":    ["amazon-bedrock/global.openai.gpt-6-luna", "humain-node/qwen3.8-27b"],
    "security_review": ["amazon-bedrock/global.openai.gpt-6-astra", "amazon-bedrock/eu.anthropic.claude-opus-5-5"]
  }
}
```

**Parsing** (`models.ts` `parseProfileSpec`):
- A key that is neither a tier nor a known capability is reported as a problem.
- A value that isn't a list of strings is reported as a problem.
- A spec that doesn't resolve is a warning at run start and is skipped. It is not fatal, unlike an
  unresolvable primary binding.

### 4.2 Candidate order for a capability

1. The primary model: the resolved binding from today's order (flags > profile capabilities >
   profile tiers > dynamic > fallback).
2. `backups[<capability>]` if it exists; otherwise `backups[<tier of the capability>]`.
3. For each **higher** tier, in ascending order: that tier's primary, then `backups[<tier>]`.
   Upgrading is allowed; lower tiers are never added.
4. Duplicates are removed: a candidate is dropped if its canonical `provider/id` is already in the
   list. (At run time, candidates on the same provider and region as a failed attempt are moved
   to the end of the list rather than skipped; see §5.3.)

### 4.3 Minimum requirements per role (`method.json` → `rules.model_requirements`)

```jsonc
"model_requirements": {
  "default": { "min_context": 128000, "min_output": 16000, "effort_control": false },
  "groups": {
    "planning": { "capabilities": ["architect", "lead_small", "lead", "lead_large"],
                  "min_context": 256000, "min_output": 64000 },
    "review":   { "capabilities": ["technical_review", "integration_review", "migration_review",
                                   "performance_review", "api_contract_review", "security_review", "qa_agent"],
                  "min_context": 200000, "min_output": 32000 },
    "worker":   { "capabilities": ["scout", "worker", "implementation_fast", "implementation_strong",
                                   "analysis_mid", "analysis_strong", "technical_lead"],
                  "min_context": 128000, "min_output": 32000 }
  }
}
```

- Each capability belongs to at most one group. Capabilities outside every group use `default`.
  `method.py` `_validate` checks: the groups cover known capabilities, no capability is in two
  groups, and all numbers are positive integers.
- `effort_control` (default `false`, per D7) is kept in the schema so a group can require it later.
  When a candidate without effort control runs a dispatch whose effort is not the default, the board
  and log show `effort dropped: <level> → n/a`, and the `route_degraded` event records
  `effort_dropped: true`.
- The planning minimum is 256K rather than 1M because, per D4, a backup starts a **fresh** session
  with a bounded handoff summary. It never has to continue a 1M-token conversation.

### 4.4 Model facts

- The source is HT's model registry, `ctx.modelRegistry.getAvailable()`, which provides
  `contextWindow`, `maxTokens` and `reasoning`. Today `availableModels()` (`index.ts:612`) keeps
  only `provider`/`id`/`name`; it will keep these three fields too.
- An optional override file, `~/.humain-terminal/agent/orchestrator-model-facts.json`, handles facts
  the registry gets wrong:
  `{ "version": 1, "models": { "<provider>/<id>": { "context": n, "max_output": n, "effort_control": bool } } }`.
  An override takes precedence over the registry.
- `effort_control` is the registry's `reasoning`. humain-node reports `false` for every model
  (`node-provider.ts:225`).
- **If a fact is missing, the candidate doesn't qualify.** It is excluded with the reason
  `unknown <fact>`.

### 4.5 Checks at run start

For every capability the plan will use, the run log and the `/orchestrator-models show` output list
the candidates in order, with ✓ or ✗ and the exclusion reason:

```
lead_large: opus-5-5 ✓ · eu opus-5-5 ✓ · astra ✓ · humain-node/claude-opus-5 ✓ (effort n/a) · humain-node/minimax-m3 ✗ min_output 16384 < 64000
```

A capability with **no qualifying backup** gets the warning
`<capability>: no qualifying backup, so a provider outage will fail this dispatch`. This is not
fatal.

## 5. Runtime behaviour

### 5.1 Classifying failures (`classifyFailure`)

The input is a finished attempt: exit code, stderr, the last assistant error message, the stop
reason, whether it hit the inactivity timeout, and whether a tool was running at the time.

| Class | Rule (first match wins) |
|---|---|
| `cancelled` | The run was cancelled by the user (`RunCancellation`). |
| `quota` | `QUOTA_ERROR_RE` (the current `provider-fallback.ts`) matches stderr or the error message. |
| `transient` | Stderr or the error message matches `/service unavailable\|\b5\d\d\b\|overloaded\|pending stream has been canceled\|stream ended without a stop reason\|fetch failed\|ECONNRESET\|ETIMEDOUT\|socket hang up\|throttl/i`. |
| `stall` | Inactivity timeout, with **no tool running** at the time (the child was waiting for model output). |
| `task` | Anything else that failed: inactivity while a tool is running, a lead's `STATUS: failed`/`blocked`, spend-cap kills, verification failures, other non-zero exits. |

The classifier only reads stderr and the harness's error fields, never the model's own text, the
same rule `dispatchParallel` follows today. `stall` is handled like `transient`. `task` and
`cancelled` never switch models: `task` goes to the existing escalation path, and `cancelled` stops.

### 5.2 Real-work test (`hadRealWork`)

An attempt did real work if **any** of these is true:
- files changed since the attempt started (the existing git snapshot diff);
- at least one nested worker finished (a `subagent` tool result in `events.jsonl`);
- at least 3 tool calls completed.

### 5.3 Retry loop (`nextStep` + `dispatchWithFailover`)

State per dispatch: the candidate list, the current index, attempts so far, switches so far, whether
the same model has already been retried once, and the start time of waiting.

1. Run the attempt on the current candidate.
2. If it succeeds, return. If the class is `task` or `cancelled`, return the failure unchanged.
3. On `transient`, `quota` or `stall`, mark the candidate's provider and model **unhealthy** in the
   run's `ModelHealth` for 10 minutes.
4. Decide the next step:
   - `quota` → **switch**.
   - `transient`/`stall` and no real work → **switch**.
   - `transient`/`stall`, real work, and the same model not yet retried → **retry the same model**
     after 60 s, with the handoff summary.
   - Otherwise → **switch**.
5. **Switch** means moving to the next healthy candidate. Candidates on the same provider and region
   as the failed one (for example, any other `amazon-bedrock/global.*` model after a
   `global.anthropic.*` 503) are moved to the end of the remaining list, not skipped: a whole region
   is likely degraded, but it isn't certain. Every switch after an attempt that did real work
   includes the handoff summary.
6. **When no candidate is left** (all used or unhealthy): **wait** 60 s, 120 s, then 240 s, and each
   time go through the list again from the top, skipping candidates still unhealthy. Once the total
   wait passes 15 minutes, **give up** with the error
   `all candidates unavailable: <model: class reason>…`.
7. Limits: at most 4 switches per dispatch. The dispatch's spend cap applies to the **total** across
   all attempts. A spend-cap kill is classified `task`.

**Defaults, configurable** through `rules.model_failover` in `method.json`:
`unhealthy_ms: 600000`, `same_model_retry_delay_ms: 60000`, `wait_schedule_ms: [60000, 120000, 240000]`,
`max_wait_ms: 900000`, `max_switches: 4`, `real_work_min_tool_calls: 3`.

**Scope:** every dispatch the bridge starts goes through `dispatchWithFailover`: triage, architect,
recon, leads, QA and escalation retries. Waves and dependencies don't change; a lead only "fails"
for dependency purposes after the loop gives up.

`ModelHealth` is **per run**, shared across parallel dispatches and waves, and not persisted between
runs.

### 5.4 Handoff summary (`buildHandoff`)

This is appended to the **original** task prompt for an attempt after one that did real work:

```
## Resume from a failed attempt (attempt <n> of <taskId>; previous model <model> failed: <class> <reason>)
Work already on disk: verify it, don't redo it.
- Files changed since this dispatch started: <list; at most 100 entries, then "+N more">
- Finished nested workers: <id ✓ first line of result>…   Unfinished: <ids>
- Last plan/report text from the previous attempt (bounded): <last assistant text, at most 4000 characters>
Continue from here. Re-run the verification before claiming success.
```

- The summary is built only from the dead attempt's `events.jsonl` and the git snapshot.
- Paths are redacted with the existing redaction helper.
- The whole section is capped at 12,000 characters.

### 5.5 Visibility

- **Board row:** `lead-0 ↻2 on astra (fable-5-1: transient 503)`.
- **Events:** `route_degraded { task_id, from_model, to_model, class, reason, attempt, real_work, effort_dropped, handoff }`
  for each switch; `model_unhealthy { model, class, until }`; `failover_exhausted { task_id, attempts[] }`.
- **Metrics:** one model-call record **per attempt**, each on its own model, so cost is attributed
  correctly. The existing `superseded_by_fallback: true` flag marks the attempts that were replaced.
- **Final summary:** a new line
  `failovers: <n> — fable-5-1→eu fable-5 (transient 503), eu fable-5→astra (transient stream canceled)`,
  shown only when n > 0.
- **Lead report:** each attempt's report text is kept, labelled by attempt.

## 6. Nested workers (D5)

Leads start workers through HT's `subagent` tool, which supports
`onFailure: { maxAttempts ≤ 3, retryWith: { model, thinking } }` on `tasks[]` entries. Its limits
(`subagent.ts:1257-1303`): **one** backup model, an immediate retry with no delay, retries on any
failure whatever the cause, and parallel (`tasks`) mode only.

- `modelTableForLead` gets the resolved candidates and the run's `ModelHealth`. Each row shows the
  capability's current model (the first healthy candidate) and a **backup** (the next qualifying
  healthy candidate, preferably on a different provider).
- The lead prompt contract (in `LEAD_DELEGATION_RULE` and `bridge/agents/orchestrator-lead.md`)
  requires every `subagent` dispatch to use `tasks: [...]`, even for one worker, and to set
  `onFailure: { maxAttempts: 2, retryWith: { model: <backup from table> } }`.
- **Check afterwards:** `auditNestedFailover(leadEvents)` counts `subagent` tool calls, and the tasks
  in them that lack `onFailure.retryWith`. It records `nested_failover_missing { task_id, missing, total }`
  and adds `⚠ <missing>/<total> nested dispatches had no backup` to the final summary. It only
  reports; nothing is blocked.

Accepted limits: nested workers get one backup, an immediate retry, no handoff summary, and no shared
`ModelHealth`.

## 7. Modules and interfaces

Placed according to the part-B4 bridge layout. Pure modules have no I/O and read no globals.

| Module | Exports | Depends on |
|---|---|---|
| `core/model-router.ts` | `resolveCandidates(capability, resolution, catalog, requirements) → Candidate[]` (each has `model`, `qualified`, `reasons[]`, `effortControl`); `classifyFailure(attempt) → FailureClass`; `hadRealWork(attempt, filesChanged, minToolCalls) → boolean`; `nextStep(state, config, now) → Step` | `models.ts`, `method.json` types |
| `core/model-catalog.ts` | `buildCatalog(registryModels, overrides) → Catalog`; `parseModelFacts(raw) → {facts, problems}` | none |
| `core/handoff.ts` | `buildHandoff(input) → string` | redaction helper |
| `core/nested-audit.ts` | `auditNestedFailover(events) → {missing, total}` | none |
| `run/model-health.ts` | `class ModelHealth { constructor(clock); markUnhealthy(model, cls, ms); isHealthy(model); snapshot() }` | none |
| `dispatch/failover.ts` | `dispatchWithFailover(task, candidates, deps) → Promise<FailoverResult>`, where `deps = { runAttempt, sleep, now, health, recordEvent, changedFilesSince, readEvents, config }` | the modules above |
| `models.ts` | `ProfileSpec.backups`; `parseProfileSpec` validates it | — |
| `method.json` / `method.py` | `rules.model_requirements`, `rules.model_failover`; `_validate` covers both | — |

**Changes to existing code**
- `dispatchParallel` wraps every task in `dispatchWithFailover`.
- The quota-only codex→Bedrock branch and `bedrockFallbackFor` are removed. The Bedrock twin becomes
  an ordinary backup candidate, and `QUOTA_ERROR_RE` moves into `classifyFailure`.
- `leadPrompt`/`modelTableForLead` receive the candidates and the health state.
- `/orchestrator-models show` prints the candidate order; `/orchestrator-models check` also probes
  the backups.
- The shipped `bridge/orchestrator-profiles.json` gets default `backups` for `premium`, `anthropic`,
  `openai` and `oss`.

**Compatibility:** a profile without `backups` gets a candidate list containing only the primary
model (plus higher tiers, per §4.2). The classifier, `ModelHealth`, and the wait-and-retry loop still
apply, which is already an improvement on today.

## 8. Testing

No test calls a live provider.

- **`classifyFailure`:** table tests using the **exact stderr strings from the four runs in §1** as
  test data. Also: quota vs transient precedence; inactivity with and without a running tool; the
  model's own text containing "503" is ignored.
- **`resolveCandidates`:** order (capability list before tier list); higher tiers added and lower
  tiers never; duplicates removed; exclusions for unmet minimums and unknown facts; `effort n/a`
  marking.
- **`nextStep` with a fake clock:** every branch of §5.3 (quota, transient with and without real
  work, the single same-model retry, the wait schedule, the 15-minute limit, the 4-switch limit,
  skipping unhealthy candidates, and moving ones on the same provider and region to the end).
- **`dispatchWithFailover` with a fake `runAttempt`:**
  - 503 then success on a backup;
  - real work then a same-model retry that carries the handoff summary;
  - all candidates failing, then waiting, then giving up with the error listing every attempt;
  - two parallel leads sharing `ModelHealth` (the second one skips the dead model without trying it);
  - the spend cap applied to the total across attempts;
  - a `task` failure passed through unchanged.
- **`buildHandoff`** from a trimmed real `events.jsonl` test fixture (the `wbouqc` lead-2 shape):
  bounds, redaction, finished vs unfinished workers.
- **`auditNestedFailover`:** tasks with, without, and partly with `onFailure`.
- **Parsing:** `backups` in the profiles file; `model_requirements`/`model_failover` in `method.py`
  `_validate` and the matching TS parity test.

## 9. Open risks

- **Quality of OSS backups for planning roles.** D7 allows `glm-5.2`/`kimi-k3`/humain-node Claude for
  leads and reviews, without effort control. The tier assignment is the user's judgement, so watch
  the `route_degraded` outcomes and adjust the lists.
- **Real outages vs. whole-region problems.** If `global.*` and `eu.*` Bedrock fail together, the
  same-provider-and-region skip doesn't help across regions; the backups on other providers carry
  the load.
- **Nested workers stay weaker** (§6) until the `subagent` tool supports a list of backups and
  classified retries.

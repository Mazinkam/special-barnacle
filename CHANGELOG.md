## Unreleased

### bridge (HT extension)

- Model overrides are real: `--cheap/--mid/--premium/--model <cap>=P/M` flags and
  `~/.humain-terminal/agent/orchestrator-adapter.json` (`tiers` / `capabilities`)
  now bind models, canonicalized against HT's model registry; an unresolvable
  override aborts before any dispatch. New `/orchestrator-models` command.
- Leads now receive the resolved agent→model table and must pass `model:` on
  every `subagent` call (HT's subagent tool ignores persona frontmatter, so
  workers were silently running on the lead's model).
- Live progress: per-dispatch widget + footer status (model, elapsed, turns,
  tool calls, last tool, cost), phase notifications between stages.
- Per-run logs under `<STATE_ROOT>/runs/<runId>/` (run.log, prompts, raw child
  event streams, stderr, lead report); `dispatch_started/finished` and
  `dispatch_plan_confirmed` EventStore events; crashes record `run-failed`.
- Files-changed now comes from `git status` before/after the lead phase instead
  of scraping the lead's prose, so mentioned-but-untouched files no longer
  trigger QA.
- Orchestrating capabilities (lead/architect/technical_lead) get a longer
  timeout; timeouts kill the child's whole process group; in-flight dispatches
  are reaped when HT exits.
- Warns when the goal asks agents to "ask questions" (children are headless);
  lead is instructed to record them under `## Open items`, which the summary
  shows. `--yes` flag; one live run per session.

# Changelog

## [Unreleased]

### Fixed

- **Phantom runs are gone: `/orchestrate` actually dispatches.** The HT bridge
  reported `leads: 0/0 succeeded`, `total cost: $0.0000`, `files: 0 changed` and
  `verification: PASS` while spending nothing and doing nothing. Root causes,
  all in `bridge/extensions/orchestrator.ts`:
  - `orchCliInvocation` called `path.basename` with no `path` binding in scope.
    HT ships as a compiled bun binary, so `process.argv[1]` is a `/$bunfs/root/`
    virtual path and every dispatch reached that line and threw
    `ReferenceError`, caught by the per-task handler and recorded as a $0 failure.
    Now uses `basename` from the static `node:path` import.
  - Dispatches passed `--agent <name>`, which is not an HT CLI flag. HT exited 1
    with `Unknown option: --agent` before contacting a provider. Personas are now
    resolved with `discoverAgents()` and injected via `--append-system-prompt`,
    matching what HT's own subagent tool does.
  - `--mode json` stdout is a newline-delimited event stream, not prose. Triage
    fed the raw stream to `JSON.parse`, so it failed every time and the command
    fell back to `implementation/5/medium` with a bare "Triage unavailable".
    Assistant text is now accumulated from `message_end` events and exposed as
    `stdout` (all turns), `finalText` (last turn), and `rawStdout` (diagnostics).
  - `Math.max(1, leads)` returned `NaN` for a missing/non-numeric
    `topology.leads`, and `Array.from({ length: NaN })` is empty — a literal
    `0/0`. Now coerced, floored at 1, and capped at `MAX_LEADS`.
- **Triage verdicts are now honoured.** The confirmed `task_class`/`complexity`/
  `risk` were computed and then discarded: `planRun` was still called with the
  unparsed `parsed.*` defaults, so every auto-triaged run planned as
  `implementation/5/medium`.
- **Capability personas resolve.** `agentNameFor` derived `orch-<capability>`,
  which missed `lead` (shipped as `orchestrator-lead`) and the analysis/review
  capabilities that have no dedicated file. Those children silently ran with the
  default system prompt and the default unrestricted tool set.
  `CAPABILITY_AGENT_ALIASES` now maps all 16 adapter capabilities onto installed
  personas, so the read-only allow-lists on reviewer and scout personas apply.
- **Cost reporting covers the whole run.** The reported total summed lead
  dispatches only. Architect, QA, escalation, and triage spend is now billed in.
  The QA dispatch also recorded only an outcome, never a `model_call`, so its
  spend was absent from `metrics.jsonl` entirely.
- **Verification can no longer report a vacuous PASS.** A run where no lead
  succeeded reports `NOT RUN`, and a run that changed nothing reports `SKIPPED`,
  instead of inheriting the empty QA suite's `passed: true`.
- Read-only personas no longer report scraped `filesChanged`: `parseFilesChanged`
  scans the child's prose, so a QA agent "reported" every path it merely
  mentioned (e.g. `package.json`, `tsconfig.json` in a repo that has neither).
- Persona prompt temp dirs are cleaned up on the synchronous `spawn()` throw path
  and reaped at activation when a previous parent was SIGKILLed mid-dispatch
  (age-gated well above the dispatch timeout so live runs are never touched).
- A failed architect dispatch is surfaced to the operator instead of being pasted
  into the lead prompt as an empty "Architect's plan:" section.
- Escalation no longer writes an all-`"unknown"` `model_call` when there was no
  retry dispatch to bill.

### Added

- Anthropic-family model routing is the default in `orchestrator/dynamic_adapter.py`:
  cheapest -> `claude-haiku-4-5`, mid -> `claude-sonnet-5`, expensive ->
  `claude-opus-5`, selected by family rank rather than cost thresholds (haiku's
  $5.50/Mtok output could never land in the cheapest bucket, so the tier went to
  `gpt-5.6-luna`). Override with `--model-family` or
  `CODING_AGENT_ORCHESTRATOR_MODEL_FAMILY`; `none` restores pure cost selection.
  `scripts/dynamic_adapter.py` is now a thin shim over the one implementation
  instead of a drifting duplicate.
- `HUMAIN_ORCHESTRATOR_ASSUME_YES` opts a non-interactive run (`--mode json -p`,
  CI, smoke tests) past the two confirmation prompts. Default stays "ask":
  outside a TTY the extension UI's `confirm()` always resolves false, so
  `/orchestrate` could previously never dispatch there.
- Dispatch resource limits, all env-overridable:
  `HUMAIN_ORCHESTRATOR_MAX_CONCURRENCY` (default 4) replaces an unbounded
  `Promise.all` child-process fan-out, `HUMAIN_ORCHESTRATOR_MAX_LEADS`
  (default 8), and `HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS` (default 20m) so a
  hung child fails its own task instead of stalling the batch forever.

- `dispatchParallel` in the HT bridge no longer produces all-`"unknown"` model_call events when the subagent tool returns a sparse `details.results` array (cancellation, mid-dispatch reconcile, harness interruption). Previously, `.map()` on a sparse array skipped the callback for each hole AND returned a sparse array, so the downstream `for (const r of leadResults)` iteration yielded `undefined` and `captureDispatchCost` recorded events with `task_id "unknown-{runId}"` (no `-i` suffix), `model/provider/capability "unknown"`, duration 0, cost $0, and the run reported `0/0 leads succeeded` with `verification: PASS` (the orchestrator's own structural check, not code verification). `dispatchParallel` now uses `flatMap` to drop sparse slots and out-of-range entries so callers only see dense, index-aligned results. The scheduler-side defense in `runDag` additionally guarantees the resolved array is always dense by filling any unset slot with the `skip`-callback stub.

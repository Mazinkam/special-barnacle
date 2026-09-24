# Architecture review and modularization plan

Status: active plan. Execute in order **A → C → B**. This file is self-contained on purpose:
`/orchestrate` agents start with `--no-session` and see nothing but this file and the repo.

- Repo: `hierarchical-agent-orchestrator` (remote `origin` = `git@github.com:Mazinkam/special-barnacle.git`, branch `main`).
- Review baseline: commit `cea98ba`. **Line numbers cite that commit.** Code moves, so re-locate by
  symbol name (`rg -n <symbol>`) before editing, and don't trust a line number without checking it.
- Verification commands (all must pass before any commit):
  - `python3 -m pytest -q` (use `python3`; plain `python` is not on PATH; the interpreter is 3.9.6)
  - `(cd bridge/extensions/orchestrator && ~/.local/bin/bun test)`
  - `bash scripts/typecheck-bridge.sh`
- Last green run of the uncommitted part-A tree: 659 pytest passed, 401 bun passed, typecheck 0 diagnostics.

## Ground rules for every part

1. Work in small commits, one logical change each (`fix(...)`, `refactor(...)`, `test(...)`).
   Run the full verification above before each commit.
2. Refactors must not change behaviour. While moving code, keep re-exports at the old import sites
   so existing tests keep passing, and delete a re-export only once nothing imports it.
3. Bug fixes come with a test that fails before the fix.
4. Don't reach into internals. New code accepts its dependencies as parameters (spawn functions,
   clocks, file paths) and doesn't read globals or `process.env` outside a config module.
5. Never rewrite `metrics.jsonl`, `events.jsonl` or `outcomes.jsonl` in the real state root
   (`~/.local/state/coding-agent-orchestrator`). Tests use temporary roots.
6. Where to run:
   - **A** runs in the main checkout.
   - **C** and **B** run in the separate worktree `.worktrees/modular-refactor`, on branch
     `refactor/modular`, created from the commit that A produces.
   - Start the `/orchestrate` session with the worktree as its cwd. The bridge works out changed
     files and QA scope from git in its own cwd, so a worktree created from inside a run started
     in the main checkout would be invisible to QA.

---

## A. Commit the finished part-1 work (main checkout)

The working tree already contains uncommitted fixes from an interrupted run. Review them, commit
them and push.

What is in the tree (check with `git status` / `git diff`):

- **Bug 1, fixed.** `cli.py` `plan` now accepts `--quality-floor` and `--cost-aggressiveness` via
  `_add_policy_override_flags`, and passes them as `user_overrides`. `build_parser()` is extracted,
  and `tests/test_cli_args.py` checks the arguments the bridge sends against the real parser.
- **Bug 2, fixed.** The new `bridge/extensions/orchestrator/escalation.ts`: retries re-send the
  original lead prompt (`leadTasks`), every failed lead is eligible, and `--max-retries` is honoured.
  Covered by `escalation.test.ts`.
- **Bug 3, fixed.** `scripts/audit_and_clean_metrics.py` and `scripts/stamp_granularity.py` now hold
  the writer lock, replace the file atomically and rebuild the index/ledger, and they no longer
  quarantine row types the package itself writes. Covered by `tests/test_maintenance_scripts.py`.
- **Bug 4, fixed.** `bridge/extensions/cross-review-demo.ts` is deleted (it was broken and contained
  `/Users/abdulkarim/...` paths). `install.sh` links an explicit allow-list of files instead of every
  file in `bridge/extensions/`.
- **Bug 5a, fixed.** `cli.py` `resolve-adapter` no longer crashes when a model has no provider
  (`_format_adapter_table`).
- **Bug 6, fixed.** `runtime.read_json` no longer silently turns a corrupt config into `{}`.
  Covered by `tests/test_read_json.py`.
- **Bug 7, fixed.** `pyproject.toml` package-data. Covered by `tests/test_packaging.py`.
- **Recon effort, fixed.** `method.json` `recon_effort` is now a valid effort, and `method.py`
  validates `exploration_topology`.
- **Dead code deleted:** `orchestrator/adapters.py`, `orchestrator/workspace.py`,
  `scripts/init_orchestrator.py`, `linux-report.md`, `linux-fix-report.md`. `.gitignore` now ignores
  `.orchestrator/` as a whole directory.

Steps:

1. Run the verification commands and confirm they are green.
2. Check that nothing still references the deleted files:
   `rg -n "init_orchestrator|orchestrator\.adapters|orchestrator/workspace|cross-review-demo|linux-(fix-)?report"`.
   Fix any doc references you find, e.g. `docs/INTEGRATION.md` mentions `workspace.py`.
3. Commit as a few logical commits: CLI/plan flags; escalation; maintenance scripts; bridge
   demo + install allow-list; read_json + packaging + method validation; dead-code/repo hygiene.
   Include this file (`docs/architecture-review.md`).
4. `git push origin main`.
5. Create the worktree for C and B:
   `git worktree add .worktrees/modular-refactor -b refactor/modular`.

Done when: `git status` is clean on `main`, the push has succeeded, and the worktree exists.

**Bug 5 is not finished.** Its bridge half (Python spawns without error handlers, no timeout) is
item C1.

---

## C. Make the orchestrator robust (worktree `refactor/modular`)

These are bugs in the `/orchestrate` pipeline that showed up in real runs
(`ht-orch-1790271548655-mho3yr`, `ht-orch-1790278601688-u4l8jt`).

### C1. One Python spawner with error handling and a timeout (finishes bug 5)
- `loadDynamicAdapter` (`index.ts:518`) and the `/orchestrator-roi` handler (`index.ts:~5389`) call
  `spawn` without a `child.on("error")` listener. A bad `HUMAIN_ORCHESTRATOR_PYTHON` produces an
  uncaught async error that the surrounding `try` cannot catch.
- `runModule` (`index.ts:2537`) has no timeout. If Python hangs, the run's terminal path hangs with
  it, because `completeRun`/`failRun` → `recordQueue.flush()` never returns.
- The five spawn copies set different environments. `loadDynamicAdapter` never sets
  `CODING_AGENT_ORCHESTRATOR_HOME`, so `resolve-adapter` can create and touch the *default* state
  root even when the user configured another one.
- `/orchestrator-roi` runs the relative path `scripts/skill_vs_baseline.py` with no `cwd`.
- `runCli` (`index.ts:2504`) is dead code.
- **Fix:** add `bridge/extensions/orchestrator/python-cli.ts` exporting
  `createPythonCli({ python, skillRoot, stateRoot, spawn, defaultTimeoutMs })` with
  `run(moduleOrScript, args, { stdin?, timeoutMs?, cwd? }): Promise<CliResult>`. This is the only
  place that builds the environment, and it always handles `error`, a timeout (kill the process
  group) and `close`. Route `loadDynamicAdapter`, `planRun`, `runModule` callers, ingest and ROI
  through it, and delete `runCli`.
- **Tests:** inject a fake `spawn` for ENOENT, a hang (timeout fires), a non-zero exit, and
  consistent environment variables.

### C2. Fall back to another provider on outages, not just quota errors
- `provider-fallback.ts` only falls back from `openai-codex/*` to `amazon-bedrock` on quota errors
  (`QUOTA_ERROR_RE`).
- In the last failed run, Bedrock returned `Service unavailable: Bedrock is unable to process your
  request.` The harness retried 3 times with backoffs of 2, 4 and 8 s and then gave up, which killed
  a lead that had just finished $3.32 of work.
- **Fix:**
  - Classify transient provider errors (`service unavailable`, `\b5\d\d\b`, `overloaded`,
    `timeout`, `ECONNRESET`, `throttl`) separately from quota errors.
  - On a transient error, retry the dispatch on the same model after a longer, configurable backoff
    (for example 30 s, then 120 s). After that, fall back to a twin of the same model on another
    provider (Bedrock ↔ openai-codex ↔ humain-node, using the alias table), and record
    `route_degraded` with the reason.
  - Keep the helpers pure in `provider-fallback.ts`, and table-test the error classifier.

### C3. Resume a lead after a transient failure instead of discarding it
- Leads delegate work to subagents, and that work is left on disk. When the lead then dies of a
  transient provider error, the run ends as FAILED with `retries: 0`, and dependent leads never start.
- **Fix:** when a lead exits because of a transient provider error (the C2 classifier) and not
  because of a bad result, re-dispatch it once. The prompt is the original lead prompt plus a
  "Resume" section containing its last report text and the list of files changed since it started.
  Count this as a resume, not a verification retry, and show it in the summary.

### C4. Don't send QA to verify a failed lead's partial work, and ground QA in the repo
- The old QA ran on 29 files that a *failed* lead had left behind. Its prompt doesn't name the repo
  root, so the agent decided it was in the wrong directory, ran `find / -iname ...`, and hung until
  the 20-minute timeout.
- **Fix:**
  - Skip QA when no lead succeeded, and say so in the summary.
  - Put the repo root as an absolute path, plus the verification commands, into every QA and lead
    prompt: "the repo root is <abs path>, your cwd; never search outside it, never run `find /`".
- **Tests:** a prompt snapshot for the QA prompt, and a test that QA is skipped when no lead
  succeeded.

### C5. The summary contradicts itself
- The FAILED summary said `verification: NOT RUN (no lead succeeded)`, yet QA had been dispatched
  and the log had `verification failed: (unparsed)`.
- **Fix:** build the summary's verification line from the actual verification state (not run /
  skipped because no lead succeeded / timed out / failed with these checks / passed).
  Unit-test every branch.

### C6. Pass context in explicitly
- Agents run with `humain-terminal --mode json -p --no-session` (`index.ts:1785`), and
  `architectPrompt`/`leadPrompt` (`index.ts:3949`, `4022`) contain only the goal string. So a goal
  like "do A then C then B" arrives with no meaning; run `ht-orch-1790278601688-u4l8jt` blocked for
  exactly this reason.
- **Fix:**
  - Add a `--context <file>` flag, which may be repeated. Each file's content is inserted into the
    architect and lead prompts under `## Provided context`, capped (for example 40 k characters per
    file, with a truncation note) and with paths redacted.
  - Add `--with-last-reply`, which inserts the last assistant message of the current session
    (via `ctx.sessionManager`) the same way.
  - Document both in `USAGE` and in the bridge README.

### C7. Detect goals that refer to missing context
- Before triage: if the goal is short (fewer than about 200 characters), refers to outside items
  (standalone letters like `A`/`B`/`C`, `option \d`, `the above`, `as discussed`, `that plan`), and
  no `--context`/`--with-last-reply` was given, stop.
- In that case, tell the user to attach context. Don't start a run that will just block.
  Allow `--force` to skip the check.

Done when: C1–C7 are each committed with tests, all verification is green, and `refactor/modular`
has been pushed (`git push -u origin refactor/modular`).

---

## B. Modularize (worktree `refactor/modular`, after C)

Goal: deep modules with small interfaces and dependencies in one direction only. Each step below
should be its own commit (or a few commits) and must not change behaviour.

### B1. Define shared values once (Python ↔ TS contract)
Today these values are copied by hand:

| Value | Copies |
|---|---|
| Stream file names | `record_index.py:51` (`STREAMS`), `runtime.py:264`, `archive.py:56` (`NEVER_ARCHIVE`), `dashboard.py:400,409,424,750`, `history.py:216`, `outcomes.py:73`, `ingest_checkpoint.py:347,553`, `run-diagnostics.ts:18-22` |
| `ingest_status.json` | `cli.py`, `dashboard.py:410,750`, `archive.py:57` |
| Batch exit codes and status strings | `cli.py:122`, `record_batch.py:203,259,268,274`, `record-queue.ts:138-141` |
| 500-record batch limit | `record_batch.py:37`, `record-queue.ts:130` |
| Path-redaction regex | `cli.py:19` (`[^ \t\n|]`), `index.ts:159` (`[^\s|]`); they already differ |
| State-root env vars and default path | `runtime.py:14` (`CODING_AGENT_ORCHESTRATOR_HOME`), `index.ts:147-149` (`HUMAIN_ORCHESTRATOR_STATE_ROOT`), `install.sh:29` |
| `CALL`/`SESSION` | `records.py:32-35` and `ingest_checkpoint.py:74-76` |
| Token fields | `economics.py:40` (4 keys), `ingest_checkpoint.py:77` (6 keys) |
| Terminal run tasks | `archive.py:54`, `run_evidence.py:56`, `history.py:113` |
| ISO-timestamp parsing | `outcomes.py:9`, `run_evidence.py:62`, `archive.py:71`, `history.py:27`, `dashboard.py:337` |
| `min_samples` | 12 in `engine.py`, `adaptive.py`, `policy_simulation.py`, `policy_recommendations.py`; **8** in `scheduler.py:63` |
| High-risk set | `adaptive.py:21,42,170`, `controls.py:28,40,50` |
| Capability → persona map | only `index.ts:3037-3047`; Python has other role aliases in `economics.py:284-296` |
| Tier and effort names | `method.json`, `models.ts:8,17,19,126`, `method.py:20`, `index.ts:3529-3537` |
| Model → tier | `models.ts:101-110` (by name regex) vs `dynamic_adapter.py:262` (by cost) |

**Steps:**
1. Add `orchestrator/contract.json`, symlinked into `bridge/extensions/orchestrator/` the same way
   `method.json` is. It holds stream→file names, never-archive names, exit codes, body statuses,
   batch and `record_id` limits, the redaction regex, env var names and the default state root.
2. Add `orchestrator/vocab.py` for the Python-only vocabulary (the rest of the table).
3. Replace every copy in the table with an import from one of these.
4. Add a parity test on each side that loads `contract.json`, plus the argv contract test from part A.
5. Move the capability → persona map and the effort aliases into `method.json`, and derive the TS
   `Tier` type from the JSON.

### B2. Break the Python import loop and get the layers in order
- `runtime.EventStore._write` lazily imports `record_batch` (`runtime.py:275`), and `record_batch`
  imports `runtime`.
- `runtime.meter` lazily imports `pricing` (`runtime.py:254`).
- `record_batch.py:29` imports `dashboard` and calls `generate_dashboard` inside `write_batch`
  (`:271`), so every durable write renders HTML.
- `engine.py:14` imports `dashboard`.

**Target layers.** A layer may import only from layers to its left. Enforce this with
`import-linter` in CI, or with a pytest that parses the imports.
```
core/ (layout, fs, jsonl, coerce, env) → config/ (loader, method, vocab, features) → records/ (schema, metering, pricing, quality)
 → store/ (index, writer, ledger, facade, documents) → ingest/ , analytics/ → routing/
 → presentation/ (dashboard_data, dashboard_html, publish) → app/ (refresh, engine) → cli/
```

**Order:**
1. Take the refresh out of `write_batch`. Add `app/refresh.py` (ledger refresh, then dashboard
   publish), and have the CLI `_write` call the writer and then refresh. Keep the same JSON body
   and exit codes, including exit code 3 when a refresh fails.
2. Split `runtime.py` into `core/fs.py` (atomic writes, fsync, locks), `core/jsonl.py` (one reader:
   remove `load_jsonl` by moving `history.load_stats` to `iter_jsonl`), `core/env.py` (state root,
   resolved lazily and not at import) and `core/layout.py` (`StateLayout(root)` with every file
   path). Move `Policy`/`QualityEvidence`/`meter()` to `records/`. Keep `runtime.py` re-exporting
   everything for one release.
3. Make `EventStore` a facade over an injected writer, route `discovery` through the writer too, and
   have `state.*` take a layout instead of building an `EventStore`.
4. Engine: inject `on_change` instead of importing the dashboard, and write `plan_run`'s 4 records
   as one `write_batch`. Unify `min_samples` via `adaptive.configured_min_samples`.
5. Make `read_json`, `method.load_method` and the `lru_cache` in `economics.py:321` return copies,
   or load them explicitly and inject them. Loading must not happen at import time (`scheduler.py:8`,
   `dynamic_adapter.py:41`, `cli.py:43` `ROOT`).

### B3. Split the big Python modules
- `dashboard.py` (779 lines): `build_data` (`:386-677`) becomes per-panel reducers fed by one pass;
  move the HTML/CSS/JS (`:681-745`) into a template; locking and publishing go to
  `presentation/publish.py`. Remove the `import os as os` test hook (`:25`) and fix the patch target
  in `tests/test_dashboard_metrics.py:724`.
- `ingest.py` (967 lines) becomes `ingest/parsers/{humain_terminal,codex}.py`, `discovery.py`,
  `reconcile.py` (`_reconcile_source_calls`, `:352-507`) and `service.py` (`ingest_paths`, plus
  `make_ingest_status`/`process_ingest` moved out of `cli.py:57-119`).
- `ingest_checkpoint.py` becomes `ingest/checkpoint.py` (codec and validators, `:84-323`) and
  `ingest/ledger.py` (`IngestLedger`, `:325-586`).
- `archive.py` becomes `archive/{manifest,seal,codec,plan,execute,restore}.py`. Move the summary
  aggregation out of `cli._archive_runs_command`.
- Remove modules that add nothing:
  - merge `policy_recommendations.py` into the routing policy module;
  - move `verification.flaky_stats` to analytics;
  - put `ContextRegistry`/`VerificationCache` on a single locked `JsonDocument` store (today they do
    unlocked read-modify-write);
  - keep `controls.py` only if it's documented as public API.
- CLI: a subcommand table with one module per command group; consistent argparse with help text;
  `--granularity` choices taken from `records.GRANULARITIES`.
- Delete or implement the ~30 unused `config.json` keys (`orchestration`, `context`, `verification`,
  `budgets`, `persistence`, `hard_gates`, ...). Make `scripts/rebuild_ledger.py` and
  `scripts/regenerate_dashboard.py` thin wrappers around `cli.main`.

### B4. Split the bridge (`index.ts`, 5,456 lines)
Target layout. Dependencies point inward only; nothing imports `index.ts`; only `config.ts` reads
`process.env`.
```
index.ts              wiring only (~60 lines): build runtime, register commands/tools/hooks
config.ts             loadBridgeConfig(env, home) -> BridgeConfig   (replaces index.ts:144-257; one expandHome)
core/                 pure logic: args.ts (parseArgs, USAGE; 4141-4375), prompts.ts (architectPrompt, leadPrompt,
                      modelTableForLead, formatTaskPrompt, LEAD_* contracts; 3982-4136, 3073), triage.ts (685-790),
                      routing.ts (pickModel, cheapestAtTier; 3304-3381), capabilities.ts (one binding fallback chain,
                      replacing 2866/3315/2427/4044), records.ts (dispatchRecordsFor with tags as a PARAMETER; 3387-3567),
                      report.ts (summary/verdict builder from a RunReport; 5041-5120), events.ts (typed event-name union)
adapters/             python-cli.ts (from C1), telemetry.ts (wraps RecordQueue; onError injected), profiles-store.ts,
                      adapter-resolver.ts, git-changes.ts (3087-3292 + ChangeTracker), process-reaper.ts (268-409)
dispatch/             child-args.ts (pure argv/env builder; 1784-1856), persona.ts, child-events.ts (the ONLY
                      cost/turn accumulator; RunSession consumes its deltas), stderr-sink.ts (the 2308-2403 close logic
                      as a tested decision table), child-process.ts (runSubagentProcess, ~250 lines), parallel.ts
run/                  context.ts (RunContext + RunRegistry replacing ACTIVE_RUN / CURRENT_RUN_TAGS /
                      CURRENT_ALIAS_TABLE globals), session.ts, board.ts (pure view), ui-sink.ts (safeUi)
pipeline/             triage-step.ts, hierarchy.ts (returns escalation results; no mutable sink), verify-loop.ts,
                      run-orchestration.ts (triage→plan→size→confirm→dispatch→verify→finalize, returns RunReport)
commands/             orchestrate.ts, orchestrator-models.ts (a subcommand table instead of the 9-way switch at 5181-5387),
                      cancel.ts, omsg.ts, roi.ts
tools/status.ts, hooks/ingest.ts, hooks/shutdown.ts
```

**Order:**
1. Move pure code first: args, prompts, triage, routing, records (tags as a parameter), report.
   Merge the duplicate `fmtElapsed`/`spinnerFrame` into `run-ui.ts`. Remove the `*ForTest` exports
   once the symbols are exported normally.
2. `config.ts` (replaces the 7 separate `~` expansions).
3. The adapters: profiles store, resolver, telemetry, git changes, process reaper. Derive
   `FALLBACK_ADAPTER` from `bridge/orchestrator-profiles.json`, and either remove the misleading
   `model:` front matter from `bridge/agents/*.md` or add a test that checks it.
4. `run/context.ts`: thread `RunContext` explicitly through `runSubagentProcess`, `dispatchParallel`,
   `dispatchReconAndLeads`, `runVerification`, `triageTask` and telemetry, then delete the globals.
   **This is the riskiest step, so do it only after the modules above are covered by tests.**
5. Split `runSubagentProcess`: child-args, then persona, then the event accumulator (which fixes the
   double cost-counting between `RunSession.onChildEvent` and the process), then stderr-sink, then
   the reaper.
6. Pipeline and commands. `index.ts` ends up doing only the wiring.
7. Fix the remaining small issues:
   - `parseFailedChecks` (`~3650`) treats `| lint | 0 errors |` as a failure;
   - run duration is parsed from the run id string (`~5082`);
   - `PlanResponse` is cast without validation (`~2644`);
   - `planRun` hard-codes `--coupling 0.5 --parallelizable 0.5` (`~2623`);
   - swallowed errors at `~1784` (prompt write) and `~5048` (the lead-report write, which the summary
     links to anyway);
   - Python/TS duplicates: `recordHookFailure` vs `cli.make_ingest_status`; `recon.ts:89-95` vs
     `models.ts:81-86` `reconWorkers` (they disagree on a missing band); `MAX_LEADS=8` vs
     `scheduler.py:43` capping at 4.

### B5. Split the big test files to match
- `bridge/extensions/orchestrator/index.test.ts` (4,229 lines): split alongside each new module;
  replace the global `node:child_process` mock with injected `spawn`; drop the stale `BorderedLoader`
  mock.
- `tests/test_ingest_checkpoint.py` (1,918 lines): turn it into a `tests/ingest_checkpoint/` package
  with shared helpers in `conftest.py`, grouped by behaviour instead of by review round
  (`RecoveryRoundTwoTests`, ...).
- Replace patches of private functions (`archive._compress_to_temp`, `record_batch._append_stream`,
  `cli.ROOT`, ...) with explicit fault-injection parameters.

### B6. Clean up docs
Fix the false claims:
- `SKILL.md:55,214` `policy_overlay.json` (doesn't exist);
- `SKILL.md:132` dashboard metrics `re_review_violations`, `recon_coverage`,
  `enforcement_readiness` (they don't exist);
- the SKILL.md "$0.50 recon ceiling" (`max_recon_cost_usd` is never read);
- `orchestrator-README.md:81` "writes via `cli metric`" (writes go through `batch -` now);
- the stale file table in `PUBLISH.md`.

Also: archive or mark the status of the completed plans in `docs/superpowers/plans/`; merge the two
"Unreleased" headings in `CHANGELOG.md`; align `requires-python` with the 3.9 interpreter that
actually runs the code (or make the bridge check the version).

Done when: B1–B6 are committed, all verification is green, the layer check passes in CI,
`index.ts` does only wiring, and `refactor/modular` is pushed. Open a PR to `main`; **do not merge
it without the user's approval.**

# Run 8 — Telemetry id bug, dead efficiency switches, test pollution, provider-health dashboard

Findings come from a read-only investigation on 2026-09-28 against `main` @ `4b78097` (which includes A1–A5a).

## Before running (operator)

Run 7 (`md5zd6`) finished with 20 commits on `feat/lead-ci-wait`. Its QA verified only 1 file, because it was launched from `main`. Run 8 is therefore based on `feat/lead-ci-wait` and verifies that work first (Step 0), without merging to `main`.

```bash
cd /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator
git worktree add .worktrees/telemetry-health -b feat/telemetry-health feat/lead-ci-wait
cp docs/superpowers/goals/2026-09-28-run8-telemetry-tests-provider-health.md .worktrees/telemetry-health/docs/superpowers/goals/
cd .worktrees/telemetry-health && git add docs/superpowers/goals && git commit -m "docs(run8): goal" && humain-terminal
```

Run only ONE orchestration of this goal, from inside `.worktrees/telemetry-health`.

Paste into HUMAIN Terminal:

```
/orchestrate --profile openai --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
Fix four orchestrator issues in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/telemetry-health (branch feat/telemetry-health, created from feat/lead-ci-wait). The spec, with evidence, is docs/superpowers/goals/2026-09-28-run8-telemetry-tests-provider-health.md (this file). Read it first.

WORKSPACE: This worktree only. Never edit the main checkout; the live extension is symlinked to it. Commit after each item passes its scoped tests. Do not merge or push.

STEP 0 — Verify run 7's unverified work (its QA checked only 1 file). Commits a2e46cd..4211028 from feat/lead-ci-wait are in this branch: A5b provider_stall, A6/N2, B1 CI waiting, B2, B3 and B4.
- Run each check separately (full suites only through a subagent): ./scripts/typecheck-bridge.sh --all, ./scripts/lint.sh, bun test ./bridge, pytest.
- Only the 3 known failures from docs/superpowers/goals/run5-baseline.md are allowed.
- Run one technical review over `git diff 8a9c3a9..4211028 -- bridge` for BLOCKING issues only.
- Fix only real breakages: at most 1 review round, one commit ("fix(run7): ...").
- Record the result in run8-baseline.md together with the baseline below.

BASELINE (as a subagent, after Step 0): run `bun test ./bridge` and pytest, and record the results in docs/superpowers/goals/run8-baseline.md. Expected: the 3 known bun failures (child-process "long minified-bundle-style…", and the two hooks/ingest "session ingest hook wiring" tests). Commit it.

ITEM 1 — Nested model_call record_id exceeds 200 characters (cost rows are rejected)
- Evidence: run ht-orch-1790588009658-8hpdev/run.log has "telemetry: orchestrator batch rejected 1 record(s) [metric:model_call]: record at index 0 record_id exceeds 200 characters".
- Cause:
  - index.ts nestedModelCallRowsFor (~4068) builds `nested:${runId}:${parentTaskId}:${dispatchAttempt}:${c.key}`.
  - nested-cost.ts keyOf() makes key = `${callId}:${taskId}:${attempt}`, and the nested taskId already embeds the callId.
  - openai-codex tool-call ids look like `call_<24>|fc_<50>` (about 83 chars) and appear twice, so the id is about 250 chars.
  - orchestrator/record_batch.py MAX_RECORD_ID_LENGTH = 200 (line ~96) then rejects the row.
  - Bedrock `tooluse_…` ids are short, which is why this only hits Codex leads, including --profile openai.
- Fix:
  - Build record_id deterministically and within the limit: keep a readable prefix (`nested:<runId>:<parentTaskId>:<attempt>:`) and replace the key with a hash, `sha256(key)` truncated to 32 hex chars, whenever the full id would exceed 200 chars. Or always hash the key, but then keep the existing ids stable for short keys, so replays of old runs still de-duplicate.
  - Keep the full value in `nested_call_id`.
  - Check every other record_id producer (live-qa.ts 2258/2302/2323, record-queue.ts) for the same risk.
  - Do not raise the Python limit.
- Tests:
  - A Codex-shaped id produces a record_id of 200 chars or fewer, the same input gives the same id, and two different keys give different ids.
  - A bridge→Python round-trip test shows the row is accepted.
  - Existing short-key ids are unchanged.
- Backfill: add an opt-in CLI or script note describing how to re-emit nested rows for affected runs from their saved events.jsonl, if the existing replay path supports that. Otherwise list it under Open items.

ITEM 2 — Remove the dead efficiency switches; rebuild only file_ownership in report mode
- Evidence:
  - A1 deleted the only implementation, the inline index.ts pipeline.
  - pipeline/run-orchestration.ts ~190-207 now only warns (`efficiency_switch_unsupported`).
  - index.ts line 146 imports file-ownership.ts and line 157 imports lead-handoff.ts, but uses neither.
  - The switches were always OFF and have no usage data (docs/superpowers/audits/2026-09-25-phase2-efficiency-and-canaries.md).
- Fix:
  (a) DELETE `scoped_leads` and `recon_before_architect`: their entries in efficiency-flags.ts, method.json (orchestrator/method.json and the bridge copy, if they differ), the HUMAIN_ORCHESTRATOR_EFFICIENCY_* env vars, lead-handoff.ts and its test, the core/records.ts and run-outcome.ts comments that reference them, and the unused imports in index.ts. Keep the Python side consistent (method.py / controls.py) and update docs/the audit with a "removed" note.
  (b) `file_ownership`: re-implement `report` mode ONLY, in pipeline/hierarchy.ts, reusing file-ownership.ts (findOwnershipOverlaps / observedEditConflicts). Record ownership overlaps and observed edit conflicts between leads as events, without changing waves. Leave `serialize` for later: keep it rejected with a clear warning. Motivation: run 2 had three parallel leads editing RunSession.recordProgress.
  (c) Remove `efficiency_switch_unsupported`, or narrow it to `file_ownership=serialize`.
- Tests: the flags parser rejects the removed switches with a clear problem message; file_ownership=report emits overlap events in a hierarchy test; knip stays clean.

ITEM 3 — The 3 baseline "flaky" failures are test pollution between files
- Evidence (bun 1.3.14):
  - Each file alone: pass.
  - Every *.test.ts except index.test.ts: 0 fail.
  - Full `bun test ./bridge`: 3 fail.
  - `bun test --isolate ./bridge`: the ingest failures become "Unhandled error between tests" in adapters/telemetry.test.ts, hooks/ingest.test.ts and commands/orchestrate.test.ts. Each one is `contract.streams` / `contract.redaction_regex` of undefined, at `import contract from "./contract.json"` (record-queue.ts:44 and hooks/ingest.ts:19). bridge/extensions/orchestrator/contract.json is a SYMLINK to ../../../orchestrator/contract.json.
  - The child-process "Bundle failed" error hides the real cause: Bun.build in 1.3 throws an AggregateError, and the test drops `err.errors`.
  - index.test.ts calls mock.module() on node:child_process, @humain/terminal and typebox (process-global in bun). It also sets process.env state roots at top level and calls process.chdir (~3424, ~3691).
- Fix (confirm each mechanism with a failing test/command before changing anything):
  (a) In dispatch/child-process.test.ts (and the equivalent Bun.build in index.test.ts ~1789), surface the AggregateError `.errors` / build logs, so the real bundle failure is visible. Then fix that cause.
  (b) Replace the symlinked-JSON imports with a tiny `contract.ts` loader that reads and parses the canonical file once, e.g. via `readFileSync(new URL(...))` or a resolved realpath. Keep contract.test.ts's parity check that there is a single source of truth. Update every importer: record-queue.ts, hooks/ingest.ts, run-diagnostics.ts and the tests.
  (c) Contain index.test.ts's global side effects: restore env and cwd in afterAll, and move the mock.module stubs to a dedicated preload or a separate test file that bun runs isolated. If that is not feasible, make the test script run index.test.ts in its own process, and document it in README "Tests".
- Done when: `bun test ./bridge` has 0 failures, `bun test --isolate ./bridge` has 0 failures, and a `--randomize` run with 3 different seeds has 0 failures. Record the seeds.

ITEM 4 — Record provider outages and show them on the dashboard
- Evidence:
  - Four runs (vcy00z, s11yls, hv4i5g, xmch50) died from `getaddrinfo ENOTFOUND bedrock-runtime.eu-west-2.amazonaws.com`, "pending stream has been canceled", "Bedrock stream ended without a stop reason" or "fetch failed". The ledger has no trace of this.
  - events.jsonl `dispatch_finished` rows carry only exit_code/stop_reason: 48 exit-124 rows with no outcome or timeout reason. The only related data is 13 `route_degraded {reason: provider_quota}` events and 17 model_call rows with stop_reason "error".
- Fix, bridge side:
  - Extend `dispatch_finished` with `outcome`, `timeout_reason`, `failure_class` (provider_stall | wait_stall | transient | quota | task | cancelled), `provider`, `model` and `error_code`. error_code is a short normalized code: ENOTFOUND, ECONNRESET, ETIMEDOUT, fetch_failed, stream_canceled, stream_no_stop_reason, http_5xx, quota. Never include raw stderr or hostnames beyond the provider endpoint host.
  - Emit a new `provider_error` event for each provider/network error observed in a dispatch's own events OR in nested-worker snapshots, with ts, run_id, task_id, provider, model, endpoint_host, error_code and nested (bool). De-duplicate repeats within one dispatch (count + first/last ts).
  - Reuse core/transient-error.ts and core/wait-stall.ts (and run 7's provider_stall classifier, if merged) as the single classifier.
- Fix, Python/dashboard side:
  - Accept the new fields and event in contract.json streams/schema, record_batch validation and ingest.
  - Add a "Provider health" panel to orchestrator/dashboard.py:
    - errors per provider per hour (last 7 days);
    - outage windows: consecutive provider_error events for the same provider/error_code less than 10 min apart merge into one window, showing start, end, count and affected runs;
    - dispatches and cost lost to provider failures;
    - runs whose first failure was provider-caused.
  - Keep it separate from the orchestrator headline tiles.
- Backfill: add a one-off, idempotent script that scans runs/*/run.log and *.stderr.log for the known error strings and emits provider_error rows (stable record_ids) for historical runs, so the four known outages show up. Dry-run by default.
- Tests: classifier cases for each error_code; a dispatch_finished row with the new fields; nested provider errors emit events once; Python accepts the rows; the dashboard renders the panel from a synthetic fixture; the backfill is idempotent (running it twice adds nothing).

ORDER: Step 0 → baseline → Item 3 (a trustworthy test suite first) → Item 1 → Item 4 → Item 2 → docs (bridge/README.md and CHANGELOG.md for all four).

RULES (mandatory, from runs 4–7):
- No bash call longer than about 3 minutes. Never chain typecheck, lint and the full suite. Run the full `bun test ./bridge` and pytest ONLY through a subagent.
- One item per worker, with a file list and a stop condition. Split any worker that passes about 60 turns.
- At most 2 review rounds per item. Anything left goes under Open items.
- Do not touch core/text-safety.ts unless a test breaks.
- Commit after every item. After any interruption, re-read `git log` and continue from the last commit.
- No sleep/poll loops. Headless; never block on human input.

VERIFICATION (at the end, each as its own subagent or step; include the outputs):
- python3 -B -m pytest -p no:cacheprovider -q
- bun test ./bridge   (0 failures; this replaces the 3-failure baseline)
- bun test --isolate ./bridge   (0 failures)
- ./scripts/typecheck-bridge.sh --all   (exit 0)
- ./scripts/lint.sh
- Regenerate the dashboard against a COPY of the state dir (cp -R ~/.local/state/coding-agent-orchestrator /tmp/orch-state-copy), run the backfill there in non-dry-run mode, and confirm the Provider health panel lists the Bedrock eu-west-2 outage windows from 2026-09-26/27. Never write to the real state dir.

FINAL REPORT:
- The commit list with the item each covers.
- Baseline vs final test counts, and the randomize seeds used.
- Open items.
- Operator steps: merge to main, /reload, and run the backfill against the real state dir (dry-run first).
```

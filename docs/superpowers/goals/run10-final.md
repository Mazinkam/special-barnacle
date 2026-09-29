# Run 10 final report

## Commits per phase

- Phase 0: `22b81d0` (feat(report)), `7e169d1` (spec).
- Phase 1: `1a9ab5f` (audit).
- Phase 2: `b53c69c` (B1 fail-closed fix), `0cc6d9c` (audit: B1 review FAIL → fix → confirm PASS).
- Phase 3: `18d0264` (merge main), `4e16e61` (single classifier), `694107d` (per-attempt cost + shared attempt signals), `3ca717d` (dispatch health classifies from the same stderr failover reads).
- Phase 4: this docs commit.

## Conflict resolution

- `adapters/adapter-resolver.ts`: kept the branch's Bun `--isolate` symlink workaround for the `orchestrator-profiles.json` import plus main's `model-catalog`/`model-router` imports and candidate logic.
- `dispatch/parallel.ts`: replaced the old single Codex→Bedrock twin retry with main's `dispatchWithFailover`; per-attempt `dispatch_finished` with dispatchHealth fields and `superseded_by_fallback` on non-final attempts, `recordProviderErrors` per attempt.
- `index.ts`: same shape; main's per-attempt loop plus dispatchHealth/recordProviderErrors per attempt.
- `index.test.ts`: kept both imports (`RecordQueue`, `ModelHealth`).
- Auto-merged files checked: `method.json` has no `scoped_leads`/`recon_before_architect` (only `method.py` rejects them); main's `model_failover`/`model_canaries` rules kept; flag guard unaffected.

## Reviews

- B1 security review FAIL (1 BLOCKING) → fix → confirm PASS.
- Technical review round 1 FAIL (cumulative final cost double-counted in `provider_health` `failed_dispatch_cost_usd`; nested evidence made the telemetry class differ from failover) → `694107d`.
- Round 2 FAIL (child-process `[provider nested error]` stderr tail: failover saw it, telemetry stripped it) → `3ca717d`, verified by scoped tests; no third review (2-round cap).

## Test counts

- Baseline (`run9-baseline.md`): Bun 1713 pass, pytest 1119 passed/1 skipped.
- Final: pytest 1153 passed, 1 skipped; `bun test ./bridge` 1822 pass 0 fail; `bun test --isolate ./bridge` 1822 pass 0 fail.
- `--randomize` seeds 101/202/303: 1822 pass 0 fail each when run alone (running concurrently with other full suites gave one different 5 s timeout per seed; these were load-related and did not reproduce).
- `typecheck-bridge --all` exit 0 with 0 diagnostics; `lint.sh` exit 0 (ruff, vulture, knip clean).

## Dashboard

State copy: `/tmp/orch-state-copy`. Backfill dry-run: 67 candidates/0 persisted; real run: 67 persisted; second real run: 0 persisted (idempotent). The dashboard was regenerated with:

```bash
CODING_AGENT_ORCHESTRATOR_HOME=/tmp/orch-state-copy PYTHONPATH=. python3 -m orchestrator.cli dashboard
```

Note: the script needs `PYTHONPATH=.`. Provider health shows ONE Bedrock eu-west-2 window: `2026-09-27T19:58:11Z` ENOTFOUND, count 1, `bedrock-runtime.eu-west-2.amazonaws.com`. There is NO 2026-09-26 window, even though the raw logs have eu-west-2 ENOTFOUND lines in run `vcy00z` (started 2026-09-26 18:27Z) and in 7 runs on 09-27. 28 of the 29 eu-west-2 rows have `timestamp_precision` "unknown" (the stderr lines have no timestamp) and are intentionally excluded (`dashboard_data.py:413-415`, per `e53d85f`). The backfill does not scan `*.events.jsonl`, which carry timestamps. Result: the check FAILED (09-26/27 windows not fully listed).

## Verdict

**NOT MERGED.** The Phase 4 dashboard check did not pass, so per the spec Phase 5 was skipped; main is still at `ed83b18`. The branch is not pushed.

## Open items

1. Decide how undated legacy provider evidence gets a time: scan the harness-emitted error fields in `*.events.jsonl` (not assistant prose), or bound the undated lines to the run's start/end interval with a new precision value. Then re-run the dashboard check and merge (`git merge --ff-only feat/telemetry-health` in the main checkout).
2. `hv4i5g` nested provider-stall evidence remains OPEN (accepted).
3. N3: covered by main's failover (lead/QA go through `dispatchWithFailover`); no gap.
4. `3ca717d` has not been independently reviewed beyond the 2-round cap.
5. Unexplained inactivity timeouts are now telemetry `provider_stall`, and the dashboard counts them as provider failures; confirm that this is intended.
6. Operator steps: after merging, open a fresh HUMAIN Terminal or run `/reload`; run `python3 scripts/backfill_provider_errors.py --state-dir ~/.local/state/coding-agent-orchestrator` (dry run), then rerun it with `--write --allow-live-state` added; push main when satisfied.

## Follow-up: structured backfill

Option A is implemented: `scripts/backfill_provider_errors.py` now reads the harness's structured error fields in `runs/*/*.events.jsonl`. It uses assistant messages with `stopReason: "error"`, an `errorMessage` and an epoch-ms `timestamp`, and never model text. Rows are de-duplicated per file, carry exact timestamps, and get `nested: true` under `details.results`. Undated text-log lines are dropped. `run.log` is never scanned (it echoes prompt text such as `goal: …`); dated `*.stderr.log` lines count only for runs without structured rows. `PYTHONPATH=.` is no longer needed.

On a fresh copy (`/tmp/orch-state-copy`) the dry-run found 54 candidates (60 before `run.log` was dropped from the text scan). The first `--write` persisted 54 and the second persisted 0. No `unknown` 09-28 goal-text windows remain. The regenerated dashboard lists Bedrock `bedrock-runtime.eu-west-2.amazonaws.com` ENOTFOUND windows on 2026-09-26 (21:49:27Z–21:49:29Z, run `vcy00z`) and on 2026-09-27 (11 windows, 08:10Z–19:58Z).

# Run 10 — Finish feat/telemetry-health and merge it into main

State on 2026-09-28 (read-only check):

- `feat/telemetry-health` @ `882b743`: 23 commits ahead of the merge-base `4211028`. It is not merged into `main`.
- There are uncommitted edits in `core/report.ts`, `core/report.test.ts` and `pipeline/run-orchestration.ts`. They explain `STATUS: partial` lead results in the terminal summary (the `why partial:` and `what still needs action:` lines).
- `main` @ `ed83b18` is 11 commits ahead of the merge-base. It adds the modular model failover commits `706aadc..ac83fa1` and the merge `ed83b18`. The main checkout is clean.
- A trial `git merge-tree main HEAD` shows 4 content conflicts:
  - `adapters/adapter-resolver.ts`
  - `dispatch/parallel.ts`
  - `index.ts`
  - `index.test.ts`
- Run 9 has no recorded final report or merge verdict. Only `run9-baseline.md` (Phase 1a and the hv4i5g open item) was committed.

## How to launch

1. Make sure no other orchestration is running.
2. Run `cd /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/telemetry-health && humain-terminal`.
3. Paste the whole block below as your first input. Do not type `/orchestrate` first.
4. Within 1 minute, check the run log for all of these:
   - `models (profile "openai")`
   - `triage: backend_refactor / complexity 7 / risk medium`
   - `worktree: …/.worktrees/telemetry-health`

   If any is missing, run `/orchestrate-cancel` and relaunch.

```
/orchestrate --profile openai --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
Finish feat/telemetry-health and merge it into main. Worktree: /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/telemetry-health. Spec: docs/superpowers/goals/2026-09-28-run10-finish-and-merge-telemetry-health.md (this file). Read it first, then the run-9 spec (2026-09-28-run9-finish-run7-and-run8.md), the run-8 spec (2026-09-28-run8-telemetry-tests-provider-health.md) and docs/superpowers/goals/run9-baseline.md. Do NOT redo committed work: check `git log --oneline 4211028..HEAD` first.

WORKSPACE: Do all work in this worktree. The main checkout is the live extension (it is symlinked). Touch it ONLY in Phase 5, and only with `git merge --ff-only`. Never push. Never write to the real state dir (~/.local/state/coding-agent-orchestrator); use /tmp/orch-state-copy.

PHASE 0 — Commit the in-progress partial-summary UX:
- Review the uncommitted diff in core/report.ts, core/report.test.ts and pipeline/run-orchestration.ts. A partial run must show "Orchestration partial", "code verification: PASS", "why partial:" and at most 5 "what still needs action:" bullets, and the raw "STATUS:" line must be hidden.
- Make sure BLOCKED and FAILED still take precedence over partial, and that reports without leadStatuses render exactly as before.
- Add a test for each of these:
  - partial + blocked shows BLOCKED;
  - partial with a non-PASS verdict;
  - partial with showFullReport=true (no action list).
- Run the scoped tests (bun test bridge/extensions/orchestrator/core/report.test.ts and pipeline/run-orchestration.test.ts). Commit: "feat(report): explain partial lead status in run summary".

PHASE 1 — Audit what run 9 finished. Use ONE read-only worker that reads the specs and git log and produces no code. For every run-9 item, list the commit(s) that cover it, or DONE-MISSING with the exact gap:
- 1b: B1 security sign-off. Record the fix round, the confirm review, and the timer vs RunSession tick decision.
- 1c (i)-(iii): the B4 replays. hv4i5g stays an OPEN item; that is accepted and does NOT block the merge.
- Run-8 Items 1-4.
- Phase 3: Item 5, the flag guard.
- Phase 4: the README and CHANGELOG entries.
Write the table to docs/superpowers/goals/run10-audit.md and commit it.

PHASE 2 — Close only the DONE-MISSING gaps from Phase 1. Use one worker per gap, give each a file list and a stop condition, and commit after each. At most 2 review rounds per gap; anything left goes under Open items. If 1b's security confirm review was never done, run it now: one review of the B1 diff, fix BLOCKING findings only, then one confirm review.

PHASE 3 — Bring main into the branch. Merge; do NOT rebase, because the history already has merge commits and other worktrees depend on it.
- Run `git merge main` in this worktree and resolve the 4 conflicts: adapter-resolver.ts, dispatch/parallel.ts, index.ts and index.test.ts.
- Main adds modular model failover:
  - 25c350e: the provider-failure failover policy;
  - c060ecc: failover wired into dispatch;
  - ac83fa1: profile backups in active runs;
  - 706aadc: method rules and catalog.
  This branch adds dispatch_finished outcome/failure_class/error_code, provider_error events, and provider-health classification (dispatch/provider-health.ts, core/transient-error.ts, core/wait-stall.ts).
- Keep BOTH features. There must be ONE provider-failure classifier: failover decisions and provider_error/failure_class telemetry must use the same classification. Pick one module as the source of truth and have the other call it. Do not keep two regex tables.
- When failover switches models, the telemetry must record the ORIGINAL failing provider/model in provider_error and the FINAL one in dispatch_finished. Add a test for this.
- Also check the auto-merged files for semantic conflicts, even though they merged cleanly: orchestrator/method.json, method.py, commands/orchestrate.ts, dispatch/child-process.ts, parallel.test.ts and orchestrator-README.md. method.json must not bring back scoped_leads or recon_before_architect.
- Run scoped tests for every conflicted and semantically touched file, plus typecheck. Commit the merge with a message that lists each conflict and how it was resolved.
- The N3 recommendation from run 9 (cross-provider failover for lead/QA provider stalls) is now provided by main's failover. Confirm that provider_stall and transient provider errors trigger failover for lead and QA dispatches, or record the gap under Open items.

PHASE 4 — Final verification on the merged branch. Run each check as its own subagent or step, with a bound of about 3 minutes, never chained, and include the outputs:
- python3 -B -m pytest -p no:cacheprovider -q
- bun test ./bridge (0 failures)
- bun test --isolate ./bridge (0 failures)
- bun test --randomize with 3 seeds (0 failures; record the seeds)
- ./scripts/typecheck-bridge.sh --all (exit 0)
- ./scripts/lint.sh (clean, knip included)
- The dashboard: rm -rf /tmp/orch-state-copy && cp -R ~/.local/state/coding-agent-orchestrator /tmp/orch-state-copy, then run scripts/backfill_provider_errors.py against the copy (dry-run first, then a real run, then a second real run that must add 0 rows). Regenerate the dashboard from the copy, and confirm that the Provider health panel lists the 2026-09-26/27 Bedrock eu-west-2 outage windows.
Update bridge/README.md and CHANGELOG.md for Phase 0 and Phase 3 (failover + telemetry), and record the final counts in docs/superpowers/goals/run10-final.md. Commit both.

PHASE 5 — Merge into main, only if every Phase 4 check passed:
- In /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator, check that `git status --porcelain` is empty and that main is still at ed83b18, or is an ancestor of feat/telemetry-health.
- If main moved and the branch no longer contains it, STOP and report. Do not merge again without re-verifying.
- Otherwise run `git merge --ff-only feat/telemetry-health`, then `git log -1` and `git merge-base --is-ancestor feat/telemetry-health main` (it must exit 0).
- Do NOT push. Do NOT delete the branch or the worktree.
- If any Phase 4 check failed, skip Phase 5 and give the verdict NOT MERGED, with the reasons.

RULES (mandatory, from runs 4-9):
- No bash call longer than about 3 minutes. Never chain typecheck, lint and the full suite. Run the full suites ONLY through a subagent.
- One item per worker, with a file list and a stop condition. Split any worker that passes about 60 turns.
- At most 2 review rounds per item. Anything left goes under Open items.
- Do not touch core/text-safety.ts unless a test breaks.
- Commit after every item. After any interruption, re-read `git log` and continue from the last commit.
- No sleep/poll loops; never wait on CI. Headless; never block on human input.

FINAL REPORT:
- Commits per phase.
- The Phase 1 audit table.
- The conflict-resolution summary.
- Baseline (run9-baseline.md) vs final test counts, and the randomize seeds.
- Open items: hv4i5g evidence, N3 status, and anything left from the review rounds.
- The merge result: the SHA main points to, or NOT MERGED with the reasons.
- Operator steps: open a fresh HUMAIN Terminal or run /reload; run scripts/backfill_provider_errors.py on the real state dir (dry-run first, then real); push main when satisfied.

--profile openai --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
```

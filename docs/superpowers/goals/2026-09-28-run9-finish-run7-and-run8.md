# Run 9 — Finish run 7 and run 8 in one run

Workspace: `.worktrees/telemetry-health` (branch `feat/telemetry-health` = the `feat/lead-ci-wait` tip `4211028` + the run-8 goal doc `de99937`).

Superseded or cancelled attempts, which all duplicated each other: `ts61wr`, `kcqmbs` and `8zggvn`. None of them committed anything.

## How to launch (read this; flags were silently ignored last time)

`/orchestrate` only honours flags at the **start or end** of its text (`core/args.ts` `parseArgs`). If you type `/orchestrate` and then paste a block that also starts with `/orchestrate`, the second one becomes goal text and every leading flag is ignored. That is how runs `ts61wr`/`kcqmbs`/`8zggvn` ended up on the premium (Bedrock) profile with triage 10/high. The block below therefore repeats the flags on its **last line**, so they apply either way.

1. Make sure no other orchestration of this goal is running in any terminal.
2. `cd /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/telemetry-health && humain-terminal`
3. Paste the whole block below as your first input. Do not type `/orchestrate` first.
4. Check within 1 minute that the run log says `models (profile "openai")`, `triage: backend_refactor / complexity 7 / risk medium` and `worktree: …/.worktrees/telemetry-health`. If it doesn't, run `/orchestrate-cancel` and relaunch.

```
/orchestrate --profile openai --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
Finish run 7 and run 8 in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/telemetry-health (branch feat/telemetry-health). Specs: docs/superpowers/goals/2026-09-27-run7-finish-remaining.md (run 7) and docs/superpowers/goals/2026-09-28-run8-telemetry-tests-provider-health.md (run 8, Items 1-4 with evidence). Run 7 evidence: ~/.local/state/coding-agent-orchestrator/runs/ht-orch-1790587906124-md5zd6/lead-report.md. Read all three first. Do NOT redo committed work; check `git log --oneline a2e46cd..HEAD`.

WORKSPACE: This worktree only. Never edit the main checkout (the live extension is symlinked to it) or .worktrees/lead-ci-wait. Commit after each item passes its scoped tests. Do not merge or push.

PHASE 1 — Close run 7 (the lead report says it is not merge-ready):
1a. Verify: run typecheck, lint, bun test ./bridge and pytest as separate steps, with the full suites only through a subagent. Only the 3 known failures from docs/superpowers/goals/run5-baseline.md are allowed. Record the results in docs/superpowers/goals/run9-baseline.md and commit.
1b. B1 security sign-off. B1's second security review FAILED, and its fixes (1a93fd1, b45a385, e6416ed, 8198968, 1d11210) were never re-reviewed. Run ONE security review of the B1 diff (core/pending-checks + CI polling + the gating commits): argument-array CLI calls, strict id and repository validation, candidate-SHA binding, log-tail bounding, no credential leakage. Fix BLOCKING findings only, then run one confirm review. Also decide, and write down in the commit message, whether B1's cancellable timer is acceptable in place of RunSession's tick. Prefer switching to the tick if that is small.
1c. B4 replay gaps:
   (i) The u25qe4 replay must drive the injected glab/gh CLI through the parent-owned wait path (pending check → poll → pass → dependent wave runs), not call the poller directly.
   (ii) The vcy00z replay must be linked end to end with the QA-timeout path (the timeout is not reported as `unit`; QA is re-run).
   (iii) hv4i5g is evidence-blocked: the real tail has no nested provider error. Do NOT fabricate evidence. Replace it with a clearly labeled SYNTHETIC fixture (name it synthetic-provider-stall-*.jsonl, with a header comment saying it is synthetic and why), OR drop that replay and list it under Open items.
   Decide on the two untracked fixtures under fixtures/ from run 7: commit them if they are used, otherwise delete them.
   One technical review round per sub-item.

PHASE 2 — Run 8, Items 1-4, exactly as specified in the run-8 goal file:
Item 3 (test pollution, so the suite reaches 0 failures) → Item 1 (the record_id length limit) → Item 4 (provider-outage telemetry, the dashboard panel and the backfill) → Item 2 (delete the scoped_leads and recon_before_architect switches; rebuild file_ownership in report mode only).
Skip run 8's "STEP 0"; Phase 1 replaces it.

PHASE 3 — New item 5: stop /orchestrate from silently ignoring flags.
- Evidence: runs ht-orch-1790598554135-ts61wr, ht-orch-1790598815778-kcqmbs and ht-orch-1790599230233-8zggvn recorded goals that begin with "/orchestrate --profile openai --task-class …". parseArgs (core/args.ts ~83) only applies boundary flags, so a leading stray "/orchestrate" token turned every flag into goal text. The runs used the premium/Bedrock profile and triage set 10/high.
- Fix:
  - Strip one or more leading literal "/orchestrate" tokens before parsing.
  - If the goal text still STARTS with a run of known flags that were not applied (e.g. the goal's first tokens are "--profile openai --task-class …"), stop before triage, as the C7 context check does: say which flags were ignored and how to fix it, unless --force is given. Flags mentioned mid-prose (e.g. "`bun test --isolate`", "unless --force") must NOT trigger this; goal specs routinely quote flags.
  - Log the effective profile, complexity, risk and lead size in one line at run start.
- Tests:
  - "/orchestrate --profile openai --complexity 7 goal" parses the flags.
  - A goal whose text starts with unapplied flags stops with a clear message.
  - Mid-prose flag mentions do not stop the run.
  - --force proceeds.
  - Existing args tests still pass.

PHASE 4 — Docs and final verification:
- bridge/README.md and CHANGELOG.md for Phase 1-3.
- Verification: each check as its own subagent or step, with outputs included:
  - python3 -B -m pytest -p no:cacheprovider -q
  - bun test ./bridge (0 failures)
  - bun test --isolate ./bridge (0 failures)
  - bun test --randomize with 3 seeds (0 failures; record the seeds)
  - ./scripts/typecheck-bridge.sh --all
  - ./scripts/lint.sh
  - The dashboard regenerated with the backfill against a COPY of the state dir (/tmp/orch-state-copy) shows the 2026-09-26/27 Bedrock eu-west-2 outage windows. Never write to the real state dir.

RULES (mandatory, from runs 4-8):
- No bash call longer than about 3 minutes. Never chain typecheck, lint and the full suite. Run the full suites ONLY through a subagent.
- One item per worker, with a file list and a stop condition. Split any worker that passes about 60 turns.
- At most 2 review rounds per item (Phase 1b: 1 fix round and 1 confirm round). Anything left goes under Open items.
- Do not touch core/text-safety.ts unless a test breaks.
- Commit after every item. After any interruption, re-read `git log` and continue from the last commit.
- No sleep/poll loops; never wait on CI yourself. Headless; never block on human input.

FINAL REPORT:
- The commit list per phase and item.
- Baseline vs final test counts and the seeds.
- Open items, including the N3 recommendation: default cross-provider failover for lead/QA provider stalls.
- A merge-readiness verdict for feat/telemetry-health.
- Operator steps: merge to main, open a fresh HUMAIN Terminal or run /reload, then run the backfill on the real state dir (dry-run first).

--profile openai --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
```

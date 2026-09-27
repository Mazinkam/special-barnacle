# Run 7 — Finish the remaining work (A5b, A6/N2, B1–B4)

## State after run 6 (`ht-orch-1790509047474-hv4i5g`, 131m, $13.95)

Committed on `feat/lead-ci-wait`:
- `ab79eeb` A1: single pipeline.
- `00aaac6` A2: final-attempt lead counting, plus review fixes `3e24b5a` and `adb62d2`. `adb62d2` is UNREVIEWED.
- `0a59acb` A3: in-wave recovery.
- `2105dae` A4: QA timeout verdict.
- `791865c` A5/N1a: settle a child that ends but never exits.

Uncommitted in the worktree (A6 started by lead-1): `core/live-tree.ts`, `core/live-tree.test.ts`, and edits to `core/report.ts` and `pipeline/run-orchestration.ts`.

Why run 6 stopped:
- lead-1 was killed on inactivity during another Bedrock DNS outage (`ENOTFOUND bedrock-runtime.eu-west-2`).
- lead 3 was skipped. The run used `main`'s old orchestrator code, so the new A3 recovery was not active.
- QA failed immediately (`fetch failed`) and verified nothing.

## Before running (operator)

```bash
cd /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/lead-ci-wait
git add -A && git commit -m "wip(run6): A6 live-tree detection (unverified)"
nslookup bedrock-runtime.eu-west-2.amazonaws.com    # if this fails or flaps, use --profile openai below
```

Optional but recommended: make A1–A5a live first, so this run itself benefits from in-wave recovery and child settling.

1. Verify the branch: `./scripts/typecheck-bridge.sh --all`, `./scripts/lint.sh`, `bun test ./bridge` (no new failures vs `docs/superpowers/goals/run5-baseline.md`).
2. Then `git -C ../.. merge --no-ff feat/lead-ci-wait` from the main checkout.
3. Run `/reload` in a fresh HUMAIN Terminal.

Launch HUMAIN Terminal from inside `.worktrees/lead-ci-wait`.

Bedrock has failed DNS in runs 4, 5 and 6. If it is not reliable today, add `--profile openai` to the /orchestrate line below. That profile runs on Codex first and falls back to Bedrock.

Paste into HUMAIN Terminal:

```
/orchestrate --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
Finish the remaining run-5 items on branch feat/lead-ci-wait in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/lead-ci-wait. The full spec is docs/superpowers/goals/2026-09-27-run5-orchestrator-bugs-and-finish-run4.md; the rules and context are in docs/superpowers/goals/2026-09-27-run6-continue-run5.md (the run-6 goal). Read both. DO NOT redo items that are already committed.

WORKSPACE: This worktree only. Never edit the main checkout. Commit on feat/lead-ci-wait after each item passes its scoped tests. Do not merge or push.

ALREADY DONE and MERGED to main at 4b78097 (the orchestrator running this run already includes A1–A5a). Verify with `git log --oneline a2e46cd..HEAD`; do not redo: A1, A2 (+ 2 review fixes), A3, A4, A5/N1 part (a) in 791865c, and the A6 WIP in the latest "wip(run6)" commit.
Evidence of the last failure: ~/.local/state/coding-agent-orchestrator/runs/ht-orch-1790509047474-hv4i5g/ (lead-1 stderr and events: nested worker t11 went silent during ENOTFOUND bedrock-runtime.eu-west-2).

REMAINING WORK, in order, one commit per item:

1. Review adb62d2 (A2 review fix #2). One technical review round. Fix only BLOCKING findings.

2. A5/N1 part (b): provider_stall.
   - When a lead times out on inactivity, or ends with an error, and its recent events or nested-worker snapshots carry provider/network errors, classify it as provider_stall. Errors to match: ENOTFOUND, ECONNRESET, "fetch failed", "pending stream has been canceled", "stream ended without a stop reason".
   - Resume it once via resumeLeadPrompt. Count it as a resume, and make it share the one-recovery-per-lead budget from A3 (see the A3 rules in the run-6 lead report).
   - Put the nested worker's last turn, last text and last errorMessage in the diagnostic.
   - Reuse core/transient-error.ts and core/wait-stall.ts.
   - Also apply this to QA: a QA dispatch that fails with a provider/network error, and 0 tool calls, is re-run once, like the A4 timeout. It must never be reported as verification FAIL.
   - Fixtures: the tails of the vcy00z lead-0, s11yls lead-0 and hv4i5g lead-1 event logs, and the hv4i5g qa stderr.

3. A6 + N2: finish the WIP.
   - Known issue: typecheck currently FAILS on the WIP: core/report.test.ts(63) is missing the new required RunReport field `outOfTreeChangesLine`. Fix this first.
   - Check core/live-tree.ts against the spec: warn when the run repo contains the running extension, and report "changes outside run tree: <path>" when a lead's work lands in a different git tree than the run cwd.
   - Finish it, test it, commit it.

4. B1: parent-owned CI waiting.
   - Wire core/pending-checks.ts into pipeline/run-orchestration.ts.
   - The orchestrator polls glab/gh on the run/session tick: bounded calls, argument arrays, strict id regex, respects cancellation. Ceiling HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS, default 60m.
   - Dependent waves wait for the check to pass. On failure, pass the job id and log tail to the next dispatch. With no CLI or no auth, record "unverified external check".
   - Show pending checks in run-ui.ts / run/board.ts and in telemetry.

5. B2: wait_stall resume.
   - An inactivity timeout whose in-flight tool is a wait pattern resumes the lead once, on the same path and budget as provider_stall.
   - CI refs from extractCiRefs become pending checks (B1).

6. B4: replay tests with fixtures under bridge/extensions/orchestrator/fixtures/, using a fake clock / injected spawn only:
   - u25qe4: wait_stall → resume → pending check → dependents run.
   - vcy00z: provider_stall; retry counted; waves run; QA timeout is not `unit`.
   - s11yls: agent_end without exit → settled.
   - hv4i5g: lead-1 provider_stall → resumed → lead 3 still runs; QA provider failure → re-run, not FAIL.

7. B3: docs.
   - bridge/README.md "Dispatch timeouts": the inactivity knob is a stopgap; HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS; pending external checks; wait_stall and provider_stall; the child settle grace period.
   - A CHANGELOG.md entry covering A1–A6, N1, N2 and B1–B2.
   - Delete the dead live-QA helpers still in index.ts (liveQaKnownCostUsd, liveQaCostRowsHaveUnknownCost, composeVerificationVerdict, liveQaSummaryLines, buildLiveQaSummaryField, recordLiveQaStageResult) if they are unused. knip must stay clean.

RULES (mandatory; the same as run 6):
- No bash call longer than about 3 minutes. Never chain typecheck, lint and the full suite. Run the full `bun test ./bridge` and pytest ONLY through a subagent.
- One item per worker, with a file list and a stop condition. Split any worker that passes about 60 turns.
- At most 2 review rounds per item; anything left goes under Open items.
- Do not touch core/text-safety.ts unless a test breaks.
- Commit after every item.
- No sleep/poll loops; never wait on CI yourself.
- Headless; never block on human input.
- If a provider/network error interrupts you, re-read `git log` and continue from the last commit. Never redo committed work.

VERIFICATION (at the end, each as its own subagent or step; include the outputs):
- python3 -B -m pytest -p no:cacheprovider -q
- bun test ./bridge   (no new failures vs docs/superpowers/goals/run5-baseline.md)
- ./scripts/typecheck-bridge.sh --all   (exit 0)
- ./scripts/lint.sh
- The B4 replay tests pass.

FINAL REPORT:
- The commit list with the item each covers.
- Baseline vs final test counts.
- Open items: the unsupported efficiency switches (scoped_leads, file_ownership, recon_before_architect) and anything deferred.
- A recommendation on N3: should lead/QA provider failover away from Bedrock be the default?
- Operator steps to merge to main and /reload.
```

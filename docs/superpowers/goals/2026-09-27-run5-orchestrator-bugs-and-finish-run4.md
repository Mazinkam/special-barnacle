# Run 5 — Fix orchestrator bugs from run 4, then finish run 4

Background: run `ht-orch-1790447244195-vcy00z` (goal: `2026-09-26-run4-lead-ci-wait-stalls.md`) reported FAILED after 271 minutes and $23.75. lead-0 was killed by the inactivity watchdog during a Bedrock DNS outage, on a machine saturated by two orphaned `bun test` processes. It had also spent about two hours re-fixing `redactCredentials`. `lead-0-retry-1` then succeeded and QA retry 2 PASSED, yet the summary still said `leads 0/1 · verification: NOT RUN`, and leads 2 and 3 were never dispatched. The run also edited `main` directly, which is the tree the live extension is symlinked to.

## Before running (operator, once)

```bash
cd /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator
kill 51083 51099                      # orphaned 3-day-old `bun test` processes (verify with ps first)
git switch -c feat/lead-ci-wait
git add -A bridge docs/superpowers/goals
git commit -m "wip(run4): no-blocking-waits rule, wait-stall classifier, pending-checks parser, redaction"
git switch main
git worktree add .worktrees/lead-ci-wait feat/lead-ci-wait
```

Confirm Bedrock is reachable. Then start HUMAIN Terminal **inside `.worktrees/lead-ci-wait`**, so the run edits the branch while the live extension keeps loading from the clean `main`.

Paste into HUMAIN Terminal:

```
/orchestrate --task-class backend_refactor --complexity 8 --risk medium --lead-size standard
Fix the orchestrator bugs exposed by run ht-orch-1790447244195-vcy00z, then finish the run-4 goal (docs/superpowers/goals/2026-09-26-run4-lead-ci-wait-stalls.md), in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/.worktrees/lead-ci-wait (branch feat/lead-ci-wait).

WORKSPACE: Work ONLY in .worktrees/lead-ci-wait on feat/lead-ci-wait. Never edit the main checkout (/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator itself); the live extension is symlinked to it. Commit at the end of each part on feat/lead-ci-wait. Do not merge or push.

EVIDENCE: ~/.local/state/coding-agent-orchestrator/runs/ht-orch-1790447244195-vcy00z/
- run.log: lead-0 killed at 21:49 (exit 124, inactivity). QA #1 "dispatch timed out after 20min (capability=qa_agent)", then logged as "verification failed: `unit`", which triggered the escalation. lead-0-retry-1 done at 22:41. QA retry 2 PASS at 22:58. The final summary still says FAILED, leads 0/1, verification NOT RUN, and waves 2 and 3 were never started.
- lead-0.events.jsonl, the last ~35 lines: nested worker tooluse_HDJUld7T5KjZBKhq0ogVfS-0 snapshots carry errorMessage "getaddrinfo ENOTFOUND bedrock-runtime.eu-west-2.amazonaws.com" and later "Bedrock stream ended without a stop reason", then go silent.

BASELINE FIRST: Before any change, run `bun test ./bridge` and `python3 -B -m pytest -p no:cacheprovider -q` on the branch. Record exactly which tests already fail; the retry lead reported 3 pre-existing failures (live-qa perf, plus duplicate-named tests in index.test.ts and run/session.test.ts). "Green" below means no new failures relative to that baseline. Also fix those 3 if the cause is clear and the fix is small; otherwise list them under Open items.

PART A — Orchestrator bugs (do first; Part B depends on A1)

A1. Two /orchestrate pipelines exist; the tested one is dead.
    - index.ts registers its own inline /orchestrate (pi.registerCommand("orchestrate") at ~5854, running through ~6575). It does NOT use commands/orchestrate.ts → pipeline/run-orchestration.ts, pipeline/hierarchy.ts or pipeline/verify-loop.ts. Fixes made in the modular copy (e.g. skipping QA when no lead succeeded, the C5 QA-timeout verdict) never run.
    - Make the modular pipeline the only implementation. Diff the two and port into the modular side everything that exists only inline: at least the Phase 3 live-QA stage / composeVerificationVerdict, qaScopeEvidenceFor, the git-snapshot fallback logging, and the resume path.
    - Then register /orchestrate through commands/orchestrate.ts and delete the inline copy.
    - Add a test that fails if index.ts again contains an inline orchestrate pipeline, i.e. /orchestrate must delegate to runOrchestration.
    - Keep /orchestrate-cancel, /orchestrator-models, /orchestrator-roi and /omsg behavior unchanged.

A2. A lead that succeeds on retry is not counted.
    - succeededLeads/dispatchOk count only leadResults, so a lead that failed and then succeeded as lead-N-retry-K still counts as failed.
    - Compute per-lead final status from its last attempt (original, resume or escalation).
    - The summary must show e.g. "lead-0: failed (inactivity) → retry-1 succeeded". The verification line must reflect the last QA verdict, and firstFailure must not be presented as the reason for the run outcome when a later attempt succeeded.

A3. Dependent waves never start after a failed lead is recovered.
    - Waves 2 and 3 were skipped when lead-0 failed. When lead-0-retry-1 later succeeded, they were never dispatched. The retry lead's prompt also claimed "Leads 2 and 3 are still changing the same tree", which was false.
    - Fix: recover a failed lead (resume or retry) inside its own wave, before dependent waves are evaluated. Only mark dependents "not started" if recovery also fails.
    - Retry and resume prompts must state the real state of the other leads.
    - Cover this in pipeline/hierarchy.test.ts.

A4. A QA timeout is reported as a check failure.
    - A QA dispatch with outcome timed_out must produce a distinct verdict ("QA TIMED OUT"), never failedChecks like `unit`, and must NOT trigger a lead escalation.
    - Re-run QA once. Tell the re-run to use scoped test commands and to avoid filesystem-wide `find /`; QA #2 of the old run did `find / -maxdepth 8`.
    - If the re-run also times out, finish with that verdict.

A5. Stalls caused by provider errors are not treated as transient.
    - When a lead times out on inactivity and its latest nested-worker snapshots, or its own stderr, carry provider/network errors (ENOTFOUND, ECONNRESET, "stream ended without a stop reason", "pending stream has been canceled"), classify the timeout as "provider_stall".
    - Reuse core/transient-error.ts and the classifier in core/wait-stall.ts.
    - Resume once with a "## Resume" section via resumeLeadPrompt. Count it as a resume, not a verification retry.
    - Include the nested worker's last turn, last text and last errorMessage in the timeout diagnostic.
    - Other timed_out outcomes keep their current behavior.

A6. The run edits the live orchestrator.
    - At run start, compare realpath(cwd's repo root) with the realpath of the loaded extension directory (this file's own location). If the run's tree contains the running extension, log a prominent warning and record a `live_extension_tree` event.
    - Warn only; do not block.

PART B — Finish run 4 (read the run-4 goal file for full requirements; already on the branch: core/wait-stall.ts, core/pending-checks.ts, toolInFlight plumbing, the NO_BLOCKING_WAITS_RULE prompt/persona rule, redaction)

B1. (run-4 deliverable 2) Parent-owned CI waiting.
    - Wire the core/pending-checks.ts parser into the unified pipeline.
    - The orchestrator polls glab/gh on its own timer, reusing run/session ticks: bounded calls, argument arrays, strict id regex, respects cancellation.
    - Ceiling: HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS, default 60m.
    - Dependent waves wait for a pending check to pass. On failure, the failing job id and log tail go to the next dispatch.
    - With no CLI or no auth, record "unverified external check".
    - Show pending checks in run-ui.ts / run/board.ts and in telemetry.

B2. (run-4 deliverable 3) Wire wait_stall resume.
    - On an inactivity timeout whose in-flight tool is a wait pattern: resume the lead once. Any CI refs from extractCiRefs become pending checks (B1).
    - Share the resume-once path with A5.

B3. (run-4 deliverable 4) Docs.
    - bridge/README.md "Dispatch timeouts": HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS as a stopgap only, plus HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS.
    - Pending external checks, wait_stall and provider_stall.
    - A CHANGELOG.md entry covering Parts A and B.

B4. Replay tests using trimmed fixtures (committed under bridge/extensions/orchestrator/fixtures/).
    - (a) The u25qe4 lead-0 CI-poll shape: wait_stall → resumed once → pending check recorded → downstream wave proceeds once the check passes.
    - (b) The vcy00z shape: nested worker with provider errors, then silence → provider_stall → resumed once. Also: a retry that succeeds is counted (A2), dependent waves run (A3), and a QA timeout is not reported as `unit` (A4).
    - Use a fake clock / injected spawn, with no real sleeps or network.

CONSTRAINTS:
- DO NOT reopen credential redaction (core/text-safety.ts). It is fail-closed and was reviewed four times. Only touch it if a test in this run breaks. Security review in this run covers the new trust boundaries only: CI CLI invocation, id validation, and report parsing.
- Cap re-review loops: at most 2 review rounds per sub-task. Anything still open after that goes to Open items; do not keep iterating.
- Leads must follow the no-blocking-waits rule themselves: no sleep/poll loops, no single command expected to run longer than about 3 minutes. Run scoped `bun test <files>` while iterating and the full suites only at the end of each part.
- Reuse existing modules and seams; keep diffs small. Deleting the inline index.ts pipeline is expected and is not "big-bang" scope creep.
- Don't weaken the watchdog for non-wait, non-provider stalls, and don't raise the defaults.
- Leads run headless; never block on human input.

VERIFICATION (must pass on feat/lead-ci-wait; include the output in the final report):
- python3 -B -m pytest -p no:cacheprovider -q
- bun test ./bridge            (no new failures vs BASELINE)
- ./scripts/typecheck-bridge.sh --all   (exit 0)
- ./scripts/lint.sh
- The B4 replay tests pass.

FINAL REPORT:
- Commits on feat/lead-ci-wait, with files changed per item (A1–A6, B1–B4).
- The baseline vs final test counts.
- Anything deferred, under Open items.
- A short operator note on how to merge to main and /reload safely.
```

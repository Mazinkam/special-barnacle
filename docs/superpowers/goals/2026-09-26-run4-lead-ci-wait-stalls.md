# Run 4 — Lead CI-wait stalls

Prerequisite: none beyond current `main` (8a9c3a9 or later).
Trigger incident: run `ht-orch-1790444514415-u25qe4`. lead-0 was killed by the inactivity watchdog (exit 124) while it ran a silent 40-minute CI poll loop, after it had already merged MR 163. Downstream waves and verification never ran.

Before running this: recover u25qe4 by hand. Check pipeline 219469. If it passed, re-dispatch only the blocked downstream waves and verification, with "MR 163 merged" as context. If it failed, dispatch a fix with the failing job log.

Paste into HUMAIN Terminal:

```
/orchestrate --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
Stop orchestrated leads from dying on the inactivity watchdog while they wait on CI, and recover correctly when it does happen, in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator.

WORKSPACE: Create a new git worktree at .worktrees/lead-ci-wait on a new branch feat/lead-ci-wait from current main. Do all work there. Do not merge or push.

INCIDENT (evidence): Run ht-orch-1790444514415-u25qe4. lead-0 merged MR 163 successfully (lead-0.events.jsonl:754). It then ran one silent bash poll of pipeline 219469: `for i in $(seq 1 40) ... sleep 60`, with a tool timeout of 2700s (events.jsonl:909-912). At 20 minutes with no meaningful progress, the orchestrator killed it (run.log:79-100). The lead was marked "UNVERIFIED PARTIAL WORK — inactivity", verified:false, exit 124. The downstream lead waves and final verification never ran. State dir: ~/.local/state/coding-agent-orchestrator/runs/ht-orch-1790444514415-u25qe4/.

ROOT CAUSE: In bridge/extensions/orchestrator/dispatch-progress.ts, a bash command only counts as progress when it finishes ("tool execution completed"). Streamed tool_execution_update output counts only when it carries nested subagent results; otherwise it is a heartbeat. So any single shell command that runs longer than HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS (default 20m) is killed, however much it prints. The C3 resume path (index.ts ~3313) excludes timed_out, so the lead was not resumed.

DELIVERABLES (all four are required):

1. Prompt/persona rule: no blocking waits.
   - Edit bridge/agents/orchestrator-lead.md, the architect/technical-lead personas in bridge/agents/, and the lead prompt builders in bridge/extensions/orchestrator/core/prompts.ts. Add an explicit rule:
     never run sleep/poll/watch loops or any single command expected to run longer than about 3 minutes. Examples to name: `sleep` in a loop, `glab ci status --live`, `gh run watch`, `until ...; do sleep`.
     To check CI, run one bounded status command (e.g. `glab ci get -p <id>` / `gh run view <id>`) and move on.
     If CI is still running when all other work is done, stop. List the pipeline/run id and MR under a new "## Pending external checks" section of the final report. Do not wait.
   - This implements goal B2 in docs/superpowers/goals/2026-09-25-run2-lead-efficiency-and-model-canaries.md.
   - Update prompts.test.ts / persona tests so the rule and the new report section are asserted.

2. Move CI waiting out of leads (parent-owned).
   - Parse "## Pending external checks" from the lead report (see lead-handoff.ts / core/report.ts for existing report parsing).
   - The orchestrator (not an LLM lead) polls each pending check with bounded, non-shell-blocking calls on its own timer, reusing the existing tick/heartbeat machinery in dispatch/child-process.ts and run/session.ts. No new busy loops.
   - It respects cancellation (cancellation.ts) and a configurable ceiling: HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS, default 60m.
   - Downstream lead waves that depend on the lead wait for the check to pass. On failure, the failing job id and log tail go to the next lead or fix dispatch as context.
   - Support GitLab (glab) and GitHub (gh). If neither CLI is available or authenticated, record the check as "unverified external check" in the report instead of failing the run.
   - Show pending checks in the run UI/board (run-ui.ts, run/board.ts) and in telemetry.

3. Classify and recover wait stalls.
   - When a lead times out on inactivity while its in-flight tool is a recognized wait pattern (same list as rule 1), classify it as "wait_stall", not as a lead or task failure. Do this in a small pure module next to core/transient-error.ts, consistent with the timeoutReason/toolInFlight AttemptSignals design in docs/superpowers/plans/2026-09-25-model-failover.md. Do not implement the whole failover plan.
   - On wait_stall: resume the lead once. Include a "## Resume" section (reuse resumeLeadPrompt) stating what it already completed, from its events and the files it changed, and that it must not re-wait. Any CI id found in the killed command becomes a pending external check (deliverable 2). Count it as a resume, not a verification retry. Show it in the summary.
   - Every other timed_out/cancelled/spend_cap outcome keeps its current behavior.
   - Tests: the wait_stall classifier (positive and negative cases, including a plain `tail -500` that is NOT a wait), resume-once behavior, and no resume for non-wait timeouts. Use a fake clock / injected spawn; add no new sleep-based tests.

4. Timeout knob, as a documented stopgap.
   - Keep HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS. Make the watchdog warning and the timeout message (dispatch-progress.ts ~478 and ~507) say when the in-flight tool looks like a wait pattern, and point to "Pending external checks" rather than only suggesting a higher timeout.
   - Document the knob and the new HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS in bridge/README.md ("Dispatch timeouts"). State clearly that raising the inactivity timeout is a stopgap only, because it also hides leads that are really stuck.
   - Add a CHANGELOG.md entry.

CONSTRAINTS:
- Reuse existing modules (dispatch-progress, lead-handoff, transient-error, resumeLeadPrompt, run/session ticks). Keep changes small and behind existing seams.
- Don't weaken the inactivity watchdog for non-wait stalls. Don't raise the defaults.
- Put no credentials in logs or reports. Invoke CI CLIs with argument arrays, not shell strings built from report text. Validate pipeline/run ids against a strict regex, because report text is untrusted.
- Leads run headless. Nothing may block on human input.
- Leads in THIS run must follow rule 1 themselves: no sleep/poll loops.

VERIFICATION (must pass; include the output in the final report):
- python3 -B -m pytest -p no:cacheprovider -q
- bun test ./bridge
- ./scripts/typecheck-bridge.sh --all   (exit 0)
- A replay-style test using a trimmed fixture shaped like the u25qe4 lead-0 events. Assert that the old behavior gives timed_out/blocked and the new behavior gives wait_stall → resumed once → pending check recorded → downstream waves proceed once the check passes.

FINAL REPORT: files changed per deliverable, test evidence, anything deferred under "Open items", and a one-paragraph operator note on how to rerun the blocked u25qe4 waves. That rerun is: check pipeline 219469, then re-dispatch only the downstream waves and verification, with "MR 163 merged" as context.
```

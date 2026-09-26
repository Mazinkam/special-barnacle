# Run 3 — Forge live-QA adapter

Prerequisite: run 2 (`feat/lead-efficiency`) merged. This run changes the same QA phase and depends on run 1's quality_evidence emission.
Start from `main` after that merge. Proving the adapter needs Docker running and a free Forge QA slot (slot 0; slot 1 is blocked by the fixture-reset allowlist).

Paste into HUMAIN Terminal:

```
/orchestrate --task-class backend_refactor --complexity 7 --risk medium --lead-size standard
Make the orchestrator's QA phase run a repository's own live QA agent, starting with Forge, in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator.

WORKSPACE: Create a new git worktree at .worktrees/repo-qa-adapter on a new branch feat/repo-qa-adapter from current main. Do all work there. Do not modify /Users/abdulkarim/Documents/Projects/forge beyond what its QA runner itself creates in its own worktrees and slots. Do not merge or push.

CONTEXT: The orchestrator's orch-qa-agent (bridge/agents/orch-qa-agent.md) only runs the typecheck, unit, integration and lint commands the architect declares. Forge ships a separate live QA agent: scripts/qa (see scripts/qa/README.md, qa/dogfood.md, qa/journeys/*.md, qa/known-issues.json). `bun qa run focused "<scope>" --ref <sha> --slot <n> --budget <min> --runtime <codex|humain-terminal> --model <m> --effort <e> --local` creates an isolated worktree and port slot, seeds the stack, drives a real browser, runs scanners, and writes durable session artifacts under qa/sessions/. Nothing connects the two today.

1. Per-repo QA adapter. A repository declares its live-QA command and a scope template in a small config file that the orchestrator reads (choose the location and schema; keep it minimal). Add the Forge declaration.
2. QA phase integration. When an adapter exists and the architect or triage marks the change as user-facing, the QA phase runs the adapter as a proper metered dispatch after the generic checks, deriving a focused scope from the goal and changed files. Generic QA still runs for everything.
3. Preflight. Check Docker, the required browser image and a free slot before starting. If a check fails, report "live QA unavailable: <reason>". Never report a silent pass, never clean another run's slot, and never bypass Forge's guards.
4. Verdict. Parse the Forge session report into PASS/FAIL with findings and artifact paths. Feed the verdict into the run's verification result and quality_evidence_score. Attribute the QA session's cost to the run (link the ingested Codex or HUMAIN Terminal session, or record it directly) and never count it twice.
5. Budget and timeouts. Respect the adapter's own session budget and do not add a second timeout on top of it (Forge's scripts/qa rule).

QUALITY GUARD: A live-QA FAIL fails verification exactly like any other QA FAIL. "Unavailable" is reported as unverified, never as passed.

VERIFICATION: Unit tests for adapter config parsing, scope derivation, preflight outcomes, report parsing (pass, fail and unavailable), and cost attribution without double counting. Bun and Python suites green. Then one real end-to-end check against Forge on slot 0 with a small low-risk scope (for example the Authentication journey with no builds), and report the session path and verdict. If Docker or the slot is unavailable, report that and stop; do not fake the check.

REPORT: branch, worktree path, changed files, test results, the end-to-end session path and verdict (or the reason it could not run), and anything deferred.
```

# Run 2 — lead efficiency, cheap recon, model canaries

Prerequisites: run 1 (`feat/telemetry-fixes`) merged; `feat/model-failover` merged, because B6 touches `models.ts` and profile parsing.
Start from `main` after those merges.

Paste into HUMAIN Terminal:

```
/orchestrate --task-class backend_refactor --complexity 9 --risk medium --lead-size large
Cut orchestration cost without lowering verification quality, in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator. Expensive roles judge; cheap roles look things up.

WORKSPACE: Create a new git worktree at .worktrees/lead-efficiency on a new branch feat/lead-efficiency from current main. Do all work there. Do not touch the main checkout (preserve its uncommitted changes) or any other worktree. Do not merge or push.

EVIDENCE (state dir ~/.local/state/coding-agent-orchestrator, runs/): 95 lead dispatches cost $200.70 of their own spend and made 1,988 bash calls, 142 reads and 41 edits against 258 subagent dispatches, although the orchestrator-lead persona says it never edits. 43 architect dispatches made 266 of their own ls/grep/read/bash calls, because the architect runs BEFORE parent-owned recon (triage → architect → recon → leads; see runs/ht-orch-1790193397618-nmac8d/run.log). 77 recon scout dispatches did 1,143 read-only lookups for $0.41 in total. In nmac8d, lead-1 ran 72 turns with context growing to about 120k tokens re-read every turn, made 61 bash calls including `sleep 90` polling against only 6 subagent calls, and three parallel leads edited the same function (RunSession.recordProgress) repeatedly.

Put every behaviour change behind a feature in orchestrator/feature_schema.json and features.py. Defaults: recommend or canary, never silently on. Each feature must have a kill switch.

R1. Run parent-owned recon before the architect. The architect and all leads receive the same bounded recon evidence packet. Keep the existing exemptions and cancellation checkpoints.
B1. Delegation budgets for the architect and leads. Allow a small number of targeted reads for checking a specific file or line. Broad exploration (grep, find, ls, multi-file reads) and follow-up questions go to an on-demand scout dispatch; test runs go to qa; diff review goes to the review roles. Enforce a configurable own-tool budget per role: past the budget the role is told to delegate, and the dispatch is not killed. Enforce the lead persona's tool allow-list (no edit/write) and find out why leads could edit.
B2. No polling. Remove or discourage sleep/poll loops in lead and architect prompts and personas. Leads wait on subagent completion or events.
B3. Phase-scoped leads. Split a lead into plan → integrate → report phases. Each phase starts a fresh session from a structured handoff note built with the existing context-packet mechanism: decisions, dispatched work and results, open questions, and pointers to full logs a phase may fetch. Use a single long lead as the fallback for tightly coupled tasks and whenever the feature is off.
B4. Parallel leads never own the same files. Planning assigns each lead a non-overlapping set of files (ownerPaths). When coupling is high, fall back to a single lead. Emit merge_conflict and decision_invalidated, which currently have no emitter.
B5. Per-dispatch lead and architect telemetry: turns, peak context tokens, own tool calls against delegated dispatches, polling turns, and phase (B3).
B6. Per-capability model canaries. Add an optional `canaries` block to profiles in bridge/orchestrator-profiles.json: {capability or tier: {model, percentage}}. Assignment is deterministic by run id and reuses adaptive.should_canary semantics. The candidate must pass the same model requirements as a failover backup (method.json rules.model_requirements), and a canary never lowers the tier. Record canary=true, baseline_model and candidate_model on every affected metric row. Show a dashboard comparison per capability of baseline against candidate: runs, cost per run, verification pass rate and delayed bad outcomes. Configure the premium profile with:
  - premium tier capabilities that bind to the premium tier primary (lead, architect, analysis_strong; not security_review, which has its own binding): candidate gpt-5.6-sol, 25%.
  - implementation_fast and implementation_strong: candidate gpt-6-sol, 25%.
  Pin the provider order openai-codex, then amazon-bedrock. Never use humain-node/gpt-5.6-sol (no reasoning support). Validate with `/orchestrator-models validate --live` or the equivalent resolver path.

QUALITY GUARD: Do not change model tiers or primaries (only canary shares), verification depth, review_after_fix rules, QA requirements or spend-cap actions. Document how to compare canary and baseline cohorts using verification pass rate and delayed outcomes, and the rule for turning a feature or canary off.

VERIFICATION: Python and Bun tests for R1 and B1–B6 (`cd bridge && bun test extensions/orchestrator`). Full suites green, with no timing-flaky tests (use wide margins). Include tests proving phase handoff preserves decisions and open questions, budgets nudge rather than kill, ownerPaths never overlap, canary assignment is deterministic and never lowers the tier, and canary rows are labelled. Regenerate the dashboard from a copy of the state dir; never write to the live state dir.

REPORT: branch, worktree path, changed files per item, test results, feature flags added with their defaults, canary configuration, how to compare cohorts, and anything deferred.
```

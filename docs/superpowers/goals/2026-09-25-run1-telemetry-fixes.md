# Run 1 — telemetry fixes

Prerequisite: none. Start from current `main`.
Next: run 2 starts after this branch is merged.

Paste into HUMAIN Terminal:

```
/orchestrate --task-class backend_refactor --complexity 7 --risk medium --lead-size large
Fix the orchestrator telemetry bugs so spend, run status and quality are measured correctly, in /Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator.

WORKSPACE: Create a new git worktree at .worktrees/telemetry-fixes on a new branch feat/telemetry-fixes from current main. Do all work there. Do not touch the main checkout (preserve its uncommitted changes), .worktrees/model-failover or .worktrees/modular-refactor. Do not merge or push.

EVIDENCE (state dir ~/.local/state/coding-agent-orchestrator): dispatch_finished events carry nested_cost_usd totalling $154.65 that never appears as metrics.jsonl model_call rows. The dashboard shows humain-terminal spend as $194 when it is about $350, and "coordination 72%" is an artifact of that gap. In run runs/ht-orch-1790193397618-nmac8d the lead's own per-turn usage sums exactly to its recorded cost_usd, and none of its subagent calls are recorded. 104 of 193 runs are "incomplete" (46 at $0), and only 9% of runs have a duration. quality_evidence_score is never emitted by live runs, so adaptive routing has history_sufficient=0% and all 122 decisions are recommended_only. Rate provenance shows source=null for gpt-5.6-sol, gpt-5.6-terra and sonnet although orchestrator/config.json defines some of them.

A1. Record every nested subagent call as a model_call metric row with parent_task_id, run_id, role/capability (derived from the agent name: orch-scout→scout, orch-implementation-strong→implementation_strong, and so on), model, provider, tokens, cost_usd and cost_source. Never count anything twice: parent-lead rows remain own-cost only. Update economics, dashboard and run_evidence so totals, cost by role, cost by runtime and the coordination rate include nested spend, clearly labelled. Add a scripts/ backfill that holds the existing writer lock, replaces files atomically, reconstructs nested rows from runs/*/ event logs (falling back to dispatch_finished.nested_cost_usd when per-call detail is missing), tags them backfilled, and is idempotent.
A2. Every run must reach a terminal state. Emit run_finished, run_failed or run_cancelled with started_at, finished_at and elapsed_ms on normal exit, failure, Esc/Ctrl+C, /orchestrate-cancel, crash and session shutdown. Add a classifier for existing runs that are stale and have no live process (status "abandoned") so the dashboard stops showing them as incomplete.
A3. Emit quality_evidence_score when a live run's verification completes, derived from the existing verification signals (review and QA verdicts, test results) by reusing engine.Engine.verify_task logic, with no new scale. Confirm adaptive history counts these rows so history_sufficient can become true.
A4. Fix the dashboard rate-provenance lookup and alias handling so a model with a config.json rate reports its source.

QUALITY GUARD: Do not change routing, model tiers, verification depth, review or QA requirements, or spend-cap actions.

VERIFICATION: Python tests for A1–A4 and the backfill (including idempotency and no double counting). Bun tests: `cd bridge && bun test extensions/orchestrator`. Full suites green, with no timing-flaky tests (use wide margins). Copy the state dir to a temp dir, run the backfill and regenerate the dashboard there, and report before/after figures for total spend, cost by role, coordination rate, run status counts, and verification and duration coverage. Never write to the live state dir.

REPORT: branch, worktree path, changed files per item, test results, before/after numbers, and anything deferred.
```

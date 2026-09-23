# Harness Integration

The package intentionally does not know how Codex, Claude Code, or another harness spawns subagents. The harness adapter owns those mechanics.

## Minimal loop

1. Construct `OrchestrationEngine`.
2. Call `plan_run(...)`.
3. Read the returned topology and compute package.
4. Resolve the abstract capability/effort through `Adapter.resolve(...)`.
5. Spawn the appropriate agent using the harness API.
6. Record every model call with `record_model_call(...)`.
7. Run deterministic verification and cache valid results with `VerificationCache`.
8. Build `QualityEvidence` and call `verify_task(...)`.
9. Escalate only the failing task if the evidence does not meet policy.
10. Call `complete_run(...)` or `fail_run(...)`.

## Adapter responsibilities

A real adapter should advertise:

- available capabilities/models
- effort-level support and mapping
- max context
- subagent support
- parallelism limits
- tool permissions
- worktree/sandbox support
- usage telemetry availability
- model/provider version identifiers when available

Do not assume effort names are portable. Translate the orchestrator's abstract effort levels into the harness/provider's supported controls.

## HUMAIN Terminal session usage

The installed bridge ingests saved assistant usage from `~/.humain-terminal/agent/sessions/<project>/*.jsonl` after `agent_settled` (3-second debounce, up to three attempts with 250 ms exponential backoff) and flushes on `session_shutdown`. The login/15-minute discovery sweep catches missed events. Message text is not ingested; ephemeral `--no-session` work is outside this path.

The generated dashboard refreshes every five seconds while visible, preserves scroll position, and has a pause/resume control. To load updated extension hooks into a running HUMAIN Terminal, run `/reload` or restart the session.

## Workspaces

`WorkspaceManager` provides Git worktree hooks and ownership locks. A production adapter may substitute native sandbox/branch isolation, but it should retain the same provenance fields: base revision, result revision, owner, and merge result.

## History

Historical routing only becomes authoritative with sufficient comparable samples. Until then, the scheduler uses conservative priors and reports sample size. Do not silently promote learned routing into global policy; evaluate policy changes separately.

# HUMAIN Terminal Bridge — Hierarchical Agent Orchestrator

This directory holds the HUMAIN Terminal (HT) side of the orchestrator integration.
The Python runtime lives at `../orchestrator/`; together they form one skill that
HT loads at runtime.

## Layout

```
bridge/
├── README.md                          (this file)
├── extensions/
│   ├── orchestrator.ts                the /orchestrate extension
│   ├── orchestrator-README.md         orchestrator-specific install notes
└── agents/
    ├── orchestrator-lead.md           hierarchical lead (drives fan-out)
    ├── orch-architect.md
    ├── orch-implementation-strong.md
    ├── orch-implementation-fast.md
    ├── orch-worker.md
    ├── orch-scout.md
    ├── orch-technical-lead.md
    ├── orch-technical-review.md
    ├── orch-security-review.md
    └── orch-qa-agent.md
```

## Install

From the skill repo root:

```bash
./install.sh           # install (idempotent)
./install.sh --uninstall   # remove the managed symlinks
```

The script symlinks the contents of `bridge/extensions/` into
`~/.humain-terminal/agent/extensions/` and `bridge/agents/` into
`~/.humain-terminal/agent/agents/`. Existing non-symlink files are left alone
(refusing to overwrite protects any in-flight edits); move them away and re-run
if you want the symlink to land.

It also copies the shipped model profiles, `bridge/orchestrator-profiles.json`
(active profile `premium`; also `anthropic`, `openai`, `oss`), to
`~/.humain-terminal/agent/orchestrator-profiles.json`. A missing file is
installed; a legacy file (the retired `default` profile, or no `frontier` tier)
is backed up to `orchestrator-profiles.json.bak-<UTC>` and replaced; a file you
have edited since is kept unless you run
`HUMAIN_ORCHESTRATOR_RESET_PROFILES=1 ./install.sh`.

Triage sizes the lead from the task (`lead_small` → mid tier, `lead` → premium,
`lead_large` → frontier); override with `/orchestrate <goal> --lead-size small|standard|large`.
See `extensions/orchestrator-README.md` for profiles, the spend cap, and the
codex → Bedrock quota fallback.

Override the install target with `HUMAIN_TERMINAL_AGENT_DIR`:

```bash
HUMAIN_TERMINAL_AGENT_DIR=/tmp/test-agent ./install.sh
```

After install, restart HT (or `/reload`) to pick up the new commands:

```
/reload
/orchestrate <goal> [--task-class T] [--complexity N] [--risk R] [--fan-out] [--max-retries N]
/orchestrator-roi
```

## Dispatch timeouts

Orchestrating capabilities (`lead`, `architect`, and `technical_lead`) use a progress-aware inactivity limit plus an absolute ceiling. `HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS` changes the no-progress limit (default: 20 minutes); raising it is only a stopgap, not a way to make leads wait on CI. Leads should report checks under `## Pending external checks` and finish rather than poll or sleep. The parent may poll supported GitHub/GitLab checks on session ticks, bounded by `HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS` (default: 60 minutes). Pending-check status and CLI/auth behavior have not been independently verified against live providers; unavailable or unrecognized results remain unverified, not passes. Parent-owned CI uses argument-array CLI calls, validates repository/check identifiers and bounds failed-job log tails; dependent waves require checks bound to the candidate SHA and repository. Truncated reports and a stale candidate gate fail closed. The bounded cancellable timer is retained instead of a RunSession tick. Fixture replay covers the parent wait → poll → dependent-wave path and QA timeout → retry, but is not live CI verification. The historical hv4i5g lead-1 tail lacks nested provider-error evidence, so its provider-stall replay is deferred, not claimed as verified.

`HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS` changes the absolute orchestrating-dispatch ceiling (default: 6 hours). The legacy `HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS` supplies that ceiling's default only when the newer variable is unset. A `wait_stall` (inactivity timeout while a wait-like tool is active) and a `provider_stall` each use the shared one-resume-per-lead recovery budget; a failed resume does not get another retry. Leaf dispatches keep their separate fixed timeout. A child that emits its terminal `agent_end` but does not exit is given a post-end settle grace of 30 seconds by default; configure it with `HUMAIN_ORCHESTRATOR_POST_END_GRACE_MS`.

## Run 9 operational notes

- `/orchestrate` strips leading duplicate command tokens and guards against unapplied known flags at the start of a goal (unless `--force`); flags quoted mid-prose stay prose. Effective profile, task class, complexity, risk and lead size/count are logged after triage/sizing, not guessed before triage.
- Normalized `dispatch_health` and `provider_error` telemetry records provider failures, including recurring nested errors after recovery, without counting unchanged event snapshots twice. The dashboard shows bounded provider health over seven days; absence of an error row is not proof of provider availability. Long nested model-call IDs are bounded to Python's batch limit, preserving stable replay IDs. Bridge test pollution from canonical JSON imports/randomized telemetry assertions was addressed; this is not a claim of a clean randomized run without running it.
- Unsupported `scoped_leads` and `recon_before_architect` switches were removed. `file_ownership` supports `off`/`report`, not serialization: `lead_edit_conflict` reports overlapping explicit lead file claims only with run-wide Git change evidence. This cannot prove which lead wrote the file, and does not gate scheduling.
- Legacy provider-error backfill is **operator opt-in**. From the repo root, first run `python3 scripts/backfill_provider_errors.py --state-dir /path/to/state-copy` (dry-run). Inspect candidates and source logs, then, only against an explicitly chosen **copy**, run `python3 scripts/backfill_provider_errors.py --state-dir /path/to/state-copy --write` and regenerate its dashboard with `CODING_AGENT_ORCHESTRATOR_HOME=/path/to/state-copy python3 -m orchestrator.cli dashboard`. `--write` rejects the live default state root; do not treat a dry-run or synthetic fixture as verified real-outage evidence. A real outage window requires inspecting the regenerated dashboard against the copied historical logs before making that claim. Do not write to live state during verification.

## Run 10 operational notes

- The run summary explains `STATUS: partial` lead results as **Orchestration partial**, includes the code-verification verdict, a **why partial:** explanation, and up to five **what still needs action:** bullets, while hiding the raw STATUS line. BLOCKED/FAILED take precedence; full-report mode omits the action list.
- CI's pending-check gate fails closed for any parser problem (`unparsed_checks`), not only truncated reports (B1, `b53c69c`).
- Phase 3 merged main's modular model failover with telemetry. `core/failure-class.ts` `classifyFailure` and shared `attemptSignals()` drive both failover and `dispatch_finished.failure_class`; `telemetryFailureClass()` maps telemetry names (stall → `provider_stall`; timed-out transient → `provider_stall`), while `wait_stall` comes from `classifyTimeout`. Unexplained no-tool inactivity timeouts are now `provider_stall` (and already trigger failover).
- Each superseded failover attempt emits its own `dispatch_finished` (`superseded_by_fallback: true`) and `provider_error` rows using that attempt's provider/model. The final `dispatch_finished` uses the final provider/model and its own cost/turns/duration, not cumulative totals; returned `DispatchResult` retains totals. Lead and QA dispatches both use failover (N3 covered).

## Editing

Because the runtime paths are symlinks, editing a file under `bridge/` is
immediately visible to HT — no copy step needed. Commit changes in `bridge/`
and they're the new canonical version for every machine that pulls this repo.

## Verification gates

Run the standard gates from the repo root before integrating a bridge change:

```bash
cd bridge/extensions/orchestrator && bun test   # unit; expect 0 fail
python3 -m pytest tests -q                      # Python runtime; expect 0 fail
./scripts/typecheck-bridge.sh                   # strict typecheck; expect exit 0
./scripts/lint.sh                               # ruff + vulture + knip; expect exit 0
```

This repo intentionally has no `package.json`, `node_modules`, or `tsconfig.json`
— HT loads the extension from here via symlinks, and its own workspace supplies
`@humain/terminal`, `typebox`, `@types/node`, and `bun-types`. A bare
`bunx tsc --noEmit *.ts` therefore cannot resolve any of those and fails with
cascading `TS2307`s that look like code defects but are not.
`scripts/typecheck-bridge.sh` exists to close that gap: it discovers the
installed HT workspace (override with `HUMAIN_TERMINAL_ROOT`), generates a
tsconfig pointing at it, and runs `tsc` with three distinct exit codes:

| Exit | Meaning | What an automated QA agent should report |
|---|---|---|
| 0 | no diagnostics | PASS |
| 1 | type errors | FAIL — fix the code |
| 2 | HT workspace / tsc / bun-types not found | SKIPPED — environment, **not** a code failure |

Scope is `bridge/extensions/orchestrator/*.ts`; keeping the gate at exactly
zero means any new error is unambiguous. For Run 9's broader final gate, run each command separately and record results rather than assuming they passed:

```bash
python3 -B -m pytest -p no:cacheprovider -q
bun test ./bridge
bun test --isolate ./bridge
bun test --randomize --seed <seed> ./bridge  # repeat with three recorded seeds
./scripts/typecheck-bridge.sh --all
./scripts/lint.sh
```

The full bridge and Python suites are resource-intensive; do not infer pass counts or outage verification from this documentation.

## Why a bridge directory?

The Python orchestrator (`../orchestrator/`) is the model-agnostic routing
runtime. The files in this directory are the HT-specific bindings — agent
definitions, the dispatch extension — that pair the runtime
with HT's command/subagent model.

Keeping them in this repo under a single `bridge/` directory means one `git pull`
updates both sides. Versions stay coupled: a Python runtime change that requires
a matching TS bridge change goes in one commit, one tag, one publish.

See `PUBLISH.md` at the repo root for the distribution story.

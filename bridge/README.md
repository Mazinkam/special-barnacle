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

Orchestrating capabilities (`lead`, `architect`, and `technical_lead`) use a progress-aware inactivity limit plus an absolute ceiling. `HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS` changes the no-progress limit (default: 20 minutes); raising it is only a stopgap, not a way to make leads wait on CI. Leads should report checks under `## Pending external checks` and finish rather than poll or sleep. The parent may poll supported GitHub/GitLab checks on session ticks, bounded by `HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS` (default: 60 minutes). Pending-check status and CLI/auth behavior have not been independently verified against live providers; unavailable or unrecognized results remain unverified, not passes.

`HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS` changes the absolute orchestrating-dispatch ceiling (default: 6 hours). The legacy `HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS` supplies that ceiling's default only when the newer variable is unset. A `wait_stall` (inactivity timeout while a wait-like tool is active) and a `provider_stall` each use the shared one-resume-per-lead recovery budget; a failed resume does not get another retry. Leaf dispatches keep their separate fixed timeout. A child that emits its terminal `agent_end` but does not exit is given a post-end settle grace of 30 seconds by default; configure it with `HUMAIN_ORCHESTRATOR_POST_END_GRACE_MS`.

## Editing

Because the runtime paths are symlinks, editing a file under `bridge/` is
immediately visible to HT — no copy step needed. Commit changes in `bridge/`
and they're the new canonical version for every machine that pulls this repo.

## Verification gates

Run all four from the repo root before integrating a bridge change:

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
zero means any new error is unambiguous.

## Why a bridge directory?

The Python orchestrator (`../orchestrator/`) is the model-agnostic routing
runtime. The files in this directory are the HT-specific bindings — agent
definitions, the dispatch extension — that pair the runtime
with HT's command/subagent model.

Keeping them in this repo under a single `bridge/` directory means one `git pull`
updates both sides. Versions stay coupled: a Python runtime change that requires
a matching TS bridge change goes in one commit, one tag, one publish.

See `PUBLISH.md` at the repo root for the distribution story.

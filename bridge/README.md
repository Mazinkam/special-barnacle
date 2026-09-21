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
│   └── cross-review-demo.ts           /cross-review-demo extension
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

Override the install target with `HUMAIN_TERMINAL_AGENT_DIR`:

```bash
HUMAIN_TERMINAL_AGENT_DIR=/tmp/test-agent ./install.sh
```

After install, restart HT (or `/reload`) to pick up the new commands:

```
/reload
/orchestrate <goal> [--task-class T] [--complexity N] [--risk R] [--fan-out] [--max-retries N]
/orchestrator-roi
/cross-review-demo
```

## Editing

Because the runtime paths are symlinks, editing a file under `bridge/` is
immediately visible to HT — no copy step needed. Commit changes in `bridge/`
and they're the new canonical version for every machine that pulls this repo.

## Why a bridge directory?

The Python orchestrator (`../orchestrator/`) is the model-agnostic routing
runtime. The files in this directory are the HT-specific bindings — agent
definitions, the dispatch extension, the demo extension — that pair the runtime
with HT's command/subagent model.

Keeping them in this repo under a single `bridge/` directory means one `git pull`
updates both sides. Versions stay coupled: a Python runtime change that requires
a matching TS bridge change goes in one commit, one tag, one publish.

See `PUBLISH.md` at the repo root for the distribution story.

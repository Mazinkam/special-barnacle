"""Tool isolation (spec §2.1): the agent binary and orchestrator must run from pinned copies outside every
task repo, because the sandbox denies reads of task repos and a readable repo would leak the solution."""
from __future__ import annotations

import os
import shlex
import shutil
from pathlib import Path

from bench.sandbox import default_deny_roots

HINT = 'build pinned copies outside every task repo with scripts/bench_tools.py (docs/BENCHMARK.md "Build pinned tools")'


def task_deny_roots(task, experiment_root: Path) -> list[Path]:
    """The roots the runner denies to this task's agent (must match bench/runner.py)."""
    return default_deny_roots([Path(task.repo), task.source.parent, Path(experiment_root) / 'journal.jsonl'])


def binary_paths(binary: str) -> list[str]:
    """Realpaths of every token of `binary` naming an existing file, or of `which(first token)`."""
    tokens = shlex.split(binary)
    out = [os.path.realpath(t) for t in tokens if os.path.isfile(t)]
    if tokens and not os.path.isfile(tokens[0]):
        found = shutil.which(tokens[0])
        if found:
            out.insert(0, os.path.realpath(found))
    return list(dict.fromkeys(out))


def primary_binary(binary: str) -> str | None:
    """The program the agent actually is: the last existing-file token (the script run by an interpreter,
    e.g. `node cli.js`), else the resolved first token."""
    tokens = shlex.split(binary)
    files = [os.path.realpath(t) for t in tokens if os.path.isfile(t)]
    if files:
        return files[-1]
    found = shutil.which(tokens[0]) if tokens else None
    return os.path.realpath(found) if found else None


def tool_paths(cfg) -> list[tuple[str, str]]:
    return ([('binary', p) for p in binary_paths(cfg.binary)]
            + [('skill_root', os.path.realpath(cfg.skill_root)), ('profiles_file', os.path.realpath(cfg.profiles_file))])


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def preflight_tool_isolation(cfg, tasks, experiment_root: Path) -> list[str]:
    """One problem per (tool, task, denied root) where a tool path is equal to or inside a denied root."""
    problems = []
    tools = tool_paths(cfg)
    for task in tasks:
        for root in task_deny_roots(task, experiment_root):
            real_root = os.path.realpath(root)
            for name, path in tools:
                if _within(path, real_root):
                    problems.append(f'{name} {path} is inside denied root {real_root} of task {task.id}; '
                                    f'the sandboxed agent could not read it. {HINT}')
    return problems

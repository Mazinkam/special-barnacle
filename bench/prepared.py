"""Prepared base trees (spec §2.3): snapshot + setup once per (repo, base commit, setup), cloned per use.

Installing a large monorepo's dependencies took ~7 minutes per snapshot, and the runner used to repeat it for
every attempt. A prepared tree is built once, marked READY only after setup succeeds, and then handed to each
attempt as an APFS clone (instant, copy-on-write). Every arm and every repeat of a task therefore starts from
the byte-identical environment, which also removes install-time drift between arms.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from bench.grade import _clone
from bench.manifest import TaskManifest
from bench.sandbox import sandbox_argv
from bench.snapshot import make_snapshot


class SetupError(RuntimeError):
    """The task's setup commands failed; the task cannot be prepared (and nothing is cached)."""


def cache_key(task: TaskManifest) -> str:
    """Identity of a prepared tree: only what determines its contents (repo, base commit, setup)."""
    payload = json.dumps({'repo': os.path.realpath(task.repo), 'base_commit': task.base_commit,
                          'setup': [list(a) for a in task.setup]}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def clone_tree(src: Path, dst: Path) -> None:
    """Full independent copy of `src` (including .git), as an APFS clone when possible.

    A clone has new inodes, so git's first `status` re-hashes every tracked file (13 s on humain-terminal,
    35 s on forge). That exceeded the bridge's 10 s git-snapshot timeout, which then reported "git snapshot
    unavailable" and skipped QA for the orchestrated arm. The index is refreshed here, before any agent
    starts and outside its clock; refreshing only rewrites stat data, never content.
    """
    src, dst = Path(src), Path(dst)
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not _clone(src, dst):
        shutil.copytree(src, dst, symlinks=True)
    if (dst / '.git').is_dir():
        subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(dst),
                        'update-index', '-q', '--refresh'], capture_output=True, check=False)


def _run_setup(task: TaskManifest, tree: Path, *, sandbox: bool, deny_roots: list[Path] | None, env: dict | None) -> None:
    for argv in task.setup:
        cmd = list(argv)
        if sandbox:   # network stays open for installs; only grading is offline
            cmd = sandbox_argv(cmd, deny_read=list(deny_roots or []), allow_network=True)
        try:
            p = subprocess.run(cmd, cwd=tree, env=env, capture_output=True, text=True, timeout=task.timeout_s)
        except subprocess.TimeoutExpired:
            raise SetupError(f'setup timed out after {task.timeout_s}s: {" ".join(argv)}') from None
        except OSError as exc:
            raise SetupError(f'setup could not start: {" ".join(argv)}: {exc}') from None
        if p.returncode != 0:
            tail = (p.stdout + p.stderr)[-300:].strip()
            raise SetupError(f'setup {" ".join(argv)} exited {p.returncode}: {tail}')


def _tune_git(tree: Path) -> None:
    """Make clones of `tree` git-ready instantly: compare only mtime and size (clones keep mtimes but not
    inodes or ctimes), then record that stat data once. Idempotent and content-neutral."""
    if not (tree / '.git').is_dir():
        return
    git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(tree)]
    for key, value in (('core.checkStat', 'minimal'), ('core.trustctime', 'false')):
        subprocess.run([*git, 'config', key, value], capture_output=True, check=False)
    subprocess.run([*git, 'update-index', '-q', '--refresh'], capture_output=True, check=False)


def prepared_tree(task: TaskManifest, cache_root: Path, *, sandbox: bool, deny_roots: list[Path] | None = None,
                  env: dict | None = None) -> Path:
    """Path of the READY prepared tree for `task`, building it (snapshot + setup) on first use.

    Callers must treat the returned tree as read-only and clone it (`clone_tree`) before changing anything.
    Concurrent callers are serialized per key with a file lock; a failed build leaves no READY tree.
    """
    cache_root = Path(cache_root)
    cache_root.mkdir(parents=True, exist_ok=True)
    key = cache_key(task)
    final = cache_root / key
    with open(cache_root / f'{key}.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (final / 'READY.json').is_file():
            _tune_git(final / 'tree')            # also upgrades caches built before tuning existed
            return final / 'tree'
        if final.exists():                       # a previous build died before READY: never reuse it
            shutil.rmtree(final)
        building = cache_root / f'{key}.building-{os.getpid()}'
        if building.exists():
            shutil.rmtree(building)
        try:
            snap = make_snapshot(Path(task.repo), task.base_commit, building / 'tree')
            _run_setup(task, snap.path, sandbox=sandbox, deny_roots=deny_roots, env=env)
            _tune_git(snap.path)
            (building / 'READY.json').write_text(json.dumps({'task': task.id, 'repo': task.repo,
                                                             'base_commit': task.base_commit,
                                                             'setup': [list(a) for a in task.setup]}, indent=2))
            os.rename(building, final)
        except BaseException:
            shutil.rmtree(building, ignore_errors=True)
            raise
        return final / 'tree'

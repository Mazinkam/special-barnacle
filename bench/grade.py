"""Trusted grading (spec §2.1): fresh copy, hidden files overlaid, no network, tamper check."""
from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from bench.manifest import TaskManifest
from bench.sandbox import sandbox_argv
from bench.snapshot import worktree_digest


@dataclass
class GradeResult:
    verdict: str
    checks: list = field(default_factory=list)
    tampered: list = field(default_factory=list)
    tree_digest: str = ''


_CLONE_NOFOLLOW = 0x0001  # never follow a symlink at the source root


def _clone(src: Path, dst: Path) -> bool:
    """Copy-on-write clone of a whole tree with one clonefile(2) call (APFS). False when unavailable.

    Grading copies the submitted tree, node_modules included, once per run; a byte copy of a large
    monorepo took minutes and gigabytes per grade. A clone is near-instant, shares blocks until written,
    and later writes to either side never affect the other.
    """
    if sys.platform != 'darwin':
        return False
    try:
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        clonefile = libc.clonefile
    except (OSError, AttributeError):
        return False
    clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
    clonefile.restype = ctypes.c_int
    return clonefile(os.fsencode(src), os.fsencode(dst), _CLONE_NOFOLLOW) == 0


def copy_tree(src: Path, dst: Path) -> None:
    """Copy `src` to a new `dst` without its top-level .git and without following symlinks.

    Each top-level entry except `.git` is cloned on its own, so the snapshot's .git (git objects for
    the whole tree) is never materialized and never has to be deleted. Only the root .git carries
    repository history (snapshots have exactly one).
    """
    src, dst = Path(src), Path(dst)
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    try:
        entries = [e for e in os.scandir(src) if e.name != '.git']
    except OSError:
        entries = None
    if entries is not None and all(_clone(Path(e.path), dst / e.name) for e in entries):
        return
    shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=True,
                    ignore=lambda d, names: ['.git'] if Path(d) == src and '.git' in names else [])


def _fingerprint(p: Path):
    if p.is_symlink():
        return ('link', os.readlink(p))
    if p.is_file():
        return ('file', hashlib.sha256(p.read_bytes()).hexdigest())
    if p.is_dir():
        return ('dir', sorted((c.name, _fingerprint(c)) for c in p.iterdir()))
    return None


def _unsafe(p: str) -> bool:
    return os.path.isabs(p) or '..' in Path(p).parts


def _protected_fingerprint(root: Path, p: str):
    parts = Path(p).parts
    cur = Path(root)
    for comp in parts[:-1]:
        cur = cur / comp
        if os.path.islink(cur):
            return ('link-parent', comp, os.readlink(cur))
    return _fingerprint(Path(root) / p)


def _unlink_symlinks_under_overlay(hidden: Path, work: Path) -> None:
    for src in sorted(hidden.rglob('*')):
        rel = src.relative_to(hidden)
        cur = work
        for comp in rel.parts:
            cur = cur / comp
            if os.path.islink(cur):
                os.unlink(cur)
                break
            if not os.path.lexists(cur):
                break


def grade(task: TaskManifest, submitted: Path, base: Path, work: Path, *, sandbox: bool = True) -> GradeResult:
    digest = worktree_digest(submitted)
    tampered = [p for p in task.protected_paths
                if _unsafe(p) or _protected_fingerprint(submitted, p) != _protected_fingerprint(base, p)]
    if work.exists():
        shutil.rmtree(work)
    copy_tree(submitted, work)
    hidden = task.source.parent / task.hidden_files
    _unlink_symlinks_under_overlay(hidden, work)
    shutil.copytree(hidden, work, symlinks=True, dirs_exist_ok=True)
    checks = []
    verdict = 'pass'
    for argv in task.hidden_checks:
        cmd = sandbox_argv(list(argv), deny_read=[], allow_network=False) if sandbox else list(argv)
        try:
            p = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=task.timeout_s)
            ok = p.returncode == 0
            checks.append({'argv': list(argv), 'exit': p.returncode, 'tail': (p.stdout + p.stderr)[-2000:]})
            if not ok and verdict == 'pass':
                verdict = 'fail'
        except subprocess.TimeoutExpired:
            checks.append({'argv': list(argv), 'exit': None, 'tail': 'timeout'})
            verdict = 'error'
    if tampered and verdict == 'pass':
        verdict = 'fail'
    return GradeResult(verdict, checks, tampered, digest)

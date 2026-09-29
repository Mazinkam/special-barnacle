"""Trusted grading (spec §2.1): fresh copy, hidden files overlaid, no network, tamper check."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from bench.manifest import TaskManifest
from bench.sandbox import sandbox_argv
from bench.snapshot import tree_digest


@dataclass
class GradeResult:
    verdict: str
    checks: list = field(default_factory=list)
    tampered: list = field(default_factory=list)
    tree_digest: str = ''


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
    digest = tree_digest(submitted)
    tampered = [p for p in task.protected_paths
                if _unsafe(p) or _protected_fingerprint(submitted, p) != _protected_fingerprint(base, p)]
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(submitted, work, symlinks=True, ignore=shutil.ignore_patterns('.git'))
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

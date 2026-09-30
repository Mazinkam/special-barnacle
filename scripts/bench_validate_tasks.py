#!/usr/bin/env python3
"""Validate a benchmark task suite (spec §2.1).

For every task: its base snapshot must FAIL the hidden checks, and the reference patch must
apply and PASS them on every one of `--repeats` runs (flake guard). Setup commands must succeed.
Any task that violates this is quarantined with a reason; nothing is benchmarked on a task whose
acceptance contract cannot distinguish "not done" from "done".

    python3 scripts/bench_validate_tasks.py SUITE_DIR --work DIR [--repeats 3] [--no-sandbox]

Exit status: 0 when every task is valid, 1 when any task is quarantined.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bench.grade import grade  # noqa: E402
from bench.manifest import TaskManifest, load_suite  # noqa: E402
from bench.snapshot import make_snapshot  # noqa: E402


def _run_setup(task: TaskManifest, tree: Path) -> str | None:
    for argv in task.setup:
        try:
            p = subprocess.run(list(argv), cwd=tree, capture_output=True, text=True, timeout=task.timeout_s)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return f'setup failed: {" ".join(argv)}: {exc}'
        if p.returncode != 0:
            return f'setup failed: {" ".join(argv)} exited {p.returncode}: {(p.stdout + p.stderr)[-300:].strip()}'
    return None


def _reference_patch(task: TaskManifest) -> Path | None:
    """The reference patch, only if it resolves inside the suite directory."""
    suite = task.source.parent.resolve()
    patch = (task.source.parent / task.reference_patch).resolve()
    return patch if patch.is_file() and suite in patch.parents else None


def validate_task(task: TaskManifest, work: Path, *, repeats: int, sandbox: bool) -> str | None:
    """Return None when the task is valid, else the quarantine reason."""
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    try:
        base = make_snapshot(Path(task.repo), task.base_commit, work / 'base')
    except (subprocess.CalledProcessError, ValueError, OSError) as exc:
        return f'snapshot failed: {exc}'
    reason = _run_setup(task, base.path)
    if reason:
        return reason
    if grade(task, base.path, base.path, work / 'g-base', sandbox=sandbox).verdict != 'fail':
        return 'base does not fail hidden checks'
    patch = _reference_patch(task)
    if patch is None:
        return 'reference patch missing or outside the suite directory'
    ref = make_snapshot(Path(task.repo), task.base_commit, work / 'ref')
    if subprocess.run(['git', '-C', str(ref.path), 'apply', '--whitespace=nowarn', str(patch)], capture_output=True).returncode != 0:
        return 'reference patch does not apply'
    reason = _run_setup(task, ref.path)
    if reason:
        return reason
    for i in range(repeats):
        if grade(task, ref.path, base.path, work / f'g-ref-{i}', sandbox=sandbox).verdict != 'pass':
            return f'reference failed hidden checks on repeat {i + 1} of {repeats}'
    return None


def validate_suite(suite: Path, work: Path, *, repeats: int = 3, sandbox: bool = True) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    ok, quarantine, reasons = [], [], {}
    for task in load_suite(suite):
        reason = validate_task(task, work / task.id, repeats=repeats, sandbox=sandbox)
        if reason:
            quarantine.append(task.id)
            reasons[task.id] = reason
        else:
            ok.append(task.id)
    (work / 'validation.json').write_text(json.dumps({'ok': ok, 'quarantine': quarantine, 'reasons': reasons}, indent=2))
    return {'ok': ok, 'quarantine': quarantine}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('suite', type=Path)
    p.add_argument('--work', type=Path, required=True, help='scratch directory for snapshots and grading')
    p.add_argument('--repeats', type=int, default=3, help='reference runs that must all pass (default 3)')
    p.add_argument('--no-sandbox', action='store_true', help='run hidden checks without sandbox-exec (tests only)')
    a = p.parse_args()
    if a.repeats < 1:
        p.error('--repeats must be at least 1')
    result = validate_suite(a.suite, a.work, repeats=a.repeats, sandbox=not a.no_sandbox)
    reasons = json.loads((a.work / 'validation.json').read_text())['reasons']
    print(json.dumps({**result, 'reasons': reasons}, indent=2))
    return 1 if result['quarantine'] else 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Run a benchmark experiment: python3 scripts/bench_run.py --suite DIR --experiment-root DIR --config JSON ..."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from bench.arms import ARMS, ExperimentConfig, config_fingerprint, provenance  # noqa: E402
from bench.manifest import load_suite  # noqa: E402
from bench.runner import plan_attempts, run_experiment  # noqa: E402
from bench.tools import preflight_tool_isolation  # noqa: E402


def _tiered_supported() -> bool:
    try:
        method = json.loads((HERE.parent / 'orchestrator' / 'method.json').read_text())
    except (OSError, ValueError):
        return False
    return bool((method.get('rules') or {}).get('workflow_policy'))


def _load_config(path: Path) -> tuple[ExperimentConfig, str | None]:
    data = json.loads(path.read_text())
    ext_dir = data.pop('installed_extension_dir', None)   # optional, for revision stamping only
    data['orchestrate_flags'] = tuple(data.get('orchestrate_flags', ()))
    for key in ('skill_root', 'profiles_file'):
        data[key] = Path(data[key])
    return ExperimentConfig(**data), ext_dir


def _extension_revision(ext_dir: str | None) -> str | None:
    if not ext_dir:
        return None
    try:
        r = subprocess.run(['git', '-C', ext_dir, 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() or None if r.returncode == 0 else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--suite', required=True, type=Path)
    ap.add_argument('--experiment-root', required=True, type=Path)
    ap.add_argument('--config', required=True, type=Path)
    ap.add_argument('--arms', default='direct,current')
    ap.add_argument('--approve-usd', required=True, type=float)
    ap.add_argument('--no-sandbox', action='store_true')
    ap.add_argument('--split', choices=('dev', 'holdout'))
    ap.add_argument('--prepared-cache', type=Path, help='prepared base trees, shareable with bench_validate_tasks.py (default: <experiment-root>/prepared)')
    args = ap.parse_args(argv)

    arms = tuple(a for a in args.arms.split(',') if a)
    bad = [a for a in arms if a not in ARMS]
    if bad or not arms:
        print(f'error: unknown arm(s) {bad}; expected from {ARMS}', file=sys.stderr)
        return 2
    if 'tiered' in arms and not _tiered_supported():
        print("error: arm 'tiered' requires rules.workflow_policy in orchestrator/method.json (Phase 2); not present", file=sys.stderr)
        return 2

    cfg, ext_dir = _load_config(args.config)
    tasks = [t for t in load_suite(args.suite) if not args.split or t.split == args.split]
    if not tasks:
        print('error: no tasks selected', file=sys.stderr)
        return 2
    n = len(plan_attempts([t.id for t in tasks], arms, cfg.k, cfg.seed))
    print(f'{n} attempts x ${cfg.per_run_usd_cap:.2f} per-run cap = ${n * cfg.per_run_usd_cap:.2f} worst case '
          f'(approved ${args.approve_usd:.2f})')

    fingerprint = config_fingerprint(cfg)
    meta_path = args.experiment_root / 'experiment.json'
    if meta_path.exists():
        old = json.loads(meta_path.read_text()).get('config_fingerprint')
        if old != fingerprint:
            print(f'error: config fingerprint changed ({old} -> {fingerprint}); refusing to continue this experiment', file=sys.stderr)
            return 3
    from bench.runner import is_live_root
    if is_live_root(args.experiment_root):
        print('error: refusing to use the live state root as an experiment root', file=sys.stderr)
        return 2
    problems = preflight_tool_isolation(cfg, tasks, args.experiment_root)
    if problems:
        print('error: tool isolation preflight failed:\n  ' + '\n  '.join(problems), file=sys.stderr)
        return 2
    try:
        # run_experiment validates the root (live state) and budget before creating anything
        if not meta_path.exists():
            _guard_then_write_meta(args, cfg, tasks, arms, fingerprint, ext_dir, meta_path)
        run_experiment(tasks, cfg, arms, args.experiment_root, approve_usd=args.approve_usd, sandbox=not args.no_sandbox,
                       prepared_cache=args.prepared_cache)
    except ValueError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    return 0


def _guard_then_write_meta(args, cfg, tasks, arms, fingerprint, ext_dir, meta_path: Path) -> None:
    from bench.runner import is_live_root
    if is_live_root(args.experiment_root):
        raise ValueError('refusing to use the live state root as an experiment root')
    if args.approve_usd < len(plan_attempts([t.id for t in tasks], arms, cfg.k, cfg.seed)) * cfg.per_run_usd_cap:
        raise ValueError('approve-usd is below attempts x per-run cap')
    args.experiment_root.mkdir(parents=True, exist_ok=True)
    meta = {'config': {**cfg.__dict__, 'skill_root': str(cfg.skill_root), 'profiles_file': str(cfg.profiles_file),
                       'orchestrate_flags': list(cfg.orchestrate_flags)},
            'config_fingerprint': fingerprint, 'provenance': provenance(cfg), 'suite_ids': sorted(t.id for t in tasks), 'arms': list(arms),
            'installed_extension_revision': _extension_revision(ext_dir)}
    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True))


if __name__ == '__main__':
    sys.exit(main())

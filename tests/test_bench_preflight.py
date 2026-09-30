import dataclasses
import json
import os
import shlex
import sys
from pathlib import Path

import pytest

from bench.runner import run_experiment
from bench.tools import preflight_tool_isolation


def _with(cfg, **kw):
    return dataclasses.replace(cfg, **kw)


def test_fixture_tools_live_outside_the_task_repo(tmp_path, tiny_suite, fake_cfg):
    # fake_cfg runs the fake agent from this checkout and uses it as skill_root; tiny_suite's repo is a
    # fresh temp git repo, so the existing runner tests are not affected by the preflight.
    assert preflight_tool_isolation(fake_cfg, tiny_suite, tmp_path / 'exp') == []


def test_skill_root_inside_task_repo_is_rejected(tmp_path, tiny_suite, fake_cfg):
    repo = Path(tiny_suite[0].repo)
    cfg = _with(fake_cfg, skill_root=repo / 'sub')
    problems = preflight_tool_isolation(cfg, tiny_suite, tmp_path / 'exp')
    assert len(problems) == 1
    p = problems[0]
    assert 'skill_root' in p and 't1' in p and os.path.realpath(repo) in p and 'scripts/bench_tools.py' in p


def test_binary_equal_to_or_inside_denied_root_is_rejected(tmp_path, tiny_suite, fake_cfg):
    repo = Path(tiny_suite[0].repo)
    agent = repo / 'cli.js'; agent.write_text('#!/bin/sh\n')
    cfg = _with(fake_cfg, binary=f'{shlex.quote(sys.executable)} {shlex.quote(str(agent))}')
    problems = preflight_tool_isolation(cfg, tiny_suite, tmp_path / 'exp')
    assert any('binary' in p and str(os.path.realpath(agent)) in p for p in problems)
    cfg = _with(fake_cfg, profiles_file=tiny_suite[0].source.parent)   # equal to the suite dir root
    assert any('profiles_file' in p for p in preflight_tool_isolation(cfg, tiny_suite, tmp_path / 'exp'))


def test_binary_symlink_into_task_repo_is_resolved(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    repo = Path(tiny_suite[0].repo)
    target = repo / 'dist' / 'cli.js'; target.parent.mkdir(); target.write_text('#!/bin/sh\n'); target.chmod(0o755)
    bindir = tmp_path / 'bin'; bindir.mkdir()
    (bindir / 'humain-terminal').symlink_to(target)
    monkeypatch.setenv('PATH', f'{bindir}{os.pathsep}{os.environ["PATH"]}')
    cfg = _with(fake_cfg, binary='humain-terminal --verbose')
    problems = preflight_tool_isolation(cfg, tiny_suite, tmp_path / 'exp')
    assert problems and os.path.realpath(target) in problems[0]


def test_run_experiment_fails_fast_before_any_snapshot(tmp_path, tiny_suite, fake_cfg):
    repo = Path(tiny_suite[0].repo)
    cfg = _with(fake_cfg, skill_root=repo)
    root = tmp_path / 'exp'
    with pytest.raises(ValueError, match='bench_tools.py'):
        run_experiment(tiny_suite, cfg, ('direct',), root, approve_usd=100, sandbox=False)
    assert not root.exists()


def test_cli_fails_fast_before_writing_experiment_meta(tmp_path, tiny_suite, fake_cfg, capsys):
    import importlib.util
    spec = importlib.util.spec_from_file_location('bench_run_cli2', Path(__file__).resolve().parents[1] / 'scripts' / 'bench_run.py')
    cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
    cfg = {'experiment_id': 'exp-test', 'seed': 1, 'k': 1, 'binary': fake_cfg.binary, 'skill_root': tiny_suite[0].repo,
           'profiles_file': str(fake_cfg.profiles_file), 'direct_model': 'fake/m', 'direct_thinking': 'low',
           'orchestrate_flags': [], 'per_run_usd_cap': 1.0, 'per_run_timeout_s': 60}
    cp = tmp_path / 'cfg.json'; cp.write_text(json.dumps(cfg))
    rc = cli.main(['--suite', str(tiny_suite[0].source.parent), '--experiment-root', str(tmp_path / 'exp'), '--config', str(cp),
                   '--arms', 'direct', '--approve-usd', '100', '--no-sandbox'])
    assert rc != 0 and 'bench_tools.py' in capsys.readouterr().err
    assert not (tmp_path / 'exp').exists()

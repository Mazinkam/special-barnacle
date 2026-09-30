import json
import os
import sys
from dataclasses import replace

import pytest

from bench.prepared import SetupError, cache_key, clone_tree, prepared_tree
from bench.runner import run_experiment


def _counting_setup(counter):
    # Appends one line per run to a file OUTSIDE the tree, so the test can count setup executions.
    return ((sys.executable, '-c', f"open({str(counter)!r}, 'a').write('x\\n'); open('built.txt', 'w').write('ok')"),)


def test_prepared_tree_runs_setup_once_and_is_reused(tmp_path, tiny_suite):
    counter = tmp_path / 'setup-runs'
    task = replace(tiny_suite[0], setup=_counting_setup(counter))
    first = prepared_tree(task, tmp_path / 'cache', sandbox=False)
    second = prepared_tree(task, tmp_path / 'cache', sandbox=False)
    assert first == second
    assert counter.read_text().count('x') == 1
    assert (first / 'built.txt').read_text() == 'ok'
    assert (first / 'a.txt').read_text() == 'base\n'
    assert (first / '.git').is_dir()                    # agents get a git repo, as with a fresh snapshot


def test_failed_setup_raises_and_caches_nothing(tmp_path, tiny_suite):
    task = replace(tiny_suite[0], setup=((sys.executable, '-c', 'import sys; sys.exit(3)'),))
    with pytest.raises(SetupError, match='exited 3'):
        prepared_tree(task, tmp_path / 'cache', sandbox=False)
    assert not any((tmp_path / 'cache').glob(f'{cache_key(task)}*/READY.json'))
    with pytest.raises(SetupError):                     # still not cached: it retries, not a stale success
        prepared_tree(task, tmp_path / 'cache', sandbox=False)


def test_cache_key_depends_on_repo_commit_and_setup(tiny_suite):
    t = tiny_suite[0]
    assert cache_key(t) == cache_key(replace(t, goal='other goal', hidden_checks=(('true',),)))
    assert cache_key(t) != cache_key(replace(t, setup=(('bun', 'install'),)))
    assert cache_key(t) != cache_key(replace(t, base_commit='b' * 40))


def test_clone_tree_is_a_full_independent_copy(tmp_path, tiny_suite):
    src = prepared_tree(tiny_suite[0], tmp_path / 'cache', sandbox=False)
    dst = tmp_path / 'attempt-tree'
    clone_tree(src, dst)
    assert (dst / '.git').is_dir() and (dst / 'a.txt').read_text() == 'base\n'
    (dst / 'a.txt').write_text('agent edit')
    assert (src / 'a.txt').read_text() == 'base\n'


def test_runner_prepares_each_task_once_across_attempts(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    counter = tmp_path / 'setup-runs'
    suite = [replace(tiny_suite[0], setup=_counting_setup(counter))]
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    cfg = replace(fake_cfg, k=2)
    journal = run_experiment(suite, cfg, ('direct', 'current'), tmp_path / 'exp', approve_usd=100, sandbox=False)
    rows = [r for r in map(json.loads, journal.read_text().splitlines()) if r.get('event') != 'started']
    assert len(rows) == 4 and {r['execution_status'] for r in rows} == {'completed'}
    assert counter.read_text().count('x') == 1          # 4 attempts, 1 setup
    for r in rows:
        tree = tmp_path / 'exp' / 'attempts' / r['attempt_id'] / 'tree'
        assert (tree / 'built.txt').read_text() == 'ok'


def test_runner_reports_setup_failure_as_infra_error(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    suite = [replace(tiny_suite[0], setup=((sys.executable, '-c', 'import sys; sys.exit(5)'),))]
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    journal = run_experiment(suite, fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    rows = [r for r in map(json.loads, journal.read_text().splitlines()) if r.get('event') != 'started']
    assert [r['execution_status'] for r in rows] == ['infra_error']
    assert 'exited 5' in rows[0]['infra_reason']
    assert not os.path.exists(tmp_path / 'exp' / 'attempts' / rows[0]['attempt_id'] / 'agent.jsonl')   # agent never ran

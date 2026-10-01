import importlib.util, json
from pathlib import Path
import pytest
from bench.runner import plan_attempts, run_experiment
from orchestrator.core.env import default_state_root

ROOT = Path(__file__).resolve().parents[1]


def _load_cli():
    spec = importlib.util.spec_from_file_location('bench_run_cli', ROOT / 'scripts' / 'bench_run.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


def test_plan_is_blocked_and_seeded():
    a = plan_attempts(['t1', 't2'], ('direct', 'current'), 2, seed=1)
    b = plan_attempts(['t1', 't2'], ('direct', 'current'), 2, seed=1)
    assert [x.attempt_id for x in a] == [x.attempt_id for x in b]
    assert len(a) == 8
    for i in range(0, 8, 2):   # each block holds both arms for one (task, k)
        assert {a[i].arm, a[i + 1].arm} == {'direct', 'current'} and a[i].task_id == a[i + 1].task_id


def test_refuses_live_state_root(tmp_path):
    with pytest.raises(ValueError, match='live state'):
        run_experiment([], None, ('direct',), default_state_root(), approve_usd=0)


def test_refuses_symlink_to_live_state_root(tmp_path, monkeypatch):
    live = tmp_path / 'live'; live.mkdir()
    monkeypatch.setenv('HUMAIN_ORCHESTRATOR_STATE_ROOT', str(live))
    link = tmp_path / 'link'; link.symlink_to(live)
    with pytest.raises(ValueError, match='live state'):
        run_experiment([], None, ('direct',), link, approve_usd=0)


def test_refuses_insufficient_approval(tmp_path, tiny_suite, fake_cfg):
    with pytest.raises(ValueError, match='approve'):
        run_experiment(tiny_suite, fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=0.0, sandbox=False)


def test_timeout_is_journaled_and_resume_skips_done(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'sleep:30')
    cfg = fake_cfg.__class__(**{**fake_cfg.__dict__, 'per_run_timeout_s': 1})
    journal = run_experiment(tiny_suite, cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    rows = [r for r in (json.loads(l) for l in journal.read_text().splitlines()) if r.get('event') != 'started']
    assert rows and {r['execution_status'] for r in rows} == {'timeout'} and all(r['verdict'] == 'unknown' for r in rows)
    lines_before = len(journal.read_text().splitlines())
    run_experiment(tiny_suite, cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    assert len(journal.read_text().splitlines()) == lines_before   # nothing re-run


def test_fake_agent_apply_passes_and_uses_launcher(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    import subprocess
    patch = tiny_suite[0].source.parent / 'reference.patch'
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', f'apply:{patch}')
    calls = []
    def launcher(*a, **k):
        calls.append(a); return subprocess.Popen(*a, **k)
    journal = run_experiment(tiny_suite, fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False, launcher=launcher)
    rows = [json.loads(l) for l in journal.read_text().splitlines() if '"started"' not in l]
    assert calls and rows[0]['execution_status'] == 'completed' and rows[0]['verdict'] == 'pass'
    assert rows[0]['cost_usd'] == pytest.approx(0.01)


def test_orphaned_started_attempt_is_replaced_once(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    root = tmp_path / 'exp'; root.mkdir()
    (root / 'journal.jsonl').write_text(json.dumps({'event': 'started', 'attempt_id': 't1.direct.k1'}) + '\n')
    journal = run_experiment(tiny_suite, fake_cfg, ('direct',), root, approve_usd=100, sandbox=False)
    rows = [json.loads(l) for l in journal.read_text().splitlines() if '"started"' not in l]
    assert rows[0]['execution_status'] == 'infra_error' and rows[0]['replaced_by'] == 't1.direct.k1-r1'
    assert rows[1]['attempt_id'] == 't1.direct.k1-r1' and rows[1]['execution_status'] == 'completed'


def _cli_files(tmp_path, fake_cfg, tiny_suite):
    cfg = {'experiment_id': 'exp-test', 'seed': 1, 'k': 1, 'binary': fake_cfg.binary, 'skill_root': str(fake_cfg.skill_root),
           'profiles_file': str(fake_cfg.profiles_file), 'direct_model': 'fake/m', 'direct_thinking': 'low',
           'orchestrate_flags': [], 'per_run_usd_cap': 1.0, 'per_run_timeout_s': 60}
    cp = tmp_path / 'cfg.json'; cp.write_text(json.dumps(cfg))
    return cp, tiny_suite[0].source.parent


def test_cli_rejects_tiered(tmp_path, tiny_suite, fake_cfg, monkeypatch, capsys):
    cli = _load_cli()
    monkeypatch.setattr(cli, '_tiered_supported', lambda: False)
    cp, suite = _cli_files(tmp_path, fake_cfg, tiny_suite)
    rc = cli.main(['--suite', str(suite), '--experiment-root', str(tmp_path / 'exp'), '--config', str(cp),
                   '--arms', 'direct,tiered', '--approve-usd', '100', '--no-sandbox'])
    assert rc != 0 and 'tiered' in capsys.readouterr().err
    assert not (tmp_path / 'exp').exists()


def test_tiered_supported_once_workflow_policy_present():
    assert _load_cli()._tiered_supported() is True


def test_cli_refuses_fingerprint_mismatch(tmp_path, tiny_suite, fake_cfg, monkeypatch, capsys):
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    cli = _load_cli(); cp, suite = _cli_files(tmp_path, fake_cfg, tiny_suite)
    args = ['--suite', str(suite), '--experiment-root', str(tmp_path / 'exp'), '--config', str(cp),
            '--arms', 'direct', '--approve-usd', '100', '--no-sandbox']
    assert cli.main(args) == 0
    assert json.loads((tmp_path / 'exp' / 'experiment.json').read_text())['suite_ids'] == ['t1']
    cfg = json.loads(cp.read_text()); cfg['seed'] = 2; cp.write_text(json.dumps(cfg))
    assert cli.main(args) != 0 and 'fingerprint' in capsys.readouterr().err


def test_setup_timeout_is_journaled_as_infra_error(tmp_path, tiny_suite, fake_cfg):
    import dataclasses
    task = dataclasses.replace(tiny_suite[0], setup=(('sleep', '10'),), timeout_s=1)
    journal = run_experiment([task], fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    rows = [json.loads(l) for l in journal.read_text().splitlines() if '"started"' not in l]
    assert rows and rows[0]['execution_status'] == 'infra_error' and rows[0]['verdict'] == 'unknown'


def test_setup_runs_with_experiment_state_env(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    import dataclasses, sys
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    task = dataclasses.replace(tiny_suite[0], setup=((sys.executable, '-c',
        "import os,pathlib; pathlib.Path('env.txt').write_text(os.environ['CODING_AGENT_ORCHESTRATOR_HOME'])"),))
    root = tmp_path / 'exp'
    run_experiment([task], fake_cfg, ('direct',), root, approve_usd=100, sandbox=False)
    written = next((root / 'attempts').glob('*/tree/env.txt')).read_text()
    assert written == str(root / 'state')


def test_resume_with_leftover_replacement_workdir(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    root = tmp_path / 'exp'; root.mkdir()
    (root / 'journal.jsonl').write_text(json.dumps({'event': 'started', 'attempt_id': 't1.direct.k1'}) + '\n')
    (root / 'attempts' / 't1.direct.k1-r1' / 'base').mkdir(parents=True)
    (root / 'attempts' / 't1.direct.k1-r1' / 'base' / 'junk').write_text('x')
    journal = run_experiment(tiny_suite, fake_cfg, ('direct',), root, approve_usd=100, sandbox=False)
    rows = [json.loads(l) for l in journal.read_text().splitlines() if '"started"' not in l]
    assert rows[-1]['attempt_id'] == 't1.direct.k1-r1' and rows[-1]['execution_status'] == 'completed'


def test_refuses_descendant_of_live_state_root(tmp_path, monkeypatch):
    live = tmp_path / 'live'
    monkeypatch.delenv('HUMAIN_ORCHESTRATOR_STATE_ROOT', raising=False)
    monkeypatch.setenv('CODING_AGENT_ORCHESTRATOR_HOME', str(live))
    with pytest.raises(ValueError, match='live state'):
        run_experiment([], None, ('direct',), live / 'bench', approve_usd=0)
    with pytest.raises(ValueError, match='live state'):
        run_experiment([], None, ('direct',), live / 'a' / 'b', approve_usd=0)
    assert not live.exists()


def test_cli_refuses_descendant_of_live_state_root(tmp_path, tiny_suite, fake_cfg, monkeypatch, capsys):
    live = tmp_path / 'live'
    monkeypatch.delenv('HUMAIN_ORCHESTRATOR_STATE_ROOT', raising=False)
    monkeypatch.setenv('CODING_AGENT_ORCHESTRATOR_HOME', str(live))
    cli = _load_cli(); cp, suite = _cli_files(tmp_path, fake_cfg, tiny_suite)
    rc = cli.main(['--suite', str(suite), '--experiment-root', str(live / 'bench'), '--config', str(cp),
                   '--arms', 'direct', '--approve-usd', '100', '--no-sandbox'])
    assert rc != 0 and 'live state' in capsys.readouterr().err and not live.exists()


def test_kill_group_returns_fast_after_normal_exit():
    import subprocess, time
    from bench.runner import _kill_group
    p = subprocess.Popen(['true'], start_new_session=True); p.wait()
    t0 = time.time(); _kill_group(p)
    assert time.time() - t0 < 1.0


def test_kill_group_reaps_orphan_of_exited_leader():
    import os, subprocess, time
    from bench.runner import _kill_group
    p = subprocess.Popen(['sh', '-c', 'sleep 30 & exit 0'], start_new_session=True); p.wait()
    _kill_group(p)
    time.sleep(0.2)
    with pytest.raises(ProcessLookupError):
        os.killpg(p.pid, 0)


def test_timeout_row_has_partial_cost(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'sleep:30')
    cfg = fake_cfg.__class__(**{**fake_cfg.__dict__, 'per_run_timeout_s': 2})
    journal = run_experiment(tiny_suite, cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    rows = [json.loads(l) for l in journal.read_text().splitlines() if '"started"' not in l]
    assert rows[0]['execution_status'] == 'timeout'
    assert isinstance(rows[0]['cost_usd'], (int, float)) and rows[0]['cost_usd'] == pytest.approx(0.01)


@pytest.mark.parametrize('bad', ['../evil', 'a/b', 'a\\b', '', '.', '..', '.hidden', 'a\x00b'])
def test_rejects_unsafe_task_ids(tmp_path, tiny_suite, fake_cfg, bad):
    import dataclasses
    task = dataclasses.replace(tiny_suite[0], id=bad)
    root = tmp_path / 'exp'
    with pytest.raises(ValueError):
        run_experiment([task], fake_cfg, ('direct',), root, approve_usd=100, sandbox=False)
    assert not (root / 'attempts').exists()
    assert not (tmp_path / 'evil').exists()


def test_refuses_attempts_symlink_outside_root(tmp_path, tiny_suite, fake_cfg):
    root, outside = tmp_path / 'exp', tmp_path / 'outside'
    root.mkdir(); outside.mkdir()
    (root / 'attempts').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        run_experiment(tiny_suite, fake_cfg, ('direct',), root, approve_usd=100, sandbox=False)
    assert list(outside.iterdir()) == []


def _alive(pid):
    import os
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # a zombie still answers kill(0); ps shows its state
    import subprocess
    state = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith('Z')


def test_detached_descendants_are_killed_after_the_attempt(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    # Bridge children run detached in their own sessions, so killing the agent's process group misses them;
    # the first smoke run left a QA pytest running after the attempt ended.
    import time
    pid_file = tmp_path / 'orphan.pid'
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', f'orphan:{pid_file}')
    run_experiment(tiny_suite, fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    pid = int(pid_file.read_text())
    deadline = time.time() + 5
    while _alive(pid) and time.time() < deadline:
        time.sleep(0.1)
    assert not _alive(pid)


def test_attempt_marker_reaches_the_agent_but_not_the_arm_env(tmp_path, fake_cfg):
    from bench.arms import arm_invocation, injected_env_keys
    from bench.runner import ATTEMPT_ENV
    _, env = arm_invocation('direct', 'g', fake_cfg, tmp_path)
    assert ATTEMPT_ENV not in env and ATTEMPT_ENV not in injected_env_keys()   # the scrubbing shell keeps it


from pathlib import Path


def test_killing_the_runner_mid_attempt_kills_detached_descendants(tmp_path, tiny_suite, fake_cfg):
    import os, signal, subprocess, sys, time, pickle
    pid_file = tmp_path / 'orphan.pid'
    (tmp_path / 'args.pkl').write_bytes(pickle.dumps((tiny_suite, fake_cfg)))
    script = (
        "import pickle, sys; sys.path.insert(0, %r); sys.path.insert(0, %r)\n"
        "from bench.runner import run_experiment\n"
        "suite, cfg = pickle.loads(open(%r, 'rb').read())\n"
        "try:\n    run_experiment(suite, cfg, ('direct',), %r, approve_usd=100, sandbox=False)\n"
        "except KeyboardInterrupt:\n    sys.exit(130)\n"
    ) % (str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent),
         str(tmp_path / 'args.pkl'), str(tmp_path / 'exp'))
    env = {**os.environ, 'BENCH_FAKE_BEHAVIOUR': f'orphansleep:{pid_file}'}
    runner = subprocess.Popen([sys.executable, '-c', script], env=env)
    deadline = time.time() + 20
    while not pid_file.exists() and time.time() < deadline:
        time.sleep(0.1)
    assert pid_file.exists()
    orphan = int(pid_file.read_text())
    runner.send_signal(signal.SIGTERM)
    assert runner.wait(30) == 130
    deadline = time.time() + 5
    while _alive(orphan) and time.time() < deadline:
        time.sleep(0.1)
    assert not _alive(orphan)


def test_attempt_env_drops_the_launching_humain_terminal_session(monkeypatch):
    # Launched from inside a humain-terminal session, the runner inherited PI_PACKAGE_DIR (pointing at the real
    # HT checkout: the task's tests then tried to read it and hit the sandbox) plus the session id/file/model.
    from bench.runner import attempt_base_env
    monkeypatch.setenv('PI_PACKAGE_DIR', '/real/humain-terminal/packages/coding-agent')
    monkeypatch.setenv('PI_SESSION_FILE', '/home/.humain-terminal/agent/sessions/x.jsonl')
    monkeypatch.setenv('HUMAIN_TERMINAL_SESSION_ID', 'abc')
    monkeypatch.setenv('HUMAIN_TERMINAL_MODEL', 'm')
    monkeypatch.setenv('PI_CODING_AGENT', 'true')
    monkeypatch.setenv('HOME_LIKE_KEEP', 'yes')
    env = attempt_base_env()
    assert not [k for k in env if k.startswith('PI_') or k.startswith('HUMAIN_TERMINAL_')]
    assert env['HOME_LIKE_KEEP'] == 'yes' and 'PATH' in env


def test_launching_session_env_never_reaches_the_agent(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    import json
    monkeypatch.setenv('PI_PACKAGE_DIR', '/real/humain-terminal')
    monkeypatch.setenv('HUMAIN_TERMINAL_SESSION_FILE', '/sessions/x.jsonl')
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'envdump')
    run_experiment(tiny_suite, fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    dump = json.loads(next((tmp_path / 'exp' / 'attempts').glob('*/tree/env.json')).read_text())
    assert 'PI_PACKAGE_DIR' not in dump and 'HUMAIN_TERMINAL_SESSION_FILE' not in dump
    assert dump['HUMAIN_TERMINAL_CODING_AGENT_DIR'].endswith('ht-agent')      # the one HT variable we set

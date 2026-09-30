import json
from dataclasses import replace

from bench.agent_dir import AGENT_DIR_ENV, CREDENTIAL_FILES, SHELL_NAME, agent_dir_path, prepare_agent_dir
from bench.arms import ARMS, arm_invocation
from bench.runner import run_experiment


def _skill(tmp_path):
    skill = tmp_path / 'skill'
    (skill / 'bridge' / 'agents').mkdir(parents=True)
    (skill / 'bridge' / 'agents' / 'orch-worker.md').write_text('---\nname: orch-worker\n---\npinned worker\n')
    (skill / 'bridge' / 'agents' / 'orchestrator-lead.md').write_text('---\nname: orchestrator-lead\n---\npinned lead\n')
    return skill


def _user_agent_dir(tmp_path):
    user = tmp_path / 'user-agent'
    (user / 'agents').mkdir(parents=True)
    (user / 'agents' / 'orch-worker.md').write_text('LIVE worker (must not be used)')
    (user / 'extensions').mkdir()
    (user / 'auth.json').write_text('{"token": "t"}')
    (user / 'settings.json').write_text('{}')
    (user / 'sessions').mkdir()
    return user


def test_prepare_copies_pinned_personas_and_links_only_credentials(tmp_path):
    skill, user = _skill(tmp_path), _user_agent_dir(tmp_path)
    out = prepare_agent_dir(tmp_path / 'exp', skill, source=user)
    assert out == agent_dir_path(tmp_path / 'exp')
    persona = out / 'agents' / 'orch-worker.md'
    assert not persona.is_symlink() and persona.read_text().endswith('pinned worker\n')
    assert (out / 'agents' / 'orchestrator-lead.md').read_text().endswith('pinned lead\n')
    assert (out / 'auth.json').is_symlink() and (out / 'auth.json').read_text() == '{"token": "t"}'
    assert not (out / 'extensions').exists() and not (out / 'sessions').exists()
    assert set(p.name for p in out.iterdir()) <= {'agents', 'PREPARED.json', 'settings.json', SHELL_NAME, *CREDENTIAL_FILES}
    meta = json.loads((out / 'PREPARED.json').read_text())
    assert meta['personas'] == ['orch-worker.md', 'orchestrator-lead.md'] and meta['skill_root'] == str(skill)


def test_prepare_is_idempotent_and_refreshes_personas(tmp_path):
    skill, user = _skill(tmp_path), _user_agent_dir(tmp_path)
    prepare_agent_dir(tmp_path / 'exp', skill, source=user)
    (skill / 'bridge' / 'agents' / 'orch-worker.md').write_text('---\nname: orch-worker\n---\nv2\n')
    out = prepare_agent_dir(tmp_path / 'exp', skill, source=user)
    assert (out / 'agents' / 'orch-worker.md').read_text().endswith('v2\n')


def test_missing_credential_files_are_skipped(tmp_path):
    skill = _skill(tmp_path)
    empty = tmp_path / 'empty-agent'; empty.mkdir()
    out = prepare_agent_dir(tmp_path / 'exp', skill, source=empty)
    assert sorted(p.name for p in out.iterdir()) == sorted(['PREPARED.json', 'agents', 'settings.json', SHELL_NAME])


def test_every_arm_points_humain_terminal_at_the_experiment_agent_dir(tmp_path, fake_cfg):
    for arm in ARMS:
        _, env = arm_invocation(arm, 'g', fake_cfg, tmp_path / 'exp')
        assert env[AGENT_DIR_ENV] == str(agent_dir_path(tmp_path / 'exp'))


def test_runner_prepares_the_agent_dir_before_attempts(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'noop')
    run_experiment(tiny_suite, replace(fake_cfg), ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    out = agent_dir_path(tmp_path / 'exp')
    assert (out / 'PREPARED.json').is_file()
    assert any((out / 'agents').glob('*.md'))          # fake_cfg.skill_root is this repo: real personas


# --- the agent's shell sees the environment of normal use, not the harness's ----------------------------

import os
import subprocess

from bench.arms import injected_env_keys


def test_settings_point_the_bash_tool_at_a_scrubbing_shell_and_keep_user_settings(tmp_path):
    skill, user = _skill(tmp_path), _user_agent_dir(tmp_path)
    (user / 'settings.json').write_text('{"theme": "dark", "defaultProvider": "amazon-bedrock"}')
    out = prepare_agent_dir(tmp_path / 'exp', skill, source=user)
    settings = json.loads((out / 'settings.json').read_text())
    assert not (out / 'settings.json').is_symlink()
    assert settings['theme'] == 'dark' and settings['defaultProvider'] == 'amazon-bedrock'
    assert settings['shellPath'] == str(out / SHELL_NAME)
    assert json.loads((user / 'settings.json').read_text()).get('shellPath') is None     # user file untouched


def test_scrubbing_shell_removes_every_injected_key_and_nothing_else(tmp_path, fake_cfg):
    out = prepare_agent_dir(tmp_path / 'exp', _skill(tmp_path), source=_user_agent_dir(tmp_path))
    _, arm_env = arm_invocation('tiered', 'g', fake_cfg, tmp_path / 'exp')
    assert set(arm_env) <= set(injected_env_keys())                                   # no key can slip through
    env = {**os.environ, **arm_env, 'KEEP_ME': 'yes'}
    shown = subprocess.run([str(out / SHELL_NAME), '-c', 'env'], env=env, capture_output=True, text=True, check=True).stdout
    names = {line.split('=', 1)[0] for line in shown.splitlines() if '=' in line}
    assert not names & set(injected_env_keys())
    assert 'KEEP_ME' in names and 'PATH' in names


def test_scrubbing_shell_preserves_exit_status_and_arguments(tmp_path):
    out = prepare_agent_dir(tmp_path / 'exp', _skill(tmp_path), source=_user_agent_dir(tmp_path))
    p = subprocess.run([str(out / SHELL_NAME), '-c', 'printf "%s|" "$0" "$1"; exit 7', 'zero', 'one two'],
                       capture_output=True, text=True)
    assert p.returncode == 7 and p.stdout == 'zero|one two|'

import json
from dataclasses import replace

from bench.agent_dir import AGENT_DIR_ENV, CREDENTIAL_FILES, agent_dir_path, prepare_agent_dir
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
    assert (out / 'settings.json').is_symlink()
    assert not (out / 'extensions').exists() and not (out / 'sessions').exists()
    assert set(p.name for p in out.iterdir()) <= {'agents', 'PREPARED.json', *CREDENTIAL_FILES}
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
    assert sorted(p.name for p in out.iterdir()) == ['PREPARED.json', 'agents']


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

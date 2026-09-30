import pytest
from bench.arms import ExperimentConfig, arm_invocation

def cfg(tmp_path):
    (tmp_path / 'profiles.json').write_text('{}')
    return ExperimentConfig('exp1', 7, 3, 'humain-terminal', tmp_path, tmp_path / 'profiles.json',
                            'amazon-bedrock/claude-sonnet-5', 'high', ('--profile', 'premium'), 5.0, 1800)

def test_direct_arm_is_plain_single_agent(tmp_path):
    argv, env = arm_invocation('direct', 'Fix X', cfg(tmp_path), tmp_path / 'exp')
    assert argv[:4] == ['humain-terminal', '--mode', 'json', '-p']
    assert '--no-extensions' in argv and argv[-1] == 'Fix X'
    assert ['--provider', 'amazon-bedrock', '--model', 'claude-sonnet-5'] == argv[argv.index('--provider'):argv.index('--provider') + 4]

def test_orchestrated_arms_run_in_foreground_with_isolated_root(tmp_path):
    for arm, mode in (('current', 'off'), ('tiered', 'enforce')):
        argv, env = arm_invocation(arm, 'Fix X', cfg(tmp_path), tmp_path / 'exp')
        assert argv[-1] == '/orchestrate --profile premium Fix X'
        ext = str(tmp_path / 'bridge' / 'extensions' / 'orchestrator')
        assert argv[-4:-1] == ['--no-extensions', '-e', ext]   # only the pinned copy's extension, right before the prompt
        assert env['HUMAIN_ORCHESTRATOR_SKILL_ROOT'] == str(tmp_path)
        assert env['HUMAIN_ORCHESTRATOR_FOREGROUND'] == '1'
        assert env['CODING_AGENT_ORCHESTRATOR_HOME'] == str(tmp_path / 'exp' / 'state')
        assert env['HUMAIN_ORCHESTRATOR_STATE_ROOT'] == str(tmp_path / 'exp' / 'state')
        assert env['HUMAIN_ORCHESTRATOR_WORKFLOW_MODE'] == mode

def test_unknown_arm_rejected(tmp_path):
    with pytest.raises(ValueError):
        arm_invocation('forced-direct', 'x', cfg(tmp_path), tmp_path)


def test_provenance_uses_git_head_for_a_checkout(tmp_path, make_repo):
    import dataclasses, subprocess
    from bench.arms import provenance
    repo, _ = make_repo(tmp_path)
    c = dataclasses.replace(cfg(tmp_path), skill_root=repo)
    head = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    p = provenance(c)
    assert p['skill_head'] == head and 'skill_dirty_sha' in p and 'skill_pinned' not in p


def test_provenance_uses_pinned_json_for_a_pinned_copy(tmp_path):
    import dataclasses, json
    from bench.arms import config_fingerprint, provenance
    skill = tmp_path / 'tools' / 'skill'; skill.mkdir(parents=True)
    pin = {'source_repo': '/src/hao', 'commit': 'a' * 40, 'tree_digest': 'd' * 64}
    (skill / 'PINNED.json').write_text(json.dumps(pin))
    c = dataclasses.replace(cfg(tmp_path), skill_root=skill)
    p = provenance(c)
    assert p['skill_pinned'] == pin and 'skill_head' not in p
    before = config_fingerprint(c)
    (skill / 'PINNED.json').write_text(json.dumps({**pin, 'commit': 'b' * 40}))
    assert config_fingerprint(c) != before


def test_provenance_records_resolved_binary_and_nearby_pinned_json(tmp_path):
    import dataclasses, json, os
    from bench.arms import config_fingerprint, provenance
    pkg = tmp_path / 'ht' / 'node' / 'pkg'
    cli = pkg / 'dist' / 'bundle' / 'cli.js'; cli.parent.mkdir(parents=True); cli.write_text('#!/usr/bin/env node\n')
    link = tmp_path / 'humain-terminal'; link.symlink_to(cli)
    c = dataclasses.replace(cfg(tmp_path), binary=str(link))
    p = provenance(c)
    assert p['binary_path'] == os.path.realpath(cli) and p['binary_pinned'] is None
    (tmp_path / 'ht' / 'PINNED.json').write_text('{"commit": "far"}')      # 5 levels up: out of reach
    assert provenance(c)['binary_pinned'] is None
    before = config_fingerprint(c)
    (pkg / 'PINNED.json').write_text(json.dumps({'commit': 'c' * 40}))      # 3rd dir up from cli.js
    assert provenance(c)['binary_pinned'] == {'commit': 'c' * 40}
    assert config_fingerprint(c) != before

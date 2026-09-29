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
        assert env['HUMAIN_ORCHESTRATOR_FOREGROUND'] == '1'
        assert env['CODING_AGENT_ORCHESTRATOR_HOME'] == str(tmp_path / 'exp' / 'state')
        assert env['HUMAIN_ORCHESTRATOR_STATE_ROOT'] == str(tmp_path / 'exp' / 'state')
        assert env['HUMAIN_ORCHESTRATOR_WORKFLOW_MODE'] == mode

def test_unknown_arm_rejected(tmp_path):
    with pytest.raises(ValueError):
        arm_invocation('forced-direct', 'x', cfg(tmp_path), tmp_path)

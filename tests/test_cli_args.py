"""Cross-checks the argparse surface in `orchestrator/cli.py` against the exact argv the TS
bridge (`bridge/extensions/orchestrator/index.ts`) builds for `python3 -m orchestrator.cli`.

The bridge and the CLI are two independently maintained sources of truth for the same argv
contract; nothing short of running the real parser against the bridge's real argv would have
caught `plan` silently rejecting `--quality-floor`/`--cost-aggressiveness` (accepted only on
`route`) with "unrecognized arguments".
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from orchestrator.cli import build_parser, _format_adapter_table

REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_TS = REPO_ROOT / 'bridge' / 'extensions' / 'orchestrator' / 'index.ts'


def _bridge_source() -> str:
    return BRIDGE_TS.read_text(encoding='utf-8')


def _extract_function(source: str, name: str) -> str:
    """Return the balanced-brace body text of `function <name>(...) { ... }` (async or not)."""
    m = re.search(rf'(?:async\s+)?function\s+{re.escape(name)}\s*\([^)]*\)[^{{]*\{{', source)
    assert m, f'could not find function {name} in {BRIDGE_TS}'
    start = m.end() - 1  # position of the opening '{'
    depth = 0
    for i in range(start, len(source)):
        if source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0:
                return source[start:i + 1]
    raise AssertionError(f'unbalanced braces in function {name}')


def test_plan_run_argv_from_bridge_is_accepted_by_the_real_parser():
    """Extract the literal argv `planRun` builds (including the conditional policy flags) and
    feed a representative instance through the real argparse parser; it must not raise."""
    body = _extract_function(_bridge_source(), 'planRun')
    literals = re.findall(r'"(--[a-z-]+)"', body)
    assert '--quality-floor' in literals
    assert '--cost-aggressiveness' in literals
    assert '--coupling' in literals
    assert '--parallelizable' in literals

    argv = ['plan', 'run-1', 'coding', '0.6', 'medium',
            '--coupling', '0.5', '--parallelizable', '0.5',
            '--quality-floor', '0.9', '--cost-aggressiveness', '0.5']
    args = build_parser().parse_args(argv)
    assert args.cmd == 'plan'
    assert args.quality_floor == pytest.approx(0.9)
    assert args.cost_aggressiveness == pytest.approx(0.5)


# Commands the bridge invokes as a direct `orchestrator.cli <cmd> ...` subprocess with literal
# `"--flag"` argv elements (as opposed to `metric`/`outcome`, which the bridge only ever sends
# through `batch -` with a JSON payload, and `route`, which the bridge never invokes directly).
_BRIDGE_FUNCTIONS_BY_COMMAND = {
    'plan': 'planRun',
}


@pytest.mark.parametrize('command,function_name', sorted(_BRIDGE_FUNCTIONS_BY_COMMAND.items()))
def test_every_bridge_flag_literal_is_accepted_by_its_subparser(command, function_name):
    """Generic guard: every literal `"--flag"` the bridge pushes into a given command's argv
    must be a real, accepted flag on that command's subparser.

    This is the shape of test that would have caught bug 1: it needs no per-flag knowledge and
    fails the moment the bridge and cli.py's subparsers disagree on the flags of any of `plan`,
    `route`, `metric`, `outcome` (or any other command added here later).
    """
    body = _extract_function(_bridge_source(), function_name)
    flags = sorted(set(re.findall(r'"(--[a-z-]+)"', body)))
    parser = build_parser()
    subparsers_actions = [a for a in parser._subparsers._group_actions if hasattr(a, 'choices')]
    subparser = subparsers_actions[0].choices[command]
    accepted = {opt for action in subparser._actions for opt in action.option_strings}
    missing = [f for f in flags if f not in accepted]
    assert not missing, (
        f'{function_name}() passes {missing} to `{command}` but the `{command}` subparser in '
        f'cli.py does not accept them'
    )


def test_route_and_metric_and_outcome_are_never_invoked_directly_with_extra_flags():
    """Documents the current bridge contract: `route`/`metric`/`outcome` reach Python only via
    `batch -`/`event`/`metric`/`outcome` with a JSON payload, never with extra literal flags. If
    this ever changes, add the new call site to `_BRIDGE_FUNCTIONS_BY_COMMAND` above so the
    generic flag check covers it too.
    """
    source = _bridge_source()
    assert 'runModule("orchestrator.cli", ["batch", "-"]' in source
    assert re.search(r'runModule\("orchestrator\.cli",\s*\[\s*"route"', source) is None


def test_models_table_renders_none_provider_as_dash():
    """Bug 5a: a model with no known provider (`provider_for_model` returned None) must not
    break `:<20` string formatting in the `resolve-adapter` default table.
    """
    adapter = {
        'coding': {
            'tier': 'flagship',
            'provider': None,
            'model': 'some-model',
            'input_cost_per_m': 3.0,
            'output_cost_per_m': 15.0,
        },
    }
    table = _format_adapter_table(adapter)
    assert '-' in table.splitlines()[-1]
    assert 'some-model' in table


def test_plan_end_to_end_accepts_quality_floor_and_cost_aggressiveness(tmp_path):
    """Subprocess-level regression for bug 1: the exact `plan` invocation the bridge makes must
    exit 0 and produce JSON, not `unrecognized arguments`."""
    state = tmp_path / 'state'
    env = {
        **os.environ,
        'CODING_AGENT_ORCHESTRATOR_HOME': str(state),
        'PYTHONPATH': str(REPO_ROOT),
    }
    command = [sys.executable, '-m', 'orchestrator.cli', 'plan', 'run-1', 'coding', '0.6', 'medium',
               '--coupling', '0.5', '--parallelizable', '0.5',
               '--quality-floor', '0.9', '--cost-aggressiveness', '0.5']
    result = subprocess.run(command, env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    import json
    body = json.loads(result.stdout)
    assert body['effective_quality_floor'] == pytest.approx(0.9)
    assert body['cost_aggressiveness'] == pytest.approx(0.5)

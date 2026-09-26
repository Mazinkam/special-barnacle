"""Bug 6: `read_json` must silently return the default for a missing file, but must not
silently swallow a corrupt/unreadable *existing* file — a warning should reach stderr so a
broken config.json is not indistinguishable from an absent one.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path


from orchestrator.runtime import read_json

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / 'orchestrator' / 'config.json'


def test_missing_file_returns_default_with_no_warning(tmp_path, caplog):
    path = tmp_path / 'does-not-exist.json'
    with caplog.at_level(logging.WARNING, logger='orchestrator'):
        result = read_json(path, {'default': True})
    assert result == {'default': True}
    assert caplog.records == []


def test_valid_file_is_parsed_with_no_warning(tmp_path, caplog):
    path = tmp_path / 'config.json'
    path.write_text(json.dumps({'a': 1}), encoding='utf-8')
    with caplog.at_level(logging.WARNING, logger='orchestrator'):
        result = read_json(path, {})
    assert result == {'a': 1}
    assert caplog.records == []


def test_corrupt_file_returns_default_and_warns(tmp_path, caplog):
    path = tmp_path / 'config.json'
    path.write_text('{not valid json', encoding='utf-8')
    with caplog.at_level(logging.WARNING, logger='orchestrator'):
        result = read_json(path, {'fallback': True})
    assert result == {'fallback': True}
    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert str(path) in message
    assert caplog.records[0].levelno == logging.WARNING


def test_corrupt_file_warning_reaches_stderr_not_via_print(tmp_path, capsys):
    """The warning must not be a plain `print` to stdout: CLI stdout is JSON the bridge parses."""
    path = tmp_path / 'config.json'
    path.write_text('{not valid json', encoding='utf-8')
    read_json(path, {})
    captured = capsys.readouterr()
    assert captured.out == ''


def test_unreadable_directory_instead_of_file_returns_default_and_warns(tmp_path, caplog):
    """Any read/parse failure on an existing path (not just bad JSON) must warn, not just json
    decode errors — e.g. the path exists but is a directory, not a file."""
    path = tmp_path / 'config.json'
    path.mkdir()
    with caplog.at_level(logging.WARNING, logger='orchestrator'):
        result = read_json(path, {'fallback': True})
    assert result == {'fallback': True}
    assert len(caplog.records) == 1


def test_cli_plan_with_corrupt_config_still_exits_zero_with_stderr_warning(tmp_path):
    """End-to-end: a corrupt orchestrator/config.json must not break `plan`/`route`; the CLI
    falls back to defaults and warns on stderr, with stdout still clean JSON for the bridge."""
    original = CONFIG_PATH.read_text(encoding='utf-8')
    try:
        CONFIG_PATH.write_text('{this is not valid json', encoding='utf-8')
        state = tmp_path / 'state'
        env = {
            **os.environ,
            'CODING_AGENT_ORCHESTRATOR_HOME': str(state),
            'PYTHONPATH': str(REPO_ROOT),
        }
        command = [sys.executable, '-m', 'orchestrator.cli', 'plan', 'run-1', 'coding', '0.6', 'medium']
        result = subprocess.run(command, env=env, capture_output=True, text=True, check=False)
        assert result.returncode == 0, result.stderr
        assert result.stderr.strip() != ''
        assert 'config.json' in result.stderr
        # stdout must be exactly the JSON plan the bridge parses with `.trim()` — no warning text mixed in.
        body = json.loads(result.stdout)
        assert body['task_class'] == 'coding'
    finally:
        CONFIG_PATH.write_text(original, encoding='utf-8')

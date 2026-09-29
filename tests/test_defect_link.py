import json
import sys
from unittest import mock

import pytest

from orchestrator import cli
from orchestrator.outcomes import bad_signal


def _run(tmp_path, argv):
    # `cli.main()` takes no argv parameter; it parses `sys.argv` (orchestrator/cli/__init__.py:195).
    with mock.patch.object(cli, 'ROOT', tmp_path), mock.patch.object(sys, 'argv', ['orchestrator', *argv]):
        with pytest.raises(SystemExit) as exc:
            cli.main()
    return exc.value.code


def _rows(tmp_path):
    return [json.loads(l) for l in (tmp_path / 'outcomes.jsonl').read_text().splitlines() if l.strip()]


def test_unconfirmed_link_is_candidate_not_bad(tmp_path):
    assert _run(tmp_path, ['defect-link', 'R1', '--type', 'revert', '--severity', 'high', '--evidence', 'x']) == 0
    [row] = _rows(tmp_path)
    assert row['kind'] == 'defect_link' and row['task_id'] == 'defect-link' and row['confirmed'] is False
    assert bad_signal(row) is False


def test_confirmed_link_counts_as_regression(tmp_path):
    assert _run(tmp_path, ['defect-link', 'R2', '--type', 'bug_traced', '--severity', 'medium',
                           '--evidence', 'issue 42', '--attribution', 'human_confirmed', '--confirmed']) == 0
    [row] = _rows(tmp_path)
    assert row['regression'] is True and bad_signal(row) is True

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from orchestrator import cli
from orchestrator.cli import make_ingest_status
from orchestrator.runtime import load_jsonl, read_json
from test_ingest import humain_terminal_log


STATUS_FIELDS = {
    'version', 'last_attempt_at', 'last_success_at', 'status', 'files_scanned',
    'emitted', 'failure_count', 'error', 'sweep_interval_seconds',
}


def test_duplicate_only_ingest_still_refreshes(tmp_path):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    first = cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                               repository=None, dry_run=False, granularity='session')
    assert first['emitted'] == 1

    with patch('orchestrator.cli.refresh') as refresh:
        result = cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                                    repository=None, dry_run=False, granularity='session')

    assert result['emitted'] == 0
    assert len(load_jsonl(root / 'metrics.jsonl')) == 1
    refresh.assert_called_once_with(root)


def test_duplicate_only_batch_writes_ok_status_with_exact_fields(tmp_path):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                       repository=None, dry_run=False, granularity='session')

    with patch.dict('os.environ', {'HUMAIN_ORCHESTRATOR_INGEST_INTERVAL': '1200'}):
        result = cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                                    repository=None, dry_run=False, granularity='session')

    status = read_json(root / 'ingest_status.json', {})
    assert result['emitted'] == 0
    assert set(status) == STATUS_FIELDS
    assert status == {
        'version': 1,
        'last_attempt_at': status['last_attempt_at'],
        'last_success_at': status['last_attempt_at'],
        'status': 'ok',
        'files_scanned': 1,
        'emitted': 0,
        'failure_count': 0,
        'error': None,
        'sweep_interval_seconds': 1200,
    }


def test_make_ingest_status_bounds_failure_details():
    result = make_ingest_status({}, {
        'failures': [{'error': 'first detail ' + 'x' * 700}, {'error': 'second detail'}],
        'files_scanned': 2,
        'emitted': 0,
    })

    assert result['status'] == 'partial'
    assert result['error'].startswith('2 file(s) failed; first: first detail ')
    assert len(result['error']) == 500


def test_ingest_reports_per_file_progress_to_stderr_when_not_quiet(tmp_path, monkeypatch, capsys):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    monkeypatch.setattr(cli, 'ROOT', root)
    monkeypatch.setattr('sys.argv', ['orchestrator', 'ingest', str(session), '--runtime',
                                     'humain-terminal', '--granularity', 'session'])

    cli.main()

    captured = capsys.readouterr()
    assert '[1/1] humain-terminal' in captured.err
    assert session.name in captured.err
    assert json.loads(captured.out)['emitted'] == 1


def test_progress_output_survives_empty_session_log_without_runtime(tmp_path, monkeypatch, capsys):
    """An empty log yields runtime=None in its summary; progress rendering must not abort the batch."""
    root = tmp_path / 'state'
    empty = tmp_path / 'empty.jsonl'
    empty.write_text('', encoding='utf-8')
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    monkeypatch.setattr(cli, 'ROOT', root)
    monkeypatch.setattr('sys.argv', ['orchestrator', 'ingest', str(empty), str(session), '--granularity', 'session'])

    cli.main()

    captured = capsys.readouterr()
    assert '[1/2]' in captured.err and '[2/2]' in captured.err
    assert json.loads(captured.out)['emitted'] == 1
    assert len(load_jsonl(root / 'metrics.jsonl')) == 1


def test_partial_batch_materializes_success_and_cli_exits_nonzero(tmp_path, monkeypatch, capsys):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    missing = tmp_path / 'unreadable.jsonl'
    monkeypatch.setattr(cli, 'ROOT', root)
    monkeypatch.setattr('sys.argv', ['orchestrator', 'ingest', str(missing), str(session),
                                     '--runtime', 'humain-terminal', '--granularity', 'session', '--quiet'])

    with pytest.raises(SystemExit) as raised:
        cli.main()

    captured = capsys.readouterr()
    stdout = captured.out
    stderr = captured.err
    status = read_json(root / 'ingest_status.json', {})
    assert raised.value.code == 1
    assert status['status'] == 'partial'
    assert set(status) == STATUS_FIELDS
    assert status['files_scanned'] == 2
    assert status['emitted'] == 1
    assert status['failure_count'] == 1
    assert status['last_success_at'] is None
    assert status['error']
    assert len(load_jsonl(root / 'metrics.jsonl')) == 1
    assert '1 file(s) failed; first:' in stderr
    assert len(stderr.splitlines()) == 1
    assert '"failures"' in stdout


def test_dry_run_does_not_write_status_or_refresh(tmp_path):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    with patch('orchestrator.cli.refresh') as refresh:
        result = cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                                    repository=None, dry_run=True, granularity='session')

    assert result['emitted'] == 1
    assert not (root / 'ingest_status.json').exists()
    refresh.assert_not_called()


def test_discovery_sweep_catches_up_idempotently_after_a_missed_hook(tmp_path):
    home = tmp_path / 'home'
    session = home / '.humain-terminal/agent/sessions/--Users-test-Projects-app--/session.jsonl'
    session.parent.mkdir(parents=True)
    marker = 'MARKER_DO_NOT_LEAK_7f3a'

    def assistant_call(call_id, output):
        return {
            'type': 'message', 'id': call_id, 'timestamp': '2026-09-23T10:00:00Z',
            'message': {'role': 'assistant', 'model': 'claude-sonnet-5',
                        'content': [{'type': 'text', 'text': marker}],
                        'usage': {'input': 20, 'output': output, 'totalTokens': 20 + output}},
        }

    session.write_text(''.join(json.dumps(row) + '\n' for row in (
        {'type': 'session', 'id': 'sweep-session'},
        assistant_call('call-1', 5), assistant_call('call-2', 7),
    )), encoding='utf-8')
    state = tmp_path / 'state'
    repo_root = Path(__file__).resolve().parents[1]
    env = {
        **os.environ,
        'HOME': str(home),
        'CODING_AGENT_ORCHESTRATOR_HOME': str(state),
        'PYTHONPATH': str(repo_root),
    }
    command = [sys.executable, '-m', 'orchestrator.cli', 'ingest', '--discover',
               '--since-days', '2', '--granularity', 'session', '--quiet']

    def sweep():
        return subprocess.run(command, env=env, capture_output=True, text=True, check=False)

    first = sweep()
    assert first.returncode == 0, first.stderr
    rows = load_jsonl(state / 'metrics.jsonl')
    assert sum(row['covers_calls'] for row in rows) == 2
    assert len(rows) == 1
    initial_status = read_json(state / 'ingest_status.json', {})
    assert set(initial_status) == STATUS_FIELDS
    assert initial_status['status'] == 'ok'
    assert (state / 'ledger.json').exists()
    assert (state / 'dashboard.html').exists()

    second = sweep()
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout)['emitted'] == 0
    assert sum(row['covers_calls'] for row in load_jsonl(state / 'metrics.jsonl')) == 2

    with session.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(assistant_call('call-3', 9)) + '\n')
    caught_up = sweep()
    assert caught_up.returncode == 0, caught_up.stderr
    assert json.loads(caught_up.stdout)['emitted'] == 1
    final_rows = load_jsonl(state / 'metrics.jsonl')
    assert sum(row['covers_calls'] for row in final_rows) == 3
    assert len(final_rows) == 2

    status_text = (state / 'ingest_status.json').read_text(encoding='utf-8')
    dashboard_text = (state / 'dashboard.html').read_text(encoding='utf-8')
    metrics_text = (state / 'metrics.jsonl').read_text(encoding='utf-8')
    assert marker not in metrics_text
    assert marker not in status_text
    assert marker not in dashboard_text
    final_status = read_json(state / 'ingest_status.json', {})
    assert set(final_status) == STATUS_FIELDS
    assert final_status['status'] == 'ok'
    assert final_status['files_scanned'] == 1
    assert final_status['emitted'] == 1


def test_refresh_with_corrupt_ingest_status_renders_unknown(tmp_path):
    root = tmp_path / 'state'
    root.mkdir()
    (root / 'ingest_status.json').write_text('{corrupt json', encoding='utf-8')

    dashboard = cli.refresh(root)

    assert dashboard == root / 'dashboard.html'
    rendered = dashboard.read_text(encoding='utf-8')
    assert '"status": "unknown"' in rendered
    assert 'Traceback' not in rendered


def test_failed_render_is_recovered_by_duplicate_only_retry(tmp_path):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                       repository=None, dry_run=False, granularity='session')
    previous_success = read_json(root / 'ingest_status.json', {})['last_success_at']

    with session.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps({
            'type': 'message', 'id': 'assistant-added', 'timestamp': '2026-09-22T10:00:00Z',
            'message': {'role': 'assistant', 'model': 'claude-sonnet-5',
                        'usage': {'input': 10, 'output': 5, 'totalTokens': 15}},
        }) + '\n')

    with patch('orchestrator.cli.refresh', side_effect=RuntimeError('renderer failed')) as refresh:
        with pytest.raises(RuntimeError, match='renderer failed'):
            cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                               repository=None, dry_run=False, granularity='session')
    failed_status = read_json(root / 'ingest_status.json', {})
    assert failed_status['status'] == 'error'
    assert failed_status['failure_count'] == 1
    assert failed_status['last_success_at'] == previous_success
    assert failed_status['error'] == 'renderer failed'
    assert len(load_jsonl(root / 'metrics.jsonl')) == 2
    refresh.assert_called_once_with(root)

    with patch('orchestrator.cli.refresh', wraps=cli.refresh) as retry_refresh:
        retry = cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                                   repository=None, dry_run=False, granularity='session')

    status = read_json(root / 'ingest_status.json', {})
    assert retry['emitted'] == 0
    assert len(load_jsonl(root / 'metrics.jsonl')) == 2
    assert status['status'] == 'ok'
    assert status['last_success_at'] != previous_success
    retry_refresh.assert_called_once_with(root)

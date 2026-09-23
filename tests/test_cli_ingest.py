from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from orchestrator import cli
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


def test_partial_batch_materializes_success_and_cli_exits_nonzero(tmp_path, monkeypatch):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    missing = tmp_path / 'unreadable.jsonl'
    monkeypatch.setattr(cli, 'ROOT', root)
    monkeypatch.setattr('sys.argv', ['orchestrator', 'ingest', str(missing), str(session),
                                     '--runtime', 'humain-terminal', '--granularity', 'session', '--quiet'])

    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout), pytest.raises(SystemExit) as raised:
        cli.main()

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
    assert '"failures"' in stdout.getvalue()


def test_dry_run_does_not_write_status_or_refresh(tmp_path):
    root = tmp_path / 'state'
    session = humain_terminal_log(tmp_path / 'session.jsonl')
    with patch('orchestrator.cli.refresh') as refresh:
        result = cli.process_ingest([session], state_root=root, runtime='humain-terminal',
                                    repository=None, dry_run=True, granularity='session')

    assert result['emitted'] == 1
    assert not (root / 'ingest_status.json').exists()
    refresh.assert_not_called()


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

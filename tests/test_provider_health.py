import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from orchestrator.dashboard import build_data
from orchestrator.presentation.dashboard_html import render
from orchestrator.record_batch import BatchValidationError, validate_batch
from scripts.backfill_provider_errors import backfill


def test_batch_accepts_normalized_health_and_rejects_raw_evidence():
    rows = [
        {'stream': 'event', 'record_id': 'a', 'event': 'provider_error', 'provider': 'acme',
         'error_code': 'ECONNRESET', 'count': 2, 'first_ts': '2026-01-01T00:00:00Z',
         'last_ts': '2026-01-01T00:00:05Z', 'run_id': 'r', 'dispatch_attempt': 0},
        {'stream': 'event', 'record_id': 'b', 'event': 'dispatch_finished', 'outcome': 'failed',
         'failure_class': 'transient', 'provider': 'acme', 'provider_model': 'm'},
    ]
    assert validate_batch(rows) == rows
    with pytest.raises(BatchValidationError):
        validate_batch([{**rows[0], 'stderr': 'secret'}])
    with pytest.raises(BatchValidationError):
        validate_batch([{**rows[0], 'error_code': 'some raw error'}])
    with pytest.raises(BatchValidationError):
        validate_batch([{**rows[1], 'failure_class': 'unknown'}])
    with pytest.raises(BatchValidationError):
        validate_batch([{**rows[0], 'endpoint_host': 'https://secret.example/path?token=foo'}])


def test_provider_panel_groups_outage_and_keeps_first_failure_separate(tmp_path: Path):
    events = [
        {'event': 'provider_error', 'ts': '2026-01-08T11:00:00Z', 'first_ts': '2026-01-08T11:00:00Z', 'last_ts': '2026-01-08T11:00:00Z', 'provider': 'acme', 'error_code': 'ECONNRESET', 'count': 2, 'run_id': 'r1'},
        {'event': 'provider_error', 'ts': '2026-01-08T11:09:00Z', 'first_ts': '2026-01-08T11:09:00Z', 'last_ts': '2026-01-08T11:09:00Z', 'provider': 'acme', 'error_code': 'ECONNRESET', 'count': 1, 'run_id': 'r2'},
        {'event': 'provider_error', 'ts': '2026-01-08T11:19:00Z', 'first_ts': '2026-01-08T11:19:00Z', 'last_ts': '2026-01-08T11:19:00Z', 'provider': 'acme', 'error_code': 'ECONNRESET', 'count': 1, 'run_id': 'r3'},
        {'event': 'provider_error', 'ts': '2026-01-08T11:01:00Z', 'provider': 'other', 'error_code': 'quota', 'count': 1, 'run_id': 'r4'},
        {'event': 'dispatch_finished', 'ts': '2026-01-08T11:02:00Z', 'run_id': 'r1', 'task_id': 't1', 'outcome': 'failed', 'failure_class': 'transient', 'provider': 'acme', 'cost_usd': 1.25},
        {'event': 'dispatch_finished', 'ts': '2026-01-08T11:03:00Z', 'run_id': 'r1', 'task_id': 't2', 'outcome': 'failed', 'failure_class': 'task', 'provider': 'acme', 'cost_usd': 2},
        {'event': 'dispatch_finished', 'ts': '2026-01-08T11:04:00Z', 'run_id': 'r2', 'task_id': 't3', 'outcome': 'timed_out', 'failure_class': 'provider_stall', 'provider': 'acme', 'cost_usd': 3},
        {'event': 'dispatch_finished', 'ts': '2026-01-08T11:05:00Z', 'run_id': 'r5', 'task_id': 't4', 'outcome': 'completed', 'provider': 'acme', 'cost_usd': 4},
    ]
    (tmp_path / 'events.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in events))
    from orchestrator.presentation import dashboard_data
    panel = dashboard_data.provider_health(events, now=datetime(2026, 1, 8, 12, tzinfo=timezone.utc))
    assert panel['errors_by_hour'] == [{'hour': '2026-01-08T11:00:00+00:00', 'provider': 'acme', 'count': 4}, {'hour': '2026-01-08T11:00:00+00:00', 'provider': 'other', 'count': 1}]
    assert panel['outage_windows'][0] == {'provider': 'acme', 'error_code': 'ECONNRESET', 'start': '2026-01-08T11:00:00+00:00', 'end': '2026-01-08T11:09:00+00:00', 'count': 3, 'runs': 2}
    assert len(panel['outage_windows']) == 3
    assert panel['failed_dispatches'] == 3
    assert panel['failed_dispatch_cost_usd'] == 6.25
    assert panel['first_failure_provider_runs'] == 2
    assert panel['first_failure_provider_run_ids'] == ['r1', 'r2']
    data = build_data(tmp_path, {'features': {}})
    assert 'provider_health' in data and data['summary']['total_cost'] == 0
    html = ''.join(render(data))
    assert 'Provider health' in html and 'first_failure_provider_runs' in html


def test_backfill_dry_run_default_and_repeat_write_is_idempotent(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'r1'
    run.mkdir(parents=True)
    (run / 'run.log').write_text('2026-01-08T11:00:00Z provider acme/model ECONNRESET\n')
    (run / 'task.stderr.log').write_text('2026-01-08T11:01:00Z fetch failed\n')
    assert backfill(root)['candidates'] == 2
    assert not (root / 'events.jsonl').exists()
    assert backfill(root, write=True)['persisted'] == 2
    assert backfill(root, write=True)['persisted'] == 0
    assert len((root / 'events.jsonl').read_text().splitlines()) == 2


def test_backfill_refuses_symlinked_logs_and_write_without_explicit_directory(tmp_path: Path):
    state = tmp_path / 'state'
    run = state / 'runs' / 'r1'
    run.mkdir(parents=True)
    outside = tmp_path / 'outside.stderr.log'
    outside.write_text('ECONNRESET\n')
    (run / 'escaped.stderr.log').symlink_to(outside)
    assert backfill(state, write=True) == {'candidates': 0, 'persisted': 0}
    result = subprocess.run([sys.executable, '-m', 'scripts.backfill_provider_errors', '--write'],
                            capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert '--state-dir is required' in result.stderr

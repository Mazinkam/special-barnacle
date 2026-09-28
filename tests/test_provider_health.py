import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from orchestrator.dashboard import build_data
from orchestrator.presentation.dashboard_html import render
from orchestrator.record_batch import BatchValidationError, validate_batch, write_batch
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


def test_provider_error_rejects_arbitrary_evidence_before_any_append(tmp_path: Path):
    base = {'stream': 'event', 'record_id': 'e1', 'event': 'provider_error',
            'provider': 'acme', 'error_code': 'quota', 'count': 1}
    for extra in ({'access_token': 'credential'}, {'debug': {'password': 'credential'}},
                  {'endpoint_host': 'safe.example', 'unrecognized': 'secret'}):
        with pytest.raises(BatchValidationError, match='unsupported provider_error fields'):
            write_batch(tmp_path, [{**base, **extra}], refresh=False)
    with pytest.raises(BatchValidationError, match='invalid provider_error source'):
        write_batch(tmp_path, [{**base, 'source': 'token=credential'}], refresh=False)
    assert not (tmp_path / 'events.jsonl').exists()
    assert validate_batch([{**base, 'source': 'legacy_provider_backfill',
                            'first_ts': '2026-01-08T11:00:00Z'}])


@pytest.mark.parametrize(('field', 'value'), [
    ('provider', 'api_key=secret'), ('provider', 'vendor\nsecret'),
    ('provider', 'x' * 49), ('provider', 'vendor/model'),
    ('model', 'token=secret'), ('model', 'model with spaces'),
    ('model', 'https://user:pass@example.com'), ('model', 'x' * 121),
    ('endpoint_host', 'user:pass@api.example.com'), ('endpoint_host', 'bad..host'),
    ('endpoint_host', '-bad.example.com'), ('endpoint_host', 'host\nsecret'),
    ('error_code', 'ECONNRESET\nsecret'), ('error_code', 'quota token=secret'),
])
def test_provider_error_rejects_leak_in_normalized_fields_before_append(tmp_path: Path, field: str, value: str):
    row = {'stream': 'event', 'record_id': 'e1', 'event': 'provider_error',
           'provider': 'openai-codex', 'model': 'gpt-6', 'error_code': 'ECONNRESET',
           'endpoint_host': 'api.example.com', 'count': 1, field: value}
    with pytest.raises(BatchValidationError) as exc:
        write_batch(tmp_path, [row], refresh=False)
    assert value not in str(exc.value)
    assert not (tmp_path / 'events.jsonl').exists()


def test_undated_precision_requires_legacy_source_and_no_evidence_timestamps():
    base = {'stream': 'event', 'record_id': 'e', 'event': 'provider_error',
            'provider': 'unknown', 'error_code': 'quota', 'count': 1,
            'timestamp_precision': 'unknown'}
    with pytest.raises(BatchValidationError, match='invalid timestamp_precision'):
        validate_batch([base])
    with pytest.raises(BatchValidationError, match='invalid timestamp_precision'):
        validate_batch([{**base, 'source': 'legacy_provider_backfill', 'first_ts': '2026-09-26T00:00:00Z'}])
    assert validate_batch([{**base, 'source': 'legacy_provider_backfill'}])


def test_provider_error_accepts_bridge_normalized_values_and_legacy_unknown(tmp_path: Path):
    rows = [
        {'stream': 'event', 'record_id': 'e1', 'event': 'provider_error',
         'provider': 'openai-codex', 'model': 'gpt-6.1/mini_v2', 'error_code': 'ENOTFOUND',
         'endpoint_host': 'bedrock-runtime.us-east-1.amazonaws.com', 'nested': False, 'count': 1},
        {'stream': 'event', 'record_id': 'e2', 'event': 'provider_error',
         'provider': 'unknown', 'error_code': 'stream_canceled', 'count': 1,
         'source': 'legacy_provider_backfill'},
    ]
    assert write_batch(tmp_path, rows, refresh=False)['persisted']['event'] == 2
    persisted = [json.loads(line) for line in (tmp_path / 'events.jsonl').read_text().splitlines()]
    assert [row.get('model') for row in persisted] == ['gpt-6.1/mini_v2', None]


def test_provider_panel_excludes_non_provider_failures_and_cancellations():
    from orchestrator.presentation.dashboard_data import provider_health
    rows = [{'event': 'dispatch_finished', 'ts': '2026-01-08T11:00:00Z',
             'outcome': outcome, 'failure_class': cause, 'cost_usd': cost}
            for outcome, cause, cost in [('failed', 'task', 2), ('cancelled', 'transient', 3),
                                         ('timed_out', 'provider_stall', 4), ('failed', 'quota', 5),
                                         ('failed', 'transient', 6), ('failed', None, 7)]]
    panel = provider_health(rows, now=datetime(2026, 1, 8, 12, tzinfo=timezone.utc))
    assert panel['failed_dispatches'] == 3
    assert panel['failed_dispatch_cost_usd'] == 15


def test_provider_panel_excludes_pre_cutoff_hours_and_aggregate_counts():
    from orchestrator.presentation.dashboard_data import provider_health
    rows = [{'event': 'provider_error', 'ts': '2026-01-08T12:00:00Z',
             'first_ts': first, 'last_ts': last, 'provider': 'acme', 'error_code': 'quota', 'count': count}
            for first, last, count in [('2026-01-01T11:59:00Z', '2026-01-01T12:01:00Z', 20),
                                       ('2026-01-01T12:01:00Z', '2026-01-01T12:02:00Z', 2),
                                       ('2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z', 1)]]
    panel = provider_health(rows, now=datetime(2026, 1, 8, 12, tzinfo=timezone.utc))
    assert panel['errors_by_hour'] == [{'hour': '2026-01-01T12:00:00+00:00', 'provider': 'acme', 'count': 3}]
    assert sum(w['count'] for w in panel['outage_windows']) == 3


def test_provider_panel_excludes_aggregates_crossing_future_boundary():
    from orchestrator.presentation.dashboard_data import provider_health
    rows = [{'event': 'provider_error', 'ts': '2026-01-08T11:59:00Z',
             'first_ts': '2026-01-08T11:59:00Z', 'last_ts': last,
             'provider': 'acme', 'error_code': 'quota', 'count': count}
            for last, count in [('2026-01-08T12:01:00Z', 20),
                                ('2026-01-08T12:00:00Z', 2)]]
    panel = provider_health(rows, now=datetime(2026, 1, 8, 12, tzinfo=timezone.utc))
    assert panel['errors_by_hour'] == [{'hour': '2026-01-08T11:00:00+00:00', 'provider': 'acme', 'count': 2}]
    assert sum(window['count'] for window in panel['outage_windows']) == 2


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
    assert panel['failed_dispatches'] == 2
    assert panel['failed_dispatch_cost_usd'] == 4.25
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


def test_backfill_bedrock_host_and_undated_evidence_never_create_precise_windows(tmp_path: Path):
    from orchestrator.presentation.dashboard_data import provider_health
    root = tmp_path / 'state'
    run = root / 'runs' / 'r1'
    run.mkdir(parents=True)
    (run / 'task.stderr.log').write_text(
        'getaddrinfo ENOTFOUND bedrock-runtime.eu-west-2.amazonaws.com)\n'
        'getaddrinfo ENOTFOUND user:secret@bedrock-runtime.eu-west-2.amazonaws.com)\n'
        'getaddrinfo ENOTFOUND bedrock-runtime.eu-west-2.amazonaws.com).evil.test\n'
        '2026-09-26T10:00:00Z fetch failed https://bedrock-runtime.eu-west-2.amazonaws.com/model?key=private\n'
        '2026-09-26T10:01:00Z ECONNRESET https://user:secret@bedrock-runtime.eu-west-2.amazonaws.com/path\n'
        '2026-09-26T10:02:00Z fetch failed https://bedrock-runtime.eu-west-2.amazonaws.com.evil.test/path\n'
    )
    assert backfill(root, write=True)['persisted'] == 6
    assert backfill(root, write=True)['persisted'] == 0
    rows = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
    assert rows[0]['provider'] == 'amazon-bedrock'
    assert rows[0]['endpoint_host'] == 'bedrock-runtime.eu-west-2.amazonaws.com'
    assert rows[0]['timestamp_precision'] == 'unknown'
    assert 'first_ts' not in rows[0] and 'last_ts' not in rows[0]
    assert rows[3]['provider'] == 'amazon-bedrock'
    assert rows[3]['first_ts'] == '2026-09-26T10:00:00Z'
    assert rows[1]['provider'] == rows[2]['provider'] == rows[4]['provider'] == rows[5]['provider'] == 'unknown'
    assert all('private' not in str(row) and 'secret' not in str(row) and 'evil.test' not in str(row) for row in rows)
    panel = provider_health(rows, now=datetime(2026, 9, 27, tzinfo=timezone.utc))
    assert panel['outage_windows'] == [{
        'provider': 'amazon-bedrock', 'error_code': 'fetch_failed',
        'start': '2026-09-26T10:00:00+00:00', 'end': '2026-09-26T10:00:00+00:00',
        'count': 1, 'runs': 1, 'endpoint_host': 'bedrock-runtime.eu-west-2.amazonaws.com',
    }, {'provider': 'unknown', 'error_code': 'ECONNRESET',
        'start': '2026-09-26T10:01:00+00:00', 'end': '2026-09-26T10:01:00+00:00',
        'count': 1, 'runs': 1}, {'provider': 'unknown', 'error_code': 'fetch_failed',
        'start': '2026-09-26T10:02:00+00:00', 'end': '2026-09-26T10:02:00+00:00',
        'count': 1, 'runs': 1}]
    assert sum(item['count'] for item in panel['errors_by_hour']) == 3


def test_provider_windows_group_by_provider_code_not_endpoint():
    from orchestrator.presentation.dashboard_data import provider_health
    rows = [{'event': 'provider_error', 'ts': f'2026-09-26T10:0{i}:00Z',
             'provider': 'amazon-bedrock', 'error_code': 'ENOTFOUND', 'count': 1,
             'endpoint_host': f'bedrock-runtime.{region}.amazonaws.com'}
            for i, region in enumerate(('eu-west-2', 'us-east-1'))]
    window, = provider_health(rows, now=datetime(2026, 9, 27, tzinfo=timezone.utc))['outage_windows']
    assert window['count'] == 2
    assert window['endpoint_hosts'] == ['bedrock-runtime.eu-west-2.amazonaws.com',
                                        'bedrock-runtime.us-east-1.amazonaws.com']


def test_backfill_matches_pending_stream_has_been_canceled(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'r1'
    run.mkdir(parents=True)
    (run / 'run.log').write_text('Error: pending stream has been canceled\n')
    assert backfill(root) == {'candidates': 1, 'persisted': 0}
    assert backfill(root, write=True)['persisted'] == 1
    record = json.loads((root / 'events.jsonl').read_text().splitlines()[0])
    assert record['error_code'] == 'stream_canceled'
    assert record['timestamp_precision'] == 'unknown'
    assert 'first_ts' not in record and 'last_ts' not in record


def test_backfill_refuses_resolved_live_root_alias_before_read_or_write(tmp_path: Path, monkeypatch):
    from scripts import backfill_provider_errors as module
    live = tmp_path / 'live'
    live.mkdir()
    (live / 'runs').mkdir()
    (tmp_path / 'alias').symlink_to(live, target_is_directory=True)
    monkeypatch.setattr(module, 'default_state_root', lambda: live)
    with pytest.raises(ValueError):
        backfill(tmp_path / 'alias', write=True)
    for alias in (tmp_path / 'alias' / '..' / 'live', tmp_path / 'live' / '..' / 'live'):
        with pytest.raises(ValueError, match='live default state'):
            backfill(alias, write=True)
    assert not (live / 'events.jsonl').exists()


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

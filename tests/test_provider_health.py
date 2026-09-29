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


def test_provider_panel_sums_per_attempt_cost_across_two_failed_attempts_of_one_task():
    # Phase 3 review B1: a task that fails over once (both attempts fail) must contribute the
    # SUM of each attempt's OWN cost_usd, never the final row's cumulative-across-attempts value
    # double-counted on top of the first row's own cost.
    from orchestrator.presentation.dashboard_data import provider_health
    rows = [
        {'event': 'dispatch_finished', 'ts': '2026-01-08T11:00:00Z', 'run_id': 'r1', 'task_id': 't1',
         'outcome': 'failed', 'failure_class': 'quota', 'dispatch_attempt': 0, 'cost_usd': 1.5,
         'superseded_by_fallback': True},
        {'event': 'dispatch_finished', 'ts': '2026-01-08T11:00:01Z', 'run_id': 'r1', 'task_id': 't1',
         'outcome': 'failed', 'failure_class': 'quota', 'dispatch_attempt': 1, 'cost_usd': 2.5},
    ]
    panel = provider_health(rows, now=datetime(2026, 1, 8, 12, tzinfo=timezone.utc))
    assert panel['failed_dispatches'] == 2
    assert panel['failed_dispatch_cost_usd'] == 4.0


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
    (run / 'lead.stderr.log').write_text('2026-01-08T11:00:00Z provider acme/model ECONNRESET\n')
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
    # Undated lines are no longer emitted; only the three dated ones are.
    assert backfill(root, write=True)['persisted'] == 3
    assert backfill(root, write=True)['persisted'] == 0
    rows = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
    assert all('timestamp_precision' not in row for row in rows)
    assert rows[0]['provider'] == 'amazon-bedrock'
    assert rows[0]['endpoint_host'] == 'bedrock-runtime.eu-west-2.amazonaws.com'
    assert rows[0]['first_ts'] == '2026-09-26T10:00:00Z'
    assert rows[1]['provider'] == rows[2]['provider'] == 'unknown'
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
    (run / 'task.stderr.log').write_text('Error: pending stream has been canceled\n'
                                 '2026-09-26T10:00:00Z Error: pending stream has been canceled\n')
    assert backfill(root) == {'candidates': 1, 'persisted': 0}
    assert backfill(root, write=True)['persisted'] == 1
    record = json.loads((root / 'events.jsonl').read_text().splitlines()[0])
    assert record['error_code'] == 'stream_canceled'
    assert 'timestamp_precision' not in record
    assert record['first_ts'] == record['last_ts'] == '2026-09-26T10:00:00Z'


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


def test_backfill_ignores_dated_run_log_prompt_echoes(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'r1'
    run.mkdir(parents=True)
    (run / 'run.log').write_text('2026-09-28T09:00:00Z goal: handle getaddrinfo ENOTFOUND and HTTP 503 retries\n')
    assert backfill(root) == {'candidates': 0, 'persisted': 0}
    assert backfill(root, write=True) == {'candidates': 0, 'persisted': 0}
    assert not (root / 'events.jsonl').exists()


def _live_root_with_error(tmp_path: Path, monkeypatch) -> Path:
    from scripts import backfill_provider_errors as module
    live = tmp_path / 'live'
    run = live / 'runs' / 'r1'
    run.mkdir(parents=True)
    (run / 'task.stderr.log').write_text('2026-09-26T10:00:00Z ECONNRESET\n')
    monkeypatch.setattr(module, 'default_state_root', lambda: live)
    return live


def test_backfill_live_root_write_requires_allow_live_state_flag(tmp_path: Path, monkeypatch):
    live = _live_root_with_error(tmp_path, monkeypatch)
    assert backfill(live) == {'candidates': 1, 'persisted': 0}  # dry run stays allowed
    with pytest.raises(ValueError, match='--allow-live-state'):
        backfill(live, write=True)
    assert not (live / 'events.jsonl').exists()


def test_backfill_live_root_write_with_allow_live_state_flag(tmp_path: Path, monkeypatch):
    live = _live_root_with_error(tmp_path, monkeypatch)
    assert backfill(live, write=True, allow_live_state=True) == {'candidates': 1, 'persisted': 1}
    assert backfill(live, write=True, allow_live_state=True) == {'candidates': 1, 'persisted': 0}
    assert len(_rows(live)) == 1


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


ENOTFOUND_MESSAGE = {
    'role': 'assistant', 'api': 'bedrock-converse-stream', 'provider': 'amazon-bedrock',
    'model': 'global.anthropic.claude-sonnet-5', 'stopReason': 'error', 'timestamp': 1790459367376,
    'content': [],
    'errorMessage': 'The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND '
                    'bedrock-runtime.eu-west-2.amazonaws.com)',
}


def _events(path: Path, events: list) -> None:
    path.write_text(''.join(json.dumps(event) + '\n' for event in events))


def _rows(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]


def test_structured_backfill_dedupes_repeated_top_level_error_message(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-a'
    run.mkdir(parents=True)
    _events(run / 'run-a-lead-0.events.jsonl', [
        {'type': 'message_start', 'message': ENOTFOUND_MESSAGE},
        {'type': 'message_end', 'message': ENOTFOUND_MESSAGE},
        {'type': 'turn_end', 'message': ENOTFOUND_MESSAGE, 'toolResults': []},
        {'type': 'agent_end', 'messages': [{'role': 'user', 'content': 'hi'}, ENOTFOUND_MESSAGE]},
        'not json at all',
    ])
    with (run / 'run-a-lead-0.events.jsonl').open('a') as handle:
        handle.write('{broken json\n')
    # Structured evidence exists for this run, so its dated *.stderr.log lines (which ARE scanned
    # for runs without structured rows) are not double-counted.
    (run / 'run-a-lead-0.stderr.log').write_text(
        '2026-09-26T21:49:27Z getaddrinfo ENOTFOUND bedrock-runtime.eu-west-2.amazonaws.com)\n')
    assert backfill(root) == {'candidates': 1, 'persisted': 0}
    assert backfill(root, write=True)['persisted'] == 1
    row, = _rows(root)
    assert row['ts'] == row['first_ts'] == row['last_ts'] == '2026-09-26T21:49:27.376Z'
    assert row['endpoint_host'] == 'bedrock-runtime.eu-west-2.amazonaws.com'
    assert row['provider'] == 'amazon-bedrock'
    assert row['model'] == 'global.anthropic.claude-sonnet-5'
    assert row['error_code'] == 'ENOTFOUND'
    assert row['nested'] is False
    assert row['task_id'] == 'run-a-lead-0' and row['run_id'] == 'run-a'
    assert row['source'] == 'legacy_provider_backfill' and row['count'] == 1
    assert 'timestamp_precision' not in row
    assert 'pending stream' not in json.dumps(row) and 'errorMessage' not in row
    from orchestrator.presentation.dashboard_data import provider_health
    window, = provider_health(_rows(root), now=datetime(2026, 9, 27, tzinfo=timezone.utc))['outage_windows']
    assert window['start'] == '2026-09-26T21:49:27.376000+00:00'
    assert window['endpoint_host'] == 'bedrock-runtime.eu-west-2.amazonaws.com'


def test_structured_backfill_marks_worker_results_nested(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-b'
    run.mkdir(parents=True)
    codex = {'role': 'assistant', 'provider': 'openai-codex', 'model': 'gpt-6', 'stopReason': 'error',
             'timestamp': 1790459400000, 'errorMessage': 'fetch failed'}
    worker = {'details': {'results': [{'messages': [codex]}]}}
    _events(run / 'run-b-lead-0.events.jsonl', [
        {'type': 'tool_execution_end', 'result': worker},
        {'type': 'message_end', 'message': {'role': 'toolResult', **worker}},
        {'type': 'turn_end', 'toolResults': [worker]},
    ])
    assert backfill(root, write=True)['persisted'] == 1
    row, = _rows(root)
    assert row['nested'] is True
    assert row['provider'] == 'openai-codex' and row['error_code'] == 'fetch_failed'
    assert 'endpoint_host' not in row


def test_structured_backfill_ignores_text_mentions_and_untimestamped_messages(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-c'
    run.mkdir(parents=True)
    mention = {'role': 'assistant', 'provider': 'amazon-bedrock', 'model': 'm', 'stopReason': 'stop',
               'timestamp': 1790459367376,
               'content': [{'type': 'text', 'text': 'getaddrinfo ENOTFOUND bedrock-runtime.eu-west-2.amazonaws.com'}],
               'errorMessage': 'getaddrinfo ENOTFOUND'}
    tool_output = {'role': 'toolResult', 'stopReason': 'error', 'timestamp': 1790459367376,
                   'errorMessage': 'ENOTFOUND', 'content': [{'type': 'text', 'text': 'ENOTFOUND'}]}
    untimestamped = [{**ENOTFOUND_MESSAGE, 'timestamp': value} for value in ('1790459367376', 1790459367.5, True, 5)]
    no_ts = {key: value for key, value in ENOTFOUND_MESSAGE.items() if key != 'timestamp'}
    _events(run / 'run-c-lead-0.events.jsonl', [
        {'type': 'message_end', 'message': mention},
        {'type': 'message_end', 'message': tool_output},
        {'type': 'tool_execution_update', 'partialResult': {'details': {'results': [{'messages': [no_ts]}]}}},
        *({'type': 'message_end', 'message': message} for message in untimestamped),
    ])
    assert backfill(root) == {'candidates': 0, 'persisted': 0}


def test_text_logs_emit_only_dated_lines_when_run_has_no_structured_rows(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-d'
    run.mkdir(parents=True)
    _events(run / 'run-d-lead-0.events.jsonl', [{'type': 'message_end', 'message': {'role': 'assistant', 'content': []}}])
    (run / 'run.log').write_text('ENOTFOUND bedrock-runtime.eu-west-2.amazonaws.com\nfetch failed\n')
    (run / 'lead.stderr.log').write_text('ECONNRESET\n2026-09-26T10:00:00Z ECONNRESET\n')
    assert backfill(root, write=True)['persisted'] == 1
    row, = _rows(root)
    assert row['error_code'] == 'ECONNRESET' and row['first_ts'] == '2026-09-26T10:00:00Z'
    assert 'timestamp_precision' not in row


def test_structured_backfill_second_write_is_idempotent(tmp_path: Path):
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-e'
    run.mkdir(parents=True)
    later = {**ENOTFOUND_MESSAGE, 'timestamp': ENOTFOUND_MESSAGE['timestamp'] + 60_000}
    _events(run / 'run-e-qa.events.jsonl', [{'type': 'message_end', 'message': ENOTFOUND_MESSAGE},
                                            {'type': 'message_end', 'message': later}])
    assert backfill(root, write=True) == {'candidates': 2, 'persisted': 2}
    assert backfill(root, write=True) == {'candidates': 2, 'persisted': 0}
    assert len(_rows(root)) == 2


def test_structured_backfill_skips_oversized_lines_and_symlinked_event_files(tmp_path: Path, monkeypatch):
    from scripts import backfill_provider_errors as module
    monkeypatch.setattr(module, 'MAX_LINE_BYTES', 4096)
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-f'
    run.mkdir(parents=True)
    huge = {'type': 'message_end', 'message': ENOTFOUND_MESSAGE, 'pad': 'x' * (module.MAX_LINE_BYTES + 10)}
    later = {**ENOTFOUND_MESSAGE, 'timestamp': ENOTFOUND_MESSAGE['timestamp'] + 1}
    _events(run / 'run-f-lead-0.events.jsonl', [huge, {'type': 'message_end', 'message': later}])
    outside = tmp_path / 'outside.events.jsonl'
    _events(outside, [{'type': 'message_end', 'message': ENOTFOUND_MESSAGE}])
    (run / 'escaped.events.jsonl').symlink_to(outside)
    assert backfill(root, write=True)['persisted'] == 1
    row, = _rows(root)
    assert row['ts'] == '2026-09-26T21:49:27.377Z'


def test_backfill_script_runs_without_pythonpath(tmp_path: Path):
    import os
    root = tmp_path / 'state'
    (root / 'runs' / 'run-g').mkdir(parents=True)
    env = {key: value for key, value in os.environ.items() if key != 'PYTHONPATH'}
    script = Path(__file__).resolve().parents[1] / 'scripts' / 'backfill_provider_errors.py'
    result = subprocess.run([sys.executable, str(script), '--state-dir', str(root)],
                            capture_output=True, text=True, check=False, env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    assert "'candidates': 0" in result.stdout


def _live_state_env(monkeypatch, live: Path) -> None:
    """Point every live-root source at `live` or away from it, never at the real state dir."""
    from scripts import backfill_provider_errors as module
    monkeypatch.setattr(module, 'DEFAULT_STATE_ROOT', str(live))
    for name in (module.STATE_ROOT_ENV_VAR, *module.STATE_ROOT_ENV_ALIASES):
        monkeypatch.delenv(name, raising=False)


def _state_with_error(root: Path) -> Path:
    run = root / 'runs' / 'r1'
    run.mkdir(parents=True)
    (run / 'task.stderr.log').write_text('2026-09-26T10:00:00Z ECONNRESET\n')
    return root


def test_backfill_refuses_case_variant_of_live_root(tmp_path: Path, monkeypatch):
    probe = tmp_path / 'caseprobe'
    probe.write_text('')
    if not (tmp_path / 'CASEPROBE').exists():
        pytest.skip('tmp filesystem is case-sensitive')
    live = _state_with_error(tmp_path / 'live')
    _live_state_env(monkeypatch, live)
    with pytest.raises(ValueError, match='--allow-live-state'):
        backfill(tmp_path / 'LIVE', write=True)
    assert not (live / 'events.jsonl').exists()


def test_backfill_env_override_still_protects_default_state_root(tmp_path: Path, monkeypatch):
    from scripts import backfill_provider_errors as module
    live = _state_with_error(tmp_path / 'live')
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    _live_state_env(monkeypatch, live)
    monkeypatch.setenv(module.STATE_ROOT_ENV_VAR, str(elsewhere))
    with pytest.raises(ValueError, match='--allow-live-state'):
        backfill(live, write=True)
    assert not (live / 'events.jsonl').exists()
    # The override target itself is protected too.
    with pytest.raises(ValueError, match='--allow-live-state'):
        backfill(elsewhere, write=True)


def test_backfill_env_alias_value_is_protected(tmp_path: Path, monkeypatch):
    from scripts import backfill_provider_errors as module
    if not module.STATE_ROOT_ENV_ALIASES:
        pytest.skip('contract defines no state-root env aliases')
    live = _state_with_error(tmp_path / 'live')
    aliased = _state_with_error(tmp_path / 'aliased')
    _live_state_env(monkeypatch, live)
    monkeypatch.setenv(module.STATE_ROOT_ENV_VAR, str(tmp_path / 'canonical'))
    monkeypatch.setenv(module.STATE_ROOT_ENV_ALIASES[0], str(aliased))
    with pytest.raises(ValueError, match='--allow-live-state'):
        backfill(aliased, write=True)
    assert not (aliased / 'events.jsonl').exists()


def test_backfill_refuses_symlink_and_samefile_alias_of_live_root(tmp_path: Path, monkeypatch):
    live = _state_with_error(tmp_path / 'live')
    _live_state_env(monkeypatch, live)
    link = tmp_path / 'link'
    link.symlink_to(live, target_is_directory=True)
    with pytest.raises(ValueError):
        backfill(link, write=True)
    via_link = tmp_path / 'link' / '.'
    with pytest.raises(ValueError, match='--allow-live-state'):
        backfill(via_link, write=True)
    assert not (live / 'events.jsonl').exists()


def test_backfill_allow_live_state_permits_write_to_protected_root(tmp_path: Path, monkeypatch):
    from scripts import backfill_provider_errors as module
    live = _state_with_error(tmp_path / 'live')
    _live_state_env(monkeypatch, live)
    monkeypatch.setenv(module.STATE_ROOT_ENV_VAR, str(tmp_path / 'elsewhere'))
    assert backfill(live, write=True, allow_live_state=True) == {'candidates': 1, 'persisted': 1}
    assert len(_rows(live)) == 1


def test_text_backfill_skips_oversized_stderr_line_without_shifting_line_numbers(tmp_path: Path, monkeypatch):
    from scripts import backfill_provider_errors as module
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-g'
    run.mkdir(parents=True)
    normal = '2026-09-26T10:00:00Z ECONNRESET\n'
    stderr_log = run / 'lead.stderr.log'
    stderr_log.write_text('prefix\n' + normal)
    expected = module.text_rows(root, run, stderr_log)
    monkeypatch.setattr(module, 'MAX_LINE_BYTES', 4096)
    # A single dated, matching line far over the cap: skipped (like events.jsonl), not loaded.
    stderr_log.write_text('2026-09-26T09:00:00Z ECONNRESET ' + 'x' * (module.MAX_LINE_BYTES * 4) + '\n' + normal)
    rows = module.text_rows(root, run, stderr_log)
    assert [row['first_ts'] for row in rows] == ['2026-09-26T10:00:00Z']
    assert [row['record_id'] for row in rows] == [row['record_id'] for row in expected]
    stderr_log.write_text('2026-09-26T09:00:00Z ECONNRESET ' + 'x' * (module.MAX_LINE_BYTES * 4))
    assert backfill(root) == {'candidates': 0, 'persisted': 0}


def test_text_backfill_does_not_follow_symlink_swapped_in_after_listing(tmp_path: Path):
    from scripts import backfill_provider_errors as module
    root = tmp_path / 'state'
    run = root / 'runs' / 'run-h'
    run.mkdir(parents=True)
    outside = tmp_path / 'outside.stderr.log'
    outside.write_text('2026-09-26T10:00:00Z ECONNRESET\n')
    link = run / 'lead.stderr.log'
    link.symlink_to(outside)
    assert module.text_rows(root, run, link) == []

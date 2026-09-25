"""Final cross-slice regressions. All roots are disposable; no installed runtime calls."""
import json
import subprocess
import sys
import time

import pytest

from orchestrator.dashboard import build_data, generate_dashboard
from orchestrator.engine import OrchestrationEngine
from orchestrator.history import build_route_stats
from orchestrator.record_batch import write_batch
from orchestrator.run_evidence import summarize_runs
from orchestrator.runtime import QualityEvidence, load_jsonl
from tests.test_record_batch import REPO, cli_env, run_cli


def page(root):
    return json.JSONDecoder().raw_decode((root/'dashboard.html').read_text().split('const D=', 1)[1])[0]


def call(run='R', **kw):
    return dict(event='model_call', run_id=run, task_id='T', task_class='crud', complexity=3,
                risk='low', capability_class='implementation_fast', effort='low',
                verification_depth='targeted', cost_usd=.1, cost_source='reported', **kw)


def test_engine_failed_verification_is_not_a_pass(tmp_path):
    engine = OrchestrationEngine(tmp_path, on_change=lambda: generate_dashboard(tmp_path, config=engine.config))
    engine.record_model_call(**call())
    engine.verify_task(run_id='R', task_id='T', evidence=QualityEvidence())
    engine.verify_task(run_id='R', task_id='other', evidence=QualityEvidence(acceptance_pass=True, deterministic_checks_pass=True))
    rows = load_jsonl(tmp_path/'metrics.jsonl')
    evidence = summarize_runs(rows, [], [])[0]
    assert evidence['verification'] == 'failed'
    assert evidence['verified_tasks'] == 1
    assert build_route_stats(rows)[0]['verified_tasks'] == 0
    assert page(tmp_path)['runs'][0]['verification'] == 'failed'


def test_route_joins_ordinary_verification_by_run_and_task():
    rows = [call(), call('other')]
    rows += [dict(event='task_verified', run_id='R', task_id='T', result='verified', quality_evidence_score=.99),
             dict(event='task_verified', run_id='other', task_id='T', result='fail', quality_evidence_score=.1)]
    outcomes = [dict(run_id='unrelated', task_id='T', regression=True), dict(run_id='R', task_id='T', regression=False)]
    group = build_route_stats(rows, outcomes)[0]
    assert group['verified_tasks'] == 1
    assert group['task_samples'] == 2
    assert group['verification_samples'] == 1
    assert group['delayed_failure_rate'] == 0
    assert group['avg_quality_evidence'] == pytest.approx(.545)
    assert group['verified_cost_usd'] == pytest.approx(.2)


def test_outcome_verification_joins_only_its_run_and_task():
    rows = [call(), call('other')]
    outcomes = [dict(run_id='R', task_id='T', outcome='verified', quality_evidence_score=.99)]
    group = build_route_stats(rows, outcomes)[0]
    assert group['verified_tasks'] == 1
    assert group['avg_quality_evidence'] == .99


def test_ingest_repairs_stale_ledger_even_with_current_dashboard(tmp_path):
    root=tmp_path/'state'; root.mkdir()
    source=tmp_path/'session.jsonl'
    source.write_text('{"type":"session","id":"empty"}\n')
    write_batch(root,[{'stream':'event','record_id':'e','event':'run_started','run_id':'R'}],refresh=False)
    assert run_cli(root,'dashboard').returncode == 0
    assert not (root/'ledger.json').exists()
    assert run_cli(root,'ingest',str(source),'--runtime','humain-terminal').returncode == 0
    assert json.loads((root/'ledger.json').read_text())['runs']['R']['status']=='running'


def test_route_missing_price_is_not_a_free_verified_route():
    row = call()
    row.update(cost_usd=0, cost_source='unmetered', model='unknown', input_tokens=50, result='verified')
    group = build_route_stats([row])[0]
    assert group['verified_cost_usd'] is None
    assert group['avg_call_cost_usd'] is None
    assert group['total_cost_usd'] is None
    assert group['unmetered_call_samples'] == 1


def test_duplicate_history_agrees_across_dashboard_and_billing(tmp_path):
    from orchestrator.economics import cost_attribution
    row=call(record_id='same')
    (tmp_path/'metrics.jsonl').write_text((json.dumps(row)+'\n')*2)
    data=build_data(tmp_path)
    assert data['summary']['total_cost']==.1
    assert data['summary']['call_rows']==1
    assert data['run_evidence']['cost_known_usd']==.1
    assert cost_attribution([row,row])['reported']['cost']==.1


def test_invalid_legacy_ids_remain_distinct_rows():
    evidence=summarize_runs([call(record_id=['bad']), call(record_id={'bad':1})], [], [])[0]
    assert evidence['call_rows']==2
    assert evidence['cost_known_usd']==.2


def test_run_evidence_dedups_each_stream_but_not_idless_rows():
    row = call(record_id='same')
    event = dict(record_id='same', run_id='R', event='rework')
    evidence = summarize_runs([row, row, call(), call()], [event, event], [])[0]
    assert evidence['call_rows'] == 3
    assert evidence['cost_known_usd'] == pytest.approx(.3)
    assert evidence['rework_events'] == 1


@pytest.mark.parametrize('model,priced', [('claude-sonnet-4-5', True), ('unknown-model', False)])
def test_old_ht_zero_estimate_is_repriced_or_unmetered(tmp_path, model, priced):
    from orchestrator.app.refresh import refresh_after_write
    row = call()
    row.update(stream='metric', record_id='old-ht', model=model, input_tokens=1000,
               cost_usd=0, cost_source='estimated-from-reported-tokens')
    result = write_batch(tmp_path, [row])
    assert result['ok']
    assert refresh_after_write(tmp_path, result)['ok']
    evidence = page(tmp_path)['runs'][0]
    assert evidence['metered_calls'] == int(priced)
    assert (evidence['cost_known_usd'] or 0) > 0 if priced else evidence['cost_known_usd'] is None


def test_ingest_retry_refreshes_after_durable_append_and_settles_events(tmp_path):
    root = tmp_path/'state'; root.mkdir()
    source = tmp_path/'session.jsonl'
    source.write_text(json.dumps({'type':'session', 'id':'S'})+'\n'+json.dumps({
        'type':'message','message':{'role':'assistant','model':'claude-sonnet-4-5',
        'usage':{'input':1000,'output':10,'cost':{'total':.2}}}})+'\n')
    program = '''
import os, sys
from orchestrator import cli
cli.refresh = lambda root: os._exit(19)  # production `process_ingest` calls `refresh(root)`
sys.argv = ['cli', 'ingest', sys.argv[1], '--runtime', 'humain-terminal']
cli.main()
'''
    crash = subprocess.run([sys.executable, '-B', '-c', program, str(source)], env=cli_env(root), cwd=REPO, capture_output=True, timeout=30)
    assert crash.returncode == 19, crash.stderr
    before = (root/'metrics.jsonl').read_bytes()
    # An interrupted event writer can also leave a complete object without its newline.
    (root/'events.jsonl').write_text('{"event":"run_started","run_id":"settled"}')
    retry = run_cli(root, 'ingest', str(source), '--runtime', 'humain-terminal')
    assert retry.returncode == 0, retry.stderr
    assert json.loads(retry.stdout)['emitted'] == 0
    assert (root/'metrics.jsonl').read_bytes() == before
    assert page(root)['metric_count'] > 0
    assert json.loads((root/'ledger.json').read_text())['runs']['settled']['status'] == 'running'


def test_dashboard_receipt_is_versioned_and_rejects_future_versions(tmp_path):
    from orchestrator.dashboard import generate_dashboard, dashboard_is_current
    generate_dashboard(tmp_path)
    receipt=tmp_path/'dashboard.version.json'
    data=json.loads(receipt.read_text())
    assert data['format_version']==1
    assert dashboard_is_current(tmp_path)
    data['format_version']=999
    receipt.write_text(json.dumps(data))
    assert not dashboard_is_current(tmp_path)


def test_concurrent_dashboard_cannot_publish_older_snapshot(tmp_path):
    root = tmp_path/'state'; root.mkdir()
    program = '''
import sys, time
from pathlib import Path
from orchestrator import dashboard
root = Path(sys.argv[1]); gate = Path(sys.argv[2]); release = Path(sys.argv[3])
original = dashboard.build_data
def paused(*a, **kw):
    data = original(*a, **kw)
    gate.touch()
    while not release.exists(): time.sleep(.01)
    return data
dashboard.build_data = paused
dashboard.generate_dashboard(root)
'''
    gate = tmp_path/'read'; release = tmp_path/'release'
    old = subprocess.Popen([sys.executable, '-B', '-c', program, str(root), str(gate), str(release)], env=cli_env(root), cwd=REPO)
    new = None
    try:
        deadline = time.monotonic()+10
        while not gate.exists() and time.monotonic()<deadline: time.sleep(.01)
        assert gate.exists()
        # The canonical writer must not wait for the stalled renderer.
        assert write_batch(root, [{'stream':'metric','record_id':'new', **call()}], refresh=False)['ok']
        new = subprocess.Popen([sys.executable, '-B', '-m', 'orchestrator.cli', 'dashboard'], env=cli_env(root), cwd=REPO, stdout=subprocess.DEVNULL)
        time.sleep(.4)
        release.touch()
        assert old.wait(timeout=15) == 0
        assert new.wait(timeout=15) == 0
        assert page(root)['metric_count'] == 1
    finally:
        release.touch()
        if old.poll() is None: old.kill(); old.wait()
        if new is not None and new.poll() is None: new.kill(); new.wait()


def test_engine_history_fallback_threshold_and_emitted_counts(tmp_path, monkeypatch):
    engine = OrchestrationEngine(tmp_path)
    engine.config['history'] = {'min_samples_for_empirical_route':23}
    monkeypatch.setattr(engine, 'resolve_features', lambda **kw: {'adaptive_routing':{'mode':'enforce'}})
    plan = engine.plan_run(run_id='R', task_class='crud', complexity=3, risk='low')
    assert plan['topology_recommendation']['min_samples'] == 23
    row = next(r for r in load_jsonl(tmp_path/'metrics.jsonl') if r['event']=='adaptive_route_decision')
    assert row['verified_task_samples'] == 0
    assert row['run_samples'] == 0
    assert row['call_samples'] == 0
    assert row['min_samples'] == 23


def test_bounded_ingest_error_keeps_head_and_actionable_tail():
    from orchestrator.cli import INGEST_ERROR_LIMIT, _bound_error, make_ingest_status
    short = 'ValueError: unreadable log'
    assert _bound_error(short) == short
    remedy = 'Switching to --granularity session cannot establish identity; nothing was written.'
    long = 'GranularityConflict: /var/tmp/x/session.jsonl: ingestion cannot identify the recorded calls — ' + 'z' * 400 + ' ' + remedy
    bounded = _bound_error(long)
    assert len(bounded) == INGEST_ERROR_LIMIT == 240
    assert bounded.startswith('GranularityConflict: /var/tmp/x/session.jsonl')
    assert bounded.endswith(remedy) and ' ... ' in bounded
    # The status file uses the same bound, and redaction happens before the cut so no partial path leaks.
    status = make_ingest_status({}, {'failures': [{'error': long.replace('/var/tmp/x', '/Users/alice/p')}], 'files_scanned': 1, 'emitted': 0})
    assert len(status['error']) == 240 and '--granularity session' in status['error']
    assert '/Users/alice' not in status['error'] and '<path>' in status['error']


def test_ingest_conflict_stderr_is_bounded_and_keeps_granularity_hint(tmp_path):
    from orchestrator.runtime import EventStore
    from tests.test_ingest_checkpoint import aggregate_row, ht_session
    root = tmp_path/'state'; root.mkdir()
    # A long directory name guarantees the redacted message exceeds the stderr bound.
    logs = tmp_path/('very-long-session-directory-name-'*4); logs.mkdir()
    log = ht_session(logs/'session.jsonl', 3)
    ok = run_cli(root, 'ingest', str(log), '--runtime', 'humain-terminal', '--granularity', 'session', '--quiet')
    assert ok.returncode == 0, ok.stderr
    EventStore(root).metric(**aggregate_row('sess-1', covers=1, input_tokens=123))  # no prefix of the log sums to this
    conflict = run_cli(root, 'ingest', str(log), '--runtime', 'humain-terminal', '--granularity', 'call', '--quiet')
    assert conflict.returncode != 0
    lines = conflict.stderr.strip().splitlines()
    assert len(lines) == 1 and len(lines[0]) == 240, conflict.stderr
    assert lines[0].startswith('1 file(s) failed; first: GranularityConflict:')
    assert '--granularity session' in lines[0]
    assert json.loads(conflict.stdout)['failures'][0]['error'].endswith('nothing was written.')

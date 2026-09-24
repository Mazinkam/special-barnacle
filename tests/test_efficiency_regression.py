"""Cross-slice recovery and release gates; only temporary state and copied fixtures."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from orchestrator.dashboard import build_data
from orchestrator.engine import OrchestrationEngine
from orchestrator.record_index import DATABASE_FILE
from orchestrator.runtime import load_jsonl, read_json
from tests.test_dashboard_refresh import load_benchmark_module
from tests.test_record_batch import REPO, cli_env, run_batch, run_cli, sample_batch


def snapshot(root):
    return {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in root.rglob('*') if p.is_file()}


@pytest.mark.parametrize('boundary', ['engine', 'init-script'])
def test_routine_refresh_preserves_exact_id_cache_and_catches_up(tmp_path, boundary):
    # Full recovery in an ordinary lifecycle boundary discards the derived index and makes
    # the NEXT append rescan all historical IDs, even though this append was already indexed.
    assert run_batch(tmp_path, sample_batch()).returncode == 0
    index = tmp_path / DATABASE_FILE
    inode = index.stat().st_ino
    if boundary == 'engine':
        OrchestrationEngine(tmp_path).complete_run('R1', record_id='terminal')
        assert read_json(tmp_path / 'ledger.json', {})['runs']['R1']['status'] == 'completed'
    else:
        result = subprocess.run([sys.executable, '-B', str(REPO / 'scripts/init_orchestrator.py')],
                                env=cli_env(tmp_path), cwd=REPO, capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        assert load_jsonl(tmp_path / 'events.jsonl')[-1]['event'] == 'orchestrator_initialized'
    ledger = read_json(tmp_path / 'ledger.json', {})
    assert ledger['checkpoint']['events_offset'] == (tmp_path / 'events.jsonl').stat().st_size
    assert index.exists(), 'routine refresh must not discard the rebuildable exact-ID cache'
    assert index.stat().st_ino == inode
    assert (tmp_path / 'dashboard.html').exists()
    # Explicit recovery still deliberately discards it; retry must reconstruct without duplicates.
    assert run_cli(tmp_path, 'rebuild').returncode == 0
    assert not index.exists()
    before = {name: (tmp_path / name).read_bytes() for name in ('events.jsonl', 'metrics.jsonl', 'outcomes.jsonl')}
    assert run_batch(tmp_path, sample_batch()).returncode == 0
    assert all((tmp_path / name).read_bytes() == data for name, data in before.items())


@pytest.mark.parametrize('crash_at', ['_write_checkpoint', 'generate_dashboard'])
def test_legacy_batch_crash_retry_dashboard_and_active_diagnostics(tmp_path, crash_at):
    # Hand-authored legacy rows have neither stable IDs nor ledger checkpoints.
    legacy = {
        'events.jsonl': [{'event': 'run_started', 'run_id': 'legacy'}, {'event': 'run_started', 'run_id': 'active'}],
        'metrics.jsonl': [{'event': 'model_call', 'run_id': 'legacy', 'task_id': 'T', 'cost_usd': .25,
                           'cost_source': 'reported', 'duration_ms': 100}],
        'outcomes.jsonl': [],
    }
    original = {}
    for name, rows in legacy.items():
        original[name] = ''.join(json.dumps(row) + '\n' for row in rows).encode()
        (tmp_path / name).write_bytes(original[name])
    active = tmp_path / 'runs/active'
    active.mkdir(parents=True)
    (active / 'run.log').write_bytes(b'active timeline\n')
    (active / 'worker.events.jsonl').write_bytes(b'{"partial":"still writing')
    diagnostics = snapshot(active)
    assert run_cli(tmp_path, 'dashboard').returncode == 0
    old_page = (tmp_path / 'dashboard.html').read_bytes()
    records = [
        {'stream': 'metric', 'record_id': 'unpriced', 'event': 'model_call', 'run_id': 'legacy',
         'task_id': 'T', 'model': 'not-a-priced-model', 'input_tokens': 100, 'output_tokens': 5},
        {'stream': 'metric', 'record_id': 'verification', 'event': 'task_verified',
         'run_id': 'legacy', 'task_id': 'T', 'result': 'verified'},
        {'stream': 'event', 'record_id': 'completed', 'event': 'run_completed', 'run_id': 'legacy'},
        {'stream': 'outcome', 'record_id': 'outcome', 'run_id': 'legacy', 'task_id': 'run-complete',
         'outcome': 'verified', 'note': '{"verification_passed":true}'},
    ]
    program = '''
import json, os, sys
from orchestrator import record_batch
def crash(*args, **kwargs): os._exit(19)
setattr(record_batch, sys.argv[2], crash)
record_batch.write_batch(sys.argv[1], json.loads(sys.stdin.read()))
'''
    crashed = subprocess.run([sys.executable, '-B', '-c', program, str(tmp_path), crash_at],
                             input=json.dumps(records), env=cli_env(tmp_path), cwd=REPO,
                             capture_output=True, text=True, timeout=60)
    assert crashed.returncode == 19, crashed.stderr
    assert (tmp_path / 'dashboard.html').read_bytes() == old_page
    durable = {name: (tmp_path / name).read_bytes() for name in legacy}
    assert all(durable[name].startswith(original[name]) for name in legacy)
    retry = run_batch(tmp_path, records)
    assert retry.returncode == 0, retry.stderr
    assert json.loads(retry.stdout)['duplicates'] == {'event': 1, 'metric': 2, 'outcome': 1}
    assert all((tmp_path / name).read_bytes() == data for name, data in durable.items())
    ledger = read_json(tmp_path / 'ledger.json', {})
    assert ledger['runs']['legacy']['status'] == 'completed'
    assert ledger['runs']['active']['status'] == 'running'
    assert ledger['checkpoint']['events_offset'] == len(durable['events.jsonl'])
    missing = next(r for r in load_jsonl(tmp_path / 'metrics.jsonl') if r.get('record_id') == 'unpriced')
    assert missing['cost_source'] == 'unmetered'
    assert missing.get('cost_usd') is None
    data = build_data(tmp_path)
    run = next(r for r in data['runs'] if r['run_id'] == 'legacy')
    assert run['call_rows'] == 2
    assert run['unmetered_calls'] == 1
    assert run['cost_known_usd'] == .25
    assert run['cost_coverage'] == .5
    assert run['elapsed_ms'] is None  # do not invent historical wall time from a new terminal timestamp
    assert run['verified_tasks'] == 1
    html = (tmp_path / 'dashboard.html').read_text()
    embedded, _ = json.JSONDecoder().raw_decode(html.split('const D=', 1)[1])
    assert embedded['run_evidence'] == data['run_evidence']
    assert embedded['summary']['total_cost'] == .25
    streams = {name: (tmp_path / name).read_bytes() for name in legacy}
    for flags in [[], ['--execute']]:
        result = run_cli(tmp_path, 'archive-runs', '--older-than-days', '1', '--json', *flags)
        assert result.returncode == 0, result.stderr
        assert 'no_terminal_outcome' in result.stdout
        assert snapshot(active) == diagnostics
        assert all((tmp_path / name).read_bytes() == content for name, content in streams.items())


def test_release_commands_visible_without_creating_state(tmp_path):
    root = tmp_path / 'absent'
    help_result = run_cli(root, '--help')
    assert help_result.returncode == 0
    for command in ('batch', 'ingest', 'archive-runs', 'restore-run', 'rebuild'):
        assert command in help_result.stdout
        result = run_cli(root, command, '--help')
        assert result.returncode == 0
    assert not root.exists()


def test_legacy_benchmark_compares_equivalent_copied_workloads(tmp_path):
    source=tmp_path/'fixture'; source.mkdir()
    for name in ('events.jsonl','metrics.jsonl','outcomes.jsonl'): (source/name).write_text('')
    result=subprocess.run([sys.executable,'-B',str(REPO/'scripts/benchmark_refresh.py'), '--source',str(source),
                           '--compare-legacy',str(REPO),'--repeat','1','--scales','1,2,4','--json'],
                          env=cli_env(tmp_path/'must-not-exist'),cwd=REPO,capture_output=True,text=True,timeout=60)
    assert result.returncode == 0, result.stderr
    report=json.loads(result.stdout)
    assert len(report['results'])==3
    for row in report['results']:
        assert row['equivalence']['canonical_bytes'] is True
        assert row['equivalence']['ledger'] is True
        assert row['equivalence']['dashboard_accounting'] is True
        assert row['before']['subprocesses']==5
        assert row['after']['subprocesses']==1
    assert not (tmp_path/'must-not-exist').exists()
    assert all(p.read_bytes()==b'' for p in source.iterdir())


def test_benchmark_overrides_inherited_live_paths(tmp_path, monkeypatch):
    bench = load_benchmark_module()
    for name in ('CODING_AGENT_ORCHESTRATOR_HOME', 'HUMAIN_ORCHESTRATOR_STATE_ROOT', 'HUMAIN_ORCHESTRATOR_SKILL_ROOT'):
        monkeypatch.setenv(name, '/do-not-use-inherited-live-path')
    env = bench.cli_env(tmp_path)
    assert env['CODING_AGENT_ORCHESTRATOR_HOME'] == str(tmp_path)
    assert env['HUMAIN_ORCHESTRATOR_STATE_ROOT'] == str(tmp_path)
    assert env['HUMAIN_ORCHESTRATOR_SKILL_ROOT'] == str(REPO)


def test_benchmark_copies_source_and_reports_pre_append_coverage(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'events.jsonl').write_text('{"event":"run_started","run_id":"R"}\n')
    (source / 'metrics.jsonl').write_text('{"event":"model_call","run_id":"R","cost_usd":0.25,"cost_source":"reported"}\n')
    (source / 'outcomes.jsonl').write_text('')
    before = snapshot(source)
    inherited = tmp_path / 'unused'  # the driver's own environment must never become a workload state root
    result = subprocess.run([sys.executable, '-B', str(REPO / 'scripts/benchmark_refresh.py'),
                             '--source', str(source), '--repeat', '1', '--scales', '1,2,4',
                             '--checkout', str(REPO), '--json'],
                            env=cli_env(inherited), cwd=REPO, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert snapshot(source) == before
    assert not inherited.exists(), 'a successful benchmark must not create the inherited state root'
    for scale, row in zip((1, 2, 4), report['results']):
        assert row['input_evidence']['runs'] == scale
        assert row['input_evidence']['call_rows'] == scale
        assert row['input_evidence']['cost_known_usd'] == .25 * scale
        assert row['input_evidence']['duration_coverage'] == 0
        assert row['input_evidence']['priced_call_coverage'] == 1
        assert row['rows']['metrics.jsonl'] == scale  # input counts, not benchmark appends
        assert row['engine_boundary']['subprocesses'] == 1
        assert row['engine_boundary']['median_s'] > 0
        assert row['batch']['median_peak_rss_mib'] > 0
    assert report['meta']['checkout'] == str(REPO)


def test_benchmark_executes_selected_checkout_not_the_driver(tmp_path):
    bench = load_benchmark_module()
    checkout = tmp_path / 'before'
    package = checkout / 'orchestrator'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    (package / 'cli.py').write_text(
        'import json, os\n'
        'def main():\n'
        '    print(json.dumps({"code": __file__, "state": os.environ["CODING_AGENT_ORCHESTRATOR_HOME"]}))\n')
    root = tmp_path / 'state'
    result = bench.run_cli(root, '--help', checkout=checkout)
    assert json.loads(result.stdout) == {'code': str(package / 'cli.py'), 'state': str(root)}
    assert not root.exists()


@pytest.mark.parametrize('args', [
    ['--repeat', '0'], ['--runs', '0'], ['--batch-size', '0'], ['--batch-size', '999999'],
    ['--scales', '0,1'], ['--scales', 'bad'], ['--scales', ''],
    ['--source', '/nonexistent-fixture'], ['--checkout', '/nonexistent-checkout'],
])
def test_benchmark_rejects_invalid_inputs_without_state_writes(tmp_path, args):
    root = tmp_path / 'state'
    result = subprocess.run([sys.executable, '-B', str(REPO / 'scripts/benchmark_refresh.py'), *args],
                            env=cli_env(root), cwd=REPO, capture_output=True, text=True, timeout=60)
    assert result.returncode == 2
    assert 'error:' in result.stderr
    assert not root.exists()


def test_benchmark_rejects_checkout_missing_engine_before_any_workload(tmp_path):
    # The engine-boundary workload imports orchestrator.engine from the checkout; a CLI-only tree
    # must be refused at argument parsing, not after the batch/dashboard workloads have already run.
    checkout = tmp_path / 'cli-only'
    (checkout / 'orchestrator').mkdir(parents=True)
    (checkout / 'orchestrator/cli.py').write_text('')
    root = tmp_path / 'state'
    result = subprocess.run([sys.executable, '-B', str(REPO / 'scripts/benchmark_refresh.py'),
                             '--checkout', str(checkout)],
                            env=cli_env(root), cwd=REPO, capture_output=True, text=True, timeout=60)
    assert result.returncode == 2
    assert 'orchestrator/engine.py' in result.stderr
    assert not root.exists()

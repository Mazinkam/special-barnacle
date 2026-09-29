import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location('bench_report', Path(__file__).resolve().parents[1] / 'scripts' / 'bench_report.py')
bench_report = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(bench_report)

def test_report_labels_small_strata_exploratory_and_counts_all_attempts():
    rows = [{'attempt_id': f'{t}.{a}.k1', 'task_id': t, 'arm': a, 'k': 1,
             'execution_status': 'timeout' if (t == 't0' and a == 'tiered') else 'completed',
             'verdict': 'unknown' if (t == 't0' and a == 'tiered') else 'pass', 'elapsed_ms': 1000, 'cost_usd': 1.0,
             'cost_complete': True, 'scope_band': 'tiny', 'risk': 'low'} for t in ('t0', 't1', 't2') for a in ('current', 'tiered')]
    text = bench_report.render(rows, control='current', candidates=('tiered',))
    assert 'exploratory' in text and 'timeout 1' in text and 'inconclusive' in text

def test_main_json_skips_started_events_and_tolerates_missing_metrics(tmp_path, monkeypatch, capsys):
    rows = [{'event': 'started', 'attempt_id': 'x'}]
    for t in ('t0', 't1'):
        for a in ('current', 'tiered'):
            rows.append({'attempt_id': f'{t}.{a}.k1', 'task_id': t, 'arm': a, 'k': 1, 'execution_status': 'timeout',
                         'verdict': 'unknown', 'elapsed_ms': None, 'cost_usd': None, 'cost_complete': False,
                         'scope_band': 'tiny', 'risk': 'low'})
    for a in ('current', 'tiered'):  # second attempt with mixed None/number elapsed exercises the median
        rows.append({'attempt_id': f't0.{a}.k2', 'task_id': 't0', 'arm': a, 'k': 2, 'execution_status': 'completed',
                     'verdict': 'pass', 'elapsed_ms': 5, 'cost_usd': 1.0, 'cost_complete': True, 'scope_band': 'tiny', 'risk': 'low'})
    j = tmp_path / 'journal.jsonl'
    j.write_text('\n'.join(json.dumps(r) for r in rows))
    monkeypatch.setattr('sys.argv', ['bench_report.py', '--journal', str(j), '--candidates', 'tiered', '--json'])
    assert bench_report.main() == 0
    out = json.loads(capsys.readouterr().out)
    assert out and out[0]['candidate'] == 'tiered'


def test_report_counts_replaced_row_until_replacement_terminal():
    base = {'task_id': 't0', 'arm': 'current', 'k': 1, 'elapsed_ms': 1, 'cost_usd': 0, 'cost_complete': True, 'scope_band': 'tiny', 'risk': 'low'}
    old = {**base, 'attempt_id': 'a', 'execution_status': 'infra_error', 'verdict': 'unknown', 'replaced_by': 'a-r1'}
    res = bench_report.analyse([old], 'current', ('tiered',), ('all',))
    assert res[0]['status']['current'] == {'infra_error': 1}
    new = {**base, 'attempt_id': 'a-r1', 'execution_status': 'completed', 'verdict': 'pass'}
    res = bench_report.analyse([old, new], 'current', ('tiered',), ('all',))
    assert res[0]['status']['current'] == {'completed': 1}

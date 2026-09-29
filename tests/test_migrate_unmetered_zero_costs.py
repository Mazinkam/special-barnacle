import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'migrate_unmetered_zero_costs.py'
ZERO = {'event': 'model_call', 'record_id': 'z1', 'run_id': 'R', 'model': 'unknown', 'cost_usd': 0,
        'cost_source': 'estimated-from-reported-tokens', 'input_tokens': 0, 'output_tokens': 0}
FREE = {'event': 'model_call', 'record_id': 'f1', 'run_id': 'R', 'model': 'm', 'cost_usd': 0,
        'cost_source': 'reported', 'input_tokens': 12, 'output_tokens': 3}
PAID = {'event': 'model_call', 'record_id': 'p1', 'run_id': 'R', 'model': 'm', 'cost_usd': .5, 'cost_source': 'reported'}
ROUTE = {'event': 'route_executed', 'record_id': 'x1', 'run_id': 'R', 'cost_usd': 0}
BAD_LINE = '{not json\n'


def _seed(root: Path) -> None:
    lines = [json.dumps(ZERO) + '\n', BAD_LINE, json.dumps(FREE) + '\n', json.dumps(PAID) + '\n', json.dumps(ROUTE) + '\n']
    (root / 'metrics.jsonl').write_text(''.join(lines))
    (root / 'events.jsonl').write_text('')
    (root / 'outcomes.jsonl').write_text('')


def _run(*args, cwd=None):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True, cwd=cwd)


def test_dry_run_writes_nothing(tmp_path):
    _seed(tmp_path); before = (tmp_path / 'metrics.jsonl').read_bytes()
    p = _run(tmp_path)
    assert p.returncode == 0, p.stderr
    assert '"candidates": 1' in p.stdout
    assert (tmp_path / 'metrics.jsonl').read_bytes() == before
    assert not list(tmp_path.glob('migration-*.json'))


def test_write_relabels_only_zero_without_usage_and_preserves_bad_line(tmp_path):
    _seed(tmp_path)
    assert _run(tmp_path, '--write').returncode == 0
    lines = (tmp_path / 'metrics.jsonl').read_text().splitlines(keepends=True)
    assert lines[1] == BAD_LINE                       # malformed line preserved byte-for-byte
    z = json.loads(lines[0])
    assert 'cost_usd' not in z and z['cost_source'] == 'unknown-no-usage-reported'
    assert z['migration_id'] == 'm20260929-unmetered-zero'
    assert json.loads(lines[2]) == FREE               # genuinely free, measured call untouched
    assert json.loads(lines[3]) == PAID
    assert json.loads(lines[4]) == ROUTE              # decision events untouched
    [manifest] = tmp_path.glob('migration-unmetered-zero-*.json')
    m = json.loads(manifest.read_text())
    assert m['changed'] == [{'line': 1, 'record_id': 'z1', 'original': {'cost_usd': 0, 'cost_source': 'estimated-from-reported-tokens'}}]


def test_second_write_is_noop(tmp_path):
    _seed(tmp_path); _run(tmp_path, '--write')
    after_first = (tmp_path / 'metrics.jsonl').read_bytes()
    p = _run(tmp_path, '--write')
    assert '"candidates": 0' in p.stdout
    assert (tmp_path / 'metrics.jsonl').read_bytes() == after_first


def test_restore_returns_original_bytes(tmp_path):
    _seed(tmp_path); original = (tmp_path / 'metrics.jsonl').read_bytes()
    _run(tmp_path, '--write')
    [manifest] = tmp_path.glob('migration-unmetered-zero-*.json')
    assert _run(tmp_path, '--restore', manifest).returncode == 0
    assert (tmp_path / 'metrics.jsonl').read_bytes() == original


def test_refuses_live_state_without_flag(tmp_path, monkeypatch):
    _seed(tmp_path)
    p = subprocess.run([sys.executable, str(SCRIPT), str(tmp_path), '--write'], capture_output=True, text=True,
                       env={'CODING_AGENT_ORCHESTRATOR_HOME': str(tmp_path), 'PATH': '/usr/bin:/bin'})
    assert p.returncode == 2 and 'live state' in p.stderr


def test_null_cost_usd_is_not_a_candidate(tmp_path):
    row = {'event': 'model_call', 'record_id': 'n1', 'run_id': 'R', 'model': 'm', 'cost_usd': None,
           'cost_source': 'estimated-from-reported-tokens', 'input_tokens': 0, 'output_tokens': 0}
    (tmp_path / 'metrics.jsonl').write_text(json.dumps(row) + '\n')
    (tmp_path / 'events.jsonl').write_text(''); (tmp_path / 'outcomes.jsonl').write_text('')
    before = (tmp_path / 'metrics.jsonl').read_bytes()
    assert '"candidates": 0' in _run(tmp_path).stdout
    assert _run(tmp_path, '--write').returncode == 0
    assert (tmp_path / 'metrics.jsonl').read_bytes() == before
    assert not list(tmp_path.glob('migration-*.json'))


def test_restore_refuses_when_metrics_changed_since_migration(tmp_path):
    _seed(tmp_path); _run(tmp_path, '--write')
    with (tmp_path / 'metrics.jsonl').open('a') as fh:
        fh.write(json.dumps({**PAID, 'record_id': 'p2'}) + '\n')
    changed = (tmp_path / 'metrics.jsonl').read_bytes()
    [manifest] = tmp_path.glob('migration-unmetered-zero-*.json')
    p = _run(tmp_path, '--restore', manifest)
    assert p.returncode == 1 and 'changed since migration' in p.stderr
    assert (tmp_path / 'metrics.jsonl').read_bytes() == changed


def test_relative_state_dir_yields_absolute_backup_and_restores_elsewhere(tmp_path):
    _seed(tmp_path); original = (tmp_path / 'metrics.jsonl').read_bytes()
    assert _run(tmp_path.name, '--write', cwd=tmp_path.parent).returncode == 0
    [manifest] = tmp_path.glob('migration-unmetered-zero-*.json')
    assert Path(json.loads(manifest.read_text())['backup']).is_absolute()
    assert _run(tmp_path, '--restore', manifest, cwd=tmp_path.parent.parent).returncode == 0
    assert (tmp_path / 'metrics.jsonl').read_bytes() == original

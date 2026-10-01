"""Every Python config.json reader (cli.cfg, OrchestrationEngine, pricing, dashboard_data) honors
ORCHESTRATOR_CONFIG_PATH through core.fs.config_path, and never falls back to the real file."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from orchestrator.cli import cfg
from orchestrator.engine import OrchestrationEngine
from orchestrator.pricing import estimate_cost_usd, load_pricing

REPO_ROOT = Path(__file__).resolve().parent.parent
REAL = (REPO_ROOT / 'orchestrator' / 'config.json').resolve()
TEMP = {'marker': 'temp', 'optimization': {'quality_floor': 0.123},
        'pricing': {'models': {'zz-test-model': {'input_per_mtok': 1000.0, 'output_per_mtok': 0.0}}}}


def _readers(tmp_path):
    engine = OrchestrationEngine(tmp_path / 'state')
    return {'cfg': cfg(), 'engine': engine.config, 'pricing': load_pricing()}


@pytest.fixture
def reads(monkeypatch):
    """Record every Path.read_text target so tests can assert the real file was (not) opened."""
    seen, orig = [], Path.read_text

    def spy(self, *a, **k):
        seen.append(self.resolve())
        return orig(self, *a, **k)
    monkeypatch.setattr(Path, 'read_text', spy)
    return seen


def test_override_values_reach_every_reader(tmp_path, monkeypatch, reads):
    p = tmp_path / 'c.json'
    p.write_text(json.dumps(TEMP))
    monkeypatch.setenv('ORCHESTRATOR_CONFIG_PATH', str(p))
    reads.clear()
    r = _readers(tmp_path)
    assert r['cfg']['marker'] == r['engine']['marker'] == 'temp'
    assert OrchestrationEngine(tmp_path / 's2').policy().quality_floor == 0.123
    assert r['pricing'] == TEMP['pricing']
    assert estimate_cost_usd(model='zz-test-model', input_tokens=1_000_000, output_tokens=0)['cost_usd'] == 1000.0
    assert REAL not in reads


@pytest.mark.parametrize('content', [None, '{not json'])
def test_missing_or_corrupt_override_never_reads_real_file(tmp_path, monkeypatch, reads, content):
    p = tmp_path / 'c.json'
    if content is not None:
        p.write_text(content)
    monkeypatch.setenv('ORCHESTRATOR_CONFIG_PATH', str(p))
    reads.clear()
    r = _readers(tmp_path)
    assert r['cfg'] == r['engine'] == r['pricing'] == {}
    assert estimate_cost_usd(model='claude-sonnet-5', input_tokens=10, output_tokens=10) is None
    assert REAL not in reads


def test_unset_all_readers_read_real_file(tmp_path, monkeypatch):
    monkeypatch.delenv('ORCHESTRATOR_CONFIG_PATH', raising=False)
    real = json.loads(REAL.read_text())
    r = _readers(tmp_path)
    assert r['cfg'] == r['engine'] == real
    assert r['pricing'] == (real.get('pricing') or {})
    assert OrchestrationEngine(tmp_path / 's3').config_path == REAL


def test_corrupt_config_scenario_gives_engine_and_pricing_no_real_config(tmp_path):
    """Same env as test_read_json's corrupt-config CLI test: engine/pricing must see the bad file."""
    bad = tmp_path / 'config.json'
    bad.write_text('{this is not valid json', encoding='utf-8')
    script = (
        "import sys\n"
        "from pathlib import Path\n"
        "from orchestrator.cli import cfg\n"
        "from orchestrator.engine import OrchestrationEngine\n"
        "from orchestrator.pricing import load_pricing\n"
        "e = OrchestrationEngine(sys.argv[1])\n"
        "assert e.config_path == Path(sys.argv[2]), e.config_path\n"
        "assert cfg() == e.config == {} and load_pricing() == {}\n"
    )
    env = {**os.environ, 'PYTHONPATH': str(REPO_ROOT), 'ORCHESTRATOR_CONFIG_PATH': str(bad),
           'CODING_AGENT_ORCHESTRATOR_HOME': str(tmp_path / 'state')}
    res = subprocess.run([sys.executable, '-c', script, str(tmp_path / 'state'), str(bad)],
                         env=env, capture_output=True, text=True, check=False)
    assert res.returncode == 0, res.stderr

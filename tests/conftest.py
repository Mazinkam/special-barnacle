import json, shlex, subprocess, sys
from pathlib import Path
import os
import pytest

# Post-write dashboard refresh is async by default (app.refresh); existing tests read the page right after a write
# (and delete their tmp dirs), so they run synchronous. tests/test_async_dashboard.py opts back in explicitly.
os.environ.setdefault('ORCHESTRATOR_DASHBOARD_SYNC', '1')

FAKE = Path(__file__).resolve().parents[1] / 'bench' / 'fake_agent.py'

def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()

def make_repo_at(tmp_path):
    repo = tmp_path / 'src'; repo.mkdir()
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    (repo / 'a.txt').write_text('base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
    base = git(repo, 'rev-parse', 'HEAD')
    (repo / 'a.txt').write_text('SOLUTION\n'); git(repo, 'commit', '-qam', 'future solution')
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git')
    return repo, base

@pytest.fixture
def make_repo():
    return make_repo_at

@pytest.fixture
def tiny_suite(tmp_path):
    from bench.manifest import load_manifest
    repo, base = make_repo_at(tmp_path)
    d = tmp_path / 'suite'; (d / 'hidden').mkdir(parents=True)
    (d / 'hidden' / 'check.py').write_text("import pathlib,sys; sys.exit(0 if 'SOLUTION' in pathlib.Path('a.txt').read_text() else 1)")
    (d / 'reference.patch').write_text(subprocess.run(['git', '-C', str(repo), 'diff', base, 'HEAD'], capture_output=True, text=True).stdout)
    m = {'id': 't1', 'repo': str(repo), 'base_commit': base, 'goal': 'make a.txt say SOLUTION', 'task_class': 'implementation',
         'scope_band': 'tiny', 'risk': 'low', 'split': 'dev', 'setup': [], 'visible_checks': [],
         'hidden_checks': [[sys.executable, 'check.py']], 'hidden_files': 'hidden', 'reference_patch': 'reference.patch',
         'protected_paths': [], 'timeout_s': 30}
    (d / 't1.json').write_text(json.dumps(m))
    return [load_manifest(d / 't1.json')]

@pytest.fixture
def fake_cfg(tmp_path):
    from bench.arms import ExperimentConfig
    (tmp_path / 'profiles.json').write_text('{}')
    skill_root = Path(__file__).resolve().parents[1]
    return ExperimentConfig('exp-test', 1, 1, f'{shlex.quote(sys.executable)} {shlex.quote(str(FAKE))}', skill_root,
                            tmp_path / 'profiles.json', 'fake/m', 'low', (), 1.0, 60)

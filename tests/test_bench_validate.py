import importlib.util
import json
import subprocess
import sys
from pathlib import Path

from conftest import git

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def _load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validate = _load('bench_validate_tasks')
candidates = _load('bench_candidates')

HAS_SOLUTION = "import pathlib,sys; sys.exit(0 if 'SOLUTION' in pathlib.Path('a.txt').read_text() else 1)"


def _task(suite, repo, base, tid, check, *, setup=None, patch_text=None):
    d = suite / tid
    (d / 'hidden').mkdir(parents=True)
    (d / 'hidden' / 'check.py').write_text(check)
    if patch_text is None:
        patch_text = subprocess.run(['git', '-C', str(repo), 'diff', base, 'HEAD'], capture_output=True, text=True, check=True).stdout
    (d / 'reference.patch').write_text(patch_text)
    manifest = {
        'id': tid, 'repo': str(repo), 'base_commit': base, 'goal': 'g', 'task_class': 'implementation',
        'scope_band': 'tiny', 'risk': 'low', 'split': 'dev', 'setup': setup or [], 'visible_checks': [],
        'hidden_checks': [[sys.executable, 'check.py']], 'hidden_files': f'{tid}/hidden',
        'reference_patch': f'{tid}/reference.patch', 'protected_paths': [], 'timeout_s': 30,
    }
    (suite / f'{tid}.json').write_text(json.dumps(manifest))


def test_validator_keeps_good_tasks_and_quarantines_broken_ones(tmp_path, make_repo):
    repo, base = make_repo(tmp_path)          # base a.txt='base', HEAD a.txt='SOLUTION'
    suite = tmp_path / 'suite'
    suite.mkdir()
    _task(suite, repo, base, 'good', HAS_SOLUTION)
    _task(suite, repo, base, 'base-passes', 'import sys; sys.exit(0)')
    _task(suite, repo, base, 'bad-patch', HAS_SOLUTION, patch_text='not a patch\n')
    _task(suite, repo, base, 'setup-fails', HAS_SOLUTION, setup=[[sys.executable, '-c', 'import sys; sys.exit(4)']])
    work = tmp_path / 'work'
    result = validate.validate_suite(suite, work, repeats=3, sandbox=False)
    assert result == {'ok': ['good'], 'quarantine': ['bad-patch', 'base-passes', 'setup-fails']}
    report = json.loads((work / 'validation.json').read_text())
    assert report['reasons']['base-passes'] == 'base does not fail hidden checks'
    assert report['reasons']['bad-patch'] == 'reference patch does not apply'
    assert report['reasons']['setup-fails'].startswith('setup failed')


def test_validator_detects_flaky_reference(tmp_path, make_repo):
    repo, base = make_repo(tmp_path)
    suite = tmp_path / 'suite'
    suite.mkdir()
    counter = tmp_path / 'count'
    flaky = (f"import pathlib,sys; c=pathlib.Path({str(counter)!r}); n=int(c.read_text()) if c.exists() else 0; "
             "c.write_text(str(n+1)); "
             "sys.exit(0 if 'SOLUTION' in pathlib.Path('a.txt').read_text() and n != 2 else 1)")
    _task(suite, repo, base, 'flaky', flaky)
    result = validate.validate_suite(suite, tmp_path / 'work', repeats=3, sandbox=False)
    assert result['quarantine'] == ['flaky']


def test_validator_cli_exit_codes(tmp_path, make_repo):
    repo, base = make_repo(tmp_path)
    suite = tmp_path / 'suite'
    suite.mkdir()
    _task(suite, repo, base, 'good', HAS_SOLUTION)
    ok = subprocess.run([sys.executable, str(SCRIPTS / 'bench_validate_tasks.py'), str(suite), '--work', str(tmp_path / 'w1'), '--no-sandbox'],
                        capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    _task(suite, repo, base, 'broken', 'import sys; sys.exit(0)')
    bad = subprocess.run([sys.executable, str(SCRIPTS / 'bench_validate_tasks.py'), str(suite), '--work', str(tmp_path / 'w2'), '--no-sandbox'],
                         capture_output=True, text=True)
    assert bad.returncode == 1 and 'broken' in bad.stdout


def test_candidates_lists_commits_touching_source_and_tests(tmp_path):
    repo = tmp_path / 'r'
    repo.mkdir()
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    (repo / 'src').mkdir(); (repo / 'tests').mkdir()
    (repo / 'src' / 'a.py').write_text('x=1\n'); (repo / 'tests' / 'test_a.py').write_text('def test(): pass\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'both')
    (repo / 'src' / 'a.py').write_text('x=2\n')
    git(repo, 'commit', '-qam', 'source only')
    (repo / 'docs.md').write_text('d\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'docs only')
    rows = candidates.list_candidates(str(repo), '90.days')
    assert [(r['subject'], r['band'], r['src'], r['tests']) for r in rows] == [('both', 'tiny', 1, 1)]
    assert len(rows[0]['sha']) == 40

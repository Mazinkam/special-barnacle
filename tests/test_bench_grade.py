import json, os, sys
from bench.manifest import load_manifest
from bench.grade import grade

def task(tmp_path, check, protected=('keep.txt',)):
    (tmp_path / 'hidden').mkdir(); (tmp_path / 'hidden' / 'check.py').write_text(check)
    (tmp_path / 'reference.patch').write_text('')
    m = {'id': 't1', 'repo': '/r', 'base_commit': 'a' * 40, 'goal': 'g', 'task_class': 'implementation',
         'scope_band': 'tiny', 'risk': 'low', 'split': 'dev', 'setup': [], 'visible_checks': [],
         'hidden_checks': [[sys.executable, 'check.py']], 'hidden_files': 'hidden',
         'reference_patch': 'reference.patch', 'protected_paths': list(protected), 'timeout_s': 30}
    (tmp_path / 't1.json').write_text(json.dumps(m)); return load_manifest(tmp_path / 't1.json')

def tree(root, **files):
    root.mkdir(); [(root / k.replace('__', '.')).write_text(v) for k, v in files.items()]; return root

def test_pass_when_hidden_check_passes(tmp_path):
    t = task(tmp_path, "import pathlib,sys; sys.exit(0 if pathlib.Path('a.txt').read_text()=='fixed' else 1)")
    base = tree(tmp_path / 'base', a__txt='bug', keep__txt='k'); sub = tree(tmp_path / 'sub', a__txt='fixed', keep__txt='k')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert r.verdict == 'pass' and r.tampered == []

def test_tampering_protected_path_fails(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)')
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='edited')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert r.verdict == 'fail' and r.tampered == ['keep.txt']

def test_timeout_is_error_not_pass(tmp_path):
    t = task(tmp_path, 'import time; time.sleep(60)')
    t = t.__class__(**{**t.__dict__, 'timeout_s': 1})
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='k')
    assert grade(t, sub, base, tmp_path / 'work', sandbox=False).verdict == 'error'


def test_protected_file_replaced_by_symlink_is_tampered(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)')
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='k')
    (tmp_path / 'other.txt').write_text('k')
    (sub / 'keep.txt').unlink(); os.symlink(tmp_path / 'other.txt', sub / 'keep.txt')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert r.tampered == ['keep.txt'] and r.verdict == 'fail'

def test_protected_directory_content_change_is_tampered(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)', protected=('pd',))
    base = tmp_path / 'base'; sub = tmp_path / 'sub'
    for r_ in (base, sub):
        (r_ / 'pd' / 'inner').mkdir(parents=True); (r_ / 'pd' / 'inner' / 'f.txt').write_text('x')
    assert grade(t, sub, base, tmp_path / 'w1', sandbox=False).tampered == []
    (sub / 'pd' / 'inner' / 'f.txt').write_text('y')
    r = grade(t, sub, base, tmp_path / 'w2', sandbox=False)
    assert r.tampered == ['pd'] and r.verdict == 'fail'

def test_grade_copy_keeps_symlinks_and_not_secret(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)')
    secret = tmp_path / 'host_secret.txt'; secret.write_text('TOPSECRET')
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='k')
    os.symlink(secret, sub / 'leak')
    d1 = grade(t, sub, base, tmp_path / 'work', sandbox=False).tree_digest
    assert os.path.islink(tmp_path / 'work' / 'leak')
    secret.write_text('changed')
    assert grade(t, sub, base, tmp_path / 'work', sandbox=False).tree_digest == d1


def test_overlay_does_not_write_through_submitted_symlink(tmp_path):
    chk = 'import sys; sys.exit(0)'
    t = task(tmp_path, chk)
    host = tmp_path / 'host.txt'; host.write_text('HOST')
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='k')
    os.symlink(host, sub / 'check.py')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert host.read_text() == 'HOST'
    w = tmp_path / 'work' / 'check.py'
    assert not w.is_symlink() and w.is_file() and w.read_text() == chk
    assert r.verdict == 'pass'

def test_overlay_does_not_write_through_symlinked_directory(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)')
    (tmp_path / 'hidden' / 'hd').mkdir(); (tmp_path / 'hidden' / 'hd' / 'x.txt').write_text('H')
    outside = tmp_path / 'outside'; outside.mkdir(); (outside / 'x.txt').write_text('HOST')
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='k')
    os.symlink(outside, sub / 'hd')
    grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert (outside / 'x.txt').read_text() == 'HOST'
    assert not (tmp_path / 'work' / 'hd').is_symlink()
    assert (tmp_path / 'work' / 'hd' / 'x.txt').read_text() == 'H'

def test_symlinked_parent_of_protected_path_is_tampered(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)', protected=('tests/keep.txt',))
    base = tmp_path / 'base'; (base / 'tests').mkdir(parents=True); (base / 'tests' / 'keep.txt').write_text('k')
    sub = tmp_path / 'sub'; sub.mkdir()
    outside = tmp_path / 'outside'; outside.mkdir(); (outside / 'keep.txt').write_text('k')
    os.symlink(outside, sub / 'tests')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert r.tampered == ['tests/keep.txt'] and r.verdict == 'fail'

def test_unsafe_protected_paths_are_tampered(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)', protected=('../base/keep.txt', '/etc/hosts'))
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='k')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert r.tampered == ['../base/keep.txt', '/etc/hosts'] and r.verdict == 'fail'


# --- fast tree copy (APFS clone on macOS, copytree elsewhere) -------------------------------------------

import time
import pytest
from bench import grade as grade_mod


def _sample(root):
    (root / 'pkg' / 'node_modules' / 'dep').mkdir(parents=True)
    (root / 'pkg' / 'node_modules' / 'dep' / 'index.js').write_text('module.exports = 1\n')
    (root / 'a.txt').write_text('A')
    (root / '.git').mkdir(); (root / '.git' / 'HEAD').write_text('ref: x\n')
    os.symlink('a.txt', root / 'link.txt')
    os.symlink('/etc/hosts', root / 'abs-link')
    return root


def test_copy_tree_matches_copytree_semantics(tmp_path):
    src = _sample(tmp_path / 'src'); dst = tmp_path / 'dst'
    grade_mod.copy_tree(src, dst)
    assert (dst / 'a.txt').read_text() == 'A'
    assert (dst / 'pkg' / 'node_modules' / 'dep' / 'index.js').read_text() == 'module.exports = 1\n'
    assert not (dst / '.git').exists()                       # history never reaches the graded tree
    assert (dst / 'link.txt').is_symlink() and os.readlink(dst / 'link.txt') == 'a.txt'
    assert (dst / 'abs-link').is_symlink() and os.readlink(dst / 'abs-link') == '/etc/hosts'   # never followed


def test_copy_tree_is_independent_of_the_source(tmp_path):
    src = _sample(tmp_path / 'src'); dst = tmp_path / 'dst'
    grade_mod.copy_tree(src, dst)
    (dst / 'a.txt').write_text('changed')
    assert (src / 'a.txt').read_text() == 'A'


def test_copy_tree_falls_back_when_clone_is_unavailable(tmp_path, monkeypatch):
    src = _sample(tmp_path / 'src'); dst = tmp_path / 'dst'
    monkeypatch.setattr(grade_mod, '_clone', lambda s, d: False)
    grade_mod.copy_tree(src, dst)
    assert (dst / 'a.txt').read_text() == 'A' and not (dst / '.git').exists() and (dst / 'link.txt').is_symlink()


@pytest.mark.skipif(sys.platform != 'darwin', reason='APFS clonefile is macOS-only')
def test_clone_is_used_and_fast_on_macos(tmp_path):
    src = tmp_path / 'big'
    for i in range(3000):
        d = src / f'd{i % 50}'; d.mkdir(parents=True, exist_ok=True); (d / f'f{i}.js').write_text('x' * 2048)
    t0 = time.monotonic(); assert grade_mod._clone(src, tmp_path / 'c1') is True; clone_s = time.monotonic() - t0
    t0 = time.monotonic(); __import__('shutil').copytree(src, tmp_path / 'c2', symlinks=True); copy_s = time.monotonic() - t0
    assert sum(1 for _ in (tmp_path / 'c1').rglob('*.js')) == 3000
    assert clone_s < copy_s

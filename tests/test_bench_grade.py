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

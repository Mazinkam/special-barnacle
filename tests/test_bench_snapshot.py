import io, os, tarfile, subprocess
import pytest
from conftest import git, make_repo_at
import bench.snapshot as snap
from bench.snapshot import make_snapshot, tree_digest

def test_snapshot_has_base_content_and_no_future_history(tmp_path):
    repo, base = make_repo_at(tmp_path)
    info = make_snapshot(repo, base, tmp_path / 'snap')
    assert (info.path / 'a.txt').read_text() == 'base\n'
    assert git(info.path, 'rev-list', '--count', 'HEAD') == '1'
    assert git(info.path, 'remote') == ''
    assert 'SOLUTION' not in subprocess.run(['git', '-C', str(info.path), 'log', '--all', '-p'], capture_output=True, text=True).stdout

def test_tree_digest_is_stable_and_content_sensitive(tmp_path):
    repo, base = make_repo_at(tmp_path)
    a = make_snapshot(repo, base, tmp_path / 's1'); b = make_snapshot(repo, base, tmp_path / 's2')
    assert tree_digest(a.path) == tree_digest(b.path)
    (b.path / 'a.txt').write_text('changed\n')
    assert tree_digest(a.path) != tree_digest(b.path)


def _tar(entries):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        for name, kind, target in entries:
            ti = tarfile.TarInfo(name)
            if kind == 'sym':
                ti.type = tarfile.SYMTYPE; ti.linkname = target
            elif kind == 'hard':
                ti.type = tarfile.LNKTYPE; ti.linkname = target
            elif kind == 'dir':
                ti.type = tarfile.DIRTYPE; ti.mode = 0o755
            else:
                data = target.encode(); ti.size = len(data); t.addfile(ti, io.BytesIO(data)); continue
            t.addfile(ti)
    return buf.getvalue()

def _patch_archive(monkeypatch, data):
    real = snap._git
    monkeypatch.setattr(snap, '_git', lambda cwd, *a, **k: data if a and a[0] == 'archive' else real(cwd, *a, **k))

@pytest.mark.parametrize('entries', [
    [('link', 'sym', '/etc')],
    [('link', 'sym', '../outside')],
    [('d', 'dir', ''), ('d/link', 'sym', '../../outside')],
    [('hl', 'hard', '../outside.txt')],
    [('hl', 'hard', '/etc/passwd')],
    [('a', 'sym', '.'), ('b', 'sym', 'a/..'), ('b/evil.txt', 'file', 'x')],
    [('link', 'sym', '..'), ('link/evil.txt', 'file', 'x')],
])
def test_make_snapshot_rejects_escaping_links(tmp_path, monkeypatch, entries):
    _patch_archive(monkeypatch, _tar(entries))
    base = tmp_path / 'box'; base.mkdir()
    with pytest.raises(ValueError):
        make_snapshot(tmp_path, 'HEAD', base / 'snap')
    assert not (base / 'evil.txt').exists() and not (base / 'snap' / 'sub' / 'evil.txt').exists()
    assert sorted(os.listdir(base)) == ['snap']

def test_make_snapshot_keeps_in_tree_symlink(tmp_path):
    repo, base = make_repo_at(tmp_path)
    os.symlink('a.txt', repo / 'ok'); git(repo, 'add', 'ok'); git(repo, 'commit', '-qm', 'link')
    info = make_snapshot(repo, git(repo, 'rev-parse', 'HEAD'), tmp_path / 'snap')
    assert os.readlink(info.path / 'ok') == 'a.txt'

def test_tree_digest_does_not_follow_symlinks(tmp_path):
    secret = tmp_path / 'host_secret.txt'; secret.write_text('one')
    d = tmp_path / 'tree'; d.mkdir(); (d / 'a.txt').write_text('a')
    os.symlink(secret, d / 'lnk'); os.symlink(tmp_path, d / 'dirlnk')
    d1 = tree_digest(d)
    secret.write_text('two-different')
    assert tree_digest(d) == d1
    os.remove(d / 'lnk'); (d / 'lnk').write_text('one')
    assert tree_digest(d) != d1


# --- worktree_digest: git's view of the tree (ignored build output excluded), repo left untouched ----------

from bench.snapshot import worktree_digest


def _git_state(repo):
    objects = sorted(str(p.relative_to(repo)) for p in (repo / '.git' / 'objects').rglob('*') if p.is_file())
    return objects, (repo / '.git' / 'index').read_bytes()


def _snap_with_ignored_dir(tmp_path, name):
    (tmp_path / name).mkdir()
    repo, base = make_repo_at(tmp_path / name)
    info = make_snapshot(repo, base, tmp_path / name / 'snap')
    (info.path / '.gitignore').write_text('node_modules/\n')
    git(info.path, 'add', '.gitignore'); git(info.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore')
    (info.path / 'node_modules' / 'dep').mkdir(parents=True)
    (info.path / 'node_modules' / 'dep' / 'index.js').write_text('1')
    return info.path


def test_worktree_digest_tracks_real_changes_only(tmp_path):
    a = _snap_with_ignored_dir(tmp_path, 'a')
    b = _snap_with_ignored_dir(tmp_path, 'b')
    assert worktree_digest(a) == worktree_digest(b)                  # same content, different clones
    start = worktree_digest(a)
    (a / 'node_modules' / 'dep' / 'index.js').write_text('2')         # ignored build output
    assert worktree_digest(a) == start
    (a / 'new.txt').write_text('agent file')                           # untracked, not ignored
    with_new = worktree_digest(a)
    assert with_new != start
    (a / 'a.txt').write_text('edited')                                 # tracked edit
    assert worktree_digest(a) not in (start, with_new)
    (a / 'a.txt').unlink()                                             # tracked deletion
    assert worktree_digest(a) not in (start, with_new)


def test_worktree_digest_never_writes_to_the_repo(tmp_path):
    a = _snap_with_ignored_dir(tmp_path, 'a')
    (a / 'new.txt').write_text('agent file')
    before = _git_state(a)
    worktree_digest(a)
    assert _git_state(a) == before


def test_worktree_digest_falls_back_without_git(tmp_path):
    d = tmp_path / 'plain'; d.mkdir(); (d / 'x.txt').write_text('x')
    assert worktree_digest(d) == tree_digest(d)

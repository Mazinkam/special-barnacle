"""Snapshot a task's base tree with no history, remotes or hooks (spec §2.1: worktrees leak the future)."""
from __future__ import annotations

import hashlib
import io
import os
import posixpath
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path

_ENV = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
        'GIT_AUTHOR_NAME': 'bench', 'GIT_AUTHOR_EMAIL': 'bench@invalid', 'GIT_COMMITTER_NAME': 'bench',
        'GIT_COMMITTER_EMAIL': 'bench@invalid', 'GIT_AUTHOR_DATE': '2000-01-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00Z'}


@dataclass(frozen=True)
class SnapshotInfo:
    path: Path
    tree_sha: str
    base_commit_in_snapshot: str


def _git(cwd: Path, *args: str, stdin: bytes | None = None) -> bytes:
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(cwd), *args], input=stdin,
                          check=True, capture_output=True, env=_ENV).stdout


def _inside(rel: str) -> bool:
    return rel != '..' and not rel.startswith('../') and not rel.startswith('/')


def make_snapshot(repo: Path, commit: str, dest: Path) -> SnapshotInfo:
    dest.mkdir(parents=True, exist_ok=False)
    archive = _git(Path(repo), 'archive', '--format=tar', commit)
    root = dest.resolve()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = tar.getmembers()
        for member in members:
            if member.name.startswith('/') or '..' in Path(member.name).parts:
                raise ValueError(f'unsafe archive member {member.name!r}')
            if member.issym() or member.islnk():
                target = member.linkname
                # symlinks resolve from the member's parent; hardlinks from the archive root
                base = posixpath.dirname(member.name) if member.issym() else ''
                if target.startswith('/') or not _inside(posixpath.normpath(posixpath.join(base, target))):
                    raise ValueError(f'unsafe link {member.name!r} -> {target!r}')
        for member in members:
            # a member must not be written through a previously extracted symlink
            parent = (root / member.name).parent.resolve()
            if parent != root and root not in parent.parents:
                raise ValueError(f'archive member {member.name!r} escapes destination')
            tar.extract(member, dest)  # members validated above
    _git(dest, 'init', '-q')
    _git(dest, 'add', '-A')
    _git(dest, 'commit', '-q', '--no-verify', '-m', 'benchmark base')
    return SnapshotInfo(dest, _git(dest, 'rev-parse', 'HEAD^{tree}').decode().strip(),
                        _git(dest, 'rev-parse', 'HEAD').decode().strip())


def tree_digest(path: Path) -> str:
    """Digest of file contents and symlink targets; symlinks are never followed."""
    h = hashlib.sha256()
    root = Path(path)
    entries = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d != '.git']
        for name in dirnames + filenames:  # symlinked dirs appear in dirnames but are not descended
            entries.append(Path(dirpath) / name)
    for f in sorted(entries):
        if f.is_symlink():
            kind, data = b'L', os.readlink(f).encode()
        elif f.is_file():
            kind, data = b'F', f.read_bytes()
        else:
            continue
        rel = f.relative_to(root).as_posix().encode()
        h.update(len(rel).to_bytes(4, 'big') + rel + kind)
        h.update(len(data).to_bytes(8, 'big') + data)
    return h.hexdigest()

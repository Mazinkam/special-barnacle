#!/usr/bin/env python3
"""Build pinned benchmark tools outside every repo: python3 scripts/bench_tools.py --dest DIR [...]

DEST/skill   `git archive` of the orchestrator repo at --skill-rev (no .git) + PINNED.json
DEST/ht      humain-terminal local release built from a `git archive` export of --ht-rev + PINNED.json

The real humain-terminal checkout is only read with `git -C ... rev-parse/archive`; nothing is built or
installed inside it (it may hold uncommitted work and the user's live CLI is npm-linked to its dist).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from bench.snapshot import tree_digest  # noqa: E402

DEFAULT_HT = Path('~/Documents/Projects/humain-terminal').expanduser()
CLI_PACKAGE = Path('node') / 'node_modules' / '@humain' / 'terminal'   # local-release.mjs's isolated npm install


def run(cmd: list[str], *, cwd: Path | None = None, input: bytes | None = None) -> bytes:
    """The one seam for external commands; tests inject a fake with the same signature. git output is
    captured (it is data, and the work-tree probe fails noisily outside a repo); build output streams."""
    capture = subprocess.PIPE if cmd[:1] == ['git'] else None
    r = subprocess.run(cmd, cwd=cwd, input=input, stdout=capture, stderr=capture)
    if r.returncode:
        raise subprocess.CalledProcessError(r.returncode, cmd, r.stdout, r.stderr)
    return r.stdout or b''


class Refusal(Exception):
    pass


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _check_dest(dest: Path, repos: list[Path], runner) -> None:
    real = os.path.realpath(dest)
    probe = Path(real)
    while not probe.exists():
        probe = probe.parent
    try:
        top = runner(['git', '-C', str(probe), 'rev-parse', '--show-toplevel']).decode().strip()
    except (subprocess.CalledProcessError, OSError):
        top = ''
    if top:
        raise Refusal(f'--dest {real} is inside the git work tree {top}; choose a directory outside every repo')
    for repo in repos:
        if _within(real, os.path.realpath(repo)):
            raise Refusal(f'--dest {real} is inside {os.path.realpath(repo)}')


def _commit(repo: Path, rev: str, runner) -> str:
    return runner(['git', '-C', str(repo), 'rev-parse', '--verify', f'{rev}^{{commit}}']).decode().strip()


def _export(repo: Path, commit: str, out: Path, force: bool, runner) -> None:
    if out.exists():
        if not force:
            raise Refusal(f'{out} already exists; pass --force to replace it')
        shutil.rmtree(out)
    out.mkdir(parents=True)
    runner(['tar', '-x', '-C', str(out)], input=runner(['git', '-C', str(repo), 'archive', '--format=tar', commit]))


def build_skill(repo: Path, rev: str, dest: Path, force: bool, runner) -> Path:
    commit = _commit(repo, rev, runner)
    out = dest / 'skill'
    _export(repo, commit, out, force, runner)
    pin = {'source_repo': os.path.realpath(repo), 'commit': commit, 'tree_digest': tree_digest(out)}
    (out / 'PINNED.json').write_text(json.dumps(pin, indent=2, sort_keys=True) + '\n')
    return out


def build_ht(repo: Path, rev: str, dest: Path, force: bool, keep_src: bool, runner) -> Path:
    commit = _commit(repo, rev, runner)
    src, out = dest / 'ht-src', dest / 'ht'
    if out.exists() and not force:
        raise Refusal(f'{out} already exists; pass --force to replace it')
    _export(repo, commit, src, force, runner)
    runner(['npm', 'ci'], cwd=src)
    runner(['node', 'scripts/local-release.mjs', '--out', str(out), '--skip-check', '--skip-test',
            '--skip-bun-install', '--force'], cwd=src)
    pkg = out / CLI_PACKAGE
    try:
        bin_rel = json.loads((pkg / 'package.json').read_text())['bin']['humain-terminal']
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise Refusal(f'no humain-terminal bin entry in {pkg / "package.json"}: {exc}') from None
    cli = pkg / bin_rel
    if not cli.is_file():
        raise Refusal(f'installed CLI not found at {cli}')
    pin = {'source_repo': os.path.realpath(repo), 'commit': commit, 'binary': str(cli)}
    text = json.dumps(pin, indent=2, sort_keys=True) + '\n'
    (out / 'PINNED.json').write_text(text)
    (pkg / 'PINNED.json').write_text(text)   # within reach of bench.arms.provenance (<= 3 dirs above cli.js)
    if not keep_src:   # the export holds HT source at --ht-rev, i.e. possibly the future of HT tasks
        shutil.rmtree(src)
    return cli


def main(argv=None, runner=run) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--dest', required=True, type=Path)
    ap.add_argument('--skill-repo', type=Path, default=HERE.parent)
    ap.add_argument('--skill-rev', default='HEAD')
    ap.add_argument('--ht-repo', type=Path, default=DEFAULT_HT)
    ap.add_argument('--ht-rev', default='HEAD')
    ap.add_argument('--skip-ht', action='store_true')
    ap.add_argument('--keep-src', action='store_true', help='keep DEST/ht-src after the build')
    ap.add_argument('--force', action='store_true', help='replace existing DEST/skill, DEST/ht-src and DEST/ht')
    a = ap.parse_args(argv)
    dest = Path(os.path.abspath(a.dest.expanduser()))
    try:
        _check_dest(dest, [a.skill_repo] + ([] if a.skip_ht else [a.ht_repo]), runner)
        skill = build_skill(a.skill_repo, a.skill_rev, dest, a.force, runner)
        snippet = {'skill_root': str(skill)}
        if not a.skip_ht:
            snippet = {'binary': str(build_ht(a.ht_repo, a.ht_rev, dest, a.force, a.keep_src, runner)), **snippet}
    except Refusal as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    except (subprocess.CalledProcessError, OSError) as exc:
        detail = getattr(exc, 'stderr', None)
        print(f'error: {exc}' + (f'\n{detail.decode(errors="replace").strip()}' if detail else ''), file=sys.stderr)
        return 1
    print('Pinned tools built. Put these in ~/orch-bench/config.json:')
    print(json.dumps(snippet, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

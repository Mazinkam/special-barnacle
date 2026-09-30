import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

from bench.snapshot import tree_digest

_spec = importlib.util.spec_from_file_location('bench_tools_cli', Path(__file__).resolve().parents[1] / 'scripts' / 'bench_tools.py')
bench_tools = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(bench_tools)


def _repo(make_repo, parent):
    parent.mkdir(parents=True, exist_ok=True)
    return make_repo(parent)


def test_refuses_dest_inside_any_git_work_tree(tmp_path, make_repo, capsys):
    skill, _ = _repo(make_repo, tmp_path / 'skill')
    other, _ = _repo(make_repo, tmp_path / 'other')
    dest = other / 'tools'
    rc = bench_tools.main(['--dest', str(dest), '--skill-repo', str(skill), '--skip-ht'])
    assert rc != 0 and 'git work tree' in capsys.readouterr().err
    assert not dest.exists()


def test_refuses_dest_inside_the_skill_or_ht_repo(tmp_path, make_repo, capsys):
    skill, _ = _repo(make_repo, tmp_path / 'skill')
    ht, _ = _repo(make_repo, tmp_path / 'ht')
    for dest in (skill / 'x' / 'tools', ht / 'tools'):
        # stub the work-tree probe so the explicit repo check is what refuses
        rc = bench_tools.main(['--dest', str(dest), '--skill-repo', str(skill), '--ht-repo', str(ht)],
                              runner=_no_git_tree(bench_tools.run))
        assert rc != 0 and 'inside' in capsys.readouterr().err
        assert not dest.exists()


def _no_git_tree(real):
    def runner(cmd, *, cwd=None, input=None):
        if cmd[:1] == ['git'] and '--show-toplevel' in cmd:
            raise subprocess.CalledProcessError(128, cmd)
        return real(cmd, cwd=cwd, input=input)
    return runner


def test_skill_copy_has_no_git_and_a_pinned_json(tmp_path, make_repo, capsys):
    skill, base = _repo(make_repo, tmp_path / 'skill')
    dest = tmp_path / 'tools'
    assert bench_tools.main(['--dest', str(dest), '--skill-repo', str(skill), '--skill-rev', base, '--skip-ht']) == 0
    copy = dest / 'skill'
    assert (copy / 'a.txt').read_text() == 'base\n'          # the requested rev, not the checkout's HEAD
    assert not (copy / '.git').exists()
    pin = json.loads((copy / 'PINNED.json').read_text())
    assert pin['source_repo'] == os.path.realpath(skill) and pin['commit'] == base and len(pin['commit']) == 40
    (copy / 'PINNED.json').rename(tmp_path / 'pin.json')
    assert pin['tree_digest'] == tree_digest(copy)
    out = capsys.readouterr().out
    assert json.loads(out[out.index('{'):out.rindex('}') + 1])['skill_root'] == str(copy)


def test_ht_step_builds_an_exported_copy_never_the_real_repo(tmp_path, make_repo, capsys):
    skill, _ = _repo(make_repo, tmp_path / 'skill')
    ht, ht_base = _repo(make_repo, tmp_path / 'ht')
    dest = tmp_path / 'tools'
    calls = []

    def runner(cmd, *, cwd=None, input=None):
        calls.append((list(cmd), cwd))
        if cmd[0] in ('git', 'tar'):
            return bench_tools.run(cmd, cwd=cwd, input=input)
        if cmd[:2] == ['node', 'scripts/local-release.mjs']:   # emulate the installed consumer layout
            pkg = Path(cmd[cmd.index('--out') + 1]) / 'node' / 'node_modules' / '@humain' / 'terminal'
            (pkg / 'dist' / 'bundle').mkdir(parents=True)
            (pkg / 'dist' / 'bundle' / 'cli.js').write_text('#!/usr/bin/env node\n')
            (pkg / 'package.json').write_text(json.dumps({'bin': {'humain-terminal': 'dist/bundle/cli.js'}}))
        return b''

    rc = bench_tools.main(['--dest', str(dest), '--skill-repo', str(skill), '--ht-repo', str(ht), '--ht-rev', ht_base],
                          runner=runner)
    assert rc == 0
    src, out_dir = dest / 'ht-src', dest / 'ht'
    build = [(c, w) for c, w in calls if c[0] not in ('git', 'tar')]
    assert build == [(['npm', 'ci'], src),
                     (['node', 'scripts/local-release.mjs', '--out', str(out_dir), '--skip-check', '--skip-test',
                       '--skip-bun-install', '--force'], src)]
    real = os.path.realpath(ht)
    for cmd, cwd in calls:   # the real HT repo is only ever read through git -C
        assert cwd is None or not os.path.realpath(cwd).startswith(real)
        if real in [os.path.realpath(x) for x in cmd if os.path.isabs(x)]:
            assert cmd[0] == 'git' and cmd[1] == '-C' and cmd[3] in ('rev-parse', 'archive')
    assert ['tar', '-x', '-C', str(src)] in [c for c, _ in calls]
    cli = out_dir / 'node' / 'node_modules' / '@humain' / 'terminal' / 'dist' / 'bundle' / 'cli.js'
    pin = json.loads((out_dir / 'PINNED.json').read_text())
    assert pin['source_repo'] == real and pin['commit'] == ht_base and pin['binary'] == str(cli)
    assert json.loads((cli.parents[2] / 'PINNED.json').read_text()) == pin   # found by bench.arms.provenance
    assert not src.exists()   # the exported source (future code for HT tasks) is removed after the build
    out = capsys.readouterr().out
    snippet = json.loads(out[out.index('{'):out.rindex('}') + 1])
    assert snippet == {'binary': str(cli), 'skill_root': str(dest / 'skill')}


def test_existing_copy_requires_force(tmp_path, make_repo, capsys):
    skill, _ = _repo(make_repo, tmp_path / 'skill')
    dest = tmp_path / 'tools'
    args = ['--dest', str(dest), '--skill-repo', str(skill), '--skip-ht']
    assert bench_tools.main(args) == 0
    assert bench_tools.main(args) != 0 and '--force' in capsys.readouterr().err
    assert bench_tools.main([*args, '--force']) == 0
    shutil.rmtree(dest)

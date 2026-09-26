"""Opt-in, reversible gzip archival of completed run diagnostics.

Every test builds its own throwaway state root: root streams (`events.jsonl`, `metrics.jsonl`,
`outcomes.jsonl`) plus recovery metadata, and `runs/<run_id>/` directories laid out like the HT
bridge writes them (`run.log`, `<task>.events.jsonl`, `<task>.prompt.md`, `<task>.stderr.log`).
The live state root is never read or written.
"""
from __future__ import annotations

import errno
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from orchestrator import archive
from orchestrator.runtime import read_json

REPO = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
DAY = 86400


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(root: Path) -> dict[str, tuple]:
    """(bytes hash, mtime_ns) of every file under `root`, keyed by relative path — symlinks included as entries."""
    out = {}
    for path in sorted(root.rglob('*')):
        rel = str(path.relative_to(root))
        if path.is_symlink(): out[rel] = ('symlink', os.readlink(path))
        elif path.is_file(): out[rel] = (sha256(path), path.stat().st_mtime_ns)
        else: out[rel] = ('dir',)
    return out


def set_age(path: Path, days: float) -> None:
    ts = (NOW - timedelta(days=days)).timestamp()
    os.utime(path, ns=(int(ts * 1e9), int(ts * 1e9)))


class ArchiveFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'state'; self.root.mkdir()
        self.runs = self.root / 'runs'; self.runs.mkdir()
        # authoritative streams and recovery metadata: must be byte-identical after any archive command
        (self.root / 'events.jsonl').write_text('{"event":"run_started","run_id":"old-done","ts":"2026-08-01T00:00:00+00:00"}\n')
        (self.root / 'metrics.jsonl').write_text('{"model":"m","cost_usd":1.5,"run_id":"old-done"}\n')
        (self.root / 'ledger.json').write_text('{"schema_version":3}')
        (self.root / 'records.checkpoint.json').write_text('{"format_version":1}')
        (self.root / 'records.index.sqlite3').write_bytes(b'SQLite format 3\x00fake')
        (self.root / 'ingest-checkpoints').mkdir(); (self.root / 'ingest-checkpoints' / 'abc.json').write_text('{}')
        self.outcomes = self.root / 'outcomes.jsonl'; self.outcomes.write_text('')

    # -- fixture helpers -----------------------------------------------------------------------
    def outcome(self, run_id: str, *, task_id: str = 'run-complete', days_ago: float | None = 40, ts: str | None = None, **extra):
        if ts is None: ts = (NOW - timedelta(days=days_ago)).isoformat()
        row = {'ts': ts, 'run_id': run_id, 'task_id': task_id, 'outcome': 'verified' if task_id == 'run-complete' else 'fail', **extra}
        with self.outcomes.open('a') as f: f.write(json.dumps(row) + '\n')

    def run_dir(self, run_id: str, *, days_ago: float = 40, files: dict[str, bytes] | None = None, run_log: bytes = b'2026-08-01T00:00:00Z run started\n') -> Path:
        d = self.runs / run_id; d.mkdir()
        files = {'run.log': run_log, f'{run_id}-lead-0.events.jsonl': b'{"type":"message_start"}\n' * 400,
                 f'{run_id}-lead-0.prompt.md': b'# task\n' * 30, f'{run_id}-lead-0.stderr.log': b'', 'lead-report.md': b'report\n' * 20} if files is None else files
        for name, data in files.items(): (d / name).write_bytes(data); set_age(d / name, days_ago)
        set_age(d, days_ago)
        return d

    def completed_run(self, run_id: str = 'old-done', *, days_ago: float = 40, **kw) -> Path:
        d = self.run_dir(run_id, days_ago=days_ago, **kw); self.outcome(run_id, days_ago=days_ago); return d

    def plan(self, **kw):
        return archive.archive_runs(self.root, older_than_days=kw.pop('older_than_days', 30), execute=False, now=NOW, **kw)

    def execute(self, **kw):
        return archive.archive_runs(self.root, older_than_days=kw.pop('older_than_days', 30), execute=True, now=NOW, **kw)

    def by_run(self, entries):
        return {e['run_id']: e for e in entries}


class DryRunTests(ArchiveFixture):
    def test_dry_run_reports_paths_and_estimates_without_writing_anything(self):
        run = self.completed_run()
        before = snapshot(self.root)
        entries = self.by_run(self.plan())
        self.assertEqual(snapshot(self.root), before, 'a dry run must not create, touch or modify any file')
        self.assertFalse((self.root / 'archive.lock').exists())
        entry = entries['old-done']
        self.assertEqual(entry['status'], 'eligible')
        names = {f['name'] for f in entry['files']}
        self.assertIn('old-done-lead-0.events.jsonl', names); self.assertIn('lead-report.md', names)
        self.assertNotIn('run.log', names, 'run.log stays readable in place')
        events = next(f for f in entry['files'] if f['name'] == 'old-done-lead-0.events.jsonl')
        self.assertEqual(events['path'], str(run / 'old-done-lead-0.events.jsonl'))
        self.assertEqual(events['destination'], str(run / 'old-done-lead-0.events.jsonl.gz'))
        self.assertEqual(events['raw_bytes'], 400 * len(b'{"type":"message_start"}\n'))
        self.assertGreater(events['estimated_compressed_bytes'], 0)
        self.assertLess(events['estimated_compressed_bytes'], events['raw_bytes'])
        self.assertEqual(entry['raw_bytes'], sum(f['raw_bytes'] for f in entry['files']))
        self.assertEqual(entry['estimated_compressed_bytes'], sum(f['estimated_compressed_bytes'] for f in entry['files']))
        self.assertNotIn('compressed_bytes', entry, 'a dry run has no actual compressed size to report')

    def test_dry_run_on_missing_runs_directory_reports_nothing_and_creates_nothing(self):
        shutil.rmtree(self.runs)
        self.assertEqual(self.plan(), [])
        self.assertFalse(self.runs.exists())

    def test_older_than_days_must_be_positive(self):
        for bad in (0, -1, float('nan')):
            with self.assertRaises(ValueError): archive.archive_runs(self.root, older_than_days=bad, execute=False, now=NOW)


class EligibilityTests(ArchiveFixture):
    def test_active_run_without_terminal_outcome_is_skipped_even_when_files_look_old(self):
        self.run_dir('looks-old-but-active', days_ago=90)  # no outcome row at all
        entry = self.by_run(self.plan())['looks-old-but-active']
        self.assertEqual(entry['status'], 'skipped'); self.assertEqual(entry['reason'], 'no_terminal_outcome')
        self.assertIn('run-complete', entry['detail']); self.assertIn('outcomes.jsonl', entry['detail'])
        self.assertEqual(entry['files'], [])

    def test_run_with_only_non_terminal_outcomes_is_skipped(self):
        self.run_dir('task-only', days_ago=90); self.outcome('task-only', task_id='T1', days_ago=90)
        entry = self.by_run(self.plan())['task-only']
        self.assertEqual((entry['status'], entry['reason']), ('skipped', 'no_terminal_outcome'))

    def test_recently_completed_run_is_skipped_with_its_age(self):
        self.completed_run('fresh', days_ago=3)
        entry = self.by_run(self.plan())['fresh']
        self.assertEqual((entry['status'], entry['reason']), ('skipped', 'recent'))
        self.assertIn('3.0 days', entry['detail']); self.assertIn('30', entry['detail'])

    def test_terminal_outcome_without_parseable_timestamp_is_skipped_as_ambiguous(self):
        self.run_dir('no-ts', days_ago=90); self.outcome('no-ts', ts='not a timestamp')
        entry = self.by_run(self.plan())['no-ts']
        self.assertEqual((entry['status'], entry['reason']), ('skipped', 'age_unknown'))

    def test_old_completion_but_recently_modified_files_is_skipped(self):
        d = self.completed_run('late-writer', days_ago=60)
        set_age(d / 'late-writer-lead-0.events.jsonl', 1)
        entry = self.by_run(self.plan())['late-writer']
        self.assertEqual((entry['status'], entry['reason']), ('skipped', 'recently_modified'))
        self.assertIn('late-writer-lead-0.events.jsonl', entry['detail'])

    def test_failed_and_cancelled_runs_count_as_completed(self):
        self.run_dir('failed', days_ago=40); self.outcome('failed', task_id='run-failed', days_ago=40)
        self.assertEqual(self.by_run(self.plan())['failed']['status'], 'eligible')

    def test_latest_terminal_outcome_decides_age(self):
        self.run_dir('twice', days_ago=40); self.outcome('twice', days_ago=40); self.outcome('twice', task_id='run-failed', days_ago=2)
        self.assertEqual(self.by_run(self.plan())['twice']['reason'], 'recent')

    def test_stream_names_and_recovery_metadata_are_never_archived_even_inside_a_run_directory(self):
        self.completed_run('odd', files={'run.log': b'x\n', 'events.jsonl': b'{}\n' * 50, 'metrics.jsonl': b'{}\n' * 50, 'outcomes.jsonl': b'{}\n' * 50,
                                         'ledger.json': b'{}', 'records.checkpoint.json': b'{}', 'discoveries.jsonl': b'{}\n', 'big.events.jsonl': b'{}\n' * 50})
        entry = self.by_run(self.plan())['odd']
        self.assertEqual([f['name'] for f in entry['files']], ['big.events.jsonl'])
        for f in archive.NEVER_ARCHIVE: self.assertNotIn(f, {x['name'] for x in entry['files']})
        self.execute()
        for name in ('events.jsonl', 'metrics.jsonl', 'outcomes.jsonl', 'ledger.json', 'records.checkpoint.json', 'discoveries.jsonl', 'run.log'):
            self.assertTrue((self.runs / 'odd' / name).exists(), name)

    def test_run_with_nothing_to_archive_is_reported(self):
        self.completed_run('log-only', files={'run.log': b'closed\n'})
        entry = self.by_run(self.plan())['log-only']
        self.assertEqual((entry['status'], entry['reason']), ('skipped', 'nothing_to_archive'))

    def test_non_directories_and_symlinked_run_directories_are_ignored(self):
        (self.runs / 'stray.txt').write_text('x')
        real = self.completed_run('real'); os.symlink(real, self.runs / 'alias')
        self.outcome('alias')
        ids = {e['run_id'] for e in self.plan()}
        self.assertEqual(ids, {'real'})

    def test_subdirectories_and_symlinks_inside_a_run_are_not_archived(self):
        d = self.completed_run('nested'); (d / 'sub').mkdir(); (d / 'sub' / 'x.log').write_text('x'); os.symlink(d / 'lead-report.md', d / 'link.md')
        entry = self.by_run(self.plan())['nested']
        self.assertNotIn('link.md', {f['name'] for f in entry['files']}); self.assertNotIn('x.log', {f['name'] for f in entry['files']})
        self.execute(); self.assertTrue((d / 'link.md').is_symlink()); self.assertTrue((d / 'sub' / 'x.log').exists())


class ExecuteAndRestoreTests(ArchiveFixture):
    def test_execute_preserves_raw_with_verified_snapshot_and_restore_is_byte_identical(self):
        d = self.completed_run()
        originals = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in d.iterdir()}
        root_before = {k: v for k, v in snapshot(self.root).items() if not k.startswith('runs/')}
        entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'archived', entry)
        root_after = {k: v for k, v in snapshot(self.root).items() if not k.startswith('runs/')}
        self.assertEqual(root_after.pop(archive.ARCHIVE_LOCK_FILE)[0], sha256(self.root / archive.ARCHIVE_LOCK_FILE), 'only the (empty) archive lock file is new')
        self.assertEqual((self.root / archive.ARCHIVE_LOCK_FILE).stat().st_size, 0)
        self.assertEqual(root_after, root_before, 'authoritative streams and recovery metadata are untouched')
        self.assertEqual((d / 'run.log').read_bytes(), originals['run.log'][0], 'run.log stays readable in place')
        for name in ('old-done-lead-0.events.jsonl', 'old-done-lead-0.prompt.md', 'old-done-lead-0.stderr.log', 'lead-report.md'):
            self.assertEqual((d / name).read_bytes(), originals[name][0], f'{name} original must be retained')
            gz = d / f'{name}.gz'; self.assertTrue(gz.exists(), f'{name}.gz missing')
            with gzip.open(gz, 'rb') as f: self.assertEqual(f.read(), originals[name][0])
        manifest = read_json(d / archive.MANIFEST_FILE, None)
        self.assertEqual(manifest['format_version'], archive.FORMAT_VERSION); self.assertEqual(manifest['run_id'], 'old-done')
        self.assertEqual(set(manifest['files']), {'old-done-lead-0.events.jsonl', 'old-done-lead-0.prompt.md', 'old-done-lead-0.stderr.log', 'lead-report.md'})
        for name, info in manifest['files'].items():
            self.assertEqual(info['sha256'], hashlib.sha256(originals[name][0]).hexdigest())
            self.assertEqual(info['raw_bytes'], len(originals[name][0])); self.assertEqual(info['archive'], f'{name}.gz')
            self.assertEqual(info['compressed_bytes'], (d / info['archive']).stat().st_size)
        self.assertEqual(entry['compressed_bytes'], sum(i['compressed_bytes'] for i in manifest['files'].values()))
        self.assertEqual(entry['raw_bytes'], sum(len(v[0]) for k, v in originals.items() if k != 'run.log'))
        self.assertTrue(all(f['status'] == 'archived' for f in entry['files']))
        self.assertFalse(list(d.glob('.*.tmp')), 'no temporary files left behind')

        self.assertEqual(entry['reclaimed_bytes'], 0)
        # Emulate legacy archives made by the old protocol, to exercise actual decompression.
        for name in manifest['files']: (d / name).unlink()
        recovery_before = snapshot(d)
        result = archive.restore_run(self.root, 'old-done')
        self.assertEqual(set(result['restored']), set(manifest['files'])); self.assertEqual(result['errors'], [])
        for name, (data, mtime_ns) in originals.items():
            self.assertEqual((d / name).read_bytes(), data, name)
            self.assertEqual((d / name).stat().st_mtime_ns, mtime_ns, f'{name} mtime restored')
        self.assertTrue(result['recovery_copies_retained'])
        for name, value in recovery_before.items(): self.assertEqual(snapshot(d)[name], value)
        self.assertFalse(list(d.glob('.*.tmp')))

    def test_repeated_execution_is_a_no_op_and_verifies_retained_snapshots(self):
        d = self.completed_run(); self.execute()
        after_first = snapshot(d)
        entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'archived')
        self.assertTrue(all(f['original_retained'] for f in entry['files']))
        self.assertEqual(snapshot(d), after_first)
        plan_entry = self.by_run(self.plan())['old-done']
        self.assertEqual(plan_entry['status'], 'eligible')
        self.assertEqual(plan_entry['compressed_bytes_already_archived'], sum(p.stat().st_size for p in d.glob('*.gz')))

    def test_repeated_execution_keeps_original_after_interrupted_legacy_archive(self):
        d = self.completed_run(); name = 'old-done-lead-0.events.jsonl'
        self.execute()
        # crash simulation: manifest + verified .gz exist but the raw file is still there (with its original mtime)
        with gzip.open(d / f'{name}.gz', 'rb') as f: (d / name).write_bytes(f.read())
        set_age(d / name, 40)
        gz_before = (d / f'{name}.gz').stat()
        entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'archived')
        self.assertTrue((d / name).exists()); self.assertEqual((d / f'{name}.gz').stat().st_ino, gz_before.st_ino, 'verified archive reused, not recompressed')

    def test_raw_file_that_diverged_from_its_manifest_entry_is_never_removed(self):
        d = self.completed_run(); name = 'lead-report.md'; self.execute()
        (d / name).write_bytes(b'edited after archive\n'); set_age(d / name, 45)
        entry = self.by_run(self.execute())['old-done']
        f = next(x for x in entry['files'] if x['name'] == name)
        self.assertEqual((entry['status'], f['status'], f['reason']), ('partial', 'skipped', 'raw_diverged'))
        self.assertEqual((d / name).read_bytes(), b'edited after archive\n'); self.assertTrue((d / f'{name}.gz').exists())

    def test_stale_gz_without_manifest_entry_is_preserved(self):
        d = self.completed_run(); name = 'lead-report.md'
        (d / f'{name}.gz').write_bytes(b'garbage'); set_age(d / f'{name}.gz', 40)
        entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'partial')
        self.assertEqual((d / f'{name}.gz').read_bytes(), b'garbage')
        self.assertEqual((d / name).read_bytes(), b'report\n' * 20)

    def test_gz_bytes_are_deterministic_for_identical_input(self):
        d1 = self.completed_run('a'); d2 = self.completed_run('b'); self.execute()
        self.assertEqual((d1 / 'lead-report.md.gz').read_bytes(), (d2 / 'lead-report.md.gz').read_bytes())

    def test_empty_file_round_trips(self):
        d = self.completed_run(); self.execute()
        self.assertTrue((d / 'old-done-lead-0.stderr.log.gz').exists())
        archive.restore_run(self.root, 'old-done'); self.assertEqual((d / 'old-done-lead-0.stderr.log').read_bytes(), b'')

    def test_execute_skips_ineligible_runs_and_archives_only_eligible_ones(self):
        self.run_dir('active', days_ago=90); self.completed_run('fresh', days_ago=2); old = self.completed_run('old', days_ago=40)
        active_before = snapshot(self.runs / 'active'); fresh_before = snapshot(self.runs / 'fresh')
        entries = self.by_run(self.execute())
        self.assertEqual(entries['active']['status'], 'skipped'); self.assertEqual(entries['fresh']['status'], 'skipped'); self.assertEqual(entries['old']['status'], 'archived')
        self.assertEqual(snapshot(self.runs / 'active'), active_before); self.assertEqual(snapshot(self.runs / 'fresh'), fresh_before)
        self.assertTrue((old / archive.MANIFEST_FILE).exists())


class FailureTests(ArchiveFixture):
    def test_stale_temp_files_and_other_dotfiles_are_left_alone(self):
        d = self.completed_run()
        stale = d / '.lead-report.md.gz.0123456789abcdef.tmp'; stale.write_bytes(b'partial'); set_age(stale, 40)
        other = d / '.DS_Store'; other.write_bytes(b'mac'); set_age(other, 40)
        plan = self.by_run(self.plan())['old-done']
        self.assertNotIn('.DS_Store', {f['name'] for f in plan['files']}); self.assertNotIn(stale.name, {f['name'] for f in plan['files']})
        entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'archived'); self.assertNotIn('removed_temp_files', entry)
        self.assertEqual(stale.read_bytes(), b'partial'); self.assertEqual(other.read_bytes(), b'mac')
    def test_disk_full_during_compression_keeps_raw_and_leaves_no_temp_or_manifest(self):
        d = self.completed_run(files={'run.log': b'log\n', 'x.events.jsonl': b'{}\n' * 100, 'x.stderr.log': b'err\n', 'lead-report.md': b'report\n'}); before = snapshot(d)

        class FullDisk(gzip.GzipFile):
            def write(self, data):
                raise OSError(errno.ENOSPC, 'No space left on device')

        with patch.object(archive.gzip, 'GzipFile', FullDisk):
            entries = self.by_run(self.execute())
        entry = entries['old-done']
        self.assertEqual(entry['status'], 'failed')
        self.assertTrue(all(f['status'] == 'failed' and f['reason'] == 'write_failed' and 'No space left' in f['detail'] for f in entry['files']), entry['files'])
        self.assertEqual(snapshot(d), before, 'raw diagnostics untouched, no temp files, no manifest')

    def test_verification_failure_keeps_raw_and_writes_no_archive(self):
        d = self.completed_run(); before = snapshot(d)
        with patch.object(archive.execute, '_decompressed_digest', return_value=('0' * 64, 0)):
            entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'failed')
        self.assertTrue(all(f['reason'] == 'verification_failed' for f in entry['files']))
        self.assertEqual(snapshot(d), before)

    def test_interrupted_publish_keeps_raw_and_removes_temp(self):
        d = self.completed_run(); before = snapshot(d)
        with patch.object(archive.os, 'link', side_effect=OSError(errno.EIO, 'Input/output error')):
            entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'failed'); self.assertEqual(snapshot(d), before)

    def test_insufficient_free_space_is_skipped_before_any_write(self):
        d = self.completed_run(); before = snapshot(d)
        with patch.object(archive.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(10 ** 12, 10 ** 12 - 10, 10)):
            entry = self.by_run(self.execute())['old-done']
        self.assertEqual(entry['status'], 'skipped'); self.assertEqual(entry['reason'], 'insufficient_disk')
        self.assertEqual(snapshot(d), before)

    def test_file_appended_during_compression_is_not_replaced(self):
        d = self.completed_run(); name = 'old-done-lead-0.events.jsonl'; target = d / name
        original = target.read_bytes()
        real = archive.execute._compress_to_temp

        def racing(src, *a, **k):
            result = real(src, *a, **k)
            if Path(src).name == name:
                with target.open('ab') as f: f.write(b'{"late":true}\n')
                set_age(target, 40)
            return result

        with patch.object(archive.execute, '_compress_to_temp', racing):
            entry = self.by_run(self.execute())['old-done']
        f = next(x for x in entry['files'] if x['name'] == name)
        self.assertEqual((f['status'], f['reason']), ('skipped', 'modified_during_archive'))
        self.assertEqual(target.read_bytes(), original + b'{"late":true}\n'); self.assertFalse((d / f'{name}.gz').exists())
        self.assertEqual(entry['status'], 'partial')
        others = [x for x in entry['files'] if x['name'] != name]
        self.assertTrue(all(x['status'] == 'archived' for x in others))

    def test_second_archiver_waits_for_the_first(self):
        self.completed_run()
        entered = threading.Event(); release = threading.Event(); order = []
        real = archive.execute._compress_to_temp

        def slow(src, *a, **k):
            entered.set(); release.wait(5); return real(src, *a, **k)

        def first():
            with patch.object(archive.execute, '_compress_to_temp', slow): order.append(('first', self.execute()))

        t = threading.Thread(target=first); t.start(); self.assertTrue(entered.wait(5))
        t2 = threading.Thread(target=lambda: order.append(('second', self.execute()))); t2.start()
        time.sleep(0.2); self.assertEqual(len(order), 0, 'second archiver must block on the archive lock')
        release.set(); t.join(5); t2.join(5)
        self.assertEqual([o[0] for o in order], ['first', 'second'])
        self.assertEqual(self.by_run(order[0][1])['old-done']['status'], 'archived')
        self.assertEqual(self.by_run(order[1][1])['old-done']['status'], 'archived')


class RestoreTests(ArchiveFixture):
    def test_restore_unknown_or_unarchived_run_reports_clearly(self):
        self.completed_run('plain')
        result = archive.restore_run(self.root, 'plain')
        self.assertEqual(result['restored'], []); self.assertEqual(result['status'], 'not_archived'); self.assertIn('not archived', result['message'])
        with self.assertRaises(FileNotFoundError): archive.restore_run(self.root, 'never-existed')

    def test_restore_rejects_path_like_run_ids(self):
        for bad in ('../x', 'a/b', '.', '..', '', '.hidden'):
            with self.assertRaises(ValueError): archive.restore_run(self.root, bad)

    def test_restore_refuses_a_corrupt_archive_and_keeps_it(self):
        d = self.completed_run(); self.execute(); gz = d / 'lead-report.md.gz'
        (d / 'lead-report.md').unlink()  # legacy raw-absent restore
        good = gz.read_bytes(); gz.write_bytes(good[:-6] + b'\x00' * 6)
        result = archive.restore_run(self.root, 'old-done')
        self.assertIn('lead-report.md', [e['name'] for e in result['errors']])
        self.assertEqual(result['errors'][0]['reason'], 'verification_failed')
        self.assertFalse((d / 'lead-report.md').exists()); self.assertTrue(gz.exists())
        manifest = read_json(d / archive.MANIFEST_FILE, None); self.assertIn('lead-report.md', manifest['files'])
        self.assertIn('old-done-lead-0.events.jsonl', manifest['files'], 'recovery metadata remains immutable')
        self.assertFalse(list(d.glob('.*.tmp')))

    def test_restore_does_not_overwrite_a_differing_raw_file(self):
        d = self.completed_run(); self.execute()
        (d / 'lead-report.md').write_bytes(b'new content\n')
        result = archive.restore_run(self.root, 'old-done')
        err = next(e for e in result['errors'] if e['name'] == 'lead-report.md')
        self.assertEqual(err['reason'], 'raw_exists'); self.assertEqual((d / 'lead-report.md').read_bytes(), b'new content\n')
        self.assertTrue((d / 'lead-report.md.gz').exists())

    def test_restore_dry_run_lists_archived_files_without_writing(self):
        d = self.completed_run(); self.execute(); before = snapshot(d)
        result = archive.restore_run(self.root, 'old-done', execute=False)
        self.assertEqual(set(result['would_restore']), {'old-done-lead-0.events.jsonl', 'old-done-lead-0.prompt.md', 'old-done-lead-0.stderr.log', 'lead-report.md'})
        self.assertEqual(snapshot(d), before)

    def test_archive_after_restore_round_trips_again(self):
        d = self.completed_run(); originals = {p.name: p.read_bytes() for p in d.iterdir()}
        self.execute(); archive.restore_run(self.root, 'old-done'); self.execute(); archive.restore_run(self.root, 'old-done')
        self.assertEqual({name: (d / name).read_bytes() for name in originals}, originals)
        self.assertTrue((d / archive.MANIFEST_FILE).exists())


class CliTests(ArchiveFixture):
    def cli(self, *args: str, root: Path | None = None) -> subprocess.CompletedProcess:
        env = {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(root or self.root), 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'}
        return subprocess.run([sys.executable, '-B', '-m', 'orchestrator.cli', *args], cwd=REPO, env=env, capture_output=True, text=True)

    def test_help_documents_both_commands(self):
        top = self.cli('--help'); self.assertEqual(top.returncode, 0); self.assertIn('archive-runs', top.stdout); self.assertIn('restore-run', top.stdout)
        a = self.cli('archive-runs', '--help'); self.assertEqual(a.returncode, 0)
        for needle in ('--execute', '--older-than-days', 'dry run', 'gzip', 'SHA-256', 'run.log', 'events.jsonl', 'restore-run', 'Never archived', 'Nothing is deleted'):
            self.assertIn(needle, a.stdout, needle)
        r = self.cli('restore-run', '--help'); self.assertEqual(r.returncode, 0)
        for needle in ('run_id', 'byte', 'manifest', '--dry-run'): self.assertIn(needle, r.stdout, needle)

    def test_cli_dry_run_prints_estimates_and_writes_nothing(self):
        self.completed_run(); self.run_dir('active', days_ago=90); before = snapshot(self.root)
        res = self.cli('archive-runs', '--older-than-days', '30')
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn('DRY RUN', res.stdout); self.assertIn('--execute', res.stdout); self.assertIn('old-done', res.stdout); self.assertIn('.events.jsonl.gz', res.stdout)
        self.assertIn('active', res.stdout); self.assertIn('no_terminal_outcome', res.stdout)
        self.assertRegex(res.stdout, r'estimated compressed')
        self.assertEqual(snapshot(self.root), before, 'CLI dry run must not create the lock, manifest, ledger or streams')
        out = self.cli('archive-runs', '--json'); data = json.loads(out.stdout)
        self.assertEqual({e['run_id']: e['status'] for e in data['runs']}, {'old-done': 'eligible', 'active': 'skipped'})
        self.assertFalse(data['executed']); self.assertEqual(data['eligible_raw_bytes'], self.by_run(data['runs'])['old-done']['raw_bytes'])
        self.assertEqual(snapshot(self.root), before)

    def test_cli_dry_run_on_absent_root_creates_nothing(self):
        missing = Path(self.tmp.name) / 'absent'
        res = self.cli('archive-runs', root=missing); self.assertEqual(res.returncode, 0, res.stderr); self.assertFalse(missing.exists())

    def test_cli_execute_then_restore_round_trip(self):
        d = self.completed_run(); originals = {p.name: p.read_bytes() for p in d.iterdir()}
        # the CLI's clock is the real one: make the completion 40 real days old
        self.outcomes.write_text(''); self.outcome('old-done', ts=(datetime.now(timezone.utc) - timedelta(days=40)).isoformat())
        for p in d.iterdir(): os.utime(p, (time.time() - 40 * DAY, time.time() - 40 * DAY))
        res = self.cli('archive-runs', '--execute', '--json'); self.assertEqual(res.returncode, 0, res.stderr)
        data = json.loads(res.stdout); self.assertTrue(data['executed']); self.assertEqual(self.by_run(data['runs'])['old-done']['status'], 'archived')
        self.assertTrue((d / 'lead-report.md').exists()); self.assertTrue((d / 'lead-report.md.gz').exists()); self.assertEqual((d / 'run.log').read_bytes(), originals['run.log'])
        self.assertEqual(data['reclaimed_bytes'], 0)
        (d / 'lead-report.md').unlink()  # exercise legacy restore through CLI
        listing = self.cli('restore-run', 'old-done', '--dry-run'); self.assertEqual(listing.returncode, 0, listing.stderr); self.assertIn('lead-report.md.gz', listing.stdout)
        self.assertTrue((d / 'lead-report.md.gz').exists())
        restored = self.cli('restore-run', 'old-done'); self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual({name: (d / name).read_bytes() for name in originals}, originals)
        again = self.cli('restore-run', 'old-done'); self.assertEqual(again.returncode, 0); self.assertIn('retained for recovery', again.stdout)
        bad = self.cli('restore-run', '../etc'); self.assertNotEqual(bad.returncode, 0)
        unknown = self.cli('restore-run', 'nope'); self.assertNotEqual(unknown.returncode, 0); self.assertIn('nope', unknown.stderr + unknown.stdout)

    def test_cli_execute_preserves_raw_and_corrupt_gzip_collision_and_returns_failure(self):
        d = self.completed_run()
        raw = d / 'lead-report.md'
        original = raw.read_bytes()
        corrupt_bytes = b'not a gzip archive; preserve this collision\x00\xff'
        collision = d / 'lead-report.md.gz'
        collision.write_bytes(corrupt_bytes)
        self.outcomes.write_text(''); self.outcome('old-done', ts=(datetime.now(timezone.utc) - timedelta(days=40)).isoformat())
        for p in d.iterdir(): os.utime(p, (time.time() - 40 * DAY, time.time() - 40 * DAY))
        res = self.cli('archive-runs', '--execute')
        self.assertEqual(res.returncode, 1, res.stdout + res.stderr)
        self.assertIn('lead-report.md', res.stdout + res.stderr)
        self.assertEqual(raw.read_bytes(), original, 'a corrupt destination must not authorize deleting the source')
        self.assertEqual(collision.read_bytes(), corrupt_bytes, 'a corrupt pre-existing archive must never be overwritten')


if __name__ == '__main__':
    unittest.main()

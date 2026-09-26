"""Sealed HT runs may reclaim raw bytes; uncoordinated runs remain snapshots."""
import errno
import gzip
import hashlib
import json
from unittest.mock import patch

from orchestrator import archive
from tests.test_archive import ArchiveFixture, NOW, snapshot

OWNER = '.diagnostics-owner.json'
SEAL = '.diagnostics-sealed.json'


def seal_fixture(run):
    owner = {'format_version': 1, 'protocol': 'ht-run-diagnostics-v1', 'run_id': run.name, 'owner_id': 'test-owner'}
    (run / OWNER).write_text(json.dumps(owner))
    files = {p.name: {'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'raw_bytes': p.stat().st_size}
             for p in run.iterdir() if p.is_file() and not p.name.startswith('.')}
    (run / SEAL).write_text(json.dumps({**owner, 'sealed_at': NOW.isoformat(), 'files': files}))


class SealedArchiveTests(ArchiveFixture):
    def test_sealed_run_reclaims_measured_bytes_and_restores_without_losing_recovery(self):
        run = self.completed_run(files={'run.log': b'log', 'a.txt': b'payload\n' * 10000})
        seal_fixture(run)
        before_bytes = sum(p.stat().st_size for p in run.iterdir())
        plan = self.plan()[0]
        self.assertEqual(plan['ownership'], 'sealed')
        self.assertFalse(plan['originals_retained'])
        result = self.execute()[0]
        self.assertFalse((run / 'a.txt').exists())
        after_bytes = sum(p.stat().st_size for p in run.iterdir())
        self.assertEqual(result['reclaimed_bytes'], before_bytes - after_bytes)
        self.assertGreater(result['reclaimed_bytes'], 70000)
        self.assertEqual(result['raw_bytes_removed'], 80000)
        again = self.execute()[0]
        self.assertEqual(again['reason'], 'already_archived')
        recovery = snapshot(run)
        self.assertEqual(archive.restore_run(self.root, run.name)['status'], 'restored')
        self.assertEqual((run / 'a.txt').read_bytes(), b'payload\n' * 10000)
        for name, value in recovery.items(): self.assertEqual(snapshot(run)[name], value)

    def test_cli_reports_sealed_reclamation_instead_of_hardcoded_zero(self):
        import argparse
        import contextlib
        import io
        from orchestrator import cli
        run = self.completed_run(files={'a.txt': b'A' * 20000})
        seal_fixture(run)
        output = io.StringIO()
        args = argparse.Namespace(older_than_days=30, execute=True, json=True)
        with patch.object(cli, 'ROOT', self.root), patch.object(cli, 'archive_runs',
                side_effect=lambda *a, **kw: archive.archive_runs(*a, now=NOW, **kw)), contextlib.redirect_stdout(output):
            self.assertEqual(cli._archive_runs_command(args), 0)
        result = json.loads(output.getvalue())
        self.assertGreater(result['reclaimed_bytes'], 19000)
        self.assertFalse(result['originals_retained'])
        self.assertEqual(result['raw_bytes_removed'], 20000)

    def test_legacy_dry_run_explains_snapshot_only_without_claiming_reclamation(self):
        run = self.completed_run(files={'a.txt': b'raw'})
        entry = self.plan()[0]
        self.assertEqual(entry['ownership'], 'uncoordinated')
        self.assertEqual(entry['reason'], 'snapshot_only')
        self.assertIn('seal', entry['detail'])
        self.assertEqual(self.execute()[0]['reclaimed_bytes'], 0)
        self.assertEqual((run / 'a.txt').read_bytes(), b'raw')

    def test_partial_manifest_resumes_after_enospc_without_recompressing_first_file(self):
        run = self.completed_run(files={'a.txt': b'A' * 20000, 'b.txt': b'B' * 20000})
        seal_fixture(run)
        compress = archive.execute._compress_to_temp
        def full_on_second(src, dest):
            if src.name == 'b.txt': raise OSError(errno.ENOSPC, 'disk full')
            return compress(src, dest)
        with patch.object(archive.execute, '_compress_to_temp', full_on_second):
            self.assertEqual(self.execute()[0]['status'], 'partial')
        self.assertFalse((run / 'a.txt').exists())
        inode = (run / 'a.txt.gz').stat().st_ino
        self.assertTrue((run / 'b.txt').exists())
        self.assertEqual(self.execute()[0]['status'], 'archived')
        self.assertEqual((run / 'a.txt.gz').stat().st_ino, inode)
        self.assertFalse((run / 'b.txt').exists())
        self.assertEqual(set(archive.load_manifest(run)['files']), {'a.txt', 'b.txt'})
        self.assertEqual(archive.restore_run(self.root, run.name)['status'], 'restored')

    def test_crash_after_gzip_publication_adopts_verified_orphan_without_overwrite(self):
        run = self.completed_run(files={'a.txt': b'A' * 20000})
        seal_fixture(run)
        with patch.object(archive.execute, '_write_manifest', side_effect=OSError(errno.ENOSPC, 'disk full')):
            self.execute()
        self.assertTrue((run / 'a.txt').exists())
        inode = (run / 'a.txt.gz').stat().st_ino
        with patch.object(archive.execute, '_compress_to_temp', side_effect=AssertionError('must adopt, not recompress')):
            result = self.execute()[0]
        self.assertEqual(result['status'], 'archived')
        self.assertFalse((run / 'a.txt').exists())
        self.assertEqual((run / 'a.txt.gz').stat().st_ino, inode)

    def test_abrupt_process_exit_after_gzip_link_resumes_without_touching_crash_temp(self):
        import os
        import subprocess
        import sys
        from tests.test_archive import REPO
        run = self.completed_run(files={'a.txt': b'A' * 20000})
        seal_fixture(run)
        proc = subprocess.run([sys.executable, '-B', '-c', '''
import os, sys
from pathlib import Path
from orchestrator import archive
from tests.test_archive import NOW
archive.execute._write_manifest = lambda *a: os._exit(91)
archive.archive_runs(Path(sys.argv[1]), execute=True, now=NOW)
''', str(self.root)], cwd=REPO, env={**os.environ, 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual(proc.returncode, 91)
        self.assertTrue((run / 'a.txt').exists())
        stale = list(run.glob('.*.tmp'))
        self.assertTrue(stale, 'os._exit bypasses temporary-file cleanup')
        stale_before = {p: p.read_bytes() for p in stale}
        self.assertEqual(self.execute()[0]['status'], 'archived')
        self.assertFalse((run / 'a.txt').exists())
        for p, data in stale_before.items(): self.assertEqual(p.read_bytes(), data)
        self.assertEqual(archive.restore_run(self.root, run.name)['status'], 'restored')
        self.assertEqual((run / 'a.txt').read_bytes(), b'A' * 20000)

    def test_crash_after_manifest_before_unlink_resumes_incrementally(self):
        run = self.completed_run(files={'a.txt': b'A' * 20000})
        seal_fixture(run)
        real_unlink = archive.Path.unlink
        def interrupted(path, *args, **kwargs):
            if path.name == 'a.txt': raise OSError(errno.EIO, 'interrupted unlink')
            return real_unlink(path, *args, **kwargs)
        with patch.object(archive.Path, 'unlink', interrupted): self.execute()
        self.assertTrue((run / 'a.txt').exists())
        self.assertTrue(archive.load_manifest(run)['files'])
        self.assertEqual(self.execute()[0]['status'], 'archived')
        self.assertFalse((run / 'a.txt').exists())

    def test_managed_run_with_terminal_but_unclosed_writers_is_skipped(self):
        run = self.completed_run(files={'a.txt': b'pending writer'})
        seal_fixture(run)
        (run / SEAL).unlink()  # terminal telemetry acknowledged, but producer leases still open
        before = snapshot(run)
        entry = self.plan()[0]
        self.assertEqual((entry['status'], entry['reason']), ('skipped', 'writers_unsealed'))
        self.execute()
        self.assertEqual(snapshot(run), before)

    def test_invalid_or_mismatched_seal_never_authorizes_removal(self):
        run = self.completed_run(files={'a.txt': b'original'})
        seal_fixture(run)
        (run / 'a.txt').write_bytes(b'late writer')
        from tests.test_archive import set_age
        set_age(run / 'a.txt', 40)
        self.execute()
        self.assertEqual((run / 'a.txt').read_bytes(), b'late writer')
        (run / SEAL).write_text('{broken')
        before = snapshot(run)
        with self.assertRaises(ValueError): self.execute()
        self.assertEqual(snapshot(run), before)

    def test_unowned_file_in_sealed_directory_is_snapshot_only(self):
        run = self.completed_run(files={'a.txt': b'A' * 20000})
        seal_fixture(run)
        (run / 'outsider.txt').write_bytes(b'unowned')
        from tests.test_archive import set_age
        set_age(run / 'outsider.txt', 40)
        self.execute()
        self.assertEqual((run / 'outsider.txt').read_bytes(), b'unowned')

    def test_hardlinked_sealed_raw_has_uncertain_ownership_and_is_never_removed(self):
        import os
        run = self.completed_run(files={'a.txt': b'original'})
        seal_fixture(run)
        os.link(run / 'a.txt', self.root / 'external-writer.txt')
        self.execute()
        self.assertTrue((run / 'a.txt').exists())

    def test_mismatched_orphan_never_overwritten_or_used_to_unlink_raw(self):
        run = self.completed_run(files={'a.txt': b'original'})
        seal_fixture(run)
        (run / 'a.txt.gz').write_bytes(gzip.compress(b'other bytes'))
        before = snapshot(run)
        self.execute()
        self.assertEqual(snapshot(run), before)

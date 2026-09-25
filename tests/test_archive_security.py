"""Security regressions use only synthetic TemporaryDirectory state roots."""
import argparse
import gzip
import hashlib
import json
import os
import shutil
import stat
from pathlib import Path
from unittest.mock import patch

from orchestrator import archive, cli
from tests.test_archive import ArchiveFixture, NOW, set_age, snapshot


class ArchiveSecurityTests(ArchiveFixture):
    def legacy_archive(self):
        run = self.completed_run(files={'a.txt': b'original\n'})
        raw = run / 'a.txt'
        compressed = gzip.compress(raw.read_bytes())
        (run / 'a.txt.gz').write_bytes(compressed)
        info = {'archive': 'a.txt.gz', 'sha256': hashlib.sha256(raw.read_bytes()).hexdigest(),
                'raw_bytes': raw.stat().st_size, 'compressed_bytes': len(compressed),
                'mtime_ns': raw.stat().st_mtime_ns, 'archived_at': NOW.isoformat()}
        manifest = {'format_version': 1, 'run_id': run.name, 'terminal_outcome': {}, 'files': {'a.txt': info}}
        (run / archive.MANIFEST_FILE).write_text(json.dumps(manifest))
        raw.unlink()  # synthetic legacy archive, not the production archive protocol
        return run, manifest

    def save_manifest(self, run, manifest):
        (run / archive.MANIFEST_FILE).write_text(json.dumps(manifest))

    def assert_rejected_without_mutation(self, operation):
        before = snapshot(self.root)
        with self.assertRaises(ValueError):
            operation()
        self.assertEqual(snapshot(self.root), before)

    def test_manifest_archive_traversal_cannot_delete_authoritative_events(self):
        run, manifest = self.legacy_archive()
        info = manifest['files']['a.txt']
        # Existing matching raw used to bypass gzip verification, then unlink events.jsonl.
        (run / 'a.txt').write_bytes(b'original\n')
        info['archive'] = '../../events.jsonl'
        self.save_manifest(run, manifest)
        self.assert_rejected_without_mutation(lambda: archive.restore_run(self.root, run.name))

    def test_manifest_validated_in_full_before_restoring_first_entry(self):
        run, manifest = self.legacy_archive()
        info = manifest['files']['a.txt'].copy()
        for name, changes in [('../escape', {}), ('/absolute', {}), ('events.jsonl', {}),
                              ('run.log', {}), ('x\\y', {}), ('.hidden', {}),
                              ('z.txt', {'archive': '/etc/passwd'}),
                              ('z.txt', {'sha256': 'not-a-digest'}),
                              ('z.txt', {'raw_bytes': -1}), ('z.txt', {'mtime_ns': 'yesterday'}),
                              ('z.txt', {'compressed_bytes': True}), ('z.txt', {'archived_at': None})]:
            with self.subTest(name=name, changes=changes):
                manifest['files'] = {'a.txt': info, name: {**info, 'archive': name + '.gz', **changes}}
                self.save_manifest(run, manifest)
                self.assert_rejected_without_mutation(lambda: archive.restore_run(self.root, run.name))

    def test_manifest_symlinks_are_rejected_before_any_mutation(self):
        run, manifest = self.legacy_archive()
        for name in ('a.txt', 'a.txt.gz', archive.MANIFEST_FILE):
            with self.subTest(name=name):
                path = run / name
                original = path.read_bytes() if path.exists() else None
                if path.exists(): path.unlink()
                path.symlink_to(self.root / 'events.jsonl')
                self.assert_rejected_without_mutation(lambda: archive.restore_run(self.root, run.name))
                path.unlink()
                if original is not None: path.write_bytes(original)

    def test_symlinked_run_or_runs_directory_is_rejected_on_restore(self):
        run, _ = self.legacy_archive()
        for path in (run, self.runs):
            with self.subTest(path=path):
                moved = path.with_name(path.name + '-real')
                path.rename(moved); path.symlink_to(moved, target_is_directory=True)
                self.assert_rejected_without_mutation(lambda: archive.restore_run(self.root, run.name))
                path.unlink(); moved.rename(path)

    def test_invalid_manifest_is_not_absence_for_archive_or_restore(self):
        run = self.completed_run(files={'a.txt': b'original'})
        for data in (b'{broken', b'[]', b'{"format_version":99,"files":{}}',
                     b'{"format_version":1,"run_id":"wrong","files":{}}',
                     b'{"format_version":1,"run_id":"old-done","files":{},"files":{}}'):
            with self.subTest(data=data):
                (run / archive.MANIFEST_FILE).write_bytes(data)
                self.assert_rejected_without_mutation(self.execute)
                self.assert_rejected_without_mutation(lambda: archive.restore_run(self.root, run.name))

    def test_late_append_after_final_stat_is_preserved_in_original_inode(self):
        run = self.completed_run(files={'a.txt': b'original\n'})
        raw = run / 'a.txt'
        real = archive.execute._write_manifest
        with raw.open('ab', buffering=0) as writer:
            def publish_then_append(*args, **kwargs):
                result = real(*args, **kwargs)
                writer.write(b'late bytes\n')  # after final stat, before the old unlink
                return result
            with patch.object(archive.execute, '_write_manifest', publish_then_append):
                self.execute()
            writer.write(b'even later bytes\n')
            self.assertTrue(raw.exists(), 'an open writer must not be orphaned by unlink/rename')
            self.assertEqual(raw.stat().st_ino, os.fstat(writer.fileno()).st_ino)
        self.assertEqual(raw.read_bytes(), b'original\nlate bytes\neven later bytes\n')

    def test_late_append_after_final_stat_of_existing_snapshot_keeps_original(self):
        run, _ = self.legacy_archive()
        raw = run / 'a.txt'; raw.write_bytes(b'original\n'); set_age(raw, 40)
        real_digest = archive.execute._decompressed_digest
        real_stat = Path.stat
        ready = False
        def verified(*args):
            nonlocal ready
            result = real_digest(*args)
            ready = True
            return result
        def stat_then_append(path, *args, **kwargs):
            nonlocal ready
            result = real_stat(path, *args, **kwargs)
            if path == raw and ready:
                ready = False
                with raw.open('ab') as writer: writer.write(b'late append\n')
            return result
        with patch.object(archive.execute, '_decompressed_digest', verified), patch.object(Path, 'stat', stat_then_append):
            self.execute()
        self.assertTrue(raw.exists(), 'existing snapshots must not authorize unlink of a live original')
        self.assertEqual(raw.read_bytes(), b'original\nlate append\n')

    def test_restore_never_overwrites_writer_creating_raw_after_initial_check(self):
        run, _ = self.legacy_archive()
        real = archive.restore._decompress_to_temp
        def create_raw(*args):
            result = real(*args)
            (run / 'a.txt').write_bytes(b'new writer bytes\n')
            return result
        before_archive = (run / 'a.txt.gz').read_bytes()
        before_manifest = (run / archive.MANIFEST_FILE).read_bytes()
        with patch.object(archive.restore, '_decompress_to_temp', create_raw):
            result = archive.restore_run(self.root, run.name)
        self.assertEqual((run / 'a.txt').read_bytes(), b'new writer bytes\n')
        self.assertTrue(result['errors'])
        self.assertEqual((run / 'a.txt.gz').read_bytes(), before_archive)
        self.assertEqual((run / archive.MANIFEST_FILE).read_bytes(), before_manifest)

    def test_manifest_created_during_publish_is_never_overwritten(self):
        run = self.completed_run(files={'a.txt': b'original'})
        real = archive.execute._write_manifest
        def competing_manifest(*args):
            (run / archive.MANIFEST_FILE).write_bytes(b'unique recovery metadata')
            return real(*args)
        with patch.object(archive.execute, '_write_manifest', competing_manifest):
            result = self.execute()
        self.assertEqual((run / archive.MANIFEST_FILE).read_bytes(), b'unique recovery metadata')
        self.assertEqual((run / 'a.txt').read_bytes(), b'original')
        self.assertNotEqual(result[0]['status'], 'archived')

    def test_restore_keeps_recovery_copies_even_if_raw_is_modified_later(self):
        run, _ = self.legacy_archive()
        before = snapshot(run)
        result = archive.restore_run(self.root, run.name)
        self.assertEqual(result['status'], 'restored')
        (run / 'a.txt').write_bytes(b'new content')
        for name, value in before.items():
            self.assertEqual(snapshot(run).get(name), value)

    def test_archive_publish_does_not_clobber_late_destination(self):
        run = self.completed_run(files={'a.txt': b'original'})
        real = archive.execute._decompressed_digest
        def competing_archive(*args):
            result = real(*args)
            (run / 'a.txt.gz').write_bytes(b'late recovery archive')
            return result
        with patch.object(archive.execute, '_decompressed_digest', competing_archive):
            self.execute()
        self.assertEqual((run / 'a.txt.gz').read_bytes(), b'late recovery archive')
        self.assertEqual((run / 'a.txt').read_bytes(), b'original')

    def test_orphan_archive_is_never_overwritten(self):
        run = self.completed_run(files={'a.txt': b'original'})
        orphan = run / 'a.txt.gz'; orphan.write_bytes(b'unique recovery bytes')
        before = snapshot(run)
        self.execute()
        self.assertEqual(snapshot(run), before)

    def test_preexisting_temp_pattern_is_not_proof_of_ownership(self):
        run = self.completed_run(files={'a.txt': b'original'})
        paths = [run / '.a.txt.gz.0123456789abcdef.tmp', run / '.events.jsonl.0123456789abcdef.tmp']
        for path in paths: path.write_bytes(b'unique unrelated bytes')
        self.execute()
        for path in paths:
            self.assertTrue(path.exists())
            self.assertEqual(path.read_bytes(), b'unique unrelated bytes')

    def test_private_permissions_hold_during_compress_and_restore(self):
        run = self.completed_run(files={'a.txt': b'secret'})
        raw = run / 'a.txt'; raw.chmod(0o600)
        compress = archive.execute._compress_to_temp
        decompress = archive.restore._decompress_to_temp
        def check_temp(fn):
            def checked(*args):
                result = fn(*args)
                self.assertEqual(stat.S_IMODE(result[0].stat().st_mode), 0o600)
                return result
            return checked
        old_umask = os.umask(0o022)
        try:
            with patch.object(archive.execute, '_compress_to_temp', check_temp(compress)):
                self.execute()
            self.assertEqual(stat.S_IMODE((run / 'a.txt.gz').stat().st_mode), 0o600)
            raw.unlink()  # emulate an old-format archive whose original has gone
            with patch.object(archive.restore, '_decompress_to_temp', check_temp(decompress)):
                archive.restore_run(self.root, run.name)
            self.assertEqual(stat.S_IMODE(raw.stat().st_mode), 0o600)
        finally:
            os.umask(old_umask)

    def test_cli_low_disk_and_modified_eligible_file_return_nonzero(self):
        run = self.completed_run(files={'a.txt': b'original'})
        args = argparse.Namespace(older_than_days=30, execute=True, json=True)
        real = archive.execute._compress_to_temp
        def append(*a):
            result = real(*a)
            with (run / 'a.txt').open('ab') as f: f.write(b'late')
            return result
        for hook in (patch.object(archive.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(10, 10, 0)),
                     patch.object(archive.execute, '_compress_to_temp', append)):
            set_age(run / 'a.txt', 40)
            with hook, patch.object(cli, 'ROOT', self.root), patch.object(cli, 'archive_runs',
                    side_effect=lambda *a, **k: archive.archive_runs(*a, now=NOW, **k)):
                self.assertNotEqual(cli._archive_runs_command(args), 0)

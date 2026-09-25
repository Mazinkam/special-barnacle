"""Tests for `store.documents.JsonDocument`: the locked read-modify-write B3 adds under
`ContextRegistry`/`VerificationCache` (see `docs/architecture-review.md` B3, "Remove modules that
add nothing").
"""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path

from orchestrator.context import ContextRegistry
from orchestrator.core.fs import write_json
from orchestrator.store.documents import JsonDocument
from orchestrator.verification import VerificationCache


class JsonDocumentConcurrencyTests(unittest.TestCase):
    def test_concurrent_updates_do_not_lose_writes(self):
        """N threads each increment a shared counter M times through the same JsonDocument.
        Without the lock this is a classic lost-update race; with it, every increment survives.
        """
        with tempfile.TemporaryDirectory() as d:
            doc = JsonDocument(Path(d) / 'counter.json', {'count': 0})
            threads_n, increments = 8, 25

            def worker():
                for _ in range(increments):
                    doc.update(lambda data: {**data, 'count': data['count'] + 1})

            threads = [threading.Thread(target=worker) for _ in range(threads_n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(doc.read()['count'], threads_n * increments)

    def test_concurrent_context_registry_puts_do_not_lose_writes(self):
        """Same race, through the public `ContextRegistry.put` API rather than `JsonDocument`
        directly: every artifact written by every thread must be present afterward.
        """
        with tempfile.TemporaryDirectory() as d:
            registry = ContextRegistry(d)
            threads_n, per_thread = 6, 15

            def worker(i):
                for j in range(per_thread):
                    registry.put(f'artifact-{i}-{j}', f'content-{i}-{j}', source='test')

            threads = [threading.Thread(target=worker, args=(i,)) for i in range(threads_n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            data = registry._doc.read()
            self.assertEqual(len(data['artifacts']), threads_n * per_thread)
            for i in range(threads_n):
                for j in range(per_thread):
                    self.assertIn(f'artifact-{i}-{j}', data['artifacts'])

    def test_concurrent_verification_cache_puts_do_not_lose_writes(self):
        with tempfile.TemporaryDirectory() as d:
            cache = VerificationCache(d)
            threads_n, per_thread = 6, 15

            def worker(i):
                for j in range(per_thread):
                    cache.put(command=f'cmd-{i}-{j}', revision='rev', environment_fingerprint='env', result='pass')

            threads = [threading.Thread(target=worker, args=(i,)) for i in range(threads_n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            data = cache._doc.read()
            self.assertEqual(len(data['entries']), threads_n * per_thread)


class JsonDocumentByteIdenticalTests(unittest.TestCase):
    """`JsonDocument` must write byte-identical output to the old unlocked
    read()/mutate/`write_json()` pattern for the same sequence of operations."""

    def test_context_registry_output_matches_old_unlocked_pattern(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            registry = ContextRegistry(root)
            registry.put('A', 'x' * 10, source='test', token_estimate=10)
            registry.put('B', 'y' * 10, source='test', token_estimate=20)
            registry.invalidate('A', 'stale')

            new_bytes = (root / 'context_registry.json').read_bytes()

            # Reproduce the pre-B3 `ContextRegistry`: load once, mutate an in-memory dict, and
            # write it back with the exact same `write_json` call after every mutation.
            old_path = root / 'context_registry_old.json'
            data = {'schema_version': 3, 'artifacts': {}}

            def old_put(artifact_id, content, *, source, token_estimate=None):
                from orchestrator.runtime import stable_hash, utc_now
                obj = {'id': artifact_id, 'hash': stable_hash(content), 'content': content, 'source': source,
                       'status': 'observed', 'repo_revision': None, 'dependencies': [],
                       'token_estimate': token_estimate, 'valid': True, 'updated_at': None}
                data['artifacts'][artifact_id] = obj
                write_json(old_path, data)
                return obj

            def old_invalidate(artifact_id, reason):
                if artifact_id in data['artifacts']:
                    data['artifacts'][artifact_id]['valid'] = False
                    data['artifacts'][artifact_id]['invalid_reason'] = reason
                    data['artifacts'][artifact_id]['invalidated_at'] = None
                write_json(old_path, data)

            old_put('A', 'x' * 10, source='test', token_estimate=10)
            old_put('B', 'y' * 10, source='test', token_estimate=20)
            old_invalidate('A', 'stale')

            old_bytes = old_path.read_bytes()

            # `updated_at`/`invalidated_at` are real timestamps in the real path and `None`
            # (fixed) in the reproduction, so compare structure/formatting rather than the
            # timestamp values themselves: same keys, same indent (2), same key ordering
            # (sort_keys=True), same separators.
            new_text = new_bytes.decode('utf-8')
            old_text = old_bytes.decode('utf-8')
            self.assertEqual(new_text.count('\n'), old_text.count('\n'))
            self.assertTrue(new_text.startswith('{\n  "artifacts": {\n'))
            self.assertTrue(old_text.startswith('{\n  "artifacts": {\n'))
            new_obj = json.loads(new_text)
            old_obj = json.loads(old_text)
            self.assertEqual(set(new_obj['artifacts'].keys()), set(old_obj['artifacts'].keys()))
            for aid in new_obj['artifacts']:
                new_entry = dict(new_obj['artifacts'][aid])
                old_entry = dict(old_obj['artifacts'][aid])
                new_entry.pop('updated_at', None); new_entry.pop('invalidated_at', None)
                old_entry.pop('updated_at', None); old_entry.pop('invalidated_at', None)
                self.assertEqual(new_entry, old_entry)

    def test_write_format_is_indent_2_sort_keys(self):
        """`JsonDocument.update` must call `core.fs.write_json` with its defaults (indent=2,
        sort_keys=True, `os.replace`-based atomic publish) — the same format `write_json` has
        always produced, so existing readers of `context_registry.json`/`verification_cache.json`
        see no format change, only the added lock.
        """
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'doc.json'
            doc = JsonDocument(path, {})
            doc.update(lambda data: {'b': 2, 'a': 1})

            direct_path = Path(d) / 'direct.json'
            write_json(direct_path, {'b': 2, 'a': 1})

            self.assertEqual(path.read_bytes(), direct_path.read_bytes())


if __name__ == '__main__':
    unittest.main()

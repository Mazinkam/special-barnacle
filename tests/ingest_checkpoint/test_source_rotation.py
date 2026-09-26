"""B5: rotation, rewrite and truncation of the source log while its checkpoint is stale
(was ``SourceChangeTests``, ``SameSizeRewriteTests``, ``RotationDuringReadTests`` and
``RewrittenSourceTests``)."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

from orchestrator import ingest_checkpoint
from orchestrator.ingest import CALL, SESSION, ingest_file
from orchestrator.runtime import EventStore

from tests.ingest_checkpoint.helpers import (
    CheckpointTestCase, aggregate_row, append, ht_call, ht_session, ingest_rows, recorded_input_tokens, snapshot,
)
from tests.test_ingest import codex_log

class SourceChangeTests(CheckpointTestCase):
    def test_rotation_to_a_new_session_at_the_same_path_is_read_from_the_start(self):
        log = ht_session(self.dir / 'session.jsonl', 4, session='sess-old')
        self.one(log)
        replacement = ht_session(self.dir / 'incoming.jsonl', 2, session='sess-new', tokens=10)
        os.replace(replacement, log)  # new inode at the same path
        rotated = self.one(log)
        self.assertEqual(rotated['emitted'], 1)
        self.assertFalse(rotated['resumed'])
        self.assertEqual(rotated['scanned_from'], 0)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-old'), 4000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-new'), 20)
        self.assertEqual(self.checkpoint(log)['offset'], log.stat().st_size)

    def test_explicit_same_session_rotation_deduplicates_without_checkpoint(self):
        for first in (CALL, SESSION):
            for second in (CALL, SESSION):
                with self.subTest(first=first, second=second):
                    name = f'{first}-{second}'
                    self.root = self.dir / f'state-{name}'
                    log = ht_session(self.dir / f'{name}.jsonl', 1)
                    initial = self.one(log, first)
                    checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                    checkpoint.unlink()
                    old_inode = log.stat().st_ino
                    os.replace(ht_session(self.dir / 'incoming.jsonl', 2), log)
                    self.assertNotEqual(log.stat().st_ino, old_inode)
                    result = self.one(log, second)
                    self.assertEqual(result['emitted'], 1)
                    self.assertEqual(result['estimated_cost_usd'], initial['estimated_cost_usd'])
                    self.assertEqual(recorded_input_tokens(self.root), 2000)
                    checkpoint.unlink()
                    self.assertEqual(self.one(log, second)['emitted'], 0)

    def test_rewrite_of_the_same_session_with_extra_calls_counts_each_token_once(self):
        log = ht_session(self.dir / 'session.jsonl', 4)
        self.one(log)
        rewritten = ht_session(self.dir / 'rewritten.jsonl', 6)  # same session id, same first 4 calls, 2 new
        os.replace(rewritten, log)
        result = self.one(log)
        self.assertEqual(result['emitted'], 1)
        self.assertEqual(recorded_input_tokens(self.root), 6000)
        per_call = ht_session(self.dir / 'pc.jsonl', 4, session='sess-c')
        self.one(per_call, CALL)
        os.replace(ht_session(self.dir / 'pc2.jsonl', 6, session='sess-c'), per_call)
        grown = self.one(per_call, CALL)
        self.assertEqual((grown['emitted'], grown['duplicates']), (2, 4))

    def test_truncation_falls_back_to_a_full_read_and_never_double_counts(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        ckpt_before = self.checkpoint(log)
        ht_session(log, 1)  # same inode, shorter: the harness rewrote it
        after = self.one(log)
        self.assertEqual(after['emitted'], 0)
        self.assertFalse(after['resumed'])
        self.assertEqual(recorded_input_tokens(self.root), 3000)
        self.assertLess(self.checkpoint(log)['offset'], ckpt_before['offset'])
        # regrowth past the old offset with different content is not mistaken for a resume, and the two
        # new calls are counted in full: the vanished calls were real usage and cannot be un-recorded
        append(log, ht_call(7, tokens=2500) + ht_call(8, tokens=2500))
        regrown = self.one(log)
        self.assertEqual(recorded_input_tokens(self.root), 8000, '1000+1000+1000 recorded before, 2500+2500 new; nothing subtracted')
        self.assertEqual(regrown['emitted'], 1)
        self.assertEqual(ingest_rows(self.root)[-1]['covers_calls'], 2)
        pc = ht_session(self.dir / 'pc.jsonl', 3, session='sess-c')
        self.one(pc, CALL)
        ht_session(pc, 1, session='sess-c')
        append(pc, ht_call(10) + ht_call(11))
        result = self.one(pc, CALL)
        self.assertEqual((result['emitted'], result['duplicates']), (2, 1))
        ids = [r['call_id'] for r in ingest_rows(self.root) if r['session_id'] == 'sess-c']
        self.assertEqual(len(ids), len(set(ids)), 'no per-call row was written twice')

    def test_partial_last_line_is_neither_counted_nor_checkpointed_until_complete(self):
        log = ht_session(self.dir / 'session.jsonl', 2)
        complete_size = log.stat().st_size
        torn = ht_call(2, tokens=5000)
        append(log, torn[: len(torn) // 2])
        first = self.one(log, CALL)
        self.assertEqual(first['emitted'], 2)
        self.assertEqual(self.checkpoint(log)['offset'], complete_size)
        append(log, torn[len(torn) // 2:])
        second = self.one(log, CALL)
        self.assertEqual((second['emitted'], second['duplicates']), (1, 2))
        self.assertEqual(second['scanned_from'], complete_size)
        self.assertEqual(recorded_input_tokens(self.root), 2000 + 5000)
        self.assertEqual(self.checkpoint(log)['offset'], log.stat().st_size)
        # a complete object missing only its newline is an in-progress write as well
        append(log, ht_call(3).rstrip('\n'))
        third = self.one(log, CALL)
        self.assertEqual(third['emitted'], 0)
        append(log, '\n')
        self.assertEqual(self.one(log, CALL)['emitted'], 1)
        self.assertEqual(len(ingest_rows(self.root)), 4)

    def test_codex_reader_resumes_with_its_turn_model_context(self):
        log = codex_log(self.dir / 'rollout.jsonl')
        first = self.one(log, CALL, runtime=None)
        self.assertEqual(first['emitted'], 2)
        append(log, json.dumps({'timestamp': '2026-09-20T05:00:04.000Z', 'ordinal': 4, 'type': 'token_usage_record',
                                'payload': {'session_id': 'sess-c', 'turn_id': 'turn-1', 'response_id': 'resp-3',
                                            'usage': {'input_tokens': 500, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                                                      'output_tokens': 25, 'total_tokens': 525}}}) + '\n')
        second = self.one(log, CALL, runtime=None)
        self.assertEqual(second['emitted'], 1)
        self.assertTrue(second['resumed'])
        row = ingest_rows(self.root)[-1]
        self.assertEqual(row['model'], 'gpt-6-astra', 'turn_context before the checkpoint still names the model')
        self.assertEqual(row['repository'], '/work/forge')
        self.assertEqual(row['provider'], 'openai')


class SameSizeRewriteTests(CheckpointTestCase):
    """Finding 4: an in-place rewrite that keeps the size and the last line is still a rewrite."""

    def _rewrite_header(self, log: Path, old: bytes, new: bytes) -> None:
        data = log.read_bytes()
        rewritten = data.replace(old, new, 1)
        self.assertEqual(len(rewritten), len(data))
        self.assertNotEqual(rewritten, data)
        stat = log.stat()
        with log.open('r+b') as handle:  # same inode, same size
            handle.write(rewritten)
        os.utime(log, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))  # coarse-mtime filesystems

    def test_same_size_header_rewrite_is_read_from_the_start(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        self._rewrite_header(log, b'"id": "sess-1"', b'"id": "sess-2"')
        result = self.one(log)
        self.assertFalse(result['resumed'], result)
        self.assertEqual(result['scanned_from'], 0)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-2'), 3000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-1'), 3000, 'recorded usage is never un-recorded')
        # per call: the rewritten header changes which session every call belongs to
        pc = ht_session(self.dir / 'pc.jsonl', 2, session='sess-c')
        self.one(pc, CALL)
        self._rewrite_header(pc, b'"id": "sess-c"', b'"id": "sess-d"')
        result = self.one(pc, CALL)
        self.assertFalse(result['resumed'])
        self.assertEqual(result['emitted'], 2)
        self.assertEqual(sorted({r['session_id'] for r in ingest_rows(self.root) if r['granularity'] == CALL}), ['sess-c', 'sess-d'])
        # a header rewrite combined with growth is caught by the head fingerprint
        grown = ht_session(self.dir / 'grown.jsonl', 2, session='sess-g')
        self.one(grown)
        self._rewrite_header(grown, b'"id": "sess-g"', b'"id": "sess-h"')
        append(grown, ht_call(2, tokens=10))
        result = self.one(grown)
        self.assertFalse(result['resumed'])
        self.assertEqual(recorded_input_tokens(self.root, 'sess-h'), 2010)


class RotationDuringReadTests(CheckpointTestCase):
    """Finding 5: verify, read and fingerprint one open file, never the path three times."""

    def test_initial_metrics_bind_the_scanned_inode_not_the_replacement_path(self):
        from orchestrator import ingest as ingest_module
        from orchestrator.ingest import service as ingest_service_module

        for granularity in (CALL, SESSION):
            with self.subTest(granularity=granularity):
                self.root = self.dir / f'state-{granularity}'
                log = self.dir / f'{granularity}_sessA.jsonl'
                log.write_text(ht_call(0), encoding='utf-8')
                identity = [log.stat().st_dev, log.stat().st_ino]
                replacement = ht_session(self.dir / 'incoming.jsonl', 2, session='sess-B')
                real_read = ingest_module.read_calls

                def rotate_then_read(*args, replacement=replacement, log=log, real_read=real_read, **kwargs):
                    os.replace(replacement, log)
                    return real_read(*args, **kwargs)

                with patch.object(ingest_service_module, 'read_calls', rotate_then_read):
                    self.one(log, granularity)
                self.assertEqual(recorded_input_tokens(self.root, 'sessA'), 1000)
                self.assertEqual(ingest_rows(self.root)[0].get('source_identity'), identity)
                self.assertNotEqual([log.stat().st_dev, log.stat().st_ino], identity)
                ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                self.one(log, granularity)
                self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 2000)
                self.assertEqual(self.one(log, granularity)['emitted'], 0)

    def test_rotation_between_verify_and_read_neither_binds_the_wrong_session_nor_duplicates(self):
        from orchestrator import ingest as ingest_module
        from orchestrator.ingest import service as ingest_service_module
        log = ht_session(self.dir / 'session.jsonl', 3, session='sess-old')
        self.one(log)
        append(log, ht_call(3))  # a genuine last call of the old session
        # same header length, same line lengths: the old offset lands on a line boundary of the new file
        replacement = ht_session(self.dir / 'incoming.jsonl', 5, session='sess-new')
        real_read_calls = ingest_module.read_calls

        def rotate_then_read(*args, **kwargs):
            if replacement.exists():
                os.replace(replacement, log)
            return real_read_calls(*args, **kwargs)

        with patch.object(ingest_service_module, 'read_calls', rotate_then_read):
            first = self.one(log)
        self.assertEqual(first['emitted'], 1)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-old'), 4000, 'only the old file was read')
        self.assertEqual(recorded_input_tokens(self.root, 'sess-new'), 0)
        second = self.one(log)
        self.assertFalse(second['resumed'])
        self.assertEqual(second['emitted'], 1)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-new'), 5000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-old'), 4000)
        self.assertEqual(self.one(log)['emitted'], 0)

    def test_in_place_rewrite_while_reading_is_rejected_before_any_write(self):
        from orchestrator import ingest as ingest_module
        from orchestrator.ingest import service as ingest_service_module
        log = ht_session(self.dir / 'session.jsonl', 3)
        real_read_calls = ingest_module.read_calls

        def rewrite_then_read(*args, **kwargs):
            result = real_read_calls(*args, **kwargs)
            stat = log.stat()
            with log.open('r+b') as handle:
                handle.write(log.read_bytes().replace(b'"id": "sess-1"', b'"id": "sess-9"', 1))
            os.utime(log, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))
            return result

        with patch.object(ingest_service_module, 'read_calls', rewrite_then_read):
            result = self.ingest(log)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertIn('while it was being read', result['failures'][0]['error'])
        self.assertEqual(ingest_rows(self.root), [])
        self.assertIsNone(self.checkpoint(log))
        self.assertEqual(self.one(log)['emitted'], 1)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-9'), 3000)


class RewrittenSourceTests(CheckpointTestCase):
    """Finding 3: a truncated log that keeps A and gains D/E owes D+E, never (A+D+E) - (A+B+C)."""

    def test_truncated_source_with_new_calls_charges_the_new_calls_in_full(self):
        log = ht_session(self.dir / 'session.jsonl', 3)  # A B C, 1000 each
        self.one(log)
        ht_session(log, 1)  # A retained, same inode
        append(log, ht_call(7, tokens=200) + ht_call(8, tokens=300))  # D E, smaller than B + C
        result = self.one(log)
        self.assertFalse(result['resumed'])
        self.assertEqual(result['emitted'], 1)
        row = ingest_rows(self.root)[-1]
        self.assertEqual((row['input_tokens'], row['covers_calls']), (500, 2))
        self.assertEqual(recorded_input_tokens(self.root), 3500)
        # a later plain append resumes and still owes exactly the appended call
        append(log, ht_call(9, tokens=40))
        grown = self.one(log)
        self.assertTrue(grown['resumed'])
        self.assertEqual(ingest_rows(self.root)[-1]['input_tokens'], 40)
        self.assertEqual(recorded_input_tokens(self.root), 3540)
        # per call: the retained call is a duplicate, the new ones are rows
        pc = ht_session(self.dir / 'pc.jsonl', 3, session='sess-c')
        self.one(pc, CALL)
        ht_session(pc, 1, session='sess-c')
        append(pc, ht_call(7, tokens=200) + ht_call(8, tokens=300))
        result = self.one(pc, CALL)
        self.assertEqual((result['emitted'], result['duplicates']), (2, 1))
        self.assertEqual(recorded_input_tokens(self.root, 'sess-c'), 3500)

    def test_recorded_usage_the_log_no_longer_contains_is_rejected_before_any_write(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        EventStore(self.root).metric(**aggregate_row('sess-1', covers=3, input_tokens=3000))  # legacy totals, no identity evidence
        ht_session(log, 1)
        append(log, ht_call(7, tokens=200))
        before = snapshot(self.root)
        result = self.ingest(log)
        self.assertEqual(result['emitted'], 0)
        self.assertEqual(len(result['failures']), 1, result)
        error = result['failures'][0]['error']
        self.assertIn('sess-1', error)
        self.assertIn('3 calls', error)
        self.assertIn('truncated or rewritten', error)
        self.assertEqual(snapshot(self.root), before, 'nothing was written')
        with self.assertRaises(ValueError):
            ingest_file(log, state_root=self.root, granularity=SESSION, runtime='humain-terminal')

    def test_rewrite_plus_rows_from_another_ingester_is_rejected_as_ambiguous(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        EventStore(self.root).metric(**aggregate_row('sess-1', covers=1, input_tokens=200))  # someone recorded a call we never saw
        ht_session(log, 1)
        append(log, ht_call(7, tokens=200) + ht_call(8, tokens=300))
        before = snapshot(self.root)
        result = self.ingest(log)
        self.assertEqual(result['emitted'], 0)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertIn('sess-1', result['failures'][0]['error'])
        self.assertEqual(snapshot(self.root), before)
        # a rotation to a different session is not ambiguous: the foreign rows belong to the old session
        os.replace(ht_session(self.dir / 'new.jsonl', 2, session='sess-new', tokens=10), log)
        rotated = self.one(log)
        self.assertEqual(rotated['emitted'], 1)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-new'), 20)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-1'), 3200)

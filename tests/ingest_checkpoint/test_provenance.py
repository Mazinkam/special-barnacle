"""B5: provenance/identity binding across rotation, promotion and fallback sessions
(was ``SessionProvenanceTests``)."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from orchestrator import ingest_checkpoint
from orchestrator.ingest import CALL, SESSION
from orchestrator.ingest import checkpoint as ingest_checkpoint_impl
from orchestrator.record_batch import write_batch, settle_streams
from orchestrator.runtime import load_jsonl

from tests.ingest_checkpoint.helpers import (
    CheckpointTestCase, append, ht_call, ht_session, ingest_rows, recorded_input_tokens, snapshot,
)

class SessionProvenanceTests(CheckpointTestCase):
    def test_rotated_live_fallback_identity_fails_before_paid_id_comparison(self):
        for reused_tokens in (1000, 5000):
            for checkpoint_state in ('present', 'missing', 'corrupt'):
                for first in (CALL, SESSION):
                    for second in (CALL, SESSION):
                        with self.subTest(tokens=reused_tokens, checkpoint=checkpoint_state, first=first, second=second):
                            name = f'{reused_tokens}-{checkpoint_state}-{first}-{second}'
                            self.root = self.dir / f'state-{name}'
                            log = self.dir / f'{name}_sessA.jsonl'
                            log.write_text(ht_call(0), encoding='utf-8')
                            self.one(log, first)
                            checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                            if checkpoint_state == 'missing':
                                checkpoint.unlink()
                            elif checkpoint_state == 'corrupt':
                                checkpoint.write_text('not json', encoding='utf-8')
                            old_inode = log.stat().st_ino
                            replacement = self.dir / 'incoming.jsonl'
                            replacement.write_text(ht_call(0, tokens=reused_tokens) + ht_call(1), encoding='utf-8')
                            os.replace(replacement, log)
                            self.assertNotEqual(log.stat().st_ino, old_inode)
                            before = snapshot(self.root)
                            for dry_run in (True, False):
                                result = self.ingest(log, second, dry_run=dry_run)
                                self.assertEqual(len(result['failures']), 1, result)
                                self.assertIn('SourceConflict', result['failures'][0]['error'])
                                self.assertIn('generation', result['failures'][0]['error'])
                                self.assertEqual(result['emitted'], 0)
                                self.assertEqual(snapshot(self.root), before,
                                                 'do not suppress the reused call and bill only asst-1')

    def test_live_fallback_with_missing_or_mixed_generations_fails_closed(self):
        for generation in ('missing', 'mixed'):
            for checkpoint_state in ('present', 'missing', 'corrupt'):
                for first in (CALL, SESSION):
                    for second in (CALL, SESSION):
                        with self.subTest(generation=generation, checkpoint=checkpoint_state, first=first, second=second):
                            name = f'{generation}-{checkpoint_state}-{first}-{second}'
                            self.root = self.dir / f'state-{name}'
                            log = self.dir / f'{name}_sessA.jsonl'
                            log.write_text(ht_call(0), encoding='utf-8')
                            self.one(log, first)
                            append(log, ht_call(1))
                            self.one(log, first)
                            rows = ingest_rows(self.root)
                            if generation == 'missing':
                                for row in rows:
                                    row.pop('source_identity')
                            else:
                                # One row matches the current inode, but cannot vouch
                                # for the generation of the other paid call.
                                rows[0]['source_identity'][1] += 1
                            (self.root / 'metrics.jsonl').write_text(
                                ''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
                            checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                            if checkpoint_state == 'missing':
                                checkpoint.unlink()
                            elif checkpoint_state == 'corrupt':
                                checkpoint.write_text('not json', encoding='utf-8')
                            log.write_text('\n' + ht_call(0) + ht_call(1) + ht_call(2, tokens=5000), encoding='utf-8')
                            settle_streams(self.root)
                            before = snapshot(self.root)
                            for dry_run in (True, False):
                                result = self.ingest(log, second, dry_run=dry_run)
                                self.assertEqual(len(result['failures']), 1, result)
                                self.assertIn('SourceConflict', result['failures'][0]['error'])
                                self.assertIn('generation', result['failures'][0]['error'])
                                self.assertEqual(result['emitted'], 0)
                                self.assertEqual(snapshot(self.root), before)

    def test_same_inode_fallback_rewrite_deduplicates_and_bills_new_usage_in_full(self):
        for checkpoint_state in ('present', 'missing', 'corrupt'):
            for first in (CALL, SESSION):
                for second in (CALL, SESSION):
                    with self.subTest(checkpoint=checkpoint_state, first=first, second=second):
                        name = f'{checkpoint_state}-{first}-{second}'
                        self.root = self.dir / f'state-{name}'
                        log = self.dir / f'{name}_sessA.jsonl'
                        log.write_text(ht_call(0), encoding='utf-8')
                        self.one(log, first)
                        checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                        if checkpoint_state == 'missing':
                            checkpoint.unlink()
                        elif checkpoint_state == 'corrupt':
                            checkpoint.write_text('not json', encoding='utf-8')
                        old_inode = log.stat().st_ino
                        # Change the prefix, not the old call's usage: this must fully
                        # re-read and reconcile rather than take the append fast path.
                        log.write_text('\n' + ht_call(0) + ht_call(1, tokens=5000), encoding='utf-8')
                        self.assertEqual(log.stat().st_ino, old_inode)
                        before = snapshot(self.root)
                        preview = self.one(log, second, dry_run=True)
                        self.assertEqual(snapshot(self.root), before)
                        result = self.one(log, second)
                        self.assertFalse(result['resumed'])
                        self.assertEqual((preview['emitted'], result['emitted']), (1, 1))
                        self.assertEqual(preview['estimated_cost_usd'], result['estimated_cost_usd'])
                        self.assertGreater(result['estimated_cost_usd'], 0)
                        self.assertEqual(recorded_input_tokens(self.root, 'sessA'), 6000)
                        self.assertEqual(ingest_rows(self.root)[-1]['input_tokens'], 5000)
                        checkpoint.unlink()
                        self.assertEqual(self.one(log, second)['emitted'], 0)
                        self.assertEqual(recorded_input_tokens(self.root, 'sessA'), 6000)

    def test_rotated_live_promotion_identity_fails_before_paid_id_comparison(self):
        for promoted in (False, True):
            for checkpoint_state in ('present', 'missing', 'corrupt'):
                for first in (CALL, SESSION):
                    for second in (CALL, SESSION):
                        with self.subTest(promoted=promoted, checkpoint=checkpoint_state, first=first, second=second):
                            name = f'{promoted}-{checkpoint_state}-{first}-{second}'
                            self.root = self.dir / f'state-{name}'
                            log = self.dir / f'{name}_sessA.jsonl'
                            log.write_text(ht_call(0), encoding='utf-8')
                            self.one(log, first)
                            target = 'sess-B' if promoted else 'sessA'
                            if promoted:
                                ht_session(log, 2, session=target)
                                self.one(log, first)
                                self.assertEqual(recorded_input_tokens(self.root, target), 1000)
                            checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                            if checkpoint_state == 'missing':
                                checkpoint.unlink()
                            elif checkpoint_state == 'corrupt':
                                checkpoint.write_text('not json', encoding='utf-8')
                            old_inode = log.stat().st_ino
                            os.replace(ht_session(self.dir / 'incoming.jsonl', 3, session=target), log)
                            self.assertNotEqual(log.stat().st_ino, old_inode)
                            before = snapshot(self.root)
                            for dry_run in (True, False):
                                result = self.ingest(log, second, dry_run=dry_run)
                                self.assertEqual(len(result['failures']), 1, result)
                                self.assertIn('SourceConflict', result['failures'][0]['error'])
                                self.assertIn('generation', result['failures'][0]['error'])
                                self.assertEqual(snapshot(self.root), before)

    def test_live_promoted_target_with_missing_metric_generation_uses_durable_binding(self):
        for first in (CALL, SESSION):
            for second in (CALL, SESSION):
                with self.subTest(first=first, second=second):
                    name = f'{first}-{second}'
                    self.root = self.dir / f'state-{name}'
                    log = self.dir / f'{name}_sessA.jsonl'
                    log.write_text(ht_call(0), encoding='utf-8')
                    self.one(log, first)
                    ht_session(log, 2, session='sess-B')
                    self.one(log, first)
                    rows = ingest_rows(self.root)
                    for row in rows:
                        if row['session_id'] == 'sess-B':
                            row.pop('source_identity')
                    (self.root / 'metrics.jsonl').write_text(
                        ''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
                    ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                    os.replace(ht_session(self.dir / 'incoming.jsonl', 3, session='sess-B'), log)
                    settle_streams(self.root)
                    before = snapshot(self.root)
                    for dry_run in (True, False):
                        result = self.ingest(log, second, dry_run=dry_run)
                        self.assertEqual(len(result['failures']), 1, result)
                        self.assertIn('SourceConflict', result['failures'][0]['error'])
                        self.assertIn('generation', result['failures'][0]['error'])
                        self.assertEqual(snapshot(self.root), before)

    def test_same_id_fallback_promotion_on_same_inode_preserves_dedup(self):
        for first in (CALL, SESSION):
            for second in (CALL, SESSION):
                with self.subTest(first=first, second=second):
                    name = f'{first}-{second}'
                    self.root = self.dir / f'state-{name}'
                    log = self.dir / f'{name}_sessA.jsonl'
                    log.write_text(ht_call(0), encoding='utf-8')
                    self.one(log, first)
                    checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                    checkpoint.unlink()
                    old_inode = log.stat().st_ino
                    ht_session(log, 2, session='sessA')
                    self.assertEqual(log.stat().st_ino, old_inode)
                    result = self.one(log, second)
                    self.assertEqual(result['emitted'], 1)
                    self.assertEqual(recorded_input_tokens(self.root, 'sessA'), 2000)
                    checkpoint.unlink()
                    self.assertEqual(self.one(log, second)['emitted'], 0)

    def test_rotated_fallback_cannot_promote_without_a_checkpoint(self):
        for corrupt in (False, True):
            for first in (CALL, SESSION):
                for second in (CALL, SESSION):
                    with self.subTest(corrupt=corrupt, first=first, second=second):
                        name = f'{corrupt}-{first}-{second}'
                        self.root = self.dir / f'state-{name}'
                        log = self.dir / f'{name}_sessA.jsonl'
                        log.write_text(ht_call(0), encoding='utf-8')
                        initial = self.one(log, first)
                        old_identity = [log.stat().st_dev, log.stat().st_ino]
                        checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                        if corrupt:
                            checkpoint.write_text('not json', encoding='utf-8')
                        else:
                            checkpoint.unlink()
                        replacement = ht_session(self.dir / 'incoming.jsonl', 2, session='sess-B')
                        os.replace(replacement, log)
                        new_identity = [log.stat().st_dev, log.stat().st_ino]
                        self.assertNotEqual(new_identity, old_identity)
                        before = snapshot(self.root)
                        preview = self.one(log, second, dry_run=True)
                        self.assertEqual(snapshot(self.root), before)
                        result = self.one(log, second)
                        self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 2000,
                                         'a new inode cannot inherit the old fallback call asst-0')
                        self.assertEqual(result['emitted'], 2 if second == CALL else 1)
                        self.assertEqual(preview['estimated_cost_usd'], result['estimated_cost_usd'])
                        self.assertAlmostEqual(result['estimated_cost_usd'], 2 * initial['estimated_cost_usd'])
                        rows = ingest_rows(self.root)
                        self.assertEqual(rows[0]['source_identity'], old_identity)
                        self.assertTrue(all(row['source_identity'] == new_identity for row in rows[1:]))
                        self.assertEqual(load_jsonl(self.root / 'events.jsonl'), [])
                        checkpoint.unlink()
                        retry = self.one(log, second)
                        self.assertEqual((retry['emitted'], retry['estimated_cost_usd']), (0, 0))
                        self.assertEqual(ingest_rows(self.root), rows)

    def test_missing_or_invalid_metric_generation_fails_closed_without_checkpoint(self):
        for identity in (None, ['bad', 'inode'], [True, 1], [1], 'unknown'):
            for rotate in (False, True):
                for first in (CALL, SESSION):
                    for second in (CALL, SESSION):
                        with self.subTest(identity=identity, rotate=rotate, first=first, second=second):
                            log = self.dir / 'log_sessA.jsonl'
                            # Separate roots prevent earlier subtests from providing evidence.
                            with tempfile.TemporaryDirectory(dir=self.dir) as state:
                                self.root = Path(state)
                                log.write_text(ht_call(0), encoding='utf-8')
                                self.one(log, first)
                                rows = ingest_rows(self.root)
                                for row in rows:
                                    row.pop('source_identity', None)
                                    if identity is not None:
                                        row['source_identity'] = identity
                                (self.root / 'metrics.jsonl').write_text(
                                    ''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
                                ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                                replacement = self.dir / 'incoming.jsonl' if rotate else log
                                ht_session(replacement, 2, session='sess-B')
                                if rotate:
                                    os.replace(replacement, log)
                                settle_streams(self.root)
                                before = snapshot(self.root)
                                for dry_run in (True, False):
                                    result = self.ingest(log, second, dry_run=dry_run)
                                    self.assertEqual(len(result['failures']), 1, result)
                                    self.assertIn('SourceConflict', result['failures'][0]['error'])
                                    self.assertIn('generation', result['failures'][0]['error'])
                                    self.assertEqual(snapshot(self.root), before)

    def test_binding_from_an_old_generation_cannot_alias_a_rotated_explicit_session(self):
        for first in (CALL, SESSION):
            for second in (CALL, SESSION):
                with self.subTest(first=first, second=second):
                    name = f'{first}-{second}'
                    self.root = self.dir / f'state-{name}'
                    log = self.dir / f'{name}_sessA.jsonl'
                    log.write_text(ht_call(0), encoding='utf-8')
                    initial = self.one(log, first)
                    ht_session(log, 1, session='sess-B')
                    self.assertEqual(self.one(log, second)['emitted'], 0)
                    events = load_jsonl(self.root / 'events.jsonl')
                    ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                    os.replace(ht_session(self.dir / 'incoming.jsonl', 2, session='sess-B'), log)
                    result = self.one(log, second)
                    self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 2000)
                    self.assertAlmostEqual(result['estimated_cost_usd'], 2 * initial['estimated_cost_usd'])
                    self.assertEqual(load_jsonl(self.root / 'events.jsonl'), events)
                    ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                    self.assertEqual(self.one(log, second)['emitted'], 0)

    def test_deleted_checkpoint_allows_same_inode_zero_cost_promotion(self):
        for first in (CALL, SESSION):
            for second in (CALL, SESSION):
                with self.subTest(first=first, second=second):
                    name = f'{first}-{second}'
                    self.root = self.dir / f'state-{name}'
                    log = self.dir / f'{name}_sessA.jsonl'
                    log.write_text(ht_call(0), encoding='utf-8')
                    self.one(log, first)
                    identity = [log.stat().st_dev, log.stat().st_ino]
                    metrics = (self.root / 'metrics.jsonl').read_bytes()
                    checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                    checkpoint.unlink()
                    ht_session(log, 1, session='sess-B')
                    self.assertEqual([log.stat().st_dev, log.stat().st_ino], identity)
                    result = self.one(log, second)
                    self.assertEqual((result['emitted'], result['estimated_cost_usd']), (0, 0))
                    self.assertEqual((self.root / 'metrics.jsonl').read_bytes(), metrics)
                    bindings = load_jsonl(self.root / 'events.jsonl')
                    self.assertEqual(len(bindings), 1)
                    self.assertEqual(bindings[0]['source_identity'], identity)
                    checkpoint.unlink()
                    self.assertEqual(self.one(log, second)['emitted'], 0)
                    self.assertEqual(load_jsonl(self.root / 'events.jsonl'), bindings)
                    self.assertEqual((self.root / 'metrics.jsonl').read_bytes(), metrics)

    def test_promotion_binding_survives_checkpoint_loss_before_successor_session(self):
        for promoted_calls in (2, 1):  # one call means promotion writes no new metric rows
            for first in (CALL, SESSION):
                for second in (CALL, SESSION):
                    with self.subTest(promoted_calls=promoted_calls, first=first, second=second):
                        name = f'{promoted_calls}-{first}-{second}'
                        self.root = self.dir / f'state-{name}'
                        log = self.dir / f'{name}_sessA.jsonl'
                        log.write_text(ht_call(0), encoding='utf-8')
                        self.one(log, first)
                        ht_session(log, promoted_calls, session='sess-B')
                        promoted = self.one(log, second)
                        self.assertEqual(promoted['emitted'], promoted_calls - 1)
                        self.assertEqual(recorded_input_tokens(self.root, 'sessA'), 1000)
                        self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), (promoted_calls - 1) * 1000)
                        ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                        ht_session(log, 2, session='sess-C')
                        before = snapshot(self.root)
                        preview = self.one(log, second, dry_run=True)
                        self.assertEqual(snapshot(self.root), before)
                        result = self.one(log, second)
                        self.assertEqual(recorded_input_tokens(self.root, 'sess-C'), 2000,
                                         'C must not inherit A after its promotion to B')
                        self.assertEqual(result['emitted'], 2 if second == CALL else 1)
                        self.assertEqual(preview['estimated_cost_usd'], result['estimated_cost_usd'])
                        self.assertGreater(result['estimated_cost_usd'], 0)
                        ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                        self.assertEqual(self.one(log, second)['emitted'], 0)

    def test_zero_metric_promotion_has_one_durable_binding_and_no_cost_on_retry(self):
        log = self.dir / 'log_sessA.jsonl'
        log.write_text(ht_call(0), encoding='utf-8')
        first = self.one(log, CALL)
        ht_session(log, 1, session='sess-B')
        metrics_before = (self.root / 'metrics.jsonl').read_bytes()
        with patch.object(ingest_checkpoint_impl, 'save_checkpoint', side_effect=OSError('checkpoint lost')):
            failed = self.ingest(log, CALL)
        self.assertEqual(len(failed['failures']), 1)
        events = load_jsonl(self.root / 'events.jsonl')
        bindings = [row for row in events if row.get('event') == 'session_ingest_promotion']
        self.assertEqual(len(bindings), 1, 'promotion must be authoritative even with no new metric')
        binding = bindings[0]
        self.assertTrue(binding['record_id'])
        self.assertEqual(binding['ingest_source'], str(log))
        self.assertEqual(binding['source_identity'], [log.stat().st_dev, log.stat().st_ino])
        self.assertEqual((binding['from_session_id'], binding['to_session_id']), ('sessA', 'sess-B'))
        self.assertEqual((self.one(log, CALL)['emitted'], self.one(log, CALL)['estimated_cost_usd']), (0, 0))
        self.assertEqual(load_jsonl(self.root / 'events.jsonl'), events)
        self.assertEqual((self.root / 'metrics.jsonl').read_bytes(), metrics_before)
        self.assertGreater(first['estimated_cost_usd'], 0)
        ingest_checkpoint.checkpoint_path(self.root, log).unlink()
        ht_session(log, 2, session='sess-C')
        self.one(log, CALL)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-C'), 2000)

    def test_unbound_legacy_promotion_is_ambiguous_after_checkpoint_loss(self):
        log = self.dir / 'log_sessA.jsonl'
        log.write_text(ht_call(0), encoding='utf-8')
        self.one(log, CALL)
        ht_session(log, 2, session='sess-B')
        self.one(log, CALL)
        # Old writers recorded origins but never persisted the A -> B binding.
        (self.root / 'events.jsonl').write_text('', encoding='utf-8')
        ingest_checkpoint.checkpoint_path(self.root, log).unlink()
        ht_session(log, 2, session='sess-C')
        settle_streams(self.root)
        before = snapshot(self.root)
        for dry_run in (True, False):
            result = self.ingest(log, CALL, dry_run=dry_run)
            self.assertEqual(len(result['failures']), 1, result)
            self.assertIn('SourceConflict', result['failures'][0]['error'])
            self.assertEqual(snapshot(self.root), before)

    def test_legacy_zero_metric_promotion_cannot_be_guessed_from_fallback_origin(self):
        log = self.dir / 'log_sessA.jsonl'
        log.write_text(ht_call(0), encoding='utf-8')
        self.one(log, CALL)
        ht_session(log, 1, session='sess-B')
        self.one(log, CALL)
        # The old writer's zero-metric promotion left only A's fallback row. That
        # is indistinguishable from a first promotion unless A attests the new protocol.
        rows = ingest_rows(self.root)
        for row in rows:
            row.pop('promotion_version', None)
        (self.root / 'metrics.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        (self.root / 'events.jsonl').write_text('', encoding='utf-8')
        ingest_checkpoint.checkpoint_path(self.root, log).unlink()
        ht_session(log, 2, session='sess-C')
        settle_streams(self.root)
        before = snapshot(self.root)
        result = self.ingest(log, CALL)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertIn('SourceConflict', result['failures'][0]['error'])
        self.assertEqual(snapshot(self.root), before)

    def test_promotion_event_survives_failure_before_new_metrics(self):
        from orchestrator import record_batch

        real_append = record_batch._append_stream
        for granularity in (CALL, SESSION):
            with self.subTest(granularity=granularity):
                self.root = self.dir / f'state-{granularity}'
                log = self.dir / f'{granularity}_sessA.jsonl'
                log.write_text(ht_call(0), encoding='utf-8')
                self.one(log, granularity)
                ht_session(log, 2, session='sess-B')

                def fail_metrics(path, *args, **kwargs):
                    if path.name == 'metrics.jsonl':
                        raise OSError('crash after event fsync, before metrics append')
                    return real_append(path, *args, **kwargs)

                with patch.object(record_batch, '_append_stream', fail_metrics):
                    failed = self.ingest(log, granularity)
                self.assertEqual(len(failed['failures']), 1, failed)
                self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 0)
                events = load_jsonl(self.root / 'events.jsonl')
                self.assertEqual(len(events), 1)
                ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                preview_before = snapshot(self.root)
                preview = self.one(log, granularity, dry_run=True)
                self.assertEqual(snapshot(self.root), preview_before)
                retried = self.one(log, granularity)
                self.assertEqual((preview['emitted'], retried['emitted']), (1, 1))
                self.assertEqual(preview['estimated_cost_usd'], retried['estimated_cost_usd'])
                self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 1000)
                self.assertEqual(load_jsonl(self.root / 'events.jsonl'), events)
                self.assertEqual(self.one(log, granularity)['emitted'], 0)

    def test_failed_promotion_fsync_is_settled_on_zero_metric_retry(self):
        log = self.dir / 'log_sessA.jsonl'
        log.write_text(ht_call(0), encoding='utf-8')
        self.one(log, CALL)
        ht_session(log, 1, session='sess-B')
        events_path = self.root / 'events.jsonl'
        checkpoint_before = self.checkpoint(log)
        real_fsync = os.fsync
        synced = []

        def fsync(fd):
            if os.fstat(fd).st_ino == events_path.stat().st_ino:
                raise OSError('event fsync failed')
            real_fsync(fd)

        with patch('os.fsync', fsync):
            failed = self.ingest(log, CALL)
        self.assertEqual(len(failed['failures']), 1, failed)
        self.assertEqual(self.checkpoint(log), checkpoint_before)
        events = load_jsonl(events_path)
        self.assertEqual(len(events), 1)

        def spy_fsync(fd):
            if os.fstat(fd).st_ino == events_path.stat().st_ino:
                synced.append(fd)
            real_fsync(fd)

        # A complete pending tail also participates in read-only reconciliation.
        events_path.write_bytes(events_path.read_bytes().rstrip(b'\n'))
        ingest_checkpoint.checkpoint_path(self.root, log).unlink()
        before = snapshot(self.root)
        self.assertEqual(self.one(log, CALL, dry_run=True)['emitted'], 0)
        self.assertEqual(snapshot(self.root), before)
        with patch('os.fsync', spy_fsync):
            result = self.one(log, CALL)
        self.assertTrue(synced, 'event durability must precede the rebuilt checkpoint')
        self.assertEqual((result['emitted'], result['estimated_cost_usd']), (0, 0))
        self.assertEqual(load_jsonl(events_path), events)
        self.assertTrue(events_path.read_bytes().endswith(b'\n'))
        self.assertEqual(recorded_input_tokens(self.root, 'sessA'), 1000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 0)

    def test_conflicting_or_malformed_durable_bindings_fail_before_any_write(self):
        for malformed in ('conflicting', 'invalid', 'generation'):
            with self.subTest(malformed=malformed):
                self.root = self.dir / f'state-{malformed}'
                log = self.dir / f'{malformed}_sessA.jsonl'
                log.write_text(ht_call(0), encoding='utf-8')
                self.one(log, CALL)
                ht_session(log, 1, session='sess-B')
                self.one(log, CALL)
                identity = [log.stat().st_dev, log.stat().st_ino]
                target = 'sess-C'
                if malformed == 'generation':
                    identity[1] += 1
                    target = 'sess-B'  # the same target cannot silently rebind its generation
                binding = ingest_checkpoint.promotion_record('humain-terminal', log,
                                                             identity, 'sessA', target)
                if malformed == 'invalid':
                    binding['source_identity'] = ['not', 'an inode']
                write_batch(self.root, [binding], refresh=False)
                ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                ht_session(log, 2, session='sess-C')
                before = snapshot(self.root)
                for dry_run in (True, False):
                    result = self.ingest(log, CALL, dry_run=dry_run)
                    self.assertEqual(len(result['failures']), 1, result)
                    self.assertIn('SourceConflict', result['failures'][0]['error'])
                    self.assertEqual(snapshot(self.root), before)

    def test_explicit_session_replacement_bills_reused_ids_without_checkpoint(self):
        for corrupt in (False, True):
            for rotate in (False, True):
                for first in (CALL, SESSION):
                    for second in (CALL, SESSION):
                        with self.subTest(corrupt=corrupt, rotate=rotate, first=first, second=second):
                            name = f'{corrupt}-{rotate}-{first}-{second}'
                            self.root = self.dir / f'state-{name}'
                            log = ht_session(self.dir / f'{name}.jsonl', 2, session='sess-A')
                            self.one(log, first)
                            checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                            if corrupt:
                                checkpoint.write_text('not json', encoding='utf-8')
                            else:
                                checkpoint.unlink()
                            before = (self.root / 'metrics.jsonl').read_bytes()
                            old_size = log.stat().st_size
                            replacement = self.dir / 'replacement.jsonl' if rotate else log
                            ht_session(replacement, 2, session='sess-B')
                            if rotate:
                                os.replace(replacement, log)
                            self.assertEqual(log.stat().st_size, old_size)
                            preview_before = snapshot(self.root)
                            preview = self.one(log, second, dry_run=True)
                            self.assertEqual(preview['emitted'], 2 if second == CALL else 1)
                            self.assertEqual(snapshot(self.root), preview_before)
                            result = self.one(log, second)
                            self.assertEqual(result['emitted'], 2 if second == CALL else 1)
                            self.assertEqual(recorded_input_tokens(self.root, 'sess-A'), 2000)
                            self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 2000)
                            self.assertTrue((self.root / 'metrics.jsonl').read_bytes().startswith(before))
                            self.assertEqual(self.one(log, second)['emitted'], 0)

    def test_fallback_promotion_recovers_canonical_origins_without_checkpoint(self):
        for corrupt in (False, True):
            for first in (CALL, SESSION):
                for second in (CALL, SESSION):
                    with self.subTest(corrupt=corrupt, first=first, second=second):
                        name = f'{corrupt}-{first}-{second}'
                        self.root = self.dir / f'state-{name}'
                        log = self.dir / f'{name}_fallback.jsonl'
                        log.write_text(ht_call(0), encoding='utf-8')
                        initial = self.one(log, first)
                        identity = [log.stat().st_dev, log.stat().st_ino]
                        checkpoint = ingest_checkpoint.checkpoint_path(self.root, log)
                        if corrupt:
                            checkpoint.write_text('not json', encoding='utf-8')
                        else:
                            checkpoint.unlink()
                        ht_session(log, 2, session='explicit')
                        before = (self.root / 'metrics.jsonl').read_bytes()
                        self.assertEqual([log.stat().st_dev, log.stat().st_ino], identity)
                        result = self.one(log, second)
                        self.assertEqual(result['emitted'], 1)
                        self.assertEqual(result['estimated_cost_usd'], initial['estimated_cost_usd'])
                        bindings = load_jsonl(self.root / 'events.jsonl')
                        self.assertEqual(len(bindings), 1)
                        self.assertEqual(bindings[0]['source_identity'], identity)
                        self.assertEqual(recorded_input_tokens(self.root, 'fallback'), 1000)
                        self.assertEqual(recorded_input_tokens(self.root, 'explicit'), 1000)
                        self.assertTrue((self.root / 'metrics.jsonl').read_bytes().startswith(before))
                        self.assertEqual([r.get('session_origin') for r in ingest_rows(self.root)],
                                         ['fallback', 'explicit'])
                        checkpoint.unlink()
                        self.assertEqual(self.one(log, second)['emitted'], 0)
                        self.assertEqual(load_jsonl(self.root / 'events.jsonl'), bindings)
                        self.assertAlmostEqual(sum(row['cost_usd'] for row in ingest_rows(self.root)),
                                               2 * initial['estimated_cost_usd'])

    def test_unknown_ledger_origin_rejects_cross_session_matches_without_writes(self):
        for origin in (None, 'invalid', ['fallback']):
            for first in (CALL, SESSION):
                for second in (CALL, SESSION):
                    with self.subTest(origin=origin, first=first, second=second):
                        self.root = self.dir / f'state-{origin}-{first}-{second}'
                        log = ht_session(self.dir / 'legacy.jsonl', 1, session='sess-A')
                        self.one(log, first)
                        rows = ingest_rows(self.root)
                        for row in rows:
                            row.pop('session_origin', None)
                            if origin is not None:
                                row['session_origin'] = origin
                        (self.root / 'metrics.jsonl').write_text(
                            ''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
                        ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                        ht_session(log, 2, session='sess-B')
                        # Settle derived writer caches after constructing the legacy ledger;
                        # reconciliation itself must leave both records and checkpoint untouched.
                        settle_streams(self.root)
                        before = snapshot(self.root)
                        for dry_run in (True, False):
                            result = self.ingest(log, second, dry_run=dry_run)
                            self.assertEqual(result['emitted'], 0)
                            self.assertEqual(len(result['failures']), 1, result)
                            self.assertIn('SourceConflict', result['failures'][0]['error'])
                            self.assertIn('provenance', result['failures'][0]['error'])
                            self.assertEqual(snapshot(self.root), before)

    def test_header_provenance_and_inode_distinguish_drift_from_new_sessions(self):
        # Only an in-place fallback -> explicit transition may alias identical calls.
        for explicit in (False, True):
            for rotate in (False, True):
                for first in (CALL, SESSION):
                    for second in (CALL, SESSION):
                        with self.subTest(explicit=explicit, rotate=rotate, first=first, second=second):
                            name = f'{explicit}-{rotate}-{first}-{second}'
                            self.root = self.dir / f'state-{name}'
                            log = self.dir / f'{name}_sessA.jsonl'
                            header = json.dumps({'type': 'session', 'id': 'sessA'}) + '\n' if explicit else ''
                            log.write_text(header + ht_call(0), encoding='utf-8')
                            self.one(log, first)
                            old_inode = log.stat().st_ino
                            replacement = self.dir / 'replacement.jsonl' if rotate else log
                            target = f'sess-B-{name}'
                            ht_session(replacement, 2, session=target)
                            if rotate:
                                os.replace(replacement, log)
                                self.assertNotEqual(log.stat().st_ino, old_inode)
                            else:
                                self.assertEqual(log.stat().st_ino, old_inode)
                            result = self.one(log, second)
                            expected_tokens = 1000 if not explicit and not rotate else 2000
                            self.assertEqual(recorded_input_tokens(self.root, target), expected_tokens)
                            self.assertEqual(result['emitted'], expected_tokens // 1000 if second == CALL else 1)
                            self.assertEqual(self.one(log, second)['emitted'], 0)

    def test_fallback_alias_does_not_leak_into_a_later_explicit_session(self):
        log = self.dir / 'log_sessA.jsonl'
        log.write_text(ht_call(0), encoding='utf-8')
        self.one(log)
        ht_session(log, 2, session='sess-B')
        self.one(log)
        self.assertEqual(recorded_input_tokens(self.root, 'sessA'), 1000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), 1000)
        ht_session(log, 2, session='sess-C')
        self.one(log)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-C'), 2000)
        append(log, ht_call(0) + ht_call(2, tokens=50))
        self.one(log)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-C'), 2050)

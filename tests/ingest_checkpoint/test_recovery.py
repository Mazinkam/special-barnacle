"""B5: crash, corruption and rollback recovery (was ``RecoveryTests``, ``DurabilityRecoveryTests``,
``MixedCoverageRecoveryTests``, ``RecoveryRoundTwoTests`` and ``MalformedCheckpointTests``)."""
from __future__ import annotations

import json
import os
from unittest.mock import patch

from orchestrator import ingest_checkpoint
from orchestrator.ingest import CALL, SESSION, ingest_file, ingest_paths
from orchestrator.ingest import checkpoint as ingest_checkpoint_impl
from orchestrator.record_batch import BatchAppendError
from orchestrator.runtime import EventStore, read_json

from tests.ingest_checkpoint.helpers import (
    CheckpointTestCase, aggregate_row, append, ht_call, ht_session, ingest_rows, recorded_input_tokens, snapshot,
)
from tests.test_ingest import codex_log

class RecoveryTests(CheckpointTestCase):
    def test_crash_between_append_and_checkpoint_is_recovered_without_duplicates(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        append(log, ht_call(3, tokens=400))
        with patch.object(ingest_checkpoint_impl, 'save_checkpoint', side_effect=OSError('disk went away')):
            with self.assertRaises(OSError):
                ingest_file(log, state_root=self.root, granularity=SESSION, runtime='humain-terminal')
        self.assertEqual(recorded_input_tokens(self.root), 3400, 'the append was durable before the crash')
        stale = self.checkpoint(log)
        self.assertLess(stale['offset'], log.stat().st_size, 'checkpoint was not advanced')
        recovered = self.one(log)
        self.assertEqual(recovered['emitted'], 0)
        self.assertEqual(recorded_input_tokens(self.root), 3400)
        self.assertEqual(self.checkpoint(log)['offset'], log.stat().st_size)
        # per call: the same crash, same ids, no second row
        pc = ht_session(self.dir / 'pc.jsonl', 2, session='sess-c')
        self.one(pc, CALL)
        append(pc, ht_call(2))
        with patch.object(ingest_checkpoint_impl, 'save_checkpoint', side_effect=OSError('disk went away')):
            with self.assertRaises(OSError):
                ingest_file(pc, state_root=self.root, granularity=CALL, runtime='humain-terminal')
        again = self.one(pc, CALL)
        self.assertEqual((again['emitted'], again['duplicates']), (0, 3))
        self.assertEqual(len([r for r in ingest_rows(self.root) if r['session_id'] == 'sess-c']), 3)

    def test_crash_with_no_prior_checkpoint_is_recovered(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        with patch.object(ingest_checkpoint_impl, 'save_checkpoint', side_effect=OSError('nope')):
            with self.assertRaises(OSError):
                ingest_file(log, state_root=self.root, granularity=SESSION, runtime='humain-terminal')
        self.assertIsNone(self.checkpoint(log))
        self.assertEqual(recorded_input_tokens(self.root), 3000)
        self.assertEqual(self.one(log)['emitted'], 0)
        self.assertEqual(recorded_input_tokens(self.root), 3000)

    def test_checkpoint_is_never_advanced_before_a_durable_append(self):
        log = ht_session(self.dir / 'session.jsonl', 2)
        self.one(log)
        before = self.checkpoint(log)
        append(log, ht_call(2))

        def fail(*args, **kwargs):
            raise BatchAppendError('append/fsync of metrics.jsonl failed', {'event': 0, 'metric': 0, 'outcome': 0})

        with patch('orchestrator.ingest.service.write_batch', fail):
            result = self.ingest(log)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertIn('same record ids', result['failures'][0]['error'])
        self.assertEqual(self.checkpoint(log), before)
        self.assertEqual(self.one(log)['emitted'], 1)
        self.assertEqual(recorded_input_tokens(self.root), 3000)

    def test_rows_appended_by_another_ingester_are_reconciled_from_metrics(self):
        log = ht_session(self.dir / 'session.jsonl', 4)
        self.one(log)
        append(log, ht_call(4, tokens=250))
        # A legacy/other process aggregated the same session meanwhile, without touching our checkpoint.
        EventStore(self.root).metric(event='model_call', source='session_ingest', role='interactive_session',
                                     agent_runtime='humain-terminal', session_id='sess-1', model='claude-sonnet-5',
                                     granularity=SESSION, covers_calls=1, call_id='other-1', input_tokens=250,
                                     output_tokens=100, cached_input_tokens=0, cache_write_tokens=0,
                                     reasoning_output_tokens=0, total_tokens=350)
        result = self.one(log)
        self.assertEqual(result['emitted'], 0, 'the other ingester already recorded the new call')
        self.assertEqual(recorded_input_tokens(self.root), 4250)
        pc = ht_session(self.dir / 'pc.jsonl', 2, session='sess-c')
        self.one(pc, CALL)
        append(pc, ht_call(2))
        from orchestrator.ingest import call_id_for
        EventStore(self.root).metric(event='model_call', source='session_ingest', role='interactive_session',
                                     agent_runtime='humain-terminal', session_id='sess-c', model='claude-sonnet-5',
                                     granularity=CALL, call_id=call_id_for('humain-terminal', 'sess-c', 'asst-2'),
                                     input_tokens=1000, output_tokens=100)
        result = self.one(pc, CALL)
        self.assertEqual((result['emitted'], result['duplicates']), (0, 3))

    def test_deleting_or_corrupting_the_checkpoint_changes_nothing_recorded(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        path = ingest_checkpoint.checkpoint_path(self.root, log)
        path.unlink()
        self.assertEqual(self.one(log)['emitted'], 0)
        for garbage in ('not json', json.dumps({'format_version': 99}), json.dumps({**read_json(path, {}), 'source': '/elsewhere'})):
            path.write_text(garbage, encoding='utf-8')
            result = self.one(log)
            self.assertEqual(result['emitted'], 0, garbage)
            self.assertFalse(result['resumed'], garbage)
        # a checkpoint claiming a prefix beyond the file, or with a wrong tail hash, is not trusted
        good = read_json(path, {})
        for bad in ({**good, 'offset': good['offset'] + 10}, {**good, 'tail_hash': 'deadbeefdeadbeef'}):
            path.write_text(json.dumps(bad), encoding='utf-8')
            self.assertFalse(self.one(log)['resumed'])
        # a checkpoint lying about dedup state cannot suppress rows the authoritative stream lacks
        (self.root / 'metrics.jsonl').write_text('', encoding='utf-8')  # restored older snapshot
        result = self.one(log)
        self.assertEqual(result['emitted'], 1, 'metrics.jsonl, not the checkpoint, decides what is recorded')
        self.assertEqual(recorded_input_tokens(self.root), 3000)

    def test_dry_run_leaves_the_state_root_byte_identical(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        result = self.ingest(log, dry_run=True)
        self.assertEqual(result['emitted'], 1)
        self.assertFalse(self.root.exists(), 'a dry run creates nothing, not even the root')
        self.one(log)
        append(log, ht_call(3))
        before = snapshot(self.root)
        preview = self.ingest(log, dry_run=True)
        self.assertEqual(preview['emitted'], 1)
        self.assertGreater(preview['estimated_cost_usd'], 0)
        self.assertEqual(snapshot(self.root), before)
        preview_calls = self.ingest(log, CALL, dry_run=True)
        self.assertEqual(preview_calls['emitted'], 1, preview_calls)
        self.assertEqual(snapshot(self.root), before)


class DurabilityRecoveryTests(CheckpointTestCase):
    """Finding 6: rows whose fsync failed are settled by the writer before a checkpoint vouches for them."""

    def test_failed_fsync_is_settled_on_a_retry_that_has_nothing_new_to_append(self):
        from orchestrator.record_index import RecordIndex
        log = ht_session(self.dir / 'session.jsonl', 3)
        EventStore(self.root)
        metrics = self.root / 'metrics.jsonl'
        real_fsync = os.fsync
        synced: list[int] = []

        def is_metrics(fd: int) -> bool:
            return os.fstat(fd).st_ino == metrics.stat().st_ino

        def failing(fd):
            if is_metrics(fd):
                raise OSError(5, 'Input/output error')
            real_fsync(fd)

        def spying(fd):
            if is_metrics(fd):
                synced.append(fd)
            real_fsync(fd)

        with patch('os.fsync', failing):
            failed = self.ingest(log)
        self.assertEqual(len(failed['failures']), 1, failed)
        self.assertIn('same record ids', failed['failures'][0]['error'])
        self.assertEqual(recorded_input_tokens(self.root), 3000, 'the bytes are visible but not known durable')
        self.assertIsNone(self.checkpoint(log))
        with RecordIndex(self.root) as index:
            self.assertLess(index['metric']['durable_size'], index['metric']['size'])
        # still failing: still no checkpoint, still reported
        with patch('os.fsync', failing):
            again = self.ingest(log)
        self.assertEqual(len(again['failures']), 1, again)
        self.assertIsNone(self.checkpoint(log))
        # the disk is back: the retry has no new row to write but must still make the old ones durable
        with patch('os.fsync', spying):
            recovered = self.one(log)
        self.assertEqual(recovered['emitted'], 0)
        self.assertTrue(synced, 'metrics.jsonl was fsynced during the retry')
        self.assertIsNotNone(self.checkpoint(log))
        with RecordIndex(self.root) as index:
            self.assertEqual(index['metric']['durable_size'], index['metric']['size'])
        self.assertEqual(recorded_input_tokens(self.root), 3000)


class MixedCoverageRecoveryTests(CheckpointTestCase):
    def test_identified_rows_cannot_pay_for_an_unrecorded_call_during_legacy_reconciliation(self):
        from orchestrator.ingest import call_id_for

        for usage in ((1000, 1000, 1000, 1000), (500, 1500, 1000, 1000), (400, 600, 1300, 1700)):
            for granularity in (SESSION, CALL):
                with self.subTest(usage=usage, granularity=granularity):
                    session = f'sess-{usage[0]}-{granularity}'
                    a, b, c, d = usage
                    log = ht_session(self.dir / f'{session}.jsonl', 1, session=session, tokens=a)
                    self.one(log, SESSION)  # only A is checkpointed
                    checkpoint_path = ingest_checkpoint.checkpoint_path(self.root, log)
                    before_checkpoint = checkpoint_path.read_bytes()
                    append(log, ht_call(1, tokens=b) + ht_call(2, tokens=c) + ht_call(3, tokens=d))
                    store = EventStore(self.root)
                    store.metric(**aggregate_row(session, covers=1, input_tokens=b))  # B: legacy, no covered IDs
                    identified = aggregate_row(session, covers=1, input_tokens=d,
                                               call_id=call_id_for('humain-terminal', session, 'asst-3'))
                    identified.pop('covers_calls')
                    identified['granularity'] = CALL
                    store.metric(**identified)  # D: identified; C is still unpaid
                    before_metrics = (self.root / 'metrics.jsonl').read_bytes()

                    result = self.ingest(log, granularity)
                    if result['failures']:
                        self.assertEqual(len(result['failures']), 1, result)
                        self.assertEqual(result['emitted'], 0)
                        self.assertEqual(checkpoint_path.read_bytes(), before_checkpoint)
                        self.assertEqual((self.root / 'metrics.jsonl').read_bytes(), before_metrics)
                        self.assertIn('reconcile', result['failures'][0]['error'])
                    else:
                        self.assertEqual(recorded_input_tokens(self.root, session), 4000,
                                         'identified D must not also pay for the skipped C')
                        self.assertEqual(result['emitted'], 1, 'only C remains unpaid')
                        self.assertEqual(ingest_rows(self.root)[-1]['input_tokens'], c)
                        self.assertEqual(self.one(log, granularity)['emitted'], 0)
                        self.assertEqual(recorded_input_tokens(self.root, session), 4000)

    def test_checkpointed_legacy_usage_does_not_pay_again_for_new_identified_rows(self):
        from orchestrator.ingest import call_id_for

        for granularity in (SESSION, CALL):
            with self.subTest(granularity=granularity):
                session = f'sess-known-legacy-{granularity}'
                log = ht_session(self.dir / f'{session}.jsonl', 1, session=session)
                self.one(log)
                append(log, ht_call(1))
                store = EventStore(self.root)
                store.metric(**aggregate_row(session, covers=1, input_tokens=1000))
                self.assertEqual(self.one(log)['emitted'], 0)  # A+B, including legacy B, now checkpointed
                append(log, ht_call(2) + ht_call(3))
                identified = aggregate_row(session, covers=1, input_tokens=1000,
                                           call_id=call_id_for('humain-terminal', session, 'asst-3'))
                identified.pop('covers_calls')
                identified['granularity'] = CALL
                store.metric(**identified)
                self.assertEqual(self.one(log, granularity)['emitted'], 1, 'only C remains unpaid')
                self.assertEqual(recorded_input_tokens(self.root, session), 4000)
                self.assertEqual(self.one(log, granularity)['emitted'], 0)


class RecoveryRoundTwoTests(CheckpointTestCase):
    def test_invalid_aggregate_coverage_cannot_turn_recorded_usage_into_unpaid_calls(self):
        log = ht_session(self.dir / 'session.jsonl', 1)
        EventStore(self.root).metric(**{**aggregate_row('sess-1', covers=1, input_tokens=1000),
                                       'covers_calls': None, 'covered_call_ids': []})
        before = snapshot(self.root)
        result = self.ingest(log)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertEqual(snapshot(self.root), before)
        # A legacy per-call row without an ID is also unidentified history, not unpaid usage.
        no_id = ht_session(self.dir / 'no-id.jsonl', 1, session='sess-noid')
        EventStore(self.root).metric(**{**aggregate_row('sess-noid', covers=1, input_tokens=1000),
                                       'granularity': CALL, 'call_id': ''})
        before = snapshot(self.root)
        result = self.ingest(no_id)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertEqual(snapshot(self.root), before)

    def test_legacy_totals_without_checkpoint_are_ambiguous_even_when_a_prefix_matches(self):
        log = ht_session(self.dir / 'session.jsonl', 4, start=10)
        EventStore(self.root).metric(**aggregate_row('sess-1', covers=3, input_tokens=3000))
        before = snapshot(self.root)
        for granularity in (SESSION, CALL):
            result = self.ingest(log, granularity)
            self.assertEqual(len(result['failures']), 1, result)
            self.assertEqual(result['emitted'], 0)
            self.assertEqual(snapshot(self.root), before)

    def test_missing_checkpoint_replacement_cannot_hide_new_calls_behind_nondecreasing_totals(self):
        for count, expected_tokens in ((3, 6000), (4, 7000)):
            with self.subTest(replacement_calls=count):
                session = f'sess-{count}'
                log = ht_session(self.dir / f'session-{count}.jsonl', 3, session=session)
                self.one(log)
                ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                ht_session(log, count, start=10, session=session)  # different IDs, equal or greater totals
                result = self.ingest(log)
                self.assertEqual(result['failures'], [])
                self.assertEqual(recorded_input_tokens(self.root, session), expected_tokens)
                self.assertEqual(self.one(log)['emitted'], 0)

    def test_regrowth_deduplicates_calls_seen_before_truncation(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        ht_session(log, 1)
        self.one(log)
        append(log, ht_call(1) + ht_call(2) + ht_call(3, tokens=50))
        result = self.one(log)
        self.assertTrue(result['resumed'])
        self.assertEqual(recorded_input_tokens(self.root), 3050)
        self.assertEqual(ingest_rows(self.root)[-1]['covers_calls'], 1)
        self.assertEqual(self.one(log, CALL)['emitted'], 0)

    def test_header_rewrite_with_growth_during_read_cannot_misattribute_calls(self):
        from orchestrator import ingest as ingest_module
        from orchestrator.ingest import service as ingest_service_module
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        before = snapshot(self.root)
        real_read = ingest_module.read_calls

        def rewrite_and_grow(*args, **kwargs):
            with log.open('r+b') as handle:
                handle.write(log.read_bytes().replace(b'sess-1', b'sess-9', 1))
            append(log, ht_call(3, tokens=50))
            return real_read(*args, **kwargs)

        with patch.object(ingest_service_module, 'read_calls', rewrite_and_grow):
            result = self.ingest(log)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertEqual(snapshot(self.root), before)
        self.one(log)
        self.assertEqual(recorded_input_tokens(self.root), 3000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-9'), 3050)

    def test_middle_context_rewrite_with_growth_is_not_a_verified_prefix(self):
        log = ht_session(self.dir / 'session.jsonl', 1)
        append(log, json.dumps({'padding': 'x' * 9000}) + '\n')
        append(log, json.dumps({'type': 'session', 'id': 'sess-2'}) + '\n' + ht_call(1))
        append(log, json.dumps({'padding': 'y' * 9000}) + '\n')
        self.one(log)
        with log.open('r+b') as handle:
            handle.write(log.read_bytes().replace(b'sess-2', b'sess-9', 1))
        append(log, ht_call(2, tokens=50))
        result = self.one(log)
        self.assertFalse(result['resumed'])
        self.assertEqual(recorded_input_tokens(self.root, 'sess-2'), 1000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-9'), 1050)

    def test_rewrite_retry_after_durable_append_and_checkpoint_failure(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        ht_session(log, 1)
        append(log, ht_call(7, tokens=200))
        with patch.object(ingest_checkpoint_impl, 'save_checkpoint', side_effect=OSError('checkpoint unavailable')):
            failed = self.ingest(log)
        self.assertEqual(len(failed['failures']), 1)
        self.assertEqual(recorded_input_tokens(self.root), 3200)
        self.assertEqual(self.one(log)['emitted'], 0)
        append(log, ht_call(8, tokens=30))
        self.one(log)
        self.assertEqual(recorded_input_tokens(self.root), 3230)

    def test_rewritten_source_repeated_in_dry_run_deduplicates_staged_rows(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        ht_session(log, 1)
        append(log, ht_call(7, tokens=200))
        before = snapshot(self.root)
        result = ingest_paths([log, log], state_root=self.root, granularity=SESSION, dry_run=True)
        self.assertEqual(result['failures'], [])
        self.assertEqual([f['emitted'] for f in result['files']], [1, 0])
        self.assertEqual(snapshot(self.root), before)
        self.one(log)
        self.assertEqual(recorded_input_tokens(self.root), 3200)

    def test_first_import_rejects_header_rewrite_and_growth_after_parsing(self):
        from orchestrator import ingest as ingest_module
        from orchestrator.ingest import service as ingest_service_module
        log = ht_session(self.dir / 'session.jsonl', 3)
        real_read = ingest_module.read_calls

        def rewrite_after_read(*args, **kwargs):
            result = real_read(*args, **kwargs)
            with log.open('r+b') as handle:
                handle.write(log.read_bytes().replace(b'sess-1', b'sess-9', 1))
            append(log, ht_call(3, tokens=50))
            return result

        with patch.object(ingest_service_module, 'read_calls', rewrite_after_read):
            result = self.ingest(log)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertEqual(ingest_rows(self.root), [])
        self.assertIsNone(self.checkpoint(log))
        self.one(log)
        self.assertEqual(recorded_input_tokens(self.root), 0)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-9'), 3050)

    def test_rollback_cannot_silently_omit_calls_also_missing_from_the_source(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log, CALL)
        (self.root / 'metrics.jsonl').write_bytes(b'')
        ht_session(log, 1)
        checkpoint = self.checkpoint(log)
        result = self.ingest(log, CALL)
        self.assertEqual(len(result['failures']), 1, result)
        self.assertEqual(result['emitted'], 0)
        self.assertEqual(ingest_rows(self.root), [])
        self.assertEqual(self.checkpoint(log), checkpoint)

    def test_invalid_parser_state_does_not_make_accounted_growth_a_rewrite(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        append(log, ht_call(3, tokens=200))
        EventStore(self.root).metric(**aggregate_row('sess-1', covers=1, input_tokens=200))
        path = ingest_checkpoint.checkpoint_path(self.root, log)
        checkpoint = read_json(path, {})
        path.write_text(json.dumps({**checkpoint, 'reader': {}}), encoding='utf-8')
        result = self.one(log)
        self.assertFalse(result['resumed'])
        self.assertEqual(result['emitted'], 0)
        self.assertEqual(recorded_input_tokens(self.root), 3200)


class MalformedCheckpointTests(CheckpointTestCase):
    def test_malformed_reader_state_falls_back_to_a_full_read(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        path = ingest_checkpoint.checkpoint_path(self.root, log)
        good = read_json(path, {})
        for reader in ({}, {'session_id': 5, 'repository': None, 'count': 3}, {'session_id': 'sess-1', 'repository': None, 'count': 'three'},
                       {'session_id': 'sess-1', 'repository': 7, 'count': 3}):
            path.write_text(json.dumps({**good, 'reader': reader}), encoding='utf-8')
            result = self.one(log)
            self.assertFalse(result['resumed'], reader)
            self.assertEqual(result['emitted'], 0, reader)
        self.assertEqual(recorded_input_tokens(self.root), 3000)
        codex = codex_log(self.dir / 'rollout.jsonl')
        self.one(codex, CALL, runtime=None)
        path = ingest_checkpoint.checkpoint_path(self.root, codex)
        good = read_json(path, {})
        for reader in ({'models': 'nope'}, {**good['reader'], 'models': {'turn-1': 3}}, {**good['reader'], 'stem': None}):
            path.write_text(json.dumps({**good, 'reader': reader}), encoding='utf-8')
            result = self.one(codex, CALL, runtime=None)
            self.assertFalse(result['resumed'], reader)
            self.assertEqual((result['emitted'], result['duplicates']), (0, 2), reader)

"""B5: session <-> per-call granularity transitions (was ``GranularityTransitionTests``)."""
from __future__ import annotations

import json

from orchestrator import ingest_checkpoint
from orchestrator.ingest import CALL, SESSION, ingest_file
from orchestrator.runtime import EventStore

from tests.ingest_checkpoint.helpers import (
    CheckpointTestCase, aggregate_row, append, ht_call, ht_session, ingest_rows, recorded_input_tokens, snapshot,
)

class GranularityTransitionTests(CheckpointTestCase):
    def test_per_call_after_session_rows_without_checkpoint_reconciles_the_exact_recorded_prefix(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        ingest_checkpoint.checkpoint_path(self.root, log).unlink()  # legacy state: rows but no checkpoint
        append(log, ht_call(3, tokens=10))
        result = self.one(log, CALL)
        self.assertEqual((result['emitted'], result['duplicates']), (1, 3))
        self.assertEqual(result['granularity_transition']['reconciled_calls'], 3)
        rows = [r for r in ingest_rows(self.root) if r['session_id'] == 'sess-1']
        self.assertEqual([r['granularity'] for r in rows], [SESSION, CALL])
        self.assertEqual(recorded_input_tokens(self.root), 3010)

    def test_per_call_after_a_session_checkpoint_resumes_after_the_recorded_prefix(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        append(log, ht_call(3, tokens=10) + ht_call(4, tokens=20))
        result = self.one(log, CALL)
        self.assertEqual((result['emitted'], result['duplicates']), (2, 3))
        transition = result['granularity_transition']
        self.assertEqual((transition['from'], transition['to']), (SESSION, CALL))
        rows = [r for r in ingest_rows(self.root) if r['session_id'] == 'sess-1']
        self.assertEqual([r['granularity'] for r in rows], [SESSION, CALL, CALL])
        self.assertEqual(recorded_input_tokens(self.root), 3030)
        self.assertEqual(self.checkpoint(log)['granularity'], CALL)
        self.assertEqual(self.one(log, CALL)['emitted'], 0)

    def test_per_call_skips_calls_another_ingester_aggregated_beyond_the_checkpoint(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        # a settled turn was appended and aggregated by another process; our checkpoint never saw it
        append(log, ht_call(3, tokens=10))
        EventStore(self.root).metric(**aggregate_row('sess-1', covers=1, input_tokens=10))
        append(log, ht_call(4, tokens=20))
        result = self.one(log, CALL)
        self.assertEqual((result['emitted'], result['duplicates']), (1, 4))
        self.assertEqual(ingest_rows(self.root)[-1]['input_tokens'], 20)
        self.assertEqual(recorded_input_tokens(self.root), 3030)

    def test_per_call_is_rejected_with_guidance_when_session_rows_match_no_source_prefix(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        EventStore(self.root).metric(**aggregate_row('sess-1', covers=2, input_tokens=1500))  # no prefix sums to this
        result = self.ingest(log, CALL)
        self.assertEqual(result['emitted'], 0)
        self.assertEqual(len(result['failures']), 1, result)
        error = result['failures'][0]['error']
        self.assertIn('sess-1', error)
        self.assertIn('--granularity session', error)
        self.assertEqual(recorded_input_tokens(self.root), 1500, 'nothing was appended')
        self.assertIsNone(self.checkpoint(log))
        with self.assertRaises(ValueError):
            ingest_file(log, state_root=self.root, granularity=CALL, runtime='humain-terminal')
        # Switching granularity cannot manufacture the missing identity evidence either.
        before = snapshot(self.root)
        fixed = self.ingest(log)
        self.assertEqual(len(fixed['failures']), 1)
        self.assertEqual(fixed['emitted'], 0)
        self.assertEqual(snapshot(self.root), before)

    def test_prefix_reconciliation_only_skips_calls_of_aggregated_sessions(self):
        log = self.dir / 'two-sessions.jsonl'
        with log.open('w', encoding='utf-8') as out:
            out.write(json.dumps({'type': 'session', 'id': 'sess-a'}) + '\n' + ht_call(0) + ht_call(1))
            out.write(json.dumps({'type': 'session', 'id': 'sess-b'}) + '\n' + ht_call(2, tokens=10) + ht_call(3, tokens=20))
        from orchestrator.ingest import call_id_for
        store = EventStore(self.root)
        store.metric(**aggregate_row('sess-a', covers=2, input_tokens=2000),
                     covered_call_ids=[call_id_for('humain-terminal', 'sess-a', 'asst-0'),
                                       call_id_for('humain-terminal', 'sess-a', 'asst-1')])
        store.metric(event='model_call', source='session_ingest', role='interactive_session', agent_runtime='humain-terminal',
                     session_id='sess-b', model='claude-sonnet-5', granularity=CALL,
                     call_id=call_id_for('humain-terminal', 'sess-b', 'asst-2'), input_tokens=10, output_tokens=100)
        result = self.one(log, CALL)
        self.assertEqual((result['emitted'], result['duplicates']), (1, 3))
        self.assertEqual(result['granularity_transition']['reconciled_calls'], 2)
        self.assertEqual(ingest_rows(self.root)[-1]['input_tokens'], 20)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-a'), 2000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-b'), 30)

    def test_session_after_per_call_emits_only_the_unrecorded_delta(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log, CALL)
        switched = self.one(log)
        self.assertEqual(switched['emitted'], 0)
        self.assertEqual((switched['granularity_transition']['from'], switched['granularity_transition']['to']), (CALL, SESSION))
        append(log, ht_call(3, tokens=10))
        result = self.one(log)
        self.assertEqual(result['emitted'], 1)
        self.assertNotIn('granularity_transition', result, 'the checkpoint already carries the new granularity')
        self.assertEqual(ingest_rows(self.root)[-1]['input_tokens'], 10)
        self.assertEqual(recorded_input_tokens(self.root), 3010)
        self.assertEqual(self.checkpoint(log)['granularity'], SESSION)

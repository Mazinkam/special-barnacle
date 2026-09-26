"""B5: ledger seeding/derivation and metrics-tail edge cases (was ``LedgerTests``,
``MetricsTailTests`` and ``MetricsRollbackTests``)."""
from __future__ import annotations

import json
from pathlib import Path

from orchestrator import ingest_checkpoint
from orchestrator.ingest import CALL, SESSION, ingest_paths
from orchestrator.runtime import EventStore

from tests.ingest_checkpoint.helpers import CheckpointTestCase, append, ht_call, ht_session, ingest_rows, recorded_input_tokens, snapshot

class LedgerTests(CheckpointTestCase):
    def _row(self, session: str, tokens: int, call_id: str, granularity: str = CALL) -> str:
        return json.dumps({'source': 'session_ingest', 'agent_runtime': 'humain-terminal', 'session_id': session,
                           'model': 'm', 'input_tokens': tokens, 'total_tokens': tokens, 'call_id': call_id,
                           'granularity': granularity, **({'covers_calls': 2} if granularity == SESSION else {})}) + '\n'

    def test_partial_ledger_seeded_from_checkpoints_at_different_offsets_matches_full_derivation(self):
        EventStore(self.root)
        metrics = self.root / 'metrics.jsonl'
        append(metrics, self._row('A', 1, 'a1') + self._row('B', 10, 'b1'))
        offset_a = metrics.stat().st_size
        ledger_a = ingest_checkpoint.IngestLedger(self.root); ledger_a.ensure({('humain-terminal', 'A')})
        seed_a = (ledger_a.export('humain-terminal', ['A']), ledger_a.metrics_state())
        append(metrics, self._row('A', 2, 'a2') + self._row('C', 100, 'c1') + self._row('B', 20, 'b2', SESSION))
        offset_b = metrics.stat().st_size
        ledger_b = ingest_checkpoint.IngestLedger(self.root); ledger_b.ensure({('humain-terminal', 'B')})
        seed_b = (ledger_b.export('humain-terminal', ['B']), ledger_b.metrics_state())
        self.assertEqual((seed_a[1]['offset'], seed_b[1]['offset']), (offset_a, offset_b))
        append(metrics, self._row('A', 3, 'a3') + self._row('B', 30, 'b3') + 'not json\n' + self._row('C', 200, 'c2')[:-5])

        partial = ingest_checkpoint.IngestLedger(self.root)
        self.assertTrue(partial.seed('humain-terminal', *seed_a))
        self.assertTrue(partial.seed('humain-terminal', *seed_b))
        partial.ensure({('humain-terminal', 'A'), ('humain-terminal', 'B')})
        partial.advance()
        self.assertEqual(partial.full_scans, 0, 'two seeded checkpoints and a suffix walk, no full derivation')
        full = ingest_checkpoint.IngestLedger(self.root); full.ensure({('humain-terminal', 'A')})
        self.assertEqual(full.full_scans, 1)
        self.assertEqual(partial.export('humain-terminal', ['A', 'B']), full.export('humain-terminal', ['A', 'B']))
        self.assertEqual(partial.export('humain-terminal', ['A'])['A']['models']['m']['input_tokens'], 6)
        self.assertEqual(partial.export('humain-terminal', ['B'])['B']['models']['m']['calls'], 4)  # 1 + 2 (covers) + 1
        self.assertEqual(partial.metrics_state()['offset'], full.metrics_state()['offset'])
        self.assertLess(partial.metrics_state()['offset'], metrics.stat().st_size, 'the torn last line is not part of the prefix')
        # an untracked session forces the upgrade to a full derivation, once
        partial.ensure({('humain-terminal', 'C')})
        self.assertEqual(partial.full_scans, 1)
        self.assertEqual(partial.export('humain-terminal', ['C']), full.export('humain-terminal', ['C']))

    def test_seed_rejects_a_checkpoint_whose_metrics_prefix_no_longer_exists(self):
        EventStore(self.root)
        metrics = self.root / 'metrics.jsonl'
        append(metrics, self._row('A', 1, 'a1'))
        ledger = ingest_checkpoint.IngestLedger(self.root); ledger.ensure({('humain-terminal', 'A')})
        recorded, state = ledger.export('humain-terminal', ['A']), ledger.metrics_state()
        metrics.write_text(self._row('A', 5, 'a9'), encoding='utf-8')  # same size, different content
        fresh = ingest_checkpoint.IngestLedger(self.root)
        self.assertFalse(fresh.seed('humain-terminal', recorded, state))
        fresh.ensure({('humain-terminal', 'A')})
        self.assertEqual(fresh.export('humain-terminal', ['A'])['A']['call_ids'], ['a9'])
        metrics.unlink()
        gone = ingest_checkpoint.IngestLedger(self.root)
        self.assertFalse(gone.seed('humain-terminal', recorded, state))
        gone.ensure({('humain-terminal', 'A')}); gone.advance()
        self.assertEqual(gone.export('humain-terminal', ['A'])['A']['call_ids'], [])


class MetricsTailTests(CheckpointTestCase):
    """Finding 1: a complete aggregate row missing only its newline is recorded usage, not a torn line."""

    def _drop_trailing_newline(self) -> Path:
        metrics = self.root / 'metrics.jsonl'
        data = metrics.read_bytes()
        self.assertTrue(data.endswith(b'\n'))
        metrics.write_bytes(data[:-1])  # an interrupted append that lost only the separator
        return metrics

    def test_aggregate_row_missing_its_newline_is_not_charged_again_when_the_source_grows(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        metrics = self._drop_trailing_newline()
        append(log, ht_call(3, tokens=400))
        result = self.one(log)
        self.assertEqual(result['emitted'], 1)
        self.assertTrue(metrics.read_bytes().endswith(b'\n'), 'the writer terminated the tail before appending')
        rows = [r for r in ingest_rows(self.root) if r['session_id'] == 'sess-1']
        self.assertEqual([r['input_tokens'] for r in rows], [3000, 400], 'only the new call was charged')
        self.assertEqual(recorded_input_tokens(self.root), 3400)
        # the same picture, without the lock or a write, for a dry run of a multi-file sweep
        self._drop_trailing_newline()
        append(log, ht_call(4, tokens=50))
        other = ht_session(self.dir / 'other.jsonl', 2, session='sess-o')
        before = snapshot(self.root)
        preview = ingest_paths([log, other, log], state_root=self.root, granularity=SESSION, runtime='humain-terminal', dry_run=True)
        self.assertEqual(preview['failures'], [])
        self.assertEqual([f['emitted'] for f in preview['files']], [1, 1, 0])
        self.assertEqual(snapshot(self.root), before, 'a dry run writes nothing, not even the missing newline')
        real = self.one(log)
        self.assertEqual(real['emitted'], 1)
        self.assertEqual(ingest_rows(self.root)[-1]['input_tokens'], 50)
        self.assertAlmostEqual(preview['files'][0]['estimated_cost_usd'], real['estimated_cost_usd'], places=9,
                               msg='the dry run priced the same 50-token delta the real run wrote')
        self.assertEqual(recorded_input_tokens(self.root), 3450)


class MetricsRollbackTests(CheckpointTestCase):
    """Finding 2: a per-call source checkpoint is only as good as the metrics prefix it was verified against."""

    def test_restored_metrics_replays_the_calls_a_per_call_checkpoint_claimed_were_recorded(self):
        log = ht_session(self.dir / 'session.jsonl', 3, session='sess-c')
        self.one(log, CALL)
        metrics = self.root / 'metrics.jsonl'
        empty = b''
        metrics.write_bytes(empty)  # an older snapshot of metrics.jsonl was restored
        result = self.one(log, CALL)
        self.assertFalse(result['resumed'], 'the checkpoint prefix no longer describes what is recorded')
        self.assertEqual((result['emitted'], result['duplicates']), (3, 0))
        ids = [r['call_id'] for r in ingest_rows(self.root)]
        self.assertEqual((len(ids), len(set(ids))), (3, 3))
        self.assertEqual(recorded_input_tokens(self.root, 'sess-c'), 3000)
        # ... also when another file of the sweep already derived the whole (rolled-back) stream
        restored = metrics.read_bytes()
        a = ht_session(self.dir / 'a.jsonl', 2, session='sess-a')
        b = ht_session(self.dir / 'b.jsonl', 2, session='sess-b')
        sweep = ingest_paths([a, b], state_root=self.root, granularity=CALL, runtime='humain-terminal')
        self.assertEqual((sweep['emitted'], sweep['failures']), (4, []))
        metrics.write_bytes(restored)
        ingest_checkpoint.checkpoint_path(self.root, a).unlink()  # a is derived from byte 0; b still has its checkpoint
        again = ingest_paths([a, b], state_root=self.root, granularity=CALL, runtime='humain-terminal')
        self.assertEqual(again['failures'], [])
        self.assertEqual([f['emitted'] for f in again['files']], [2, 2])
        self.assertFalse(again['files'][1]['resumed'])
        ids = [r['call_id'] for r in ingest_rows(self.root)]
        self.assertEqual((len(ids), len(set(ids))), (7, 7))

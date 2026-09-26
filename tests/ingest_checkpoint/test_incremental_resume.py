"""B5: unchanged/second-import resume behaviour (was ``UnchangedSessionTests``)."""
from __future__ import annotations

import json
from unittest.mock import patch

from orchestrator import ingest_checkpoint
from orchestrator.ingest import CALL, SESSION, ingest_paths
from orchestrator.runtime import EventStore

from tests.ingest_checkpoint.helpers import (
    CheckpointTestCase, append, ht_call, ht_session, ingest_rows, recorded_input_tokens,
)
from tests.test_ingest import codex_log


class UnchangedSessionTests(CheckpointTestCase):
    def test_second_import_of_an_unchanged_session_replays_neither_source_nor_history(self):
        log = ht_session(self.dir / 'session.jsonl', 300)
        # ~1 MiB of unrelated history: the second import must not rescan it.
        EventStore(self.root)
        with (self.root / 'metrics.jsonl').open('a', encoding='utf-8') as out:
            for i in range(6000):
                out.write(json.dumps({'ts': 't', 'event': 'model_call', 'run_id': f'R{i}', 'model': 'm', 'input_tokens': 1,
                                      'output_tokens': 1, 'record_id': f'h-{i}', 'cost_source': 'unmetered', 'pad': 'x' * 120}) + '\n')
        first = self.one(log)
        self.assertEqual(first['emitted'], 1)
        self.assertEqual(recorded_input_tokens(self.root), 300 * 1000)
        ckpt_file = ingest_checkpoint.checkpoint_path(self.root, log)
        ckpt_inode = ckpt_file.stat().st_ino

        from tests.record_io_probe import IoMeterUnsupported, measure_io
        try:
            with measure_io() as counts:
                second = self.one(log)
        except IoMeterUnsupported:
            counts = None
            second = self.one(log)
        self.assertEqual(second['emitted'], 0)
        self.assertEqual(second['duplicates'], 1)
        self.assertEqual(second['usage_rows'], 300)
        self.assertTrue(second['resumed'], second)
        self.assertEqual(second['scanned_from'], log.stat().st_size, 'no source line was re-read')
        self.assertEqual(recorded_input_tokens(self.root), 300 * 1000)
        self.assertEqual(ckpt_file.stat().st_ino, ckpt_inode, 'an unchanged session does not rewrite its checkpoint')
        if counts is not None:
            self.assertLess(counts['read'], 64 * 1024,
                            f'unchanged re-import read {counts["read"]} bytes; session is {log.stat().st_size}, '
                            f'history is {(self.root / "metrics.jsonl").stat().st_size}')

    def test_unchanged_codex_does_not_scan_metrics_for_source_reconciliation(self):
        log = codex_log(self.dir / 'rollout.jsonl')
        self.one(log, CALL, runtime=None)
        # A valid checkpoint covers every call; source_states would upgrade its partial
        # ledger to a full metrics scan even though there is nothing to reconcile.
        with patch.object(ingest_checkpoint.IngestLedger, '_full_scan',
                          side_effect=AssertionError('unchanged Codex scanned full metrics history')):
            result = self.one(log, CALL, runtime=None)
        self.assertTrue(result['resumed'])
        self.assertEqual((result['emitted'], result['duplicates']), (0, 2))

    def test_per_call_second_import_is_also_incremental(self):
        log = ht_session(self.dir / 'session.jsonl', 40)
        first = self.one(log, CALL)
        self.assertEqual(first['emitted'], 40)
        second = self.one(log, CALL)
        self.assertEqual((second['emitted'], second['duplicates'], second['usage_rows']), (0, 40, 40))
        self.assertTrue(second['resumed'])
        self.assertEqual(second['scanned_from'], log.stat().st_size)
        self.assertEqual(len(ingest_rows(self.root)), 40)

    def test_growth_reads_only_the_new_lines_and_emits_only_the_delta(self):
        log = ht_session(self.dir / 'session.jsonl', 5)
        self.one(log)
        size = log.stat().st_size
        append(log, ht_call(5, tokens=700) + ht_call(6, tokens=300))
        delta = self.one(log)
        self.assertEqual(delta['emitted'], 1)
        self.assertEqual(delta['scanned_from'], size)
        rows = ingest_rows(self.root)
        self.assertEqual(rows[-1]['input_tokens'], 1000)
        self.assertEqual(rows[-1]['covers_calls'], 2)
        self.assertEqual(recorded_input_tokens(self.root), 5 * 1000 + 1000)
        per_call = ht_session(self.dir / 'calls.jsonl', 3, session='sess-c')
        self.one(per_call, CALL)
        append(per_call, ht_call(3) + ht_call(4))
        grown = self.one(per_call, CALL)
        self.assertEqual((grown['emitted'], grown['duplicates']), (2, 3))
        self.assertEqual(len([r for r in ingest_rows(self.root) if r['session_id'] == 'sess-c']), 5)

    def test_checkpoint_records_identity_offset_granularity_and_reconstructible_dedup_state(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        self.one(log)
        ckpt = self.checkpoint(log)
        self.assertIsNotNone(ckpt)
        stat = log.stat()
        self.assertEqual(ckpt['format_version'], ingest_checkpoint.FORMAT_VERSION)
        self.assertEqual(ckpt['source'], str(log))
        self.assertEqual(ckpt['identity'], [stat.st_dev, stat.st_ino])
        self.assertEqual(ckpt['offset'], stat.st_size)
        self.assertEqual(ckpt['granularity'], SESSION)
        self.assertEqual(ckpt['runtime'], 'humain-terminal')
        # dedup state == what an independent scan of metrics.jsonl says
        rebuilt = ingest_checkpoint.IngestLedger(self.root)
        rebuilt.ensure({('humain-terminal', 'sess-1')})
        self.assertEqual(ckpt['recorded'], rebuilt.export('humain-terminal', ['sess-1']))
        self.assertEqual(ckpt['metrics']['offset'], (self.root / 'metrics.jsonl').stat().st_size)

    def test_multi_file_sweep_with_checkpoints_reads_no_source_and_emits_nothing(self):
        a = ht_session(self.dir / 'a.jsonl', 10, session='sess-a')
        b = ht_session(self.dir / 'b.jsonl', 10, session='sess-b')
        first = ingest_paths([a, b], state_root=self.root, granularity=SESSION, runtime='humain-terminal')
        self.assertEqual(first['emitted'], 2)
        append(b, ht_call(10, tokens=50))
        second = ingest_paths([a, b], state_root=self.root, granularity=SESSION, runtime='humain-terminal')
        self.assertEqual(second['failures'], [])
        self.assertEqual(second['emitted'], 1)
        self.assertTrue(all(f['resumed'] for f in second['files']), second['files'])
        self.assertEqual(second['files'][0]['scanned_from'], a.stat().st_size)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-a'), 10_000)
        self.assertEqual(recorded_input_tokens(self.root, 'sess-b'), 10_050)
        third = ingest_paths([a, b], state_root=self.root, granularity=SESSION, runtime='humain-terminal')
        self.assertEqual((third['emitted'], third['failures']), (0, []))

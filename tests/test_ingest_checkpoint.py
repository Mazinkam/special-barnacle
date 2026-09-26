"""Incremental, concurrency-safe session ingestion.

Every test uses a throwaway state root and copied/synthetic session logs. The checkpoint under
test is a derived cache: whatever happens to it (missing, stale, corrupt, crash before it is
written), the authoritative ``metrics.jsonl`` must end up holding every token exactly once.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from orchestrator import ingest_checkpoint
from orchestrator.ingest import checkpoint as ingest_checkpoint_impl
from orchestrator.ingest import CALL, SESSION, ingest_file, ingest_paths
from orchestrator.record_batch import BatchAppendError, settle_streams, write_batch
from orchestrator.runtime import EventStore, load_jsonl, read_json
from tests.test_ingest import codex_log

REPO = Path(__file__).resolve().parents[1]


def env_for(root: Path) -> dict[str, str]:
    return {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(root), 'CODING_AGENT_RUNTIME': 'humain-terminal',
            'CODING_AGENT_REPOSITORY': '/work/forge', 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'}


def ht_call(i: int, *, tokens: int = 1000, model: str = 'claude-sonnet-5') -> str:
    return json.dumps({'type': 'message', 'id': f'asst-{i}', 'timestamp': f'2026-09-21T10:00:{i % 60:02d}.000Z',
                       'message': {'role': 'assistant', 'model': model, 'provider': 'humain-node',
                                   'usage': {'input': tokens, 'output': 100, 'cacheRead': 0, 'cacheWrite': 0,
                                             'cacheWrite1h': 0, 'reasoning': 0, 'totalTokens': tokens + 100}}}) + '\n'


def ht_session(path: Path, calls: int, *, session: str = 'sess-1', start: int = 0, tokens: int = 1000) -> Path:
    with path.open('w', encoding='utf-8') as out:
        out.write(json.dumps({'type': 'session', 'id': session}) + '\n')
        for i in range(start, start + calls):
            out.write(ht_call(i, tokens=tokens))
    return path


def append(path: Path, text: str) -> None:
    with path.open('a', encoding='utf-8') as out:
        out.write(text)


def ingest_rows(root: Path) -> list[dict]:
    return [r for r in load_jsonl(root / 'metrics.jsonl') if r.get('source') == 'session_ingest']


def recorded_input_tokens(root: Path, session: str = 'sess-1') -> int:
    return sum(int(r.get('input_tokens') or 0) for r in ingest_rows(root) if r.get('session_id') == session)


def snapshot(root: Path) -> dict[str, bytes]:
    if not root.exists():
        return {}
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


class CheckpointTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.root = self.dir / 'state'
        self._env = patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(self.root),
                                            'CODING_AGENT_RUNTIME': 'humain-terminal',
                                            'CODING_AGENT_REPOSITORY': '/work/forge'})
        self._env.start()
        self.addCleanup(self._env.stop)

    def ingest(self, log: Path, granularity: str = SESSION, runtime: str | None = 'humain-terminal', **kw) -> dict:
        return ingest_paths([log], state_root=self.root, granularity=granularity, runtime=runtime, **kw)

    def one(self, log: Path, granularity: str = SESSION, **kw) -> dict:
        result = self.ingest(log, granularity, **kw)
        self.assertEqual(result['failures'], [], result)
        return result['files'][0]

    def checkpoint(self, log: Path) -> dict | None:
        return ingest_checkpoint.load_checkpoint(self.root, log)


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


def aggregate_row(session: str, *, covers: int, input_tokens: int, call_id: str = 'other-agg') -> dict:
    """A session-level row as another (possibly legacy) ingester would have written it."""
    return dict(event='model_call', source='session_ingest', role='interactive_session', agent_runtime='humain-terminal',
                session_id=session, model='claude-sonnet-5', granularity=SESSION, covers_calls=covers, call_id=call_id,
                input_tokens=input_tokens, output_tokens=100 * covers, cached_input_tokens=0, cache_write_tokens=0,
                reasoning_output_tokens=0, total_tokens=input_tokens + 100 * covers)


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


class ConcurrencyTests(CheckpointTestCase):
    def _spawn(self, log: Path, granularity: str, n: int) -> list[subprocess.CompletedProcess]:
        script = textwrap.dedent('''
            import sys, time
            from orchestrator.cli import main
            deadline = float(sys.argv[1])
            time.sleep(max(0.0, deadline - time.time()))
            sys.argv = ['orchestrator', 'ingest', sys.argv[2], '--runtime', 'humain-terminal', '--granularity', sys.argv[3], '--quiet']
            main()
        ''')
        import time
        deadline = time.time() + 1.5
        procs = [subprocess.Popen([sys.executable, '-B', '-c', script, str(deadline), str(log), granularity],
                                  env=env_for(self.root), cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for _ in range(n)]
        results = []
        for proc in procs:
            out, err = proc.communicate(timeout=120)
            results.append(subprocess.CompletedProcess(proc.args, proc.returncode, out, err))
        return results

    def test_competing_promotions_write_one_binding_even_without_new_metrics(self):
        for promoted_calls in (1, 2):
            with self.subTest(promoted_calls=promoted_calls):
                self.root = self.dir / f'state-{promoted_calls}'
                log = self.dir / f'{promoted_calls}_sessA.jsonl'
                log.write_text(ht_call(0), encoding='utf-8')
                first = self.one(log, CALL)
                ht_session(log, promoted_calls, session='sess-B')
                ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                results = self._spawn(log, CALL, 3)
                self.assertEqual([r.returncode for r in results], [0] * 3, [r.stderr for r in results])
                self.assertEqual(sum(json.loads(r.stdout)['emitted'] for r in results), promoted_calls - 1)
                self.assertEqual(recorded_input_tokens(self.root, 'sess-B'), (promoted_calls - 1) * 1000)
                bindings = [row for row in load_jsonl(self.root / 'events.jsonl')
                            if row.get('event') == 'session_ingest_promotion']
                self.assertEqual(len(bindings), 1)
                cost = sum(float(row.get('cost_usd') or 0) for row in ingest_rows(self.root))
                self.assertAlmostEqual(cost, first['estimated_cost_usd'] * promoted_calls)
                ingest_checkpoint.checkpoint_path(self.root, log).unlink()
                ht_session(log, 2, session='sess-C')
                self.one(log, CALL)
                self.assertEqual(recorded_input_tokens(self.root, 'sess-C'), 2000)

    def test_competing_processes_record_a_session_exactly_once(self):
        log = ht_session(self.dir / 'session.jsonl', 30)
        results = self._spawn(log, SESSION, 4)
        self.assertEqual([r.returncode for r in results], [0] * 4, [r.stderr for r in results])
        rows = ingest_rows(self.root)
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(recorded_input_tokens(self.root), 30_000)
        self.assertEqual(sum(json.loads(r.stdout)['emitted'] for r in results), 1)

    def test_competing_per_call_processes_write_each_call_once(self):
        log = ht_session(self.dir / 'session.jsonl', 30, session='sess-c')
        results = self._spawn(log, CALL, 4)
        self.assertEqual([r.returncode for r in results], [0] * 4, [r.stderr for r in results])
        ids = [r['call_id'] for r in ingest_rows(self.root)]
        self.assertEqual(len(ids), 30)
        self.assertEqual(len(set(ids)), 30)

    def test_competing_threads_with_independent_ledgers_never_double_count(self):
        log = ht_session(self.dir / 'session.jsonl', 20)
        barrier = threading.Barrier(4)
        errors: list[BaseException] = []

        def worker():
            try:
                barrier.wait(timeout=10)
                ingest_paths([log], state_root=self.root, granularity=SESSION, runtime='humain-terminal')
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads: t.start()
        for t in threads: t.join(timeout=60)
        self.assertEqual(errors, [])
        self.assertEqual(len(ingest_rows(self.root)), 1)
        self.assertEqual(recorded_input_tokens(self.root), 20_000)


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


class DryRunTests(CheckpointTestCase):
    def test_cli_dry_run_creates_no_state(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        argv = [sys.executable, '-B', '-m', 'orchestrator.cli', 'ingest', str(log), '--runtime', 'humain-terminal', '--granularity', 'session', '--dry-run', '--quiet']
        run = subprocess.run(argv, env=env_for(self.root), cwd=str(REPO), capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)['emitted'], 1)
        self.assertFalse(self.root.exists(), 'a CLI dry run creates nothing, not even the root')
        self.one(log)
        append(log, ht_call(3))
        before = snapshot(self.root)
        run = subprocess.run(argv, env=env_for(self.root), cwd=str(REPO), capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)['emitted'], 1)
        self.assertEqual(snapshot(self.root), before)

    def test_dry_run_sweep_dedups_in_memory_like_a_real_sweep(self):
        a = ht_session(self.dir / 'a.jsonl', 3, session='sess-a')
        b = ht_session(self.dir / 'b.jsonl', 2, session='sess-b')
        for granularity in (SESSION, CALL):
            preview = ingest_paths([a, b, a], state_root=self.root, granularity=granularity, runtime='humain-terminal', dry_run=True)
            self.assertEqual(preview['failures'], [])
            expected = [1, 1, 0] if granularity == SESSION else [3, 2, 0]
            self.assertEqual([f['emitted'] for f in preview['files']], expected, granularity)
            self.assertEqual(preview['files'][2]['duplicates'], 1 if granularity == SESSION else 3)
            self.assertFalse(self.root.exists())
        real = ingest_paths([a, b, a], state_root=self.root, granularity=SESSION, runtime='humain-terminal')
        self.assertEqual([f['emitted'] for f in real['files']], [1, 1, 0])


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


class WriterInterfaceTests(CheckpointTestCase):
    def test_write_batch_can_run_under_a_lock_the_caller_already_holds(self):
        from orchestrator.runtime import writer_lock
        EventStore(self.root)
        with writer_lock(self.root):
            result = write_batch(self.root, [{'stream': 'metric', 'record_id': 'x-1', 'event': 'model_call'}], refresh=False, lock=False)
        self.assertEqual(result['persisted']['metric'], 1)
        with self.assertRaises(ValueError):
            write_batch(self.root, [{'stream': 'metric', 'record_id': 'x-2'}], refresh=True, lock=False)

    def test_ingest_cli_reports_conflicts_on_stderr_and_exits_nonzero_when_nothing_could_be_ingested(self):
        log = ht_session(self.dir / 'session.jsonl', 3)
        ok = subprocess.run([sys.executable, '-B', '-m', 'orchestrator.cli', 'ingest', str(log), '--granularity', 'session', '--quiet'],
                            env=env_for(self.root), cwd=str(REPO), capture_output=True, text=True, timeout=120)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(json.loads(ok.stdout)['emitted'], 1)
        EventStore(self.root).metric(**aggregate_row('sess-1', covers=1, input_tokens=123))  # no prefix of the log sums to this
        conflict = subprocess.run([sys.executable, '-B', '-m', 'orchestrator.cli', 'ingest', str(log), '--granularity', 'call', '--quiet'],
                                  env=env_for(self.root), cwd=str(REPO), capture_output=True, text=True, timeout=120)
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn('--granularity session', conflict.stderr)
        body = json.loads(conflict.stdout)
        self.assertEqual(len(body['failures']), 1)
        self.assertEqual(recorded_input_tokens(self.root), 3123)


if __name__ == '__main__':
    unittest.main()

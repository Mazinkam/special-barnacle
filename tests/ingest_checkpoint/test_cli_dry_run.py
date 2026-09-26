"""B5: CLI/dry-run behaviour and the ``write_batch`` writer interface (was ``DryRunTests`` and
``WriterInterfaceTests``)."""
from __future__ import annotations

import json
import subprocess
import sys

from orchestrator.ingest import CALL, SESSION, ingest_paths
from orchestrator.record_batch import write_batch
from orchestrator.runtime import EventStore

from tests.ingest_checkpoint.helpers import (
    CheckpointTestCase, REPO, aggregate_row, append, env_for, ht_call, ht_session, recorded_input_tokens, snapshot,
)

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

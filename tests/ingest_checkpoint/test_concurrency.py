"""B5: concurrent processes/threads racing the same checkpoint (was ``ConcurrencyTests``)."""
from __future__ import annotations

import json
import subprocess
import sys
import textwrap
import threading
from pathlib import Path

from orchestrator import ingest_checkpoint
from orchestrator.ingest import CALL, SESSION, ingest_paths
from orchestrator.runtime import load_jsonl

from tests.ingest_checkpoint.helpers import CheckpointTestCase, REPO, env_for, ht_call, ht_session, ingest_rows, recorded_input_tokens

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

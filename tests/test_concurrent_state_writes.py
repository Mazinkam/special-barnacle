import json
import multiprocessing
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from orchestrator.runtime import EventStore, write_json


def _rebuild_with_pause(
    root, role, first_paused, release_first, second_started, second_entered,
    second_lock_attempted, second_lock_acquired,
):
    import fcntl
    from orchestrator.state import rebuild, reduce_event

    original_reduce_event = reduce_event
    original_flock = fcntl.flock

    def observed_flock(fd, operation):
        if role == "second" and operation == fcntl.LOCK_EX:
            second_lock_attempted.set()
            original_flock(fd, operation)
            second_lock_acquired.set()
        else:
            original_flock(fd, operation)

    def controlled_reduce_event(state, event):
        if role == "first" and event.get("run_id") == "R1":
            first_paused.set()
            if not release_first.wait(timeout=10):
                raise TimeoutError("test did not release the first rebuild")
        if role == "second" and event.get("run_id") == "R2":
            second_entered.set()
        return original_reduce_event(state, event)

    with patch("orchestrator.runtime.fcntl.flock", observed_flock):
        with patch("orchestrator.state.reduce_event", controlled_reduce_event):
            if role == "second":
                second_started.set()
            rebuild(root)


def _append_batch_with_observed_lock(root, records, started, lock_attempted, lock_acquired, result_queue):
    import fcntl
    from orchestrator.record_batch import write_batch

    original_flock = fcntl.flock

    def observed_flock(fd, operation):
        if operation == fcntl.LOCK_EX:
            lock_attempted.set()
            original_flock(fd, operation)
            lock_acquired.set()
        else:
            original_flock(fd, operation)

    with patch("orchestrator.runtime.fcntl.flock", observed_flock):
        started.set()
        result_queue.put(write_batch(root, records))


class ConcurrentStateWriteTests(unittest.TestCase):
    def test_concurrent_json_writes_use_independent_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "ledger.json")
            replace_barrier = threading.Barrier(2)
            original_replace = Path.replace

            def synchronized_replace(source, target):
                replace_barrier.wait(timeout=5)
                return original_replace(source, target)

            with patch.object(Path, "replace", synchronized_replace):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    writes = [
                        pool.submit(write_json, path, {"writer": number})
                        for number in (1, 2)
                    ]
                    for write in writes:
                        write.result(timeout=5)

            self.assertIn(json.loads(path.read_text())["writer"], (1, 2))

    def test_concurrent_process_rebuilds_do_not_leave_ledger_stale(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(directory)
            store.emit("run_started", run_id="R1")
            # Appends share the writer lock with rebuilds, so R2 is written before the first
            # rebuild is paused while holding that lock.
            store.emit("run_started", run_id="R2")
            context = multiprocessing.get_context("spawn")
            first_paused = context.Event()
            release_first = context.Event()
            second_started = context.Event()
            second_entered = context.Event()
            second_lock_attempted = context.Event()
            second_lock_acquired = context.Event()
            first = context.Process(
                target=_rebuild_with_pause,
                args=(directory, "first", first_paused, release_first, second_started,
                      second_entered, second_lock_attempted, second_lock_acquired),
            )
            second = context.Process(
                target=_rebuild_with_pause,
                args=(directory, "second", first_paused, release_first, second_started,
                      second_entered, second_lock_attempted, second_lock_acquired),
            )

            first.start()
            second_entered_while_first_paused = None
            try:
                self.assertTrue(first_paused.wait(timeout=10))
                second.start()
                self.assertTrue(second_started.wait(timeout=10))
                self.assertTrue(second_lock_attempted.wait(timeout=10))
                second_acquired_while_first_paused = second_lock_acquired.wait(timeout=0.25)
                second_entered_while_first_paused = second_entered.is_set()
            finally:
                release_first.set()
                first.join(timeout=10)
                if second.pid is not None:
                    second.join(timeout=10)
                for process in (first, second):
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=5)

            self.assertEqual(first.exitcode, 0)
            self.assertEqual(second.exitcode, 0)
            self.assertFalse(
                second_acquired_while_first_paused,
                "the second process must block on the ledger lock until the first snapshot is written",
            )
            self.assertFalse(second_entered_while_first_paused)
            ledger = json.loads(Path(directory, "ledger.json").read_text())
            self.assertEqual(set(ledger["runs"]), {"R1", "R2"})

    def test_batch_append_blocks_on_the_writer_lock_while_a_rebuild_is_in_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(directory)
            store.emit("run_started", run_id="R1")
            context = multiprocessing.get_context("spawn")
            first_paused = context.Event()
            release_first = context.Event()
            unused = [context.Event() for _ in range(4)]
            appender_started = context.Event()
            appender_lock_attempted = context.Event()
            appender_lock_acquired = context.Event()
            results = context.Queue()
            records = [
                {"stream": "event", "record_id": "cc-1", "event": "run_started", "run_id": "R2"},
                {"stream": "metric", "record_id": "cc-2", "event": "model_call", "run_id": "R2", "model": "gpt-4o",
                 "input_tokens": 1, "output_tokens": 1},
            ]
            rebuilder = context.Process(
                target=_rebuild_with_pause,
                args=(directory, "first", first_paused, release_first, *unused),
            )
            appender = context.Process(
                target=_append_batch_with_observed_lock,
                args=(directory, records, appender_started, appender_lock_attempted, appender_lock_acquired, results),
            )

            rebuilder.start()
            try:
                self.assertTrue(first_paused.wait(timeout=10))
                appender.start()
                self.assertTrue(appender_started.wait(timeout=10))
                self.assertTrue(appender_lock_attempted.wait(timeout=10))
                acquired_while_rebuild_paused = appender_lock_acquired.wait(timeout=0.25)
                events_while_paused = Path(directory, "events.jsonl").read_text()
            finally:
                release_first.set()
                rebuilder.join(timeout=10)
                if appender.pid is not None:
                    appender.join(timeout=10)
                for process in (rebuilder, appender):
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=5)

            self.assertEqual(rebuilder.exitcode, 0)
            self.assertEqual(appender.exitcode, 0)
            self.assertFalse(acquired_while_rebuild_paused, "append must wait for the in-progress rebuild's lock")
            self.assertNotIn("cc-1", events_while_paused)
            result = results.get(timeout=5)
            self.assertTrue(result["ok"])
            self.assertEqual(result["persisted"], {"event": 1, "metric": 1, "outcome": 0})
            ledger = json.loads(Path(directory, "ledger.json").read_text())
            self.assertEqual(set(ledger["runs"]), {"R1", "R2"}, "the acknowledged append must be visible in the published ledger")
            events_path = Path(directory, "events.jsonl")
            self.assertEqual(ledger["checkpoint"]["events_offset"], events_path.stat().st_size)
            self.assertEqual(events_path.read_text().count("cc-1"), 1)


if __name__ == "__main__":
    unittest.main()

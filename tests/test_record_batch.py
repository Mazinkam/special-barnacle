"""Durable coordinated batch writes: validation, ordering, idempotent retries, and recovery.

Every test runs against a throwaway state root. Cross-process cases spawn the real CLI (or a
small child script) with ``CODING_AGENT_ORCHESTRATOR_HOME`` pointed at that root, so the lock,
checkpoint and ledger behaviour is exercised across process boundaries rather than in-process.
"""
from __future__ import annotations

import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from orchestrator.runtime import EventStore, load_jsonl, read_json

REPO = Path(__file__).resolve().parents[1]
STREAM_FILES = {"event": "events.jsonl", "metric": "metrics.jsonl", "outcome": "outcomes.jsonl"}


def cli_env(root: Path) -> dict[str, str]:
    return {
        **os.environ,
        "CODING_AGENT_ORCHESTRATOR_HOME": str(root),
        "CODING_AGENT_RUNTIME": "batch-test",
        "CODING_AGENT_REPOSITORY": "/work/forge",
        "PYTHONPATH": str(REPO),
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def run_cli(root: Path, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-B", "-m", "orchestrator.cli", *args],
        input=stdin, capture_output=True, text=True, env=cli_env(root), cwd=str(REPO), timeout=60,
    )


def run_batch(root: Path, records: list, *, as_argument: bool = False) -> subprocess.CompletedProcess:
    payload = json.dumps(records)
    if as_argument:
        return run_cli(root, "batch", payload)
    return run_cli(root, "batch", stdin=payload)


def stream_ids(root: Path, stream: str) -> list[str]:
    return [row.get("record_id") for row in load_jsonl(root / STREAM_FILES[stream])]


def sample_batch() -> list[dict]:
    return [
        {"stream": "event", "record_id": "e-1", "event": "run_started", "run_id": "R1"},
        {"stream": "metric", "record_id": "m-1", "event": "model_call", "run_id": "R1", "task_id": "T1",
         "model": "claude-sonnet-4-5", "input_tokens": 100, "output_tokens": 50},
        {"stream": "event", "record_id": "e-2", "event": "task_created", "run_id": "R1", "task_id": "T1"},
        {"stream": "outcome", "record_id": "o-1", "run_id": "R1", "task_id": "T1", "outcome": "verified"},
        {"stream": "event", "record_id": "e-3", "event": "task_completed", "run_id": "R1", "task_id": "T1"},
    ]


def strip_volatile(ledger: dict) -> dict:
    return {k: v for k, v in ledger.items() if k not in {"checkpoint"}}


class TemporaryRootTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name, "state")
        self.addCleanup(self._tmp.cleanup)


class BatchCliTests(TemporaryRootTestCase):
    def test_batch_persists_streams_in_order_and_refreshes_ledger_and_dashboard(self):
        result = run_batch(self.root, sample_batch())
        self.assertEqual(result.returncode, 0, result.stderr)
        body = json.loads(result.stdout)
        self.assertTrue(body["ok"])
        self.assertEqual(body["persisted"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertEqual(body["duplicates"], {"event": 0, "metric": 0, "outcome": 0})
        self.assertTrue(body["ledger_updated"])
        self.assertTrue(body["dashboard_updated"])

        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        self.assertEqual(stream_ids(self.root, "metric"), ["m-1"])
        self.assertEqual(stream_ids(self.root, "outcome"), ["o-1"])
        events = load_jsonl(self.root / "events.jsonl")
        self.assertNotIn("stream", events[0])
        self.assertEqual(events[0]["agent_runtime"], "batch-test")
        self.assertEqual(events[0]["repository"], "/work/forge")
        self.assertIn("ts", events[0])
        metric = load_jsonl(self.root / "metrics.jsonl")[0]
        self.assertIn("cost_source", metric, "metric records must pass through the shared meter")

        ledger = read_json(self.root / "ledger.json", None)
        self.assertEqual(ledger["runs"]["R1"]["status"], "running")
        self.assertEqual(ledger["tasks"]["T1"]["status"], "completed")
        self.assertEqual(ledger["checkpoint"]["events_offset"], (self.root / "events.jsonl").stat().st_size)
        self.assertTrue((self.root / "dashboard.html").exists())

    def test_batch_accepts_payload_argument_and_records_object(self):
        result = run_batch(self.root, sample_batch()[:1], as_argument=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = run_cli(self.root, "batch", stdin=json.dumps({"records": sample_batch()[1:2]}))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stream_ids(self.root, "event"), ["e-1"])
        self.assertEqual(stream_ids(self.root, "metric"), ["m-1"])

    def test_unsupported_stream_rejects_the_whole_batch(self):
        records = sample_batch()
        records.insert(2, {"stream": "discovery", "record_id": "d-1", "note": "nope"})
        result = run_batch(self.root, records)
        self.assertEqual(result.returncode, 1)
        body = json.loads(result.stdout)
        self.assertFalse(body["ok"])
        self.assertIn("discovery", body["error"])
        self.assertEqual(body["persisted"], {"event": 0, "metric": 0, "outcome": 0})
        for stream in STREAM_FILES:
            self.assertEqual(stream_ids(self.root, stream), [], stream)
        self.assertFalse((self.root / "ledger.json").exists())

    def test_malformed_record_rejects_the_whole_batch(self):
        cases = {
            "missing record_id": {"stream": "event", "event": "run_started", "run_id": "R1"},
            "empty record_id": {"stream": "event", "record_id": "", "event": "run_started"},
            "event without name": {"stream": "event", "record_id": "x-1", "run_id": "R1"},
            "not an object": "run_started",
            "list payload": ["stream", "event"],
        }
        for label, bad in cases.items():
            with self.subTest(label):
                records = sample_batch()
                records.insert(3, bad)
                result = run_batch(self.root, records)
                self.assertEqual(result.returncode, 1, result.stdout)
                body = json.loads(result.stdout)
                self.assertFalse(body["ok"])
                self.assertIn("index 3", body["error"])
                for stream in STREAM_FILES:
                    self.assertEqual(stream_ids(self.root, stream), [], f"{label}: {stream}")

    def test_batch_shape_is_validated(self):
        for label, payload in {
            "not a list": json.dumps({"stream": "event"}),
            "empty": "[]",
            "invalid json": "{nope",
        }.items():
            with self.subTest(label):
                result = run_cli(self.root, "batch", stdin=payload)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertFalse(json.loads(result.stdout)["ok"])
        from orchestrator.record_batch import MAX_BATCH_RECORDS
        too_many = [{"stream": "event", "record_id": f"e-{i}", "event": "noop"} for i in range(MAX_BATCH_RECORDS + 1)]
        result = run_batch(self.root, too_many)
        self.assertEqual(result.returncode, 1)
        self.assertIn(str(MAX_BATCH_RECORDS), json.loads(result.stdout)["error"])
        self.assertEqual(stream_ids(self.root, "event"), [])

    def test_repeated_record_id_within_one_batch_is_rejected(self):
        records = sample_batch()
        records.append({"stream": "outcome", "record_id": "e-1", "task_id": "T1"})
        result = run_batch(self.root, records)
        self.assertEqual(result.returncode, 1)
        self.assertIn("e-1", json.loads(result.stdout)["error"])
        for stream in STREAM_FILES:
            self.assertEqual(stream_ids(self.root, stream), [])

    def test_retrying_a_batch_with_the_same_ids_is_idempotent(self):
        first = run_batch(self.root, sample_batch())
        self.assertEqual(first.returncode, 0, first.stderr)
        before = {s: (self.root / f).read_bytes() for s, f in STREAM_FILES.items()}
        second = run_batch(self.root, sample_batch())
        self.assertEqual(second.returncode, 0, second.stderr)
        body = json.loads(second.stdout)
        self.assertTrue(body["ok"])
        self.assertEqual(body["persisted"], {"event": 0, "metric": 0, "outcome": 0})
        self.assertEqual(body["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
        for stream, path in STREAM_FILES.items():
            self.assertEqual((self.root / path).read_bytes(), before[stream], stream)
        # A partially overlapping retry persists only the new records, in order.
        third = run_batch(self.root, [*sample_batch()[:2],
                                      {"stream": "event", "record_id": "e-4", "event": "run_completed", "run_id": "R1"}])
        body = json.loads(third.stdout)
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertEqual(body["persisted"], {"event": 1, "metric": 0, "outcome": 0})
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "e-4"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["R1"]["status"], "completed")

    def test_legacy_single_record_commands_still_write_through_the_common_writer(self):
        self.assertEqual(run_cli(self.root, "event", "run_started", json.dumps({"run_id": "L1"})).returncode, 0)
        self.assertEqual(run_cli(self.root, "metric", json.dumps({"event": "model_call", "run_id": "L1", "model": "gpt-4o",
                                                                   "input_tokens": 5, "output_tokens": 5})).returncode, 0)
        self.assertEqual(run_cli(self.root, "outcome", json.dumps({"run_id": "L1", "task_id": "T1", "outcome": "verified"})).returncode, 0)
        events = load_jsonl(self.root / "events.jsonl"); metrics = load_jsonl(self.root / "metrics.jsonl"); outcomes = load_jsonl(self.root / "outcomes.jsonl")
        self.assertEqual([e["event"] for e in events], ["run_started"])
        self.assertTrue(events[0]["record_id"]); self.assertTrue(metrics[0]["record_id"]); self.assertTrue(outcomes[0]["record_id"])
        self.assertEqual(metrics[0]["agent_runtime"], "batch-test")
        self.assertIn("cost_source", metrics[0])
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["L1"]["status"], "running")
        # A legacy caller that supplies its own record_id gets the same idempotency.
        for _ in range(2):
            self.assertEqual(run_cli(self.root, "event", "run_completed", json.dumps({"run_id": "L1", "record_id": "legacy-done"})).returncode, 0)
        self.assertEqual([e["event"] for e in load_jsonl(self.root / "events.jsonl")], ["run_started", "run_completed"])
        rebuild = run_cli(self.root, "rebuild")
        self.assertEqual(rebuild.returncode, 0, rebuild.stderr)
        self.assertEqual(json.loads(rebuild.stdout)["runs"]["L1"]["status"], "completed")
        status = run_cli(self.root, "status")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(json.loads(status.stdout)["runs"]["L1"]["status"], "completed")

    def test_event_store_methods_assign_ids_and_dedup_supplied_ids(self):
        store = EventStore(self.root)
        first = store.emit("run_started", run_id="S1")
        self.assertTrue(first["record_id"])
        store.emit("task_created", task_id="T1", record_id="fixed-id")
        store.emit("task_created", task_id="T1", record_id="fixed-id")
        self.assertEqual([e.get("record_id") for e in store.all_events()], [first["record_id"], "fixed-id"])
        metric = store.metric(event="model_call", model="gpt-4o", input_tokens=1, output_tokens=1)
        self.assertIn("cost_source", metric)
        self.assertEqual(stream_ids(self.root, "metric"), [metric["record_id"]])
        outcome = store.outcome(task_id="T1", outcome="verified")
        self.assertEqual(stream_ids(self.root, "outcome"), [outcome["record_id"]])

    def test_dashboard_failure_is_reported_after_records_are_durable(self):
        from orchestrator import record_batch
        from orchestrator.app import refresh as refresh_module
        result = record_batch.write_batch(self.root, sample_batch())
        with patch.object(refresh_module, "generate_dashboard", side_effect=RuntimeError("render exploded")):
            result = refresh_module.refresh_after_write(self.root, result)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "refresh_failed")
        self.assertEqual(result["persisted"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertTrue(result["ledger_updated"])
        self.assertFalse(result["dashboard_updated"])
        self.assertIn("render exploded", result["error"])
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        # The retry must not append duplicates and must complete the refresh.
        retry = record_batch.write_batch(self.root, sample_batch())
        retry = refresh_module.refresh_after_write(self.root, retry)
        self.assertTrue(retry["ok"])
        self.assertEqual(retry["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertTrue(retry["dashboard_updated"])
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])

    def test_dashboard_failure_exit_code_distinguishes_durable_append(self):
        script = textwrap.dedent(
            """
            import sys, json
            from unittest.mock import patch
            from orchestrator import cli
            from orchestrator.app import refresh as refresh_module
            sys.argv = ["orchestrator", "batch"]
            with patch.object(refresh_module, "generate_dashboard", side_effect=RuntimeError("render exploded")):
                cli.main()
            """
        )
        result = subprocess.run([sys.executable, "-B", "-c", script], input=json.dumps(sample_batch()), capture_output=True,
                                text=True, env=cli_env(self.root), cwd=str(REPO), timeout=60)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        body = json.loads(result.stdout)
        self.assertEqual(body["status"], "refresh_failed")
        self.assertEqual(body["persisted"]["event"], 3)
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])


class RecoveryTests(TemporaryRootTestCase):
    def test_process_interrupted_between_append_and_response_is_recovered_by_same_id_retry(self):
        script = textwrap.dedent(
            """
            import os, sys, json
            from orchestrator import record_batch
            def crash(*args, **kwargs):
                os._exit(9)
            record_batch._write_checkpoint = crash
            record_batch.write_batch(sys.argv[1], json.loads(sys.stdin.read()))
            """
        )
        crashed = subprocess.run([sys.executable, "-B", "-c", script, str(self.root)], input=json.dumps(sample_batch()),
                                 capture_output=True, text=True, env=cli_env(self.root), cwd=str(REPO), timeout=60)
        self.assertEqual(crashed.returncode, 9, crashed.stderr)
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"], "append happened before the crash")
        self.assertFalse((self.root / "ledger.json").exists(), "no ledger was published before the crash")

        retry = run_batch(self.root, sample_batch())
        self.assertEqual(retry.returncode, 0, retry.stderr)
        body = json.loads(retry.stdout)
        self.assertEqual(body["persisted"], {"event": 0, "metric": 0, "outcome": 0})
        self.assertEqual(body["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertTrue(body["ledger_updated"])
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        self.assertEqual(stream_ids(self.root, "metric"), ["m-1"])
        ledger = read_json(self.root / "ledger.json", {})
        self.assertEqual(ledger["tasks"]["T1"]["status"], "completed")
        self.assertEqual(ledger["checkpoint"]["events_offset"], (self.root / "events.jsonl").stat().st_size)

    def test_process_interrupted_after_checkpoint_but_before_ledger_publish_catches_up_on_retry(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        script = textwrap.dedent(
            """
            import os, sys, json
            from orchestrator import record_batch
            def crash(*args, **kwargs):
                os._exit(9)
            record_batch.replay_ledger = crash
            record_batch.write_batch(sys.argv[1], json.loads(sys.stdin.read()))
            """
        )
        later = [{"stream": "event", "record_id": "e-late", "event": "run_completed", "run_id": "R1"}]
        crashed = subprocess.run([sys.executable, "-B", "-c", script, str(self.root)], input=json.dumps(later),
                                 capture_output=True, text=True, env=cli_env(self.root), cwd=str(REPO), timeout=60)
        self.assertEqual(crashed.returncode, 9, crashed.stderr)
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "e-late"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["R1"]["status"], "running", "ledger is behind the durable append")

        retry = run_batch(self.root, later)
        self.assertEqual(retry.returncode, 0, retry.stderr)
        body = json.loads(retry.stdout)
        self.assertEqual(body["duplicates"], {"event": 1, "metric": 0, "outcome": 0})
        self.assertTrue(body["ledger_updated"], "acknowledging a duplicate event must still catch the ledger up")
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "e-late"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["R1"]["status"], "completed")

    def test_io_failure_between_streams_keeps_earlier_appends_durable_and_retry_completes(self):
        from orchestrator import record_batch
        real_append = record_batch._append_stream

        def fail_metrics(path, lines, **kwargs):
            if path.name == "metrics.jsonl":
                raise OSError(28, "No space left on device")
            return real_append(path, lines, **kwargs)

        with self.assertRaises(record_batch.BatchAppendError) as caught:
            record_batch.write_batch(self.root, sample_batch(), append_stream=fail_metrics)
        self.assertEqual(caught.exception.persisted, {"event": 3, "metric": 0, "outcome": 0})
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"], "earlier stream appends stay durable")
        self.assertEqual(stream_ids(self.root, "metric"), [])
        self.assertEqual(stream_ids(self.root, "outcome"), [])
        self.assertFalse((self.root / record_batch.CHECKPOINT_FILE).exists(), "no checkpoint before all appends succeed")

        retry = record_batch.write_batch(self.root, sample_batch())
        self.assertTrue(retry["ok"])
        self.assertEqual(retry["persisted"], {"event": 0, "metric": 1, "outcome": 1})
        self.assertEqual(retry["duplicates"], {"event": 3, "metric": 0, "outcome": 0})
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        self.assertEqual(stream_ids(self.root, "metric"), ["m-1"])
        self.assertEqual(stream_ids(self.root, "outcome"), ["o-1"])

    def test_append_failure_exit_code_reports_partial_durable_counts(self):
        script = textwrap.dedent(
            """
            import sys
            from unittest.mock import patch
            from orchestrator import record_batch, cli
            original = record_batch._append_stream
            def fail_metrics(path, lines, **kwargs):
                if path.name == "metrics.jsonl":
                    raise OSError(28, "No space left on device")
                return original(path, lines, **kwargs)
            sys.argv = ["orchestrator", "batch"]
            with patch.object(record_batch, "_append_stream", fail_metrics):
                cli.main()
            """
        )
        result = subprocess.run([sys.executable, "-B", "-c", script], input=json.dumps(sample_batch()), capture_output=True,
                                text=True, env=cli_env(self.root), cwd=str(REPO), timeout=60)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        body = json.loads(result.stdout)
        self.assertEqual(body["status"], "append_failed")
        self.assertEqual(body["persisted"], {"event": 3, "metric": 0, "outcome": 0})
        self.assertIn("No space left", body["error"])

    def test_malformed_dedup_checkpoint_is_rebuilt_from_jsonl(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        from orchestrator.record_batch import CHECKPOINT_FILE
        checkpoint = self.root / CHECKPOINT_FILE
        self.assertTrue(checkpoint.exists())
        for garbage in ("{not json", json.dumps({"format_version": 1, "streams": {"event": {"size": 10 ** 9, "recent_ids": ["zzz"]}}}), ""):
            checkpoint.write_text(garbage, encoding="utf-8")
            result = run_batch(self.root, sample_batch())
            self.assertEqual(result.returncode, 0, result.stderr)
            body = json.loads(result.stdout)
            self.assertEqual(body["duplicates"], {"event": 3, "metric": 1, "outcome": 1}, garbage)
            self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        checkpoint.unlink()
        result = run_batch(self.root, [{"stream": "event", "record_id": "e-9", "event": "run_completed", "run_id": "R1"}])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "e-9"])
        self.assertTrue(checkpoint.exists())

    def test_malformed_ledger_checkpoint_falls_back_to_full_replay(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        ledger_path = self.root / "ledger.json"
        good = json.loads(ledger_path.read_text())
        size = (self.root / "events.jsonl").stat().st_size
        variants = {
            "offset beyond file": {**good["checkpoint"], "events_offset": size + 1000},
            "offset inside a line": {**good["checkpoint"], "events_offset": size - 3},
            "wrong tail hash": {**good["checkpoint"], "events_tail_hash": "deadbeef"},
            "non-numeric offset": {**good["checkpoint"], "events_offset": "12"},
            "wrong format version": {**good["checkpoint"], "format_version": 999},
        }
        for label, checkpoint in variants.items():
            with self.subTest(label):
                stale = {**good, "runs": {}, "tasks": {}, "checkpoint": checkpoint}
                ledger_path.write_text(json.dumps(stale), encoding="utf-8")
                result = run_batch(self.root, [{"stream": "event", "record_id": f"fix-{label}", "event": "task_verified",
                                                "run_id": "R1", "task_id": "T1"}])
                self.assertEqual(result.returncode, 0, result.stderr)
                ledger = json.loads(ledger_path.read_text())
                self.assertEqual(ledger["runs"]["R1"]["status"], "running", "full replay must restore the earlier events")
                self.assertEqual(ledger["tasks"]["T1"]["status"], "verified")
                self.assertEqual(ledger["checkpoint"]["events_offset"], (self.root / "events.jsonl").stat().st_size)

    def test_trailing_partial_line_is_terminated_and_later_records_replay(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        events = self.root / "events.jsonl"
        with events.open("a", encoding="utf-8") as handle:
            handle.write('{"event":"task_created","task_id":"TORN","record_id":"torn"')  # crashed writer, no newline
        result = run_batch(self.root, [{"stream": "event", "record_id": "e-after", "event": "task_created", "run_id": "R1", "task_id": "T2"}])
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = events.read_bytes().split(b"\n")
        self.assertEqual(lines[-1], b"", "the stream must end with a newline")
        self.assertEqual(json.loads(lines[-2])["record_id"], "e-after", "the new record must sit on its own line")
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "e-after"])
        ledger = read_json(self.root / "ledger.json", {})
        self.assertEqual(ledger["tasks"]["T2"]["status"], "created")
        self.assertNotIn("TORN", ledger["tasks"])
        from orchestrator.state import rebuild
        self.assertEqual(strip_volatile(rebuild(self.root)), strip_volatile(ledger))

    def test_partial_line_present_during_incremental_replay_does_not_advance_checkpoint(self):
        from orchestrator import state
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        events = self.root / "events.jsonl"
        complete_size = events.stat().st_size
        with events.open("a", encoding="utf-8") as handle:
            handle.write('{"event":"task_created","task_id":"PARTIAL"')
        ledger = state.refresh_ledger(self.root)
        self.assertEqual(ledger["checkpoint"]["events_offset"], complete_size)
        self.assertNotIn("PARTIAL", ledger["tasks"])
        with events.open("a", encoding="utf-8") as handle:
            handle.write(',"record_id":"late"}\n')
        ledger = state.refresh_ledger(self.root)
        self.assertEqual(ledger["checkpoint"]["events_offset"], events.stat().st_size)
        self.assertEqual(ledger["tasks"]["PARTIAL"]["status"], "created")

    def test_legacy_ledger_without_offset_is_fully_rebuilt_then_incremental(self):
        store = EventStore(self.root)
        store.emit("run_started", run_id="OLD")
        store.emit("task_created", task_id="T0")
        from orchestrator.state import EMPTY
        legacy = {**EMPTY, "runs": {"OLD": {"status": "running"}}, "tasks": {}, "updated_at": "2026-01-01T00:00:00+00:00"}
        legacy.pop("checkpoint", None)
        (self.root / "ledger.json").write_text(json.dumps(legacy), encoding="utf-8")
        result = run_batch(self.root, [{"stream": "event", "record_id": "new-1", "event": "task_completed", "task_id": "T0"}])
        self.assertEqual(result.returncode, 0, result.stderr)
        ledger = read_json(self.root / "ledger.json", {})
        self.assertEqual(ledger["tasks"]["T0"]["status"], "completed")
        self.assertEqual(ledger["runs"]["OLD"]["status"], "running")
        self.assertEqual(ledger["schema_version"], 3, "rolling upgrade: old readers must still accept the ledger")
        self.assertEqual(ledger["checkpoint"]["events_offset"], (self.root / "events.jsonl").stat().st_size)
        self.assertEqual(ledger["checkpoint"]["events_replayed"], 3)
        from orchestrator.state import load_or_rebuild
        self.assertEqual(load_or_rebuild(self.root)["tasks"]["T0"]["status"], "completed")

    def test_incremental_ledger_matches_full_rebuild_and_dedups_by_record_id(self):
        from orchestrator.state import rebuild
        batches = [
            sample_batch(),
            [{"stream": "event", "record_id": "e-10", "event": "task_verified", "run_id": "R1", "task_id": "T1"},
             {"stream": "event", "record_id": "e-11", "event": "run_completed", "run_id": "R1"}],
            [{"stream": "event", "record_id": "e-20", "event": "run_started", "run_id": "R2"},
             {"stream": "event", "record_id": "e-10", "event": "task_verified", "run_id": "R1", "task_id": "T1"}],
        ]
        for batch in batches:
            self.assertEqual(run_batch(self.root, batch).returncode, 0)
        incremental = read_json(self.root / "ledger.json", {})
        self.assertEqual(incremental["checkpoint"]["events_replayed"], 6)
        self.assertEqual(set(incremental["runs"]), {"R1", "R2"})
        self.assertEqual(incremental["runs"]["R1"]["status"], "completed")
        full = rebuild(self.root)
        self.assertEqual(strip_volatile(full), strip_volatile(incremental))
        self.assertEqual(full["checkpoint"]["events_offset"], incremental["checkpoint"]["events_offset"])
        # Records that bypassed append-time dedup (e.g. an old writer) are still collapsed by full replay.
        with (self.root / "events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"ts": "2026-09-23T00:00:00+00:00", "event": "run_started", "run_id": "R1", "record_id": "e-1"}) + "\n")
        replayed = rebuild(self.root)
        self.assertEqual(replayed["runs"]["R1"]["status"], "completed", "a duplicate record_id must not be replayed twice")
        self.assertEqual(replayed["checkpoint"]["events_replayed"], 6)


def _fsync_by_inode(calls: list, fail_inode: int | None = None, fail_once: bool = True):
    """Wrap os.fsync so a test can see which files were synced and inject one failure."""
    original = os.fsync
    state = {"failed": False}

    def wrapper(fd):
        inode = os.fstat(fd).st_ino
        calls.append(inode)
        if fail_inode is not None and inode == fail_inode and not (fail_once and state["failed"]):
            state["failed"] = True
            raise OSError(5, "Input/output error")
        return original(fd)

    return wrapper


class ReviewRegressionTests(TemporaryRootTestCase):
    """Regressions for the review findings on the first durable-writer implementation."""

    # (1) A bounded recent-id window must never let an old record id through again.
    def test_duplicate_older_than_any_bounded_window_is_still_rejected(self):
        from orchestrator import record_batch
        total = 4200  # more than the 4096-id window the first implementation kept
        first = [{"stream": "metric", "record_id": "m-0", "event": "model_call", "run_id": "R1", "model": "gpt-4o",
                  "input_tokens": 1, "output_tokens": 1}]
        record_batch.write_batch(self.root, first, refresh=False)
        for start in range(1, total, record_batch.MAX_BATCH_RECORDS):
            batch = [{"stream": "metric", "record_id": f"m-{i}", "event": "model_call", "run_id": "R1", "model": "gpt-4o",
                      "input_tokens": 1, "output_tokens": 1} for i in range(start, min(start + record_batch.MAX_BATCH_RECORDS, total))]
            record_batch.write_batch(self.root, batch, refresh=False)
        before = (self.root / "metrics.jsonl").read_bytes()
        self.assertEqual(before.count(b'"record_id": "m-0"'), 1)
        retry = record_batch.write_batch(self.root, first, refresh=False)
        self.assertEqual(retry["duplicates"], {"event": 0, "metric": 1, "outcome": 0})
        self.assertEqual(retry["persisted"], {"event": 0, "metric": 0, "outcome": 0})
        self.assertEqual((self.root / "metrics.jsonl").read_bytes(), before, "an old id must not be appended a second time")
        # The same holds across processes (fresh index load) and for the event stream.
        events = [{"stream": "event", "record_id": f"e-{i}", "event": "task_created", "run_id": "R1", "task_id": f"T{i}"}
                  for i in range(total)]
        for start in range(0, total, record_batch.MAX_BATCH_RECORDS):
            record_batch.write_batch(self.root, events[start:start + record_batch.MAX_BATCH_RECORDS], refresh=False)
        result = run_batch(self.root, events[:3])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["duplicates"]["event"], 3)
        self.assertEqual(len(stream_ids(self.root, "event")), total)

    # (2) Cached membership can never be the reason a new record is silently dropped.
    def test_valid_shaped_corrupt_checkpoint_cannot_discard_a_new_record(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        def corrupt(record_id: str, *, consistent: bool):
            """Forge membership in a structurally valid cache; receipt stays independent."""
            from orchestrator.record_index import DATABASE_FILE
            path = self.root / DATABASE_FILE
            before = path.stat()
            with sqlite3.connect(path) as db:
                db.execute('INSERT INTO ids VALUES (?, ?)', ('event', record_id))
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            db.close()
            if consistent:
                os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))

        for label, consistent in (("detectable corruption", False), ("internally consistent but wrong", True)):
            with self.subTest(label):
                rid = f"ghost-{int(consistent)}"
                corrupt(rid, consistent=consistent)
                result = run_batch(self.root, [{"stream": "event", "record_id": rid, "event": "task_created", "run_id": "R1",
                                                "task_id": f"G{int(consistent)}"}])
                self.assertEqual(result.returncode, 0, result.stderr)
                body = json.loads(result.stdout)
                self.assertEqual(body["persisted"]["event"], 1, f"{label}: the record must be appended, not silently dropped")
                self.assertEqual(body["duplicates"]["event"], 0)
                self.assertIn(rid, stream_ids(self.root, "event"))
                self.assertEqual(read_json(self.root / "ledger.json", {})["tasks"][f"G{int(consistent)}"]["status"], "created")
        # The cache is rebuilt from the authoritative stream afterwards: a genuine retry still dedups.
        again = run_batch(self.root, sample_batch())
        self.assertEqual(json.loads(again.stdout)["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "ghost-0", "ghost-1"])

    # (3) A complete record that merely lacks its newline is data, not garbage.
    def test_complete_record_without_trailing_newline_is_recognized_and_not_duplicated_on_retry(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        events = self.root / "events.jsonl"
        late = {"stream": "event", "record_id": "nl-less", "event": "task_created", "run_id": "R1", "task_id": "NL"}
        with events.open("ab") as handle:  # a writer that lost its newline (torn write of the final byte)
            handle.write(json.dumps({k: v for k, v in late.items() if k != "stream"}).encode())
        retry = run_batch(self.root, [late])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        body = json.loads(retry.stdout)
        self.assertEqual(body["duplicates"], {"event": 1, "metric": 0, "outcome": 0}, "the complete record is already durable")
        self.assertEqual(body["persisted"], {"event": 0, "metric": 0, "outcome": 0})
        data = events.read_bytes()
        self.assertTrue(data.endswith(b"\n"), "acknowledging the record must make it a replayable line")
        self.assertEqual(data.count(b'"nl-less"'), 1)
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "nl-less"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["tasks"]["NL"]["status"], "created")

    def test_complete_record_without_newline_is_terminated_even_by_an_unrelated_batch(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        events = self.root / "events.jsonl"
        with events.open("ab") as handle:
            handle.write(json.dumps({"record_id": "nl-less", "event": "task_created", "run_id": "R1", "task_id": "NL"}).encode())
        result = run_batch(self.root, [{"stream": "metric", "record_id": "m-9", "event": "model_call", "run_id": "R1",
                                        "model": "gpt-4o", "input_tokens": 1, "output_tokens": 1}])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(events.read_bytes().endswith(b"\n"))
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "nl-less"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["tasks"]["NL"]["status"], "created")

    def test_incomplete_fragment_is_left_untouched_when_nothing_is_appended_to_its_stream(self):
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        events = self.root / "events.jsonl"
        with events.open("ab") as handle:
            handle.write(b'{"event":"task_created","task_id":"FRAG","record_id":"frag')
        before = events.read_bytes()
        result = run_batch(self.root, sample_batch()[:1])  # duplicate-only for the event stream
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["duplicates"]["event"], 1)
        self.assertEqual(events.read_bytes(), before, "a fragment that might still be completed is not rewritten")
        self.assertNotIn("FRAG", read_json(self.root / "ledger.json", {})["tasks"])
        # Appending to that stream terminates the fragment so the new record is parseable (no truncation).
        result = run_batch(self.root, [{"stream": "event", "record_id": "e-after", "event": "task_created", "run_id": "R1", "task_id": "T2"}])
        self.assertEqual(result.returncode, 0, result.stderr)
        data = events.read_bytes()
        self.assertTrue(data.startswith(before), "append-only: earlier bytes are never rewritten or truncated")
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "e-after"])

    # (4) Visible-but-unsynced bytes must be fsynced before a retry acknowledges them as duplicates.
    def test_fsync_failure_is_reported_and_the_retry_syncs_visible_duplicates_before_acknowledging(self):
        from orchestrator import record_batch
        metrics = self.root / "metrics.jsonl"
        record_batch.write_batch(self.root, sample_batch()[:1], refresh=False)  # creates the root and event stream
        metrics.touch()
        metrics_inode = metrics.stat().st_ino
        calls: list[int] = []
        with patch("orchestrator.record_batch.os.fsync", _fsync_by_inode(calls, fail_inode=metrics_inode)):
            with self.assertRaises(record_batch.BatchAppendError) as caught:
                record_batch.write_batch(self.root, sample_batch(), refresh=False)
        self.assertEqual(caught.exception.persisted, {"event": 2, "metric": 0, "outcome": 0}, "an unsynced stream is not persisted")
        self.assertIn("same record ids", str(caught.exception))
        self.assertEqual(stream_ids(self.root, "metric"), ["m-1"], "the bytes are visible even though the sync failed")
        self.assertEqual(_checkpoint_snapshot(self.root)["streams"]["metric"]["size"], 0,
                         "no committed checkpoint may vouch for unsynced bytes")

        calls.clear()
        with patch("orchestrator.record_batch.os.fsync", _fsync_by_inode(calls)):
            retry = record_batch.write_batch(self.root, sample_batch())
        self.assertTrue(retry["ok"], retry)
        self.assertEqual(retry["duplicates"], {"event": 3, "metric": 1, "outcome": 0})
        self.assertEqual(retry["persisted"], {"event": 0, "metric": 0, "outcome": 1})
        self.assertIn(metrics_inode, calls, "visible duplicates must be fsynced before they are acknowledged")
        self.assertEqual(stream_ids(self.root, "metric"), ["m-1"])

    def test_bytes_appended_by_a_crashed_writer_are_synced_before_the_checkpoint_vouches_for_them(self):
        from orchestrator import record_batch
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        events = self.root / "events.jsonl"
        with events.open("ab") as handle:  # a writer that died between write() and fsync()
            handle.write(json.dumps({"record_id": "unsynced", "event": "task_created", "run_id": "R1", "task_id": "U"}).encode() + b"\n")
        calls: list[int] = []
        with patch("orchestrator.record_batch.os.fsync", _fsync_by_inode(calls)):
            result = record_batch.write_batch(self.root, [{"stream": "outcome", "record_id": "o-2", "run_id": "R1", "task_id": "U", "outcome": "verified"}])
        self.assertTrue(result["ok"])
        self.assertIn(events.stat().st_ino, calls, "the catch-up region of the event stream must be fsynced")
        checkpoint = _checkpoint_snapshot(self.root)
        self.assertEqual(checkpoint["streams"]["event"]["size"], events.stat().st_size)

    # (5) Reducer key fields are validated before anything is appended; nothing raises a raw traceback.
    def test_unhashable_stream_and_key_fields_are_rejected_with_structured_errors(self):
        bad_stream = [{"stream": ["event"], "record_id": "x-1", "event": "run_started", "run_id": "R1"}]
        result = run_batch(self.root, bad_stream)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        body = json.loads(result.stdout)
        self.assertFalse(body["ok"]); self.assertIn("index 0", body["error"]); self.assertIn("stream", body["error"])
        key_cases = {
            "run_id list": {"stream": "event", "record_id": "k-1", "event": "run_started", "run_id": ["R1"]},
            "run_id object": {"stream": "event", "record_id": "k-2", "event": "run_started", "run_id": {"id": "R1"}},
            "run_id integer": {"stream": "event", "record_id": "k-3", "event": "run_started", "run_id": 7},
            "task_id list": {"stream": "event", "record_id": "k-4", "event": "task_created", "run_id": "R1", "task_id": ["T"]},
            "decision_id bool": {"stream": "event", "record_id": "k-5", "event": "decision_created", "decision_id": True},
            "workstream_id list": {"stream": "event", "record_id": "k-6", "event": "workstream_created", "workstream_id": []},
            "resource object": {"stream": "event", "record_id": "k-7", "event": "lock_acquired", "resource": {}},
            "metric run_id list": {"stream": "metric", "record_id": "k-8", "event": "model_call", "run_id": ["R1"], "model": "gpt-4o"},
            "outcome task_id list": {"stream": "outcome", "record_id": "k-9", "run_id": "R1", "task_id": ["T1"]},
        }
        for label, bad in key_cases.items():
            with self.subTest(label):
                records = [*sample_batch(), bad]
                result = run_batch(self.root, records)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                body = json.loads(result.stdout)
                field = label.split()[-2] if label.startswith(("metric", "outcome")) else label.split()[0]
                self.assertIn("index 5", body["error"]); self.assertIn(field, body["error"])
                for stream in STREAM_FILES:
                    self.assertEqual(stream_ids(self.root, stream), [], f"{label}: all-or-nothing")
        # Null key fields are allowed (the reducer ignores them), so existing callers are unaffected.
        ok = run_batch(self.root, [{"stream": "event", "record_id": "n-1", "event": "run_started", "run_id": None}])
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)

    def test_single_record_commands_reject_bad_payloads_without_tracebacks(self):
        for label, args in {
            "event unhashable run_id": ("event", "run_started", json.dumps({"run_id": ["R1"]})),
            "event payload not an object": ("event", "run_started", "[1,2]"),
            "event payload invalid json": ("event", "run_started", "{nope"),
            "metric unhashable task_id": ("metric", json.dumps({"event": "model_call", "task_id": {"x": 1}})),
            "outcome payload not an object": ("outcome", "42"),
        }.items():
            with self.subTest(label):
                result = run_cli(self.root, *args)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                body = json.loads(result.stdout)
                self.assertFalse(body["ok"]); self.assertEqual(body["status"], "invalid")
        for stream in STREAM_FILES:
            self.assertEqual(stream_ids(self.root, stream), [])
        from orchestrator.record_batch import BatchValidationError
        store = EventStore(self.root)
        with self.assertRaises(BatchValidationError):
            store.emit("run_started", run_id={"id": "R1"})
        with self.assertRaises(BatchValidationError):
            store.metric(event="model_call", run_id=["R1"])

    def test_legacy_poison_record_with_unhashable_key_does_not_break_replay(self):
        from orchestrator.state import rebuild, refresh_ledger
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        with (self.root / "events.jsonl").open("a", encoding="utf-8") as handle:  # written by an older writer
            handle.write(json.dumps({"record_id": "poison", "event": "run_started", "run_id": ["R9"]}) + "\n")
            handle.write(json.dumps({"record_id": "fine", "event": "run_started", "run_id": "R2"}) + "\n")
        ledger = refresh_ledger(self.root)
        self.assertEqual(set(ledger["runs"]), {"R1", "R2"})
        self.assertEqual(ledger["checkpoint"]["events_offset"], (self.root / "events.jsonl").stat().st_size)
        self.assertEqual(set(rebuild(self.root)["runs"]), {"R1", "R2"})

    # (6) A checkpoint write failure after the fsync is a structured partial result, not a traceback.
    def test_checkpoint_write_failure_after_durable_append_returns_structured_result(self):
        from orchestrator import record_batch
        with patch("orchestrator.record_batch.write_json", side_effect=OSError(28, "No space left on device")):
            result = record_batch.write_batch(self.root, sample_batch())
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "checkpoint_failed")
        self.assertEqual(result["persisted"], {"event": 3, "metric": 1, "outcome": 1}, "the records are durable")
        self.assertEqual(result["retry"], "same_ids")
        self.assertIn("No space left", result["error"]); self.assertIn("same record ids", result["error"])
        self.assertFalse(result["ledger_updated"]); self.assertFalse(result["dashboard_updated"])
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        self.assertFalse((self.root / record_batch.CHECKPOINT_FILE).exists())

        retry = record_batch.write_batch(self.root, sample_batch())
        from orchestrator.app.refresh import refresh_after_write
        retry = refresh_after_write(self.root, retry)
        self.assertTrue(retry["ok"], retry)
        self.assertEqual(retry["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertIsNone(retry["retry"])
        self.assertTrue(retry["ledger_updated"]); self.assertTrue(retry["dashboard_updated"])
        self.assertTrue((self.root / record_batch.CHECKPOINT_FILE).exists())
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["tasks"]["T1"]["status"], "completed")

    def test_checkpoint_write_failure_exit_code_and_body_carry_retry_guidance(self):
        script = textwrap.dedent(
            """
            import sys
            from unittest.mock import patch
            from orchestrator import record_batch, cli
            sys.argv = ["orchestrator", "batch"]
            with patch("orchestrator.record_batch.write_json", side_effect=OSError(28, "No space left on device")):
                cli.main()
            """
        )
        result = subprocess.run([sys.executable, "-B", "-c", script], input=json.dumps(sample_batch()), capture_output=True,
                                text=True, env=cli_env(self.root), cwd=str(REPO), timeout=60)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        body = json.loads(result.stdout)
        self.assertEqual(body["status"], "checkpoint_failed")
        self.assertEqual(body["persisted"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertEqual(body["retry"], "same_ids")
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])

    def test_append_failure_body_carries_retry_guidance(self):
        from orchestrator import record_batch

        def fail(path, lines, **kwargs):
            raise OSError(28, "No space left on device")

        with self.assertRaises(record_batch.BatchAppendError) as caught:
            record_batch.write_batch(self.root, sample_batch(), append_stream=fail)
        self.assertIn("same record ids", str(caught.exception))
        self.assertEqual(caught.exception.persisted, {"event": 0, "metric": 0, "outcome": 0})

    # Single-record commands: the command decides the stream (and event name); the payload cannot override them.
    def test_single_record_command_stream_and_event_cannot_be_overridden_by_payload(self):
        conflicts = {
            "event payload redirects to metric": ("event", "run_started", json.dumps({"stream": "metric", "run_id": "X"})),
            "metric payload redirects to event": ("metric", json.dumps({"stream": "event", "event": "run_started", "run_id": "X"})),
            "outcome payload redirects to event": ("outcome", json.dumps({"stream": "event", "event": "run_started", "run_id": "X"})),
            "event payload renames the event": ("event", "run_started", json.dumps({"event": "run_failed", "run_id": "X"})),
        }
        for label, args in conflicts.items():
            with self.subTest(label):
                result = run_cli(self.root, *args)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                body = json.loads(result.stdout)
                self.assertFalse(body["ok"]); self.assertEqual(body["status"], "invalid")
        for stream in STREAM_FILES:
            self.assertEqual(stream_ids(self.root, stream), [], stream)
        # A payload that agrees with the command is fine.
        ok = run_cli(self.root, "event", "run_started", json.dumps({"stream": "event", "event": "run_started", "run_id": "X"}))
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        self.assertEqual([e["event"] for e in load_jsonl(self.root / "events.jsonl")], ["run_started"])
        from orchestrator.record_batch import BatchValidationError
        store = EventStore(self.root)
        with self.assertRaises(BatchValidationError):
            store.metric(stream="event", event="model_call", run_id="X")
        self.assertEqual(len(load_jsonl(self.root / "events.jsonl")), 1)
        self.assertEqual(stream_ids(self.root, "metric"), [])


def _checkpoint_snapshot(root: Path) -> dict:
    """Inspect committed cache content without changing it or its independent receipt."""
    from orchestrator.record_index import DATABASE_FILE, decode_key
    db = sqlite3.connect(f'file:{root / DATABASE_FILE}?mode=ro', uri=True)
    try:
        streams = {s: json.loads(value) for s, value in db.execute('SELECT stream, value FROM meta')}
        for stream, entry in streams.items():
            entry['ids'] = [decode_key(r[0]) for r in db.execute('SELECT record_id FROM ids WHERE stream=? ORDER BY record_id', (stream,))]
        return {'streams': streams}
    finally:
        db.close()


def _drop_ids_from_checkpoint(root: Path, removals: dict[str, list[str]]) -> None:
    from orchestrator.record_index import DATABASE_FILE, encode_key
    db = sqlite3.connect(root / DATABASE_FILE)
    try:
        for stream, ids in removals.items():
            for rid in ids:
                assert db.execute('DELETE FROM ids WHERE stream=? AND record_id=?', (stream, encode_key(rid))).rowcount == 1
        db.commit()
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    finally:
        db.close()


def _completed_run(case: TemporaryRootTestCase) -> list[dict]:
    """sample_batch() followed by run_completed, so a stale run_started retry is the worst case for the ledger."""
    late = [{"stream": "event", "record_id": "e-late", "event": "run_completed", "run_id": "R1"}]
    case.assertEqual(run_batch(case.root, sample_batch()).returncode, 0)
    case.assertEqual(run_batch(case.root, late).returncode, 0)
    case.assertEqual(read_json(case.root / "ledger.json", {})["runs"]["R1"]["status"], "completed")
    return late


class SecurityReviewRound2Tests(TemporaryRootTestCase):
    """A structurally valid cache edit invalidates the independent writer receipt."""

    def _completed_run(self) -> list[dict]:
        return _completed_run(self)

    # A false-negative index (an id the stream has but the cache lost) must not append the record again.
    def test_index_missing_existing_ids_cannot_append_them_again_or_regress_the_ledger(self):
        from orchestrator.state import rebuild
        self._completed_run()
        _drop_ids_from_checkpoint(self.root, {"event": ["e-1"], "metric": ["m-1"]})
        events_before = (self.root / "events.jsonl").read_bytes()
        metrics_before = (self.root / "metrics.jsonl").read_bytes()
        ledger_before = read_json(self.root / "ledger.json", {})

        # Retrying the stale run_started (e-1) after run_completed is the worst case: a wrong append
        # would flip the run back to 'running' in the incremental ledger only.
        retry = run_batch(self.root, [sample_batch()[0], sample_batch()[1]])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        body = json.loads(retry.stdout)
        self.assertEqual(body["duplicates"], {"event": 1, "metric": 1, "outcome": 0}, "membership comes from the stream, not the cache")
        self.assertEqual(body["persisted"], {"event": 0, "metric": 0, "outcome": 0})
        self.assertEqual((self.root / "events.jsonl").read_bytes(), events_before, "no duplicate event line")
        self.assertEqual((self.root / "metrics.jsonl").read_bytes(), metrics_before, "no duplicate metric line")
        ledger = read_json(self.root / "ledger.json", {})
        self.assertEqual(ledger["runs"]["R1"]["status"], "completed", "a stale run_started must not regress the run")
        self.assertEqual(ledger["checkpoint"]["events_replayed"], ledger_before["checkpoint"]["events_replayed"])
        self.assertEqual(strip_volatile(rebuild(self.root)), strip_volatile(ledger), "incremental ledger must equal full replay")

    def test_index_with_every_id_removed_is_not_trusted_for_new_verdicts(self):
        from orchestrator import record_batch
        self._completed_run()
        _drop_ids_from_checkpoint(self.root, {"event": ["e-1", "e-2", "e-3", "e-late"], "metric": ["m-1"], "outcome": ["o-1"]})
        before = {stream: (self.root / name).read_bytes() for stream, name in STREAM_FILES.items()}
        result = record_batch.write_batch(self.root, sample_batch())
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertEqual(result["persisted"], {"event": 0, "metric": 0, "outcome": 0})
        for stream, name in STREAM_FILES.items():
            self.assertEqual((self.root / name).read_bytes(), before[stream], stream)
        # The rebuilt checkpoint is complete again.
        saved = _checkpoint_snapshot(self.root)
        self.assertEqual(saved["streams"]["event"]["ids"], ["e-1", "e-2", "e-3", "e-late"])
        self.assertEqual(saved["streams"]["metric"]["ids"], ["m-1"])

    def test_loaded_index_membership_always_matches_the_stream(self):
        from orchestrator import record_batch
        self._completed_run()
        _drop_ids_from_checkpoint(self.root, {"event": ["e-2"]})
        # Exercise the public retry path: do not load a second index without the writer lock.
        result = record_batch.write_batch(self.root, sample_batch(), refresh=False)
        self.assertEqual(result['duplicates'], {'event': 3, 'metric': 1, 'outcome': 1})
        self.assertEqual(_checkpoint_snapshot(self.root)['streams']['event']['ids'], stream_ids(self.root, 'event'))
        self.assertEqual(_checkpoint_snapshot(self.root)['streams']['event']['size'], (self.root / 'events.jsonl').stat().st_size)

    # A metric batch that repairs a newline-less event but cannot checkpoint must not leave the
    # ledger behind after the same-id retry succeeds.
    def test_repaired_newline_less_event_reaches_the_ledger_after_a_failed_checkpoint_and_same_id_retry(self):
        from orchestrator import record_batch
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        events = self.root / "events.jsonl"
        with events.open("ab") as handle:  # a crashed writer: whole record, newline lost
            handle.write(json.dumps({"record_id": "nl-late", "event": "run_completed", "run_id": "R1"}).encode())
        metric = [{"stream": "metric", "record_id": "m-9", "event": "model_call", "run_id": "R1", "model": "gpt-4o",
                   "input_tokens": 1, "output_tokens": 1}]
        with patch("orchestrator.record_batch.write_json", side_effect=OSError(28, "No space left on device")):
            first = record_batch.write_batch(self.root, metric)
        self.assertEqual(first["status"], "checkpoint_failed")
        self.assertEqual(first["retry"], "same_ids")
        self.assertTrue(events.read_bytes().endswith(b"\n"), "the complete record was repaired by the unrelated batch")
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "nl-late"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["R1"]["status"], "running", "ledger is behind")

        retry = run_batch(self.root, metric)  # fresh process, fresh index load
        self.assertEqual(retry.returncode, 0, retry.stderr)
        body = json.loads(retry.stdout)
        self.assertTrue(body["ok"]); self.assertEqual(body["duplicates"], {"event": 0, "metric": 1, "outcome": 0})
        self.assertTrue(body["ledger_updated"], "OK may only be returned once the ledger covers the complete authoritative prefix")
        ledger = read_json(self.root / "ledger.json", {})
        self.assertEqual(ledger["runs"]["R1"]["status"], "completed")
        self.assertEqual(ledger["checkpoint"]["events_offset"], events.stat().st_size)
        self.assertEqual(ledger["checkpoint"]["events_replayed"], 4)

    def test_any_batch_refreshes_a_ledger_that_is_behind_the_complete_event_prefix(self):
        from orchestrator import record_batch
        self.assertEqual(run_batch(self.root, sample_batch()).returncode, 0)
        metric = [{"stream": "metric", "record_id": "m-9", "event": "model_call", "run_id": "R1", "model": "gpt-4o",
                   "input_tokens": 1, "output_tokens": 1}]
        current = record_batch.write_batch(self.root, metric)
        self.assertTrue(current["ok"]); self.assertFalse(current["ledger_updated"], "a current ledger is not rewritten")
        events = self.root / "events.jsonl"
        with events.open("ab") as handle:  # an old-code writer appended a complete line without publishing
            handle.write(json.dumps({"record_id": "old-writer", "event": "run_completed", "run_id": "R1"}).encode() + b"\n")
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["R1"]["status"], "running")
        behind = record_batch.write_batch(self.root, metric)  # duplicate metric, no event touched by this batch
        self.assertTrue(behind["ok"], behind)
        self.assertEqual(behind["duplicates"]["metric"], 1)
        self.assertTrue(behind["ledger_updated"], "ledger offset behind the complete prefix must trigger a refresh")
        ledger = read_json(self.root / "ledger.json", {})
        self.assertEqual(ledger["runs"]["R1"]["status"], "completed")
        self.assertEqual(ledger["checkpoint"]["events_offset"], events.stat().st_size)
        # A trailing fragment is not part of the complete prefix: the ledger stays current and is not rewritten.
        with events.open("ab") as handle:
            handle.write(b'{"event":"run_failed","run_id":"R1","record_id":"frag')
        again = record_batch.write_batch(self.root, metric)
        self.assertTrue(again["ok"]); self.assertFalse(again["ledger_updated"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["R1"]["status"], "completed")


def _forge_index_with_stream_access(root: Path, removals: dict[str, list[str]]) -> None:
    """Forge valid membership/metadata with full stream access and restore mtime.

    Stream bytes (including predictable tail bindings) are available to the
    attacker; the independent receipt is not. OS ctime cannot be restored by utime.
    """
    from orchestrator.record_index import DATABASE_FILE
    path = root / DATABASE_FILE
    before = path.stat()
    for name in STREAM_FILES.values():
        (root / name).read_bytes()
    _drop_ids_from_checkpoint(root, removals)
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))


class _CountingFile:
    """Binary read proxy that counts the bytes handed to the caller."""

    def __init__(self, raw, counter: list[int]):
        self._raw = raw; self._counter = counter

    def read(self, n: int = -1):
        data = self._raw.read(n); self._counter[0] += len(data); return data

    def readline(self, *args):
        line = self._raw.readline(*args); self._counter[0] += len(line); return line

    def __iter__(self): return self

    def __next__(self):
        line = next(self._raw); self._counter[0] += len(line); return line

    def __enter__(self): return self

    def __exit__(self, *exc): return self._raw.__exit__(*exc)

    def __getattr__(self, name): return getattr(self._raw, name)


def _count_stream_bytes_read(fn):
    """Run `fn()` and return how many bytes it read from `*.jsonl` files (buffered opens and os.pread)."""
    counter = [0]
    real_open = io.open; real_pread = os.pread

    def counting_open(file, mode="r", *args, **kwargs):
        handle = real_open(file, mode, *args, **kwargs)
        if str(file).endswith(".jsonl") and "b" in mode and "r" in mode:
            return _CountingFile(handle, counter)
        return handle

    def counting_pread(fd, n, offset):
        data = real_pread(fd, n, offset); counter[0] += len(data); return data

    with patch("io.open", counting_open), patch("os.pread", counting_pread):
        fn()
    return counter[0]


def _fill_streams(root: Path, per_stream: int) -> None:
    """`per_stream` events and metrics with distinct ids, appended through the writer in maximal batches."""
    from orchestrator import record_batch
    for stream in ("event", "metric"):
        for start in range(0, per_stream, record_batch.MAX_BATCH_RECORDS):
            rows = []
            for i in range(start, min(start + record_batch.MAX_BATCH_RECORDS, per_stream)):
                if stream == "event":
                    rows.append({"stream": "event", "record_id": f"e-{i}", "event": "task_created", "run_id": f"R{i // 50}", "task_id": f"T{i}"})
                else:
                    rows.append({"stream": "metric", "record_id": f"m-{i}", "event": "model_call", "run_id": f"R{i // 50}",
                                 "task_id": f"T{i}", "model": "claude-sonnet-4-5", "input_tokens": 100, "output_tokens": 50})
            record_batch.write_batch(root, rows, refresh=False)


class IndexThreatModelTests(TemporaryRootTestCase):
    """A cache-only forgery is rejected before classification, not at a periodic audit."""

    def _checkpoint_ids(self, stream: str) -> list[str]:
        return _checkpoint_snapshot(self.root)['streams'][stream]['ids']

    # --- intentional modification by a stream reader: rejected before acknowledgement -----------

    def test_stream_reader_forgery_is_rejected_and_rebuild_stays_equivalent(self):
        from orchestrator.state import rebuild
        _completed_run(self)
        _forge_index_with_stream_access(self.root, {"event": ["e-1", "e-2"]})
        retry = run_batch(self.root, [sample_batch()[0]])  # stale run_started after run_completed
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)["duplicates"]["event"], 1)
        self.assertEqual(stream_ids(self.root, "event").count("e-1"), 1)
        self.assertEqual(read_json(self.root / 'ledger.json', {})['runs']['R1']['status'], 'completed')
        ledger = rebuild(self.root)
        self.assertEqual(ledger["runs"]["R1"]["status"], "completed", "full replay collapses the duplicate by record_id")
        self.assertEqual(ledger["checkpoint"]["events_replayed"], 4)
        # `rebuild` is the recovery path for derived state: the forged index is discarded and the next
        # write re-derives membership from the stream, so e-2 (forged away, never re-appended) dedups.
        events_after = (self.root / "events.jsonl").read_bytes()
        retry = run_batch(self.root, [sample_batch()[2]])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        body = json.loads(retry.stdout)
        self.assertEqual(body["duplicates"], {"event": 1, "metric": 0, "outcome": 0}, "after rebuild the index must come from the stream")
        self.assertEqual((self.root / "events.jsonl").read_bytes(), events_after)
        self.assertEqual(sorted(set(self._checkpoint_ids("event"))), ["e-1", "e-2", "e-3", "e-late"])
        self.assertEqual(read_json(self.root / "ledger.json", {})["runs"]["R1"]["status"], "completed")
        self.assertEqual(strip_volatile(rebuild(self.root)), strip_volatile(read_json(self.root / "ledger.json", {})))

    def test_forged_index_is_re_derived_before_any_growth_or_retry(self):
        from orchestrator import record_batch
        _completed_run(self)
        _forge_index_with_stream_access(self.root, {"metric": ["m-1"]})
        metrics = self.root / "metrics.jsonl"
        before = metrics.read_bytes()
        # An unrelated duplicate-only batch still invalidates and repairs the entire forged cache.
        record_batch.write_batch(self.root, [sample_batch()[0]], refresh=False)
        self.assertIn('m-1', self._checkpoint_ids('metric'))
        retry = record_batch.write_batch(self.root, [sample_batch()[1]], refresh=False)
        self.assertEqual(retry["duplicates"]["metric"], 1)
        self.assertEqual(metrics.read_bytes(), before)

    # --- accidental corruption: detected before any record is classified -------------------------

    def test_accidental_index_corruption_is_detected_before_any_record_is_classified(self):
        from orchestrator import record_batch
        _completed_run(self)
        checkpoint = self.root / record_batch.CHECKPOINT_FILE
        from orchestrator.record_index import DATABASE_FILE, INDEX_VERSION, encode_key

        with self.subTest("bit-rot inside an id"):
            db = sqlite3.connect(self.root / DATABASE_FILE)
            changed = db.execute("UPDATE ids SET record_id=? WHERE stream='event' AND record_id=?", (encode_key('e-l'), encode_key('e-1'))).rowcount
            db.commit(); db.close()
            self.assertEqual(changed, 1, 'the test must corrupt a real cache key')
            before = (self.root / "events.jsonl").read_bytes()
            body = json.loads(run_batch(self.root, [sample_batch()[0]]).stdout)
            self.assertEqual(body["duplicates"]["event"], 1, "the real id is still present in the stream")
            self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
            self.assertEqual(self._checkpoint_ids("event"), ["e-1", "e-2", "e-3", "e-late"])

        with self.subTest("checkpoint from another stream state (last line rewritten in place)"):
            events = self.root / "events.jsonl"
            data = events.read_bytes()
            self.assertEqual(data.count(b'"e-late"'), 1)
            events.write_bytes(data.replace(b'"e-late"', b'"e-LATE"'))  # same size, different last line
            body = json.loads(run_batch(self.root, [{"stream": "event", "record_id": "e-LATE", "event": "run_completed", "run_id": "R1"}]).stdout)
            self.assertEqual(body["duplicates"]["event"], 1, "membership must be re-derived from the rewritten stream")
            self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3", "e-LATE"])
            self.assertEqual(self._checkpoint_ids("event"), ["e-1", "e-2", "e-3", "e-LATE"])

        with self.subTest("previous checkpoint format"):
            raw = json.loads(checkpoint.read_text(encoding="utf-8")); raw["format_version"] = 4
            checkpoint.write_text(json.dumps(raw), encoding="utf-8")
            body = json.loads(run_batch(self.root, sample_batch()).stdout)
            self.assertEqual(body["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
            self.assertEqual(json.loads(checkpoint.read_text(encoding="utf-8"))["format_version"], INDEX_VERSION)

    # --- cost of a new write does not scale with the history (1x / 2x / 4x fixtures) --------------

    def test_new_write_reads_a_bounded_amount_of_history(self):
        from orchestrator import record_batch
        measured: dict[int, int] = {}
        for multiplier in (1, 2, 4):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp, "state")
                _fill_streams(root, 600 * multiplier)

                def probe(i: int, root=root):
                    return record_batch.write_batch(root, [{"stream": "event", "record_id": f"probe-{i}", "event": "task_created",
                                                            "run_id": "RP", "task_id": f"P{i}"}], refresh=False)

                probe(0); probe(1)  # warm up before the measured write
                measured[multiplier] = _count_stream_bytes_read(lambda: probe(2))
                self.assertEqual(stream_ids(root, "event")[-3:], ["probe-0", "probe-1", "probe-2"])
                history = sum((root / name).stat().st_size for name in STREAM_FILES.values() if (root / name).exists())
                self.assertGreater(history, 1e5 * multiplier)
        self.assertLess(measured[1], 64 * 1024, f"a single write must not read the history: {measured}")
        self.assertLessEqual(measured[4], measured[1] + 4096, f"bytes read per write must not grow with history: {measured}")
        self.assertLessEqual(measured[2], measured[1] + 4096, measured)


if __name__ == "__main__":
    unittest.main()

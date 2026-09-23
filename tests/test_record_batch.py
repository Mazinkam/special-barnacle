"""Durable coordinated batch writes: validation, ordering, idempotent retries, and recovery.

Every test runs against a throwaway state root. Cross-process cases spawn the real CLI (or a
small child script) with ``CODING_AGENT_ORCHESTRATOR_HOME`` pointed at that root, so the lock,
checkpoint and ledger behaviour is exercised across process boundaries rather than in-process.
"""
from __future__ import annotations

import json
import os
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
        with patch.object(record_batch, "generate_dashboard", side_effect=RuntimeError("render exploded")):
            result = record_batch.write_batch(self.root, sample_batch())
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "refresh_failed")
        self.assertEqual(result["persisted"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertTrue(result["ledger_updated"])
        self.assertFalse(result["dashboard_updated"])
        self.assertIn("render exploded", result["error"])
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])
        # The retry must not append duplicates and must complete the refresh.
        retry = record_batch.write_batch(self.root, sample_batch())
        self.assertTrue(retry["ok"])
        self.assertEqual(retry["duplicates"], {"event": 3, "metric": 1, "outcome": 1})
        self.assertTrue(retry["dashboard_updated"])
        self.assertEqual(stream_ids(self.root, "event"), ["e-1", "e-2", "e-3"])

    def test_dashboard_failure_exit_code_distinguishes_durable_append(self):
        script = textwrap.dedent(
            """
            import sys, json
            from unittest.mock import patch
            from orchestrator import record_batch, cli
            sys.argv = ["orchestrator", "batch"]
            with patch.object(record_batch, "generate_dashboard", side_effect=RuntimeError("render exploded")):
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
        original = record_batch._append_stream

        def fail_metrics(path, lines):
            if path.name == "metrics.jsonl":
                raise OSError(28, "No space left on device")
            return original(path, lines)

        with patch.object(record_batch, "_append_stream", fail_metrics):
            with self.assertRaises(record_batch.BatchAppendError) as caught:
                record_batch.write_batch(self.root, sample_batch())
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
            def fail_metrics(path, lines):
                if path.name == "metrics.jsonl":
                    raise OSError(28, "No space left on device")
                return original(path, lines)
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


if __name__ == "__main__":
    unittest.main()

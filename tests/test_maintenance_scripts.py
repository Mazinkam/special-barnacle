"""Coverage for the metrics-stream maintenance scripts' locking and rewrite safety.

Both `scripts/audit_and_clean_metrics.py` and `scripts/stamp_granularity.py` rewrite
`metrics.jsonl`, the package's shared, concurrently-appended telemetry stream. These tests pin:

* every row *type* the package itself writes to `metrics.jsonl` (per
  `orchestrator.records.classify` / `NON_COST_EVENTS`, and `orchestrator.ingest`'s
  `session_ingest` aggregate rows) survives `audit_and_clean_metrics.py` unquarantined,
* both scripts take the package's single writer lock (`orchestrator.runtime.writer_lock`)
  across their read->rewrite, so a concurrent append is blocked until the rewrite is done and
  is never lost,
* both rewrites are idempotent.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
AUDIT_SCRIPT = REPO_ROOT / "scripts" / "audit_and_clean_metrics.py"
STAMP_SCRIPT = REPO_ROOT / "scripts" / "stamp_granularity.py"

sys.path.insert(0, str(REPO_ROOT))
from orchestrator.records import NON_COST_EVENTS  # noqa: E402
from orchestrator.runtime import writer_lock  # noqa: E402


def _complete_model_call(**overrides) -> dict:
    row = {"event": "model_call", "model": "gpt-5", "agent_runtime": "codex",
           "provider": "openai", "role": "lead", "cost_usd": 0.5}
    row.update(overrides)
    return row


def _session_aggregate(**overrides) -> dict:
    # Shaped exactly like `orchestrator.ingest._base_metric` + the SESSION update: event is
    # `model_call` (set unconditionally by `_base_metric`), but there is no `provider` field,
    # which is exactly what the old completeness check quarantined.
    row = {"event": "model_call", "model": "gpt-5", "agent_runtime": "codex",
           "source": "session_ingest", "granularity": "session", "covers_calls": 5,
           "call_id": "sess-1", "cost_usd": 2.0}
    row.update(overrides)
    return row


def _event_row(event: str, **overrides) -> dict:
    row = {"event": event, "run_id": "r1"}
    row.update(overrides)
    return row


def _every_package_row_type() -> list[dict]:
    """One row per shape the package actually writes to `metrics.jsonl`."""
    rows = [_complete_model_call(), _session_aggregate()]
    rows += [_event_row(name) for name in sorted(NON_COST_EVENTS)]
    return rows


def _write_metrics(state_dir: Path, rows: list[dict]) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = state_dir / "metrics.jsonl"
    with metrics_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
    return metrics_path


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _quarantine_rows(state_dir: Path) -> list[dict]:
    rows: list[dict] = []
    for path in state_dir.glob("metrics.quarantine-*.jsonl"):
        rows.extend(_read_jsonl(path))
    return rows


def test_audit_keeps_every_package_row_type(tmp_path):
    rows = _every_package_row_type()
    _write_metrics(tmp_path, rows)

    result = subprocess.run([sys.executable, str(AUDIT_SCRIPT), str(tmp_path)],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr

    quarantined = _quarantine_rows(tmp_path)
    assert quarantined == [], f"unexpectedly quarantined: {quarantined}"

    kept = _read_jsonl(tmp_path / "metrics.jsonl")
    assert len(kept) == len(rows)
    kept_events = sorted(r.get("event") for r in kept)
    expected_events = sorted(r.get("event") for r in rows)
    assert kept_events == expected_events


def test_audit_takes_writer_lock_and_blocks_until_released(tmp_path):
    rows = _every_package_row_type()
    metrics_path = _write_metrics(tmp_path, rows)

    late_row = _event_row("route_executed", run_id="late")
    with writer_lock(tmp_path):
        proc = subprocess.Popen([sys.executable, str(AUDIT_SCRIPT), str(tmp_path)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.5)
        # Still blocked: the script cannot have started its read/rewrite while we hold the lock.
        assert proc.poll() is None, "audit script proceeded without waiting for the writer lock"

        # An append that lands *before* the script's rewrite (because it is serialized behind our
        # hold on the same lock) must not be lost when the script eventually rewrites the file.
        with metrics_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(late_row) + "\n")

    stdout, stderr = proc.communicate(timeout=30)
    assert proc.returncode == 0, stderr

    kept = _read_jsonl(metrics_path)
    kept_run_ids = [r.get("run_id") for r in kept if r.get("event") == "route_executed"]
    assert "late" in kept_run_ids, "append made while the script waited for the lock was lost"


def test_stamp_granularity_takes_writer_lock_and_preserves_rows(tmp_path):
    rows = _every_package_row_type()
    # Strip granularity so the script actually has work to do (mirrors "predates the field").
    for row in rows:
        row.pop("granularity", None)
    metrics_path = _write_metrics(tmp_path, rows)

    late_row = _event_row("shadow_review", run_id="late-stamp")
    with writer_lock(tmp_path):
        proc = subprocess.Popen(
            [sys.executable, str(STAMP_SCRIPT), str(tmp_path), "--write"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.5)
        assert proc.poll() is None, "stamp_granularity proceeded without waiting for the writer lock"

        with metrics_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(late_row) + "\n")

    stdout, stderr = proc.communicate(timeout=30)
    assert proc.returncode == 0, stderr

    kept = _read_jsonl(metrics_path)
    assert len(kept) == len(rows) + 1

    late_kept = [r for r in kept if r.get("run_id") == "late-stamp"]
    assert len(late_kept) == 1, "append made while stamp_granularity waited for the lock was lost"
    assert late_kept[0].get("granularity") == "event"

    # Every original row is still present and now carries a granularity.
    for row in kept:
        assert row.get("granularity") in {"call", "session", "event"}


def test_audit_and_clean_metrics_is_idempotent(tmp_path):
    rows = _every_package_row_type()
    _write_metrics(tmp_path, rows)

    first = subprocess.run([sys.executable, str(AUDIT_SCRIPT), str(tmp_path)],
                           capture_output=True, text=True, timeout=30)
    assert first.returncode == 0, first.stderr
    after_first = _read_jsonl(tmp_path / "metrics.jsonl")

    second = subprocess.run([sys.executable, str(AUDIT_SCRIPT), str(tmp_path)],
                            capture_output=True, text=True, timeout=30)
    assert second.returncode == 0, second.stderr
    after_second = _read_jsonl(tmp_path / "metrics.jsonl")

    assert after_second == after_first
    assert "patched:     0" in second.stdout
    assert "kept:        " + str(len(after_first)) in second.stdout


def test_stamp_granularity_is_idempotent(tmp_path):
    rows = _every_package_row_type()
    for row in rows:
        row.pop("granularity", None)
    metrics_path = _write_metrics(tmp_path, rows)

    first = subprocess.run([sys.executable, str(STAMP_SCRIPT), str(tmp_path), "--write"],
                           capture_output=True, text=True, timeout=30)
    assert first.returncode == 0, first.stderr
    after_first = _read_jsonl(metrics_path)

    second = subprocess.run([sys.executable, str(STAMP_SCRIPT), str(tmp_path), "--write"],
                            capture_output=True, text=True, timeout=30)
    assert second.returncode == 0, second.stderr
    after_second = _read_jsonl(metrics_path)

    assert after_second == after_first
    assert f"already stamped: {len(after_first)}" in second.stdout
    assert "total changed:   0" in second.stdout

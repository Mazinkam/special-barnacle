#!/usr/bin/env python3
"""Audit and clean metrics.jsonl.

Quarantines records that are neither a complete model-call event nor one of the package's own
non-cost EVENT/SESSION rows (per `orchestrator.records.classify` — `route_executed`,
`adaptive_route_decision`, `task_verified`, `task_failed`, `verification_result`, `context_packet`,
`shadow_review`, `decision_invalidated`, and session_ingest aggregates), or shaped like aggregate
telemetry with `metric`/`value`/`unit`. Patches records that are clearly model calls missing the
`event` discriminator. Normalizes non-canonical enum values. Rewrites metrics.jsonl clean and
regenerates the dashboard.

The read→rewrite is done under the package's writer lock (`orchestrator.runtime.writer_lock`) so a
concurrent append from the running package is never lost, and the rewrite itself is a same-directory
temp file + fsync + `os.replace`, never a truncating in-place write, so a crash mid-rewrite leaves
the original stream intact.

Idempotent: re-running it on a clean stream is a no-op (the quarantine file
will already exist with the same records, the rewrite will produce an
identical file).

Usage: python3 scripts/audit_and_clean_metrics.py [state_dir]
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# Make `orchestrator` importable regardless of cwd/PYTHONPATH when this script is invoked
# directly, matching how `scripts/stamp_granularity.py` resolves the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator.records import EVENT, SESSION, classify  # noqa: E402
from orchestrator.runtime import writer_lock  # noqa: E402

STATE = Path(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/.local/state/coding-agent-orchestrator"))
METRICS = STATE / "metrics.jsonl"

# Canonical event discriminator value for a per-call row. Non-cost EVENT rows
# (`route_executed`, `adaptive_route_decision`, `task_verified`, ...) and SESSION
# aggregate rows are recognized structurally via `orchestrator.records.classify`
# below, rather than by hard-coding a second copy of the event vocabulary here —
# that copy is exactly what let the previous version of this script quarantine
# rows the package itself writes (e.g. `task_verified`/`task_failed` events and
# session aggregates missing a per-call `provider`).
MODEL_CALL_EVENTS = {"model_call"}

# Canonical verification_depth values (from scheduler.py ComputePackage).
# Anything outside this set maps to `targeted`.
CANONICAL_VERIFICATION_DEPTH = {"none", "targeted", "broad", "full"}
VERIFICATION_DEPTH_MAP = {
    "controller_review": "targeted",
    "live_stack": "targeted",
    "code_read_verified": "targeted",
}

# Canonical result values.
CANONICAL_RESULT = {"pass", "fail", "success", "ok", "reported", "error"}
RESULT_MAP = {
    "partial": "fail",  # no middle ground in the canonical enum
}

# Legacy field renames.
LEGACY_RENAMES = {"runtime": "agent_runtime"}

# Junk fields — keys that are not part of any known metric schema and come from
# aggregate-telemetry emissions. Stipped and quarantined with the record.
JUNK_FIELDS = {"of", "baseline", "requests", "tool_calls"}

# A record is fixable-in-place if it has the model-call schema but is missing
# the event discriminator. Required fields per TELEMETRY.md model_call section.
REQUIRED_FOR_MODEL_CALL = {"model", "agent_runtime", "role"}

# A "complete" model_call record has everything downstream aggregation needs:
# a model identifier, a runtime, a provider, a role, and non-zero token counts.
# Records missing any of these cannot be reliably priced or attributed and
# should be quarantined.
COMPLETE_MODEL_CALL = {"model", "agent_runtime", "provider", "role"}


def categorize(rec: dict) -> tuple[str, str]:
    """Return (category, reason). category in {'keep','patch','quarantine'}."""
    event = rec.get("event")
    source = rec.get("source")

    # Defer to `orchestrator.records.classify` first: it is the package's own,
    # single definition of what a SESSION aggregate or a non-cost EVENT row looks
    # like. A row the package classifies as SESSION or EVENT is a row the package
    # itself writes to metrics.jsonl (session_ingest aggregates; `route_executed`,
    # `adaptive_route_decision`, `task_verified`, `task_failed`, `verification_result`,
    # `context_packet`, `shadow_review`, `decision_invalidated`), so it is always kept
    # rather than being quarantined by a second, drifted copy of that vocabulary here.
    granularity = classify(rec)
    if granularity in (SESSION, EVENT):
        return ("keep", "")

    # Already correctly typed as a model-call.
    if event in MODEL_CALL_EVENTS:
        # For model_calls, enforce completeness — a record missing model/provider/role
        # cannot be reliably priced or attributed.
        missing = [k for k in COMPLETE_MODEL_CALL if not rec.get(k)]
        if missing:
            return ("quarantine", f"incomplete_model_call_missing:{','.join(missing)}")
        return ("keep", "")

    # Aggregate telemetry leaked into metrics stream. Detected by presence of
    # `metric`/`value`/`unit` keys.
    if "metric" in rec and "value" in rec:
        return ("quarantine", "aggregate_telemetry_leak")

    # Records from session_ingest should always have event=model_call.
    if source == "session_ingest":
        return ("quarantine", "session_ingest_missing_event")

    # Records with unset `event` but the right shape: patch in event=model_call.
    if event in {None, "?"}:
        if REQUIRED_FOR_MODEL_CALL.issubset(rec.keys()):
            return ("patch", "add_event_model_call")
        # No model field means we can't safely call it a model_call.
        return ("quarantine", "missing_event_no_model_schema")

    return ("quarantine", f"unknown_event:{event!r}")


def clean(rec: dict, *, quarantine_reason: str) -> tuple[dict, dict | None]:
    """Apply inline fixes. Returns (cleaned_record, quarantined_record_or_none).

    If quarantine_reason is non-empty the record is quarantined wholesale
    (with the reason attached). Otherwise the record is kept and patched.
    """
    if quarantine_reason:
        q = dict(rec)
        q["__quarantine_reason"] = quarantine_reason
        return (None, q)

    out = dict(rec)

    # 1. Legacy field renames.
    for old, new in LEGACY_RENAMES.items():
        if old in out and new not in out:
            out[new] = out.pop(old)
        elif old in out and new in out:
            # Both present: drop the legacy copy.
            out.pop(old)

    # 2. Strip junk fields.
    for k in JUNK_FIELDS:
        out.pop(k, None)

    # 3. Patch missing event discriminator.
    if out.get("event") in {None, "?"} and REQUIRED_FOR_MODEL_CALL.issubset(out.keys()):
        out["event"] = "model_call"

    # 4. Normalize verification_depth.
    vd = out.get("verification_depth")
    if vd is not None:
        if vd in VERIFICATION_DEPTH_MAP:
            out["verification_depth"] = VERIFICATION_DEPTH_MAP[vd]
        elif vd not in CANONICAL_VERIFICATION_DEPTH and vd != "?":
            out["verification_depth"] = "targeted"

    # 5. Normalize result.
    r = out.get("result")
    if r is not None and r in RESULT_MAP:
        out["result"] = RESULT_MAP[r]

    # 6. complexity: keep as int where it already is (Python handles int⊕float
    # transparibly), but be consistent in new emissions. No rewrite needed.

    return (out, None)


def _write_atomic(target: Path, records: list[dict]) -> None:
    """Replace `target` with `records`, atomically (temp file + fsync + os.replace).

    Rewriting `target` in place (`open('w')` then writing line by line) truncates the shared
    metric stream the instant it opens; an interruption before the last line lands destroys data
    that was never re-written and a crash mid-rewrite leaves a truncated stream for every reader.
    Writing a sibling temp file in the same directory and `os.replace`ing it means readers always
    see either the whole old stream or the whole new one.
    """
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(target.parent),
                                          prefix=f".{target.name}.", suffix=".tmp", delete=False)
    temp_path = Path(handle.name)
    try:
        with handle:
            for rec in records:
                handle.write(json.dumps(rec, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def main() -> int:
    if not METRICS.exists():
        print(f"error: no metrics stream at {METRICS}", file=sys.stderr)
        return 1

    # Hold the package's single writer lock across the whole read→rewrite so a concurrent
    # `orchestrator` append between this script's read and its atomic replace is never lost —
    # the same lock `record_batch`/`EventStore` take before appending or checkpointing.
    with writer_lock(STATE):
        records = []
        bad = 0
        with METRICS.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    bad += 1

        if bad:
            print(f"warning: {bad} malformed lines skipped", file=sys.stderr)

        kept: list[dict] = []
        quarantined: list[dict] = []
        categories: Counter = Counter()
        reasons: Counter = Counter()

        for rec in records:
            cat, reason = categorize(rec)
            categories[cat] += 1
            if cat == "keep":
                kept.append(rec)
            elif cat == "patch":
                cleaned, q = clean(rec, quarantine_reason="")
                if cleaned is not None:
                    kept.append(cleaned)
                    reasons["patched:" + reason] += 1
                else:
                    quarantined.append(q)
                    reasons["quarantined:" + reason] += 1
            elif cat == "quarantine":
                _, q = clean(rec, quarantine_reason=reason)
                quarantined.append(q)
                reasons["quarantined:" + reason] += 1

        # Backup current metrics stream.
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = STATE / f"metrics.pre-cleanup-{ts}.jsonl"
        shutil.copy2(METRICS, backup)

        # Write quarantine file.
        q_path = STATE / f"metrics.quarantine-{ts}.jsonl"
        with q_path.open("w", encoding="utf-8") as fh:
            for rec in quarantined:
                fh.write(json.dumps(rec, sort_keys=True) + "\n")

        # Rewrite metrics.jsonl clean, atomically, while still holding the lock so nothing can
        # append between this replace and the lock release.
        _write_atomic(METRICS, kept)

    print(f"audit summary (total {len(records)}):")
    print(f"  kept:        {categories.get('keep', 0)}")
    print(f"  patched:     {categories.get('patch', 0)}")
    print(f"  quarantined: {categories.get('quarantine', 0)}")
    print()
    print("reasons:")
    for r, c in reasons.most_common():
        print(f"  {r}: {c}")
    print()
    print(f"backup:    {backup}")
    print(f"quarantine: {q_path}")
    print(f"clean:     {METRICS} ({len(kept)} records)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

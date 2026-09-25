"""Coverage for `scripts/backfill_nested_costs.py` (Phase 1 items 2-3, the follow-on review's
R4/S1-S5 hardening findings, and the third round's F1-F5 findings that replaced in-place
`--state-root`/`--apply`/`--rollback` mutation with a strictly copy-then-backfill
`--source`/`--output`/`--apply` contract).

Mixes direct-import unit tests (replay/plan/safety-primitive logic) with subprocess-level tests for
the CLI safety gates (dry-run default, protected-root refusal with no override, unsafe-source-tree
abort, output-stream-hazard abort, idempotent chained `--apply`) — the same mix
`tests/test_maintenance_scripts.py` uses for the other metrics-stream maintenance scripts.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "backfill_nested_costs.py"

sys.path.insert(0, str(REPO_ROOT))

_spec = importlib.util.spec_from_file_location("backfill_nested_costs", SCRIPT)
backfill = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(backfill)  # type: ignore[union-attr]


def _dispatch_finished(run_id="r1", task_id="r1-lead-0", nested_cost_usd=None, dispatch_attempt=None,
                       **extra):
    ev = {"event": "dispatch_finished", "run_id": run_id, "task_id": task_id,
          "record_id": f"df-{run_id}-{task_id}-{dispatch_attempt}"}
    if nested_cost_usd is not None:
        ev["nested_cost_usd"] = nested_cost_usd
    if dispatch_attempt is not None:
        ev["dispatch_attempt"] = dispatch_attempt
    ev.update(extra)
    return ev


def _subagent_end(tool_call_id, results):
    return {"type": "tool_execution_end", "toolCallId": tool_call_id, "toolName": "subagent",
            "result": {"content": [], "details": {"mode": "single", "agentScope": "user",
                                                   "projectAgentsDir": None, "results": results}}}


def _subagent_update(tool_call_id, results):
    return {"type": "tool_execution_update", "toolCallId": tool_call_id, "toolName": "subagent",
            "partialResult": {"details": {"results": results}}}


def _result(task_id="tc1-0", agent="orch-qa-agent", model="global.anthropic.claude-sonnet-5",
           cost=0.03, exit_code=0, **over):
    r = {"agent": agent, "agentSource": "user", "task": "t", "taskId": task_id, "parentTaskId": "tc1",
         "depth": 1, "exitCode": exit_code, "messages": [], "stderr": "",
         "usage": {"input": 8, "output": 333, "cacheRead": 0, "cacheWrite": 0, "cost": cost, "contextTokens": 8708, "turns": 1},
         "model": model, "isolation": "worktree", "stopReason": "stop"}
    r.update(over)
    return r


def _write_state(root: Path, *, events=(), run_logs=None, metrics=()):
    root.mkdir(parents=True, exist_ok=True)
    (root / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
    (root / "metrics.jsonl").write_text("".join(json.dumps(m) + "\n" for m in metrics), encoding="utf-8")
    (root / "outcomes.jsonl").write_text("", encoding="utf-8")
    for (run_id, task_id), lines in (run_logs or {}).items():
        d = root / "runs" / run_id
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{task_id}.events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in lines), encoding="utf-8")


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _run(*args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=timeout)


def _env_without_orchestrator_home() -> dict[str, str]:
    import os
    return {k: v for k, v in os.environ.items() if k != "CODING_AGENT_ORCHESTRATOR_HOME"}


# --- bounded, provenance-preserving JSONL reading (S5) --------------------------------------------

class BoundedJsonlReadingTests(unittest.TestCase):
    def test_oversized_line_is_skipped_and_line_numbers_stay_physical(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            huge = json.dumps({"x": "a" * (backfill.MAX_LINE_BYTES + 1024)})
            path.write_text(huge + "\n" + json.dumps({"ok": 1}) + "\n", encoding="utf-8")
            results = list(backfill.iter_physical_jsonl(path))
            self.assertEqual(results, [(1, None, "oversized_line"), (2, {"ok": 1}, None)])

    def test_deep_nesting_json_does_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            deep = "[" * 100_000 + "]" * 100_000
            path.write_text(deep + "\n" + json.dumps({"ok": 1}) + "\n", encoding="utf-8")
            results = list(backfill.iter_physical_jsonl(path))
            self.assertEqual(results[0], (1, None, "deep_nesting"))
            self.assertEqual(results[1], (2, {"ok": 1}, None))

    def test_malformed_json_is_skipped_but_blank_lines_are_not_treated_as_errors(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            path.write_text("not json\n\n" + json.dumps({"ok": 1}) + "\n", encoding="utf-8")
            results = list(backfill.iter_physical_jsonl(path))
            self.assertEqual(results[0][2], "malformed_json")
            self.assertEqual(results[1], (2, None, None))
            self.assertEqual(results[2], (3, {"ok": 1}, None))

    def test_line_numbers_survive_a_mix_of_skips(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            oversized = json.dumps({"x": "a" * (backfill.MAX_LINE_BYTES + 10)})
            lines = ["bad json", oversized, "", json.dumps({"n": 4})]
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            results = list(backfill.iter_physical_jsonl(path))
            self.assertEqual([r[0] for r in results], [1, 2, 3, 4])
            self.assertEqual(results[3], (4, {"n": 4}, None))


# --- finite non-negative cost enforcement ----------------------------------------------------------

class FiniteCostTests(unittest.TestCase):
    def test_inf_and_nan_are_rejected(self):
        self.assertIsNone(backfill._finite_nonneg_or_none(float("inf")))
        self.assertIsNone(backfill._finite_nonneg_or_none(float("-inf")))
        self.assertIsNone(backfill._finite_nonneg_or_none(float("nan")))

    def test_negative_is_rejected(self):
        self.assertIsNone(backfill._finite_nonneg_or_none(-0.01))

    def test_finite_nonnegative_is_accepted(self):
        self.assertEqual(backfill._finite_nonneg_or_none(0.03), 0.03)
        self.assertEqual(backfill._finite_nonneg_or_none(0), 0.0)

    def test_non_numeric_and_bool_are_rejected(self):
        self.assertIsNone(backfill._finite_nonneg_or_none("0.03"))
        self.assertIsNone(backfill._finite_nonneg_or_none(True))

    def test_inf_cost_in_a_replayed_call_is_unreported_not_zero(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            r = _result()
            r["usage"]["cost"] = float("inf")
            path.write_text(json.dumps(_subagent_end("c1", [r])) + "\n", encoding="utf-8")
            [entry] = backfill.replay_nested_calls(path).values()
            self.assertFalse(entry["costReported"])
            self.assertIsNone(entry["usage"]["cost"])


# --- dispatch_attempt validation (F4) ---------------------------------------------------------------

class DispatchAttemptValidationTests(unittest.TestCase):
    def test_plain_ints_in_range_are_valid(self):
        self.assertEqual(backfill._valid_dispatch_attempt(0), 0)
        self.assertEqual(backfill._valid_dispatch_attempt(1), 1)
        self.assertEqual(backfill._valid_dispatch_attempt(16), 16)

    def test_integral_floats_accepted_as_int(self):
        self.assertEqual(backfill._valid_dispatch_attempt(1.0), 1)

    def test_out_of_range_is_invalid(self):
        self.assertIsNone(backfill._valid_dispatch_attempt(17))
        self.assertIsNone(backfill._valid_dispatch_attempt(-1))

    def test_non_integral_float_is_invalid(self):
        self.assertIsNone(backfill._valid_dispatch_attempt(1.5))

    def test_infinity_and_nan_never_crash_and_are_invalid(self):
        self.assertIsNone(backfill._valid_dispatch_attempt(float("inf")))
        self.assertIsNone(backfill._valid_dispatch_attempt(float("-inf")))
        self.assertIsNone(backfill._valid_dispatch_attempt(float("nan")))

    def test_strings_and_bools_are_invalid(self):
        self.assertIsNone(backfill._valid_dispatch_attempt("1"))
        self.assertIsNone(backfill._valid_dispatch_attempt(True))
        self.assertIsNone(backfill._valid_dispatch_attempt(None))

    def test_malformed_dispatch_attempt_field_never_crashes_and_reads_as_absent(self):
        self.assertIsNone(backfill._dispatch_attempt_field({"dispatch_attempt": float("inf")}))
        self.assertIsNone(backfill._dispatch_attempt_field({"dispatch_attempt": "bogus"}))
        self.assertIsNone(backfill._dispatch_attempt_field({"dispatch_attempt": 1.5}))
        self.assertEqual(backfill._dispatch_attempt_default_zero({"dispatch_attempt": float("nan")}), 0)

    def test_malformed_dispatch_attempt_on_a_pair_makes_it_unprovable(self):
        for bad in (float("nan"), float("inf"), "not-a-number", 1.5, True, 17):
            with self.subTest(bad=bad):
                group = [(1, {"dispatch_attempt": bad}), (2, {"dispatch_attempt": 1})]
                self.assertIsNone(backfill._separate_attempts(group))


# --- run-id / run-log path safety (S4) --------------------------------------------------------------

class RunIdSafetyTests(unittest.TestCase):
    def test_path_traversal_run_id_is_rejected(self):
        for bad in ("../etc", "..", ".", "a/b", "a\\b", ""):
            with self.subTest(bad=bad):
                self.assertFalse(backfill.valid_run_id(bad))

    def test_plausible_run_ids_are_accepted(self):
        for good in ("ht-orch-1790193397618-nmac8d", "r1", "run.1_2-3"):
            with self.subTest(good=good):
                self.assertTrue(backfill.valid_run_id(good))

    def test_invalid_run_id_never_reaches_the_filesystem(self):
        with tempfile.TemporaryDirectory() as d:
            runs_dir = Path(d) / "runs"
            runs_dir.mkdir()
            path, reason = backfill.safe_run_log_path(runs_dir, "../escape", "t1")
            self.assertIsNone(path)
            self.assertEqual(reason, "invalid_run_id")

    def test_symlinked_run_dir_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runs_dir = root / "runs"
            runs_dir.mkdir()
            outside = root / "outside"
            outside.mkdir()
            (outside / "t1.events.jsonl").write_text(json.dumps(_subagent_end("c1", [_result(cost=99.0)])) + "\n")
            (runs_dir / "r1").symlink_to(outside)
            path, reason = backfill.safe_run_log_path(runs_dir, "r1", "t1")
            self.assertIsNone(path)
            self.assertEqual(reason, "symlinked_run_dir")

    def test_symlinked_run_log_file_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runs_dir = root / "runs"
            run_dir = runs_dir / "r1"
            run_dir.mkdir(parents=True)
            target = root / "target.jsonl"
            target.write_text(json.dumps(_subagent_end("c1", [_result(cost=99.0)])) + "\n")
            (run_dir / "t1.events.jsonl").symlink_to(target)
            path, reason = backfill.safe_run_log_path(runs_dir, "r1", "t1")
            self.assertIsNone(path)
            self.assertEqual(reason, "symlinked_run_log")

    def test_a_symlinked_run_dir_never_contributes_rows_via_plan_backfill(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=99.0)])
            outside = root.parent / f"{root.name}-outside"
            outside.mkdir()
            (outside / "r1-lead-0.events.jsonl").write_text(
                json.dumps(_subagent_end("c1", [_result(cost=99.0)])) + "\n")
            (root / "runs").mkdir()
            (root / "runs" / "r1").symlink_to(outside)
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["skipped_unsafe"]), 1)
            self.assertEqual(plan["skipped_unsafe"][0]["reason"], "symlinked_run_dir")


# --- symlink-escape guard on the state root itself (S1) ----------------------------------------

class SymlinkEscapeGuardTests(unittest.TestCase):
    def test_symlinked_metrics_jsonl_is_rejected(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            root = Path(d1) / "state"
            outside = Path(d2) / "evil.jsonl"
            outside.write_text("not really metrics.jsonl\n")
            _write_state(root, events=[])
            (root / "metrics.jsonl").unlink()
            (root / "metrics.jsonl").symlink_to(outside)
            with self.assertRaises(backfill.SymlinkEscapeError):
                backfill.reject_symlink_escape(root)

    def test_symlinked_runs_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            root = Path(d1) / "state"
            outside = Path(d2)
            _write_state(root, events=[])
            (root / "runs").symlink_to(outside)
            with self.assertRaises(backfill.SymlinkEscapeError):
                backfill.reject_symlink_escape(root)

    def test_a_plain_state_root_passes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[])
            backfill.reject_symlink_escape(root)  # must not raise

    def test_cli_dry_run_refuses_a_symlinked_metrics_jsonl(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            root = Path(d1) / "state"
            outside = Path(d2) / "evil.jsonl"
            outside.write_text("x\n")
            _write_state(root, events=[])
            (root / "metrics.jsonl").unlink()
            (root / "metrics.jsonl").symlink_to(outside)
            proc = _run("--source", str(root))
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("resolves outside the state root", proc.stderr)


# --- existing-coverage overlap detection (R4) -------------------------------------------------------

class OverlapDetectionTests(unittest.TestCase):
    def test_overlap_via_nested_flag_is_detected(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "metrics.jsonl"
            path.write_text(json.dumps({"event": "model_call", "run_id": "r1", "parent_task_id": "t1",
                                        "nested": True}) + "\n", encoding="utf-8")
            covered = backfill.existing_nested_coverage(path, skip_counts={})
            self.assertIn(("r1", "t1"), covered)

    def test_overlap_via_record_id_prefix_is_detected(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "metrics.jsonl"
            path.write_text(json.dumps({"event": "model_call",
                                        "record_id": "nested:r1:t1:0:call1:tc1-0:0"}) + "\n", encoding="utf-8")
            covered = backfill.existing_nested_coverage(path, skip_counts={})
            self.assertIn(("r1", "t1"), covered)

    def test_plan_backfill_skips_a_dispatch_already_covered_by_an_existing_row(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(
                root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]},
                metrics=[{"event": "model_call", "run_id": "r1", "parent_task_id": "r1-lead-0", "nested": True,
                         "record_id": "nested:r1:r1-lead-0:0:existing:x:0"}],
            )
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["already_covered"]), 1)


# --- per-attempt planning + old-bug cumulative-sum detection ----------------------------------------

class PerAttemptPlanningTests(unittest.TestCase):
    def test_single_event_no_dispatch_attempt_field_defaults_to_attempt_zero(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                        run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})
            plan = backfill.plan_backfill(root)
            self.assertEqual(len(plan["reconciled"]), 1)
            self.assertEqual(plan["rows_to_add"][0]["dispatch_attempt"], 0)
            self.assertEqual(plan["rows_to_add"][0]["record_id"], "nested:r1:r1-lead-0:0:c1:tc1-0:0")

    def test_two_explicit_distinct_attempts_are_planned_and_reconciled_independently(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(
                root,
                events=[_dispatch_finished(nested_cost_usd=0.03, dispatch_attempt=0),
                       _dispatch_finished(nested_cost_usd=0.05, dispatch_attempt=1)],
                run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03, task_id="tc1-0")])],
                         ("r1", "r1-lead-0-fallback"): [_subagent_end("c2", [_result(cost=0.05, task_id="tc2-0")])]},
            )
            plan = backfill.plan_backfill(root)
            self.assertEqual(len(plan["reconciled"]), 2)
            record_ids = sorted(r["record_id"] for r in plan["rows_to_add"])
            self.assertEqual(record_ids, ["nested:r1:r1-lead-0:0:c1:tc1-0:0", "nested:r1:r1-lead-0:1:c2:tc2-0:0"])

    def test_two_events_missing_dispatch_attempt_are_ambiguous_old_bug_candidates(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(
                root,
                events=[_dispatch_finished(nested_cost_usd=0.03, superseded_by_fallback=True),
                       _dispatch_finished(nested_cost_usd=0.08)],
                run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.08)])]},
            )
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["ambiguous"]), 1)
            self.assertIn("cumulative-sum", plan["ambiguous"][0]["reason"])

    def test_two_events_with_the_same_explicit_attempt_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(
                root,
                events=[_dispatch_finished(nested_cost_usd=0.03, dispatch_attempt=0),
                       _dispatch_finished(nested_cost_usd=0.08, dispatch_attempt=0)],
            )
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["ambiguous"]), 1)

    def test_more_than_two_events_for_one_task_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[
                _dispatch_finished(nested_cost_usd=0.01, dispatch_attempt=0),
                _dispatch_finished(nested_cost_usd=0.02, dispatch_attempt=1),
                _dispatch_finished(nested_cost_usd=0.03, dispatch_attempt=2),
            ])
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["ambiguous"]), 1)

    def test_a_malformed_dispatch_attempt_on_one_event_of_a_pair_is_ambiguous_not_a_crash(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[
                _dispatch_finished(nested_cost_usd=0.01, dispatch_attempt=float("nan")),
                _dispatch_finished(nested_cost_usd=0.02, dispatch_attempt=1),
            ])
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["ambiguous"]), 1)


# --- reconciliation buckets: per-call reconciled vs event-log-only vs ambiguous ---------------------

class ReconciliationBucketTests(unittest.TestCase):
    def test_reconciling_detail_is_booked_per_call_reconciled(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                        run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})
            plan = backfill.plan_backfill(root)
            self.assertEqual(len(plan["rows_to_add"]), 1)
            self.assertEqual(len(plan["reconciled"]), 1)
            self.assertEqual(plan["rows_to_add"][0]["backfill_evidence"], "reconciled_with_aggregate")

    def test_mismatched_sum_is_ambiguous_and_nothing_is_booked(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=4.19)],
                        run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["ambiguous"]), 1)

    def test_missing_aggregate_key_books_as_event_log_only_no_aggregate(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished()],
                        run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})
            plan = backfill.plan_backfill(root)
            self.assertEqual(len(plan["rows_to_add"]), 1)
            self.assertEqual(plan["ambiguous"], [])
            self.assertEqual(len(plan["unverifiable_total"]), 1)
            self.assertEqual(plan["rows_to_add"][0]["backfill_evidence"], "event_log_only_no_aggregate")

    def test_non_finite_aggregate_is_ambiguous_not_booked(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=float("inf"))],
                        run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["ambiguous"]), 1)

    def test_no_log_evidence_is_reported_not_booked(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=1.0)])
            plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["no_evidence"]), 1)


class RoleForAgentNameTests(unittest.TestCase):
    def test_known_prefix_and_aliases(self):
        self.assertEqual(backfill.role_for_agent_name("orch-scout"), "scout")
        self.assertEqual(backfill.role_for_agent_name("orch-implementation-strong"), "implementation_strong")
        self.assertEqual(backfill.role_for_agent_name("orchestrator-lead"), "lead_large")

    def test_unknown_agent_is_explicit_unknown(self):
        self.assertEqual(backfill.role_for_agent_name(None), "unknown")
        self.assertEqual(backfill.role_for_agent_name("something-custom"), "unknown")


class ReplayNestedCallsTests(unittest.TestCase):
    def test_missing_log_file_yields_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(backfill.replay_nested_calls(Path(d) / "missing.events.jsonl"), {})

    def test_latest_wins_across_duplicate_update_snapshots(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            path.write_text(
                json.dumps(_subagent_update("c1", [_result(cost=0.01)])) + "\n"
                + json.dumps(_subagent_end("c1", [_result(cost=0.03)])) + "\n",
                encoding="utf-8")
            entries = backfill.replay_nested_calls(path)
            self.assertEqual(len(entries), 1)
            key = next(iter(entries))
            self.assertAlmostEqual(entries[key]["usage"]["cost"], 0.03)

    def test_distinct_attempts_on_the_same_task_id_are_not_collapsed(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            path.write_text(
                json.dumps(_subagent_end("c1", [_result(task_id="t1", cost=0.5, exit_code=1, attempt=0)])) + "\n"
                + json.dumps(_subagent_end("c1", [_result(task_id="t1", cost=0.7, exit_code=0, attempt=1)])) + "\n",
                encoding="utf-8")
            entries = backfill.replay_nested_calls(path)
            self.assertEqual(len(entries), 2)

    def test_unreported_cost_stays_none_not_zero(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            r = _result()
            r["usage"] = {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "cost": None, "contextTokens": 1, "turns": 1}
            path.write_text(json.dumps(_subagent_end("c1", [r])) + "\n", encoding="utf-8")
            [entry] = backfill.replay_nested_calls(path).values()
            self.assertFalse(entry["costReported"])
            self.assertIsNone(entry["usage"]["cost"])

    def test_source_line_is_the_real_physical_line_even_after_skipped_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            path.write_text(
                "not json\n\n" + json.dumps(_subagent_end("c1", [_result(cost=0.03)])) + "\n",
                encoding="utf-8")
            [entry] = backfill.replay_nested_calls(path).values()
            self.assertEqual(entry["source_line"], 3)

    def test_a_later_update_with_no_valid_cost_never_erases_an_earlier_reported_one(self):
        # T5/F2: mirrors NestedCostTracker.observe exactly. A later observation missing/invalid
        # cost must not overwrite the last VALID one, but every other field still refreshes.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            first = _subagent_update("c1", [_result(task_id="t1", cost=0.05, exit_code=None)])
            second = _subagent_end("c1", [_result(task_id="t1", cost=None, exit_code=0, stop_reason="stop")])
            second["result"]["details"]["results"][0]["usage"]["cost"] = None
            path.write_text(json.dumps(first) + "\n" + json.dumps(second) + "\n", encoding="utf-8")
            [entry] = backfill.replay_nested_calls(path).values()
            self.assertAlmostEqual(entry["usage"]["cost"], 0.05)
            self.assertTrue(entry["costReported"])
            self.assertEqual(entry["exitCode"], 0)  # non-cost fields still refresh to latest
            self.assertEqual(entry["source_line"], 2)

    def test_two_valid_costs_the_later_one_wins_not_summed(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            path.write_text(
                json.dumps(_subagent_update("c1", [_result(task_id="t1", cost=0.05)])) + "\n"
                + json.dumps(_subagent_end("c1", [_result(task_id="t1", cost=0.09)])) + "\n",
                encoding="utf-8")
            [entry] = backfill.replay_nested_calls(path).values()
            self.assertAlmostEqual(entry["usage"]["cost"], 0.09)


# --- bounded retention (F3): caps enforced before insertion, over-cap groups collapse -------------

class BoundedRetentionTests(unittest.TestCase):
    def test_replay_nested_calls_enforces_max_entries_before_inserting(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            results = [_result(task_id=f"tc{i}", cost=0.01) for i in range(5)]
            path.write_text(json.dumps(_subagent_end("c1", results)) + "\n", encoding="utf-8")
            with self.assertRaises(backfill.PlanTooLargeError):
                backfill.replay_nested_calls(path, max_entries=2)
            # a cap large enough for all 5 keys succeeds normally
            entries = backfill.replay_nested_calls(path, max_entries=10)
            self.assertEqual(len(entries), 5)

    def test_replay_nested_calls_does_not_grow_past_the_cap_when_refreshing_an_existing_key(self):
        # Refreshing an ALREADY-tracked key must never count against the cap again.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.events.jsonl"
            path.write_text(
                json.dumps(_subagent_update("c1", [_result(task_id="t1", cost=0.01)])) + "\n"
                + json.dumps(_subagent_end("c1", [_result(task_id="t1", cost=0.02)])) + "\n",
                encoding="utf-8")
            entries = backfill.replay_nested_calls(path, max_entries=1)  # only 1 distinct key ever
            self.assertEqual(len(entries), 1)

    def test_group_dispatch_finished_events_caps_events_per_group_before_appending(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "events.jsonl"
            events = [_dispatch_finished(task_id="t1", dispatch_attempt=i, nested_cost_usd=1.0) for i in range(5)]
            path.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
            groups, overflow, _skip = backfill._group_dispatch_finished_events(
                path, cap=1000, max_events_per_group=2, max_total_events=1000)
            self.assertEqual(len(groups[("r1", "t1")]), 2)
            self.assertEqual(overflow[("r1", "t1")], 3)

    def test_group_dispatch_finished_events_caps_total_events_before_appending(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "events.jsonl"
            events = [_dispatch_finished(task_id=f"t{i}", nested_cost_usd=1.0) for i in range(5)]
            path.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
            with self.assertRaises(backfill.PlanTooLargeError):
                backfill._group_dispatch_finished_events(path, cap=1000, max_events_per_group=100,
                                                         max_total_events=2)

    def test_group_dispatch_finished_events_caps_distinct_groups_before_a_new_key_is_inserted(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "events.jsonl"
            events = [_dispatch_finished(task_id=f"t{i}", nested_cost_usd=1.0) for i in range(5)]
            path.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
            with self.assertRaises(backfill.PlanTooLargeError):
                backfill._group_dispatch_finished_events(path, cap=2, max_events_per_group=100,
                                                         max_total_events=1000)

    def test_an_over_cap_group_collapses_into_a_bounded_ambiguous_summary_via_plan_backfill(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            events = [_dispatch_finished(nested_cost_usd=1.0, dispatch_attempt=i) for i in range(5)]
            _write_state(root, events=events)
            with patch.object(backfill, "MAX_EVENTS_PER_GROUP", 2):
                plan = backfill.plan_backfill(root)
            self.assertEqual(plan["rows_to_add"], [])
            self.assertEqual(len(plan["ambiguous"]), 1)
            entry = plan["ambiguous"][0]
            self.assertEqual(entry["events"], 5)  # true total, even though only 2 were retained
            self.assertIn("collapsed into this bounded summary", entry["reason"])


# --- planning size cap (S5) --------------------------------------------------------------------------

class PlanTooLargeTests(unittest.TestCase):
    def test_too_many_dispatch_groups_aborts_with_a_clear_error(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            events = [_dispatch_finished(task_id=f"t{i}", nested_cost_usd=0.01) for i in range(5)]
            _write_state(root, events=events)
            with patch.object(backfill, "MAX_RETAINED_RECORDS", 2):
                with self.assertRaises(backfill.PlanTooLargeError):
                    backfill.plan_backfill(root)

    def test_cli_dry_run_reports_the_abort_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            events = [_dispatch_finished(task_id=f"t{i}", nested_cost_usd=0.01) for i in range(5)]
            _write_state(root, events=events)
            with patch.object(backfill, "MAX_RETAINED_RECORDS", 2):
                rc = backfill.main(["--source", str(root)])
            self.assertEqual(rc, 3)
            self.assertEqual((root / "metrics.jsonl").read_text(), "")

    def test_cli_apply_leaves_the_partial_output_in_place_with_an_incomplete_marker_on_plan_too_large(self):
        # Phase 1 review B2: --output is NEVER recursively deleted on failure, no matter the cause.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            events = [_dispatch_finished(task_id=f"t{i}", nested_cost_usd=0.01) for i in range(5)]
            _write_state(root, events=events)
            output = Path(d) / "out"
            with patch.object(backfill, "MAX_RETAINED_RECORDS", 2):
                rc = backfill.main(["--source", str(root), "--output", str(output), "--apply"])
            self.assertEqual(rc, 3)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())


# --- copy-then-backfill contract (F-round-3) -------------------------------------------------------

class SourceUntouchedTests(unittest.TestCase):
    """Dry-run and --apply must NEVER write to --source, in any outcome."""

    def _state(self, root: Path):
        _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                    run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})

    def test_dry_run_is_the_default_and_writes_nothing_at_all(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            before = (root / "metrics.jsonl").read_text(encoding="utf-8")
            entries_before = sorted(p.name for p in root.iterdir())
            proc = _run("--source", str(root))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("dry-run only", proc.stdout)
            self.assertEqual((root / "metrics.jsonl").read_text(encoding="utf-8"), before)
            self.assertEqual(sorted(p.name for p in root.iterdir()), entries_before)

    def test_apply_never_writes_to_source_even_on_success(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            before_metrics = (root / "metrics.jsonl").read_text(encoding="utf-8")
            before_events = (root / "events.jsonl").read_text(encoding="utf-8")
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual((root / "metrics.jsonl").read_text(encoding="utf-8"), before_metrics)
            self.assertEqual((root / "events.jsonl").read_text(encoding="utf-8"), before_events)
            self.assertFalse((root / "ledger.lock").exists())
            self.assertFalse((root / "ledger.json").exists())

    def test_apply_requires_output(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            proc = _run("--source", str(root), "--apply")
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("--output is required", proc.stderr)


class OutputCopySemanticsTests(unittest.TestCase):
    def _state(self, root: Path):
        _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                    run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})

    def test_apply_refuses_an_existing_output_directory(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            output = Path(d) / "out"
            output.mkdir()
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("already exists", proc.stderr)

    def test_apply_creates_output_with_restrictive_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)

    def test_apply_writes_a_manifest_naming_source_hashes_and_rows_added(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            manifests = list(output.glob("backfill-manifest-*.json"))
            self.assertEqual(len(manifests), 1)
            manifest = json.loads(manifests[0].read_text())
            self.assertEqual(manifest["source_path"], str(root.resolve()))
            self.assertEqual(manifest["output_path"], str(output.resolve()))
            self.assertEqual(manifest["rows_added"], 1)
            self.assertEqual(manifest["script_version"], backfill.BACKFILL_VERSION)
            import hashlib
            expected = hashlib.sha256((root / "events.jsonl").read_bytes()).hexdigest()
            self.assertEqual(manifest["source_sha256"]["events.jsonl"], expected)

    def test_a_symlink_anywhere_in_source_aborts_and_leaves_output_with_an_incomplete_marker(self):
        # Phase 1 review B2: --output is left in place (never rmtree'd) with an INCOMPLETE marker.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            target = Path(d) / "outside.txt"
            target.write_text("x")
            (root / "runs" / "r1" / "evil-link").symlink_to(target)
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("symlink", proc.stderr)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())
            # No self-referential copy started: the unsafe entry is caught by the lstat scan
            # BEFORE any file is ever copied (Phase 1 review B3), so the output dir is empty save
            # for the marker this script itself wrote.
            self.assertEqual([p.name for p in output.iterdir()], ["INCOMPLETE"])

    def test_a_fifo_in_source_aborts_and_leaves_output_with_an_incomplete_marker(self):
        import os as _os
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            _os.mkfifo(root / "runs" / "r1" / "weird.fifo")
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("special", proc.stderr)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())

    def test_a_hazardous_line_in_a_copied_stream_aborts_before_write_batch_and_leaves_output_with_a_marker(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[])
            huge = json.dumps({"x": "a" * (backfill.MAX_LINE_BYTES + 1024)})
            (root / "metrics.jsonl").write_text(huge + "\n", encoding="utf-8")
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("hazard", proc.stderr)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())
            # The copy itself DID happen (the hazard is only detected once write_batch's shared
            # readers would be exposed to it) - the copied metrics.jsonl is still there too.
            self.assertTrue((output / "metrics.jsonl").exists())

    def test_apply_copies_only_regular_files_and_directories(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue((output / "events.jsonl").is_file())
            self.assertTrue((output / "runs" / "r1").is_dir())
            self.assertTrue((output / "runs" / "r1" / "r1-lead-0.events.jsonl").is_file())

    def test_scan_source_tree_reports_every_unsafe_entry_kind(self):
        import os as _os
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            (root / "link1").symlink_to(root / "events.jsonl")
            _os.mkfifo(root / "fifo1")
            dirs, files, unsafe = backfill.scan_source_tree(root)
            kinds = sorted(kind for _rel, kind in unsafe)
            self.assertEqual(kinds, ["special", "symlink"])


class IdempotentChainedApplyTests(unittest.TestCase):
    def test_reapplying_against_a_previous_outputs_own_copy_adds_zero_rows(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                        run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})
            out1 = Path(d) / "out1"
            proc1 = _run("--source", str(root), "--output", str(out1), "--apply")
            self.assertEqual(proc1.returncode, 0, proc1.stderr)
            rows1 = _read_jsonl(out1 / "metrics.jsonl")
            self.assertEqual(len(rows1), 1)

            out2 = Path(d) / "out2"
            proc2 = _run("--source", str(out1), "--output", str(out2), "--apply")
            self.assertEqual(proc2.returncode, 0, proc2.stderr)
            self.assertIn("applied: 0 row(s)", proc2.stdout)
            rows2 = _read_jsonl(out2 / "metrics.jsonl")
            self.assertEqual(len(rows2), 1)  # carried over, not duplicated
            self.assertEqual(rows1, rows2)

            # out1 itself (this run's OWN --source) must stay untouched by this second apply.
            self.assertEqual(_read_jsonl(out1 / "metrics.jsonl"), rows1)

            # Two distinct manifests: the first apply's own, carried into out2 by the copy, plus
            # this second apply's own — never overwritten, never collided.
            manifests = list(out2.glob("backfill-manifest-*.json"))
            self.assertEqual(len(manifests), 2)


class ProductionRootGuardTests(unittest.TestCase):
    """S2/F-round-3: BOTH --source and --output are checked, by realpath, in BOTH directions
    (candidate inside protected root, or protected root inside candidate) against both the
    conventional root and the env-configured runtime default. There is no override flag."""

    def _state(self, root: Path):
        _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)])

    def test_refuses_when_output_is_the_conventional_production_root(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            fake_production = Path(d) / "prod"
            fake_production.mkdir()
            output = fake_production
            with patch.object(backfill, "CONVENTIONAL_PRODUCTION_ROOT", fake_production):
                rc = backfill.main(["--source", str(root), "--output", str(output), "--apply"])
            self.assertEqual(rc, 2)
            self.assertEqual(list(fake_production.iterdir()), [])

    def test_refuses_when_source_is_the_conventional_production_root(self):
        with tempfile.TemporaryDirectory() as d:
            fake_production = Path(d) / "prod"
            self._state(fake_production)
            output = Path(d) / "out"
            with patch.object(backfill, "CONVENTIONAL_PRODUCTION_ROOT", fake_production):
                rc = backfill.main(["--source", str(fake_production), "--output", str(output), "--apply"])
            self.assertEqual(rc, 2)
            self.assertFalse(output.exists())

    def test_refuses_when_output_is_an_ancestor_of_the_protected_root(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            fake_production = Path(d) / "prod" / "nested"
            fake_production.mkdir(parents=True)
            with patch.object(backfill, "CONVENTIONAL_PRODUCTION_ROOT", fake_production):
                rc = backfill.main(["--source", str(root), "--output", str(Path(d) / "prod"), "--apply"])
            self.assertEqual(rc, 2)

    def test_refuses_the_env_configured_runtime_default_root_for_output(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            env_root = Path(d) / "env-configured"
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), "--source", str(root), "--output", str(env_root), "--apply"],
                capture_output=True, text=True, timeout=30,
                env={**_env_without_orchestrator_home(), "CODING_AGENT_ORCHESTRATOR_HOME": str(env_root)})
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertIn("protected production root", proc.stderr)
            self.assertFalse(env_root.exists())

    def test_dry_run_against_a_protected_source_is_still_allowed(self):
        with tempfile.TemporaryDirectory() as d:
            fake_production = Path(d) / "prod"
            self._state(fake_production)
            with patch.object(backfill, "CONVENTIONAL_PRODUCTION_ROOT", fake_production):
                rc = backfill.main(["--source", str(fake_production)])
            self.assertEqual(rc, 0)

    def test_the_override_flag_no_longer_exists(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            self.assertNotIn("--i-understand-production", SCRIPT.read_text())
            proc = _run("--source", str(root), "--apply", "--i-understand-production")
            self.assertEqual(proc.returncode, 2)
            self.assertIn("unrecognized arguments", proc.stderr)

    def test_the_state_root_and_rollback_flags_no_longer_exist(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            proc = _run("--source", str(root), "--state-root", str(root))
            self.assertEqual(proc.returncode, 2)
            self.assertIn("unrecognized arguments", proc.stderr)
        proc = _run("--rollback", "/tmp/whatever")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr)


# --- --source/--output overlap guard (Phase 1 review B1) -------------------------------------------

class SourceOutputOverlapTests(unittest.TestCase):
    def _state(self, root: Path):
        _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)])

    def test_output_inside_source_is_rejected_before_anything_is_created(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            before = sorted(p.name for p in root.iterdir())
            output = root / "nested-out"
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertIn("--output", proc.stderr)
            self.assertFalse(output.exists())
            # --source is untouched: same entries, nothing new created inside it.
            self.assertEqual(sorted(p.name for p in root.iterdir()), before)

    def test_source_inside_output_is_rejected_before_anything_new_is_written(self):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d) / "out"
            output.mkdir()
            root = output / "state"
            self._state(root)
            before = sorted(p.name for p in output.iterdir())
            proc = _run("--source", str(root), "--output", str(output), "--apply")
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertIn("--output", proc.stderr)
            # Nothing new was written into --output beyond what was already there (the caller's
            # own "state" subdirectory): no INCOMPLETE marker, no manifest, no os.mkdir attempt.
            self.assertEqual(sorted(p.name for p in output.iterdir()), before)
            self.assertFalse((output / "INCOMPLETE").exists())

    def test_output_equal_to_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            before = sorted(p.name for p in root.iterdir())
            proc = _run("--source", str(root), "--output", str(root), "--apply")
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertEqual(sorted(p.name for p in root.iterdir()), before)

    def test_disjoint_source_and_output_are_not_flagged_as_overlapping(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            output = Path(d) / "unrelated-out"
            self.assertIsNone(backfill.refused_source_output_overlap(root, output))

    def test_refused_source_output_overlap_direct(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "a" / "b"
            source.mkdir(parents=True)
            # output does not exist yet, is nested INSIDE source
            output = source / "c" / "out"
            overlap = backfill.refused_source_output_overlap(source, output)
            self.assertIsNotNone(overlap)
            source_real, output_real = overlap
            self.assertEqual(source_real, backfill._realpath(source))


# --- copy-budget enforcement (Phase 1 review W2) ---------------------------------------------------

class CopyBudgetTests(unittest.TestCase):
    def _state(self, root: Path):
        _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                    run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})

    def test_scan_source_tree_enforces_max_files_before_completing_the_walk(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "src"
            source.mkdir()
            for i in range(5):
                (source / f"f{i}.txt").write_text("x")
            with self.assertRaises(backfill.CopyBudgetExceededError):
                backfill.scan_source_tree(source, max_files=2)

    def test_scan_source_tree_enforces_max_bytes_before_completing_the_walk(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "src"
            source.mkdir()
            (source / "big.txt").write_bytes(b"x" * 1000)
            with self.assertRaises(backfill.CopyBudgetExceededError):
                backfill.scan_source_tree(source, max_bytes=10)

    def test_scan_source_tree_without_a_budget_is_unaffected(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "src"
            source.mkdir()
            (source / "a.txt").write_text("x")
            dirs, files, unsafe = backfill.scan_source_tree(source)
            self.assertEqual(unsafe, [])
            self.assertEqual(len(files), 1)

    def test_copy_source_tree_enforces_max_bytes_during_the_copy_itself(self):
        # Even when the scan itself was run with NO byte budget, copy_source_tree's own running
        # tally still catches a copy that would exceed max_bytes (Phase 1 review W2: enforced
        # AGAIN during the copy, not only from the pre-copy scan's tally).
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "src"
            source.mkdir()
            (source / "a.txt").write_bytes(b"x" * 100)
            (source / "b.txt").write_bytes(b"y" * 100)
            output = Path(d) / "out"
            output.mkdir(mode=0o700)
            dirs, files, unsafe = backfill.scan_source_tree(source)
            self.assertEqual(unsafe, [])
            with self.assertRaises(backfill.CopyBudgetExceededError):
                backfill.copy_source_tree(source, output, dirs=dirs, files=files, max_bytes=150)

    def test_apply_aborts_when_max_copy_bytes_is_exceeded(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply",
                       "--max-copy-bytes", "5")
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("max-copy-bytes", proc.stderr)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())

    def test_apply_succeeds_with_a_generous_max_copy_bytes_budget(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply",
                       "--max-copy-bytes", str(backfill.DEFAULT_MAX_COPY_BYTES))
            self.assertEqual(proc.returncode, 0, proc.stderr)


# --- caps checked BEFORE insertion, never after (Phase 1 review W3) --------------------------------

class CapsCheckedBeforeInsertionTests(unittest.TestCase):
    def test_existing_nested_coverage_raises_before_the_over_cap_key_is_added(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "metrics.jsonl"
            rows = [{"event": "model_call", "run_id": f"r{i}", "parent_task_id": "t", "nested": True}
                   for i in range(3)]
            path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            with self.assertRaises(backfill.PlanTooLargeError):
                backfill.existing_nested_coverage(path, skip_counts={}, cap=2)

    def test_existing_nested_coverage_succeeds_exactly_at_the_cap(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "metrics.jsonl"
            rows = [{"event": "model_call", "run_id": f"r{i}", "parent_task_id": "t", "nested": True}
                   for i in range(2)]
            path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            covered = backfill.existing_nested_coverage(path, skip_counts={}, cap=2)
            self.assertEqual(len(covered), 2)

    def test_extend_rows_checked_raises_before_extending_rows_to_add(self):
        rows_to_add = [{"a": 1}]
        with self.assertRaises(backfill.PlanTooLargeError):
            backfill._extend_rows_checked(rows_to_add, [{"b": 2}, {"c": 3}], cap=2)
        # The cap was checked BEFORE the extend: a failed attempt must leave rows_to_add untouched.
        self.assertEqual(rows_to_add, [{"a": 1}])

    def test_extend_rows_checked_succeeds_exactly_at_the_cap(self):
        rows_to_add = [{"a": 1}]
        backfill._extend_rows_checked(rows_to_add, [{"b": 2}], cap=2)
        self.assertEqual(rows_to_add, [{"a": 1}, {"b": 2}])


# --- pre-scan must also parse a final unterminated line, matching RecordIndex._scan (W1) ----------

class FinalUnterminatedLineTests(unittest.TestCase):
    def test_final_unterminated_line_is_skipped_by_default(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            path.write_text(json.dumps({"a": 1}) + "\n" + json.dumps({"b": 2}), encoding="utf-8")
            results = list(backfill.iter_physical_jsonl(path))
            self.assertEqual(results, [(1, {"a": 1}, None)])

    def test_final_unterminated_line_is_parsed_when_requested(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            path.write_text(json.dumps({"a": 1}) + "\n" + json.dumps({"b": 2}), encoding="utf-8")
            results = list(backfill.iter_physical_jsonl(path, include_final_unterminated=True))
            self.assertEqual(results, [(1, {"a": 1}, None), (2, {"b": 2}, None)])

    def test_deeply_nested_final_unterminated_line_is_a_hazard_only_when_requested(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "log.jsonl"
            deep = "[" * 100_000 + "]" * 100_000
            path.write_text(json.dumps({"a": 1}) + "\n" + deep, encoding="utf-8")  # no trailing \n
            default_results = list(backfill.iter_physical_jsonl(path))
            self.assertEqual(default_results, [(1, {"a": 1}, None)])
            full_results = list(backfill.iter_physical_jsonl(path, include_final_unterminated=True))
            self.assertEqual(full_results[1], (2, None, "deep_nesting"))

    def test_prescan_output_streams_catches_a_deep_nested_unterminated_tail(self):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d)
            deep = "[" * 100_000 + "]" * 100_000
            (output / "metrics.jsonl").write_text(json.dumps({"ok": 1}) + "\n" + deep, encoding="utf-8")
            (output / "events.jsonl").write_text("", encoding="utf-8")
            (output / "outcomes.jsonl").write_text("", encoding="utf-8")
            hazards = backfill.prescan_output_streams(output)
            self.assertIn("metrics.jsonl", hazards)
            self.assertEqual(hazards["metrics.jsonl"].get("deep_nesting"), 1)

    def test_cli_apply_aborts_on_a_deep_nested_unterminated_tail_in_a_copied_stream(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[])
            deep = "[" * 100_000 + "]" * 100_000
            (root / "metrics.jsonl").write_text(json.dumps({"ok": 1}) + "\n" + deep, encoding="utf-8")
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply", timeout=15)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("hazard", proc.stderr)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())


# --- lstat scan runs BEFORE hashing/copying; safe opens for hashing/copying (Phase 1 review B3) ---

class ScanBeforeHashingOrderingTests(unittest.TestCase):
    def test_hash_source_streams_is_never_called_when_the_source_tree_is_unsafe(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)])
            (root / "outcomes.jsonl").unlink()
            (root / "outcomes.jsonl").symlink_to(root / "events.jsonl")  # symlink INSIDE the tree
            output = Path(d) / "out"
            with patch.object(backfill, "hash_source_streams") as mock_hash:
                rc = backfill.main(["--source", str(root), "--output", str(output), "--apply"])
            self.assertNotEqual(rc, 0)
            mock_hash.assert_not_called()
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())


class SafeOpenForHashingAndCopyingTests(unittest.TestCase):
    def test_open_regular_nofollow_rejects_a_fifo_without_hanging(self):
        import os as _os
        import threading
        with tempfile.TemporaryDirectory() as d:
            fifo_path = Path(d) / "weird.fifo"
            _os.mkfifo(fifo_path)
            result: dict = {}

            def attempt():
                try:
                    backfill._open_regular_nofollow(fifo_path)
                except Exception as exc:  # noqa: BLE001
                    result["exc"] = exc

            thread = threading.Thread(target=attempt, daemon=True)
            thread.start()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive(), "opening a FIFO for hashing/copying must never hang")
            self.assertIsInstance(result.get("exc"), backfill.NotARegularFileError)

    def test_open_regular_nofollow_rejects_a_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "target.txt"
            target.write_text("x")
            link = Path(d) / "link.txt"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                backfill._open_regular_nofollow(link)

    def test_open_regular_nofollow_accepts_a_plain_regular_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "f.txt"
            path.write_text("hello")
            with backfill._open_regular_nofollow(path) as f:
                self.assertEqual(f.read(), b"hello")


class SourceStreamFifoAndSymlinkRejectionTests(unittest.TestCase):
    def _state(self, root: Path):
        _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)])

    def test_fifo_outcomes_jsonl_is_rejected_quickly_not_hung(self):
        import os as _os
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            (root / "outcomes.jsonl").unlink()
            _os.mkfifo(root / "outcomes.jsonl")
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply", timeout=5)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("special", proc.stderr)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())

    def test_symlinked_stream_inside_source_is_rejected_before_hashing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            self._state(root)
            (root / "outcomes.jsonl").unlink()
            (root / "outcomes.jsonl").symlink_to(root / "events.jsonl")
            output = Path(d) / "out"
            proc = _run("--source", str(root), "--output", str(output), "--apply", timeout=10)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("symlink", proc.stderr)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())


# --- post-copy source-hash re-verification (Phase 1 review W4) -------------------------------------

class SourceChangedDuringCopyTests(unittest.TestCase):
    def test_verify_copied_stream_hashes_raises_on_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d) / "out"
            output.mkdir()
            (output / "metrics.jsonl").write_text("changed\n", encoding="utf-8")
            source_hashes = {"metrics.jsonl": "deadbeef" * 8, "events.jsonl": None, "outcomes.jsonl": None}
            with self.assertRaises(backfill.SourceChangedDuringCopyError):
                backfill.verify_copied_stream_hashes(output, source_hashes)

    def test_verify_copied_stream_hashes_passes_when_matching(self):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d) / "out"
            output.mkdir()
            (output / "metrics.jsonl").write_text("same\n", encoding="utf-8")
            import hashlib
            expected = hashlib.sha256((output / "metrics.jsonl").read_bytes()).hexdigest()
            backfill.verify_copied_stream_hashes(
                output, {"metrics.jsonl": expected, "events.jsonl": None, "outcomes.jsonl": None})

    def test_cli_apply_aborts_when_the_copied_output_does_not_match_the_pre_copy_source_hash(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "state"
            _write_state(root, events=[_dispatch_finished(nested_cost_usd=0.03)],
                        run_logs={("r1", "r1-lead-0"): [_subagent_end("c1", [_result(cost=0.03)])]})
            output = Path(d) / "out"

            original_copy = backfill.copy_source_tree

            def tampering_copy(source, output_dir, *, dirs, files, max_bytes=None):
                original_copy(source, output_dir, dirs=dirs, files=files, max_bytes=max_bytes)
                # Simulate --source changing mid-copy: the copied metrics.jsonl no longer matches
                # the hash taken of --source BEFORE the copy started.
                (output_dir / "metrics.jsonl").write_text("tampered\n", encoding="utf-8")

            with patch.object(backfill, "copy_source_tree", side_effect=tampering_copy):
                rc = backfill.main(["--source", str(root), "--output", str(output), "--apply"])
            self.assertNotEqual(rc, 0)
            self.assertTrue(output.exists())
            self.assertTrue((output / "INCOMPLETE").exists())


if __name__ == "__main__":
    unittest.main()

"""Golden output pin for the dashboard renderer (B3, `docs/architecture-review.md`).

`orchestrator/dashboard.py` is about to be split into `orchestrator/presentation/{dashboard_data,
dashboard_html,publish}.py`. That refactor must not change a single byte of the rendered
`dashboard.html` or of the JSON `build_data` returns for the same inputs. This test builds a
representative state root (model_call CALL and SESSION rows, a session-ingest aggregate,
`route_executed`, `adaptive_route_decision`, a `task_verified` attestation, run-scoped and
per-task `outcomes.jsonl` rows including the terminal `run-complete`/`run-failed` task ids,
`run_completed`/`run_failed`/`decision_invalidated`/`merge_conflict` events, and
`ingest_status.json`) and compares the rendered output against a golden snapshot captured from the
code at HEAD (before the split).

Two clocks are wall-clock-dependent in the current implementation: `dashboard.build_data`'s
`generated_at`/`ingest_status` staleness check, and `outcomes.outcome_summary`'s outcome-age
calculation. Both are frozen here by patching the `datetime` name in whichever module currently
defines `build_data`/`outcome_summary` — resolved dynamically via `__module__`, not hardcoded to
`orchestrator.dashboard`/`orchestrator.outcomes`, so the patch target keeps working if `build_data`
moves to `orchestrator.presentation.dashboard_data` (outcomes.py itself is not moved by this step).

To regenerate the golden files after an intentional behaviour change, run:
    DASHBOARD_GOLDEN_UPDATE=1 python3 -m pytest tests/test_dashboard_golden.py -q
and inspect the diff under `tests/fixtures/dashboard_golden/` before committing it.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from orchestrator import records
from orchestrator.dashboard import build_data, generate_dashboard
from orchestrator.outcomes import outcome_summary

REPO_ROOT = Path(__file__).resolve().parents[1]
GOLDEN_DIR = REPO_ROOT / 'tests' / 'fixtures' / 'dashboard_golden'
GOLDEN_HTML = GOLDEN_DIR / 'dashboard.html'
GOLDEN_DATA = GOLDEN_DIR / 'data.json'

#: Fixed instant every `datetime.now(timezone.utc)` call reachable from `generate_dashboard`
#: (given these fixtures) must observe, so `generated_at`, ingest-status staleness, and outcome
#: age/maturity are reproducible no matter when the test runs.
FROZEN_NOW = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)


class _FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FROZEN_NOW.astimezone(tz) if tz is not None else FROZEN_NOW.replace(tzinfo=None)


def _frozen_clock():
    """Patch the `datetime` name in whichever modules currently define `build_data` and
    `outcome_summary`, resolved via `__module__` so the patch target survives `build_data` moving
    to `orchestrator.presentation.dashboard_data`."""
    build_data_module = sys.modules[build_data.__module__]
    outcomes_module = sys.modules[outcome_summary.__module__]
    patches = [patch.object(build_data_module, 'datetime', _FrozenDateTime)]
    if outcomes_module is not build_data_module:
        patches.append(patch.object(outcomes_module, 'datetime', _FrozenDateTime))
    return patches


def _write_stream(root: Path, name: str, rows) -> None:
    (root / f'{name}.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')


def build_fixture_root(root: Path) -> None:
    """A representative state root covering every reducer `build_data` runs."""
    metrics = [
        # Ordinary per-call rows, one pass one fail, joined into policy `p1`.
        {'event': 'model_call', 'granularity': 'call', 'agent_runtime': 'humain-terminal',
         'run_id': 'r1', 'task_id': 't1', 'role': 'lead', 'capability_class': 'lead',
         'lead_size': 'small', 'policy_id': 'p1', 'result': 'pass', 'cost_usd': 1.2,
         'cost_source': 'reported', 'model': 'gpt-6-astra', 'input_tokens': 4000, 'output_tokens': 300,
         'ts': '2026-09-24T10:00:00+00:00'},
        {'event': 'model_call', 'granularity': 'call', 'agent_runtime': 'humain-terminal',
         'run_id': 'r1', 'task_id': 't2', 'role': 'implementation_fast', 'policy_id': 'p1',
         'result': 'fail', 'retry': 1, 'cost_usd': 0.8, 'cost_source': 'estimated-from-reported-tokens',
         'cost_rate_model': 'gpt-6-astra', 'model': 'gpt-6-astra', 'input_tokens': 9000,
         'output_tokens': 700, 'quality_evidence_score': 0.6, 'cost_aggressiveness': 0.5,
         'ts': '2026-09-24T10:05:00+00:00'},
        # An attested verification of t1 via a metrics-side `task_verified` row.
        {'event': 'task_verified', 'run_id': 'r1', 'task_id': 't1', 'result': 'verified',
         'ts': '2026-09-24T10:06:00+00:00'},
        # A whole-session aggregate, distinct from per-call rows.
        {'event': 'model_call', 'granularity': 'session', 'covers_calls': 29, 'cost_usd': 3.94303,
         'cost_source': 'estimated-from-reported-tokens', 'cost_rate_model': 'claude-opus-5',
         'agent_runtime': 'humain-terminal', 'input_tokens': 5704180, 'output_tokens': 33834,
         'model': 'claude-opus-5', 'role': 'lead', 'run_id': 'r1', 'ts': '2026-09-24T09:44:06+00:00'},
        # A large lead in a second run, self-implemented.
        {'event': 'model_call', 'granularity': 'call', 'agent_runtime': 'claude-code',
         'run_id': 'r2', 'task_id': 'r2-lead-0', 'role': 'lead_large', 'capability_class': 'lead',
         'lead_size': 'large', 'lead_self_implemented': True, 'policy_id': 'p2', 'cost_usd': 6.0,
         'cost_source': 'reported', 'model': 'sonnet', 'input_tokens': 20000, 'output_tokens': 1500,
         'ts': '2026-09-25T08:00:00+00:00'},
        # Bridge-executed spend (mirrors the model_call cost of the same runtime).
        {'event': 'route_executed', 'agent_runtime': 'humain-terminal', 'executed_cost_usd': 1.2,
         'capability_class': 'lead', 'executed_passes': True, 'task_id': 't1', 'run_id': 'r1',
         'ts': '2026-09-24T10:00:01+00:00'},
        # An adaptive routing decision.
        {'event': 'adaptive_route_decision', 'adaptive_mode': 'recommend', 'route_action': 'recommended_only',
         'agent_runtime': 'humain-terminal', 'capability_class': 'architect', 'explored': False,
         'history_sufficient': True, 'policy_id': 'p1', 'cost_aggressiveness': 0.7,
         'ts': '2026-09-24T10:00:02+00:00'},
        # Interactive-session ingestion: excluded from orchestrated cohorts, its own panel.
        {'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
         'granularity': 'session', 'covers_calls': 140, 'cost_usd': 12.5, 'agent_runtime': 'codex',
         'cost_source': 'estimated-from-reported-tokens', 'cost_rate_model': 'gpt-6-astra',
         'input_tokens': 1_000_000, 'output_tokens': 20_000, 'session_id': 'sess-a',
         'ts': '2026-09-24T11:00:00+00:00'},
    ]
    events = [
        {'event': 'run_completed', 'run_id': 'r1', 'elapsed_ms': 62000, 'elapsed_source': 'reported',
         'ts': '2026-09-24T10:10:00+00:00'},
        {'event': 'run_failed', 'run_id': 'r2', 'elapsed_ms': 45000, 'elapsed_source': 'reported',
         'ts': '2026-09-25T08:05:00+00:00'},
        {'event': 'decision_invalidated', 'run_id': 'r1', 'ts': '2026-09-24T10:07:00+00:00'},
        {'event': 'merge_conflict', 'run_id': 'r1', 'ts': '2026-09-24T10:08:00+00:00'},
        {'event': 'context_packet_miss', 'run_id': 'r2', 'ts': '2026-09-25T08:01:00+00:00'},
    ]
    outcomes = [
        # Run-scoped QA gate rows (task ids end in `-qa`).
        {'run_id': 'r1', 'task_id': 'r1-qa', 'verification': True, 'outcome': 'verified',
         'ts': '2026-09-24T10:11:00+00:00'},
        {'run_id': 'r2', 'task_id': 'r2-qa', 'verification': False, 'outcome': 'fail',
         'ts': '2026-09-25T08:06:00+00:00'},
        # Terminal run-level outcomes (`run_evidence.TERMINAL_OUTCOME_TASKS`).
        {'run_id': 'r1', 'task_id': 'run-complete', 'outcome': 'completed', 'ts': '2026-09-24T10:12:00+00:00'},
        {'run_id': 'r2', 'task_id': 'run-failed', 'outcome': 'failed', 'ts': '2026-09-25T08:07:00+00:00'},
        # A delayed, matured (30d+ under the frozen clock) bad outcome on t2.
        {'task_id': 't2', 'outcome': 'blocked', 'reopened': True,
         'completed_at': '2026-08-01T00:00:00+00:00', 'ts': '2026-08-01T00:00:00+00:00'},
    ]
    ingest_status = {
        'status': 'ok', 'last_attempt_at': '2026-10-01T11:50:00+00:00',
        'last_success_at': '2026-10-01T11:50:00+00:00', 'emitted': 140, 'failure_count': 0,
        'error': None, 'sweep_interval_seconds': 900,
    }
    _write_stream(root, 'metrics', metrics)
    _write_stream(root, 'events', events)
    _write_stream(root, 'outcomes', outcomes)
    (root / 'ingest_status.json').write_text(json.dumps(ingest_status), encoding='utf-8')


def _dump_data(data: dict) -> str:
    return json.dumps(records.to_json(data), indent=2, sort_keys=True, default=records.json_default)


class DashboardGoldenTests(unittest.TestCase):
    def test_generate_dashboard_matches_the_golden_html_and_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_fixture_root(root)
            patches = _frozen_clock()
            for p in patches:
                p.start()
            try:
                data = build_data(root, config={})
                html_path = generate_dashboard(root, config={})
                html = html_path.read_text(encoding='utf-8')
            finally:
                for p in patches:
                    p.stop()
            actual_data_json = _dump_data(data)

        if os.environ.get('DASHBOARD_GOLDEN_UPDATE'):
            GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
            GOLDEN_HTML.write_text(html, encoding='utf-8')
            GOLDEN_DATA.write_text(actual_data_json, encoding='utf-8')
            self.skipTest('DASHBOARD_GOLDEN_UPDATE=1: golden files (re)written, not compared')

        self.assertTrue(GOLDEN_HTML.exists(), f'missing golden file {GOLDEN_HTML}; run with '
                                               f'DASHBOARD_GOLDEN_UPDATE=1 to create it')
        self.assertTrue(GOLDEN_DATA.exists(), f'missing golden file {GOLDEN_DATA}; run with '
                                              f'DASHBOARD_GOLDEN_UPDATE=1 to create it')
        expected_html = GOLDEN_HTML.read_text(encoding='utf-8')
        expected_data_json = GOLDEN_DATA.read_text(encoding='utf-8')
        self.assertEqual(html, expected_html,
                         'rendered dashboard.html differs from tests/fixtures/dashboard_golden/dashboard.html')
        self.assertEqual(actual_data_json, expected_data_json,
                         'build_data() output differs from tests/fixtures/dashboard_golden/data.json')


if __name__ == '__main__':
    unittest.main()

"""Bounded-memory streaming and atomic publication of the orchestrator dashboard.

Every test runs on a throwaway state root filled with a deterministic synthetic history
(`write_synthetic_history`, also used by `scripts/benchmark_refresh.py`). The aggregate-equality
test compares `dashboard.build_data` with `reference_build_data`, an independent whole-file
re-derivation of the same accounting: it loads each stream into memory once, deduplicates by
`record_id`, and then computes every field with plain list comprehensions and `x / y if y else None`
arithmetic instead of the streaming pass's running counters, deques, generator-fed reducers and
`records.NO_DATA` helpers. The two must agree on every full-history aggregate and UI field
(including `ingest_status` and `instrumentation`); only the recent-row retention is bounded.
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import random
import re
import signal
import statistics
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from orchestrator import dashboard, outcomes as outcomes_module, records, runtime
from orchestrator.economics import (ESTIMATED, REPORTED, UNMETERED, cost_attribution, cost_class, fanout_rework,
                                    is_call_row, is_session_ingest, nested_reconciliation, orchestration_overhead,
                                    row_cost, unique_records, waste_cost)
from orchestrator.features import feature_inventory
from orchestrator.history import build_route_stats
from orchestrator.outcomes import outcome_summary
from orchestrator.run_evidence import evidence_coverage, summarize_runs
from orchestrator.runtime import load_jsonl, read_json
from orchestrator.verification import flaky_stats

REPO = Path(__file__).resolve().parents[1]
STREAMS = ('events.jsonl', 'metrics.jsonl', 'outcomes.jsonl')


# --------------------------------------------------------------------------------------------
# Deterministic synthetic history (no live state is ever read)
# --------------------------------------------------------------------------------------------

ROLES = (('worker', 'implementation_fast'), ('worker', 'implementation_strong'), ('technical_lead', 'architect'),
         ('technical_review', 'technical_review'), ('qa', 'qa'))
MODELS = ('anthropic/claude-sonnet-4-5', 'openai/gpt-5', 'anthropic/claude-haiku-4-5')
RUNTIMES = ('humain-terminal', 'claude-code', 'codex')
TASK_CLASSES = ('crud', 'refactor', 'bugfix', 'infra')
RISKS = ('low', 'medium', 'high')
ACTIONS = ('recommended_only', 'empirical_enforced', 'static_default', 'fallback_insufficient_history')


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec='seconds')


def synthetic_history(runs: int, seed: int = 7, *, run_prefix: str = 'R') -> dict[str, list[dict]]:
    """Return {'events.jsonl': [...], 'metrics.jsonl': [...], 'outcomes.jsonl': [...]} for `runs` runs.

    Roughly 12 events, 12 metrics (incl. 2 interactive-session rows) and 5 outcomes per run, spread
    over ~90 days so daily trends, maturity windows, route cohorts and run evidence are all populated.
    """
    rnd = random.Random(seed)
    base = datetime(2025, 5, 1, 9, 0, tzinfo=timezone.utc)
    events: list[dict] = []; metrics: list[dict] = []; outcomes: list[dict] = []
    for i in range(runs):
        rid = f'{run_prefix}{i:06d}'
        start = base + timedelta(minutes=rnd.randint(0, 90 * 24 * 60))
        t = start
        def tick(seconds: int = 30) -> str:
            nonlocal t
            t = t + timedelta(seconds=rnd.randint(1, seconds)); return _iso(t)
        task_class = rnd.choice(TASK_CLASSES); risk = rnd.choice(RISKS); complexity = rnd.randint(1, 10)
        agent_runtime = rnd.choice(RUNTIMES); policy_id = f'pol-{rnd.randint(0, 2)}'
        common = {'agent_runtime': agent_runtime, 'repository': '/work/forge'}
        events.append({'ts': _iso(start), 'record_id': f'{rid}-ev-start', 'event': 'run_started', 'run_id': rid,
                       'started_at': _iso(start), 'task_class': task_class, **common})
        metrics.append({'ts': tick(), 'record_id': f'{rid}-m-route', 'event': 'adaptive_route_decision', 'run_id': rid,
                        'task_class': task_class, 'complexity': complexity, 'risk': risk, 'policy_id': policy_id,
                        'cost_aggressiveness': rnd.choice((.5, .7, .9)), 'adaptive_mode': 'recommend',
                        'route_action': rnd.choice(ACTIONS), 'selected_capability': 'implementation_fast',
                        'selected_effort': 'standard', 'selected_verification_depth': 'targeted',
                        'historical_samples': rnd.randint(0, 40), 'verified_task_samples': rnd.choice((None, 3, 9)),
                        'explored': rnd.random() < .1, 'history_sufficient': rnd.random() < .6, 'canary': False,
                        'topology_shape': rnd.choice(('flat', 'hierarchical')), 'topology_depth': 2, 'topology_workers': 3, 'topology_leads': 1, **common})
        tasks = rnd.randint(2, 5)
        for k in range(tasks):
            tid = f'{rid}-T{k}'
            events.append({'ts': tick(), 'record_id': f'{tid}-created', 'event': 'task_created', 'run_id': rid, 'task_id': tid, **common})
            retry_of = tid if rnd.random() < .15 else None
            events.append({'ts': tick(), 'record_id': f'{tid}-dispatch', 'event': 'dispatch_started', 'run_id': rid, 'task_id': tid,
                           **({'retry_of': retry_of} if retry_of else {}), **common})
            for c in range(rnd.randint(1, 3)):
                role, cap = rnd.choice(ROLES); provenance = rnd.random()
                row = {'ts': tick(), 'record_id': f'{tid}-call-{c}', 'event': 'model_call', 'run_id': rid, 'task_id': tid,
                       'role': role, 'capability_class': cap, 'model': rnd.choice(MODELS), 'task_class': task_class,
                       'complexity': complexity, 'risk': risk, 'effort': 'standard', 'verification_depth': 'targeted',
                       'topology_shape': 'hierarchical', 'policy_id': policy_id, 'cost_aggressiveness': .7,
                       'duration_ms': rnd.randint(500, 90000), 'retry': 1 if retry_of and c == 0 else 0, **common}
                if provenance < .55:
                    row.update({'cost_usd': round(rnd.uniform(.001, 1.5), 6), 'cost_source': 'reported',
                                'input_tokens': rnd.randint(100, 50000), 'output_tokens': rnd.randint(10, 8000), 'cached_input_tokens': rnd.randint(0, 20000)})
                elif provenance < .85:
                    row.update({'cost_usd': round(rnd.uniform(.001, .8), 6), 'cost_source': 'estimated-from-reported-tokens',
                                'input_tokens': rnd.randint(100, 30000), 'output_tokens': rnd.randint(10, 4000)})
                else:
                    row.update({'cost_source': 'unmetered', 'input_tokens': 0, 'output_tokens': 0})
                if rnd.random() < .3: row['quality_evidence_score'] = round(rnd.uniform(.5, 1), 3)
                if rnd.random() < .2: row['review_wait_ms'] = rnd.randint(1000, 600000)
                if rnd.random() < .05: row['waste_reason'] = 'rework'
                metrics.append(row)
            verified = rnd.random() < .7
            metrics.append({'ts': tick(), 'record_id': f'{tid}-verify', 'event': 'task_verified' if verified else 'verification_result',
                            'run_id': rid, 'task_id': tid, 'role': 'qa', 'capability_class': 'qa', 'task_class': task_class,
                            'complexity': complexity, 'risk': risk, 'result': 'verified' if verified else rnd.choice(('pass', 'fail')),
                            'check_id': f'check-{rnd.randint(0, 5)}', 'quality_evidence_score': round(rnd.uniform(.6, 1), 3), **common})
            events.append({'ts': tick(), 'record_id': f'{tid}-done', 'event': 'task_completed' if verified else 'task_failed',
                           'run_id': rid, 'task_id': tid, **common})
            outcomes.append({'ts': tick(), 'record_id': f'{tid}-outcome', 'run_id': rid, 'task_id': tid,
                             'outcome': 'verified' if verified else 'failed', 'verification': verified,
                             'completed_at': _iso(t), 'reopened': rnd.random() < .08, 'regression': rnd.random() < .04, **common})
        if rnd.random() < .1:
            events.append({'ts': tick(), 'record_id': f'{rid}-invalidated', 'event': 'decision_invalidated', 'decision_id': f'{rid}-D',
                           'affected_tasks': rnd.randint(1, 3), **({'run_id': rid} if rnd.random() < .5 else {}), **common})
        if rnd.random() < .08:
            events.append({'ts': tick(), 'record_id': f'{rid}-conflict', 'event': 'merge_conflict', 'run_id': rid, **common})
        if rnd.random() < .15:
            metrics.append({'ts': tick(), 'record_id': f'{rid}-shadow', 'event': 'shadow_review', 'run_id': rid, 'normal_pass': rnd.random() < .8,
                            'shadow_pass': rnd.random() < .8, 'role': 'technical_review', 'capability_class': 'technical_review', **common})
        metrics.append({'ts': tick(), 'record_id': f'{rid}-ctx', 'event': rnd.choice(('context_packet', 'context_packet', 'context_packet_miss')), 'run_id': rid, **common})
        for s in range(2):
            metrics.append({'ts': tick(), 'record_id': f'{rid}-sess-{s}', 'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
                            'session_id': f'sess-{i // 3}', 'agent_runtime': rnd.choice(RUNTIMES), 'model': rnd.choice(MODELS),
                            'cost_usd': round(rnd.uniform(.01, 2), 6), 'cost_source': 'estimated', 'input_tokens': rnd.randint(1000, 90000),
                            'output_tokens': rnd.randint(50, 9000), 'repository': '/work/other'})
        finished = tick(600); failed = rnd.random() < .12
        events.append({'ts': finished, 'record_id': f'{rid}-ev-end', 'event': 'run_failed' if failed else 'run_completed', 'run_id': rid,
                       'started_at': _iso(start), 'finished_at': finished, 'elapsed_ms': int((t - start).total_seconds() * 1000),
                       'elapsed_source': 'monotonic', **common})
        outcomes.append({'ts': finished, 'record_id': f'{rid}-run-outcome', 'run_id': rid, 'task_id': 'run-failed' if failed else 'run-complete',
                         'note': json.dumps({'retries': rnd.randint(0, 2), 'verification_passed': not failed}), **common})
    for rows in (events, metrics, outcomes):
        rows.sort(key=lambda r: r['ts'])
    return {'events.jsonl': events, 'metrics.jsonl': metrics, 'outcomes.jsonl': outcomes}


def edge_case_rows() -> dict[str, list[dict]]:
    """Representative shapes the synthetic generator never emits, appended after the sorted history.

    Each one exercises a branch the streaming pass and the whole-file oracle must agree on: costs
    carried only by `ci_cost_usd`/`human_cost_usd`, `null` cost and usage (unmetered, not free),
    the legacy `runtime` key instead of `agent_runtime` (orchestrated and ingested rows), a verified
    row without a task id, a row without any timestamp, events with no `run_id`, a duplicate
    `record_id` that must bill once, a session aggregate on each side of the ingest split
    (`covers_calls` / `legacy_source`), the engine's failed verdict (`task_verified` + `result: fail`)
    contradicting a dispatch pass for the same task, `route_executed` spend that no cost field sees,
    and cost-rate provenance fields on an estimated row.
    """
    run = {'run_id': 'R-edge', 'repository': '/work/forge'}
    ts = lambda s: f'2025-08-15T10:{s:02d}:00+00:00'  # noqa: E731 - later than every generated row
    metrics = [
        {'ts': ts(0), 'record_id': 'edge-ci', 'event': 'ci_run', 'task_id': 'R-edge-T0', 'ci_cost_usd': .42, 'cost_source': 'reported',
         'role': 'ci', 'agent_runtime': 'humain-terminal', **run},
        {'ts': ts(1), 'record_id': 'edge-human', 'event': 'human_review', 'task_id': 'R-edge-T0', 'human_cost_usd': 3.0,
         'role': 'human', 'agent_runtime': 'humain-terminal', **run},
        {'ts': ts(2), 'record_id': 'edge-null-cost', 'event': 'model_call', 'task_id': 'R-edge-T1', 'role': 'worker',
         'capability_class': 'implementation_fast', 'model': 'openai/gpt-5', 'cost_usd': None, 'input_tokens': None, 'output_tokens': None,
         'cost_source': 'estimated-from-reported-tokens', 'policy_id': 'pol-0', 'agent_runtime': 'codex', **run},
        {'ts': ts(3), 'record_id': 'edge-legacy-runtime', 'event': 'model_call', 'task_id': 'R-edge-T1', 'role': 'worker',
         'model': 'anthropic/claude-haiku-4-5', 'cost_usd': .25, 'cost_source': 'reported', 'input_tokens': 100, 'output_tokens': 10,
         'runtime': 'claude-code', 'review_wait_ms': 2500, **run},
        # Same record_id as the row above with a different cost: a replayed append must bill once.
        {'ts': ts(3), 'record_id': 'edge-legacy-runtime', 'event': 'model_call', 'task_id': 'R-edge-T1', 'role': 'worker',
         'model': 'anthropic/claude-haiku-4-5', 'cost_usd': 999.0, 'cost_source': 'reported', 'input_tokens': 100, 'output_tokens': 10,
         'runtime': 'claude-code', **run},
        {'ts': ts(4), 'record_id': 'edge-legacy-session', 'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
         'session_id': 42, 'runtime': 'claude-code', 'model': 'openai/gpt-5', 'cost_usd': None, 'input_tokens': None, 'output_tokens': 500,
         'repository': '/work/other'},
        {'ts': ts(4), 'record_id': 'edge-session-aggregate', 'event': 'model_call', 'source': 'session_ingest', 'role': 'interactive_session',
         'session_id': 'agg-1', 'granularity': 'session', 'covers_calls': 40, 'agent_runtime': 'codex', 'model': 'openai/gpt-5',
         'cost_usd': 6.5, 'cost_source': 'estimated', 'input_tokens': 900000, 'output_tokens': 40000, 'repository': '/work/other'},
        {'ts': ts(5), 'record_id': 'edge-verified-no-task', 'event': 'task_verified', 'role': 'qa', 'result': 'verified',
         'quality_evidence_score': .9, 'agent_runtime': 'humain-terminal', **run},
        # Dispatch exit 0 for R-edge-T2, then the engine's gate verdict for the same task: `task_verified`
        # carrying `result: 'fail'`. The task is attested-failed, not verified and not a dispatch pass.
        {'ts': ts(5), 'record_id': 'edge-dispatch-pass', 'event': 'model_call', 'task_id': 'R-edge-T2', 'role': 'worker',
         'model': 'openai/gpt-5', 'cost_usd': .11, 'cost_source': 'reported', 'input_tokens': 10, 'output_tokens': 5, 'result': 'pass',
         'policy_id': 'pol-edge', 'agent_runtime': 'codex', **run},
        {'ts': ts(6), 'record_id': 'edge-engine-failed-verdict', 'event': 'task_verified', 'task_id': 'R-edge-T2', 'result': 'fail',
         'quality_evidence_score': .2, 'agent_runtime': 'codex', **run},
        # A dispatch pass with no attestation at all: counted under `dispatch_pass`, never `verified`.
        {'ts': ts(6), 'record_id': 'edge-dispatch-only', 'event': 'model_call', 'task_id': 'R-edge-T3', 'role': 'worker',
         'model': 'openai/gpt-5', 'cost_usd': .07, 'cost_source': 'reported', 'input_tokens': 10, 'output_tokens': 5, 'result': 'pass',
         'policy_id': 'pol-edge', 'agent_runtime': 'codex', **run},
        # Orchestrated session aggregate (legacy import): counted as spend, excluded from per-call stats.
        {'ts': ts(7), 'record_id': 'edge-legacy-aggregate', 'event': 'model_call', 'legacy_source': 'metrics-v1', 'covers_calls': 12,
         'role': 'worker', 'model': 'openai/gpt-5', 'cost_usd': 4.0, 'cost_source': 'estimated', 'input_tokens': 300000,
         'output_tokens': 20000, 'agent_runtime': 'codex', **run},
        # Bridge-executed spend: real dollars that every `cost_usd` field reads as $0.
        {'ts': ts(7), 'record_id': 'edge-route-executed', 'event': 'route_executed', 'task_id': 'R-edge-T1', 'executed_cost_usd': .3,
         'executed_passes': True, 'agent_runtime': 'codex', **run},
        {'ts': ts(7), 'record_id': 'edge-route-executed-legacy', 'event': 'route_executed', 'task_id': 'R-edge-T2', 'executed_cost_usd': .2,
         'runtime': 'claude-code', **run},
        # An estimated row whose rate provenance is declared and verified.
        {'ts': ts(8), 'record_id': 'edge-rate-verified', 'event': 'model_call', 'task_id': 'R-edge-T1', 'role': 'worker',
         'model': 'openai/gpt-5', 'cost_rate_model': 'gpt-5', 'cost_rate_source': 'openai pricing page', 'cost_rate_verified_on': '2025-08-01',
         'cost_usd': .05, 'cost_source': 'estimated-from-reported-tokens', 'input_tokens': 1000, 'output_tokens': 100,
         'agent_runtime': 'codex', **run},
        {'record_id': 'edge-bare', 'event': 'model_call', 'cost_usd': .01, **run},
    ]
    events = [
        {'ts': ts(0), 'record_id': 'edge-ev-start', 'event': 'run_started', 'started_at': ts(0), 'runtime': 'claude-code', **run},
        {'ts': ts(1), 'record_id': 'edge-ev-no-run', 'event': 'orchestrator_initialized', 'schema_version': 3},
        {'ts': ts(2), 'record_id': 'edge-ev-conflict-no-run', 'event': 'merge_conflict_resolution'},
        {'ts': ts(2), 'record_id': 'edge-ev-invalidated-no-run', 'event': 'decision_invalidated', 'decision_id': 'D-edge', 'affected_tasks': 2},
        {'ts': ts(6), 'record_id': 'edge-ev-end', 'event': 'run_completed', 'started_at': ts(0), 'finished_at': ts(6),
         'elapsed_ms': 360000, 'elapsed_source': 'monotonic', **run},
    ]
    outcomes = [{'ts': ts(6), 'record_id': 'edge-outcome', 'task_id': 'run-complete', 'note': 'not json', 'completed_at': None, **run}]
    return {'events.jsonl': events, 'metrics.jsonl': metrics, 'outcomes.jsonl': outcomes}


#: A fresh, well-formed `ingest_status.json` as `cli.process_ingest` writes it. `last_*` are filled in
#: at write time so the sweep is never stale relative to the test's clock; `build_ingest_status`'s
#: staleness and validation rules have their own unit tests in `tests/test_dashboard_metrics.py`.
INGEST_STATUS_FIXTURE = {'status': 'ok', 'emitted': 7, 'failure_count': 1, 'error': None, 'sweep_interval_seconds': 600}


def write_ingest_status(root: Path) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    status = {**INGEST_STATUS_FIXTURE, 'last_attempt_at': now, 'last_success_at': now}
    (root / 'ingest_status.json').write_text(json.dumps(status), encoding='utf-8')
    return status


def append_rows(root: Path, rows_by_stream: dict[str, list[dict]]) -> None:
    for name, rows in rows_by_stream.items():
        with (root / name).open('ab') as f:
            for row in rows: f.write((json.dumps(row, sort_keys=True) + '\n').encode('utf-8'))


def write_synthetic_history(root: Path, runs: int, seed: int = 7) -> dict[str, int]:
    """Write a synthetic history into `root` (created if needed) and return row counts per stream."""
    root.mkdir(parents=True, exist_ok=True)
    counts = {}
    for name, rows in synthetic_history(runs, seed).items():
        with (root / name).open('wb') as f:
            for row in rows:
                f.write((json.dumps(row, sort_keys=True) + '\n').encode('utf-8'))
        counts[name] = len(rows)
    return counts


# --------------------------------------------------------------------------------------------
# Oracle: an independent whole-file re-derivation of the merged build_data accounting
# --------------------------------------------------------------------------------------------
#
# Deliberately *not* streaming: every stream is loaded into a list, deduplicated once by
# `record_id`, and each figure is computed by a separate pass over those lists with
# `x / y if y else None` arithmetic (`None` is what `records.NO_DATA` becomes on the wire). The
# list-based reducers both sides share (`waste_cost`, `cost_attribution`, `build_route_stats`,
# `summarize_runs`, `outcome_summary`, `flaky_stats`, ...) are called on the complete lists, so the
# comparison checks that the streaming pass feeds them the same cohorts, and everything the
# streaming pass accumulates inline (session folding, role/runtime/policy/day breakdowns, per-call
# percentiles, adaptive counters, instrumentation sample counts, display tails) is re-derived here.

def _ref_quantile(xs, p):
    if not xs: return None
    xs = sorted(xs); k = (len(xs) - 1) * p; lo = int(k); hi = min(len(xs) - 1, lo + 1); return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def _ref_ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def _ref_mean(xs):
    return sum(xs) / len(xs) if xs else None


def _ref_num(value) -> float:
    if value is None or isinstance(value, bool): return 0.0
    try: return float(value or 0)
    except (TypeError, ValueError): return 0.0


def _ref_tokens(row) -> int:
    return int(_ref_num(row.get('input_tokens'))) + int(_ref_num(row.get('output_tokens')))


def _ref_ts(row) -> object:
    value = row.get('ts')
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).strip().replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None


def _ref_runtime(row) -> str:
    return str(row.get('agent_runtime') or row.get('runtime') or 'unknown')


def _ref_ingest_status(root: Path) -> dict:
    """What the page must say about the sweep. Only the two shapes this test writes are modelled."""
    raw = read_json(root / 'ingest_status.json', None)
    if not isinstance(raw, dict) or not raw:
        return {'status': 'unknown', 'last_attempt_at': None, 'last_success_at': None, 'emitted': 0, 'failure_count': 0,
                'error': None, 'stale_after_seconds': 1800}
    return {'status': raw['status'], 'last_attempt_at': raw['last_attempt_at'], 'last_success_at': raw['last_success_at'],
            'emitted': int(raw.get('emitted') or 0), 'failure_count': int(raw.get('failure_count') or 0),
            'error': raw.get('error'), 'stale_after_seconds': 2 * int(raw.get('sweep_interval_seconds') or 900)}


def _ref_instrumentation(samples: dict[str, int]) -> dict[str, dict]:
    """Per-card instrumentation state from whole-history sample counts (see `dashboard.INSTRUMENTATION`)."""
    state = {}
    for key, field in dashboard.INSTRUMENTATION.items():
        instrumented = records.is_instrumented(field); count = samples[key]
        state[key] = {'field': field, 'instrumented': instrumented, 'samples': count,
                      'label': None if instrumented and count > 0 else ('not emitted' if instrumented else 'not instrumented'),
                      'note': (records.UNINSTRUMENTED_FIELDS.get(field) or records.INSTRUMENTED_FIELDS.get(field)
                               or dashboard._FIELD_NOTES.get(field) or '')}
    return state


def reference_build_data(root: Path, config: dict | None = None):
    config = config or read_json(Path(dashboard.__file__).with_name('config.json'), {})  # `{}` falls back like build_data
    events = list(unique_records(load_jsonl(root / 'events.jsonl')))
    metrics = list(unique_records(load_jsonl(root / 'metrics.jsonl')))
    outcomes = list(unique_records(load_jsonl(root / 'outcomes.jsonl')))
    ingested = [r for r in metrics if is_session_ingest(r)]
    orchestrated = [r for r in metrics if not is_session_ingest(r)]
    # Mirrors `dashboard.build_data`'s injection point exactly: the residual rows must be present
    # before ANY other reducer below reads `orchestrated`, and `ambiguous` never joins any total.
    nested = nested_reconciliation(events, orchestrated)
    orchestrated = orchestrated + nested['rows']

    # -- spend ---------------------------------------------------------------------------------
    total = sum(row_cost(r) for r in orchestrated)
    waste = waste_cost(orchestrated); attribution = cost_attribution(orchestrated)
    per_call = [row_cost(r) for r in orchestrated if records.is_per_call_cost_row(r)]
    session_rows = [r for r in orchestrated if records.classify(r) == records.SESSION]
    p50 = _ref_quantile(per_call, .5); p99 = _ref_quantile(per_call, .99)
    tail_ratio = p99 / p50 if len(per_call) >= dashboard.MIN_TAIL_SAMPLES and p50 else None

    # -- verification: one verdict per task over every row of both streams ---------------------
    by_task = defaultdict(list)
    for r in orchestrated + outcomes:
        if r.get('task_id') is not None: by_task[str(r['task_id'])].append(r)
    verdicts = {tid: records.resolve_task_verification(rows) for tid, rows in by_task.items()}
    verified = {tid for tid, v in verdicts.items() if v == (records.VERIFIED, records.ATTESTED)}
    dispatch_passed = {tid for tid, v in verdicts.items() if v == (records.VERIFIED, records.DISPATCH)}
    task_of = lambda r: str(r['task_id']) if r.get('task_id') is not None else None  # noqa: E731

    # -- breakdowns ----------------------------------------------------------------------------
    roles = sorted({r.get('role') or r.get('capability_class') or 'unknown' for r in orchestrated}, key=str)
    by_role = {}
    for name in roles:
        rows = [r for r in orchestrated if (r.get('role') or r.get('capability_class') or 'unknown') == name]
        calls = [r for r in rows if is_call_row(r)]
        by_role[name] = {'cost': sum(row_cost(r) for r in rows), 'rows': len(rows), 'call_rows': len(calls),
                         'session_rows': sum(1 for r in rows if records.classify(r) == records.SESSION),
                         'covered_calls': sum(records.covered_calls(r) for r in calls), 'tokens': sum(_ref_tokens(r) for r in rows)}
    by_runtime = {}
    for name in sorted({_ref_runtime(r) for r in orchestrated}):
        rows = [r for r in orchestrated if _ref_runtime(r) == name]
        calls = [r for r in rows if is_call_row(r)]
        reported = [r for r in calls if cost_class(r) == REPORTED]; estimated = [r for r in calls if cost_class(r) == ESTIMATED]
        by_runtime[name] = {'cost': sum(row_cost(r) for r in rows), 'rows': len(rows), 'call_rows': len(calls),
                            'session_rows': sum(1 for r in rows if records.classify(r) == records.SESSION),
                            'covered_calls': sum(records.covered_calls(r) for r in calls),
                            'reported_cost': sum(row_cost(r) for r in reported), 'estimated_cost': sum(row_cost(r) for r in estimated),
                            'metered_calls': len(reported) + len(estimated), 'unmetered_calls': len(calls) - len(reported) - len(estimated)}
    policy_rows = []
    for pid in dict.fromkeys(str(r.get('policy_id') or 'unknown') for r in orchestrated):  # first-seen order, like the stream
        rows = [r for r in orchestrated if str(r.get('policy_id') or 'unknown') == pid]
        quality = [float(r['quality_evidence_score']) for r in rows if r.get('quality_evidence_score') is not None]
        aggr = [float(r['cost_aggressiveness']) for r in rows if r.get('cost_aggressiveness') is not None]
        cost = sum(row_cost(r) for r in rows); vn = len({task_of(r) for r in rows} & verified)
        policy_rows.append({'policy_id': pid, 'cost': cost, 'rows': len(rows), 'call_rows': sum(1 for r in rows if is_call_row(r)),
                            'verified': vn, 'verified_cost': _ref_ratio(cost, vn), 'dispatch_pass': len({task_of(r) for r in rows} & dispatch_passed),
                            'quality': _ref_mean(quality), 'cost_aggressiveness': _ref_mean(aggr)})
    trends = []
    for day in sorted({str(r.get('ts', ''))[:10] or 'unknown' for r in orchestrated}):
        rows = [r for r in orchestrated if (str(r.get('ts', ''))[:10] or 'unknown') == day]
        quality = [float(r['quality_evidence_score']) for r in rows if r.get('quality_evidence_score') is not None]
        aggr = [float(r['cost_aggressiveness']) for r in rows if r.get('cost_aggressiveness') is not None]
        cost = sum(row_cost(r) for r in rows); vn = len({task_of(r) for r in rows} & verified)
        trends.append({'day': day, 'cost': cost, 'rows': len(rows), 'call_rows': sum(1 for r in rows if is_call_row(r)), 'verified': vn,
                       'verified_cost': _ref_ratio(cost, vn), 'dispatch_pass': len({task_of(r) for r in rows} & dispatch_passed),
                       'quality': _ref_mean(quality), 'cost_aggressiveness': _ref_mean(aggr),
                       'retries': sum(int(_ref_num(r.get('retry'))) for r in rows),
                       'adaptive': sum(1 for r in rows if r.get('event') == 'adaptive_route_decision')})

    # -- signals with or without a producer ----------------------------------------------------
    context_misses = sum(1 for r in orchestrated if r.get('event') in {'context_packet_miss', 'context_refetch'})
    context_packets = sum(1 for r in orchestrated if r.get('event') == 'context_packet')
    conflicts = sum(1 for e in events if e.get('event') in {'merge_conflict', 'merge_conflict_resolution'})
    invalidations = sum(1 for e in events if e.get('event') == 'decision_invalidated')
    review_wait = [_ref_num(r.get('review_wait_ms')) / 1000 for r in orchestrated if r.get('review_wait_ms') is not None]
    shadow = [r for r in orchestrated if r.get('event') == 'shadow_review']
    false_pass = sum(1 for r in shadow if r.get('normal_pass') is True and r.get('shadow_pass') is False)
    over_reject = sum(1 for r in shadow if r.get('normal_pass') is False and r.get('shadow_pass') is True)
    quality_samples = sum(1 for r in orchestrated if r.get('quality_evidence_score') is not None)
    retry_samples = sum(1 for r in orchestrated if 'retry' in r)
    outsum = outcome_summary(root); mature30 = [x for x in outsum if x['mature_30d']]
    delayed_bad = sum(1 for x in mature30 if x['bad_outcome'])

    # -- adaptive routing ----------------------------------------------------------------------
    adaptive = [r for r in orchestrated if r.get('event') == 'adaptive_route_decision']
    actions = defaultdict(int)
    for r in adaptive: actions[str(r.get('route_action', 'unknown'))] += 1
    action_names = ('recommended_only', 'empirical_enforced', 'static_default', 'fallback_insufficient_history')

    # -- bridge-executed spend and rate provenance ---------------------------------------------
    executed = [r for r in orchestrated if r.get('event') == 'route_executed']
    executed_by_runtime = {}
    for r in executed: executed_by_runtime[_ref_runtime(r)] = executed_by_runtime.get(_ref_runtime(r), 0.0) + _ref_num(r.get('executed_cost_usd'))
    executed_cost = sum(executed_by_runtime.values())
    paired = sum(row_cost(r) for r in orchestrated if r.get('event') == 'model_call' and _ref_runtime(r) in executed_by_runtime)
    executed_spend = {'cost': executed_cost, 'rows': len(executed), 'by_runtime': executed_by_runtime, 'model_call_cost_same_runtimes': paired,
                      'mirrors_model_call_cost': executed_cost > 0 and paired > 0 and abs(executed_cost - paired) <= dashboard.EXECUTED_MIRROR_TOLERANCE * max(executed_cost, paired),
                      'counted_in_total_cost': False}
    estimated_rows = [r for r in metrics if cost_class(r) == ESTIMATED]  # orchestrated + ingested
    rate_models = []
    for name in dict.fromkeys(str(r.get('cost_rate_model') or r.get('model') or 'unknown') for r in estimated_rows):
        rows = [r for r in estimated_rows if str(r.get('cost_rate_model') or r.get('model') or 'unknown') == name]
        sources = [str(r['cost_rate_source']) for r in rows if r.get('cost_rate_source')]
        verified_on = [str(r['cost_rate_verified_on']) for r in rows if r.get('cost_rate_verified_on')]
        timestamps = [_ref_ts(r) for r in rows]
        predates = (not sources and all(t is not None for t in timestamps)
                   and all(t < dashboard.PROVENANCE_INTRODUCED_AT for t in timestamps))
        rate_models.append({'model': name, 'rows': len(rows), 'cost': sum(row_cost(r) for r in rows),
                            'source': sources[0] if sources else None, 'verified_on': verified_on[-1] if verified_on else None,
                            'source_predates_provenance': predates})
    rate_models.sort(key=lambda m: -m['cost'])
    dominant = rate_models[0] if rate_models else None
    rate_provenance = {'scope': 'all metric rows (orchestrated + ingested)', 'estimated_cost': sum(m['cost'] for m in rate_models),
                       'rate_rows': len(estimated_rows), 'verified_rate_rows': sum(1 for r in estimated_rows if r.get('cost_rate_verified_on')),
                       'unverified_rate_cost': sum(m['cost'] for m in rate_models if not m['verified_on']),
                       'dominant_model': dominant['model'] if dominant else None, 'dominant_rows': dominant['rows'] if dominant else None,
                       'dominant_cost': dominant['cost'] if dominant else None, 'models': rate_models[:8]}

    # -- runs ----------------------------------------------------------------------------------
    runs = summarize_runs(orchestrated, events, outcomes); run_cov = evidence_coverage(runs)
    overhead = orchestration_overhead(orchestrated)

    summary = {
        'total_cost': total, 'reported_cost': attribution[REPORTED]['cost'], 'estimated_cost': attribution[ESTIMATED]['cost'],
        'unmetered_calls': attribution[UNMETERED]['calls'], 'call_rows': attribution['call_rows'], 'covered_calls': attribution['covered_calls'],
        'cost_coverage': attribution['coverage'],
        'runs': run_cov['runs'], 'runs_fully_priced': run_cov['runs_fully_priced'], 'runs_with_elapsed': run_cov['runs_with_elapsed'],
        'priced_run_coverage': run_cov['priced_run_coverage'], 'duration_coverage': run_cov['duration_coverage'],
        'verification_coverage': run_cov['verification_coverage'], 'cost_provenance': run_cov['cost_provenance'],
        'runs_with_verification_evidence': run_cov['runs_with_verification_evidence'],
        'runs_with_tested_revision': run_cov['runs_with_tested_revision'],
        'runs_with_check_commands': run_cov['runs_with_check_commands'],
        'runs_with_review_verdict': run_cov['runs_with_review_verdict'],
        'runs_with_unavailable_checks_listed': run_cov['runs_with_unavailable_checks_listed'],
        'tested_revision_coverage': run_cov['tested_revision_coverage'],
        'check_commands_coverage': run_cov['check_commands_coverage'],
        'review_verdict_coverage': run_cov['review_verdict_coverage'],
        'verified_tasks': len(verified), 'verified_cost': _ref_ratio(total, len(verified)),
        'dispatch_pass_tasks': len(dispatch_passed), 'dispatch_pass_cost': _ref_ratio(total, len(dispatch_passed)),
        'waste_cost': sum(waste.values()), 'waste_rate': _ref_ratio(sum(waste.values()), total),
        'orchestration_overhead': overhead, 'coordination_rate': overhead['coordination_rate'], 'verification_rate': overhead['verification_rate'],
        'coordination_cost': overhead['coordination_cost'], 'verification_cost': overhead['verification_cost'],
        'spend_cap_breaches': sum(e.get('event') == 'spend_cap_exceeded' for e in events),
        'nested_reconciliation_ambiguous': nested['ambiguous_count'],
        'fanout_rework': fanout_rework(events), 'context_miss_rate': _ref_ratio(context_misses, context_packets),
        'conflicts': conflicts or None, 'review_wait_p90_s': _ref_quantile(review_wait, .9),
        'shadow_reviews': len(shadow), 'shadow_false_pass_rate': _ref_ratio(false_pass, len(shadow)), 'shadow_over_reject_rate': _ref_ratio(over_reject, len(shadow)),
        'stable_30d_failure_rate': _ref_ratio(delayed_bad, len(mature30)),
        'per_call_samples': len(per_call), 'per_call_cost': sum(per_call), 'mean_call_cost': _ref_mean(per_call),
        'p50_cost': p50, 'p90_cost': _ref_quantile(per_call, .9), 'p99_cost': p99, 'max_call_cost': max(per_call) if per_call else None,
        'session_rows': len(session_rows), 'session_cost': sum(row_cost(r) for r in session_rows),
        'tail_ratio': tail_ratio, 'tail_ratio_min_samples': dashboard.MIN_TAIL_SAMPLES,
        'executed_spend': executed_spend, 'rate_provenance': rate_provenance,
        'adaptive_decisions': len(adaptive), 'adaptive_actions': dict(actions),
        'adaptive_action_counts': {name: (actions.get(name, 0) if adaptive else None) for name in action_names},
        'exploration_rate_observed': _ref_ratio(sum(1 for x in adaptive if x.get('explored')), len(adaptive)),
        'history_sufficient_rate': _ref_ratio(sum(1 for x in adaptive if x.get('history_sufficient')), len(adaptive)),
    }

    # -- interactive sessions: rows are not calls ----------------------------------------------
    interactive_sessions = {
        'rows': len(ingested), 'calls': sum(records.covered_calls(r) for r in ingested),
        'aggregate_rows': sum(1 for r in ingested if records.classify(r) == records.SESSION),
        'cost': sum(row_cost(r) for r in ingested), 'tokens': sum(_ref_tokens(r) for r in ingested), 'by_runtime': {},
        'sessions': len({str(r['session_id']) for r in ingested if r.get('session_id') is not None}) or None,
    }
    for name in dict.fromkeys(_ref_runtime(r) for r in ingested):
        rows = [r for r in ingested if _ref_runtime(r) == name]
        interactive_sessions['by_runtime'][name] = {'rows': len(rows), 'calls': sum(records.covered_calls(r) for r in rows), 'cost': sum(row_cost(r) for r in rows)}

    return {'generated_at': None,
            'last_event_ts': max((str(e.get('ts', '')) for e in events), default=None) or None,
            'last_metric_ts': max((str(r.get('ts', '')) for r in metrics), default=None) or None,
            'event_count': len(events), 'metric_count': len(metrics),
            'summary': summary, 'waste': waste, 'by_role': by_role, 'by_runtime': by_runtime, 'policies': policy_rows, 'trends': trends,
            'instrumentation': _ref_instrumentation({
                'review_wait_p90_s': len(review_wait), 'context_miss_rate': context_packets, 'fanout_rework': invalidations,
                'conflicts': conflicts, 'shadow_false_pass_rate': len(shadow), 'shadow_over_reject_rate': len(shadow),
                'quality': quality_samples, 'avg_quality_evidence': quality_samples, 'retry_rate': retry_samples}),
            'routes': build_route_stats(orchestrated, outcomes), 'outcomes': outsum,
            'run_evidence': run_cov, 'runs': runs[-dashboard.RECENT_RUNS:],
            'lead_sizes': dashboard._lead_sizes(orchestrated, runs),
            'spend_caps': dashboard._spend_caps([e for e in events if e.get('event') == 'spend_cap_exceeded'], runs),
            'nested_reconciliation_ambiguous': nested['ambiguous'],
            'flaky': flaky_stats(orchestrated),
            'interactive_sessions': interactive_sessions,
            'ingest_status': _ref_ingest_status(root),
            'features': feature_inventory(config.get('features', {})), 'adaptive': adaptive[-dashboard.RECENT_ADAPTIVE:],
            'events': events[-dashboard.RECENT_EVENTS:], 'metrics': metrics[-dashboard.RECENT_METRICS:]}


def normalized(data: dict) -> dict:
    """Wire form: `NO_DATA` -> null, defaultdicts/key order flattened, the volatile timestamp removed."""
    data = json.loads(json.dumps(records.to_json(data), sort_keys=True, default=records.json_default))
    data.pop('generated_at', None)
    return data


#: Dollar figures are summed in a different order by the streaming pass (interactive rows are folded
#: as they are read) and by the oracle (one `sum` per cohort); Python 3.14 exposed the resulting
#: representation drift on `interactive_sessions.cost`. A nanodollar is far below anything a reader
#: can act on; a cent is not.
FLOAT_DELTA = 1e-9


def assert_same_data(test: unittest.TestCase, actual, expected, path: str = 'D') -> None:
    """Deep equality with `FLOAT_DELTA` for floats; everything else (keys, ints, strings, nulls) exact."""
    if isinstance(expected, dict):
        test.assertIsInstance(actual, dict, path)
        test.assertEqual(sorted(actual), sorted(expected), f'{path}: key set diverged')
        for key in expected: assert_same_data(test, actual[key], expected[key], f'{path}.{key}')
    elif isinstance(expected, list):
        test.assertIsInstance(actual, list, path)
        test.assertEqual(len(actual), len(expected), f'{path}: length diverged')
        for i, (a, e) in enumerate(zip(actual, expected)): assert_same_data(test, a, e, f'{path}[{i}]')
    elif isinstance(expected, float) and not isinstance(expected, bool) and isinstance(actual, (int, float)) and not isinstance(actual, bool):
        test.assertAlmostEqual(actual, expected, delta=FLOAT_DELTA, msg=path)
    else:
        test.assertEqual(actual, expected, path)


def embedded_data(html: str) -> dict:
    """Parse the `const D=...;` payload the page renders from."""
    start = html.index("<script>const D=") + len("<script>const D=")
    end = html.index(";const $=", start)
    return json.loads(html[start:end])


class SyntheticRootTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name, 'state')
        self.addCleanup(self._tmp.cleanup)

    def freeze_outcome_clock(self):
        """Pin `outcome_summary`'s `now` for the rest of the test.

        `age_days` is `(now - completed_at).days`; the oracle and the streaming build run a second
        apart over ~2k outcomes with random times of day, so about one run in forty saw one
        outcome's age tick over between the two calls. Both sides must see the same instant.
        """
        frozen = datetime.now(timezone.utc)

        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen if tz is None else frozen.astimezone(tz)

        patcher = patch.object(outcomes_module, 'datetime', FrozenDateTime)
        patcher.start(); self.addCleanup(patcher.stop)


# --------------------------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------------------------

class StreamingReaderTests(SyntheticRootTestCase):
    def test_iter_jsonl_yields_only_complete_well_formed_objects(self):
        path = self.root / 'metrics.jsonl'; self.root.mkdir()
        path.write_bytes(b'{"a":1}\n\n   \nnot json\n[1,2]\n"str"\n{"b":2}\n\xff\xfe{"bad":"utf8"}\n{"c":3}\n{"torn":')
        self.assertEqual(list(runtime.iter_jsonl(path)), [{'a': 1}, {'b': 2}, {'c': 3}])
        self.assertEqual(list(runtime.iter_jsonl(self.root / 'missing.jsonl')), [])

    def test_iter_jsonl_streams_instead_of_reading_the_whole_file(self):
        path = self.root / 'events.jsonl'; self.root.mkdir()
        path.write_bytes(b''.join(b'{"i":%d}\n' % i for i in range(1000)))
        with patch.object(Path, 'read_text', side_effect=AssertionError('whole-file read')), \
             patch.object(Path, 'read_bytes', side_effect=AssertionError('whole-file read')):
            it = runtime.iter_jsonl(path)
            self.assertEqual(next(it), {'i': 0})
            self.assertEqual(sum(1 for _ in it), 999)


class DashboardAggregateTests(SyntheticRootTestCase):
    def test_streaming_build_matches_the_whole_file_reference_on_a_large_history(self):
        counts = write_synthetic_history(self.root, runs=450)
        self.assertGreater(counts['metrics.jsonl'], 2000); self.assertGreater(counts['events.jsonl'], 500)
        append_rows(self.root, edge_case_rows())
        ingest_status = write_ingest_status(self.root)
        self.freeze_outcome_clock()
        expected = normalized(reference_build_data(self.root, config={}))
        actual = normalized(dashboard.build_data(self.root, config={}))
        self.assertEqual(sorted(actual), sorted(expected))
        for key in expected:
            with self.subTest(field=key):
                assert_same_data(self, actual[key], expected[key], key)

        # The oracle is only meaningful if the fixture drives the branches it re-derives; pin the
        # shape of the accounting so a regression on either side cannot pass by both being empty.
        summary = actual['summary']; events = load_jsonl(self.root / 'events.jsonl')
        self.assertGreater(summary['per_call_samples'], dashboard.MIN_TAIL_SAMPLES)
        self.assertIsInstance(summary['tail_ratio'], float); self.assertLess(summary['tail_ratio'], 100)
        self.assertGreater(summary['p50_cost'], 0, 'per-call percentiles exclude the $0 event rows')
        self.assertEqual(summary['session_rows'], 1); self.assertAlmostEqual(summary['session_cost'], 4.0)
        self.assertGreater(summary['verified_tasks'], 0)
        # R-edge-T2: dispatch pass + engine `task_verified`/`result: fail` -> neither verified nor a dispatch pass.
        # R-edge-T3: dispatch pass with no attestation -> the one dispatch pass.
        self.assertEqual(summary['dispatch_pass_tasks'], 1)
        edge_policy = next(p for p in actual['policies'] if p['policy_id'] == 'pol-edge')
        self.assertEqual((edge_policy['verified'], edge_policy['dispatch_pass']), (0, 1))
        self.assertEqual(summary['conflicts'], sum(1 for e in events if e.get('event') in {'merge_conflict', 'merge_conflict_resolution'}))
        invalidated = [e for e in events if e.get('event') == 'decision_invalidated']
        self.assertAlmostEqual(summary['fanout_rework'], sum(int(e['affected_tasks']) for e in invalidated) / len(invalidated))
        self.assertEqual(summary['executed_spend']['rows'], 2); self.assertAlmostEqual(summary['executed_spend']['cost'], .5)
        self.assertFalse(summary['executed_spend']['mirrors_model_call_cost']); self.assertFalse(summary['executed_spend']['counted_in_total_cost'])
        self.assertEqual(summary['rate_provenance']['verified_rate_rows'], 1)
        self.assertIn('gpt-5', {m['model'] for m in summary['rate_provenance']['models']})
        # A replayed record_id bills once: the $999 duplicate is exactly what the naive sum over-counts.
        naive_rows = [r for r in load_jsonl(self.root / 'metrics.jsonl') if not is_session_ingest(r)]
        self.assertAlmostEqual(sum(row_cost(r) for r in naive_rows) - summary['total_cost'], 999.0)
        self.assertAlmostEqual(sum(row_cost(r) for r in naive_rows if (r.get('agent_runtime') or r.get('runtime')) == 'claude-code')
                               - actual['by_runtime']['claude-code']['cost'], 999.0)
        self.assertEqual(actual['metric_count'], counts['metrics.jsonl'] + len(edge_case_rows()['metrics.jsonl']) - 1)
        # Session aggregates are counted as calls, not rows.
        sessions = actual['interactive_sessions']
        self.assertEqual(sessions['aggregate_rows'], 1); self.assertEqual(sessions['calls'], sessions['rows'] + 39)
        self.assertEqual(sessions['by_runtime']['codex']['calls'], sessions['by_runtime']['codex']['rows'] + 39)
        # Cards say *why* a value is missing, from the whole history's sample counts.
        instrumentation = actual['instrumentation']
        self.assertEqual(instrumentation['review_wait_p90_s']['label'], 'not instrumented')
        self.assertGreater(instrumentation['review_wait_p90_s']['samples'], 0)
        self.assertIsNone(instrumentation['quality']['label']); self.assertGreater(instrumentation['quality']['samples'], 100)
        self.assertIsNone(instrumentation['retry_rate']['label']); self.assertGreater(instrumentation['retry_rate']['samples'], 100)
        self.assertEqual(instrumentation['fanout_rework']['samples'], len(invalidated))
        # Sweep health is what the fixture wrote, fresh, with the doubled sweep interval as the staleness bound.
        self.assertEqual(actual['ingest_status'], {'status': 'ok', 'last_attempt_at': ingest_status['last_attempt_at'],
                                                   'last_success_at': ingest_status['last_success_at'], 'emitted': 7,
                                                   'failure_count': 1, 'error': None, 'stale_after_seconds': 1200})

    def test_streaming_build_matches_the_reference_without_a_sweep_status_file(self):
        write_synthetic_history(self.root, runs=20)
        self.freeze_outcome_clock()
        expected = normalized(reference_build_data(self.root, config={}))
        actual = normalized(dashboard.build_data(self.root, config={}))
        assert_same_data(self, actual, expected)
        self.assertEqual(actual['ingest_status']['status'], 'unknown')
        self.assertEqual(actual['summary']['executed_spend']['rows'], 0)
        self.assertFalse(actual["summary"]["executed_spend"]["mirrors_model_call_cost"])
    def test_recent_rows_are_bounded_to_the_stream_tail(self):
        write_synthetic_history(self.root, runs=450)
        events = load_jsonl(self.root / 'events.jsonl'); metrics = load_jsonl(self.root / 'metrics.jsonl')
        data = dashboard.build_data(self.root, config={})
        self.assertEqual(data['event_count'], len(events)); self.assertEqual(data['metric_count'], len(metrics))
        self.assertEqual(len(data['events']), dashboard.RECENT_EVENTS); self.assertEqual(data['events'], events[-dashboard.RECENT_EVENTS:])
        self.assertEqual(len(data['metrics']), dashboard.RECENT_METRICS); self.assertEqual(data['metrics'], metrics[-dashboard.RECENT_METRICS:])
        adaptive = [r for r in metrics if r.get('event') == 'adaptive_route_decision' and not is_session_ingest(r)]
        self.assertEqual(data['adaptive'], adaptive[-dashboard.RECENT_ADAPTIVE:])
        self.assertLessEqual(len(data['runs']), dashboard.RECENT_RUNS)
        self.assertEqual(data['summary']['adaptive_decisions'], len(adaptive))  # full-history totals survive the cap

    def test_build_never_reads_a_whole_stream_and_opens_each_stream_once(self):
        write_synthetic_history(self.root, runs=40)
        opened: dict[str, int] = defaultdict(int)
        real_open = io.open

        def counting_open(file, mode='r', *args, **kwargs):
            if isinstance(file, (str, os.PathLike)) and str(file).endswith('.jsonl') and 'r' in mode:
                opened[Path(file).name] += 1
            return real_open(file, mode, *args, **kwargs)

        with patch.object(Path, 'read_text', side_effect=AssertionError('whole-file read of a stream')), \
             patch('io.open', counting_open):
            data = dashboard.build_data(self.root, config={})
        self.assertEqual(dict(opened), {'events.jsonl': 1, 'metrics.jsonl': 1, 'outcomes.jsonl': 1})
        self.assertTrue(data['outcomes'])

    def test_outcome_summary_reuses_already_loaded_rows(self):
        rows = [{'task_id': 'T1', 'completed_at': '2024-01-01T00:00:00+00:00', 'reopened': True}]
        with patch.object(Path, 'exists', side_effect=AssertionError('touched disk')), \
             patch.object(Path, 'open', side_effect=AssertionError('touched disk')):
            summary = outcome_summary(self.root, rows=rows)
        self.assertEqual([(s['task_id'], s['bad_outcome'], s['mature_90d']) for s in summary], [('T1', True, True)])

    def test_invalid_trailing_metric_line_is_ignored_without_losing_the_complete_prefix(self):
        write_synthetic_history(self.root, runs=30)
        metrics = load_jsonl(self.root / 'metrics.jsonl')
        expected_total = sum(row_cost(r) for r in metrics if not is_session_ingest(r))
        with (self.root / 'metrics.jsonl').open('ab') as f:
            f.write(b'garbage line\n{"record_id":"torn","event":"model_call","cost_usd":99')  # torn, no newline
        data = dashboard.build_data(self.root, config={})
        self.assertEqual(data['metric_count'], len(metrics))
        self.assertAlmostEqual(data['summary']['total_cost'], expected_total)
        self.assertNotIn('torn', json.dumps(data['metrics']))
        out = dashboard.generate_dashboard(self.root, config={})
        self.assertEqual(embedded_data(out.read_text(encoding='utf-8'))['metric_count'], len(metrics))


class AtomicPublicationTests(SyntheticRootTestCase):
    def _torn_write_open(self, on_write):
        """io.open wrapper: every file opened for writing during a render gets `on_write` applied."""
        real_open = io.open

        def wrapper(file, mode='r', *args, **kwargs):
            f = real_open(file, mode, *args, **kwargs)
            if 'w' in mode or 'a' in mode:
                original_write = f.write

                def torn(data):
                    on_write(data, original_write)
                f.write = torn
            return f
        return wrapper

    def test_interrupted_render_retains_the_previous_complete_page(self):
        write_synthetic_history(self.root, runs=10)
        out = dashboard.generate_dashboard(self.root, config={})
        previous = out.read_bytes()
        self.assertIn(b'</html>', previous)

        def die_half_way(data, original_write):
            original_write(data[: len(data) // 2]); raise OSError(28, 'No space left on device')

        with patch('io.open', self._torn_write_open(die_half_way)):
            with self.assertRaises(OSError):
                dashboard.generate_dashboard(self.root, config={})
        self.assertEqual(out.read_bytes(), previous, 'a torn render must not replace the published page')
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.endswith('.tmp') and 'dashboard' in p.name], [],
                         'no temporary file may be left behind')
        # A later refresh catches up with a complete document.
        again = dashboard.generate_dashboard(self.root, config={})
        self.assertEqual(again, out)
        self.assertTrue(out.read_text(encoding='utf-8').endswith('</html>'))

    def test_readers_never_observe_a_truncated_page_during_publication(self):
        write_synthetic_history(self.root, runs=10)
        out = dashboard.generate_dashboard(self.root, config={})
        previous = out.read_bytes(); previous_inode = out.stat().st_ino; observed = []

        def observe(data, original_write):
            observed.append(out.read_bytes()); original_write(data)

        with patch('io.open', self._torn_write_open(observe)):
            dashboard.generate_dashboard(self.root, config={})
        final = out.read_bytes()
        self.assertTrue(observed)
        self.assertTrue(final.endswith(b'</html>'))
        # Every write the hook saw happened while the page was one complete document: the previous
        # one for the page's own temp-file writes, and (only after the rename) the new one for the
        # `dashboard.version.json` receipt written next. Never a partial page.
        self.assertEqual(observed[0], previous, 'the page was replaced before the first byte of the new one was written')
        for i, seen in enumerate(observed):
            self.assertIn(seen, (previous, final), f'observation {i}: readers saw a page that is neither the old nor the new complete document')
        self.assertNotEqual(out.stat().st_ino, previous_inode, 'the page must be replaced by rename, not rewritten in place')


class SurrogateTests(SyntheticRootTestCase):
    def test_historical_lone_surrogates_render_as_escaped_json(self):
        write_synthetic_history(self.root, runs=3)
        # What the pre-batch writer (json.dumps, ensure_ascii=True) left on disk: valid ASCII bytes.
        rows = [
            {'ts': '2025-08-01T00:00:00+00:00', 'record_id': 'old-\ud800', 'event': 'model_call', 'run_id': 'R-sur', 'role': 'worker',
             'note': 'a\udfffb</script>', 'cost_usd': .5, 'cost_source': 'reported', 'input_tokens': 1, 'output_tokens': 1},
        ]
        with (self.root / 'metrics.jsonl').open('ab') as f:
            for row in rows: f.write((json.dumps(row) + '\n').encode('ascii'))
        with (self.root / 'events.jsonl').open('ab') as f:
            f.write((json.dumps({'ts': '2025-08-01T00:00:01+00:00', 'record_id': 'ev-\udc00', 'event': 'run_started', 'run_id': 'R-sur'}) + '\n').encode('ascii'))
        out = dashboard.generate_dashboard(self.root, config={})
        html = out.read_bytes().decode('utf-8')  # strict: no surrogate may reach the UTF-8 document
        self.assertNotRegex(html, '[\ud800-\udfff]')
        self.assertNotIn('</script>', html.split('<script>const D=', 1)[1].split(';const $=', 1)[0])
        data = embedded_data(html)
        by_id = {r.get('record_id'): r for r in data['metrics']}
        self.assertEqual(by_id['old-\ud800']['note'], 'a\udfffb</script>')
        self.assertIn('ev-\udc00', {e.get('record_id') for e in data['events']})
        self.assertEqual(data['runs'][-1]['run_id'], 'R-sur')

    def test_safe_escapes_lone_surrogates_but_leaves_valid_unicode_alone(self):
        text = dashboard.safe({'k': 'é😀\ud800</x'})
        self.assertEqual(text, '{"k": "é😀\\ud800<\\/x"}')
        self.assertEqual(json.loads(text), {'k': 'é😀\ud800</x'})


class CliRefreshPathTests(SyntheticRootTestCase):
    def _env(self) -> dict[str, str]:
        return {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(self.root), 'CODING_AGENT_RUNTIME': 'dashboard-test',
                'CODING_AGENT_REPOSITORY': '/work/forge', 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'}

    def _cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, '-B', '-m', 'orchestrator.cli', *args], capture_output=True, text=True, env=self._env(), cwd=str(REPO), timeout=120)

    def test_init_uses_the_batch_refresh_path_without_discarding_the_record_index(self):
        write_synthetic_history(self.root, runs=5)
        first = self._cli('batch', json.dumps([{'stream': 'event', 'record_id': 'warm', 'event': 'run_started', 'run_id': 'W'}]))
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        index = self.root / 'records.index.sqlite3'; receipt = self.root / 'records.checkpoint.json'
        self.assertTrue(index.exists() and receipt.exists())
        before = (index.stat().st_ino, read_json(receipt, None))
        result = self._cli('init')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Initialized V3 state', result.stdout)
        events = load_jsonl(self.root / 'events.jsonl')
        self.assertEqual(events[-1]['event'], 'orchestrator_initialized')
        ledger = read_json(self.root / 'ledger.json', None)
        self.assertEqual(ledger['checkpoint']['events_offset'], (self.root / 'events.jsonl').stat().st_size)
        self.assertTrue(embedded_data((self.root / 'dashboard.html').read_text(encoding='utf-8'))['event_count'] == len(events))
        # The exact-id cache is still the same trusted database (init is not a recovery `rebuild`).
        self.assertEqual(index.stat().st_ino, before[0]); self.assertNotEqual(read_json(receipt, None), before[1])
        self.assertTrue((self.root / 'records.index.sqlite3').exists())

    def test_init_reports_an_append_failure_as_structured_json_with_same_id_retry(self):
        write_synthetic_history(self.root, runs=2)
        before = (self.root / 'events.jsonl').read_bytes()
        script = textwrap.dedent(
            """
            import sys
            from unittest.mock import patch
            from orchestrator import record_batch, cli
            def fail(path, lines, **kwargs): raise OSError(28, 'No space left on device')
            sys.argv = ['orchestrator', 'init']
            with patch.object(record_batch, '_append_stream', fail):
                cli.main()
            """
        )
        result = subprocess.run([sys.executable, '-B', '-c', script], capture_output=True, text=True, env=self._env(), cwd=str(REPO), timeout=120)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)  # EXIT_APPEND_FAILED, like `batch`/`event`
        self.assertNotIn('Traceback', result.stderr)
        body = json.loads(result.stdout)
        self.assertEqual((body['ok'], body['status'], body['retry']), (False, 'append_failed', 'same_ids'))
        self.assertEqual(body['persisted'], {'event': 0, 'metric': 0, 'outcome': 0})
        self.assertIn('No space left', body['error'])
        self.assertFalse(body['ledger_updated']); self.assertFalse(body['dashboard_updated'])
        self.assertEqual((self.root / 'events.jsonl').read_bytes(), before, 'nothing may be appended by a failed init')
        # Same-id retry: the next init finishes the work exactly once.
        retry = self._cli('init')
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertIn('Initialized V3 state', retry.stdout)
        self.assertEqual([e['event'] for e in load_jsonl(self.root / 'events.jsonl')].count('orchestrator_initialized'), 1)


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location('benchmark_refresh', REPO / 'scripts' / 'benchmark_refresh.py')
    module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module; spec.loader.exec_module(module)
    return module


class BenchmarkHarnessTests(SyntheticRootTestCase):
    """scripts/benchmark_refresh.py must measure children without deadlocking and report measured bytes."""

    def setUp(self):
        super().setUp(); self.bench = load_benchmark_module()

    def _run_child_bounded(self, *args, timeout=60, **kwargs):
        """Run the harness in a thread so a reap-before-drain deadlock fails the test instead of hanging it."""
        result = []
        thread = threading.Thread(target=lambda: result.append(self.bench.run_child(*args, **kwargs)), daemon=True)
        thread.start(); thread.join(timeout)
        self.assertTrue(result, f'harness did not return within {timeout}s (child output larger than a pipe buffer)')
        return result[0]

    def test_run_child_drains_output_larger_than_a_pipe_buffer(self):
        out_bytes, err_bytes, in_bytes = 2 * 1024 * 1024, 1024 * 1024, 512 * 1024
        code = (f'import sys; data = sys.stdin.read(); sys.stdout.write("o" * {out_bytes}); sys.stderr.write("e" * {err_bytes}); '
                f'sys.stdout.flush(); sys.exit(0 if len(data) == {in_bytes} else 9)')
        run = self._run_child_bounded([sys.executable, '-c', code], env=dict(os.environ), stdin='i' * in_bytes)
        self.assertEqual(run.returncode, 0, run.stderr[-200:])
        self.assertEqual(len(run.stdout), out_bytes); self.assertEqual(len(run.stderr), err_bytes)
        self.assertGreater(run.ru_maxrss, 0, 'rusage must be the child\'s own (os.wait4)')
        self.assertGreater(run.elapsed_s, 0)
        self.assertIsNone(run.io, 'an uninstrumented child has no I/O report')

    def test_run_child_reports_a_non_zero_exit_code(self):
        run = self._run_child_bounded([sys.executable, '-c', 'import sys; sys.exit(7)'], env=dict(os.environ))
        self.assertEqual(run.returncode, 7)

    def test_run_child_preserves_nonzero_exit_when_timeout_is_configured(self):
        run = self.bench.run_child([sys.executable, '-c', 'import sys; sys.exit(7)'], env=dict(os.environ), timeout=10)
        self.assertEqual(run.returncode, 7)

    def test_run_child_raises_timeout_for_a_hung_process(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.bench.run_child([sys.executable, '-c', 'import time; time.sleep(10)'], env=dict(os.environ), timeout=0.05)

    def test_run_child_with_timeout_blocks_on_the_child_instead_of_sampling_it(self):
        # Only the legacy side carries a timeout. A WNOHANG/sleep poll adds up to one sampling interval
        # to that side's measured elapsed time and nothing to the batch side, biasing the comparison.
        wait4 = os.wait4; options_seen = []
        def recording_wait4(pid, options):
            options_seen.append(options); return wait4(pid, options)
        with patch.object(self.bench.time, 'sleep', side_effect=AssertionError('the harness must not sleep while a measured child runs')), \
             patch.object(self.bench.os, 'wait4', recording_wait4):
            run = self.bench.run_child([sys.executable, '-c', 'import time; time.sleep(0.2)'], env=dict(os.environ), timeout=10)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(options_seen, [0], 'one blocking reap per child; never WNOHANG sampling')
        self.assertGreaterEqual(run.elapsed_s, 0.2)

    def test_run_child_timeout_kills_and_reaps_the_child_in_a_worker_thread(self):
        # The benchmark tests drive the harness from helper threads; the supervisor must not depend on
        # main-thread-only signal handlers, and a timed-out child must be reaped (no zombie, no
        # ResourceWarning from an un-waited Popen).
        outcome = []
        def run():
            try: self.bench.run_child([sys.executable, '-c', 'import time; time.sleep(10)'], env=dict(os.environ), timeout=0.1)
            except BaseException as exc: outcome.append(exc)
        thread = threading.Thread(target=run, daemon=True); thread.start(); thread.join(10)
        self.assertFalse(thread.is_alive(), 'timeout supervisor did not fire from a worker thread')
        self.assertIsInstance(outcome[0], subprocess.TimeoutExpired)

    def _run_child_with_failing_timer_start(self, exc: BaseException, *, after_start: bool):
        """Drive run_child(timeout=...) with a Timer whose start() raises `exc`, optionally after the thread is running.

        Returns (pid, timer, kills): the child's pid, the Timer the supervisor built, and every
        (pid, sig) the harness sent through os.kill. The Timer is armed with a deadline far shorter
        than the child's lifetime, so an un-disarmed supervisor would fire during the test.
        """
        bench = self.bench; timers = []; kills = []; pids = []
        class FailingStart(threading.Timer):
            def start(self):
                timers.append(self)
                if after_start: super().start()  # the interrupt lands after the thread is already running
                raise exc
        real_popen = bench.subprocess.Popen
        def spy_popen(*args, **kwargs):
            proc = real_popen(*args, **kwargs); pids.append(proc.pid); return proc
        real_kill = bench.os.kill
        def spy_kill(pid, sig):
            kills.append((pid, sig)); return real_kill(pid, sig)
        with patch.object(bench.threading, 'Timer', FailingStart), patch.object(bench.subprocess, 'Popen', spy_popen), \
             patch.object(bench.os, 'kill', spy_kill), self.assertRaises(type(exc)) as ctx:
            bench.run_child([sys.executable, '-c', 'import time; time.sleep(10)'], env=dict(os.environ), timeout=0.05)
        self.assertIs(ctx.exception, exc)
        self.assertEqual(len(pids), 1); self.assertEqual(len(timers), 1)
        return pids[0], timers[0], kills

    def _assert_child_reaped_and_supervisor_disarmed(self, pid, timer, kills):
        # No zombie: the pid is no longer a child of this process (a zombie would return (pid, status);
        # a live child (0, 0)). Popen was told about the reap, so its destructor issues no second waitpid.
        with self.assertRaises(ChildProcessError): os.waitpid(pid, os.WNOHANG)
        # No late signal: the supervisor is closed and its thread, if it ever ran, has exited. The
        # one kill is the cleanup path's own, sent before the reap; nothing else may be sent, even
        # if the timer callback were still to run.
        self.assertFalse(timer.is_alive(), 'supervisor thread outlived close()')
        self.assertTrue(timer.finished.is_set(), 'supervisor timer was not cancelled')
        self.assertEqual(kills, [(pid, signal.SIGKILL)])
        deadline = timer.function.__self__
        deadline._expire()  # a late fire after close() must be a no-op: the pid may already belong to someone else
        self.assertEqual(kills, [(pid, signal.SIGKILL)]); self.assertFalse(deadline.expired)

    def test_run_child_reaps_the_child_and_disarms_when_timer_start_raises(self):
        # threading.Timer.start() can fail (RuntimeError: can't start new thread). The supervisor was
        # built outside run_child's cleanup try, so the child stayed unreaped: a zombie until Popen's
        # destructor reaped it behind the harness's back.
        pid, timer, kills = self._run_child_with_failing_timer_start(RuntimeError("can't start new thread"), after_start=False)
        self._assert_child_reaped_and_supervisor_disarmed(pid, timer, kills)

    def test_run_child_disarms_a_running_timer_when_start_is_interrupted(self):
        # Thread.start() blocks on the new thread's started-event; a KeyboardInterrupt delivered there
        # leaves the timer thread running while start() raises. Previously the supervisor reference
        # was lost, so nothing cancelled it: the child was left unreaped and the armed SIGKILL could
        # later hit whatever process the kernel had given the recycled pid.
        pid, timer, kills = self._run_child_with_failing_timer_start(KeyboardInterrupt(), after_start=True)
        self._assert_child_reaped_and_supervisor_disarmed(pid, timer, kills)

    def test_legacy_timeout_budget_scales_with_planned_processes_and_is_capped(self):
        self.assertEqual(self.bench.legacy_process_timeout(1), 60)
        self.assertEqual(self.bench.legacy_process_timeout(120), 120)
        self.assertEqual(self.bench.legacy_process_timeout(500), 240)
        # The outer test budgets the driver's whole compare-legacy workload per (possibly emulated) child
        # from the same planned count the driver uses, inside the same 60..240s bounds.
        self.assertEqual(self.bench.compare_legacy_process_count(scales=3, repeat=1, batch_size=5), 36)
        self.assertEqual(self.bench.legacy_process_timeout(36, seconds_per_process=5), 180)
        self.assertEqual(self.bench.legacy_process_timeout(36, seconds_per_process=10), 240)
        self.assertEqual(self.bench.legacy_process_timeout(2, seconds_per_process=5), 60)

    def test_run_child_keeps_the_exit_code_when_the_io_report_is_truncated(self):
        # A child that dies mid-report leaves a syntactically incomplete file: the harness must report
        # the child's exit code and `io=None`, never raise a decode error that masks the failure.
        code = ('import os, sys; open(os.environ["ORCHESTRATOR_BENCH_IO_REPORT"], "w").write(\'{"python_file_io": {"read_\'); sys.exit(3)')
        run = self._run_child_bounded([sys.executable, '-c', code], env=dict(os.environ))
        self.assertEqual(run.returncode, 3)
        self.assertIsNone(run.io, 'a truncated report is no report')
        # A report that parses but is not the expected object is also discarded, not mistaken for data.
        code = 'import os, sys; open(os.environ["ORCHESTRATOR_BENCH_IO_REPORT"], "w").write("[1, 2]"); sys.exit(0)'
        run = self._run_child_bounded([sys.executable, '-c', code], env=dict(os.environ))
        self.assertEqual(run.returncode, 0); self.assertIsNone(run.io)

    def test_run_cli_surfaces_the_exit_code_of_a_child_that_crashed_mid_report(self):
        code = ('import os, sys; open(os.environ["ORCHESTRATOR_BENCH_IO_REPORT"], "w").write(\'{"python_file_io\'); sys.exit(5)')
        self.bench.cli_argv = lambda *args: [sys.executable, '-c', code]
        with self.assertRaises(SystemExit) as ctx:
            self.bench.run_cli(self.root, 'dashboard', timeout=10)
        self.assertIn('failed (5)', str(ctx.exception))

    def _child(self, io):
        return self.bench.ChildRun(argv=[], returncode=0, elapsed_s=.1, ru_maxrss=1, ru_inblock=0, ru_oublock=0, stdout='', stderr='', io=io)

    def test_io_summary_never_labels_a_partially_reported_group_as_a_whole(self):
        full = lambda r, w: {'python_file_io': {'read_bytes': r, 'write_bytes': w}, 'physical': {'read_bytes': r, 'write_bytes': w, 'source': 'os'}}  # noqa: E731
        logical_only = lambda r, w: {'python_file_io': {'read_bytes': r, 'write_bytes': w}}  # noqa: E731
        complete = [self._child(full(100, 10)), self._child(full(200, 20))]
        unreported = [self._child(full(1000, 100)), self._child(None)]                # a child without any report
        no_physical = [self._child(full(5000, 500)), self._child(logical_only(1, 1))]  # a child that reported only logical bytes
        summary = self.bench.io_summary([complete, unreported, no_physical])
        # Groups with a silent child contribute nothing to that section; the median is over the fully reported groups only,
        # and the section says so instead of presenting 1000/100 as if it were the whole two-child operation.
        self.assertEqual((summary['logical']['read_bytes'], summary['logical']['write_bytes']), (int(statistics.median([300, 5001])), int(statistics.median([30, 501]))))
        self.assertEqual((summary['logical']['groups'], summary['logical']['complete_groups']), (3, 2))
        self.assertTrue(summary['logical']['partial'])
        self.assertEqual((summary['physical']['read_bytes'], summary['physical']['write_bytes']), (300, 30))
        self.assertEqual((summary['physical']['groups'], summary['physical']['complete_groups']), (3, 1))
        self.assertTrue(summary['physical']['partial'])
        # Fully reported groups are not flagged.
        clean = self.bench.io_summary([complete, [self._child(full(7, 7))]])
        self.assertFalse(clean['logical']['partial']); self.assertEqual((clean['logical']['groups'], clean['logical']['complete_groups']), (2, 2))
        self.assertEqual(clean['logical']['read_bytes'], int(statistics.median([300, 7])))
        # A section no complete group reported is None, never a number.
        self.assertIsNone(self.bench.io_summary([unreported, no_physical])['physical'])
        self.assertIsNone(self.bench.io_summary([unreported])['logical'])
        self.assertIsNone(self.bench.io_summary([[self._child(None)]])['logical'])

    def test_instrumented_child_reports_logical_bytes_exactly_and_physical_bytes_separately(self):
        self.root.mkdir(); source = self.root / 'in.bin'; source.write_bytes(os.urandom(300 * 1024 + 17))
        code = textwrap.dedent(f"""
            import os
            from pathlib import Path
            p = Path({str(source)!r}); root = p.parent
            whole = p.read_bytes()                                   # BufferedReader.read(-1) -> readall
            lines = sum(len(l) for l in open(p, 'rb'))               # iteration -> readinto
            with open(root / 'out.bin', 'wb') as f: f.write(b'x' * 123456)   # BufferedWriter -> raw write
            with open(root / 'out.txt', 'w', encoding='utf-8') as f: f.write('\\u00e9' * 1000)   # 2000 UTF-8 bytes
            fd = os.open(root / 'raw.bin', os.O_WRONLY | os.O_CREAT); os.write(fd, b'y' * 1000); os.close(fd)
            fd = os.open(p, os.O_RDONLY); n = len(os.read(fd, 4096)); os.close(fd)
            assert len(whole) == lines == {source.stat().st_size} and n == 4096
        """)
        run = self._run_child_bounded(self.bench.instrumented_argv(code), env=dict(os.environ))
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIsNotNone(run.io)
        logical = run.io['python_file_io']
        self.assertEqual(logical['read_bytes'], 2 * source.stat().st_size + 4096)
        self.assertEqual(logical['write_bytes'], 123456 + 2000 + 1000)
        summary = self.bench.io_summary([[run]])
        self.assertEqual((summary['logical']['read_bytes'], summary['logical']['write_bytes']), (logical['read_bytes'], logical['write_bytes']))
        self.assertIn('source', summary['logical'])
        # Physical I/O is the kernel's/OS's count of bytes that actually reached the disk: reported
        # separately from the logical count, never substituted for it, and null only when this
        # platform offers no per-process source for it.
        self.assertIn('physical', summary)
        if summary['physical'] is not None:
            self.assertTrue(all(isinstance(summary['physical'][k], int) and summary['physical'][k] >= 0 for k in ('read_bytes', 'write_bytes')))
            self.assertIn('source', summary['physical'])
        if sys.platform.startswith('linux') or sys.platform == 'darwin':
            self.assertIsNotNone(summary['physical'], f'{sys.platform} has a per-process physical I/O source')

    def test_cli_children_are_instrumented_and_bytes_exceed_the_streams_read(self):
        write_synthetic_history(self.root, runs=3)
        stream_bytes = sum((self.root / n).stat().st_size for n in STREAMS)
        run = self._run_child_bounded(self.bench.cli_argv('dashboard'), env=self.bench.cli_env(self.root), cwd=str(REPO))
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), str(self.root / 'dashboard.html'))
        self.assertGreaterEqual(run.io['python_file_io']['read_bytes'], stream_bytes, 'a dashboard render reads every stream once')
        self.assertGreaterEqual(run.io['python_file_io']['write_bytes'], (self.root / 'dashboard.html').stat().st_size)
        self.assertFalse([p for p in self.root.iterdir() if p.suffix == '.json' and 'io' in p.name and p.name != 'dashboard.version.json'], 'the I/O report never lands in the state root')

    def test_measure_reports_measured_bytes_not_only_fixture_sizes(self):
        write_synthetic_history(self.root, runs=3)
        args = argparse.Namespace(batch_size=2, repeat=1, checkout=REPO)
        timeouts = []
        run_child = self.bench.run_child
        def record_timeout(*argv, **kwargs):
            if kwargs.get('timeout') is not None: timeouts.append(kwargs['timeout'])
            return run_child(*argv, **kwargs)
        with patch.object(self.bench, 'run_child', record_timeout):
            result = self.bench.measure(self.root, 1, args, tag='t')
        self.assertEqual(timeouts, [60, 60], 'the two per-record legacy children receive the bounded planned-workload timeout')
        self.assertIn('fixture_bytes', result); self.assertNotIn('bytes', result)
        for op in ('batch', 'dashboard', 'per_record_legacy', 'cold_first_batch', 'engine_boundary'):
            io = result[op]['io']
            self.assertGreater(io['logical']['read_bytes'], 0, op); self.assertGreater(io['logical']['write_bytes'], 0, op)
            self.assertIn('physical', io, op)
        self.assertGreater(result['batch']['io']['logical']['write_bytes'], 0)
        self.assertEqual(result['per_record_legacy']['subprocesses'], 2)
        self.assertEqual(result['total_subprocesses'], 1 + 3 + 2)


if __name__ == '__main__':
    unittest.main()

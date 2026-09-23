"""Bounded-memory streaming and atomic publication of the orchestrator dashboard.

Every test runs on a throwaway state root filled with a deterministic synthetic history
(`write_synthetic_history`, also used by `scripts/benchmark_refresh.py`). The aggregate-equality
test compares `dashboard.build_data` with `reference_build_data`, a verbatim copy of the pre-change
implementation that loads whole files into memory: the new streaming build must produce the same
full-history aggregates and UI fields, only the recent-row retention is bounded.
"""
from __future__ import annotations

import io
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import unittest
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from orchestrator import dashboard, runtime
from orchestrator.economics import (ESTIMATED, REPORTED, UNMETERED, cost_attribution, cost_class, fanout_rework,
                                    is_call_row, is_session_ingest, orchestration_overhead, row_cost, waste_cost)
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
# Oracle: the pre-change build_data, verbatim (whole-file loads, three quantile sorts, ...)
# --------------------------------------------------------------------------------------------

def _ref_quantile(xs, p):
    if not xs: return 0.0
    xs = sorted(xs); k = (len(xs) - 1) * p; lo = int(k); hi = min(len(xs) - 1, lo + 1); return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def reference_build_data(root: Path, config: dict | None = None):
    config = config or read_json(Path(dashboard.__file__).with_name('config.json'), {})
    metrics = load_jsonl(root / 'metrics.jsonl'); events = load_jsonl(root / 'events.jsonl'); outcomes = load_jsonl(root / 'outcomes.jsonl')
    ingested = [r for r in metrics if is_session_ingest(r)]
    orchestrated = [r for r in metrics if not is_session_ingest(r)]
    costs = [float(r.get('cost_usd', 0) or 0) + float(r.get('ci_cost_usd', 0) or 0) + float(r.get('human_cost_usd', 0) or 0) for r in orchestrated]
    verified = {r.get('task_id') for r in orchestrated if r.get('result') == 'verified' or r.get('event') == 'task_verified'} - {None}
    total = sum(costs); waste = waste_cost(orchestrated)
    attribution = cost_attribution(orchestrated)
    role = defaultdict(lambda: {'cost': 0, 'calls': 0, 'tokens': 0})
    rt_agg = defaultdict(lambda: {'cost': 0, 'calls': 0, 'reported_cost': 0.0, 'estimated_cost': 0.0, 'metered_calls': 0, 'unmetered_calls': 0})
    policies = defaultdict(lambda: {'cost': 0, 'calls': 0, 'verified': set(), 'quality': [], 'aggr': []})
    adaptive = []
    for r in orchestrated:
        rr = r.get('role') or r.get('capability_class') or 'unknown'
        role[rr]['cost'] += float(r.get('cost_usd', 0) or 0); role[rr]['calls'] += 1
        role[rr]['tokens'] += int(r.get('input_tokens', 0) or 0) + int(r.get('output_tokens', 0) or 0)
        agent_runtime = r.get('agent_runtime') or r.get('runtime') or 'unknown'; rt = rt_agg[agent_runtime]
        rt['cost'] += float(r.get('cost_usd', 0) or 0); rt['calls'] += 1
        if is_call_row(r):
            provenance = cost_class(r)
            if provenance == REPORTED: rt['reported_cost'] += float(r.get('cost_usd', 0) or 0); rt['metered_calls'] += 1
            elif provenance == ESTIMATED: rt['estimated_cost'] += float(r.get('cost_usd', 0) or 0); rt['metered_calls'] += 1
            else: rt['unmetered_calls'] += 1
        pid = r.get('policy_id') or 'unknown'; p = policies[pid]
        p['cost'] += float(r.get('cost_usd', 0) or 0); p['calls'] += 1
        if r.get('result') == 'verified' or r.get('event') == 'task_verified': p['verified'].add(r.get('task_id'))
        if r.get('quality_evidence_score') is not None: p['quality'].append(float(r['quality_evidence_score']))
        if r.get('cost_aggressiveness') is not None: p['aggr'].append(float(r['cost_aggressiveness']))
        if r.get('event') == 'adaptive_route_decision': adaptive.append(r)
    policy_rows = []
    for pid, p in policies.items():
        vn = len(p['verified']); policy_rows.append({'policy_id': pid, 'cost': p['cost'], 'calls': p['calls'], 'verified': vn,
            'verified_cost': p['cost'] / vn if vn else None, 'quality': sum(p['quality']) / len(p['quality']) if p['quality'] else None,
            'cost_aggressiveness': sum(p['aggr']) / len(p['aggr']) if p['aggr'] else None})
    context_misses = sum(1 for r in orchestrated if r.get('event') in {'context_packet_miss', 'context_refetch'})
    context_packets = sum(1 for r in orchestrated if r.get('event') == 'context_packet')
    conflicts = sum(1 for e in events if e.get('event') in {'merge_conflict', 'merge_conflict_resolution'})
    review_wait = [float(r.get('review_wait_ms', 0) or 0) / 1000 for r in orchestrated if r.get('review_wait_ms') is not None]
    shadow = [r for r in orchestrated if r.get('event') == 'shadow_review']
    false_pass = sum(1 for r in shadow if r.get('normal_pass') is True and r.get('shadow_pass') is False)
    over_reject = sum(1 for r in shadow if r.get('normal_pass') is False and r.get('shadow_pass') is True)
    outsum = outcome_summary(root); mature30 = [x for x in outsum if x['mature_30d']]
    delayed_bad = sum(1 for x in mature30 if x['bad_outcome'])
    actions = defaultdict(int)
    for r in adaptive: actions[str(r.get('route_action', 'unknown'))] += 1
    runs = summarize_runs(orchestrated, events, outcomes)
    run_cov = evidence_coverage(runs)
    summary = {'total_cost': total, 'reported_cost': attribution[REPORTED]['cost'], 'estimated_cost': attribution[ESTIMATED]['cost'],
        'unmetered_calls': attribution[UNMETERED]['calls'], 'call_rows': attribution['call_rows'], 'cost_coverage': attribution['coverage'],
        'runs': run_cov['runs'], 'runs_fully_priced': run_cov['runs_fully_priced'], 'runs_with_elapsed': run_cov['runs_with_elapsed'],
        'priced_run_coverage': run_cov['priced_run_coverage'], 'duration_coverage': run_cov['duration_coverage'],
        'verification_coverage': run_cov['verification_coverage'], 'cost_provenance': run_cov['cost_provenance'],
        'verified_tasks': len(verified), 'verified_cost': total / len(verified) if verified else None,
        'waste_cost': sum(waste.values()), 'waste_rate': sum(waste.values()) / total if total else 0,
        'orchestration_overhead': orchestration_overhead(orchestrated), 'fanout_rework': fanout_rework(events),
        'context_miss_rate': context_misses / context_packets if context_packets else 0, 'conflicts': conflicts,
        'review_wait_p90_s': _ref_quantile(review_wait, .9), 'shadow_false_pass_rate': false_pass / len(shadow) if shadow else None,
        'shadow_over_reject_rate': over_reject / len(shadow) if shadow else None,
        'stable_30d_failure_rate': delayed_bad / len(mature30) if mature30 else None,
        'p50_cost': _ref_quantile(costs, .5), 'p90_cost': _ref_quantile(costs, .9), 'p99_cost': _ref_quantile(costs, .99),
        'tail_ratio': _ref_quantile(costs, .99) / max(1e-9, _ref_quantile(costs, .5)) if costs else 0,
        'adaptive_decisions': len(adaptive), 'adaptive_actions': dict(actions),
        'exploration_rate_observed': sum(1 for x in adaptive if x.get('explored')) / len(adaptive) if adaptive else None,
        'history_sufficient_rate': sum(1 for x in adaptive if x.get('history_sufficient')) / len(adaptive) if adaptive else None}
    daily = defaultdict(lambda: {'cost': 0.0, 'calls': 0, 'verified': set(), 'quality': [], 'aggr': [], 'retries': 0, 'adaptive': 0})
    for r in orchestrated:
        day = str(r.get('ts', ''))[:10] or 'unknown'; d = daily[day]; d['cost'] += float(r.get('cost_usd', 0) or 0); d['calls'] += 1; d['retries'] += int(r.get('retry', 0) or 0)
        if r.get('event') == 'adaptive_route_decision': d['adaptive'] += 1
        if r.get('result') == 'verified' or r.get('event') == 'task_verified': d['verified'].add(r.get('task_id'))
        if r.get('quality_evidence_score') is not None: d['quality'].append(float(r['quality_evidence_score']))
        if r.get('cost_aggressiveness') is not None: d['aggr'].append(float(r['cost_aggressiveness']))
    trends = []
    for day, d in sorted(daily.items()):
        vn = len(d['verified']); trends.append({'day': day, 'cost': d['cost'], 'calls': d['calls'], 'verified': vn,
            'verified_cost': d['cost'] / vn if vn else None, 'quality': sum(d['quality']) / len(d['quality']) if d['quality'] else None,
            'cost_aggressiveness': sum(d['aggr']) / len(d['aggr']) if d['aggr'] else None, 'retries': d['retries'], 'adaptive': d['adaptive']})
    interactive_sessions = {
        'calls': len(ingested),
        'cost': sum(row_cost(r) for r in ingested),
        'tokens': sum(int(r.get('input_tokens', 0) or 0) + int(r.get('output_tokens', 0) or 0) for r in ingested),
        'by_runtime': {},
        'sessions': len({str(r.get('session_id')) for r in ingested if r.get('session_id') is not None}) or None,
    }
    for r in ingested:
        agent_runtime = r.get('agent_runtime') or r.get('runtime') or 'unknown'
        br = interactive_sessions['by_runtime'].setdefault(agent_runtime, {'calls': 0, 'cost': 0.0})
        br['calls'] += 1; br['cost'] += row_cost(r)
    last_event_ts = max((str(e.get('ts', '')) for e in events), default=None) or None
    last_metric_ts = max((str(r.get('ts', '')) for r in metrics), default=None) or None
    return {'generated_at': None,
        'last_event_ts': last_event_ts, 'last_metric_ts': last_metric_ts,
        'event_count': len(events), 'metric_count': len(metrics),
        'summary': summary, 'waste': waste, 'by_role': role, 'by_runtime': rt_agg, 'policies': policy_rows, 'trends': trends,
        'routes': build_route_stats(orchestrated, outcomes), 'outcomes': outsum,
        'run_evidence': run_cov, 'runs': runs[-200:],
        'flaky': flaky_stats(orchestrated),
        'interactive_sessions': interactive_sessions,
        'features': feature_inventory(config.get('features', {})), 'adaptive': adaptive[-500:],
        'events': events[-500:], 'metrics': metrics[-2000:]}


def normalized(data: dict) -> dict:
    """JSON round trip (defaultdicts, key order) with the volatile timestamp removed."""
    data = json.loads(json.dumps(data, sort_keys=True, default=str))
    data.pop('generated_at', None)
    return data


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
        expected = normalized(reference_build_data(self.root, config={}))
        actual = normalized(dashboard.build_data(self.root, config={}))
        # Compare the streaming reducer to the whole-file oracle for fields whose semantics did
        # not change. The current dashboard deliberately adds ingest health/instrumentation and
        # distinguishes rows, calls, and attested verification where the older oracle did not.
        stable_keys = ('adaptive', 'event_count', 'events', 'features', 'flaky', 'last_event_ts',
                       'last_metric_ts', 'metric_count', 'metrics', 'outcomes', 'routes',
                       'run_evidence', 'runs', 'waste')
        for key in stable_keys:
            self.assertEqual(actual[key], expected[key], f'dashboard field {key!r} diverged from the reference')
        for key in ('total_cost', 'reported_cost', 'estimated_cost', 'unmetered_calls',
                    'call_rows', 'cost_coverage', 'runs', 'runs_fully_priced', 'runs_with_elapsed'):
            self.assertEqual(actual['summary'][key], expected['summary'][key],
                             f'dashboard summary field {key!r} diverged from the reference')
        for role, old in expected['by_role'].items():
            current = actual['by_role'][role]
            self.assertEqual(current['rows'], old['calls'], role)
            self.assertEqual(current['cost'], old['cost'], role)
            self.assertEqual(current['tokens'], old['tokens'], role)
        for runtime, old in expected['by_runtime'].items():
            current = actual['by_runtime'][runtime]
            self.assertEqual(current['rows'], old['calls'], runtime)
            for key in ('cost', 'reported_cost', 'estimated_cost', 'metered_calls', 'unmetered_calls'):
                self.assertEqual(current[key], old[key], f'runtime {runtime}: {key}')
        self.assertEqual(actual['interactive_sessions']['rows'], expected['interactive_sessions']['calls'])
        for key in ('cost', 'tokens', 'sessions'):
            self.assertEqual(actual['interactive_sessions'][key], expected['interactive_sessions'][key])
        for runtime, old in expected['interactive_sessions']['by_runtime'].items():
            current = actual['interactive_sessions']['by_runtime'][runtime]
            self.assertEqual(current['rows'], old['calls'], runtime)
            self.assertEqual(current['cost'], old['cost'], runtime)
        old_policies = {row['policy_id']: row for row in expected['policies']}
        for current in actual['policies']:
            old = old_policies[current['policy_id']]
            self.assertEqual(current['rows'], old['calls'], current['policy_id'])
            for key in ('cost', 'quality', 'cost_aggressiveness'):
                actual_value, expected_value = current[key], old[key]
                # The newer NO_DATA sentinel preserves its distinction from a measured zero;
                # the legacy whole-file oracle used None for an absent sample.
                if actual_value == 'NO_DATA' and expected_value is None:
                    continue
                self.assertEqual(actual_value, expected_value, f"policy {current['policy_id']}: {key}")
        old_trends = {row['day']: row for row in expected['trends']}
        for current in actual['trends']:
            old = old_trends[current['day']]
            self.assertEqual(current['rows'], old['calls'], current['day'])
            for key in ('cost', 'quality', 'cost_aggressiveness', 'retries', 'adaptive'):
                actual_value, expected_value = current[key], old[key]
                if actual_value == 'NO_DATA' and expected_value is None:
                    continue
                self.assertEqual(actual_value, expected_value, f"trend {current['day']}: {key}")

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
        sidecars = {'dashboard.lock', 'dashboard.version.json'}
        leftovers = [p.name for p in self.root.iterdir()
                     if p.name != 'dashboard.html' and p.name not in sidecars and 'dashboard' in p.name]
        self.assertEqual(leftovers, [], 'no temporary file may be left behind')
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
        self.assertTrue(observed)
        self.assertTrue(all(seen == previous for seen in observed), 'the published page changed before the new one was complete')
        self.assertNotEqual(out.stat().st_ino, previous_inode, 'the page must be replaced by rename, not rewritten in place')
        self.assertTrue(out.read_text(encoding='utf-8').endswith('</html>'))


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
    def _cli(self, *args: str) -> subprocess.CompletedProcess:
        env = {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(self.root), 'CODING_AGENT_RUNTIME': 'dashboard-test',
               'CODING_AGENT_REPOSITORY': '/work/forge', 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'}
        return subprocess.run([sys.executable, '-B', '-m', 'orchestrator.cli', *args], capture_output=True, text=True, env=env, cwd=str(REPO), timeout=120)

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


if __name__ == '__main__':
    unittest.main()

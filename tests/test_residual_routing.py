"""Regression evidence for final pricing/chronology routing blockers."""
import pytest

from orchestrator.adaptive import adaptive_route
from orchestrator.history import build_route_stats


def call(run_id='run-a', **overrides):
    return {
        'event': 'model_call', 'run_id': run_id, 'task_id': 'same-task',
        'task_class': 'crud', 'complexity': 3, 'risk': 'low',
        'capability_class': 'implementation_fast', 'effort': 'low',
        'verification_depth': 'targeted', 'cost_usd': .01, 'cost_source': 'reported',
        **overrides,
    }


@pytest.mark.parametrize('metric_result,outcome,metric_ts,outcome_ts,verified', [
    ('fail', 'verified', '2026-09-23T12:00:00Z', '2026-09-23T11:00:00Z', 0),
    ('verified', 'fail', '2026-09-23T11:00:00Z', '2026-09-23T12:00:00Z', 0),
    ('fail', 'verified', '2026-09-23T11:00:00Z', '2026-09-23T12:00:00Z', 1),
    ('verified', 'fail', '2026-09-23T12:00:00Z', '2026-09-23T11:00:00Z', 1),
    ('fail', 'verified', '2026-09-23T12:00:00Z', '2026-09-23T12:00:00Z', 0),
    # Compare instants, not ISO string order: 13:00+02 is earlier than 12:00Z.
    ('fail', 'verified', '2026-09-23T12:00:00Z', '2026-09-23T13:00:00+02:00', 0),
])
def test_history_latest_verification_across_streams(metric_result, outcome, metric_ts, outcome_ts, verified):
    metrics = [call(), call('run-b', capability_class='implementation_strong'),
               {'event': 'task_verified', 'run_id': 'run-a', 'task_id': 'same-task',
                'result': metric_result, 'ts': metric_ts}]
    outcomes = [{'run_id': 'run-a', 'task_id': 'same-task', 'outcome': outcome, 'ts': outcome_ts},
                {'run_id': 'run-b', 'task_id': 'same-task', 'outcome': 'verified', 'ts': outcome_ts}]
    stats = {s['capability']: s for s in build_route_stats(metrics, outcomes)}
    assert stats['implementation_fast']['verified_tasks'] == verified
    assert stats['implementation_fast']['verified_runs'] == verified
    assert stats['implementation_strong']['verified_tasks'] == 1
    assert stats['implementation_fast']['verified_cost_usd'] == (.01 if verified else None)


def test_history_out_of_order_metric_attempts_use_timestamps():
    metrics = [call(),
               {'event': 'task_verified', 'run_id': 'run-a', 'task_id': 'same-task',
                'result': 'fail', 'ts': '2026-09-23T12:00:00Z'},
               {'event': 'task_verified', 'run_id': 'run-a', 'task_id': 'same-task',
                'result': 'verified', 'ts': '2026-09-23T11:00:00Z'}]
    assert build_route_stats(metrics)[0]['verified_tasks'] == 0


def route(stats):
    return adaptive_route(
        run_id='new', task_class='crud', complexity=3, risk='low', quality_floor=.9,
        cost_aggressiveness=.8, stats=stats, min_samples=12,
        features={'adaptive_routing': {'mode': 'enforce'}, 'historical_learning': {'enabled': True}},
        default_efforts={'implementation_fast': 'standard', 'implementation_strong': 'standard'},
    )


def cohort(*, priced, count=12, shape='direct'):
    metrics = []
    for i in range(count):
        metrics.append(call(f'{shape}-{i}', topology_shape=shape,
                            cost_usd=.01 if priced else None,
                            cost_source='reported' if priced else 'unmetered'))
        metrics.append({'event': 'task_verified', 'run_id': f'{shape}-{i}', 'task_id': 'same-task',
                        'result': 'verified', 'quality_evidence_score': .99})
    return metrics


def test_unmetered_successes_cannot_authorize_empirical_enforce():
    stats = build_route_stats(cohort(priced=False))
    assert stats[0]['verified_tasks'] == 12
    assert stats[0]['unmetered_call_samples'] == 12
    assert stats[0]['verified_cost_usd'] is None
    decision = route(stats)
    assert decision['history_sufficient'] is False
    assert decision['explanation']['action'] == 'fallback_insufficient_history'
    assert decision['selected'] == decision['default']


def test_unmetered_cohort_cannot_lend_sample_count_to_priced_cohort():
    stats = build_route_stats(cohort(priced=False) + cohort(priced=True, count=1, shape='multi_lead'))
    decision = route(stats)
    assert decision['history_sufficient'] is False
    assert decision['selected'] == decision['default']


def test_eligible_priced_cohort_can_enforce_despite_larger_unmetered_cohort():
    stats = build_route_stats(cohort(priced=False, count=20) + cohort(priced=True, shape='multi_lead'))
    decision = route(stats)
    assert decision['history_sufficient'] is True
    assert decision['explanation']['action'] == 'empirical_enforced'
    assert decision['empirical']['choice']['estimated_verified_cost_usd'] == .01
    assert decision['explanation']['verified_task_samples'] == 12

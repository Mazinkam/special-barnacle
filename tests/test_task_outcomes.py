import unittest
from orchestrator.analytics.task_outcomes import task_outcomes, summarize_task_outcomes


def call(run_id, **kw):
    row = {'event': 'model_call', 'run_id': run_id, 'task_id': f'{run_id}-t', 'role': 'worker',
           'capability_class': 'implementation_fast', 'model': 'anthropic/claude-sonnet-4-5',
           'agent_runtime': 'humain-terminal', 'task_class': 'implementation', 'complexity': 3, 'risk': 'low'}
    row.update(kw); return row


def complete(run_id, outcome='verified', **note):
    import json
    return {'run_id': run_id, 'task_id': 'run-complete', 'outcome': outcome, 'verification_scope': 'run',
            'note': json.dumps(note), 'elapsed_ms': 60000, 'elapsed_source': 'monotonic'}


class TaskOutcomeTests(unittest.TestCase):
    def test_route_executed_rows_do_not_create_calls_or_outcomes(self):
        metrics = [call('a', cost_usd=.1, cost_source='reported', input_tokens=10, output_tokens=5),
                   {'event': 'route_executed', 'run_id': 'a', 'task_id': 'a-t', 'complexity': 9, 'risk': 'critical'}]
        [row] = task_outcomes(metrics, [], [complete('a', verification_passed=True)])
        self.assertEqual(row['complexity'], 3)          # decision row ignored for strata
        self.assertEqual(row['risk'], 'low')
        self.assertEqual(row['complexity_band'], 'small')

    def test_decision_only_run_is_not_an_outcome(self):
        metrics = [{'event': 'route_executed', 'run_id': 'z', 'task_id': 'z-t', 'complexity': 9, 'risk': 'critical'}]
        self.assertEqual(task_outcomes(metrics, [], []), [])

    def test_all_unknown_cost_group_is_none(self):
        row = {'verification': 'unknown', 'cost_known_usd': None, 'cost_complete': False, 'complexity_band': 'small'}
        self.assertIsNone(summarize_task_outcomes([row])['small']['cost_known_usd'])

    def test_status_and_verification_are_separate(self):
        [row] = task_outcomes([call('b')], [], [complete('b', outcome='fail', verification_passed=False)])
        self.assertEqual(row['execution_status'], 'completed')
        self.assertEqual(row['verification'], 'fail')

    def test_missing_verdict_is_unknown(self):
        [row] = task_outcomes([call('c', cost_usd=.1, cost_source='reported', input_tokens=1)], [], [])
        self.assertEqual(row['verification'], 'unknown')
        self.assertEqual(row['execution_status'], 'unknown')

    def test_blocked_run(self):
        [row] = task_outcomes([call('d')], [], [complete('d', outcome='blocked', blocked=True)])
        self.assertTrue(row['blocked'])
        self.assertEqual(row['verification'], 'unknown')

    def test_partial_usage_makes_cost_incomplete(self):
        metrics = [call('e', cost_usd=.2, cost_source='reported', input_tokens=10, output_tokens=5),
                   call('e', usage_scope='partial', input_tokens=50, output_tokens=0, cost_usd=.01, cost_source='estimated-from-reported-tokens')]
        [row] = task_outcomes(metrics, [], [complete('e', verification_passed=True)])
        self.assertFalse(row['cost_complete'])
        self.assertEqual(row['usage_partial_calls'], 1)


class SummaryTests(unittest.TestCase):
    def test_denominators_and_cost_per_verified(self):
        rows = [
            {'complexity_band': 'small', 'verification': 'pass', 'blocked': False, 'elapsed_ms': 1000, 'cost_known_usd': 1.0, 'cost_complete': True, 'fix_rounds': 0, 'provider_retries': 0, 'delayed_bad_outcome': None},
            {'complexity_band': 'small', 'verification': 'fail', 'blocked': False, 'elapsed_ms': 3000, 'cost_known_usd': 1.0, 'cost_complete': True, 'fix_rounds': 1, 'provider_retries': 1, 'delayed_bad_outcome': None},
            {'complexity_band': 'small', 'verification': 'unknown', 'blocked': False, 'elapsed_ms': None, 'cost_known_usd': None, 'cost_complete': False, 'fix_rounds': None, 'provider_retries': 0, 'delayed_bad_outcome': True},
        ]
        s = summarize_task_outcomes(rows)['small']
        self.assertEqual((s['n'], s['pass'], s['fail'], s['unknown']), (3, 1, 1, 1))
        self.assertAlmostEqual(s['pass_rate_known'], .5)
        self.assertAlmostEqual(s['verified_rate_all'], 1 / 3)
        self.assertAlmostEqual(s['elapsed_coverage'], 2 / 3)
        self.assertIsNone(s['cost_per_verified_usd'])   # one run's cost is incomplete
        self.assertAlmostEqual(s['fix_rounds_mean'], .5)
        self.assertEqual(s['delayed_bad'], 1)

    def test_zero_passes_has_no_finite_cost_per_success(self):
        rows = [{'complexity_band': 'large', 'verification': 'fail', 'blocked': False, 'elapsed_ms': 10, 'cost_known_usd': 2.0, 'cost_complete': True, 'fix_rounds': 0, 'provider_retries': 0, 'delayed_bad_outcome': None}]
        self.assertIsNone(summarize_task_outcomes(rows)['large']['cost_per_verified_usd'])

    def test_workflow_fields_from_summary(self):
        [row] = task_outcomes([call('w')], [], [complete('w', verification_passed=True,
                               workflow={'mode': 'enforce', 'planned': 'direct', 'final': 'led', 'escalations': 1})])
        self.assertEqual((row['workflow_mode'], row['workflow_level_planned'], row['workflow_level_final'], row['workflow_escalations']),
                         ('enforce', 'direct', 'led', 1))

"""Tests for `orchestrator.model_comparison` — offline, report-only canary comparison.

`compare_canary_cohorts` never routes, never promotes, and never claims quality-equivalence or
savings: every scenario here checks that `claim_supported` stays `False` and that the report only
ever exposes `sufficient_samples` plus raw counts.
"""
import unittest
from datetime import datetime, timezone

from orchestrator.model_comparison import compare_canary_cohorts, format_comparison

NOW = datetime(2026, 3, 1, tzinfo=timezone.utc)


def _row(cohort='baseline', candidate_id='cand-1', model='gpt-6-astra', cost_usd=0.10,
         cost_source='provider_reported', role='implementer', task_class='bugfix', risk='medium',
         complexity=5, repo='repo-a', policy_version='v1', task_id=None, run_id='run-1',
         deviation=None, flags=None, extra=None):
    row = {
        'event': 'model_call', 'canary_cohort': cohort, 'canary_candidate_id': candidate_id,
        'canary_policy_version': policy_version, 'baseline_model': 'gpt-5', 'candidate_model': model,
        'requested_model': model, 'executed_model': model, 'model': model,
        'cost_usd': cost_usd, 'cost_source': cost_source, 'input_tokens': 100, 'output_tokens': 50,
        'role': role, 'task_class': task_class, 'risk': risk, 'complexity': complexity, 'repo': repo,
        'run_id': run_id, 'task_id': task_id, 'canary_deviation': deviation,
        'experiment_flags': flags or [], 'ts': '2026-01-01T00:00:00Z',
    }
    if extra:
        row.update(extra)
    return row


def _make_arm(cohort, n, *, candidate_id='cand-1', task_prefix='t', run_prefix='r', **kwargs):
    return [
        _row(cohort=cohort, candidate_id=candidate_id, task_id=f'{task_prefix}{i}',
             run_id=f'{run_prefix}{i}', **kwargs)
        for i in range(n)
    ]


def _verified_outcome(run_id, task_id, ts='2026-01-02T00:00:00Z'):
    return {'run_id': run_id, 'task_id': task_id, 'outcome': 'verified', 'ts': ts, 'completed_at': ts}


class TestEmptyInput(unittest.TestCase):
    def test_empty_rows_returns_empty_report(self):
        report = compare_canary_cohorts([], now=NOW)
        self.assertEqual(report['groups'], [])
        self.assertEqual(report['ineligible_rows'], 0)
        self.assertEqual(report['confounded_excluded'], 0)
        self.assertIn('no canary-eligible cohorts', format_comparison(report))


class TestZeroExposure(unittest.TestCase):
    def test_only_baseline_present_yields_no_candidate_arm_and_unsupported_claim(self):
        rows = _make_arm('baseline', 5)
        report = compare_canary_cohorts(rows, now=NOW, min_samples_per_arm=5)
        self.assertEqual(len(report['groups']), 1)
        stratum = report['groups'][0]['strata'][0]
        self.assertIsNotNone(stratum['baseline'])
        self.assertIsNone(stratum['candidate'])
        self.assertFalse(stratum['claim_supported'])
        self.assertFalse(stratum['sufficient_samples'])
        self.assertTrue(any('zero exposure' in n for n in stratum['notes']))


class TestConfounded(unittest.TestCase):
    def test_scoped_leads_flag_excluded_by_default(self):
        rows = _make_arm('baseline', 3, flags=['scoped_leads']) + _make_arm('candidate', 3, flags=['scoped_leads'])
        report = compare_canary_cohorts(rows, now=NOW)
        self.assertEqual(report['confounded_excluded'], 6)
        self.assertEqual(report['groups'], [])

    def test_allow_confounded_includes_flagged_rows(self):
        rows = _make_arm('baseline', 3, flags=['scoped_leads']) + _make_arm('candidate', 3, flags=['scoped_leads'])
        report = compare_canary_cohorts(rows, now=NOW, allow_confounded=True)
        self.assertEqual(report['confounded_excluded'], 0)
        self.assertEqual(len(report['groups']), 1)
        stratum = report['groups'][0]['strata'][0]
        self.assertEqual(stratum['baseline']['attempts'], 3)
        self.assertEqual(stratum['candidate']['attempts'], 3)


class TestIneligible(unittest.TestCase):
    def test_ineligible_rows_counted_separately_and_excluded_from_groups(self):
        rows = _make_arm('baseline', 3) + _make_arm('candidate', 3) + [
            _row(cohort='ineligible', candidate_id='cand-1', task_id='i1', run_id='ri1'),
        ]
        report = compare_canary_cohorts(rows, now=NOW)
        self.assertEqual(report['ineligible_rows'], 1)
        stratum = report['groups'][0]['strata'][0]
        self.assertEqual(stratum['baseline']['attempts'], 3)
        self.assertEqual(stratum['candidate']['attempts'], 3)


class TestUnknownCost(unittest.TestCase):
    def test_unknown_cost_not_zero_and_blocks_cost_per_verified(self):
        rows = _make_arm('baseline', 3, cost_usd=None, cost_source='unmetered', extra={'input_tokens': 0, 'output_tokens': 0})
        rows += _make_arm('candidate', 3)
        outcomes = [_verified_outcome(f'r{i}', f't{i}') for i in range(3)]
        report = compare_canary_cohorts(rows, outcomes, now=NOW)
        stratum = report['groups'][0]['strata'][0]
        baseline = stratum['baseline']
        self.assertFalse(baseline['cost']['complete'])
        self.assertEqual(baseline['cost']['unknown_cost_rows'], 3)
        self.assertIsNone(baseline['cost_per_verified_outcome'])
        # known_usd for an unmetered arm must never be reported as a fabricated zero-cost total.
        self.assertEqual(baseline['cost']['known_usd'], 0.0)
        self.assertFalse(stratum['sufficient_samples'])


class TestFailedAttemptsAndNestedRows(unittest.TestCase):
    def test_failed_attempts_and_nested_rows_included_in_cost(self):
        rows = _make_arm('candidate', 3)
        # a failed attempt (result: fail) still costs money and must be counted
        rows.append(_row(cohort='candidate', task_id='fail-1', run_id='rf1', extra={'result': 'fail'}))
        # a real, bridge-shaped nested subagent detail row under a candidate dispatch's own task:
        # `nestedModelCallRowsFor` never stamps canary fields on these — only `run_id` and
        # `parent_task_id` identify it, so it must be attributed to its parent to be counted here.
        candidate_parent = _row(cohort='candidate', task_id='t0', run_id='r0')
        rows.append(candidate_parent)
        rows.append({
            # `role`/`capability_class` matched to the parent's own so this stays one group in the
            # test — in real bridge output the nested child's role usually differs from the
            # dispatch's, which is exactly why capability is NOT among the inherited fields.
            'event': 'model_call', 'run_id': 'r0', 'task_id': 't0:impl-0', 'parent_task_id': 't0',
            'role': 'implementer', 'capability_class': 'implementer',
            'cost_usd': 0.10, 'cost_source': 'reported', 'nested': True,
            'nesting_depth': 1, 'nested_call_id': 'impl-0', 'dispatch_attempt': 0,
        })
        rows += _make_arm('baseline', 3)
        report = compare_canary_cohorts(rows, now=NOW)
        self.assertEqual(report['unattributed_nested_rows'], 0)
        stratum = report['groups'][0]['strata'][0]
        candidate = stratum['candidate']
        self.assertEqual(candidate['attempts'], 5)  # nested detail adds cost, not an attempt
        expected_known = 0.10 * 6
        self.assertAlmostEqual(candidate['cost']['known_usd'], expected_known, places=6)
        self.assertEqual(candidate['nested_cost_by_role']['implementer'], {'known_usd': 0.10, 'unknown_rows': 0})


class TestUnattributedNestedRows(unittest.TestCase):
    def test_nested_row_with_no_matching_parent_is_counted_not_dropped(self):
        rows = _make_arm('candidate', 3) + _make_arm('baseline', 3)
        # `parent_task_id` names a task_id that never appears as a direct row in this run: the
        # nested row's parent cannot be found at all, so it must not be attributed to any arm.
        rows.append({
            'event': 'model_call', 'run_id': 'run-1', 'task_id': 'ghost:impl-0',
            'parent_task_id': 'no-such-task', 'role': 'implementation_strong',
            'cost_usd': 0.42, 'cost_source': 'reported', 'nested': True,
        })
        report = compare_canary_cohorts(rows, now=NOW)
        self.assertEqual(report['unattributed_nested_rows'], 1)
        stratum = report['groups'][0]['strata'][0]
        # the unattributed nested row's $0.42 never lands in either arm.
        self.assertEqual(stratum['candidate']['attempts'], 3)
        self.assertAlmostEqual(stratum['candidate']['cost']['known_usd'], 0.10 * 3, places=6)

    def test_nested_row_under_a_non_canary_parent_is_not_unattributed_and_not_grouped(self):
        # The parent exists (same run_id/task_id) but is not canary-tracked at all — this is a
        # known, real parent, just not part of the comparison, so it must NOT inflate
        # `unattributed_nested_rows` (that counter means "parent not found", not "parent ineligible").
        parent = _row(cohort='ineligible', task_id='t9', run_id='r9')
        nested = {
            'event': 'model_call', 'run_id': 'r9', 'task_id': 't9:impl-0', 'parent_task_id': 't9',
            'role': 'implementation_strong', 'cost_usd': 0.10, 'cost_source': 'reported', 'nested': True,
        }
        rows = _make_arm('candidate', 3) + _make_arm('baseline', 3) + [parent, nested]
        report = compare_canary_cohorts(rows, now=NOW)
        self.assertEqual(report['unattributed_nested_rows'], 0)
        self.assertEqual(report['ineligible_rows'], 1)

    def test_unknown_nested_cost_keeps_arm_cost_incomplete(self):
        parent = _row(cohort='candidate', task_id='t0', run_id='r0')
        unmetered_nested = {
            'event': 'model_call', 'run_id': 'r0', 'task_id': 't0:impl-0', 'parent_task_id': 't0',
            'role': 'implementer', 'cost_source': 'unmetered', 'nested': True,
            'input_tokens': 0, 'output_tokens': 0,
        }
        rows = [parent, unmetered_nested] + _make_arm('candidate', 29, task_prefix='ct', run_prefix='cr')
        rows += _make_arm('baseline', 30, task_prefix='bt', run_prefix='br')
        report = compare_canary_cohorts(rows, now=NOW, min_samples_per_arm=30)
        stratum = report['groups'][0]['strata'][0]
        self.assertFalse(stratum['candidate']['cost']['complete'])
        self.assertFalse(stratum['sufficient_samples'])


class TestNestedReconciliationNoDoubleCounting(unittest.TestCase):
    def test_aggregate_and_detail_rows_are_not_both_booked(self):
        """Phase-1 reconciliation (`economics.nested_reconciliation`) guarantees a dispatch's
        `nested_cost_usd` aggregate and its durable per-task detail rows are never both present as
        call rows for the same identity — this module must not reintroduce that double count by
        also treating a `dispatch_finished`-shaped aggregate row as canary-eligible spend.
        """
        parent = _row(cohort='candidate', task_id='t0', run_id='r0', cost_usd=0.10)
        detail_1 = {
            'event': 'model_call', 'run_id': 'r0', 'task_id': 't0:impl-0', 'parent_task_id': 't0',
            'role': 'implementer', 'cost_usd': 0.20, 'cost_source': 'reported', 'nested': True,
        }
        detail_2 = {
            'event': 'model_call', 'run_id': 'r0', 'task_id': 't0:impl-1', 'parent_task_id': 't0',
            'role': 'implementer', 'cost_usd': 0.30, 'cost_source': 'reported', 'nested': True,
        }
        # The dispatch_finished aggregate event itself: no canary_cohort, so it can never enter a
        # group even though it carries a cost_usd/model_call-adjacent-looking shape.
        aggregate_event = {
            'event': 'dispatch_finished', 'run_id': 'r0', 'task_id': 't0', 'nested_cost_usd': 0.50,
        }
        rows = [parent, detail_1, detail_2, aggregate_event] + _make_arm('baseline', 1, task_prefix='bt', run_prefix='br')
        report = compare_canary_cohorts(rows, now=NOW)
        self.assertEqual(report['unattributed_nested_rows'], 0)
        stratum = report['groups'][0]['strata'][0]
        # parent (0.10) + two detail rows (0.20 + 0.30) = 0.60, never plus the 0.50 aggregate too.
        self.assertAlmostEqual(stratum['candidate']['cost']['known_usd'], 0.60, places=6)
        self.assertEqual(stratum['candidate']['attempts'], 1)
        self.assertEqual(stratum['candidate']['nested_cost_by_role']['implementer'], {'known_usd': 0.50, 'unknown_rows': 0})


class TestDuplicateRows(unittest.TestCase):
    def test_duplicate_record_ids_deduped(self):
        row = _row(cohort='baseline', task_id='t0', run_id='r0', extra={'record_id': 'dup-1'})
        rows = [row, dict(row)] + _make_arm('candidate', 1, task_prefix='ct', run_prefix='cr')
        report = compare_canary_cohorts(rows, now=NOW)
        stratum = report['groups'][0]['strata'][0]
        self.assertEqual(stratum['baseline']['attempts'], 1)


class TestTinySamples(unittest.TestCase):
    def test_tiny_samples_unsupported(self):
        rows = _make_arm('baseline', 2) + _make_arm('candidate', 2)
        report = compare_canary_cohorts(rows, now=NOW, min_samples_per_arm=30)
        stratum = report['groups'][0]['strata'][0]
        self.assertFalse(stratum['sufficient_samples'])
        self.assertFalse(stratum['claim_supported'])
        self.assertTrue(any('below min_samples_per_arm' in n for n in stratum['notes']))


class TestPolicyVersionSeparation(unittest.TestCase):
    def test_strata_separated_by_policy_version(self):
        rows = (
            _make_arm('baseline', 3, policy_version='v1') + _make_arm('candidate', 3, policy_version='v1')
            + _make_arm('baseline', 3, policy_version='v2', task_prefix='b2', run_prefix='rb2')
            + _make_arm('candidate', 3, policy_version='v2', task_prefix='c2', run_prefix='rc2')
        )
        report = compare_canary_cohorts(rows, now=NOW)
        strata = report['groups'][0]['strata']
        self.assertEqual(len(strata), 2)
        versions = sorted(s['policy_version'] for s in strata)
        self.assertEqual(versions, ['v1', 'v2'])


class TestProviderSubstitutionDeviations(unittest.TestCase):
    def test_deviation_counted_by_type(self):
        rows = _make_arm('candidate', 2, deviation='provider_substitution')
        rows += _make_arm('candidate', 1, task_prefix='c2', run_prefix='rc2', deviation=None)
        rows += _make_arm('baseline', 3)
        report = compare_canary_cohorts(rows, now=NOW)
        stratum = report['groups'][0]['strata'][0]
        self.assertEqual(stratum['candidate']['deviations'], {'provider_substitution': 2})


class TestSufficientSamplesAndVerification(unittest.TestCase):
    def test_sufficient_samples_true_with_full_cost_and_verified_outcomes(self):
        rows = (_make_arm('baseline', 30, task_prefix='bt', run_prefix='br')
                + _make_arm('candidate', 30, task_prefix='ct', run_prefix='cr'))
        outcomes = (
            [_verified_outcome(f'br{i}', f'bt{i}') for i in range(30)]
            + [_verified_outcome(f'cr{i}', f'ct{i}') for i in range(30)]
        )
        report = compare_canary_cohorts(rows, outcomes, now=NOW, min_samples_per_arm=30)
        stratum = report['groups'][0]['strata'][0]
        self.assertTrue(stratum['sufficient_samples'])
        self.assertFalse(stratum['claim_supported'])  # never a claim, even when sufficient
        self.assertEqual(stratum['baseline']['outcomes']['verified'], 30)
        self.assertEqual(stratum['candidate']['outcomes']['verified'], 30)
        self.assertIsNotNone(stratum['baseline']['cost_per_verified_outcome'])
        self.assertIsNotNone(stratum['candidate']['cost_per_verified_outcome'])
        # outcomes observed >= 30 days before NOW -> mature, not immature.
        self.assertEqual(stratum['baseline']['delayed']['immature'], 0)
        self.assertEqual(stratum['candidate']['delayed']['immature'], 0)


class TestImmatureOutcomes(unittest.TestCase):
    def test_missing_or_recent_outcomes_are_immature(self):
        rows = _make_arm('baseline', 3, task_prefix='bt', run_prefix='br')
        # one outcome recorded just before NOW (immature), two tasks have no outcome at all.
        outcomes = [_verified_outcome('br0', 'bt0', ts='2026-02-25T00:00:00Z')]
        report = compare_canary_cohorts(rows, outcomes, now=NOW)
        stratum = report['groups'][0]['strata'][0]
        self.assertEqual(stratum['baseline']['delayed']['immature'], 3)


class TestFormatComparison(unittest.TestCase):
    def test_format_comparison_never_prints_a_claim_string(self):
        rows = _make_arm('baseline', 3) + _make_arm('candidate', 3)
        report = compare_canary_cohorts(rows, now=NOW)
        text = format_comparison(report)
        self.assertIn('sufficient_samples', text)
        self.assertIn('claim_supported=False', text)
        self.assertNotIn('quality-equivalent', text)
        self.assertNotIn('savings', text)


if __name__ == '__main__':
    unittest.main()

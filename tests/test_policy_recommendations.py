"""Direct tests for ``orchestrator.policy_recommendations`` (B5).

The module is a re-export shim (B3, `docs/architecture-review.md`): its only public name is
`recommend_policy`, forwarded from `orchestrator.routing.policy`. These tests exercise the real
behaviour of that function through the shim's public surface, not the merged module directly, so a
regression in the re-export itself would also be caught.
"""
import copy
import unittest
from unittest.mock import patch

from orchestrator.history import build_route_stats
from orchestrator.policy_recommendations import recommend_policy
from orchestrator.routing import policy as policy_mod


def crud_rows(task_id: str, *, calls: int = 3, cost: float = .01, quality: float = .99) -> list[dict]:
    base = {'task_class': 'crud', 'complexity': 3, 'risk': 'low', 'capability_class': 'implementation_fast',
            'effort': 'low', 'verification_depth': 'targeted', 'task_id': task_id}
    rows = [{**base, 'event': 'model_call', 'model': 'm', 'cost_usd': cost, 'cost_source': 'reported'} for _ in range(calls)]
    rows.append({**base, 'event': 'task_verified', 'result': 'verified', 'quality_evidence_score': quality})
    return rows


class RecommendPolicyEmptyInputTests(unittest.TestCase):
    def test_empty_stats_never_mutates_never_errors_and_falls_back_to_the_current_policy(self):
        result = recommend_policy(stats=[], current_quality_floor=0.90, current_cost_aggressiveness=0.5)
        self.assertTrue(result['estimated'])
        self.assertEqual(result['current']['cohorts'], 0)
        self.assertIsNone(result['current']['estimated_avg_verified_cost_usd'])
        # nothing was ever priced, so nothing is feasible: the recommendation is the current estimate itself
        self.assertEqual(result['recommendation'], result['current'])
        # 3 quality-floor points x 5 cost-aggressiveness points, deduplicated, all in-range for 0.90/0.5
        self.assertEqual(result['candidates_evaluated'], 15)
        self.assertIn('warning', result)

    def test_empty_stats_grid_still_evaluates_every_combination_even_though_none_are_feasible(self):
        result = recommend_policy(stats=[], current_quality_floor=0.90, current_cost_aggressiveness=0.5)
        for candidate in (result['current'], result['recommendation']):
            self.assertIsNone(candidate['estimated_avg_verified_cost_usd'])
            self.assertIsNone(candidate['estimated_avg_quality_evidence'])
            self.assertEqual(candidate['selections'], [])


class RecommendPolicyGridThresholdTests(unittest.TestCase):
    """`recommend_policy` grid-searches a small neighborhood; both axes are clamped to a valid range."""

    def _simulated_points(self, **kwargs) -> set:
        calls: set = set()
        real_simulate = policy_mod.simulate_policy

        def spy(*, stats, quality_floor, cost_aggressiveness, min_samples):
            calls.add((quality_floor, cost_aggressiveness))
            return real_simulate(stats=stats, quality_floor=quality_floor, cost_aggressiveness=cost_aggressiveness,
                                 min_samples=min_samples)

        with patch.object(policy_mod, 'simulate_policy', spy):
            recommend_policy(stats=[], **kwargs)
        return calls

    def test_quality_floor_above_the_ceiling_is_dropped_from_the_grid(self):
        # current=0.999: +0.01 would be 1.009 (> 0.999 ceiling) and must not be simulated.
        points = self._simulated_points(current_quality_floor=0.999, current_cost_aggressiveness=0.5)
        floors = {q for q, _ in points}
        self.assertEqual(floors, {0.989, 0.999})

    def test_quality_floor_below_the_floor_is_dropped_from_the_grid(self):
        # current=0.80: -0.01 would be 0.79 (< 0.80 floor) and must not be simulated.
        points = self._simulated_points(current_quality_floor=0.80, current_cost_aggressiveness=0.5)
        floors = {q for q, _ in points}
        self.assertEqual(floors, {0.80, 0.81})

    def test_cost_aggressiveness_is_clamped_to_the_unit_interval_and_deduplicated(self):
        # current=0.0: -0.15/-0.05 both clamp to 0.0, which is already the 0-delta point.
        points = self._simulated_points(current_quality_floor=0.90, current_cost_aggressiveness=0.0)
        aggs = {a for _, a in points}
        self.assertEqual(aggs, {0.0, 0.05, 0.15})

    def test_cost_aggressiveness_upper_clamp_and_dedup_at_the_ceiling(self):
        # current=0.95: +0.15 clamps to 1.0, +0.05 rounds to 1.0 too (0.95+0.05=1.00 already at the edge).
        points = self._simulated_points(current_quality_floor=0.90, current_cost_aggressiveness=0.95)
        aggs = {a for _, a in points}
        self.assertEqual(aggs, {0.80, 0.90, 0.95, 1.0})


class RecommendPolicyRealCohortTests(unittest.TestCase):
    def test_a_cheaper_feasible_cohort_is_recommended_over_a_more_expensive_current_policy(self):
        # 20 verified `crud`/low-risk tasks, cheap and high quality: implementation_fast's history
        # dominates its own historical evidence, so the grid search should not recommend anything
        # more expensive than the (already cheap) current policy for the same cohort.
        metrics = []
        for i in range(20):
            metrics += crud_rows(f'T{i}', cost=.01, quality=.99)
        stats = build_route_stats(metrics, [])
        result = recommend_policy(stats=stats, current_quality_floor=0.90, current_cost_aggressiveness=0.5)
        self.assertTrue(result['current']['selections'])
        current_cost = result['current']['estimated_avg_verified_cost_usd']
        recommended_cost = result['recommendation']['estimated_avg_verified_cost_usd']
        self.assertIsNotNone(current_cost)
        self.assertIsNotNone(recommended_cost)
        self.assertLessEqual(recommended_cost, current_cost)
        self.assertGreaterEqual(result['candidates_evaluated'], 1)

    def test_stats_are_never_mutated(self):
        metrics = []
        for i in range(20):
            metrics += crud_rows(f'T{i}')
        stats = build_route_stats(metrics, [])
        before = copy.deepcopy(stats)
        recommend_policy(stats=stats, current_quality_floor=0.90, current_cost_aggressiveness=0.5)
        self.assertEqual(stats, before)

    def test_an_unreachable_quality_floor_never_recommends_below_the_current_achieved_quality(self):
        """Feasibility is gated on `min(quality_floor, current_quality)`: when no candidate can
        plausibly clear an unreachable absolute floor (0.999 here, from only 5 verified samples),
        `recommend_policy` still refuses to recommend anything worse on quality than what the
        current policy already measures -- it does not silently accept a quality regression just
        because the floor itself is unreachable.
        """
        metrics = []
        for i in range(5):
            metrics += crud_rows(f'T{i}', cost=.01, quality=.99)
        stats = build_route_stats(metrics, [])
        result = recommend_policy(stats=stats, current_quality_floor=0.999, current_cost_aggressiveness=0.5)
        current_quality = result['current']['estimated_avg_quality_evidence']
        recommended_quality = result['recommendation']['estimated_avg_quality_evidence']
        recommended_cost = result['recommendation']['estimated_avg_verified_cost_usd']
        current_cost = result['current']['estimated_avg_verified_cost_usd']
        self.assertIsNotNone(current_quality)
        self.assertGreaterEqual(recommended_quality, current_quality)
        self.assertLessEqual(recommended_cost, current_cost)


if __name__ == '__main__':
    unittest.main()

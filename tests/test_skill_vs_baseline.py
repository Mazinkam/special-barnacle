"""Guardrails for the cost-only counterfactuals in skill_vs_baseline.py."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'skill_vs_baseline.py'
spec = importlib.util.spec_from_file_location('skill_vs_baseline', SCRIPT_PATH)
assert spec and spec.loader
skill_vs_baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill_vs_baseline)


class CurrentBaselineTests(unittest.TestCase):
    def test_flat_cost_scenarios_use_active_profile_tiers_and_resolvable_rates(self):
        expected = {
            'gpt-6-luna (cheap tier)': 'gpt-6-luna',
            'sonnet-5-5 (mid tier)': 'claude-sonnet-5-5',
            'opus-5-5 (premium tier)': 'claude-opus-5-5',
            'fable-5-1 (frontier sensitivity)': 'claude-fable-5-1',
        }
        self.assertEqual(dict(skill_vs_baseline.BRACKETS), expected)

        pricing = skill_vs_baseline.load_pricing()
        sample = {'input_tokens': 1_000_000, 'output_tokens': 100_000}
        expected_costs = {
            'gpt-6-luna (cheap tier)': 0.15,
            'sonnet-5-5 (mid tier)': 3.0,
            'opus-5-5 (premium tier)': 6.0,
            'fable-5-1 (frontier sensitivity)': 15.0,
        }
        for label, model in expected.items():
            with self.subTest(label=label):
                self.assertEqual(skill_vs_baseline.reprice(sample, model, pricing), expected_costs[label])

    def test_cost_per_success_comparison_tracks_current_mid_tier_label(self):
        self.assertIn('sonnet-5-5 (mid tier)', [label for label, _ in skill_vs_baseline.BRACKETS])
        self.assertEqual(skill_vs_baseline.COMMON_BASELINE_MODEL, 'claude-sonnet-5-5')


if __name__ == '__main__':
    unittest.main()

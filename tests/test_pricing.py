"""Phase 1 item 6: pricing provenance regression tests.

The audit (`docs/superpowers/audits/2026-09-25-phase1-audit.md`, confirmed defect 4) found that
100% of live `gpt-5.6-sol` / `gpt-5.6-terra` / `sonnet` rows carry `cost_rate_source: null`, but
that this is a *historical* gap: every row predates commit `d57b327` (2026-09-23), which is when
`config.json` first started carrying a `source` on rate entries and `pricing.estimate_cost_usd`
first started forwarding it. Calling `estimate_cost_usd` against HEAD today already returns
`cost_rate_source` for these models. This module pins that so a future refactor cannot silently
drop the field again, for every rate entry `config.json` actually defines, and for the aliases
(provider-prefixed ids, an unversioned `sonnet` name) the audit named by name.
"""
from __future__ import annotations
import unittest
from pathlib import Path

from orchestrator.pricing import estimate_cost_usd, load_pricing
from orchestrator.runtime import read_json

CONFIG_PATH = Path(__file__).resolve().parent.parent / 'orchestrator' / 'config.json'


class PricingProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.config = read_json(CONFIG_PATH, {})
        self.pricing = load_pricing(self.config)
        self.models = self.pricing.get('models') or {}
        self.assertTrue(self.models, 'config.json must define at least one pricing.models entry')

    def test_every_config_rate_entry_populates_cost_rate_source_and_model(self):
        """Every model config.json prices must come back with a non-null `cost_rate_source` and
        the rate table's own `id`/model name in `cost_rate_model`, using realistic token counts
        so no entry is skipped as unmeterable."""
        for model_id, rate in self.models.items():
            with self.subTest(model=model_id):
                result = estimate_cost_usd(
                    model=model_id, input_tokens=10_000, output_tokens=2_000,
                    cached_input_tokens=1_000, cache_write_tokens=500, pricing=self.pricing,
                )
                self.assertIsNotNone(result, f'{model_id} produced no estimate at all')
                self.assertEqual(result['cost_rate_source'], rate.get('source') or 'unverified-local-catalog',
                                 f'{model_id} cost_rate_source did not match its config.json rate entry')
                self.assertIsNotNone(result['cost_rate_source'], f'{model_id} cost_rate_source must not be null')
                self.assertEqual(result['cost_rate_verified_on'], rate.get('verified_on'))
                self.assertEqual(result['cost_rate_model'], rate.get('id') or model_id)

    def test_gpt_5_6_sol_and_terra_carry_provenance(self):
        """The two canary aliases the audit and the Phase 2 goal both name explicitly."""
        for model_id in ('gpt-5.6-sol', 'gpt-5.6-terra'):
            with self.subTest(model=model_id):
                result = estimate_cost_usd(model=model_id, input_tokens=1_000, output_tokens=200, pricing=self.pricing)
                self.assertIsNotNone(result)
                self.assertIsNotNone(result['cost_rate_source'])

    def test_sonnet_variants_carry_provenance(self):
        for model_id in ('claude-sonnet-4-5', 'claude-sonnet-5', 'claude-sonnet-4-20250514', 'claude-sonnet-4-6'):
            with self.subTest(model=model_id):
                result = estimate_cost_usd(model=model_id, input_tokens=1_000, output_tokens=200, pricing=self.pricing)
                self.assertIsNotNone(result)
                self.assertIsNotNone(result['cost_rate_source'])

    def test_provider_prefixed_ids_still_resolve_and_carry_provenance(self):
        """`rate_for`'s suffix/substring match must still resolve a rate \u2014 and its provenance \u2014
        when the model string carries a provider/region prefix a live runtime actually reports."""
        cases = [
            'bedrock/claude-sonnet-4-5',
            'us.anthropic.claude-sonnet-5',
            'anthropic/claude-opus-4-5',
            'openai/gpt-5.6-sol',
        ]
        for model_id in cases:
            with self.subTest(model=model_id):
                result = estimate_cost_usd(model=model_id, input_tokens=1_000, output_tokens=200, pricing=self.pricing)
                self.assertIsNotNone(result, f'{model_id} did not resolve to any rate at all')
                self.assertIsNotNone(result['cost_rate_source'], f'{model_id} resolved but lost its provenance')

    def test_no_config_rate_entry_is_verified_yet(self):
        """Authoritative price-verification work still needed (Phase 1 item 6): every rate entry
        `config.json` defines today is `unverified-local-catalog` with no `verified_on` date. This
        pins the current state so the day a rate is actually verified, this test fails and must be
        updated deliberately \u2014 it must never be relaxed to make an unverified rate look verified.
        """
        unverified = [m for m, r in self.models.items() if r.get('source') == 'unverified-local-catalog' and not r.get('verified_on')]
        self.assertEqual(sorted(unverified), sorted(self.models.keys()),
                         'a rate entry has provenance beyond unverified-local-catalog; update the audit doc, do not relax this test')


if __name__ == '__main__':
    unittest.main()

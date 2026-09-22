import os
import unittest
from unittest.mock import patch

from orchestrator import dynamic_adapter as da


def fake_catalog():
    """A small catalog covering the Anthropic family plus a cheap non-Claude
    model, mirroring the shape of `data/humain_node_catalog.json`."""
    return [
        {
            "id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5",
            "output_cost_per_m": 5.5, "input_cost_per_m": 1.1,
            "max_context_tokens": 200000, "provider_ids": ["bedrock-us-east-1"],
            "api_interface": "anthropic_messages", "supports_function_calling": None,
        },
        {
            "id": "claude-sonnet-5", "display_name": "Claude Sonnet 5",
            "output_cost_per_m": 11.0, "input_cost_per_m": 2.2,
            "max_context_tokens": 1000000, "provider_ids": ["bedrock-us-east-1"],
            "api_interface": "anthropic_messages", "supports_function_calling": None,
        },
        {
            "id": "claude-opus-4-7", "display_name": "Claude Opus 4.7",
            "output_cost_per_m": 27.5, "input_cost_per_m": 5.5,
            "max_context_tokens": 200000, "provider_ids": ["bedrock-us-east-1"],
            "api_interface": "anthropic_messages", "supports_function_calling": None,
        },
        {
            "id": "claude-opus-5", "display_name": "Claude Opus 5",
            "output_cost_per_m": 27.5, "input_cost_per_m": 5.5,
            "max_context_tokens": 200000, "provider_ids": ["bedrock-us-east-1"],
            "api_interface": "anthropic_messages", "supports_function_calling": None,
        },
        {
            "id": "gpt-5.6-luna", "display_name": "GPT 5.6 Luna",
            "output_cost_per_m": 1.2, "input_cost_per_m": 0.2,
            "max_context_tokens": 128000, "provider_ids": ["openai"],
            "api_interface": "chat_completions", "supports_function_calling": None,
        },
    ]


def fake_ht_store(include_claude=True, include_opus=True):
    """Mirrors load_ht_store()'s output shape: {provider: {model_id: {id, aliases}}}."""
    store = {
        "openai-codex": {
            "gpt-5.6-luna": {"id": "gpt-5.6-luna", "aliases": set()},
        },
    }
    if include_claude:
        bedrock = {
            "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
                "id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                "aliases": {"claude-haiku-4-5"},
            },
            "us.anthropic.claude-sonnet-5": {
                "id": "us.anthropic.claude-sonnet-5",
                "aliases": {"claude-sonnet-5"},
            },
        }
        if include_opus:
            bedrock["us.anthropic.claude-opus-4-7"] = {
                "id": "us.anthropic.claude-opus-4-7", "aliases": {"claude-opus-4-7"},
            }
            bedrock["us.anthropic.claude-opus-5"] = {
                "id": "us.anthropic.claude-opus-5", "aliases": {"claude-opus-5"},
            }
        store["amazon-bedrock"] = bedrock
    return store


class ResolveAdapterFamilyPreferenceTests(unittest.TestCase):
    def setUp(self):
        # Belt-and-suspenders: never let a test accidentally read the
        # operator's real HT store/catalog or inherit an env override.
        self._env_patch = patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        os.environ.pop(da.MODEL_FAMILY_ENV_VAR, None)
        self.addCleanup(self._env_patch.stop)

    def _patch_sources(self, ht_store, catalog):
        patcher_ht = patch.object(da, "load_ht_store", return_value=ht_store)
        patcher_cat = patch.object(da, "load_catalog", return_value=catalog)
        patcher_ht.start()
        patcher_cat.start()
        self.addCleanup(patcher_ht.stop)
        self.addCleanup(patcher_cat.stop)

    def test_default_anthropic_mapping_for_all_three_tiers(self):
        self._patch_sources(fake_ht_store(), fake_catalog())
        adapter = da.resolve_adapter()

        self.assertEqual(adapter["implementation_fast"]["model"], "claude-haiku-4-5")
        self.assertEqual(adapter["implementation_fast"]["tier"], "cheapest")
        self.assertEqual(adapter["worker"]["model"], "claude-haiku-4-5")
        self.assertEqual(adapter["scout"]["model"], "claude-haiku-4-5")

        self.assertEqual(adapter["technical_lead"]["model"], "claude-sonnet-5")
        self.assertEqual(adapter["technical_lead"]["tier"], "mid")

        self.assertEqual(adapter["architect"]["model"], "claude-opus-5")
        self.assertEqual(adapter["architect"]["tier"], "expensive")
        self.assertEqual(adapter["security_review"]["model"], "claude-opus-5")

        explanations = adapter["_explanations"]
        self.assertIn("model_family=anthropic", explanations["implementation_fast"])
        self.assertIn("family_rank_tier=cheapest", explanations["implementation_fast"])
        self.assertIn("family_rank_tier=expensive", explanations["architect"])

    def test_explicit_disable_restores_cost_based_selection(self):
        self._patch_sources(fake_ht_store(), fake_catalog())
        adapter = da.resolve_adapter(model_family="none")

        # Pure cost-tier behaviour: luna's $1.2/Mtok output cost undercuts
        # haiku's $5.5/Mtok, so luna wins the cheapest-tier capabilities.
        self.assertEqual(adapter["implementation_fast"]["model"], "gpt-5.6-luna")
        self.assertEqual(adapter["worker"]["model"], "gpt-5.6-luna")
        self.assertEqual(adapter["scout"]["model"], "gpt-5.6-luna")
        self.assertEqual(adapter["implementation_fast"]["provider"], "openai-codex")

        for cap in ("implementation_fast", "worker", "scout"):
            self.assertNotIn("model_family=anthropic", adapter["_explanations"][cap])

    def test_disable_via_env_var(self):
        self._patch_sources(fake_ht_store(), fake_catalog())
        with patch.dict(os.environ, {da.MODEL_FAMILY_ENV_VAR: "cost"}):
            adapter = da.resolve_adapter()
        self.assertEqual(adapter["implementation_fast"]["model"], "gpt-5.6-luna")

    def test_fallback_with_explanation_when_family_member_missing(self):
        # Opus isn't in the configured+catalog intersection (HT store has no
        # bedrock opus entries), but haiku/sonnet still are.
        self._patch_sources(fake_ht_store(include_opus=False), fake_catalog())
        adapter = da.resolve_adapter()

        self.assertEqual(adapter["implementation_fast"]["model"], "claude-haiku-4-5")
        self.assertEqual(adapter["technical_lead"]["model"], "claude-sonnet-5")

        # architect (expensive) falls back to cost-tier selection since no
        # opus is available; sonnet is the next-best (highest cost) model.
        self.assertEqual(adapter["architect"]["model"], "claude-sonnet-5")
        self.assertEqual(adapter["architect"]["tier"], "mid")

        notes = adapter["_explanations"]["architect"]
        self.assertTrue(any("falling back to cost tier" in n for n in notes))
        self.assertTrue(any(n.startswith("tier=") for n in notes))

    def test_never_emits_a_capability_with_no_model(self):
        self._patch_sources(fake_ht_store(), fake_catalog())
        adapter = da.resolve_adapter()
        for cap, info in adapter.items():
            if cap.startswith("_"):
                continue
            self.assertIsNotNone(info.get("model"))
            self.assertTrue(info["model"])

    def test_unknown_model_family_value_disables_preference(self):
        self._patch_sources(fake_ht_store(), fake_catalog())
        adapter = da.resolve_adapter(model_family="totally-made-up")
        self.assertEqual(adapter["implementation_fast"]["model"], "gpt-5.6-luna")


if __name__ == "__main__":
    unittest.main()

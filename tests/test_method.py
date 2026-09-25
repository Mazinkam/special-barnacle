import json
import re
import unittest
from pathlib import Path

from orchestrator import method
from orchestrator.dynamic_adapter import CAPABILITY_TIER_TARGET
from orchestrator.scheduler import EFFORTS

ROOT = Path(__file__).resolve().parents[1]


class TestMethod(unittest.TestCase):
    def test_loads_and_validates(self):
        m = method.load_method()
        self.assertEqual(m["schema_version"], 1)
        self.assertEqual(m["tiers"], ["cheap", "mid", "premium", "frontier"])

    def test_every_capability_has_known_tier_and_effort(self):
        m = method.load_method()
        for cap, spec in m["capabilities"].items():
            self.assertIn(spec["tier"], m["tiers"], cap)
            self.assertIn(spec["default_effort"], m["effort_levels"], cap)

    def test_roles_point_at_declared_capabilities(self):
        m = method.load_method()
        for role, cap in m["roles"].items():
            self.assertIn(cap, m["capabilities"], role)

    def test_rule_capabilities_are_declared(self):
        m = method.load_method()
        caps = set(m["capabilities"])
        r = m["rules"]
        self.assertIn(r["review_after_fix"]["min_capability"], caps)
        for risk, spec in r["review_after_fix"]["escalation_by_risk"].items():
            self.assertIn(spec["capability"], caps, risk)
            self.assertIn(spec["tier_min"], m["tiers"], risk)
        self.assertIn(r["pre_implementation_recon"]["worker_capability"], caps)
        self.assertIn(r["pre_implementation_recon"]["lead_synthesis_capability"], caps)
        self.assertIn(r["exploration_topology"]["recon_capability"], caps)
        self.assertIn(r["exploration_topology"]["synthesis_capability"], caps)
        for cls, spec in r["exploration_topology"]["by_task_class"].items():
            self.assertIn(spec["worker"], caps, cls)
            if spec["lead"] is not None:
                self.assertIn(spec["lead"], caps, cls)

    def test_dynamic_adapter_tiers_derive_from_method(self):
        expected = {cap: method.ADAPTER_TIER_NAMES[spec["tier"]] for cap, spec in method.load_method()["capabilities"].items()}
        self.assertEqual(CAPABILITY_TIER_TARGET, expected)

    def test_scheduler_efforts_derive_from_method(self):
        self.assertEqual(EFFORTS, method.effort_levels())

    def test_helpers(self):
        self.assertEqual(method.tier_of("architect"), "premium")
        self.assertEqual(method.tier_of("implementation_fast"), "cheap")
        self.assertIsNone(method.tier_of("nope"))
        self.assertEqual(method.default_effort("security_review"), "high")
        self.assertEqual(method.default_effort("unknown_cap"), "standard")
        self.assertEqual(method.rereview_floor("high")["tier_min"], "premium")
        self.assertEqual(method.rereview_floor("low")["tier_min"], "mid")
        self.assertTrue(method.rereview_floor("critical").get("independent_review"))
        self.assertEqual(method.recon_workers(4), 0)
        self.assertEqual(method.recon_workers(5), 3)
        self.assertEqual(method.recon_workers(8), 4)
        self.assertEqual(method.recon_workers(10), 5)
        self.assertEqual(method.recon_workers(7, task_class="investigation"), 0)

    def test_bridge_symlink_points_at_canonical_file(self):
        link = ROOT / "bridge" / "extensions" / "orchestrator" / "method.json"
        self.assertTrue(link.is_symlink(), "bridge/extensions/orchestrator/method.json must be a symlink")
        self.assertEqual(link.resolve(), (ROOT / "orchestrator" / "method.json").resolve())
        self.assertEqual(json.loads(link.read_text()), method.load_method())

    def test_skill_md_does_not_contradict_method(self):
        """SKILL.md is the human summary; the thresholds it quotes must match the data."""
        text = (ROOT / "SKILL.md").read_text()
        recon = method.load_method()["rules"]["pre_implementation_recon"]
        self.assertIn(f"complexity >= {recon['min_complexity']}", text)
        for band in recon["workers_by_complexity"]:
            self.assertRegex(text, rf"\|\s*{band['min']}[–-]{band['max']}\s*\|\s*{band['workers']}\s*\|")
        self.assertIn("orchestrator/method.json", text)

    def test_lead_capabilities_and_tiers(self):
        self.assertEqual(method.tier_of("lead_small"), "mid")
        self.assertEqual(method.tier_of("lead"), "premium")
        self.assertEqual(method.tier_of("lead_large"), "frontier")
        self.assertEqual(method.rereview_floor("critical")["tier_min"], "frontier")
        self.assertEqual(method.rereview_floor("high")["tier_min"], "premium")

    def test_lead_size(self):
        self.assertEqual(method.lead_size(2, "low"), "small")
        self.assertEqual(method.lead_size(5, "low"), "standard")
        self.assertEqual(method.lead_size(8, "low"), "large")
        self.assertEqual(method.lead_size(2, "medium"), "standard")
        self.assertEqual(method.lead_size(2, "high"), "large")
        self.assertEqual(method.lead_size(2, "critical"), "large")
        self.assertEqual(method.lead_size(99, "bogus"), "large")
        self.assertEqual(method.lead_size(-4, "bogus"), "standard")
        self.assertEqual(method.lead_size(float("nan"), "low"), "standard")
        self.assertEqual(method.lead_size(9, "critical", override="small"), "small")

    def test_lead_size_rounding_and_non_finite_match_the_bridge(self):
        # TS uses Math.round (half up) and treats non-finite input as 5.
        self.assertEqual(method.lead_size(6.5, "low"), "large")
        self.assertEqual(method.lead_size(3.5, "low"), "standard")
        self.assertEqual(method.lead_size(float("inf"), "low"), "standard")
        self.assertEqual(method.lead_size(float("-inf"), "low"), "standard")
        self.assertEqual(method.lead_size("7", "low"), "large")

    def test_lead_size_parity_with_bridge_cases(self):
        cases = [(1, "low", "small"), (3, "low", "small"), (4, "low", "standard"), (6, "low", "standard"),
                 (7, "low", "large"), (10, "low", "large"), (2, "medium", "standard"), (2, "high", "large"),
                 (2, "critical", "large"), (5, "high", "large"), (2, "weird", "standard")]
        for c, r, size in cases:
            self.assertEqual(method.lead_size(c, r), size, (c, r))

    def test_spend_cap_rule(self):
        cap = method.rule("dispatch_spend_cap")
        self.assertIn(cap["mode"], ("off", "warn", "enforce"))
        self.assertEqual(cap["mode"], "warn")
        self.assertEqual(cap["usd_by_capability"]["lead_large"], 10.0)

    def test_bad_recon_effort_raises(self):
        data = json.loads(method.METHOD_PATH.read_text())
        data["rules"]["exploration_topology"]["recon_effort"] = "medium"
        with self.assertRaisesRegex(ValueError, "recon_effort"):
            method._validate(data)

    def test_bad_rule_tier_raises(self):
        data = json.loads(method.METHOD_PATH.read_text())
        data["rules"]["dispatch_spend_cap"]["default_tier"] = "bogus"
        with self.assertRaisesRegex(ValueError, "default_tier"):
            method._validate(data)

    def test_no_haiku_in_family_presets(self):
        from orchestrator.dynamic_adapter import MODEL_FAMILY_PRESETS
        for preset in MODEL_FAMILY_PRESETS.values():
            for prefix in preset.values():
                self.assertNotIn("haiku", prefix)

    def test_capability_personas_map_to_declared_capabilities(self):
        m = method.load_method()
        for cap, persona in m["capability_personas"].items():
            self.assertIn(cap, m["capabilities"], cap)
            self.assertIsInstance(persona, str)
        self.assertEqual(method.capability_personas(), m["capability_personas"])

    def test_effort_aliases_resolve_to_declared_effort_levels(self):
        m = method.load_method()
        for thinking, effort in m["effort_aliases"].items():
            self.assertIn(effort, m["effort_levels"], thinking)
        self.assertEqual(method.effort_aliases(), m["effort_aliases"])

    def test_bad_capability_persona_raises(self):
        data = json.loads(method.METHOD_PATH.read_text())
        data["capability_personas"]["nope"] = "orch-nope"
        with self.assertRaisesRegex(ValueError, "capability_personas"):
            method._validate(data)

    def test_bad_effort_alias_raises(self):
        data = json.loads(method.METHOD_PATH.read_text())
        data["effort_aliases"]["off"] = "bogus"
        with self.assertRaisesRegex(ValueError, "effort_aliases"):
            method._validate(data)


if __name__ == "__main__":
    unittest.main()

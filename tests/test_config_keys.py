"""B3 review requirement (`docs/architecture-review.md`): every key in `orchestrator/config.json`
must be read somewhere, or deleted. `orchestration`, `context`, `verification`, `budgets`,
`persistence` (top-level) and `optimization.hard_gates` (nested) were deleted by this review step
because nothing reads them (verified individually with `rg` across `orchestrator/`, `scripts/`,
`bridge/`, `tests/` before deleting each one; see the B3 section of the review doc for the exact
`rg` commands run).

This test is the maintained allow-list: `CONFIG_KEY_CONSUMERS` names, for every top-level key
still in `config.json`, the source file(s) that read it (grep-verified `config.get('<key>', ...)`
calls), so a future edit that deletes a consumer without updating this test — or adds a new
top-level key without wiring a reader — fails loudly instead of silently reintroducing dead config.
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / 'orchestrator' / 'config.json'

#: top-level config.json key -> (source file read relative to the repo root, the literal
#: `.get('<key>'` (or `["<key>"]`) substring proving that file reads it).
CONFIG_KEY_CONSUMERS: dict[str, list[tuple[str, str]]] = {
    # `schema_version` is the file's own format-version marker (like `method.json`/`contract.json`/
    # `feature_schema.json`), not a behavioural setting; nothing needs to read it programmatically.
    'schema_version': [],
    'optimization': [('orchestrator/engine.py', 'self.config.get("optimization", {})')],
    'history': [('orchestrator/engine.py', "self.config.get('history',{})")],
    'pricing': [('orchestrator/pricing.py', "config.get('pricing') or {}")],
    'features': [
        ('orchestrator/engine.py', "self.config.get('features', {})"),
        ('orchestrator/presentation/dashboard_data.py', "config.get('features', {})"),
        ('orchestrator/cli/routing_cmds.py', "C.get('features', {})"),
    ],
}

#: `optimization`'s own sub-keys (all read via `o = config.get('optimization', {})` then
#: `o.get(...)` in `engine.py`'s `Policy` construction). `hard_gates` was deleted from `config.json`
#: because it is not in this list (verified unread anywhere).
OPTIMIZATION_SUBKEYS_READ = {
    'quality_floor', 'cost_aggressiveness', 'latency_weight', 'human_hour_value_usd',
    'risk_quality_floor_delta',
}


class ConfigKeysTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(CONFIG_PATH.read_text())

    def test_every_top_level_key_has_a_consumer_entry(self):
        self.assertEqual(set(self.config.keys()), set(CONFIG_KEY_CONSUMERS.keys()),
                          'config.json top-level keys drifted from the maintained allow-list in '
                          'this test; add/remove a CONFIG_KEY_CONSUMERS entry (and verify with rg '
                          'before deleting anything from config.json)')

    def test_every_named_consumer_file_actually_contains_the_read(self):
        for key, consumers in CONFIG_KEY_CONSUMERS.items():
            for relative_path, needle in consumers:
                source = (REPO_ROOT / relative_path).read_text()
                self.assertIn(needle, source, f"{relative_path} no longer contains {needle!r}; "
                                               f"update or remove the '{key}' consumer entry")

    def test_optimization_has_no_unread_subkeys(self):
        self.assertEqual(set(self.config['optimization'].keys()), OPTIMIZATION_SUBKEYS_READ)

    def test_deleted_keys_stay_deleted(self):
        deleted = {'orchestration', 'context', 'verification', 'budgets', 'persistence'}
        self.assertEqual(deleted & set(self.config.keys()), set())
        self.assertNotIn('hard_gates', self.config.get('optimization', {}))


if __name__ == '__main__':
    unittest.main()

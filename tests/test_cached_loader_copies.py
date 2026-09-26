"""B2 step 5: cached loaders must not hand out a reference to their own cache.

`method.load_method`, `economics._role_sets` (backed by `@lru_cache`) and `core.fs.read_json`
(not cached, but exercised here for the same property) must all return something a caller can
mutate without corrupting what the next caller sees. Before this test, `method.load_method()`
returned the exact object `functools.lru_cache` remembers, so `load_method()['tiers'].append(...)`
in one caller silently changed `m['tiers']` for every other caller for the rest of the process.
"""
from __future__ import annotations

import json

from orchestrator import economics, method
from orchestrator.core.fs import read_json


def test_load_method_mutation_does_not_leak_into_next_call():
    first = method.load_method()
    first['tiers'].append('bogus-tier')
    first['capabilities']['bogus-cap'] = {'tier': 'bogus-tier', 'default_effort': 'standard'}

    second = method.load_method()

    assert 'bogus-tier' not in second['tiers']
    assert 'bogus-cap' not in second['capabilities']


def test_load_method_returns_a_new_object_each_call():
    first = method.load_method()
    second = method.load_method()
    assert first == second
    assert first is not second
    # nested containers must be independent too, not just the top-level dict
    assert first['capabilities'] is not second['capabilities']


def test_role_sets_mutation_does_not_leak_into_next_call():
    first = economics._role_sets()
    first['bogus-key'] = frozenset({'bogus-role'})

    second = economics._role_sets()

    assert 'bogus-key' not in second
    assert set(second) == {economics.COORDINATION, economics.VERIFICATION}


def test_role_sets_returns_a_new_dict_each_call():
    first = economics._role_sets()
    second = economics._role_sets()
    assert first == second
    assert first is not second


def test_read_json_mutation_of_result_does_not_affect_next_read(tmp_path):
    path = tmp_path / 'config.json'
    path.write_text(json.dumps({'pricing': {'a': 1}}), encoding='utf-8')

    first = read_json(path, {})
    first['pricing']['a'] = 999
    first['pricing']['injected'] = True

    second = read_json(path, {})

    assert second == {'pricing': {'a': 1}}


def test_read_json_missing_file_returns_independent_defaults_across_calls(tmp_path):
    """Each call passes its own default literal, so two calls against a missing file must not
    somehow share state through `read_json` itself."""
    path = tmp_path / 'missing.json'
    first = read_json(path, {'artifacts': {}})
    first['artifacts']['x'] = 1

    second = read_json(path, {'artifacts': {}})

    assert second == {'artifacts': {}}

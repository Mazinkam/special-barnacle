"""B2 review finding: `from orchestrator.scheduler import *` and `from orchestrator.dynamic_adapter
import *` must still yield `EFFORTS`/`CAPABILITY_TIER_TARGET`.

Both constants used to be plain module-level assignments (`EFFORTS = effort_levels()`,
`CAPABILITY_TIER_TARGET = adapter_tier_targets()`) computed at import time — a file read on every
`import orchestrator.scheduler`/`import orchestrator.dynamic_adapter`. `tests/
test_import_side_effects.py` (B2 step 5) forbids that: both are now resolved lazily, on first
access, through module `__getattr__`. Neither module previously defined `__all__`, so a bare `from
module import *` (no `__all__`) only binds names already sitting in `module.__dict__` — and a
name served exclusively through `__getattr__` never gets there, so switching to lazy resolution
silently dropped `EFFORTS`/`CAPABILITY_TIER_TARGET` from every wildcard import. Both modules now
define an explicit `__all__` that lists `EFFORTS`/`CAPABILITY_TIER_TARGET` alongside every other
previously-public name: with an `__all__` present, `import *` does `getattr(module, name)` for
each listed name instead of reading `__dict__` directly, which does reach `__getattr__`.
"""
from __future__ import annotations

import unittest

import orchestrator.dynamic_adapter as dynamic_adapter
import orchestrator.scheduler as scheduler

#: Every public (non-underscore) module-level name `orchestrator/scheduler.py` exposed at 1a1e439
#: (pre-lazy-loading), before `EFFORTS` became `__getattr__`-only. `SCHEDULER_MIN_SAMPLES` and
#: `efforts` are later additions, kept in the module's own `__all__` but not required here since
#: this set only has to prove nothing from 1a1e439 was removed.
SCHEDULER_PUBLIC_NAMES_AT_1A1E439 = frozenset({
    'Any', 'ComputePackage', 'DEFAULT_PACKAGES', 'EFFORTS', 'asdict', 'bucket_complexity',
    'dataclass', 'effort_levels', 'is_no_data', 'measured', 'package_history',
    'recommend_package', 'topology_for',
})

#: Same, for `orchestrator/dynamic_adapter.py`.
DYNAMIC_ADAPTER_PUBLIC_NAMES_AT_1A1E439 = frozenset({
    'Any', 'CAPABILITY_TIER_TARGET', 'DISABLE_VALUES', 'EXCLUDED_MODEL_PREFIXES',
    'MODEL_FAMILY_DEFAULT', 'MODEL_FAMILY_ENV_VAR', 'MODEL_FAMILY_PRESETS', 'Path',
    'TIER_BOUNDARIES', 'adapter_tier_targets', 'argparse', 'defaultdict', 'is_excluded_model',
    'json', 'load_catalog', 'load_ht_store', 'main', 'os', 'provider_for_model',
    'resolve_adapter', 'resolve_model_family', 'resolve_models', 'sys', 'tier_for',
})


class StarExportTests(unittest.TestCase):
    def test_scheduler_all_is_a_superset_of_the_pre_lazy_loading_public_names(self):
        self.assertTrue(SCHEDULER_PUBLIC_NAMES_AT_1A1E439.issubset(set(scheduler.__all__)),
                         'orchestrator.scheduler.__all__ must not drop a name that used to be '
                         f'star-importable: missing {SCHEDULER_PUBLIC_NAMES_AT_1A1E439 - set(scheduler.__all__)}')

    def test_dynamic_adapter_all_is_a_superset_of_the_pre_lazy_loading_public_names(self):
        self.assertTrue(DYNAMIC_ADAPTER_PUBLIC_NAMES_AT_1A1E439.issubset(set(dynamic_adapter.__all__)),
                         'orchestrator.dynamic_adapter.__all__ must not drop a name that used to be '
                         'star-importable: missing '
                         f'{DYNAMIC_ADAPTER_PUBLIC_NAMES_AT_1A1E439 - set(dynamic_adapter.__all__)}')

    def test_star_import_from_scheduler_includes_efforts(self):
        namespace: dict[str, object] = {}
        exec('from orchestrator.scheduler import *', namespace)
        self.assertIn('EFFORTS', namespace)
        self.assertEqual(namespace['EFFORTS'], scheduler.efforts())

    def test_star_import_from_dynamic_adapter_includes_capability_tier_target(self):
        namespace: dict[str, object] = {}
        exec('from orchestrator.dynamic_adapter import *', namespace)
        self.assertIn('CAPABILITY_TIER_TARGET', namespace)
        self.assertEqual(namespace['CAPABILITY_TIER_TARGET'], dynamic_adapter._capability_tier_target())


if __name__ == '__main__':
    unittest.main()

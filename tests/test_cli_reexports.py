"""B3 review requirement (`docs/architecture-review.md`): `orchestrator.cli` must keep re-exporting
every name that was importable from the old single-file `orchestrator/cli.py` (ground rule 2 —
"don't change what's importable"), even though the argparse construction and command dispatch now
live in per-command-group modules under the `orchestrator/cli/` package.

`EXPECTED_CLI_REEXPORTS` below is the literal set of every module-level name (`ast`-derived:
`def`/`class` statements, plain assignments/annotated assignments, and every name bound by an
`import`/`from ... import` statement, excluding the `from __future__ import annotations` binding)
in `orchestrator/cli.py` at commit `580c504` (the tip of `refactor/modular` immediately before the
`cli.py` -> `cli/__init__.py` split): `git show 580c504:orchestrator/cli.py`, then the same
`ast.parse`/`tree.body` walk `tests/test_ingest_reexports.py` uses for the equivalent `ingest.py`
split.
"""
from __future__ import annotations

import unittest

from orchestrator import cli

#: Every module-level name `orchestrator/cli.py` bound just before the B3 CLI-package split.
EXPECTED_CLI_REEXPORTS: frozenset = frozenset({
    'Any', 'BatchAppendError', 'BatchValidationError', 'CONTRACT_EXIT_APPEND_FAILED',
    'CONTRACT_EXIT_INVALID', 'CONTRACT_EXIT_OK', 'CONTRACT_EXIT_REFRESH_FAILED', 'Callable',
    'ContextRegistry', 'DEFAULT_OLDER_THAN_DAYS', 'EXIT_APPEND_FAILED', 'EXIT_INVALID', 'EXIT_OK',
    'EXIT_REFRESH_FAILED', 'EventStore', 'FeaturePolicy', 'INGEST_ERROR_LIMIT',
    'PATH_REDACTION_RE', 'Path', 'QualityEvidence', 'RESTORE_COMMAND', 'RETRY_SAME_IDS', 'ROOT',
    'STATUS_APPEND_FAILED', 'STATUS_INVALID', 'STREAMS', '_PATH_RE', '_add_policy_override_flags',
    '_archive_runs_command', '_batch_payload', '_bound_error', '_failure', '_fmt_bytes',
    '_format_adapter_table', '_ingest_process_ingest', '_parse_json', '_redact_paths',
    '_restore_run_command', '_root', '_single', '_write', 'archive_runs', 'argparse',
    'build_engine', 'build_parser', 'cfg', 'default_state_root', 'discover_logs',
    'feature_inventory', 'generate_dashboard', 'ingest_paths', 'json', 'load_or_rebuild',
    'load_stats', 'main', 'make_ingest_status', 'os', 'process_ingest', 'read_json', 'rebuild',
    'recommend_package', 'refresh', 'refresh_after_write', 'refresh_ledger', 'resolve_adapter',
    'restore_run', 'single_record', 'summarize_archive_results', 'sys', 'topology_for',
    'write_batch', 'write_records',
    # Added by the B3 split itself (still module-level on `orchestrator.cli`, not moved out):
    'eng',
})


class CliReexportTests(unittest.TestCase):
    def test_every_pre_split_name_is_still_importable(self):
        missing = sorted(name for name in EXPECTED_CLI_REEXPORTS if not hasattr(cli, name))
        self.assertEqual(missing, [], f'orchestrator.cli no longer exposes: {missing}')

    def test_command_modules_are_reachable_for_patch_object_targets(self):
        # `records_cmds.register`/`.HANDLERS` etc. are real submodules, not copies, so
        # `mock.patch.object(cli.records_cmds, ...)`-style targets (if ever needed) work.
        from orchestrator.cli import archive_cmds, context_cmds, ingest_cmds, records_cmds, routing_cmds
        for module in (records_cmds, routing_cmds, ingest_cmds, context_cmds, archive_cmds):
            self.assertTrue(hasattr(module, 'register'))
            self.assertTrue(hasattr(module, 'HANDLERS'))

    def test_dunder_main_runs_the_same_main(self):
        import runpy
        import unittest.mock as mock
        with mock.patch.object(cli, 'main') as fake_main:
            # `python3 -m orchestrator.cli` executes `orchestrator/cli/__main__.py`, which must call
            # the exact same `main` this module exposes (so patching `cli.main` in a test, or a
            # future wrapper script calling it directly, observes `__main__.py` too).
            runpy.run_module('orchestrator.cli.__main__', run_name='__main__')
            fake_main.assert_called_once()


if __name__ == '__main__':
    unittest.main()

"""B3 review requirement (`docs/architecture-review.md`): `orchestrator.ingest` and
`orchestrator.ingest_checkpoint` must keep re-exporting every name that was importable from them
before the B3 split, and `orchestrator.cli` must keep `make_ingest_status`/`process_ingest`
importable under those exact names even though their implementation moved to
`orchestrator.ingest.service`.

The expected-name sets below are the literal set of every module-level name (`ast`-derived:
`def`/`class` statements, plain assignments/annotated assignments, and every name bound by an
`import`/`from ... import` statement, excluding the `from __future__ import annotations` binding)
in `orchestrator/ingest.py` and `orchestrator/ingest_checkpoint.py` at the pre-split commit (the
tip of `refactor/modular` immediately before this split). Anything previously reachable as
`orchestrator.ingest.<name>` or `orchestrator.ingest_checkpoint.<name>` — a private helper, a
stdlib/typing name reached through the module for `unittest.mock.patch(...)`, a re-exported
constant — must stay reachable, per ground rule 2 ("don't change what's importable").
"""
from __future__ import annotations

import time as _stdlib_time
import unittest
from pathlib import Path as _stdlib_Path
from typing import Any as _stdlib_Any
from typing import BinaryIO as _stdlib_BinaryIO
from typing import Callable as _stdlib_Callable
from typing import Iterable as _stdlib_Iterable
from typing import Iterator as _stdlib_Iterator
from typing import NamedTuple as _stdlib_NamedTuple
from typing import Optional as _stdlib_Optional

import hashlib as _stdlib_hashlib
import json as _stdlib_json
import os as _stdlib_os

import orchestrator.ingest as ingest
import orchestrator.ingest_checkpoint as ingest_checkpoint
from orchestrator import cli, contract, record_batch, records, runtime, vocab
from orchestrator.ingest import checkpoint, discovery, ledger, parsers, reconcile, service
from orchestrator.ingest.parsers import _shared as parsers_shared
from orchestrator.ingest.parsers import humain_terminal

#: Every module-level name `orchestrator/ingest.py` bound just before the B3 split (see the
#: module docstring above for exactly how).
EXPECTED_INGEST_REEXPORTS: frozenset = frozenset({
    'Any', 'BatchAppendError', 'BinaryIO', 'CALL', 'CODEX', 'COUNT_FIELDS', 'Callable',
    'EventStore', 'GranularityConflict', 'HUMAIN_TERMINAL', 'IngestLedger', 'Iterable', 'Iterator',
    'LOG_GLOBS', 'MAX_BATCH_RECORDS', 'NamedTuple', 'Optional', 'PARSERS', 'Parser', 'Path',
    'READERS', 'SESSION', 'SourceConflict', 'TOKEN_FIELDS', '_PROBE_LIMIT', '_TEMP_MARKERS',
    '_base_metric', '_chunks', '_codex_state', '_codex_state_ok', '_conflict', '_empty_summary',
    '_group_key', '_humain_terminal_state', '_humain_terminal_state_ok', '_ingest_open_source',
    '_ingest_source', '_int', '_is_int', '_lines', '_observe', '_observed_from_json',
    '_observed_ids', '_observed_to_json', '_optional_str', '_paid_call_ids', '_parse_codex',
    '_parse_humain_terminal', '_reconcile_prefix', '_reconcile_source_calls',
    '_resolve_encoded_path', '_run', '_session_rows', '_tally', 'add_totals', 'build_record',
    'call_id_for', 'ckpt', 'default_state_root', 'detect_runtime', 'discover_logs',
    'empty_totals', 'ingest_file', 'ingest_paths', 'is_scratch_log', 'iter_jsonl_from', 'json',
    'log_repository', 'open_binary', 'read_calls', 'read_codex', 'read_humain_terminal',
    'settle_streams', 'stable_hash', 'tail_fingerprint', 'time', 'totals_equal', 'write_batch',
    'writer_lock',
})

#: name -> the object every one of the above (except the plain stdlib/typing singletons, covered
#: by `INGEST_STDLIB_IDENTITY`) must be identical to (its actual new home).
INGEST_NEW_HOME_IDENTITY: dict = {
    'BatchAppendError': record_batch.BatchAppendError,
    'MAX_BATCH_RECORDS': record_batch.MAX_BATCH_RECORDS,
    'build_record': record_batch.build_record,
    'settle_streams': record_batch.settle_streams,
    'write_batch': record_batch.write_batch,
    'CALL': records.CALL,
    'SESSION': records.SESSION,
    'EventStore': runtime.EventStore,
    'default_state_root': runtime.default_state_root,
    'iter_jsonl_from': runtime.iter_jsonl_from,
    'open_binary': runtime.open_binary,
    'stable_hash': runtime.stable_hash,
    'tail_fingerprint': runtime.tail_fingerprint,
    'writer_lock': runtime.writer_lock,
    'GranularityConflict': service.GranularityConflict,
    '_base_metric': service._base_metric,
    '_chunks': service._chunks,
    '_conflict': service._conflict,
    '_empty_summary': service._empty_summary,
    '_group_key': service._group_key,
    '_ingest_open_source': service._ingest_open_source,
    '_ingest_source': service._ingest_source,
    '_observe': service._observe,
    '_observed_from_json': service._observed_from_json,
    '_observed_ids': service._observed_ids,
    '_observed_to_json': service._observed_to_json,
    '_paid_call_ids': service._paid_call_ids,
    '_reconcile_prefix': service._reconcile_prefix,
    '_run': service._run,
    '_session_rows': service._session_rows,
    '_tally': service._tally,
    'ingest_file': service.ingest_file,
    'ingest_paths': service.ingest_paths,
    'HUMAIN_TERMINAL': parsers.HUMAIN_TERMINAL,
    'CODEX': parsers.CODEX,
    'PARSERS': parsers.PARSERS,
    'READERS': parsers.READERS,
    'Parser': parsers.Parser,
    'detect_runtime': parsers.detect_runtime,
    'read_calls': parsers.read_calls,
    'read_codex': parsers.read_codex,
    'read_humain_terminal': parsers.read_humain_terminal,
    '_codex_state': parsers._codex_state,
    '_codex_state_ok': parsers._codex_state_ok,
    '_humain_terminal_state': parsers._humain_terminal_state,
    '_humain_terminal_state_ok': parsers._humain_terminal_state_ok,
    '_parse_codex': parsers._parse_codex,
    '_parse_humain_terminal': parsers._parse_humain_terminal,
    '_lines': parsers._lines,
    'LOG_GLOBS': discovery.LOG_GLOBS,
    '_TEMP_MARKERS': discovery._TEMP_MARKERS,
    'discover_logs': discovery.discover_logs,
    'is_scratch_log': discovery.is_scratch_log,
    'SourceConflict': reconcile.SourceConflict,
    '_reconcile_source_calls': reconcile._reconcile_source_calls,
    'call_id_for': reconcile.call_id_for,
    '_PROBE_LIMIT': humain_terminal._PROBE_LIMIT,
    '_resolve_encoded_path': humain_terminal._resolve_encoded_path,
    'log_repository': humain_terminal.log_repository,
    '_int': parsers_shared._int,
    '_is_int': parsers_shared._is_int,
    '_optional_str': parsers_shared._optional_str,
    'COUNT_FIELDS': checkpoint.COUNT_FIELDS,
    'TOKEN_FIELDS': checkpoint.TOKEN_FIELDS,
    'add_totals': checkpoint.add_totals,
    'empty_totals': checkpoint.empty_totals,
    'totals_equal': checkpoint.totals_equal,
    'IngestLedger': ledger.IngestLedger,
    'ckpt': checkpoint,
}

#: name -> the stdlib/typing object it must be the exact same singleton as.
INGEST_STDLIB_IDENTITY: dict = {
    'Any': _stdlib_Any,
    'BinaryIO': _stdlib_BinaryIO,
    'Callable': _stdlib_Callable,
    'Iterable': _stdlib_Iterable,
    'Iterator': _stdlib_Iterator,
    'NamedTuple': _stdlib_NamedTuple,
    'Optional': _stdlib_Optional,
    'Path': _stdlib_Path,
    'json': _stdlib_json,
    'time': _stdlib_time,
}

#: Every module-level name `orchestrator/ingest_checkpoint.py` bound just before the B3 split.
EXPECTED_CHECKPOINT_REEXPORTS: frozenset = frozenset({
    'Any', 'BinaryIO', 'CALL', 'CHECKPOINT_DIR', 'COUNT_FIELDS', 'FORMAT_VERSION',
    'GRANULARITIES', 'INGEST_SOURCE', 'INGEST_TOKEN_FIELDS', 'IngestLedger', 'Iterable',
    'MAX_CHECKPOINT_BYTES', 'MAX_TAIL_BYTES', 'Optional', 'PROMOTION_EVENT', 'PROMOTION_VERSION',
    'Path', 'SESSION', 'STREAMS', 'TAIL_FINGERPRINT_BYTES', 'TOKEN_FIELDS', '_blank_state',
    '_int', '_is_int', '_state_from_json', '_state_to_json', '_valid_hash', '_valid_identity',
    '_valid_observed', '_valid_recorded', '_valid_stat', '_valid_totals', 'add_totals',
    'changed_while_reading', 'checkpoint_path', 'empty_totals', 'file_identity', 'hashlib',
    'head_fingerprint', 'iter_jsonl_from', 'json', 'load_checkpoint', 'open_binary', 'os',
    'prefix_fingerprint', 'promotion_record', 'read_json', 'save_checkpoint', 'source_key',
    'source_prefix_intact', 'source_signature', 'stable_hash', 'tail_fingerprint', 'totals_equal',
    'valid_session_provenance', 'verify_prefix', 'write_json',
})

CHECKPOINT_NEW_HOME_IDENTITY: dict = {
    'CHECKPOINT_DIR': checkpoint.CHECKPOINT_DIR,
    'COUNT_FIELDS': checkpoint.COUNT_FIELDS,
    'FORMAT_VERSION': checkpoint.FORMAT_VERSION,
    'GRANULARITIES': checkpoint.GRANULARITIES,
    'INGEST_SOURCE': checkpoint.INGEST_SOURCE,
    'MAX_CHECKPOINT_BYTES': checkpoint.MAX_CHECKPOINT_BYTES,
    'MAX_TAIL_BYTES': checkpoint.MAX_TAIL_BYTES,
    'PROMOTION_EVENT': checkpoint.PROMOTION_EVENT,
    'PROMOTION_VERSION': checkpoint.PROMOTION_VERSION,
    'TOKEN_FIELDS': checkpoint.TOKEN_FIELDS,
    '_blank_state': checkpoint._blank_state,
    '_int': checkpoint._int,
    '_is_int': checkpoint._is_int,
    '_state_from_json': checkpoint._state_from_json,
    '_state_to_json': checkpoint._state_to_json,
    '_valid_hash': checkpoint._valid_hash,
    '_valid_identity': checkpoint._valid_identity,
    '_valid_observed': checkpoint._valid_observed,
    '_valid_recorded': checkpoint._valid_recorded,
    '_valid_stat': checkpoint._valid_stat,
    '_valid_totals': checkpoint._valid_totals,
    'add_totals': checkpoint.add_totals,
    'changed_while_reading': checkpoint.changed_while_reading,
    'checkpoint_path': checkpoint.checkpoint_path,
    'empty_totals': checkpoint.empty_totals,
    'file_identity': checkpoint.file_identity,
    'head_fingerprint': checkpoint.head_fingerprint,
    'load_checkpoint': checkpoint.load_checkpoint,
    'prefix_fingerprint': checkpoint.prefix_fingerprint,
    'promotion_record': checkpoint.promotion_record,
    'save_checkpoint': checkpoint.save_checkpoint,
    'source_key': checkpoint.source_key,
    'source_prefix_intact': checkpoint.source_prefix_intact,
    'source_signature': checkpoint.source_signature,
    'totals_equal': checkpoint.totals_equal,
    'valid_session_provenance': checkpoint.valid_session_provenance,
    'verify_prefix': checkpoint.verify_prefix,
    'IngestLedger': ledger.IngestLedger,
    'CALL': vocab.CALL,
    'SESSION': vocab.SESSION,
    'INGEST_TOKEN_FIELDS': vocab.INGEST_TOKEN_FIELDS,
    'STREAMS': contract.STREAMS,
    'TAIL_FINGERPRINT_BYTES': runtime.TAIL_FINGERPRINT_BYTES,
    'stable_hash': runtime.stable_hash,
    'read_json': runtime.read_json,
    'write_json': runtime.write_json,
    'iter_jsonl_from': runtime.iter_jsonl_from,
    'open_binary': runtime.open_binary,
    'tail_fingerprint': runtime.tail_fingerprint,
}

CHECKPOINT_STDLIB_IDENTITY: dict = {
    'Any': _stdlib_Any,
    'BinaryIO': _stdlib_BinaryIO,
    'Iterable': _stdlib_Iterable,
    'Optional': _stdlib_Optional,
    'Path': _stdlib_Path,
    'hashlib': _stdlib_hashlib,
    'json': _stdlib_json,
    'os': _stdlib_os,
}


class IngestReexportTests(unittest.TestCase):
    def test_every_previously_importable_name_is_still_importable(self):
        for name in sorted(EXPECTED_INGEST_REEXPORTS):
            self.assertTrue(hasattr(ingest, name),
                             f'orchestrator.ingest no longer has {name!r}, previously importable '
                             f'from it (see docs/architecture-review.md B3)')

    def test_every_expected_reexport_is_covered_by_exactly_one_identity_map(self):
        self.assertEqual(set(INGEST_NEW_HOME_IDENTITY) | set(INGEST_STDLIB_IDENTITY),
                          EXPECTED_INGEST_REEXPORTS)

    def test_moved_names_are_identical_to_their_new_home(self):
        for name, expected in INGEST_NEW_HOME_IDENTITY.items():
            self.assertIs(getattr(ingest, name), expected,
                           f'orchestrator.ingest.{name} is not the same object as its new home')

    def test_stdlib_reexports_are_the_same_singleton(self):
        for name, expected in INGEST_STDLIB_IDENTITY.items():
            self.assertIs(getattr(ingest, name), expected,
                           f'orchestrator.ingest.{name} is not the same object callers used to get')


class IngestCheckpointReexportTests(unittest.TestCase):
    def test_every_previously_importable_name_is_still_importable(self):
        for name in sorted(EXPECTED_CHECKPOINT_REEXPORTS):
            self.assertTrue(hasattr(ingest_checkpoint, name),
                             f'orchestrator.ingest_checkpoint no longer has {name!r}, previously '
                             f'importable from it (see docs/architecture-review.md B3)')

    def test_every_expected_reexport_is_covered_by_exactly_one_identity_map(self):
        self.assertEqual(set(CHECKPOINT_NEW_HOME_IDENTITY) | set(CHECKPOINT_STDLIB_IDENTITY),
                          EXPECTED_CHECKPOINT_REEXPORTS)

    def test_moved_names_are_identical_to_their_new_home(self):
        for name, expected in CHECKPOINT_NEW_HOME_IDENTITY.items():
            self.assertIs(getattr(ingest_checkpoint, name), expected,
                           f'orchestrator.ingest_checkpoint.{name} is not the same object as its new home')

    def test_stdlib_reexports_are_the_same_singleton(self):
        for name, expected in CHECKPOINT_STDLIB_IDENTITY.items():
            self.assertIs(getattr(ingest_checkpoint, name), expected,
                           f'orchestrator.ingest_checkpoint.{name} is not the same object callers used to get')


class CliIngestNameReexportTests(unittest.TestCase):
    """`make_ingest_status`/`process_ingest` moved from `cli.py` to `ingest.service` (B3); both
    names must stay importable from `cli` under their old signatures/behaviour (ground rule 2).
    """

    def test_make_ingest_status_is_importable_and_identical_to_its_new_home(self):
        self.assertTrue(hasattr(cli, 'make_ingest_status'))
        self.assertIs(cli.make_ingest_status, service.make_ingest_status)

    def test_process_ingest_is_importable_from_cli(self):
        self.assertTrue(hasattr(cli, 'process_ingest'))
        # `cli.process_ingest` is a thin wrapper (it injects `cli.refresh`, which
        # `ingest.service.process_ingest` cannot import directly per the B2 layer order), so it is
        # not the identical object -- but it must still be a distinct, callable name on `cli`.
        self.assertTrue(callable(cli.process_ingest))
        self.assertIsNot(cli.process_ingest, service.process_ingest)

    def test_ingest_error_limit_is_importable_from_cli(self):
        # tests/test_final_integration.py imports this from `orchestrator.cli`.
        self.assertTrue(hasattr(cli, 'INGEST_ERROR_LIMIT'))
        self.assertEqual(cli.INGEST_ERROR_LIMIT, service.INGEST_ERROR_LIMIT)


if __name__ == '__main__':
    unittest.main()

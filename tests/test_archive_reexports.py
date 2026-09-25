"""B3 review requirement (`docs/architecture-review.md`): `orchestrator.archive` must keep
re-exporting every name that was importable from it before the B3 split (ground rule 2: "don't
change what's importable").

The expected-name set below is the literal set of every module-level name (`ast`-derived:
`def`/`class` statements, plain assignments/annotated assignments, and every name bound by an
`import`/`from ... import` statement, excluding the `from __future__ import annotations` binding)
in `orchestrator/archive.py` at the pre-split commit (the tip of `refactor/modular` immediately
before this split). Anything previously reachable as `orchestrator.archive.<name>` — a private
helper, a stdlib name reached through the module for `unittest.mock.patch.object(archive, ...)`,
a re-exported constant — must stay reachable.

`patch.object(archive, '_compress_to_temp', ...)`-style mock targets are a separate concern from
"importable" (ground rule 2 covers the latter, not "patchable at the exact same dotted path"):
after the split, the code that looks `_compress_to_temp` etc. up at call time lives in one
particular submodule (`archive.execute`, `archive.restore`, ...), so tests that need to intercept
that call must patch `archive.execute._compress_to_temp` etc, not `archive._compress_to_temp`.
See `tests/test_archive.py`, `tests/test_archive_sealed.py` and `tests/test_archive_security.py`
for the updated patch targets, and the `archive/__init__.py` module docstring.
"""
from __future__ import annotations

import gzip as _stdlib_gzip
import hashlib as _stdlib_hashlib
import json as _stdlib_json
import math as _stdlib_math
import os as _stdlib_os
import re as _stdlib_re
import shutil as _stdlib_shutil
import stat as _stdlib_stat
import tempfile as _stdlib_tempfile
import unittest
import zlib as _stdlib_zlib
from datetime import datetime as _stdlib_datetime
from datetime import timezone as _stdlib_timezone
from pathlib import Path as _stdlib_Path
from typing import Any as _stdlib_Any
from typing import Iterator as _stdlib_Iterator
from typing import Optional as _stdlib_Optional

import orchestrator.archive as archive
from orchestrator import contract, runtime, vocab
from orchestrator.archive import codec, execute, manifest, plan, restore, seal

#: Every module-level name `orchestrator/archive.py` bound just before the B3 split (see the
#: module docstring above for exactly how).
EXPECTED_ARCHIVE_REEXPORTS: frozenset = frozenset({
    'Any', 'Iterator', 'Optional', 'Path',
    'gzip', 'hashlib', 'json', 'math', 'os', 're', 'shutil', 'stat', 'tempfile', 'zlib',
    'datetime', 'timezone',
    'exclusive_file_lock', 'fsync_directory', 'iter_jsonl', 'utc_now',
    'NEVER_ARCHIVE_FILES', 'STREAMS', 'TERMINAL_TASK_IDS',
    'FORMAT_VERSION', 'OWNER_FILE', 'SEAL_FILE', 'SEAL_PROTOCOL', 'RUNS_DIR', 'MANIFEST_FILE',
    'ARCHIVE_LOCK_FILE', 'ARCHIVE_SUFFIX', 'DEFAULT_OLDER_THAN_DAYS', 'NEVER_ARCHIVE',
    'KEEP_READABLE', 'RESTORE_COMMAND', 'CHUNK', 'SAMPLE_BYTES', 'COMPRESS_LEVEL',
    'FREE_SPACE_MARGIN', 'EMPTY_GZIP_BYTES',
    'parse_ts', 'terminal_outcomes', 'validate_run_id', '_validate_days',
    '_private_temp', '_open_regular', '_digest_file', '_decompressed_digest',
    '_compress_to_temp', '_decompress_to_temp', '_unlink_quietly', 'estimate_compressed_bytes',
    '_validate_directory', '_validate_file', '_validate_name', '_unique_object',
    'load_manifest', '_write_manifest', 'load_seal', '_stat_key',
    '_run_dirs', '_candidate_files', '_skip', 'plan_run', 'plan_archive',
    '_archive_file', '_commit_archive_file', '_run_storage_bytes', '_execute_run',
    'archive_lock', 'archive_runs',
    '_restore_file', 'restore_run', 'locate_run_file', 'locate_path',
})

#: name -> the object every one of the above (except the plain stdlib/typing singletons, covered
#: by `ARCHIVE_STDLIB_IDENTITY`) must be identical to (its actual new home).
ARCHIVE_NEW_HOME_IDENTITY: dict = {
    'exclusive_file_lock': runtime.exclusive_file_lock,
    'fsync_directory': runtime.fsync_directory,
    'iter_jsonl': runtime.iter_jsonl,
    'utc_now': runtime.utc_now,
    'NEVER_ARCHIVE_FILES': contract.NEVER_ARCHIVE_FILES,
    'STREAMS': contract.STREAMS,
    'TERMINAL_TASK_IDS': vocab.TERMINAL_TASK_IDS,

    'CHUNK': codec.CHUNK,
    'SAMPLE_BYTES': codec.SAMPLE_BYTES,
    'COMPRESS_LEVEL': codec.COMPRESS_LEVEL,
    'EMPTY_GZIP_BYTES': codec.EMPTY_GZIP_BYTES,
    '_private_temp': codec._private_temp,
    '_open_regular': codec._open_regular,
    '_digest_file': codec._digest_file,
    '_decompressed_digest': codec._decompressed_digest,
    '_compress_to_temp': codec._compress_to_temp,
    '_decompress_to_temp': codec._decompress_to_temp,
    '_unlink_quietly': codec._unlink_quietly,
    'estimate_compressed_bytes': codec.estimate_compressed_bytes,

    'FORMAT_VERSION': manifest.FORMAT_VERSION,
    'RUNS_DIR': manifest.RUNS_DIR,
    'MANIFEST_FILE': manifest.MANIFEST_FILE,
    'ARCHIVE_SUFFIX': manifest.ARCHIVE_SUFFIX,
    'NEVER_ARCHIVE': manifest.NEVER_ARCHIVE,
    'KEEP_READABLE': manifest.KEEP_READABLE,
    'RESTORE_COMMAND': manifest.RESTORE_COMMAND,
    'parse_ts': manifest.parse_ts,
    'validate_run_id': manifest.validate_run_id,
    '_validate_days': manifest._validate_days,
    '_validate_directory': manifest._validate_directory,
    '_validate_file': manifest._validate_file,
    '_validate_name': manifest._validate_name,
    '_unique_object': manifest._unique_object,
    'load_manifest': manifest.load_manifest,
    '_write_manifest': manifest._write_manifest,
    '_stat_key': manifest._stat_key,

    'OWNER_FILE': seal.OWNER_FILE,
    'SEAL_FILE': seal.SEAL_FILE,
    'SEAL_PROTOCOL': seal.SEAL_PROTOCOL,
    'load_seal': seal.load_seal,

    'DEFAULT_OLDER_THAN_DAYS': plan.DEFAULT_OLDER_THAN_DAYS,
    'terminal_outcomes': plan.terminal_outcomes,
    '_run_dirs': plan._run_dirs,
    '_candidate_files': plan._candidate_files,
    '_skip': plan._skip,
    'plan_run': plan.plan_run,
    'plan_archive': plan.plan_archive,

    'ARCHIVE_LOCK_FILE': execute.ARCHIVE_LOCK_FILE,
    'FREE_SPACE_MARGIN': execute.FREE_SPACE_MARGIN,
    '_archive_file': execute._archive_file,
    '_commit_archive_file': execute._commit_archive_file,
    '_run_storage_bytes': execute._run_storage_bytes,
    '_execute_run': execute._execute_run,
    'archive_lock': execute.archive_lock,
    'archive_runs': execute.archive_runs,

    '_restore_file': restore._restore_file,
    'restore_run': restore.restore_run,
    'locate_run_file': restore.locate_run_file,
    'locate_path': restore.locate_path,
}

#: name -> the stdlib/typing object it must be the exact same singleton as.
ARCHIVE_STDLIB_IDENTITY: dict = {
    'Any': _stdlib_Any,
    'Iterator': _stdlib_Iterator,
    'Optional': _stdlib_Optional,
    'Path': _stdlib_Path,
    'gzip': _stdlib_gzip,
    'hashlib': _stdlib_hashlib,
    'json': _stdlib_json,
    'math': _stdlib_math,
    'os': _stdlib_os,
    're': _stdlib_re,
    'shutil': _stdlib_shutil,
    'stat': _stdlib_stat,
    'tempfile': _stdlib_tempfile,
    'zlib': _stdlib_zlib,
    'datetime': _stdlib_datetime,
    'timezone': _stdlib_timezone,
}


class ArchiveReexportTests(unittest.TestCase):
    def test_every_previously_importable_name_is_still_importable(self):
        for name in sorted(EXPECTED_ARCHIVE_REEXPORTS):
            self.assertTrue(hasattr(archive, name),
                             f'orchestrator.archive no longer has {name!r}, previously importable '
                             f'from it (see docs/architecture-review.md B3)')

    def test_every_expected_reexport_is_covered_by_exactly_one_identity_map(self):
        self.assertEqual(set(ARCHIVE_NEW_HOME_IDENTITY) | set(ARCHIVE_STDLIB_IDENTITY),
                          EXPECTED_ARCHIVE_REEXPORTS)

    def test_moved_names_are_identical_to_their_new_home(self):
        for name, expected in ARCHIVE_NEW_HOME_IDENTITY.items():
            self.assertIs(getattr(archive, name), expected,
                           f'orchestrator.archive.{name} is not the same object as its new home')

    def test_stdlib_reexports_are_the_same_singleton(self):
        for name, expected in ARCHIVE_STDLIB_IDENTITY.items():
            self.assertIs(getattr(archive, name), expected,
                           f'orchestrator.archive.{name} is not the same object callers used to get')

    def test_submodules_are_reachable_for_patch_object_targets(self):
        # `patch.object(archive.execute, '_compress_to_temp', ...)`-style targets rely on these
        # attribute names being the actual submodules, not re-exported copies.
        for name, module in (('codec', codec), ('manifest', manifest), ('seal', seal),
                              ('plan', plan), ('execute', execute), ('restore', restore)):
            self.assertIs(getattr(archive, name), module)


class CliArchiveSummaryReexportTests(unittest.TestCase):
    """`summarize_archive_results` moved from `cli._archive_runs_command` to
    `orchestrator.archive.execute` (B3); `cli.py` calls it explicitly rather than re-implementing
    the aggregation inline.
    """

    def test_summarize_archive_results_is_importable_from_the_archive_package(self):
        self.assertTrue(hasattr(archive, 'summarize_archive_results'))
        self.assertIs(archive.summarize_archive_results, execute.summarize_archive_results)

    def test_cli_uses_the_moved_summary_function(self):
        from orchestrator import cli
        self.assertIs(cli.summarize_archive_results, execute.summarize_archive_results)


if __name__ == '__main__':
    unittest.main()

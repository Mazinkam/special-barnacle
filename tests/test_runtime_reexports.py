"""B2 review finding (BLOCKING): `orchestrator.runtime` must keep re-exporting every name that
was importable from it before the B2.2/B2.3 split, not just the "main" public API.

The list below is the literal union of every module-level name (`ast`-derived: `def`/`class`
statements, plain assignments/annotated assignments including ones made inside a top-level `if`
block like `_handler`, and every name bound by an `import`/`from ... import` statement) in
`orchestrator/runtime.py` at:
  - 1a1e439 (pre-split, the original monolithic module), and
  - 568b7eb (mid-split, after `contract.py`'s `DEFAULT_STATE_ROOT`/`STATE_ROOT_ENV_VAR`/`STREAMS`
    were threaded through but before `core`/`records.metering`/`store.facade` existed).

Anything previously reachable as `orchestrator.runtime.<name>` (a private helper, a stdlib module
object reached through this name for `unittest.mock.patch(...)`, a dataclass field default
factory helper) must stay reachable, per ground rule 2 ("don't change what's importable").

`_handler` is conditional even in the pre-split module: `core.fs` (like the monolithic module
before it) only binds `_handler` when the `orchestrator` logger had no handlers yet at import
time (`if not _LOGGER.handlers: ... _handler = ...`). `orchestrator.runtime` mirrors that with
`if hasattr(core.fs, '_handler'): _handler = core.fs._handler` instead of importing it
unconditionally, so `import orchestrator.runtime` cannot raise `ImportError` merely because
something already attached a handler to the `orchestrator` logger before `core.fs` ran (see
`RuntimeHandlerReexportSubprocessTests` below for the regression this guards against). The
checks below therefore skip `_handler` whenever this process's `core.fs` did not define it,
instead of asserting it unconditionally.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
import fcntl as _stdlib_fcntl
import hashlib as _stdlib_hashlib
import json as _stdlib_json
import logging as _stdlib_logging
import os as _stdlib_os
import secrets as _stdlib_secrets
import sys as _stdlib_sys
import unittest
from contextlib import contextmanager as _stdlib_contextmanager
from dataclasses import asdict as _stdlib_asdict
from dataclasses import dataclass as _stdlib_dataclass
from dataclasses import field as _stdlib_field
from datetime import datetime as _stdlib_datetime
from datetime import timezone as _stdlib_timezone
from pathlib import Path as _stdlib_Path
from typing import Any as _stdlib_Any
from typing import Iterable as _stdlib_Iterable
from typing import Iterator as _stdlib_Iterator
from typing import Optional as _stdlib_Optional

import orchestrator.runtime as runtime
from orchestrator import contract
from orchestrator.core import env as core_env
from orchestrator.core import fs as core_fs
from orchestrator.core import jsonl as core_jsonl
from orchestrator.records import metering
from orchestrator.store import facade

#: Every module-level name `orchestrator/runtime.py` bound at 1a1e439 (pre-split) or 568b7eb
#: (mid-split). Generated once by parsing each revision's source with `ast` and taking the union
#: of `def`/`class` names, assignment targets (including inside the top-level `if` guarding
#: `_handler`), and every name an `import`/`from ... import` statement bound. See the module
#: docstring above for exactly how (and why both revisions, not just one).
EXPECTED_REEXPORTS: frozenset[str] = frozenset({
    'Any', 'DEFAULT_STATE_ROOT', 'EventStore', 'Iterable', 'Iterator', 'Optional', 'Path',
    'Policy', 'QualityEvidence', 'RECORD_INDEX_FILE', 'STATE_ROOT_ENV_VAR', 'STREAMS',
    'TAIL_FINGERPRINT_BYTES', 'WRITER_LOCK_FILE', '_LOGGER', '_create_exclusive_tmp', '_handler',
    'append_jsonl', 'asdict', 'contextmanager', 'dataclass', 'datetime', 'default_attribution',
    'default_state_root', 'encode_jsonl', 'exclusive_file_lock', 'fcntl', 'field',
    'fsync_directory', 'fsync_directory_ancestry', 'hashlib', 'iter_jsonl', 'iter_jsonl_from',
    'json', 'load_jsonl', 'logging', 'meter', 'open_binary', 'os', 'read_json', 'secrets',
    'stable_hash', 'sys', 'tail_fingerprint', 'timezone', 'utc_now', 'write_json',
    'write_text_atomic', 'writer_lock',
})

#: name -> the object every one of the above must be identical to (its actual new home), for
#: names whose "new home" is a specific function/class/constant rather than a stdlib singleton
#: module (those are covered by `STDLIB_IDENTITY` below instead).
NEW_HOME_IDENTITY: dict[str, object] = {
    'default_attribution': core_env.default_attribution,
    'default_state_root': core_env.default_state_root,
    'stable_hash': core_env.stable_hash,
    'utc_now': core_env.utc_now,
    'RECORD_INDEX_FILE': core_fs.RECORD_INDEX_FILE,
    'WRITER_LOCK_FILE': core_fs.WRITER_LOCK_FILE,
    'exclusive_file_lock': core_fs.exclusive_file_lock,
    'fsync_directory': core_fs.fsync_directory,
    'fsync_directory_ancestry': core_fs.fsync_directory_ancestry,
    'read_json': core_fs.read_json,
    'write_json': core_fs.write_json,
    'write_text_atomic': core_fs.write_text_atomic,
    'writer_lock': core_fs.writer_lock,
    '_LOGGER': core_fs._LOGGER,
    '_create_exclusive_tmp': core_fs._create_exclusive_tmp,
    '_handler': core_fs._handler,
    'TAIL_FINGERPRINT_BYTES': core_jsonl.TAIL_FINGERPRINT_BYTES,
    'append_jsonl': core_jsonl.append_jsonl,
    'encode_jsonl': core_jsonl.encode_jsonl,
    'iter_jsonl': core_jsonl.iter_jsonl,
    'iter_jsonl_from': core_jsonl.iter_jsonl_from,
    'load_jsonl': core_jsonl.load_jsonl,
    'open_binary': core_jsonl.open_binary,
    'tail_fingerprint': core_jsonl.tail_fingerprint,
    'Policy': metering.Policy,
    'QualityEvidence': metering.QualityEvidence,
    'meter': metering.meter,
    'EventStore': facade.EventStore,
    'DEFAULT_STATE_ROOT': contract.DEFAULT_STATE_ROOT,
    'STATE_ROOT_ENV_VAR': contract.STATE_ROOT_ENV_VAR,
    'STREAMS': contract.STREAMS,
}

#: name -> the stdlib/typing/dataclasses/contextlib/datetime/pathlib object it must be the exact
#: same singleton as (module objects, or `typing`/`dataclasses` helpers, which are themselves
#: ordinary module-level objects re-imported under the same name).
STDLIB_IDENTITY: dict[str, object] = {
    'fcntl': _stdlib_fcntl,
    'hashlib': _stdlib_hashlib,
    'json': _stdlib_json,
    'logging': _stdlib_logging,
    'os': _stdlib_os,
    'secrets': _stdlib_secrets,
    'sys': _stdlib_sys,
    'contextmanager': _stdlib_contextmanager,
    'asdict': _stdlib_asdict,
    'dataclass': _stdlib_dataclass,
    'field': _stdlib_field,
    'datetime': _stdlib_datetime,
    'timezone': _stdlib_timezone,
    'Path': _stdlib_Path,
    'Any': _stdlib_Any,
    'Iterable': _stdlib_Iterable,
    'Iterator': _stdlib_Iterator,
    'Optional': _stdlib_Optional,
}


class RuntimeReexportTests(unittest.TestCase):
    def test_every_previously_importable_name_is_still_importable(self):
        for name in sorted(EXPECTED_REEXPORTS):
            if name == '_handler' and not hasattr(core_fs, '_handler'):
                continue  # core.fs did not define it this run (logger already had a handler)
            self.assertTrue(hasattr(runtime, name),
                             f'orchestrator.runtime no longer has {name!r}, previously importable '
                             f'from it (see docs/architecture-review.md B2.2/B2.3)')

    def test_moved_names_are_identical_to_their_new_home(self):
        self.assertEqual(set(NEW_HOME_IDENTITY) | set(STDLIB_IDENTITY), EXPECTED_REEXPORTS,
                          'every expected re-export must be covered by exactly one identity map above')
        for name, expected in NEW_HOME_IDENTITY.items():
            if name == '_handler' and not hasattr(core_fs, '_handler'):
                continue  # core.fs did not define it this run (logger already had a handler)
            self.assertIs(getattr(runtime, name), expected,
                           f'orchestrator.runtime.{name} is not the same object as its new home')

    def test_stdlib_reexports_are_the_same_singleton(self):
        for name, expected in STDLIB_IDENTITY.items():
            self.assertIs(getattr(runtime, name), expected,
                           f'orchestrator.runtime.{name} is not the same object callers used to get '
                           f'(needed e.g. for patch("orchestrator.runtime.fcntl.flock", ...))')

    def test_handler_is_absent_when_core_fs_did_not_define_it(self):
        """`_handler` must never be unconditionally imported: if `core.fs` did not bind it (this
        process's `orchestrator` logger already had a handler when `core.fs` ran), `runtime` must
        not claim to re-export it either, rather than raising `ImportError` at import time (the
        BLOCKING finding this module now guards against) or fabricating a value.
        """
        if hasattr(core_fs, '_handler'):
            self.skipTest("this process's core.fs defined _handler; nothing to assert about its absence")
        self.assertFalse(hasattr(runtime, '_handler'))


class RuntimeHandlerReexportSubprocessTests(unittest.TestCase):
    """Regression test for the BLOCKING finding: `orchestrator.runtime` used to do
    `from .core.fs import _handler` unconditionally, which raised `ImportError` whenever the
    `orchestrator` logger already had a handler before `core.fs` ran — e.g. a host application
    (or a previous import of `orchestrator.core.fs` under a different alias) installing its own
    handler on `logging.getLogger('orchestrator')` before ever importing `orchestrator.runtime`.
    A fresh subprocess is required because within one process `core.fs` (and therefore its
    `_handler` decision) is only ever evaluated once, on its first import.
    """
    def test_import_succeeds_when_orchestrator_logger_already_has_a_handler(self):
        script = textwrap.dedent("""\
            import logging
            logging.getLogger('orchestrator').addHandler(logging.NullHandler())
            import orchestrator.runtime  # must not raise ImportError
            assert not hasattr(orchestrator.runtime, '_handler'), (
                'core.fs did not define _handler (logger already had a handler); '
                'runtime must not re-export it either'
            )
            print('ok')
            """)
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0,
                          f'import orchestrator.runtime failed with a pre-installed orchestrator '
                          f'logger handler:\nstdout={result.stdout!r}\nstderr={result.stderr!r}')
        self.assertEqual(result.stdout.strip(), 'ok')


if __name__ == '__main__':
    unittest.main()

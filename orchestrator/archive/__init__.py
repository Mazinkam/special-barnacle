"""Opt-in reversible diagnostics archival under `<root>/runs/<run_id>/`.

Eligibility requires a durable terminal outcome and old completion/file timestamps. Active,
recent and ambiguous runs are skipped. Authoritative streams/metadata and run.log stay intact.
A fresh HT RunDiagnostics owner drains all producer leases (including child stdio close),
fsyncs its files and publishes an immutable SHA-256 inventory seal after terminal acknowledgement.
Only inventory-matching files of that sealed owner may be removed. Legacy uncoordinated directories
remain snapshot-only; managed unsealed runs are skipped. Final stat checks alone never establish
ownership of open descriptors.

Under archive.lock, each file is compressed to a private temporary gzip, fsynced and verified,
then linked without clobbering an existing archive. Matching orphan archives can be adopted only
by verifying full decompressed bytes against raw. Commit manifest progress per file before raw
unlink; valid metadata can only be extended, with durable prior generations retained. Failures
leave raw and recovery files available for incremental retry. Unknown temporary files are untouched.
Restore verifies and publishes absent raw names without clobber; archives/manifests remain intact.
No background timer or automatic deletion exists. Accounting reports raw removed, gzip size,
and net logical storage change including recovery metadata (not filesystem allocated blocks).

Manifest v1: {format_version, run_id, terminal_outcome, files: {name: {archive, sha256,
raw_bytes, compressed_bytes, mtime_ns, archived_at}}}. Owner/seal v1 use protocol
`ht-run-diagnostics-v1`, run_id and owner_id; seal adds sealed_at and files:{name:{sha256,raw_bytes}}.

This used to be one 659-line module (B3, `docs/architecture-review.md`); it is now a package:

* `codec.py` — hashing/compression primitives (`_compress_to_temp`, `_decompress_to_temp`,
  `_digest_file`, `_decompressed_digest`, `estimate_compressed_bytes`, ...).
* `manifest.py` — the manifest codec (`load_manifest`/`_write_manifest`), path/name validation,
  and the timestamp/run-id/day helpers other submodules share (`parse_ts`, `validate_run_id`, ...).
* `seal.py` — HT owner/seal metadata (`load_seal`).
* `plan.py` — read-only selection of archivable runs (`plan_run`, `plan_archive`,
  `terminal_outcomes`).
* `execute.py` — archiving under `archive.lock` (`archive_runs`, `_execute_run`, `_archive_file`).
* `restore.py` — restoring archived files and locating a run diagnostic (`restore_run`,
  `locate_run_file`, `locate_path`).

Every name that used to be importable from `orchestrator.archive` (public API, private helpers,
and the stdlib names it imported for its own use, including `unittest.mock.patch.object(archive,
...)` targets) stays importable from here — see `tests/test_archive_reexports.py`. Some of those
mock targets now need to name the submodule where the code actually looks the name up at call time
(ground rule 2 covers "importable", not "patchable at the same dotted path" — see
`tests/test_archive.py`, `tests/test_archive_sealed.py` and `tests/test_archive_security.py` for
the updated `patch.object(archive.execute, ...)`/`patch.object(archive.restore, ...)` targets).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from ..runtime import exclusive_file_lock, fsync_directory, iter_jsonl, utc_now
from ..contract import NEVER_ARCHIVE_FILES, STREAMS
from ..vocab import TERMINAL_TASK_IDS

from . import codec as _codec
from . import execute as _execute
from . import manifest as _manifest
from . import plan as _plan
from . import restore as _restore
from . import seal as _seal
from .codec import (
    CHUNK,
    COMPRESS_LEVEL,
    EMPTY_GZIP_BYTES,
    SAMPLE_BYTES,
    _compress_to_temp,
    _decompress_to_temp,
    _decompressed_digest,
    _digest_file,
    _open_regular,
    _private_temp,
    _unlink_quietly,
    estimate_compressed_bytes,
)
from .execute import (
    ARCHIVE_LOCK_FILE,
    FREE_SPACE_MARGIN,
    _archive_file,
    _commit_archive_file,
    _execute_run,
    _run_storage_bytes,
    archive_lock,
    archive_runs,
)
from .manifest import (
    ARCHIVE_SUFFIX,
    FORMAT_VERSION,
    KEEP_READABLE,
    MANIFEST_FILE,
    NEVER_ARCHIVE,
    RESTORE_COMMAND,
    RUNS_DIR,
    _stat_key,
    _unique_object,
    _validate_days,
    _validate_directory,
    _validate_file,
    _validate_name,
    _write_manifest,
    load_manifest,
    parse_ts,
    validate_run_id,
)
from .plan import (
    DEFAULT_OLDER_THAN_DAYS,
    _candidate_files,
    _run_dirs,
    _skip,
    plan_archive,
    plan_run,
    terminal_outcomes,
)
from .restore import (
    _restore_file,
    locate_path,
    locate_run_file,
    restore_run,
)
from .seal import OWNER_FILE, SEAL_FILE, SEAL_PROTOCOL, load_seal

#: Submodule handles for `patch.object(archive.execute, '_compress_to_temp', ...)`-style targets
#: (`archive.<name>` used to be enough; each function now lives in exactly one submodule, so the
#: mock target has to name it — see the module docstring above and `tests/test_archive.py`).
codec = _codec
execute = _execute
manifest = _manifest
plan = _plan
restore = _restore
seal = _seal

__all__ = [
    # constants
    'FORMAT_VERSION', 'OWNER_FILE', 'SEAL_FILE', 'SEAL_PROTOCOL', 'RUNS_DIR', 'MANIFEST_FILE',
    'ARCHIVE_LOCK_FILE', 'ARCHIVE_SUFFIX', 'DEFAULT_OLDER_THAN_DAYS', 'NEVER_ARCHIVE',
    'KEEP_READABLE', 'RESTORE_COMMAND', 'CHUNK', 'SAMPLE_BYTES', 'COMPRESS_LEVEL',
    'FREE_SPACE_MARGIN', 'EMPTY_GZIP_BYTES',
    # terminal outcomes / age
    'parse_ts', 'terminal_outcomes', 'validate_run_id',
    # compression primitives
    'estimate_compressed_bytes',
    # manifest / seal
    'load_manifest', 'load_seal',
    # planning
    'plan_run', 'plan_archive',
    # execution
    'archive_lock', 'archive_runs',
    # restore / lookup
    'restore_run', 'locate_run_file', 'locate_path',
    # submodules (for patch targets)
    'codec', 'manifest', 'seal', 'plan', 'execute', 'restore',
]

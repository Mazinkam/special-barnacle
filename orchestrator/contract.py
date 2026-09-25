"""Loader for the shared Python <-> TS on-disk/CLI contract (`contract.json`).

`contract.json` holds values that must byte-for-byte match the bridge's copy in
`bridge/extensions/orchestrator/contract.json` (a symlink to this same file — see
its own `description` field for what belongs here and what doesn't). This module
is the only place that reads the file; every other module imports the constants
below instead of re-parsing JSON or re-typing a literal.

Loading at import of this small module (rather than lazily) is acceptable: the
file ships as package data (`pyproject.toml` `[tool.setuptools.package-data]`)
and is required for the package to do anything useful, so there is no ordering
hazard to defer.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_CONTRACT_PATH = Path(__file__).with_name('contract.json')
_CONTRACT: dict[str, Any] = json.loads(_CONTRACT_PATH.read_text(encoding='utf-8'))

#: Stream name -> JSONL file name (`record_index.STREAMS`, and former copies in
#: runtime.py/archive.py/dashboard.py/history.py/outcomes.py/ingest_checkpoint.py).
STREAMS: dict[str, str] = dict(_CONTRACT['streams'])

#: Receipt file for the last ingest attempt (`cli.py`, `dashboard.py`, `archive.py`).
INGEST_STATUS_FILE: str = _CONTRACT['ingest_status_file']

#: File names archive.py must never touch, regardless of age (`archive.NEVER_ARCHIVE`)
#: and the matching protected-name set in `run-diagnostics.ts`.
NEVER_ARCHIVE_FILES: frozenset[str] = frozenset(_CONTRACT['never_archive_files'])

_batch = _CONTRACT['batch']
#: Batch-write limits and the durable-write CLI's exit codes / body statuses
#: (`cli.py`, `record_batch.py`, and the TS mirrors in `record-queue.ts`).
MAX_BATCH_RECORDS: int = int(_batch['max_records'])
MAX_RECORD_ID_LENGTH: int = int(_batch['max_record_id_length'])
EXIT_OK: int = int(_batch['exit_codes']['ok'])
EXIT_INVALID: int = int(_batch['exit_codes']['invalid'])
EXIT_APPEND_FAILED: int = int(_batch['exit_codes']['append_failed'])
EXIT_REFRESH_FAILED: int = int(_batch['exit_codes']['refresh_failed'])
STATUS_OK: str = _batch['statuses']['ok']
STATUS_INVALID: str = _batch['statuses']['invalid']
STATUS_APPEND_FAILED: str = _batch['statuses']['append_failed']
STATUS_REFRESH_FAILED: str = _batch['statuses']['refresh_failed']
STATUS_CHECKPOINT_FAILED: str = _batch['statuses']['checkpoint_failed']
RETRY_SAME_IDS: str = _batch['retry_same_ids']

#: Path-redaction regex, Python side only (`cli.py`). The TS side's regex differs
#: on purpose — see `contract.json`'s `redaction_regex._todo` — so this module
#: does not expose the `ts` variant.
PATH_REDACTION_RE: re.Pattern[str] = re.compile(_CONTRACT['redaction_regex']['python'])

_state_root = _CONTRACT['state_root']
#: Env var Python reads for the state root (`runtime.default_state_root`).
STATE_ROOT_ENV_VAR: str = _state_root['env_vars']['python']
#: Env var name the TS bridge reads for its own state-root config, kept here so
#: Python-side tests can assert both sides agree without duplicating the string.
TS_STATE_ROOT_ENV_VAR: str = _state_root['env_vars']['ts']
#: Default state root when no env var is set, expanded by callers with `~`.
DEFAULT_STATE_ROOT: str = _state_root['default']

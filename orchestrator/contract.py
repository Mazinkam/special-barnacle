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

#: B4.7: single source for the lead-count ceiling. `scheduler.topology_for` never requests
#: more leads than this; the TS bridge's `config.ts` `maxLeads` default is this same value
#: (see `contract.json`'s `max_leads_note` for why 4, not the TS side's old default of 8).
MAX_LEADS: int = int(_CONTRACT['max_leads'])

_ingest_status = _CONTRACT['ingest_status']
#: B4.7: `ingest_status.json`'s field names, shared by `ingest.service.make_ingest_status`
#: and the TS bridge's `hooks/ingest.ts` `recordHookFailure` (see `contract.json`'s
#: `ingest_status._note` for why the two keep separate write logic on purpose).
INGEST_STATUS_FIELDS: frozenset[str] = frozenset(_ingest_status['fields'])
#: `status` field's literal values, keyed by meaning (`ok`/`partial`/`error`).
INGEST_STATUS_VALUES: dict[str, str] = dict(_ingest_status['status_values'])
#: Fallback `sweep_interval_seconds` when neither an env override nor a previous status exists.
DEFAULT_SWEEP_INTERVAL_SECONDS: int = int(_ingest_status['default_sweep_interval_seconds'])

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
_state_root_env = _state_root['env_vars']
#: Canonical env var both runtimes prefer for the state root (`core.env.default_state_root`,
#: the TS bridge's `config.ts`). Resolution order on both sides: this name if set and
#: non-empty, then each of `STATE_ROOT_ENV_ALIASES` in order, then `DEFAULT_STATE_ROOT`.
STATE_ROOT_ENV_VAR: str = _state_root_env['canonical']
#: Deprecated fallback alias(es), tried only if `STATE_ROOT_ENV_VAR` is unset/empty. Kept here
#: so both runtimes share exactly the same list instead of re-typing it.
STATE_ROOT_ENV_ALIASES: tuple[str, ...] = tuple(_state_root_env['aliases'])
#: Default state root when neither the canonical name nor any alias is set, expanded by
#: callers with `~`.
DEFAULT_STATE_ROOT: str = _state_root['default']

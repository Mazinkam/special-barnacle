"""HT run-diagnostics owner/seal metadata: only a fresh sealed owner may authorize raw removal.

Split out of `orchestrator/archive.py` (B3, `docs/architecture-review.md`); see
`orchestrator/archive/__init__.py` for the package overview and re-export contract.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from .codec import _open_regular
from .manifest import ARCHIVE_SUFFIX, NEVER_ARCHIVE, _unique_object, _validate_file, parse_ts, validate_run_id

OWNER_FILE = '.diagnostics-owner.json'
SEAL_FILE = '.diagnostics-sealed.json'
SEAL_PROTOCOL = 'ht-run-diagnostics-v1'


def load_seal(run_dir: Path) -> Optional[dict[str, Any]]:
    """Only the fresh-directory HT owner protocol may authorize raw removal.

    Absent metadata means legacy snapshot-only; partial managed ownership is skipped by planning.
    Malformed or unsafe metadata fails closed. The inventory binds removal to bytes written by
    that owner, not arbitrary later files.
    """
    values = []
    for name in (OWNER_FILE, SEAL_FILE):
        path = run_dir / name
        _validate_file(path)
        try:
            with _open_regular(path) as source: value = json.load(source, object_pairs_hook=_unique_object)
        except FileNotFoundError:
            values.append(None); continue
        except (OSError, UnicodeError, ValueError) as exc:
            raise ValueError(f'invalid diagnostic ownership metadata: {path}: {exc}') from exc
        if (not isinstance(value, dict) or type(value.get('format_version')) is not int
                or value['format_version'] != 1 or value.get('protocol') != SEAL_PROTOCOL
                or value.get('run_id') != run_dir.name or not isinstance(value.get('owner_id'), str)
                or not value['owner_id']):
            raise ValueError(f'invalid diagnostic ownership schema: {path}')
        values.append(value)
    owner, seal = values
    if owner is None or seal is None: return None
    if (owner['owner_id'] != seal['owner_id'] or parse_ts(seal.get('sealed_at')) is None
            or not isinstance(seal.get('files'), dict)):
        raise ValueError('diagnostic seal does not match its owner')
    for name, info in seal['files'].items():
        validate_run_id(name)
        if (name.startswith('.') or name in NEVER_ARCHIVE or name.endswith(ARCHIVE_SUFFIX)
                or not isinstance(info, dict) or type(info.get('raw_bytes')) is not int or info['raw_bytes'] < 0
                or not isinstance(info.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', info['sha256'])):
            raise ValueError(f'invalid diagnostic seal entry: {name!r}')
    return seal

"""State-root/attribution/time resolution, kept lazy: nothing here resolves at import time.

Moved out of `orchestrator/runtime.py` (B2.2); `orchestrator.runtime` re-exports every name
here for one release. May import `contract`/`vocab`, nothing else under `orchestrator`.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..contract import DEFAULT_STATE_ROOT, STATE_ROOT_ENV_VAR


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()

def default_state_root() -> Path:
    return Path(os.environ.get(STATE_ROOT_ENV_VAR, DEFAULT_STATE_ROOT)).expanduser()

def default_attribution() -> dict[str, str]:
    return {
        'agent_runtime': os.environ.get('CODING_AGENT_RUNTIME', 'unknown'),
        'repository': os.environ.get('CODING_AGENT_REPOSITORY', str(Path.cwd().resolve())),
    }

def stable_hash(value: Any) -> str:
    raw=json.dumps(value,sort_keys=True,separators=(",",":"),default=str).encode()
    return hashlib.sha256(raw).hexdigest()[:16]

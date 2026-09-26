"""HUMAIN Terminal session log parsing: project-path decoding and the per-line reader step.

Split out of `orchestrator/ingest.py` (B3, `docs/architecture-review.md`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from ._shared import _int, _is_int, _optional_str
from .. import checkpoint as ckpt

_PROBE_LIMIT = 4_000


def _resolve_encoded_path(name: str, *, root: Path = Path('/')) -> Optional[Path]:
    """Decode a HUMAIN Terminal project directory name back into a real path.

    The name is an absolute path with separators replaced by `-`, which is ambiguous whenever a
    directory name itself contains a dash (`humain-terminal`). Resolve it against the filesystem,
    preferring longer segment merges, so `--Users-a-humain-terminal--` cannot be silently
    mis-split. Returns None when no existing directory matches; guessing a repository is worse
    than leaving attribution to the caller.
    """
    tokens = [token for token in name.strip('-').split('-') if token]
    if not tokens:
        return None
    probes = 0

    def walk(base: Path, index: int) -> Optional[Path]:
        nonlocal probes
        if index >= len(tokens):
            return base
        for end in range(len(tokens), index, -1):
            probes += 1
            if probes > _PROBE_LIMIT:
                return None
            candidate = base / '-'.join(tokens[index:end])
            if candidate.is_dir():
                resolved = walk(candidate, end)
                if resolved is not None:
                    return resolved
        return None

    return walk(root, 0)


def log_repository(path: Path) -> Optional[str]:
    """Repository a HUMAIN Terminal session belongs to, decoded from its project directory."""
    resolved = _resolve_encoded_path(path.parent.name)
    return str(resolved) if resolved else None


def _humain_terminal_state(path: Path) -> dict[str, Any]:
    return {'session_id': path.stem.split('_')[-1], 'session_origin': 'fallback', 'session_provenance': {},
            'repository': log_repository(path), 'count': 0}


def _humain_terminal_state_ok(state: dict[str, Any]) -> bool:
    return (isinstance(state.get('session_id'), str) and _optional_str(state.get('repository'))
            and state.get('session_origin') in ('fallback', 'explicit')
            and ckpt.valid_session_provenance(state.get('session_provenance'))
            and _is_int(state.get('count')) and state['count'] >= 0)


def _parse_humain_terminal(record: dict[str, Any], state: dict[str, Any]) -> Optional[dict[str, Any]]:
    """HUMAIN Terminal session JSONL: assistant messages carry a `usage` block.

    `usage.input` excludes cached reads here, unlike the OpenAI-style convention used by the
    telemetry contract, so cached reads are folded back into `input_tokens` to keep
    `cached_input_tokens` a subset of it.
    """
    if record.get('type') == 'session':
        session_id = record.get('id') or record.get('sessionId')
        if session_id:
            state['session_id'] = str(session_id)
            state['session_origin'] = 'explicit'
            state['session_provenance'][state['session_id']] = 'explicit'
    message = record.get('message')
    if not isinstance(message, dict) or message.get('role') != 'assistant':
        return None
    usage = message.get('usage')
    if not isinstance(usage, dict):
        return None
    state['session_provenance'].setdefault(state['session_id'], state['session_origin'])
    cached = _int(usage.get('cacheRead'))
    call = {
        'native_id': str(record.get('id') or state['count']),
        '_native_id_stable': bool(record.get('id')),
        'session_id': state['session_id'],
        'session_origin': state['session_origin'],
        'ts': record.get('timestamp'),
        'model': message.get('model'),
        'provider': message.get('provider'),
        'repository': state['repository'],
        'input_tokens': _int(usage.get('input')) + cached,
        'cached_input_tokens': cached,
        'cache_write_tokens': _int(usage.get('cacheWrite')) + _int(usage.get('cacheWrite1h')),
        'output_tokens': _int(usage.get('output')),
        'reasoning_output_tokens': _int(usage.get('reasoning')),
        'total_tokens': _int(usage.get('totalTokens')),
    }
    state['count'] += 1
    return call

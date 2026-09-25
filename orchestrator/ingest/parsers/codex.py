"""Codex rollout log parsing: cumulative vs. per-response usage bookkeeping.

Split out of `orchestrator/ingest.py` (B3, `docs/architecture-review.md`).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from ._shared import _int, _optional_str


def _codex_state(path: Path) -> dict[str, Any]:
    return {'models': {}, 'latest_model': None, 'repository': None, 'provider': None, 'stem': path.stem}


def _codex_state_ok(state: dict[str, Any]) -> bool:
    models = state.get('models')
    return (isinstance(models, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in models.items())
            and all(_optional_str(state.get(key)) for key in ('latest_model', 'repository', 'provider'))
            and isinstance(state.get('stem'), str))


def _parse_codex(record: dict[str, Any], state: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Codex rollout JSONL: one `token_usage_record` per response.

    `payload.usage` is the per-response delta; `turn_token_usage` and `thread_token_usage` are
    cumulative and must not be summed. The model lives on `turn_context`, keyed by turn.
    """
    kind = record.get('type')
    payload = record.get('payload')
    if not isinstance(payload, dict):
        return None
    if kind == 'session_meta':
        state['repository'] = payload.get('cwd') or state['repository']
        state['provider'] = payload.get('model_provider') or state['provider']
        return None
    if kind == 'turn_context':
        model = payload.get('model')
        if model:
            state['latest_model'] = str(model)
            if payload.get('turn_id'):
                state['models'][str(payload['turn_id'])] = state['latest_model']
        state['repository'] = payload.get('cwd') or state['repository']
        return None
    if kind != 'token_usage_record':
        return None
    usage = payload.get('usage')
    if not isinstance(usage, dict):
        return None
    turn_id = payload.get('turn_id')
    return {
        'native_id': str(payload.get('response_id') or f"{turn_id}:{record.get('ordinal')}"),
        '_native_id_stable': bool(payload.get('response_id') or (turn_id and record.get('ordinal') is not None)),
        'session_id': str(payload.get('session_id') or state['stem']),
        'session_origin': 'explicit' if payload.get('session_id') else 'fallback',
        'turn_id': turn_id,
        'ts': record.get('timestamp'),
        'model': state['models'].get(str(turn_id), state['latest_model']),
        'provider': state['provider'],
        'repository': state['repository'],
        'input_tokens': _int(usage.get('input_tokens')),
        'cached_input_tokens': _int(usage.get('cached_input_tokens')),
        'cache_write_tokens': _int(usage.get('cache_write_input_tokens')),
        'output_tokens': _int(usage.get('output_tokens')),
        'reasoning_output_tokens': _int(usage.get('reasoning_output_tokens')),
        'total_tokens': _int(usage.get('total_tokens')),
    }

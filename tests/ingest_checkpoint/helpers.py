"""Shared fixtures and helpers for the ``tests.ingest_checkpoint`` package (B5).

Every module in this package tests the same subject as the old
``tests/test_ingest_checkpoint.py``: incremental, concurrency-safe session ingestion. Every test
uses a throwaway state root and copied/synthetic session logs. The checkpoint under test is a
derived cache: whatever happens to it (missing, stale, corrupt, crash before it is written), the
authoritative ``metrics.jsonl`` must end up holding every token exactly once.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from orchestrator import ingest_checkpoint
from orchestrator.ingest import SESSION, ingest_paths
from orchestrator.runtime import load_jsonl

REPO = Path(__file__).resolve().parents[2]


def env_for(root: Path) -> dict[str, str]:
    return {**os.environ, 'CODING_AGENT_ORCHESTRATOR_HOME': str(root), 'CODING_AGENT_RUNTIME': 'humain-terminal',
            'CODING_AGENT_REPOSITORY': '/work/forge', 'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1'}


def ht_call(i: int, *, tokens: int = 1000, model: str = 'claude-sonnet-5') -> str:
    return json.dumps({'type': 'message', 'id': f'asst-{i}', 'timestamp': f'2026-09-21T10:00:{i % 60:02d}.000Z',
                       'message': {'role': 'assistant', 'model': model, 'provider': 'humain-node',
                                   'usage': {'input': tokens, 'output': 100, 'cacheRead': 0, 'cacheWrite': 0,
                                             'cacheWrite1h': 0, 'reasoning': 0, 'totalTokens': tokens + 100}}}) + '\n'


def ht_session(path: Path, calls: int, *, session: str = 'sess-1', start: int = 0, tokens: int = 1000) -> Path:
    with path.open('w', encoding='utf-8') as out:
        out.write(json.dumps({'type': 'session', 'id': session}) + '\n')
        for i in range(start, start + calls):
            out.write(ht_call(i, tokens=tokens))
    return path


def append(path: Path, text: str) -> None:
    with path.open('a', encoding='utf-8') as out:
        out.write(text)


def ingest_rows(root: Path) -> list[dict]:
    return [r for r in load_jsonl(root / 'metrics.jsonl') if r.get('source') == 'session_ingest']


def recorded_input_tokens(root: Path, session: str = 'sess-1') -> int:
    return sum(int(r.get('input_tokens') or 0) for r in ingest_rows(root) if r.get('session_id') == session)


def snapshot(root: Path) -> dict[str, bytes]:
    if not root.exists():
        return {}
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


def aggregate_row(session: str, *, covers: int, input_tokens: int, call_id: str = 'other-agg') -> dict:
    """A session-level row as another (possibly legacy) ingester would have written it."""
    return dict(event='model_call', source='session_ingest', role='interactive_session', agent_runtime='humain-terminal',
                session_id=session, model='claude-sonnet-5', granularity=SESSION, covers_calls=covers, call_id=call_id,
                input_tokens=input_tokens, output_tokens=100 * covers, cached_input_tokens=0, cache_write_tokens=0,
                reasoning_output_tokens=0, total_tokens=input_tokens + 100 * covers)


class CheckpointTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.root = self.dir / 'state'
        self._env = patch.dict(os.environ, {'CODING_AGENT_ORCHESTRATOR_HOME': str(self.root),
                                            'CODING_AGENT_RUNTIME': 'humain-terminal',
                                            'CODING_AGENT_REPOSITORY': '/work/forge'})
        self._env.start()
        self.addCleanup(self._env.stop)

    def ingest(self, log: Path, granularity: str = SESSION, runtime: str | None = 'humain-terminal', **kw) -> dict:
        return ingest_paths([log], state_root=self.root, granularity=granularity, runtime=runtime, **kw)

    def one(self, log: Path, granularity: str = SESSION, **kw) -> dict:
        result = self.ingest(log, granularity, **kw)
        self.assertEqual(result['failures'], [], result)
        return result['files'][0]

    def checkpoint(self, log: Path) -> dict | None:
        return ingest_checkpoint.load_checkpoint(self.root, log)

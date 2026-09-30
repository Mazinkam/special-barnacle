"""`IngestLedger.source_promotions` event-offset cache and `generate_dashboard(skip_if_current=True)`."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from orchestrator.app.refresh import refresh_after_write
from orchestrator.contract import STREAMS
from orchestrator.ingest import ledger as ledger_module
from orchestrator.ingest.checkpoint import promotion_record
from orchestrator.ingest.ledger import IngestLedger
from orchestrator.presentation import publish
from orchestrator.record_batch import write_batch

RUNTIME, SOURCE = 'rt', '/src/a.jsonl'


def _line(row) -> str:
    return json.dumps(row, sort_keys=True) + '\n'


def _promo(before, after, identity=(1, 2), source=SOURCE):
    return promotion_record(RUNTIME, source, list(identity), before, after)


def _events(root) -> Path:
    return Path(root) / STREAMS['event']


def test_append_only_reads_suffix(tmp_path, monkeypatch):
    ev = _events(tmp_path)
    ev.write_text(_line(_promo('a', 'A')) + _line({'event': 'other'}))
    ledger = IngestLedger(tmp_path)
    assert set(ledger.source_promotions(RUNTIME, SOURCE)) == {'a'}
    size = ev.stat().st_size
    calls = []
    real = ledger_module.iter_jsonl_from
    monkeypatch.setattr(ledger_module, 'iter_jsonl_from', lambda f, offset=0: calls.append(offset) or real(f, offset))
    ledger.source_promotions(RUNTIME, SOURCE)
    with ev.open('a') as f:
        f.write(_line(_promo('b', 'B')))
    assert set(ledger.source_promotions(RUNTIME, SOURCE)) == {'a', 'b'}
    assert 0 not in calls and calls[-1] == size


def test_rewrite_truncate_and_replace_rescan(tmp_path):
    ev = _events(tmp_path)
    ev.write_text(_line(_promo('a', 'A')) + _line(_promo('b', 'B')))
    ledger = IngestLedger(tmp_path)
    assert set(ledger.source_promotions(RUNTIME, SOURCE)) == {'a', 'b'}
    # in-place rewrite: same inode, the last line before the cached offset differs
    ev.write_text(_line(_promo('a', 'A')) + _line(_promo('c', 'C')))
    assert set(ledger.source_promotions(RUNTIME, SOURCE)) == {'a', 'c'}
    # truncated below the cached offset
    ev.write_text(_line(_promo('d', 'D')))
    assert set(ledger.source_promotions(RUNTIME, SOURCE)) == {'d'}
    # replaced by a larger file on a new inode
    new = tmp_path / 'new'
    new.write_text(_line(_promo('e', 'E')) + _line({'event': 'x'}) * 5)
    os.replace(new, ev)
    assert set(ledger.source_promotions(RUNTIME, SOURCE)) == {'e'}
    ev.unlink()
    assert ledger.source_promotions(RUNTIME, SOURCE) == {}


def test_conflict_fails_closed_and_recovers(tmp_path):
    ev = _events(tmp_path)
    ev.write_text(_line(_promo('a', 'A')))
    ledger = IngestLedger(tmp_path)
    ledger.source_promotions(RUNTIME, SOURCE)
    with ev.open('a') as f:
        f.write(_line(_promo('a', 'B')))
    for _ in range(2):  # the cache must not swallow the conflict on retry
        with pytest.raises(ValueError, match='ambiguous session promotion'):
            ledger.source_promotions(RUNTIME, SOURCE)
    ev.write_text(_line(_promo('a', 'A')))
    assert ledger.source_promotions(RUNTIME, SOURCE)['a']['to_session_id'] == 'A'


def test_other_source_ignored_and_result_not_aliased(tmp_path):
    _events(tmp_path).write_text(_line(_promo('a', 'A')) + _line(_promo('z', 'Z', source='/src/other.jsonl')))
    ledger = IngestLedger(tmp_path)
    first = ledger.source_promotions(RUNTIME, SOURCE)
    assert set(first) == {'a'}
    first['a']['source_identity'].append(99)
    assert ledger.source_promotions(RUNTIME, SOURCE)['a']['source_identity'] == [1, 2]


def _event(rid):
    return {'stream': 'event', 'record_id': rid, 'event': 'note'}


def test_dashboard_skip_only_when_current(tmp_path):
    root = tmp_path
    assert write_batch(root, [_event('e1')], refresh=False)['ok']
    publish.generate_dashboard(root, config={})
    page = root / 'dashboard.html'
    before = page.read_bytes()
    renders = []
    real = publish.render
    with patch.object(publish, 'render', lambda d: renders.append(1) or real(d)):
        # duplicate-only write: no new bytes, receipt current -> refresh skips the render
        result = refresh_after_write(root, write_batch(root, [_event('e1')], refresh=False), config={})
        assert result['dashboard_updated'] and renders == []
        assert page.read_bytes() == before
        # the explicit command always renders
        publish.generate_dashboard(root, config={})
        assert len(renders) == 1
        # new bytes invalidate the receipt -> re-render
        refresh_after_write(root, write_batch(root, [_event('e2')], refresh=False), config={})
        assert len(renders) == 2
        assert publish.dashboard_is_current(root)

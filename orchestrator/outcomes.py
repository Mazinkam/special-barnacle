from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict
from typing import Iterable
from .runtime import default_state_root, iter_jsonl

def _dt(s):
    try: return datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception: return None

#: Keys that make an outcome "bad". `major_rewrite` and `incident` are historical additions from
#: two different call sites (outcome_summary and history.build_route_stats respectively); both are
#: honored here so the two consumers agree on what a bad outcome is.
_BAD_SIGNAL_KEYS = ('reopened', 'regression', 'rollback', 'human_correction', 'major_rewrite', 'incident')


def _note_payload(row: dict) -> dict:
    """Best-effort parse of the JSON object live rows stuff into `note`/`notes`.

    Live outcomes.jsonl rows carry their real payload as a JSON string inside `note`
    (e.g. `note='{"success_rate":1,"verification_passed":true,...}'`), so a typed top-level check
    for `reopened`/`regression`/... never fires against them. `note` (and, on 7 live rows, `notes`)
    is just as often plain prose ("looks good, shipped"), so a parse failure here is the expected
    case, not an error — it must be swallowed silently rather than raised, or a single prose note
    would crash outcome summarization.
    """
    payload: dict = {}
    for key in ('note', 'notes'):
        value = row.get(key)
        if not isinstance(value, str):
            continue
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            payload.update(parsed)
    return payload


def bad_signal(row: dict) -> bool:
    """Does this outcome row carry a bad-outcome signal?

    Typed top-level fields are authoritative when present (including an explicit falsy value —
    a row that states `"reopened": false` must not fall through to the note payload for that key).
    Only keys absent from the top level fall back to the JSON-in-note payload.

    Public (not `_bad_signal`) because `history.build_route_stats`'s `delayed_bad` loop needs this
    exact definition too. It used to inline a raw literal check (top-level fields only) instead of
    calling this, so a live row whose bad-outcome signal is JSON-in-`note` (the shape live rows
    actually carry) was 'bad' to `outcome_summary` but not to `build_route_stats` — the per-route
    "Delayed fail" column and the global "30d delayed failure" card disagreed on identical data.
    Both call sites must go through this one function so that can't recur.
    """
    payload = None
    for key in _BAD_SIGNAL_KEYS:
        if key in row:
            if row.get(key):
                return True
            continue
        if payload is None:
            payload = _note_payload(row)
        if payload.get(key):
            return True
    return False


def outcome_summary(root=None, rows:Iterable[dict]|None=None):
    """Per-task delayed-outcome maturity. Pass `rows` to reuse outcomes a caller already streamed."""
    if rows is None:
        root=Path(root) if root is not None else default_state_root(); rows=iter_jsonl(root/'outcomes.jsonl')
    by=defaultdict(list)
    for r in rows:
        if r.get('task_id'): by[r['task_id']].append(r)
    now=datetime.now(timezone.utc); result=[]
    for tid,os in by.items():
        first=min((_dt(o.get('completed_at') or o.get('ts','')) for o in os), default=None)
        age=(now-first).days if first else None
        bad=any(bad_signal(o) for o in os)
        result.append({'task_id':tid,'age_days':age,'bad_outcome':bad,'mature_7d':age is not None and age>=7,'mature_30d':age is not None and age>=30,'mature_90d':age is not None and age>=90})
    return result

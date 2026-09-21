from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict
from .runtime import default_state_root, load_jsonl

def _dt(s):
    try: return datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception: return None

def outcome_summary(root=None):
    root=Path(root) if root is not None else default_state_root(); rows=load_jsonl(root/'outcomes.jsonl'); by=defaultdict(list)
    for r in rows:
        if r.get('task_id'): by[r['task_id']].append(r)
    now=datetime.now(timezone.utc); result=[]
    for tid,os in by.items():
        first=min((_dt(o.get('completed_at') or o.get('ts','')) for o in os), default=None)
        age=(now-first).days if first else None
        bad=any(o.get('reopened') or o.get('regression') or o.get('rollback') or o.get('human_correction') or o.get('major_rewrite') for o in os)
        result.append({'task_id':tid,'age_days':age,'bad_outcome':bad,'mature_7d':age is not None and age>=7,'mature_30d':age is not None and age>=30,'mature_90d':age is not None and age>=90})
    return result

"""Flaky-check detection over `verification_result` metric rows.

Moved out of `orchestrator.verification` (B3, `docs/architecture-review.md`: "move
`verification.flaky_stats` to analytics" — it had nothing to do with the on-disk
`VerificationCache` that module otherwise held). `orchestrator.verification` re-exports this name.
"""
from __future__ import annotations

from collections import defaultdict


def flaky_stats(metrics:list[dict], window:int=30):
    by=defaultdict(list)
    for r in metrics:
        if r.get('event')=='verification_result' and r.get('check_id'):
            by[r['check_id']].append(r)
    out=[]
    for cid,rows in by.items():
        rows=rows[-window:]; vals=[1 if r.get('result')=='pass' else 0 for r in rows]
        transitions=sum(1 for a,b in zip(vals,vals[1:]) if a!=b)
        out.append({'check_id':cid,'samples':len(vals),'pass_rate':sum(vals)/len(vals) if vals else None,'transition_rate':transitions/max(1,len(vals)-1)})
    return out

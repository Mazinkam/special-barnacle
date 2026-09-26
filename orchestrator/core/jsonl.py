"""The one JSONL reader: streaming, tail-fingerprint and (legacy) eager variants.

Moved out of `orchestrator/runtime.py` (B2.2); `orchestrator.runtime` re-exports every name
here for one release. No `orchestrator` imports beyond this comment.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterator, Optional
from contextlib import contextmanager


def encode_jsonl(record: dict[str,Any]) -> bytes:
    return (json.dumps(record,sort_keys=True,default=str)+'\n').encode('utf-8')

def append_jsonl(path: Path, record: dict[str,Any]):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('ab') as f: f.write(encode_jsonl(record))

@contextmanager
def open_binary(source):
    """`source` as a positioned binary reader: a Path is opened (and closed); an open file is used as is.

    A caller that must see one consistent file across several reads (identity, prefix check, scan,
    fingerprint) opens it once and passes the handle, so a rotation of the *path* in between cannot
    hand each step a different file.
    """
    if hasattr(source,'seek'): yield source; return
    with Path(source).open('rb') as f: yield f

def iter_jsonl_from(path, offset: int=0):
    """Yield `(record, end_offset)` for each complete line at or after `offset` of a Path or open binary file.

    Blank or malformed *complete* lines yield `(None, end_offset)` so a caller can still advance
    past them; a trailing line without a newline is a torn or in-progress write and is never
    yielded, so `end_offset` values always mark a replayable prefix.
    """
    if not hasattr(path,'seek') and not Path(path).exists(): return
    with open_binary(path) as f:
        f.seek(offset); pos=offset
        for line in f:
            if not line.endswith(b'\n'): return
            pos+=len(line); stripped=line.strip()
            if not stripped: yield None,pos; continue
            try: yield json.loads(stripped),pos
            except (json.JSONDecodeError,UnicodeDecodeError): yield None,pos

def iter_jsonl(path: Path) -> Iterator[dict[str,Any]]:
    """Stream the complete, well-formed JSON objects of a JSONL file in order, one at a time.

    Never holds the whole file: lines are read through the buffered binary reader and parsed one
    by one. Blank lines, malformed lines, invalid UTF-8 and non-object JSON values are skipped, and a
    trailing line without its newline (torn or in-progress write) is not yielded — the same
    replayable-prefix rule the ledger uses, so the dashboard and the ledger agree on what exists.
    `load_jsonl` remains the eager whole-file reader for callers that need a list.
    """
    for record,_ in iter_jsonl_from(path):
        if isinstance(record,dict): yield record

TAIL_FINGERPRINT_BYTES=4096

def tail_fingerprint(path, offset: int) -> Optional[str]:
    """Hash of the last complete line ending exactly at `offset` (None for an empty prefix).

    Cheap identity check for a checkpointed prefix: if the bytes before the offset changed (file
    rewritten, rotated, or offset landing mid-line) the fingerprint no longer matches. `path` may
    be an open binary file (see `open_binary`).
    """
    if offset<=0: return None
    with open_binary(path) as f:
        start=max(0,offset-TAIL_FINGERPRINT_BYTES); f.seek(start); chunk=f.read(offset-start)
    if not chunk.endswith(b'\n'): return 'unterminated'
    body=chunk[:-1]; cut=body.rfind(b'\n')
    return hashlib.sha256(body[cut+1:]).hexdigest()[:16]

def load_jsonl(path: Path) -> list[dict[str,Any]]:
    """Eager whole-file reader kept for callers with different corrupt-input semantics than `iter_jsonl`.

    Not folded into `iter_jsonl`/`iter_jsonl_from`: this reads text mode (a genuinely invalid-UTF-8
    file raises here rather than being silently skipped line-by-line), so replacing call sites would
    change behaviour on that edge case. See docs/architecture-review.md B2.2.
    """
    if not path.exists(): return []
    out=[]
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip(): continue
        try: out.append(json.loads(line))
        except json.JSONDecodeError: continue
    return out

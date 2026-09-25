from __future__ import annotations
from dataclasses import dataclass, asdict, field
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator, Optional
from contextlib import contextmanager
import fcntl, hashlib, json, logging, os, secrets, sys

from .contract import DEFAULT_STATE_ROOT, STATE_ROOT_ENV_VAR, STREAMS

_LOGGER = logging.getLogger('orchestrator')
if not _LOGGER.handlers:
    # Independent of the caller's logging config: a warning about a corrupt config file must
    # reach stderr even when nothing else configured logging (e.g. running as `python3 -m
    # orchestrator.cli`), and it must never land on stdout, which the TS bridge parses as JSON.
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setFormatter(logging.Formatter('%(name)s: %(levelname)s: %(message)s'))
    _LOGGER.addHandler(_handler)
_LOGGER.setLevel(logging.WARNING)


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

def read_json(path: Path, default):
    if not path.exists(): return default
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        _LOGGER.warning('failed to read %s (%s: %s); using default', path, type(exc).__name__, exc)
        return default

def fsync_directory(path: Path):
    """Make newly created/replaced directory entries durable on local POSIX filesystems."""
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def fsync_directory_ancestry(path: Path) -> list[Path]:
    """fsync the real `path` and every ancestor on the same filesystem, deepest first; return them.

    A stream fsync plus an fsync of the state root only makes the *file* entries durable. Each
    directory entry (`state` in `new`, `new` in `T`, ...) lives in its parent and needs that parent
    synced too, or a power loss after an acknowledged write can drop the whole state tree. Existence
    proves nothing about durability: a directory another process, an older writer or an earlier
    attempt whose fsync failed created a moment ago may still live only in the page cache, so the
    caller syncs the chain itself, whoever created it. The walk stops at the mount point: the entry
    naming a mount point is on the parent filesystem and had to exist for the mount to be there at
    all. Symlinks are resolved first so the physical chain is the one synced. An fsync of a clean
    directory is a cheap syscall (~15 us here), so a write pays well under a millisecond for this.
    """
    directory = Path(path).resolve()
    device = directory.stat().st_dev
    synced: list[Path] = []
    while True:
        fsync_directory(directory); synced.append(directory)
        parent = directory.parent
        if parent == directory or parent.stat().st_dev != device:
            return synced
        directory = parent


def _create_exclusive_tmp(path: Path) -> tuple[int, Path]:
    """Open a fresh same-directory temporary file for an atomic replacement of `path`."""
    for _ in range(100):
        tmp = path.with_name(f'.{path.name}.{secrets.token_hex(8)}.tmp')
        try:
            return os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666), tmp
        except FileExistsError:
            continue
    raise FileExistsError(f'Could not create a unique temporary file for {path}')


def write_json(path: Path, value: Any, *, compact: bool=False, durable: bool=False):
    fd, tmp = _create_exclusive_tmp(path)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            # json.dumps uses the C encoder; json.dump(fp) always falls back to the pure-Python one.
            f.write(json.dumps(value, separators=(',',':') if compact else None, indent=None if compact else 2, sort_keys=True, default=str))
            if durable:
                f.flush()
                os.fsync(f.fileno())
        os.replace(tmp, path)
        if durable: fsync_directory(path.parent)
    finally:
        try: tmp.unlink()
        except FileNotFoundError: pass

def write_text_atomic(path: Path, chunks: Iterable[str], *, encoding: str='utf-8'):
    """Publish a text document by same-directory temporary file + rename.

    Readers (a browser tab on `file://dashboard.html`, another process) see either the previous
    complete document or the new complete one, never a truncated page. A failure while rendering
    or writing leaves the previous document untouched and removes the temporary file. Nothing is
    fsynced: derived views are rebuildable, and the next refresh republishes them.
    """
    fd, tmp = _create_exclusive_tmp(path)
    try:
        with os.fdopen(fd, 'w', encoding=encoding) as f:
            for chunk in chunks: f.write(chunk)
        os.replace(tmp, path)
    finally:
        try: tmp.unlink()
        except FileNotFoundError: pass

@contextmanager
def exclusive_file_lock(path: Path):
    """Hold an advisory exclusive lock until the context exits."""
    with path.open('a', encoding='utf-8') as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try: yield
        finally: fcntl.flock(f.fileno(), fcntl.LOCK_UN)

WRITER_LOCK_FILE='ledger.lock'
RECORD_INDEX_FILE='records.checkpoint.json'  # independent receipt for the rebuildable SQLite record-id cache

def writer_lock(root: Path):
    """The single process-wide lock that serializes check/append/checkpoint/ledger writes.

    The file name is the one the pre-batch code already used for rebuilds, so a process running
    older code still excludes the new writer during a rolling upgrade. Advisory `flock` locks are
    per open file description, so this must not be re-entered from the same call chain.
    """
    return exclusive_file_lock(Path(root)/WRITER_LOCK_FILE)

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
    if not path.exists(): return []
    out=[]
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip(): continue
        try: out.append(json.loads(line))
        except json.JSONDecodeError: continue
    return out

@dataclass
class Policy:
    quality_floor: float=0.95
    cost_aggressiveness: float=0.70
    latency_weight: float=0.10
    human_hour_value_usd: float=0.0
    shadow_review_rate: float=0.03
    risk_quality_floor_delta: dict[str,float]=field(default_factory=lambda:{'low':0.0,'medium':0.02,'high':0.04,'critical':0.045})
    def effective_quality_floor(self,risk:str)->float:
        return min(.999,max(0.0,self.quality_floor+self.risk_quality_floor_delta.get(risk,0.0)))
    def snapshot(self)->dict[str,Any]:
        d=asdict(self); d['policy_id']=stable_hash(d); return d

@dataclass
class QualityEvidence:
    acceptance_pass: bool=False
    deterministic_checks_pass: bool=False
    tests_pass: Optional[bool]=None
    semantic_review_pass: Optional[bool]=None
    architecture_review_pass: Optional[bool]=None
    shadow_review_pass: Optional[bool]=None
    unresolved_high_risk_findings: int=0
    uncertainty: str='medium'
    reopened: Optional[bool]=None
    regression: Optional[bool]=None
    rollback: Optional[bool]=None
    human_correction: Optional[bool]=None
    def hard_gate_pass(self)->bool:
        return bool(self.acceptance_pass and self.deterministic_checks_pass and self.tests_pass is not False and self.unresolved_high_risk_findings==0)
    def evidence_score(self)->float:
        # Assurance/evidence summary for routing/UI, not literal correctness probability.
        parts=[(.22,self.acceptance_pass),(.14,self.deterministic_checks_pass),(.18,self.tests_pass),(.18,self.semantic_review_pass),(.12,self.architecture_review_pass),(.06,self.shadow_review_pass)]
        score=0.0
        for w,v in parts: score += w*(1.0 if v is True else .45 if v is None else 0.0)
        stable=1.0
        for bad,pen in [(self.reopened,.30),(self.regression,.35),(self.rollback,.45),(self.human_correction,.25)]:
            if bad is True: stable-=pen
        score += .10*max(0.0,stable)
        score -= {'low':0.0,'medium':.03,'high':.08}.get(self.uncertainty,.03)
        score -= min(.25,.05*self.unresolved_high_risk_findings)
        return max(0.0,min(1.0,score))

def meter(payload: dict[str,Any]) -> dict[str,Any]:
    """Stamp cost provenance on a call metric, deriving cost from tokens when possible.

    Without this, a runtime that cannot report `cost_usd` writes a row with no cost and the
    dashboard renders it as $0.00 — indistinguishable from genuinely free work. Every call row
    leaves here with an explicit `cost_source`, so 'not measured' and 'measured as zero' stay
    distinguishable downstream. Imported lazily to keep `runtime` free of package cycles.
    """
    from .economics import is_call_row
    if not is_call_row(payload): return payload
    legacy_placeholder = (payload.get('cost_source') == 'estimated-from-reported-tokens'
                          and not payload.get('cost_rate_model') and not payload.get('cost_usd'))
    if payload.get('cost_source') and not legacy_placeholder: return payload
    if payload.get('cost_usd') is not None and not legacy_placeholder: return {**payload,'cost_source':'reported'}
    if legacy_placeholder:
        payload = {k:v for k,v in payload.items() if k not in {'cost_usd', 'cost_source'}}
    from .pricing import estimate_cost_usd
    estimate=estimate_cost_usd(model=payload.get('model'),input_tokens=payload.get('input_tokens'),
                               output_tokens=payload.get('output_tokens'),
                               cached_input_tokens=payload.get('cached_input_tokens'),
                               cache_write_tokens=payload.get('cache_write_tokens'))
    return {**payload,**estimate} if estimate else {**payload,'cost_source':'unmetered'}

class EventStore:
    def __init__(self, root: str|Path|None=None):
        self.root=Path(root) if root is not None else default_state_root(); self.root.mkdir(parents=True,exist_ok=True)  # write_batch syncs the ancestry before any acknowledgement
        self.events=self.root/STREAMS['event']; self.metrics=self.root/STREAMS['metric']; self.discoveries=self.root/'discoveries.jsonl'; self.outcomes=self.root/STREAMS['outcome']
        for p in [self.events,self.metrics,self.discoveries,self.outcomes]:
            if not p.exists(): p.touch(exist_ok=True)
    def _write(self,stream:str,payload:dict[str,Any],*,event:str|None=None):
        """Route a single record through the coordinated writer (lock + dedup + checkpoint).

        Callers that want the ledger/dashboard refreshed do so explicitly, as before; the writer
        here only guarantees the durable, deduplicated append. The stream (and event name) named
        by the method win over anything in the payload. Imported lazily: `record_batch` depends
        on this module.
        """
        from .record_batch import write_batch, single_record
        result=write_batch(self.root,[single_record(stream,payload,event=event)],refresh=False)
        return result['records'][0]
    def emit(self,event:str,**payload):
        return self._write('event',payload,event=event)
    def preview_metric(self,**payload):
        """Build the record a `metric()` call would write, without writing it (dry runs)."""
        return {'ts':utc_now(),**default_attribution(),**meter(payload)}
    def metric(self,**payload):
        return self._write('metric',payload)
    def discovery(self,**payload):
        rec={'ts':utc_now(),**default_attribution(),**payload}; append_jsonl(self.discoveries,rec); return rec
    def outcome(self,**payload):
        return self._write('outcome',payload)
    def all_events(self): return load_jsonl(self.events)

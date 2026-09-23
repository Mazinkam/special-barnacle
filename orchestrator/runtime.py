from __future__ import annotations
from dataclasses import dataclass, asdict, field
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Optional
from contextlib import contextmanager
import fcntl, hashlib, json, os, secrets


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()

def default_state_root() -> Path:
    return Path(os.environ.get('CODING_AGENT_ORCHESTRATOR_HOME', Path.home()/'.local'/'state'/'coding-agent-orchestrator')).expanduser()

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
    except Exception: return default

def write_json(path: Path, value: Any):
    for _ in range(100):
        tmp = path.with_name(f'.{path.name}.{secrets.token_hex(8)}.tmp')
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
            break
        except FileExistsError:
            continue
    else:
        raise FileExistsError(f'Could not create a unique temporary file for {path}')

    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, indent=2, sort_keys=True, default=str)
        tmp.replace(path)
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

def append_jsonl(path: Path, record: dict[str,Any]):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a',encoding='utf-8') as f: f.write(json.dumps(record,sort_keys=True,default=str)+'\n')

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
    if not is_call_row(payload) or payload.get('cost_source'): return payload
    if payload.get('cost_usd') is not None: return {**payload,'cost_source':'reported'}
    from .pricing import estimate_cost_usd
    estimate=estimate_cost_usd(model=payload.get('model'),input_tokens=payload.get('input_tokens'),
                               output_tokens=payload.get('output_tokens'),
                               cached_input_tokens=payload.get('cached_input_tokens'),
                               cache_write_tokens=payload.get('cache_write_tokens'))
    return {**payload,**estimate} if estimate else {**payload,'cost_source':'unmetered'}

class EventStore:
    def __init__(self, root: str|Path|None=None):
        self.root=Path(root) if root is not None else default_state_root(); self.root.mkdir(parents=True,exist_ok=True)
        self.events=self.root/'events.jsonl'; self.metrics=self.root/'metrics.jsonl'; self.discoveries=self.root/'discoveries.jsonl'; self.outcomes=self.root/'outcomes.jsonl'
        for p in [self.events,self.metrics,self.discoveries,self.outcomes]: p.touch(exist_ok=True)
    def emit(self,event:str,**payload):
        rec={'ts':utc_now(),**default_attribution(),'event':event,**payload}; append_jsonl(self.events,rec); return rec
    def preview_metric(self,**payload):
        """Build the record a `metric()` call would write, without writing it (dry runs)."""
        return {'ts':utc_now(),**default_attribution(),**meter(payload)}
    def metric(self,**payload):
        rec=self.preview_metric(**payload); append_jsonl(self.metrics,rec); return rec
    def discovery(self,**payload):
        rec={'ts':utc_now(),**default_attribution(),**payload}; append_jsonl(self.discoveries,rec); return rec
    def outcome(self,**payload):
        rec={'ts':utc_now(),**default_attribution(),**payload}; append_jsonl(self.outcomes,rec); return rec
    def all_events(self): return load_jsonl(self.events)

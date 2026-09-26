"""`Policy`, `QualityEvidence` and `meter()` — moved out of `orchestrator/runtime.py` (B2.2).

These belong in `records/` (not `core/`): `meter()` classifies and prices a call row, which
needs `economics.is_call_row` and `pricing.estimate_cost_usd` — both above `core` in the layer
order. `orchestrator.runtime` re-exports all three names for one release, so existing imports
(`from orchestrator.runtime import Policy`, ...) keep working unchanged.

The two lazy, function-local imports this module used to need (`from .economics import
is_call_row` and `from .pricing import estimate_cost_usd`, both inside `meter()`, done "to keep
`runtime` free of package cycles") are ordinary top-level imports here: `economics` and
`pricing` do not import `runtime`/`records.metering`/`store`, so there is no cycle to avoid.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Optional

from ..core.env import stable_hash
from ..economics import is_call_row
from ..pricing import estimate_cost_usd


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
    distinguishable downstream.
    """
    if not is_call_row(payload): return payload
    legacy_placeholder = (payload.get('cost_source') == 'estimated-from-reported-tokens'
                          and not payload.get('cost_rate_model') and not payload.get('cost_usd'))
    if payload.get('cost_source') and not legacy_placeholder: return payload
    if payload.get('cost_usd') is not None and not legacy_placeholder: return {**payload,'cost_source':'reported'}
    if legacy_placeholder:
        payload = {k:v for k,v in payload.items() if k not in {'cost_usd', 'cost_source'}}
    estimate=estimate_cost_usd(model=payload.get('model'),input_tokens=payload.get('input_tokens'),
                               output_tokens=payload.get('output_tokens'),
                               cached_input_tokens=payload.get('cached_input_tokens'),
                               cache_write_tokens=payload.get('cache_write_tokens'))
    return {**payload,**estimate} if estimate else {**payload,'cost_source':'unmetered'}

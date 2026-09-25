"""Backward-compatible re-export shim.

`orchestrator/dashboard.py` used to hold data assembly, HTML rendering, and publish/locking in one
779-line module (B3, `docs/architecture-review.md`). It is now split into
`orchestrator/presentation/{dashboard_data,dashboard_html,publish}.py`; every name that used to be
importable from `orchestrator.dashboard` is re-exported here unchanged, so `app/refresh.py`,
`app/engine.py`, `cli.py`, `scripts/regenerate_dashboard.py` and every test that imports from this
module keep working without modification.

`generate_dashboard` here is a thin wrapper, not a straight re-export: it passes this module's own
`build_data` name to `presentation.publish.generate_dashboard` explicitly, so
`tests/test_final_integration.py`'s `dashboard.build_data = <patched>` (an existing monkeypatch
seam that relies on `generate_dashboard` and `build_data` sharing one module's globals) keeps
working even though the two functions now live in different modules.
"""
from __future__ import annotations

from .presentation.dashboard_data import (
    EXECUTED_MIRROR_TOLERANCE,
    INSTRUMENTATION,
    LEAD_SIZE_ORDER,
    MIN_TAIL_SAMPLES,
    RECENT_ADAPTIVE,
    RECENT_EVENTS,
    RECENT_METRICS,
    RECENT_RUNS,
    _FIELD_NOTES,
    _CONFLICT_EVENTS,
    _CONTEXT_MISS_EVENTS,
    _executed_spend,
    _instrumentation,
    _int,
    _lead_sizes,
    _mirrors,
    _num,
    _rate_provenance,
    _verification_task_ids,
    build_data,
    build_ingest_status,
    tail_ratio,
)
from .presentation.dashboard_html import _LONE_SURROGATE, safe
from .presentation.publish import (
    dashboard_is_current,
    stream_version,
)
from .presentation import publish as _publish

__all__ = [
    'RECENT_EVENTS', 'RECENT_METRICS', 'RECENT_ADAPTIVE', 'RECENT_RUNS',
    'MIN_TAIL_SAMPLES', 'INSTRUMENTATION', 'EXECUTED_MIRROR_TOLERANCE', 'LEAD_SIZE_ORDER',
    'safe', 'tail_ratio', 'build_ingest_status', 'build_data',
    'stream_version', 'dashboard_is_current', 'generate_dashboard',
]


def generate_dashboard(state_dir=None, config: dict | None = None):
    return _publish.generate_dashboard(state_dir, config, build_data=build_data)

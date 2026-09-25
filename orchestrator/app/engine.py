"""The wired entry point for constructing an `OrchestrationEngine` with dashboard publication.

`OrchestrationEngine` itself never imports the presentation layer (`dashboard.py`): its
`on_change` callback defaults to a no-op, and without one, state changes durably append but no
dashboard is regenerated. `build_engine` is the one place that wires the two together, using the
engine's *own* loaded config (`engine.config`, read from `config_path`) rather than a second,
separately loaded config that could drift from it. Every caller that wants the old
CLI-equivalent behaviour (state change -> dashboard refresh) should construct its engine through
this factory instead of calling `OrchestrationEngine(...)` directly with an ad hoc `on_change`.
"""
from __future__ import annotations

from pathlib import Path

from ..presentation.publish import generate_dashboard
from ..engine import OrchestrationEngine


def build_engine(root: str | Path | None = None, *, config_path: str | Path | None = None) -> OrchestrationEngine:
    """Construct an `OrchestrationEngine` whose `on_change` regenerates the dashboard.

    The dashboard is rendered with `engine.config` — the same config the engine loaded for
    itself from `config_path` — never a second, independently loaded config dict.
    """
    engine = OrchestrationEngine(root, config_path=config_path)
    engine._on_change = lambda: generate_dashboard(engine.state_root, config=engine.config)
    return engine

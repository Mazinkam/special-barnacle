"""Loader and helpers for the canonical orchestration method (method.json).

`method.json` is the single source of truth for the capability vocabulary,
cost tiers, effort levels, role aliases and the three routing rules. The HT
bridge reads the same file (through a symlink) so Python and TypeScript can
never drift on these constants. Runtime config lives in config.json; runtime
state lives under ~/.local/state/coding-agent-orchestrator/.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

METHOD_PATH = Path(__file__).with_name("method.json")

# dynamic_adapter.py buckets models by cost into these historical names.
ADAPTER_TIER_NAMES = {"cheap": "cheapest", "mid": "mid", "premium": "expensive"}


@lru_cache(maxsize=1)
def load_method(path: Path | None = None) -> dict[str, Any]:
    data = json.loads((path or METHOD_PATH).read_text())
    _validate(data)
    return data


def _validate(m: dict[str, Any]) -> None:
    tiers = set(m["tiers"])
    efforts = set(m["effort_levels"])
    for cap, spec in m["capabilities"].items():
        if spec["tier"] not in tiers:
            raise ValueError(f"method.json: capability {cap!r} has unknown tier {spec['tier']!r}")
        if spec["default_effort"] not in efforts:
            raise ValueError(f"method.json: capability {cap!r} has unknown effort {spec['default_effort']!r}")
    for role, cap in m["roles"].items():
        if cap not in m["capabilities"]:
            raise ValueError(f"method.json: role {role!r} maps to undeclared capability {cap!r}")
    for risk, spec in m["rules"]["review_after_fix"]["escalation_by_risk"].items():
        if spec["tier_min"] not in tiers:
            raise ValueError(f"method.json: review_after_fix[{risk}] has unknown tier {spec['tier_min']!r}")


def capabilities() -> list[str]:
    return list(load_method()["capabilities"])


def tier_of(capability: str) -> str | None:
    spec = load_method()["capabilities"].get(capability)
    return spec["tier"] if spec else None


def adapter_tier_targets() -> dict[str, str]:
    """capability -> cheapest|mid|expensive, the vocabulary dynamic_adapter.py uses."""
    return {cap: ADAPTER_TIER_NAMES[spec["tier"]] for cap, spec in load_method()["capabilities"].items()}


def effort_levels() -> list[str]:
    return list(load_method()["effort_levels"])


def default_effort(capability: str, fallback: str = "standard") -> str:
    spec = load_method()["capabilities"].get(capability)
    return spec["default_effort"] if spec else fallback


def default_efforts() -> dict[str, str]:
    return {cap: spec["default_effort"] for cap, spec in load_method()["capabilities"].items()}


def roles() -> dict[str, str]:
    return dict(load_method()["roles"])


def rule(name: str) -> dict[str, Any]:
    return load_method()["rules"][name]


def rereview_floor(risk: str) -> dict[str, Any]:
    """Rule 1: minimum re-review package for the given risk (falls back to 'medium')."""
    table = rule("review_after_fix")["escalation_by_risk"]
    return dict(table.get(risk) or table["medium"])


def recon_workers(complexity: float, task_class: str | None = None) -> int:
    """Rule 2: number of pre-implementation recon workers; 0 means skip recon."""
    r = rule("pre_implementation_recon")
    if task_class in r["skip_for_task_classes"] or complexity < r["min_complexity"]:
        return 0
    for band in r["workers_by_complexity"]:
        if band["min"] <= complexity <= band["max"]:
            return int(band["workers"])
    return int(r["workers_by_complexity"][-1]["workers"])

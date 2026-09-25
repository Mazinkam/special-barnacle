"""Loader and helpers for the canonical orchestration method (method.json).

`method.json` is the single source of truth for the capability vocabulary,
cost tiers, effort levels, role aliases and the three routing rules. The HT
bridge reads the same file (through a symlink) so Python and TypeScript can
never drift on these constants. Runtime config lives in config.json; runtime
state lives under ~/.local/state/coding-agent-orchestrator/.
"""
from __future__ import annotations

import copy
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

METHOD_PATH = Path(__file__).with_name("method.json")

# dynamic_adapter.py buckets models by cost into these historical names.
# frontier shares the "expensive" bucket: the dynamic adapter has no finer cost band.
ADAPTER_TIER_NAMES = {"cheap": "cheapest", "mid": "mid", "premium": "expensive", "frontier": "expensive"}

LEAD_SIZE_ORDER = ["small", "standard", "large"]


@lru_cache(maxsize=1)
def _load_method_cached(path: Path | None = None) -> dict[str, Any]:
    data = json.loads((path or METHOD_PATH).read_text())
    _validate(data)
    return data


def load_method(path: Path | None = None) -> dict[str, Any]:
    """Return method.json's parsed contents, memoized by path (it never changes mid-process).

    Returns a deep copy of the memoized parse: `_load_method_cached` is shared across every
    caller, so returning the cached object itself would let one caller's in-place edit (e.g.
    `load_method()['tiers'].append(...)` in a test) leak into every other caller for the rest of
    the process. The parse is small, so copying it on every call is cheap relative to reloading
    the file.
    """
    return copy.deepcopy(_load_method_cached(path))


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
    for cap in m.get("capability_personas", {}):
        if cap not in m["capabilities"]:
            raise ValueError(f"method.json: capability_personas key {cap!r} is not a declared capability")
    for thinking, effort in m.get("effort_aliases", {}).items():
        if effort not in efforts:
            raise ValueError(f"method.json: effort_aliases[{thinking!r}] has unknown effort {effort!r}")
    for risk, spec in m["rules"]["review_after_fix"]["escalation_by_risk"].items():
        if spec["tier_min"] not in tiers:
            raise ValueError(f"method.json: review_after_fix[{risk}] has unknown tier {spec['tier_min']!r}")
    ls = m["rules"].get("lead_sizing")
    if ls:
        for size, cap in ls["sizes"].items():
            if size not in LEAD_SIZE_ORDER:
                raise ValueError(f"method.json: lead_sizing has unknown size {size!r}")
            if cap not in m["capabilities"]:
                raise ValueError(f"method.json: lead_sizing size {size!r} maps to undeclared capability {cap!r}")
        for band in ls["by_complexity"]:
            if band["size"] not in ls["sizes"]:
                raise ValueError(f"method.json: lead_sizing band {band!r} has unknown size")
        for risk, size in ls["risk_floor"].items():
            if size not in ls["sizes"]:
                raise ValueError(f"method.json: lead_sizing risk_floor[{risk}] has unknown size {size!r}")
    cap = m["rules"].get("dispatch_spend_cap")
    if cap and cap["mode"] not in ("off", "warn", "enforce"):
        raise ValueError(f"method.json: dispatch_spend_cap has unknown mode {cap['mode']!r}")
    _validate_rule_efforts_and_tiers(m["rules"], efforts, tiers)


def _validate_rule_efforts_and_tiers(node: Any, efforts: set[str], tiers: set[str], path: str = "rules") -> None:
    """Recursively check every rules key ending in `_effort`/named `effort` against
    effort_levels, and every key ending in `_tier`/`_tiers` against tiers."""
    if isinstance(node, dict):
        for key, value in node.items():
            cur_path = f"{path}.{key}"
            if (key == "effort" or key.endswith("_effort")) and isinstance(value, str):
                if value not in efforts:
                    raise ValueError(f"method.json: {cur_path} has unknown effort {value!r}")
            elif key.endswith("_tier") or key.endswith("_tiers"):
                candidates = value if isinstance(value, list) else [value]
                for candidate in candidates:
                    if isinstance(candidate, str) and candidate not in tiers:
                        raise ValueError(f"method.json: {cur_path} has unknown tier {candidate!r}")
            _validate_rule_efforts_and_tiers(value, efforts, tiers, cur_path)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            _validate_rule_efforts_and_tiers(item, efforts, tiers, f"{path}[{i}]")


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


def capability_personas() -> dict[str, str]:
    """Capability -> persona overrides for capabilities whose persona file is not
    simply `orch-<capability>`. Mirrors bridge/extensions/orchestrator/index.ts'
    agentNameFor."""
    return dict(load_method().get("capability_personas", {}))


def effort_aliases() -> dict[str, str]:
    """HT thinking level -> method.json effort vocabulary. Mirrors
    bridge/extensions/orchestrator/index.ts' methodEffortFor."""
    return dict(load_method().get("effort_aliases", {}))


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


def lead_size(complexity: float, risk: str, override: str | None = None) -> str:
    """Lead sizing: max(complexity band, risk floor); a valid override wins.

    Mirrors bridge/extensions/orchestrator/lead-sizing.ts. Complexity is clamped
    to 1..10 (non-numeric/NaN -> 5); an unknown risk uses the medium floor.
    """
    r = rule("lead_sizing")
    if override in LEAD_SIZE_ORDER:
        return override
    try:
        c = float(complexity)
    except (TypeError, ValueError):
        c = 5.0
    if not math.isfinite(c):  # NaN / +-inf, like the bridge's Number.isFinite guard
        c = 5.0
    # Half-up rounding to match JavaScript Math.round (Python's round() is half-even).
    c = max(1.0, min(10.0, float(math.floor(c + 0.5))))
    band = next((b["size"] for b in r["by_complexity"] if b["min"] <= c <= b["max"]), r["by_complexity"][-1]["size"])
    floor = r["risk_floor"].get(risk, r["risk_floor"]["medium"])
    return max(band, floor, key=LEAD_SIZE_ORDER.index)

#!/usr/bin/env python3
"""Dynamic capability -> model resolver for the orchestrator.

The orchestrator's adapter was previously a static dict hardcoding model IDs
like `amazon-bedrock/anthropic.claude-sonnet-5`. That assumed every installation
had those specific models configured in `models-store.json`. It also ignored
the full humain-node catalog — meaning models like `glm-5.2`, `kimi-k3`, and
`humain-m3-research-preview` were invisible even when they were reachable.

This module reads:
  1. `~/.humain-terminal/agent/models-store.json` — what's CONFIGURED in HT
  2. `data/humain_node_catalog.json` — what's AVAILABLE in the catalog
and emits a capability -> best-model mapping, ranked by cost tier, constrained
to the intersection (must be both configured AND in the catalog — and
`supports_function_calling` must be true, since the orchestrator uses tool
dispatch).

Usage: python3 dynamic_adapter.py [--json] [--explain]
  --json    emit the resolved adapter as JSON
  --explain emit the per-capability selection reasoning
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

# These capability tiers match the orchestrator's DEFAULT_PACKAGES
# (orchestrator/scheduler.py) and the policy_overlay.json routing rules.
# The bucketing is by (blended_cost, output_cost) percentile — cheapest
# tier wins for cheap capabilities, priciest for premium.
CAPABILITY_TIER_TARGET = {
    "implementation_fast":  "cheapest",
    "worker":               "cheapest",
    "scout":                "cheapest",
    "analysis_mid":         "mid",
    "technical_lead":       "mid",
    "implementation_strong":"mid",
    "technical_review":     "mid",
    "integration_review":   "mid",
    "migration_review":     "mid",
    "performance_review":   "mid",
    "api_contract_review":  "mid",
    "analysis_strong":      "expensive",
    "architect":            "expensive",
    "security_review":      "expensive",
    "qa_agent":             "mid",
    "lead":                 "mid",
}

# Cost-tier thresholds (USD per million output tokens). Models below fall in
# the cheapest bucket, above into expensive, the rest into mid. Calibrated to
# the model catalog dated 2026-09-21.
TIER_BOUNDARIES = {
    "cheapest_output_per_mtok":  2.0,   # <= is cheapest
    "expensive_output_per_mtok": 15.0,  # >= is expensive
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_ht_store() -> dict[str, dict[str, Any]]:
    """Return {ht_provider: {model_id: {id, aliases}}} from HT's models-store.

    Each model carries its `id` plus any discovered aliases. Bedrock models are
    sometimes versioned (`anthropic.claude-haiku-4-5-20251001-v1:0`) and need
    a short-form alias to match the catalog's canonical IDs.
    """
    ht_path = Path(os.path.expanduser("~/.humain-terminal/agent/models-store.json"))
    if not ht_path.exists():
        return {}
    try:
        data = json.loads(ht_path.read_text())
    except Exception:
        return {}
    out: dict[str, dict[str, Any]] = {}
    if isinstance(data, dict):
        for provider, payload in data.items():
            if not isinstance(payload, dict):
                continue
            models = payload.get("models") or []
            if not isinstance(models, list):
                continue
            out[provider] = {}
            for m in models:
                if not isinstance(m, dict):
                    continue
                mid = m.get("id")
                if not mid:
                    continue
                aliases = set()
                # Bedrock models in HT often have version/region suffixes the
                # catalog doesn't. Strip them when we recognize a claude/
                # nova / titan family.
                aliases.update(_bedrock_aliases(mid))
                out[provider][mid] = {"id": mid, "aliases": aliases}
    return out


def _bedrock_aliases(model_id: str) -> set[str]:
    """Generate alias candidates for a bedrock model id.

    Strips version suffixes, date suffixes, and region prefixes to produce
    shorter forms that match the catalog's canonical IDs. Examples:
      anthropic.claude-haiku-4-5-20251001-v1:0  -> claude-haiku-4-5
      anthropic.claude-sonnet-5                  -> claude-sonnet-5
      amazon.nova-pro-v1:0                       -> amazon.nova-pro
      us.anthropic.claude-sonnet-5               -> claude-sonnet-5
      us.openai.gpt-5.6-luna                     -> gpt-5.6-luna
      claude-haiku-4-5-20251001-v1:0             -> claude-haiku-4-5
    """
    import re
    aliases: set[str] = set()
    mid = model_id.strip()
    # Remove a leading region prefix (us., eu., apac., global., au., jp.)
    for prefix in ("us.", "eu.", "apac.", "global.", "au.", "jp."):
        if mid.startswith(prefix):
            mid = mid[len(prefix):]
            aliases.add(mid)
    # Strip the `:0` revision suffix
    if mid.endswith(":0"):
        mid = mid[:-2]
        aliases.add(mid)
    # Strip `-vN:0` or `-vN` trailing version markers. Loop in case multiple
    # passes are needed (e.g. after the :0 strip, `-v1:0` becomes `-v1`).
    for _ in range(3):
        m = re.match(r"^(.*?)-v\d+(:\d+)?$", mid)
        if m:
            mid = m.group(1)
            aliases.add(mid)
        else:
            break
    # Strip trailing `-YYYYMMDD` dates (Anthropic-style)
    m = re.match(r"^(.+?)-(\d{8})$", mid)
    if m and m.group(2).isdigit():
        mid = m.group(1)
        aliases.add(mid)
    # Strip vendor prefix (`anthropic.`, `amazon.`) to land on the canonical
    # short form the catalog uses: `claude-...`, `nova-...`.
    for prefix in ("anthropic.", "amazon.", "stability.", "cohere.", "ai21.", "meta.", "openai."):
        if mid.startswith(prefix):
            short = mid[len(prefix):]
            aliases.add(short)
    return {a for a in aliases if a}


def load_catalog() -> list[dict[str, Any]]:
    path = _repo_root() / "data" / "humain_node_catalog.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except Exception:
        return []
    items = data.get("items") if isinstance(data, dict) else data
    return [m for m in items if isinstance(m, dict) and m.get("id")]


def resolve_models() -> dict[str, dict[str, Any]]:
    """Compute the intersection: configured AND catalog AND dispatchable.

    The catalog's `supports_function_calling` field is sometimes `None` (treated
    as "unknown" by the upstream). For chat-style interfaces, treat `None` as
    a likely-true signal — the orchestrator only routes tool-calling work to
    dispatch.

    Provider selection is not first-match-wins on the alias map — we prefer
    the HT-side provider whose registered model id most closely matches the
    catalog's backing provider_ids. Without this, iterating openai-codex →
    amazon-bedrock → humain-node overwrites `gpt-5.6-luna`'s alias so the
    resolver always picks amazon-bedrock even when humain-node has the same
    model. We score by:
      1. Provider id overlap: an HT provider name that also appears in the
         catalog's `provider_ids` (e.g. catalog says `humain-fuse`, HT has
         `humain-node` — different strings, but for chat models served via
         the HUMAIN gateway, `humain-node` is the correct target).
      2. humain-node wins by default as the universal HUMAIN gateway.
      3. Fall back to first match.
    """
    ht = load_ht_store()
    catalog = load_catalog()

    by_id: dict[str, dict[str, Any]] = {}
    for m in catalog:
        if m.get("supports_function_calling") is False:
            continue
        api_iface = m.get("api_interface", "")
        if api_iface not in ("chat_completions", "anthropic_messages", "responses"):
            continue
        catalog_id = m["id"]
        catalog_pids = set(m.get("provider_ids") or [])

        # For each HT provider, check whether ANY model under it resolves to
        # this catalog id. Score each match and keep the best.
        best_score = None
        best_provider = None
        best_ht_model_id = None
        for provider, models in ht.items():
            for mid, info in models.items():
                aliases = info.get("aliases", set()) | {mid}
                if catalog_id not in aliases:
                    continue
                # Score: 0 if the HT provider name matches a catalog
                # provider_id exactly, 1 if `humain-node` (universal gateway),
                # 2 otherwise.
                if provider in catalog_pids:
                    score = 0
                elif provider == "humain-node":
                    score = 1
                else:
                    score = 2
                if best_score is None or score < best_score:
                    best_score = score
                    best_provider = provider
                    best_ht_model_id = mid
                # Stop early on perfect score
                if best_score == 0:
                    break
            if best_score == 0:
                break

        if best_provider is None:
            continue

        out = dict(m)
        out["ht_provider"] = best_provider
        out["ht_model_id"] = best_ht_model_id
        by_id[catalog_id] = out
    return by_id


def tier_for(model: dict[str, Any]) -> str:
    out_cost = float(model.get("output_cost_per_m") or 0)
    if out_cost <= TIER_BOUNDARIES["cheapest_output_per_mtok"]:
        return "cheapest"
    if out_cost >= TIER_BOUNDARIES["expensive_output_per_mtok"]:
        return "expensive"
    return "mid"


def provider_for_model(model: dict[str, Any]) -> str | None:
    """Return the HT-side provider name (NOT the catalog's provider_ids).

    HT's subagent tool uses its own config keys (`amazon-bedrock`, `openai-codex`)
    as the routing target, not the catalog's backing-provider ids. The resolver
    already did the alias-walk to determine ht_provider; prefer that.
    """
    if model.get("ht_provider"):
        return str(model["ht_provider"])
    pids = model.get("provider_ids") or []
    if isinstance(pids, list) and pids:
        return str(pids[0])
    return None


def resolve_adapter() -> dict[str, dict[str, Any]]:
    """Build capability -> {provider, model, output_cost_per_m, tier, source}."""
    models = resolve_models()
    if not models:
        return {}

    # Group models by tier
    by_tier: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for m in models.values():
        by_tier[tier_for(m)].append(m)

    # Within a tier, prefer the model with the largest context window (most
    # capable given equal cost) and lowest output cost (cheapest given equal
    # capability). Sort key is a tuple: (-context, output_cost, input_cost).
    def sort_key(m: dict[str, Any]) -> tuple[int, float, float, str]:
        ctx = -(m.get("max_context_tokens") or 0)
        out_cost = float(m.get("output_cost_per_m") or 0)
        in_cost = float(m.get("input_cost_per_m") or 0)
        name = str(m.get("id") or "")
        return (ctx, out_cost, in_cost, name)

    for tier_models in by_tier.values():
        tier_models.sort(key=sort_key)

    chosen: dict[str, dict[str, Any]] = {}
    explanations: dict[str, list[str]] = {}

    for cap, target_tier in CAPABILITY_TIER_TARGET.items():
        # Try target tier first; if empty, fall down to mid, then cheapest.
        candidates = (
            by_tier.get(target_tier)
            or by_tier.get("mid")
            or by_tier.get("cheapest")
            or []
        )
        if not candidates:
            explanations[cap] = ["no model available"]
            continue
        m = candidates[0]
        provider = provider_for_model(m)
        chosen[cap] = {
            "provider": provider,
            "model": m["id"],
            "display_name": m.get("display_name"),
            "input_cost_per_m": m.get("input_cost_per_m"),
            "output_cost_per_m": m.get("output_cost_per_m"),
            "max_context_tokens": m.get("max_context_tokens"),
            "tier": tier_for(m),
            "source": "dynamic_intersection",
        }
        others = [c["id"] for c in candidates[1:4]]
        notes = [f"tier={tier_for(m)}", f"output_cost_per_m={m.get('output_cost_per_m')}"]
        if others:
            notes.append(f"alternatives={others}")
        explanations[cap] = notes

    chosen["_explanations"] = explanations  # type: ignore
    return chosen


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true", help="emit resolved adapter as JSON")
    ap.add_argument("--explain", action="store_true", help="include selection reasoning")
    args = ap.parse_args()

    adapter = resolve_adapter()
    if args.json or args.explain:
        print(json.dumps(adapter, indent=2))
    else:
        # Default: print a human-readable table.
        print(f"{'capability':<24} {'tier':<12} {'provider':<20} {'model':<35} {'in$/M':>8} {'out$/M':>8}")
        print("-" * 110)
        for cap, info in sorted(adapter.items()):
            if cap.startswith("_"):
                continue
            print(
                f"{cap:<24} {info['tier']:<12} "
                f"{(info.get('provider') or '-'):<20} "
                f"{info['model']:<35} "
                f"{(info.get('input_cost_per_m') or 0):>8.2f} "
                f"{(info.get('output_cost_per_m') or 0):>8.2f}"
            )
        print()
        print("Run with --explain for per-capability selection reasoning.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

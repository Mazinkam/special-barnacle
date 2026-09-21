from __future__ import annotations
"""Token-rate pricing so runtimes without provider-reported cost are still metered.

A harness that cannot report `cost_usd` directly (Codex CLI, HUMAIN Terminal) can
report token counts instead; this module converts those into an estimated cost and
labels it as estimated. Rates live in `config.json` under `pricing`, never in code,
because they change without notice. No rate configured means no estimate: the record
stays `unmetered` rather than silently reporting a fabricated number.
"""
from pathlib import Path
from typing import Any, Optional

from .runtime import read_json

_MTOK = 1_000_000


def load_pricing(config: dict[str, Any] | None = None) -> dict[str, Any]:
    if config is None:
        config = read_json(Path(__file__).with_name('config.json'), {})
    pricing = config.get('pricing') or {}
    return pricing if isinstance(pricing, dict) else {}


def rate_for(model: str | None, pricing: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Longest-suffix-aware lookup: `us.anthropic.claude-sonnet-5` matches `claude-sonnet-5`."""
    if not model:
        return None
    models = pricing.get('models') or {}
    if not isinstance(models, dict):
        return None
    key = str(model).strip().lower()
    if key in models:
        return models[key]
    best: tuple[int, dict[str, Any]] | None = None
    for candidate, rate in models.items():
        c = str(candidate).lower()
        if c and c in key and (best is None or len(c) > best[0]):
            best = (len(c), rate)
    return best[1] if best else None


def estimate_cost_usd(*, model: str | None = None, input_tokens: Any = None, output_tokens: Any = None,
                      cached_input_tokens: Any = None, cache_write_tokens: Any = None,
                      pricing: dict[str, Any] | None = None,
                      config: dict[str, Any] | None = None) -> Optional[dict[str, Any]]:
    """Return {'cost_usd', 'cost_source', 'cost_rate_model'} or None when not estimable."""
    pricing = load_pricing(config) if pricing is None else pricing
    if pricing.get('enabled') is False:
        return None
    rate = rate_for(model, pricing)
    if not isinstance(rate, dict):
        return None

    def count(value: Any) -> int:
        try:
            n = int(value or 0)
        except (TypeError, ValueError):
            return 0
        return n if n > 0 else 0

    def price(field: str) -> float:
        try:
            return float(rate.get(field) or 0.0)
        except (TypeError, ValueError):
            return 0.0

    cached = count(cached_input_tokens)
    fresh_input = max(0, count(input_tokens) - cached)
    output = count(output_tokens)
    # Cache writes are billed above the input rate and, on long agent sessions, routinely exceed
    # fresh input. Omitting them understates cost by orders of magnitude, so they are priced
    # explicitly and are enough on their own to make a call meterable.
    cache_write = count(cache_write_tokens)
    if fresh_input + cached + output + cache_write == 0:
        return None
    cost = (fresh_input * price('input_per_mtok') + cached * price('cache_read_per_mtok')
            + cache_write * price('cache_write_per_mtok') + output * price('output_per_mtok')) / _MTOK
    return {
        'cost_usd': round(cost, 6),
        'cost_source': 'estimated-from-reported-tokens',
        'cost_rate_model': rate.get('id') or model,
    }

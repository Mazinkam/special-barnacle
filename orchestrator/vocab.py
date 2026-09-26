"""Python-only shared vocabulary (constants copied by hand across modules).

This is the Python-side complement to `contract.py`/`contract.json`: values
that don't cross the Python<->TS boundary, so they don't belong in the JSON
contract, but were still being retyped in more than one module. Each name
below documents which modules used to hold their own copy.

Two rules this module follows on purpose:

* Constants are only unified when their *values and semantics* are identical.
  Where two copies happened to use the same literal but differ in kind (a
  4-tuple vs. a 6-tuple, a set of ids vs. a dict of id -> status, 12 vs. 8),
  they keep separate names here rather than being merged into one — merging
  those would be a behaviour change, which this refactor (B1) does not make.
* `parse_iso_ts` unifies the two copies (`outcomes._dt`, `run_evidence._parse_ts`)
  behind one function, but they are NOT behaviourally identical on every input:
  `outcomes._dt(s)` called `s.replace('Z', '+00:00')` directly (no `str()`, no
  falsy guard), so a non-string value (an int, a float, a `datetime`) raised
  inside the `try` and was caught, returning `None`. `run_evidence._parse_ts(value)`
  guarded falsy input first and then called `str(value).replace(...)`, so a
  `datetime` value (whose `str()` is itself a valid, single-separator ISO-ish
  string) actually parsed successfully instead of returning `None`. `parse_iso_ts`
  below takes a `coerce_str` flag to reproduce each caller's exact behaviour
  instead of picking one and quietly changing the other's semantics.
  `archive.parse_ts` (which normalizes naive timestamps to UTC) and
  `dashboard.py`'s inner `parse_timestamp`/`history.py`'s inline weight-decay
  parse (both of which also normalize tz, with different exception handling)
  are NOT unified here — they stay where they are, as documented below.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

# --- CALL/SESSION granularity -------------------------------------------------
# `records.py` (GRANULARITIES = (CALL, SESSION, EVENT)) and
# `ingest_checkpoint.py` (GRANULARITIES = (CALL, SESSION)) both defined their
# own CALL/SESSION string constants with identical values; the GRANULARITIES
# tuples themselves differ (records.py adds EVENT) and are NOT unified here.
CALL = 'call'
SESSION = 'session'

# --- Token fields --------------------------------------------------------------
# economics.py's TOKEN_KEYS (4 keys, no reasoning/cache-write breakdown) and
# ingest_checkpoint.py's TOKEN_FIELDS (6 keys) serve different purposes and are
# kept as distinct named constants rather than merged.
ECONOMICS_TOKEN_KEYS: tuple[str, ...] = ('input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens')
INGEST_TOKEN_FIELDS: tuple[str, ...] = (
    'input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens',
    'reasoning_output_tokens', 'total_tokens',
)

# --- Terminal run tasks ---------------------------------------------------------
# archive.py's TERMINAL_TASK_IDS (a frozenset of ids) and history.py's inline
# `{'run-complete','run-failed'}` literal are identical sets and are unified
# here. run_evidence.py's TERMINAL_OUTCOME_TASKS is a *dict* mapping each id to
# a status word ('completed'/'failed') — different shape/semantics — and is
# NOT unified; it stays a separate constant in run_evidence.py.
TERMINAL_TASK_IDS: frozenset[str] = frozenset({'run-complete', 'run-failed'})

# --- ISO timestamp parsing -------------------------------------------------------


def parse_iso_ts(value: Any, *, coerce_str: bool = True) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp (`Z` suffix accepted), or return None.

    Reproduces the two previously-duplicated functions exactly, selected by `coerce_str`:

    * `coerce_str=True` (the default) matches `run_evidence._parse_ts`: falsy input
      (None, '', 0, ...) short-circuits to None, then the value is coerced with `str()`
      before `.replace('Z', '+00:00')` and `datetime.fromisoformat`. Because of the
      `str()` coercion, a `datetime` value can parse successfully here (its `str()` is
      itself an ISO-ish string).
    * `coerce_str=False` matches `outcomes._dt`: no falsy guard and no `str()` coercion —
      `.replace('Z', '+00:00')` is called on `value` itself, inside the same `try`, so a
      non-string value (None, an int, a float, a `datetime`) raises `AttributeError` (or
      `TypeError`) and is caught, always returning None.

    In both modes, a successful parse is returned exactly as `datetime.fromisoformat`
    produces it (naive stays naive, aware stays aware — no timezone normalization). Do
    not change this to normalize tz; callers that need UTC-normalized timestamps use
    `archive.parse_ts` or their own local copy instead, on purpose (see module
    docstring). Do not change the default or add a single unconditional behaviour here:
    the two modes are intentionally different (see module docstring) and each caller
    below is pinned to its own historical mode via `functools.partial`.
    """
    if coerce_str:
        if not value:
            return None
        try:
            return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        except Exception:
            return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except Exception:
        return None


# --- min_samples ------------------------------------------------------------------
# 12 in engine.py, adaptive.py, policy_simulation.py, policy_recommendations.py.
DEFAULT_MIN_SAMPLES = 12
# Same threshold as DEFAULT_MIN_SAMPLES: a scheduler recommendation should not start trusting a
# package's history with less evidence than the rest of adaptive routing requires (single source;
# see CHANGELOG.md "Unreleased" for the behaviour change from the old, unrelated literal 8).
SCHEDULER_MIN_SAMPLES = DEFAULT_MIN_SAMPLES

# --- High-risk set ------------------------------------------------------------------
# `{'high','critical'}`, used identically in adaptive.py (lines with risk checks)
# and controls.py. controls.py also has a *different* set (`{'medium','high','critical'}`)
# for integration_tests, which is left alone — it is not a copy of this constant.
HIGH_RISK: frozenset[str] = frozenset({'high', 'critical'})

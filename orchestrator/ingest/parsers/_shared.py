"""Tiny helpers shared by both per-runtime parsers, kept in a leaf module so
`humain_terminal.py`, `codex.py` and `parsers/__init__.py` can all import them without a cycle
(`parsers/__init__.py` also imports `humain_terminal`/`codex`, so those two must not import back
through `.` — they import this module directly instead).
"""
from __future__ import annotations

from typing import Any


def _int(value: Any) -> int:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _optional_str(value: Any) -> bool:
    return value is None or isinstance(value, str)

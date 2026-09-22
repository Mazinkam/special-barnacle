#!/usr/bin/env python3
"""Thin shim over `orchestrator.dynamic_adapter`.

This used to be a near-duplicate of `orchestrator/dynamic_adapter.py`. To
avoid the two drifting out of sync, this file now just bootstraps the repo
root onto `sys.path` and re-exports everything from the real implementation.

Usage: python3 scripts/dynamic_adapter.py [--json] [--explain] [--model-family NAME]
  (identical to `python3 -m orchestrator.dynamic_adapter` / `python3
  -m orchestrator.cli resolve-adapter` — see orchestrator/dynamic_adapter.py
  for the full implementation and docs.)
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from orchestrator.dynamic_adapter import *  # noqa: F401,F403
from orchestrator.dynamic_adapter import main

if __name__ == "__main__":
    raise SystemExit(main())

"""Thin wrapper around `orchestrator.cli`'s re-exported `generate_dashboard`/`cfg` (see B3,
`docs/architecture-review.md`).

Deliberately does NOT call `orchestrator.cli.main(['dashboard'])`: `main()` first constructs an
`EventStore(root)` before dispatching any command, which creates the state root and its stream
files if they don't exist yet. This script has never done that, and changing that now would be a
behaviour change this B3 step is not supposed to make (see `docs/architecture-review.md` B3:
"preserve their output"). Calling `orchestrator.cli.generate_dashboard`/`cli._root`/`cli.cfg`
directly reuses the exact same function and config resolution the CLI's `dashboard` command uses,
without `cli.main`'s extra side effect.
"""
from orchestrator.cli import _root, cfg, generate_dashboard

print(generate_dashboard(_root(), config=cfg()))

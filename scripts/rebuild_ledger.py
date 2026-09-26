"""Thin wrapper around `orchestrator.cli`'s re-exported `rebuild` (`orchestrator.state.rebuild`,
re-exported from `orchestrator.cli` — see B3, `docs/architecture-review.md`).

Deliberately does NOT call `orchestrator.cli.main(['rebuild'])`: that command also republishes the
dashboard afterward (`cli.records_cmds.handle_rebuild`), and `main()` first constructs an
`EventStore(root)` (creating the state root and its stream files if they don't exist yet). This
script has never done either of those, and changing that now would be a behaviour change this B3
step is not supposed to make (see `docs/architecture-review.md` B3: "preserve their output").
Calling `orchestrator.cli.rebuild`/`orchestrator.cli._root` directly reuses the exact same function
the CLI's `rebuild` command calls, and resolves the state root the same way the CLI does (honouring
`CODING_AGENT_ORCHESTRATOR_HOME`), without any of `cli.main`'s extra side effects.
"""
import json

from orchestrator.cli import _root, rebuild

print(json.dumps(rebuild(_root()), indent=2))

"""macOS sandbox-exec wrappers (spec §2.1). Denies reads of source checkouts/state; optional no-network."""
from __future__ import annotations

import os
from pathlib import Path

from orchestrator.core.env import default_state_root


def _quote(p: Path) -> str:
    return '"' + str(Path(p).resolve()).replace('\\', '\\\\').replace('"', '\\"') + '"'


def profile(deny_read: list[Path], allow_network: bool) -> str:
    rules = ['(version 1)', '(allow default)']
    for root in deny_read:
        rules.append(f'(deny file-read* file-write* (subpath {_quote(root)}))')
    if not allow_network:
        rules.append('(deny network*)')
        rules.append('(allow network* (local unix))')
    return '\n'.join(rules)


def sandbox_argv(argv: list[str], *, deny_read: list[Path], allow_network: bool) -> list[str]:
    return ['sandbox-exec', '-p', profile(deny_read, allow_network), *argv]


def default_deny_roots(extra: list[Path]) -> list[Path]:
    home = Path(os.path.expanduser('~'))
    return [default_state_root(), home / '.humain-terminal' / 'agent' / 'sessions', *extra]

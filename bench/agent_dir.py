"""A per-experiment humain-terminal agent directory (spec §2.2).

humain-terminal discovers personas in `<agent dir>/agents`. The user's real agent dir holds symlinks into the
live skill checkout, which the sandbox denies for tasks on this repo (personas silently fall back to the default)
and which would otherwise bypass the pinned skill copy. Each experiment therefore gets its own agent dir:
real copies of the pinned skill's personas, plus symlinks to the user's credential/model/settings files only.
No extensions (arms load the orchestrator explicitly with `-e`), no sessions, no skills.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

AGENT_DIR_ENV = 'HUMAIN_TERMINAL_CODING_AGENT_DIR'
CREDENTIAL_FILES = ('auth.json', 'oauth-accounts.json', 'models-store.json', 'models.json', 'settings.json', 'trust.json')


def agent_dir_path(experiment_root: Path) -> Path:
    return Path(experiment_root) / 'ht-agent'


def default_source() -> Path:
    env = os.environ.get(AGENT_DIR_ENV)
    return Path(os.path.expanduser(env)) if env else Path.home() / '.humain-terminal' / 'agent'


def prepare_agent_dir(experiment_root: Path, skill_root: Path, *, source: Path | None = None) -> Path:
    """Create (or refresh) the experiment's agent dir and return it."""
    out = agent_dir_path(experiment_root)
    src = Path(source) if source is not None else default_source()
    out.mkdir(parents=True, exist_ok=True)
    agents = out / 'agents'
    if agents.exists():
        shutil.rmtree(agents)
    agents.mkdir()
    personas = sorted((Path(skill_root) / 'bridge' / 'agents').glob('*.md'))
    for persona in personas:
        shutil.copyfile(persona, agents / persona.name)          # real file: readable inside the sandbox
    for name in CREDENTIAL_FILES:
        link = out / name
        if link.is_symlink() or link.exists():
            link.unlink()
        if (src / name).exists():
            link.symlink_to((src / name).resolve())
    (out / 'PREPARED.json').write_text(json.dumps({'skill_root': str(skill_root), 'source': str(src),
                                                   'personas': [p.name for p in personas]}, indent=2))
    return out

"""Benchmark task manifests (spec §2.1). One JSON file per task; hidden material lives beside it."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

SCOPE_BANDS = ('tiny', 'small', 'multi_file', 'cross_system')
RISKS = ('low', 'medium', 'high', 'critical')
SPLITS = ('dev', 'holdout')
_SHA = re.compile(r'^[0-9a-f]{40}$')


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class TaskManifest:
    id: str
    repo: str
    base_commit: str
    goal: str
    task_class: str
    scope_band: str
    risk: str
    split: str
    setup: tuple
    visible_checks: tuple
    hidden_checks: tuple
    hidden_files: str
    reference_patch: str
    protected_paths: tuple
    timeout_s: int
    source: Path


def _argv_list(value, field, problems):
    if not isinstance(value, list) or not all(isinstance(a, list) and a and all(isinstance(s, str) for s in a) for a in value):
        problems.append(f'{field} must be a list of non-empty argv string lists')
        return ()
    return tuple(tuple(a) for a in value)


def load_manifest(path: Path) -> TaskManifest:
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    p: list[str] = []
    for key in ('id', 'repo', 'goal', 'task_class', 'hidden_files', 'reference_patch'):
        if not isinstance(data.get(key), str) or not data[key].strip():
            p.append(f'{key} must be a non-empty string')
    if not isinstance(data.get('base_commit'), str) or not _SHA.match(data['base_commit']):
        p.append('base_commit must be a full 40-hex commit id')
    for key, allowed in (('scope_band', SCOPE_BANDS), ('risk', RISKS), ('split', SPLITS)):
        if data.get(key) not in allowed:
            p.append(f'{key} must be one of {allowed}')
    setup = _argv_list(data.get('setup', []), 'setup', p)
    visible = _argv_list(data.get('visible_checks', []), 'visible_checks', p)
    hidden = _argv_list(data.get('hidden_checks'), 'hidden_checks', p)
    if not hidden:
        p.append('hidden_checks must contain at least one check')
    protected = data.get('protected_paths', [])
    if not isinstance(protected, list) or not all(isinstance(s, str) for s in protected):
        p.append('protected_paths must be a list of strings')
    t = data.get('timeout_s')
    if not isinstance(t, int) or t <= 0:
        p.append('timeout_s must be a positive integer')
    if p:
        raise ManifestError(f'{path}: ' + '; '.join(p))
    return TaskManifest(data['id'], data['repo'], data['base_commit'], data['goal'], data['task_class'],
                        data['scope_band'], data['risk'], data['split'], setup, visible, hidden,
                        data['hidden_files'], data['reference_patch'], tuple(protected), t, Path(path))


def load_suite(directory: Path) -> list[TaskManifest]:
    tasks = [load_manifest(f) for f in sorted(Path(directory).glob('*.json'))]
    seen: set[str] = set()
    for t in tasks:
        if t.id in seen:
            raise ManifestError(f'duplicate id {t.id}')
        seen.add(t.id)
    return sorted(tasks, key=lambda t: t.id)

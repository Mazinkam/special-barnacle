"""Arm invocations (spec §2.2). Same binary, profile and state isolation for every arm."""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from bench.tools import primary_binary

ARMS = ('direct', 'current', 'tiered')


@dataclass(frozen=True)
class ExperimentConfig:
    experiment_id: str
    seed: int
    k: int
    binary: str
    skill_root: Path
    profiles_file: Path
    direct_model: str
    direct_thinking: str
    orchestrate_flags: tuple
    per_run_usd_cap: float
    per_run_timeout_s: int


def _model_args(model: str) -> list[str]:
    if '/' in model:
        provider, name = model.split('/', 1)
        return ['--provider', provider, '--model', name]
    return ['--model', model]


def arm_invocation(arm: str, goal: str, cfg: ExperimentConfig, experiment_root: Path) -> tuple[list[str], dict[str, str]]:
    if arm not in ARMS:
        raise ValueError(f'unknown arm {arm!r}; expected one of {ARMS}')
    state = str(Path(experiment_root) / 'state')
    env = {'CODING_AGENT_ORCHESTRATOR_HOME': state, 'HUMAIN_ORCHESTRATOR_STATE_ROOT': state,
           'HUMAIN_ORCHESTRATOR_SKILL_ROOT': str(cfg.skill_root),
           'HUMAIN_ORCHESTRATOR_PROFILES_FILE': str(cfg.profiles_file),
           'BENCH_EXPERIMENT_ID': cfg.experiment_id}
    base = [cfg.binary, '--mode', 'json', '-p', '--no-session']
    if arm == 'direct':
        return [*base, *_model_args(cfg.direct_model), '--thinking', cfg.direct_thinking,
                '--no-extensions', '--no-skills', '--no-prompt-templates', goal], env
    env['HUMAIN_ORCHESTRATOR_FOREGROUND'] = '1'
    env['HUMAIN_ORCHESTRATOR_WORKFLOW_MODE'] = 'enforce' if arm == 'tiered' else 'off'
    # load only the pinned skill copy's extension, never whatever is installed in ~/.humain-terminal
    extension = str(Path(cfg.skill_root) / 'bridge' / 'extensions' / 'orchestrator')
    return [*base, '--no-extensions', '-e', extension, ' '.join(['/orchestrate', *cfg.orchestrate_flags, goal])], env


def _read_pin(path: Path):
    raw = path.read_bytes()
    try:
        return json.loads(raw)
    except ValueError:
        return {'unparsed_sha256': hashlib.sha256(raw).hexdigest()}


def provenance(cfg: ExperimentConfig) -> dict:
    """What exactly runs: the skill copy (PINNED.json for a pinned copy, else git HEAD + dirty diff) and the
    resolved binary (plus a PINNED.json next to it or up to two directories above its directory)."""
    out: dict = {}
    pin = Path(cfg.skill_root) / 'PINNED.json'
    if pin.is_file():
        out['skill_pinned'] = _read_pin(pin)
    else:
        out['skill_head'] = subprocess.run(['git', '-C', str(cfg.skill_root), 'rev-parse', 'HEAD'],
                                           capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(['git', '-C', str(cfg.skill_root), 'diff', 'HEAD'], capture_output=True).stdout
        out['skill_dirty_sha'] = hashlib.sha256(dirty).hexdigest()
    binary = primary_binary(cfg.binary)
    out['binary_path'] = binary
    out['binary_pinned'] = None
    if binary:
        for d in list(Path(binary).parents)[:3]:
            if (d / 'PINNED.json').is_file():
                out['binary_pinned'] = _read_pin(d / 'PINNED.json')
                break
    return out


def config_fingerprint(cfg: ExperimentConfig) -> str:
    payload = json.dumps({**asdict(cfg), 'skill_root': str(cfg.skill_root), 'profiles_file': str(cfg.profiles_file),
                          **provenance(cfg),
                          'profiles_sha': hashlib.sha256(Path(cfg.profiles_file).read_bytes()).hexdigest()}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()

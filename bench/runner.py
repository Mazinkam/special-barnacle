"""Experiment runner (spec §2.3): isolated attempts, journal, budgets, resume."""
from __future__ import annotations

import json
import os
import random
import shlex
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from bench.agent_dir import prepare_agent_dir
from bench.arms import arm_invocation, config_fingerprint
from bench.contamination import scan_attempt, tool_locations
from bench.grade import grade
from bench.usage import agent_stream_cost
from bench.sandbox import sandbox_argv
from bench.prepared import SetupError, clone_tree, prepared_tree
from bench.tools import preflight_tool_isolation, task_deny_roots
from orchestrator.core.env import default_state_root


@dataclass(frozen=True)
class Attempt:
    attempt_id: str
    task_id: str
    arm: str
    k: int


def plan_attempts(task_ids, arms, k, seed) -> list[Attempt]:
    rng = random.Random(seed)
    blocks = [(t, i) for i in range(1, k + 1) for t in task_ids]
    rng.shuffle(blocks)
    out = []
    for t, i in blocks:
        order = list(arms)
        rng.shuffle(order)
        out += [Attempt(f'{t}.{a}.k{i}', t, a, i) for a in order]
    return out


def is_live_root(root: Path) -> bool:
    live = default_state_root().resolve(strict=False)
    r = Path(root).resolve(strict=False)
    return r == live or live in r.parents


def _journal(root: Path) -> tuple[Path, dict, set]:
    path = root / 'journal.jsonl'
    done, started = {}, set()
    if path.exists():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if row.get('event') == 'started':
                started.add(row['attempt_id'])
            else:
                done[row['attempt_id']] = row
    return path, done, started - set(done)


def _append(path: Path, row: dict) -> None:
    with path.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(row, sort_keys=True) + '\n')
        fh.flush()
        os.fsync(fh.fileno())


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]


def _outcome_rows(state: Path) -> list[dict]:
    from orchestrator.analytics.task_outcomes import task_outcomes
    return task_outcomes(*(_read(state / f) for f in ('metrics.jsonl', 'events.jsonl', 'outcomes.jsonl')))


def _run_cost(state: Path, known_runs: set) -> tuple[float, bool, dict]:
    """Cost/completeness of runs that appeared after the attempt began (Phase 0 task_outcomes)."""
    fresh = [r for r in _outcome_rows(state) if r['run_id'] not in known_runs]
    cost = sum(r['cost_known_usd'] or 0 for r in fresh)
    complete = bool(fresh) and all(r['cost_complete'] for r in fresh)
    return cost, complete, (fresh[-1] if fresh else {})


def _check_id(value: str, what: str) -> None:
    if not value or value.startswith('.') or any(c in value for c in ('/', '\\', '\0')):
        raise ValueError(f'unsafe {what}: {value!r}')


def run_experiment(tasks, cfg, arms, experiment_root: Path, *, approve_usd: float, sandbox: bool = True,
                   launcher=subprocess.Popen, prepared_cache: Path | None = None) -> Path:
    root = Path(experiment_root)
    cache = Path(prepared_cache) if prepared_cache is not None else root / 'prepared'
    _raise_on_sigterm()
    if is_live_root(root):
        raise ValueError('refusing to use the live state root as an experiment root')
    by_id = {t.id: t for t in tasks}
    for tid in by_id:
        _check_id(tid, 'task id')
    attempts = plan_attempts(sorted(by_id), arms, cfg.k if cfg else 0, cfg.seed if cfg else 0)
    for a in attempts:
        _check_id(a.attempt_id, 'attempt id')
    cap = cfg.per_run_usd_cap if cfg else 0.0
    if cfg is None or approve_usd < len(attempts) * cap:
        raise ValueError(f'approve at least ${len(attempts) * cap:.2f} (--approve-usd) for {len(attempts)} attempts')
    problems = preflight_tool_isolation(cfg, list(by_id.values()), root)
    if problems:
        raise ValueError('tool isolation preflight failed:\n  ' + '\n  '.join(problems))
    root.mkdir(parents=True, exist_ok=True)
    prepare_agent_dir(root, Path(cfg.skill_root))   # before any attempt: every arm reads its personas here
    fingerprint = config_fingerprint(cfg)
    journal, done, orphaned = _journal(root)
    for a in attempts:
        todo = None
        if a.attempt_id in orphaned:
            _append(journal, _infra_row(a, a.attempt_id + '-r1'))
            todo = Attempt(a.attempt_id + '-r1', a.task_id, a.arm, a.k)
        elif a.attempt_id in done:
            repl = done[a.attempt_id].get('replaced_by')
            if repl and repl not in done:   # crashed between replacement marker and its terminal row
                todo = Attempt(repl, a.task_id, a.arm, a.k)
                if repl in orphaned:        # replacement itself died: record once, do not loop
                    _append(journal, _infra_row(todo, None))
                    continue
        else:
            todo = a
        if todo is not None:
            _append(journal, _run_one(by_id[a.task_id], todo, cfg, root, fingerprint, journal, sandbox, launcher, cache))
    return journal


def _infra_row(a: Attempt, replaced_by) -> dict:
    row = {'attempt_id': a.attempt_id, 'task_id': a.task_id, 'arm': a.arm, 'k': a.k,
           'execution_status': 'infra_error', 'verdict': 'unknown'}
    if replaced_by:
        row['replaced_by'] = replaced_by
    return row


def _attempt_cost(arm: str, work: Path, state: Path, known) -> tuple:
    """(cost, complete, orchestrator run row). The direct arm has no orchestrator telemetry: its cost comes
    from its own --mode json stream (bench/usage.py); unknown stays None, never 0."""
    if arm == 'direct':
        cost, complete = agent_stream_cost(work / 'agent.jsonl')
        return cost, complete, {}
    return _run_cost(state, known)


def _run_one(task, a: Attempt, cfg, root: Path, fingerprint: str, journal: Path, sandbox: bool, launcher,
             cache: Path) -> dict:
    _check_id(a.attempt_id, 'attempt id')
    work = root / 'attempts' / a.attempt_id
    try:
        work.resolve(strict=False).relative_to(root.resolve())
    except ValueError:
        raise ValueError(f'refusing to use work dir outside experiment root: {work}') from None
    if work.exists():   # leftover from an interrupted run of this very attempt
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)
    argv, env = arm_invocation(a.arm, task.goal, cfg, root)
    # One snapshot + setup per task for the whole experiment (bench/prepared.py); each attempt gets a clone.
    # The prepared tree doubles as the pristine base for the grader's tamper comparison (read-only).
    try:
        base = prepared_tree(task, cache, sandbox=sandbox, deny_roots=task_deny_roots(task, root),
                             env={**attempt_base_env(), **env})
    except SetupError as exc:
        return {**_infra_row(a, None), 'infra_reason': str(exc)[:500]}
    snap = work / 'tree'
    clone_tree(base, snap)
    argv = shlex.split(argv[0]) + argv[1:]           # allows "python fake_agent.py" style binaries
    if sandbox:
        argv = sandbox_argv(argv, deny_read=task_deny_roots(task, root), allow_network=True)
    state = root / 'state'
    known = {r['run_id'] for r in _outcome_rows(state)}
    runs_before = _run_dirs(state)
    _append(journal, {'event': 'started', 'attempt_id': a.attempt_id})
    t0 = time.time()
    status = 'completed'
    with (work / 'agent.jsonl').open('wb') as out, (work / 'agent.stderr').open('wb') as err:
        marker = f'{a.attempt_id}:{os.getpid()}:{time.time_ns()}'
        proc = launcher(argv, cwd=snap, env={**attempt_base_env(), **env, ATTEMPT_ENV: marker}, stdout=out, stderr=err,
                        start_new_session=True)
        try:
            while proc.poll() is None:
                if time.time() - t0 > cfg.per_run_timeout_s:
                    status = 'timeout'
                    break
                if (_attempt_cost(a.arm, work, state, known)[0] or 0) > cfg.per_run_usd_cap:
                    status = 'budget_exceeded'
                    break
                time.sleep(0.5)
        finally:
            _kill_group(proc)
            _kill_marked(marker)
    if status == 'completed' and proc.returncode != 0:
        status = 'failed'
    elapsed_ms = int((time.time() - t0) * 1000)
    cost, complete, run = _attempt_cost(a.arm, work, state, known)
    fresh_ids = {r['run_id'] for r in _outcome_rows(state)} - known
    run_dirs = sorted((_run_dirs(state) - runs_before) | {state / 'runs' / i for i in fresh_ids if i and '/' not in i})
    contaminated, evidence = scan_attempt(work / 'agent.jsonl', [d for d in run_dirs if d.is_dir()], tool_locations(cfg))
    verdict, digest = 'unknown', None
    if status in ('completed', 'failed'):
        g = grade(task, snap, base, work / 'grade', sandbox=sandbox)
        verdict, digest = g.verdict, g.tree_digest
        (work / 'grade.json').write_text(json.dumps(g.__dict__, default=str, indent=2))
    return {'attempt_id': a.attempt_id, 'task_id': a.task_id, 'arm': a.arm, 'k': a.k, 'execution_status': status,
            'verdict': verdict, 'elapsed_ms': elapsed_ms, 'cost_usd': cost, 'cost_complete': complete,
            'fix_rounds': run.get('fix_rounds'), 'provider_retries': run.get('provider_retries'),
            'run_id': run.get('run_id'), 'tree_digest': digest, 'config_fingerprint': fingerprint,
            'scope_band': task.scope_band, 'risk': task.risk, 'split': task.split,
            'contaminated': contaminated, 'contamination_evidence': evidence}


def _run_dirs(state: Path) -> set:
    runs = state / 'runs'
    return {d for d in runs.iterdir() if d.is_dir()} if runs.is_dir() else set()


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


ATTEMPT_ENV = 'BENCH_ATTEMPT_MARKER'
_SESSION_PREFIXES = ('PI_', 'HUMAIN_TERMINAL_')


def attempt_base_env() -> dict:
    """The runner's environment minus the launching humain-terminal session (PI_*, HUMAIN_TERMINAL_*).

    Launched from inside an HT session, the runner inherited PI_PACKAGE_DIR (the real HT checkout: the task's
    own tests read it and hit the sandbox) and the session id/file/model/provider. Each agent must start as if
    from a clean terminal; the arm sets the one HT variable it needs (the experiment agent dir).
    """
    return {k: v for k, v in os.environ.items() if not k.startswith(_SESSION_PREFIXES)}


def _raise_on_sigterm() -> None:
    """Make `kill <runner>` unwind like Ctrl-C, so every attempt's cleanup (`finally`) runs."""
    import threading
    if threading.current_thread() is threading.main_thread():
        def _handler(signum, frame):
            raise KeyboardInterrupt(f'signal {signum}')
        signal.signal(signal.SIGTERM, _handler)


def _marked_pids(marker: str) -> list[int]:
    """Processes whose environment carries this attempt's marker. Bridge children run detached in their own
    sessions (and are reparented to launchd once their parent exits), so process-group and parent links
    miss them; the inherited environment does not. Requires `ps -E` (macOS/BSD; same-user processes)."""
    try:
        out = subprocess.run(['ps', '-axEww', '-o', 'pid=,command='], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    needle = f'{ATTEMPT_ENV}={marker}'
    pids = []
    for line in out.splitlines():
        head, _, rest = line.strip().partition(' ')
        if head.isdigit() and int(head) != os.getpid() and any(tok == needle for tok in rest.split()):
            pids.append(int(head))
    return pids


def _kill_marked(marker: str) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        pids = _marked_pids(marker)
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, PermissionError):
                pass
        deadline = time.time() + 3
        while time.time() < deadline and _marked_pids(marker):
            time.sleep(0.1)


def _kill_group(proc) -> None:
    """Terminate the agent's whole process group (also reaps orphans of an already-exited leader)."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not _group_alive(proc.pid):
            break
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            break
        if sig == signal.SIGTERM:
            deadline = time.time() + 2
            while time.time() < deadline and (proc.poll() is None or _group_alive(proc.pid)):
                time.sleep(0.05)
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        pass

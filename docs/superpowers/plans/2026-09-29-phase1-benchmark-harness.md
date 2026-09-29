# Phase 1 — Benchmark and Experiment Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible, leak-resistant harness that runs benchmark tasks through the `direct`, `current` and `tiered` arms, grades them in a trusted environment, and reports paired pass/time/cost/iteration results with honest uncertainty.

**Architecture:** A small Python package `bench/` at the repo root (dev tooling, not shipped in the wheel) plus thin `scripts/bench_*.py` entry points. Each attempt gets a history-free snapshot of the task's base tree, runs under a macOS `sandbox-exec` profile that denies reads of source checkouts and orchestrator state, and writes into an isolated experiment root. Grading happens in a separate copy with hidden checks and no network. Two small bridge fixes make `/orchestrate` scriptable: honour the canonical state-root variable and add a foreground mode.

**Tech Stack:** Python 3.9+ stdlib, `git`, macOS `sandbox-exec`, `humain-terminal` CLI (`--mode json -p --no-session`), Bun for bridge tests.

**Spec:** `docs/superpowers/specs/2026-09-29-tiered-workflows-and-eval-design.md` (Section 2). Depends on Phase 0's `task_outcome` fields (`orchestrator/analytics/task_outcomes.py`, `fix_rounds`, `usage_scope`) — see `docs/superpowers/plans/2026-09-29-phase0-trustworthy-measurement.md`. The `tiered` arm needs Phase 2's `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE=enforce` switch; until Phase 2 lands, the runner rejects `tiered` with a clear error.

## Global Constraints

- Python `>=3.9`; ruff `E9,F,B`; no new dependencies.
- `bench/` is not added to `[tool.setuptools.packages.find]`; it is repo-local tooling imported by tests via the repo root on `sys.path` (`python3 -m pytest` from the repo root).
- No model spend in CI or unit tests. Paid runs require an explicit `--approve-usd` greater than or equal to the printed estimate.
- Experiment writes go only under `--experiment-root`; never the live state root. The runner refuses a root equal to `default_state_root()`.
- Worktrees are never the isolation boundary. Agents see only a snapshot with one synthetic base commit, no remotes, no hooks.
- Hidden checks, reference patches and task manifests live outside any path readable inside the agent sandbox.
- Repo tests and setup are untrusted code: grading runs them under a no-network sandbox with timeouts.
- `bridge/extensions/orchestrator/index.ts` has unrelated uncommitted edits: stage only this plan's hunk with `git add -p`.
- All failed, capped, crashed and replaced attempts are kept in the journal and counted in denominators.

## Review Focus

1. A task whose base already passes its hidden check, or whose reference fails it, must be rejected by task validation, not silently benchmarked — Task 3.
2. An agent reading a denied path (e.g. the real source checkout containing the future solution) must fail inside the sandbox — Task 5 canary test.
3. A killed/timed-out attempt must still produce a journal entry with `execution_status = timeout` and its partial cost, and a resumed runner must not re-run or drop it — Task 8.
4. A comparison where every task passes in both arms (zero variance) must return `inconclusive`, not a confident `pass` — Task 9.
5. An experiment root that resolves to the live state root (including via symlink) must be refused — Task 8.

---

### Task 1: Bridge honours the canonical state root

`index.ts:166` reads only `HUMAIN_ORCHESTRATOR_STATE_ROOT`, ignoring `CODING_AGENT_ORCHESTRATOR_HOME`, so an experiment cannot redirect run logs and telemetry with the canonical variable.

**Files:**
- Modify: `bridge/extensions/orchestrator/config.ts` (export `resolveStateRoot`, currently a private `function resolveStateRoot(env: BridgeEnv): string` ~line 121)
- Modify: `bridge/extensions/orchestrator/index.ts:166-168`
- Test: `bridge/extensions/orchestrator/config.test.ts`

**Interfaces:**
- Produces: `export function resolveStateRoot(env: BridgeEnv): string` (canonical → aliases → contract default).

- [ ] **Step 1: Failing test** — append to `config.test.ts`:

```ts
import { resolveStateRoot } from "./config.ts";

describe("resolveStateRoot", () => {
	test("canonical variable wins over the deprecated alias", () => {
		expect(resolveStateRoot({ CODING_AGENT_ORCHESTRATOR_HOME: "/exp/a", HUMAIN_ORCHESTRATOR_STATE_ROOT: "/old" })).toBe("/exp/a");
	});
	test("alias is used when canonical is unset", () => {
		expect(resolveStateRoot({ HUMAIN_ORCHESTRATOR_STATE_ROOT: "/old" })).toBe("/old");
	});
});
```

(If `describe`/`test`/`expect` are not yet imported in that file, add `import { describe, expect, test } from "bun:test";`.)

- [ ] **Step 2: Run** `cd bridge/extensions/orchestrator && bun test config.test.ts` — Expected: FAIL (`resolveStateRoot` is not exported).

- [ ] **Step 3: Implement** — in `config.ts` change `function resolveStateRoot(` to `export function resolveStateRoot(`. In `index.ts` replace:

```ts
const STATE_ROOT =
	process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT ??
	"~/.local/state/coding-agent-orchestrator";
```

with:

```ts
// One resolver for both runtimes (config.ts / orchestrator/core/env.py): canonical
// CODING_AGENT_ORCHESTRATOR_HOME, then aliases, then the contract default.
const STATE_ROOT = resolveStateRoot(process.env);
```

and add `resolveStateRoot` to the existing `./config.ts` import in `index.ts` (search `from "./config.ts"`).

- [ ] **Step 4: Run** `bun test && cd - && bash scripts/typecheck-bridge.sh` — Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/extensions/orchestrator/config.ts bridge/extensions/orchestrator/config.test.ts
git add -p bridge/extensions/orchestrator/index.ts   # only the STATE_ROOT + import hunks
git commit -m "fix(bridge): resolve state root via canonical CODING_AGENT_ORCHESTRATOR_HOME"
```

---

### Task 2: Foreground `/orchestrate` for headless runs

`/orchestrate` returns immediately and runs detached; print mode then disposes the runtime and the shutdown hook cancels the run. Add an opt-in env switch that makes the command handler await the run. Print mode already awaits `command.handler` (`humain-terminal/packages/coding-agent/src/core/agent-session.ts:1851`).

**Files:**
- Modify: `bridge/extensions/orchestrator/commands/orchestrate.ts` (after `session.runPromise = runPromise;` ~line 750)
- Test: `bridge/extensions/orchestrator/commands/orchestrate.test.ts`

**Interfaces:**
- Produces: env `HUMAIN_ORCHESTRATOR_FOREGROUND=1` ⇒ handler resolves only after the run settles. Default unchanged.

- [ ] **Step 1: Failing test** — in `commands/orchestrate.test.ts`, inside the existing `describe("commands/orchestrate.ts: a successful claim reaches runOrchestration (A1 review fixes)", …)` block (it already resets the seam in `afterEach`), add:

```ts
	test("HUMAIN_ORCHESTRATOR_FOREGROUND=1 makes the handler await the run", async () => {
		const { pi, getHandler } = fakePi();
		const session = fakeRunSessionLike("placeholder");
		const { deps } = baseDeps({
			resolveAdapter: async () => healthyResolution(fakeAdapter()),
			createSession: () => session,
			env: { HUMAIN_ORCHESTRATOR_FOREGROUND: "1" },
		});
		registerOrchestrateCommand(pi, deps);
		const { ctx } = fakeCtx();
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		let finished = false;
		setRunOrchestrationForTest(async () => { await gate; finished = true; return { kind: "aborted" }; });

		let settled = false;
		const handlerDone = getHandler()("fix the login race", ctx).then(() => { settled = true; });
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);
		release();
		await handlerDone;
		expect(finished).toBe(true);
	});

	test("without the switch the handler returns before the run settles", async () => {
		const { pi, getHandler } = fakePi();
		const { deps } = baseDeps({
			resolveAdapter: async () => healthyResolution(fakeAdapter()),
			createSession: () => fakeRunSessionLike("placeholder"),
			env: {},
		});
		registerOrchestrateCommand(pi, deps);
		const { ctx } = fakeCtx();
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		setRunOrchestrationForTest(async () => { await gate; return { kind: "aborted" }; });
		await getHandler()("fix the login race", ctx);   // resolves while the run is still gated
		release();
	});
```

If `baseDeps`'s `OrchestrateDeps` requires other fields for `env` (check `baseDeps` ~line 117), pass the same shape it already uses.

- [ ] **Step 2: Run** `bun test commands/orchestrate.test.ts` — Expected: FAIL (`settled` is `true` before `release()`).

- [ ] **Step 3: Implement** — after the existing `runPromise.catch(...)` block add:

```ts
			// Headless callers (benchmark runner, CI) opt in to waiting for the run so print mode
			// does not dispose the runtime — and cancel the run via session_shutdown — mid-flight.
			if (deps.env.HUMAIN_ORCHESTRATOR_FOREGROUND === "1") {
				await runPromise.catch(() => undefined);
			}
```

- [ ] **Step 4: Run** `bun test && cd - && bash scripts/typecheck-bridge.sh` — Expected: PASS.

- [ ] **Step 5: Manual smoke (no spend check first)** — `HUMAIN_ORCHESTRATOR_FOREGROUND=1 CODING_AGENT_ORCHESTRATOR_HOME=$(mktemp -d) humain-terminal --mode json -p --no-session "/orchestrate --help"` should exit without starting a run. Record the observed behaviour in the commit message; a paid real-goal smoke is Task 11.

- [ ] **Step 6: Commit**

```bash
git add bridge/extensions/orchestrator/commands/orchestrate.ts bridge/extensions/orchestrator/commands/orchestrate.test.ts
git commit -m "feat(bridge): HUMAIN_ORCHESTRATOR_FOREGROUND=1 awaits /orchestrate for headless runs"
```

---

### Task 3: Task manifest schema and validation

**Files:**
- Create: `bench/__init__.py` (empty), `bench/manifest.py`
- Test: `tests/test_bench_manifest.py`

**Interfaces:**
- Produces:

```python
@dataclass(frozen=True)
class TaskManifest:
    id: str; repo: str; base_commit: str; goal: str
    task_class: str; scope_band: str; risk: str; split: str
    setup: tuple[tuple[str, ...], ...]          # argv lists, run in the snapshot before the agent
    visible_checks: tuple[tuple[str, ...], ...] # argv lists the agent may also run
    hidden_checks: tuple[tuple[str, ...], ...]  # argv lists, grader only
    hidden_files: str                            # dir (relative to manifest) overlaid at grading
    reference_patch: str                         # path (relative to manifest), analysis/validation only
    protected_paths: tuple[str, ...]             # repo paths the agent must not modify (e.g. tests it must satisfy)
    timeout_s: int
SCOPE_BANDS = ('tiny', 'small', 'multi_file', 'cross_system')
RISKS = ('low', 'medium', 'high', 'critical')
SPLITS = ('dev', 'holdout')
def load_manifest(path: Path) -> TaskManifest          # raises ManifestError with every problem listed
def load_suite(directory: Path) -> list[TaskManifest]  # sorted by id; duplicate ids rejected
class ManifestError(ValueError): ...
```

- [ ] **Step 1: Failing tests** — `tests/test_bench_manifest.py`:

```python
import json
import pytest
from bench.manifest import ManifestError, load_manifest, load_suite

GOOD = {
    'id': 'forge-001', 'repo': '/src/forge', 'base_commit': 'a' * 40, 'goal': 'Fix X',
    'task_class': 'implementation', 'scope_band': 'small', 'risk': 'low', 'split': 'dev',
    'setup': [['bun', 'install']], 'visible_checks': [['bun', 'test']], 'hidden_checks': [['bun', 'test', 'hidden.test.ts']],
    'hidden_files': 'hidden', 'reference_patch': 'reference.patch', 'protected_paths': ['hidden.test.ts'], 'timeout_s': 1800,
}

def write(tmp_path, name, data):
    p = tmp_path / name; p.write_text(json.dumps(data)); return p

def test_valid_manifest_loads(tmp_path):
    m = load_manifest(write(tmp_path, 'forge-001.json', GOOD))
    assert m.scope_band == 'small' and m.hidden_checks == (('bun', 'test', 'hidden.test.ts'),)

@pytest.mark.parametrize('field,value', [('scope_band', 'huge'), ('risk', 'meh'), ('split', 'train'),
                                         ('base_commit', 'HEAD'), ('hidden_checks', []), ('timeout_s', 0)])
def test_invalid_fields_rejected(tmp_path, field, value):
    with pytest.raises(ManifestError, match=field):
        load_manifest(write(tmp_path, 'x.json', {**GOOD, field: value}))

def test_suite_rejects_duplicate_ids(tmp_path):
    write(tmp_path, 'a.json', GOOD); write(tmp_path, 'b.json', GOOD)
    with pytest.raises(ManifestError, match='duplicate id'):
        load_suite(tmp_path)
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_manifest.py` — Expected: FAIL (`ModuleNotFoundError: bench`).

- [ ] **Step 3: Implement** `bench/manifest.py`:

```python
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
```

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_manifest.py` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bench/__init__.py bench/manifest.py tests/test_bench_manifest.py && git commit -m "feat(bench): task manifest schema and validation"`

---

### Task 4: History-free snapshots

**Files:**
- Create: `bench/snapshot.py`
- Test: `tests/test_bench_snapshot.py`

**Interfaces:**
- Produces: `make_snapshot(repo: Path, commit: str, dest: Path) -> SnapshotInfo` where `SnapshotInfo(path: Path, tree_sha: str, base_commit_in_snapshot: str)`; `tree_digest(path: Path) -> str` (sha256 over sorted relative paths + file bytes, excluding `.git`).

- [ ] **Step 1: Failing tests**

```python
import subprocess
from pathlib import Path
from bench.snapshot import make_snapshot, tree_digest

def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()

def make_repo(tmp_path):
    repo = tmp_path / 'src'; repo.mkdir()
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    (repo / 'a.txt').write_text('base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
    base = git(repo, 'rev-parse', 'HEAD')
    (repo / 'a.txt').write_text('SOLUTION\n'); git(repo, 'commit', '-qam', 'future solution')
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git')
    return repo, base

def test_snapshot_has_base_content_and_no_future_history(tmp_path):
    repo, base = make_repo(tmp_path)
    info = make_snapshot(repo, base, tmp_path / 'snap')
    assert (info.path / 'a.txt').read_text() == 'base\n'
    assert git(info.path, 'rev-list', '--count', 'HEAD') == '1'
    assert git(info.path, 'remote') == ''
    assert 'SOLUTION' not in subprocess.run(['git', '-C', str(info.path), 'log', '--all', '-p'], capture_output=True, text=True).stdout

def test_tree_digest_is_stable_and_content_sensitive(tmp_path):
    repo, base = make_repo(tmp_path)
    a = make_snapshot(repo, base, tmp_path / 's1'); b = make_snapshot(repo, base, tmp_path / 's2')
    assert tree_digest(a.path) == tree_digest(b.path)
    (b.path / 'a.txt').write_text('changed\n')
    assert tree_digest(a.path) != tree_digest(b.path)
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_snapshot.py` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `bench/snapshot.py`:

```python
"""Snapshot a task's base tree with no history, remotes or hooks (spec §2.1: worktrees leak the future)."""
from __future__ import annotations

import hashlib
import io
import os
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path

_ENV = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
        'GIT_AUTHOR_NAME': 'bench', 'GIT_AUTHOR_EMAIL': 'bench@invalid', 'GIT_COMMITTER_NAME': 'bench',
        'GIT_COMMITTER_EMAIL': 'bench@invalid', 'GIT_AUTHOR_DATE': '2000-01-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00Z'}


@dataclass(frozen=True)
class SnapshotInfo:
    path: Path
    tree_sha: str
    base_commit_in_snapshot: str


def _git(cwd: Path, *args: str, stdin: bytes | None = None) -> bytes:
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(cwd), *args], input=stdin,
                          check=True, capture_output=True, env=_ENV).stdout


def make_snapshot(repo: Path, commit: str, dest: Path) -> SnapshotInfo:
    dest.mkdir(parents=True, exist_ok=False)
    archive = _git(Path(repo), 'archive', '--format=tar', commit)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            if member.name.startswith('/') or '..' in Path(member.name).parts:
                raise ValueError(f'unsafe archive member {member.name!r}')
        tar.extractall(dest)  # members validated above
    _git(dest, 'init', '-q')
    _git(dest, 'add', '-A')
    _git(dest, 'commit', '-q', '--no-verify', '-m', 'benchmark base')
    return SnapshotInfo(dest, _git(dest, 'rev-parse', 'HEAD^{tree}').decode().strip(),
                        _git(dest, 'rev-parse', 'HEAD').decode().strip())


def tree_digest(path: Path) -> str:
    h = hashlib.sha256()
    for f in sorted(p for p in Path(path).rglob('*') if p.is_file() and '.git' not in p.relative_to(path).parts):
        rel = f.relative_to(path).as_posix().encode()
        h.update(len(rel).to_bytes(4, 'big') + rel)
        data = f.read_bytes()
        h.update(len(data).to_bytes(8, 'big') + data)
    return h.hexdigest()
```

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_snapshot.py` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bench/snapshot.py tests/test_bench_snapshot.py && git commit -m "feat(bench): history-free task snapshots and tree digests"`

---

### Task 5: Sandbox profiles with a leakage canary

**Files:**
- Create: `bench/sandbox.py`
- Test: `tests/test_bench_sandbox.py`

**Interfaces:**
- Produces: `sandbox_argv(argv: list[str], *, deny_read: list[Path], allow_network: bool) -> list[str]` returning `['sandbox-exec', '-p', PROFILE, *argv]`; `default_deny_roots(extra: list[Path]) -> list[Path]` = resolved orchestrator state root, `~/.humain-terminal/agent/sessions`, plus `extra` (task repos, suite dir, experiment journal dir).

- [ ] **Step 1: Failing tests**

```python
import subprocess, sys
import pytest
from pathlib import Path
from bench.sandbox import sandbox_argv

pytestmark = pytest.mark.skipif(sys.platform != 'darwin', reason='sandbox-exec is macOS-only')

def test_denied_root_is_unreadable(tmp_path):
    secret = tmp_path / 'checkout'; secret.mkdir(); (secret / 'solution.txt').write_text('FUTURE')
    p = subprocess.run(sandbox_argv(['/bin/cat', str(secret / 'solution.txt')], deny_read=[secret], allow_network=True), capture_output=True, text=True)
    assert p.returncode != 0 and 'FUTURE' not in p.stdout

def test_allowed_path_is_readable(tmp_path):
    ok = tmp_path / 'snap'; ok.mkdir(); (ok / 'a.txt').write_text('base')
    p = subprocess.run(sandbox_argv(['/bin/cat', str(ok / 'a.txt')], deny_read=[tmp_path / 'other'], allow_network=True), capture_output=True, text=True)
    assert p.returncode == 0 and p.stdout == 'base'

def test_network_denied_when_requested():
    p = subprocess.run(sandbox_argv(['/usr/bin/curl', '-sS', '--max-time', '3', 'https://example.com'], deny_read=[], allow_network=False), capture_output=True, text=True)
    assert p.returncode != 0
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_sandbox.py` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `bench/sandbox.py`:

```python
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
```

Note: the agent itself still needs network for its model provider, so agent runs use `allow_network=True`; grading uses `allow_network=False`.

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_sandbox.py` — Expected: PASS on macOS (skipped elsewhere). If `sandbox-exec` rejects `(local unix)`, drop that line and keep the test green.

- [ ] **Step 5: Commit** `git add bench/sandbox.py tests/test_bench_sandbox.py && git commit -m "feat(bench): sandbox-exec profiles with leakage and network canaries"`

---

### Task 6: Arm definitions and frozen experiment config

**Files:**
- Create: `bench/arms.py`
- Test: `tests/test_bench_arms.py`

**Interfaces:**
- Produces:

```python
@dataclass(frozen=True)
class ExperimentConfig:
    experiment_id: str; seed: int; k: int
    binary: str                        # e.g. 'humain-terminal' or path to fake agent
    skill_root: Path                   # pinned checkout of this repo (HUMAIN_ORCHESTRATOR_SKILL_ROOT)
    profiles_file: Path                # frozen orchestrator-profiles.json copy
    direct_model: str                  # provider/model for the direct arm (same as implementation_strong binding)
    direct_thinking: str
    orchestrate_flags: tuple[str, ...] # e.g. ('--profile', 'premium', '--max-retries', '2')
    per_run_usd_cap: float; per_run_timeout_s: int
ARMS = ('direct', 'current', 'tiered')
def arm_invocation(arm: str, goal: str, cfg: ExperimentConfig, experiment_root: Path) -> tuple[list[str], dict[str, str]]
def config_fingerprint(cfg: ExperimentConfig) -> str   # sha256 of config + skill_root HEAD + profiles bytes
```

- [ ] **Step 1: Failing tests**

```python
from pathlib import Path
import pytest
from bench.arms import ExperimentConfig, arm_invocation

def cfg(tmp_path):
    (tmp_path / 'profiles.json').write_text('{}')
    return ExperimentConfig('exp1', 7, 3, 'humain-terminal', tmp_path, tmp_path / 'profiles.json',
                            'amazon-bedrock/claude-sonnet-5', 'high', ('--profile', 'premium'), 5.0, 1800)

def test_direct_arm_is_plain_single_agent(tmp_path):
    argv, env = arm_invocation('direct', 'Fix X', cfg(tmp_path), tmp_path / 'exp')
    assert argv[:4] == ['humain-terminal', '--mode', 'json', '-p']
    assert '--no-extensions' in argv and argv[-1] == 'Fix X'
    assert ['--provider', 'amazon-bedrock', '--model', 'claude-sonnet-5'] == argv[argv.index('--provider'):argv.index('--provider') + 4]

def test_orchestrated_arms_run_in_foreground_with_isolated_root(tmp_path):
    for arm, mode in (('current', 'off'), ('tiered', 'enforce')):
        argv, env = arm_invocation(arm, 'Fix X', cfg(tmp_path), tmp_path / 'exp')
        assert argv[-1] == '/orchestrate --profile premium Fix X'
        assert env['HUMAIN_ORCHESTRATOR_FOREGROUND'] == '1'
        assert env['CODING_AGENT_ORCHESTRATOR_HOME'] == str(tmp_path / 'exp' / 'state')
        assert env['HUMAIN_ORCHESTRATOR_STATE_ROOT'] == str(tmp_path / 'exp' / 'state')
        assert env['HUMAIN_ORCHESTRATOR_WORKFLOW_MODE'] == mode

def test_unknown_arm_rejected(tmp_path):
    with pytest.raises(ValueError):
        arm_invocation('forced-direct', 'x', cfg(tmp_path), tmp_path)
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_arms.py` — Expected: FAIL.

- [ ] **Step 3: Implement** `bench/arms.py`:

```python
"""Arm invocations (spec §2.2). Same binary, profile and state isolation for every arm."""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

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
    return [*base, ' '.join(['/orchestrate', *cfg.orchestrate_flags, goal])], env


def config_fingerprint(cfg: ExperimentConfig) -> str:
    head = subprocess.run(['git', '-C', str(cfg.skill_root), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(['git', '-C', str(cfg.skill_root), 'diff', 'HEAD'], capture_output=True).stdout
    payload = json.dumps({**asdict(cfg), 'skill_root': str(cfg.skill_root), 'profiles_file': str(cfg.profiles_file),
                          'skill_head': head, 'skill_dirty_sha': hashlib.sha256(dirty).hexdigest(),
                          'profiles_sha': hashlib.sha256(Path(cfg.profiles_file).read_bytes()).hexdigest()}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()
```

The orchestrated arms load the bridge extension installed in `~/.humain-terminal`. Before a paid run (Task 11), confirm the installed extension matches `skill_root` HEAD (`install.sh` output or `bridge/README.md` install notes) and record both in the experiment manifest; the runner refuses to start if they differ.

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_arms.py` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bench/arms.py tests/test_bench_arms.py && git commit -m "feat(bench): arm invocations with isolated state and config fingerprint"`

---

### Task 7: Trusted grader

**Files:**
- Create: `bench/grade.py`
- Test: `tests/test_bench_grade.py`

**Interfaces:**
- Consumes: `TaskManifest`, `sandbox_argv`, `tree_digest`.
- Produces: `grade(task: TaskManifest, submitted: Path, base: Path, work: Path, *, sandbox: bool = True) -> GradeResult` with `GradeResult(verdict: 'pass'|'fail'|'error', checks: list[dict], tampered: list[str], tree_digest: str)`. Checks run on a fresh copy of `submitted` with `hidden_files` overlaid; `protected_paths` changed relative to `base` ⇒ `tampered` non-empty ⇒ verdict `fail`.

- [ ] **Step 1: Failing tests**

```python
import json, sys
from pathlib import Path
from bench.manifest import load_manifest
from bench.grade import grade

def task(tmp_path, check):
    (tmp_path / 'hidden').mkdir(); (tmp_path / 'hidden' / 'check.py').write_text(check)
    (tmp_path / 'reference.patch').write_text('')
    m = {'id': 't1', 'repo': '/r', 'base_commit': 'a' * 40, 'goal': 'g', 'task_class': 'implementation',
         'scope_band': 'tiny', 'risk': 'low', 'split': 'dev', 'setup': [], 'visible_checks': [],
         'hidden_checks': [[sys.executable, 'check.py']], 'hidden_files': 'hidden',
         'reference_patch': 'reference.patch', 'protected_paths': ['keep.txt'], 'timeout_s': 30}
    (tmp_path / 't1.json').write_text(json.dumps(m)); return load_manifest(tmp_path / 't1.json')

def tree(root, **files):
    root.mkdir(); [(root / k.replace('__', '.')).write_text(v) for k, v in files.items()]; return root

def test_pass_when_hidden_check_passes(tmp_path):
    t = task(tmp_path, "import pathlib,sys; sys.exit(0 if pathlib.Path('a.txt').read_text()=='fixed' else 1)")
    base = tree(tmp_path / 'base', a__txt='bug', keep__txt='k'); sub = tree(tmp_path / 'sub', a__txt='fixed', keep__txt='k')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert r.verdict == 'pass' and r.tampered == []

def test_tampering_protected_path_fails(tmp_path):
    t = task(tmp_path, 'import sys; sys.exit(0)')
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='edited')
    r = grade(t, sub, base, tmp_path / 'work', sandbox=False)
    assert r.verdict == 'fail' and r.tampered == ['keep.txt']

def test_timeout_is_error_not_pass(tmp_path):
    t = task(tmp_path, 'import time; time.sleep(60)')
    t = t.__class__(**{**t.__dict__, 'timeout_s': 1})
    base = tree(tmp_path / 'base', keep__txt='k'); sub = tree(tmp_path / 'sub', keep__txt='k')
    assert grade(t, sub, base, tmp_path / 'work', sandbox=False).verdict == 'error'
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_grade.py` — Expected: FAIL.

- [ ] **Step 3: Implement** `bench/grade.py`:

```python
"""Trusted grading (spec §2.1): fresh copy, hidden files overlaid, no network, tamper check."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from bench.manifest import TaskManifest
from bench.sandbox import sandbox_argv
from bench.snapshot import tree_digest


@dataclass
class GradeResult:
    verdict: str
    checks: list = field(default_factory=list)
    tampered: list = field(default_factory=list)
    tree_digest: str = ''


def _sha(p: Path) -> str | None:
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def grade(task: TaskManifest, submitted: Path, base: Path, work: Path, *, sandbox: bool = True) -> GradeResult:
    digest = tree_digest(submitted)
    tampered = [p for p in task.protected_paths if _sha(Path(submitted) / p) != _sha(Path(base) / p)]
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(submitted, work, ignore=shutil.ignore_patterns('.git'))
    shutil.copytree(task.source.parent / task.hidden_files, work, dirs_exist_ok=True)
    checks = []
    verdict = 'pass'
    for argv in task.hidden_checks:
        cmd = sandbox_argv(list(argv), deny_read=[], allow_network=False) if sandbox else list(argv)
        try:
            p = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=task.timeout_s)
            ok = p.returncode == 0
            checks.append({'argv': list(argv), 'exit': p.returncode, 'tail': (p.stdout + p.stderr)[-2000:]})
            if not ok and verdict == 'pass':
                verdict = 'fail'
        except subprocess.TimeoutExpired:
            checks.append({'argv': list(argv), 'exit': None, 'tail': 'timeout'})
            verdict = 'error'
    if tampered and verdict == 'pass':
        verdict = 'fail'
    return GradeResult(verdict, checks, tampered, digest)
```

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_grade.py` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bench/grade.py tests/test_bench_grade.py && git commit -m "feat(bench): trusted grader with hidden overlay and tamper detection"`

---

### Task 8: Runner with journal, budgets and resume

**Files:**
- Create: `bench/runner.py`, `bench/fake_agent.py`, `scripts/bench_run.py`
- Test: `tests/test_bench_runner.py`

**Interfaces:**
- Consumes: Tasks 3–7; Phase 0 `task_outcomes` for per-run cost/iterations from the experiment state root.
- Produces:
  - `plan_attempts(tasks, arms, k, seed) -> list[Attempt]` — `Attempt(attempt_id, task_id, arm, k)`; blocks of (task, k) with arms shuffled inside each block by `random.Random(seed)`.
  - `run_experiment(tasks, cfg, arms, experiment_root, *, approve_usd, sandbox=True, launcher=subprocess.Popen) -> Path` (journal path). Journal `experiment_root/journal.jsonl`, one JSON object per terminal attempt: `attempt_id, task_id, arm, k, execution_status (completed|failed|timeout|budget_exceeded|infra_error), verdict (pass|fail|error|unknown), elapsed_ms, cost_usd, cost_complete, fix_rounds, provider_retries, run_id, tree_digest, config_fingerprint, replaced_by?`.
  - Refuses when `experiment_root` resolves to `default_state_root()`; refuses when `approve_usd < len(attempts) * per_run_usd_cap`.
  - Resume: attempts already in the journal are skipped; an attempt with a `started` marker but no terminal row is recorded `infra_error` with `replaced_by` a new attempt id `…-r1` and re-run once.
- `bench/fake_agent.py`: a stand-in binary. Reads `BENCH_FAKE_BEHAVIOUR` (`apply:<patch>` | `noop` | `sleep:<s>`) and writes a minimal `metrics.jsonl`/`outcomes.jsonl` into `CODING_AGENT_ORCHESTRATOR_HOME` so the cost/iteration path is exercised.

- [ ] **Step 1: Failing tests** — `tests/test_bench_runner.py`:

```python
import json, sys
from pathlib import Path
import pytest
from bench.runner import plan_attempts, run_experiment
from bench.arms import ExperimentConfig
from orchestrator.core.env import default_state_root

FAKE = str(Path(__file__).resolve().parents[1] / 'bench' / 'fake_agent.py')

def test_plan_is_blocked_and_seeded():
    a = plan_attempts(['t1', 't2'], ('direct', 'current'), 2, seed=1)
    b = plan_attempts(['t1', 't2'], ('direct', 'current'), 2, seed=1)
    assert [x.attempt_id for x in a] == [x.attempt_id for x in b]
    assert len(a) == 8
    for i in range(0, 8, 2):   # each block holds both arms for one (task, k)
        assert {a[i].arm, a[i + 1].arm} == {'direct', 'current'} and a[i].task_id == a[i + 1].task_id

def test_refuses_live_state_root(tmp_path):
    with pytest.raises(ValueError, match='live state'):
        run_experiment([], None, ('direct',), default_state_root(), approve_usd=0)

def test_refuses_insufficient_approval(tmp_path, tiny_suite, fake_cfg):
    with pytest.raises(ValueError, match='approve'):
        run_experiment(tiny_suite, fake_cfg, ('direct',), tmp_path / 'exp', approve_usd=0.0, sandbox=False)

def test_timeout_is_journaled_and_resume_skips_done(tmp_path, tiny_suite, fake_cfg, monkeypatch):
    monkeypatch.setenv('BENCH_FAKE_BEHAVIOUR', 'sleep:30')
    cfg = fake_cfg.__class__(**{**fake_cfg.__dict__, 'per_run_timeout_s': 1})
    journal = run_experiment(tiny_suite, cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    rows = [r for r in (json.loads(l) for l in journal.read_text().splitlines()) if r.get('event') != 'started']
    assert rows and {r['execution_status'] for r in rows} == {'timeout'} and all(r['verdict'] == 'unknown' for r in rows)
    lines_before = len(journal.read_text().splitlines())
    run_experiment(tiny_suite, cfg, ('direct',), tmp_path / 'exp', approve_usd=100, sandbox=False)
    assert len(journal.read_text().splitlines()) == lines_before   # nothing re-run
```

Create `tests/conftest.py` (move `git`/`make_repo` out of `tests/test_bench_snapshot.py` and import them there from `conftest`):

```python
import json, shlex, subprocess, sys
from pathlib import Path
import pytest

FAKE = Path(__file__).resolve().parents[1] / 'bench' / 'fake_agent.py'

def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()

def make_repo_at(tmp_path):
    repo = tmp_path / 'src'; repo.mkdir()
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    (repo / 'a.txt').write_text('base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
    base = git(repo, 'rev-parse', 'HEAD')
    (repo / 'a.txt').write_text('SOLUTION\n'); git(repo, 'commit', '-qam', 'future solution')
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git')
    return repo, base

@pytest.fixture
def make_repo():
    return make_repo_at

@pytest.fixture
def tiny_suite(tmp_path):
    from bench.manifest import load_manifest
    repo, base = make_repo_at(tmp_path)
    d = tmp_path / 'suite'; (d / 'hidden').mkdir(parents=True)
    (d / 'hidden' / 'check.py').write_text("import pathlib,sys; sys.exit(0 if 'SOLUTION' in pathlib.Path('a.txt').read_text() else 1)")
    (d / 'reference.patch').write_text(subprocess.run(['git', '-C', str(repo), 'diff', base, 'HEAD'], capture_output=True, text=True).stdout)
    m = {'id': 't1', 'repo': str(repo), 'base_commit': base, 'goal': 'make a.txt say SOLUTION', 'task_class': 'implementation',
         'scope_band': 'tiny', 'risk': 'low', 'split': 'dev', 'setup': [], 'visible_checks': [],
         'hidden_checks': [[sys.executable, 'check.py']], 'hidden_files': 'hidden', 'reference_patch': 'reference.patch',
         'protected_paths': [], 'timeout_s': 30}
    (d / 't1.json').write_text(json.dumps(m))
    return [load_manifest(d / 't1.json')]

@pytest.fixture
def fake_cfg(tmp_path):
    from bench.arms import ExperimentConfig
    (tmp_path / 'profiles.json').write_text('{}')
    skill_root = Path(__file__).resolve().parents[1]
    return ExperimentConfig('exp-test', 1, 1, f'{shlex.quote(sys.executable)} {shlex.quote(str(FAKE))}', skill_root,
                            tmp_path / 'profiles.json', 'fake/m', 'low', (), 1.0, 60)
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_runner.py` — Expected: FAIL.

- [ ] **Step 3: Implement** — `bench/runner.py` (core loop; keep each function small):

```python
"""Experiment runner (spec §2.3): isolated attempts, journal, budgets, resume."""
from __future__ import annotations

import json
import os
import random
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from bench.arms import arm_invocation, config_fingerprint
from bench.grade import grade
from bench.sandbox import default_deny_roots, sandbox_argv
from bench.snapshot import make_snapshot
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
        order = list(arms); rng.shuffle(order)
        out += [Attempt(f'{t}.{a}.k{i}', t, a, i) for a in order]
    return out


def _same(a: Path, b: Path) -> bool:
    try:
        return a.exists() and b.exists() and os.path.samefile(a, b)
    except OSError:
        return a.resolve() == b.resolve()


def _journal(root: Path) -> tuple[Path, dict, set]:
    path = root / 'journal.jsonl'
    done, started = {}, set()
    if path.exists():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if row.get('event') == 'started': started.add(row['attempt_id'])
            else: done[row['attempt_id']] = row
    return path, done, started - set(done)


def _append(path: Path, row: dict) -> None:
    with path.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(row, sort_keys=True) + '\n'); fh.flush(); os.fsync(fh.fileno())


def _run_cost(state: Path, since_ts: float) -> tuple[float, bool, dict]:
    """Known cost and completeness for runs that started after `since_ts`, via Phase 0 task_outcomes."""
    from orchestrator.analytics.task_outcomes import task_outcomes
    from orchestrator.runtime import iter_jsonl
    streams = [list(iter_jsonl(state / f)) if (state / f).exists() else [] for f in ('metrics.jsonl', 'events.jsonl', 'outcomes.jsonl')]
    rows = task_outcomes(*streams)
    fresh = [r for r in rows if r.get('started_at') is None or r['started_at'] >= time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(since_ts))]
    cost = sum(r['cost_known_usd'] or 0 for r in fresh)
    complete = all(r['cost_complete'] for r in fresh) and bool(fresh)
    last = fresh[-1] if fresh else {}
    return cost, complete, last


def run_experiment(tasks, cfg, arms, experiment_root: Path, *, approve_usd: float, sandbox: bool = True) -> Path:
    root = Path(experiment_root)
    if _same(root, default_state_root()) or root.resolve() == default_state_root().resolve():
        raise ValueError('refusing to use the live state root as an experiment root')
    by_id = {t.id: t for t in tasks}
    attempts = plan_attempts(sorted(by_id), arms, cfg.k if cfg else 0, cfg.seed if cfg else 0)
    if cfg is None or approve_usd < len(attempts) * cfg.per_run_usd_cap:
        need = len(attempts) * (cfg.per_run_usd_cap if cfg else 0)
        raise ValueError(f'approve at least ${need:.2f} (--approve-usd) for {len(attempts)} attempts')
    root.mkdir(parents=True, exist_ok=True)
    fingerprint = config_fingerprint(cfg)
    journal, done, orphaned = _journal(root)
    for a in attempts:
        if a.attempt_id in done:
            continue
        attempt = a
        if a.attempt_id in orphaned:
            _append(journal, {'attempt_id': a.attempt_id, 'task_id': a.task_id, 'arm': a.arm, 'k': a.k,
                              'execution_status': 'infra_error', 'verdict': 'unknown', 'replaced_by': a.attempt_id + '-r1'})
            attempt = Attempt(a.attempt_id + '-r1', a.task_id, a.arm, a.k)
        _append(journal, _run_one(by_id[a.task_id], attempt, cfg, root, fingerprint, journal, sandbox))
    return journal


def _run_one(task, a: Attempt, cfg, root: Path, fingerprint: str, journal: Path, sandbox: bool) -> dict:
    work = root / 'attempts' / a.attempt_id
    base = make_snapshot(Path(task.repo), task.base_commit, work / 'base')
    snap = make_snapshot(Path(task.repo), task.base_commit, work / 'tree')
    for argv in task.setup:
        subprocess.run(list(argv), cwd=snap.path, check=False, timeout=task.timeout_s)
    argv, env = arm_invocation(a.arm, task.goal, cfg, root)
    argv = shlex.split(argv[0]) + argv[1:]           # allows "python fake_agent.py" style binaries
    if sandbox:
        argv = sandbox_argv(argv, deny_read=default_deny_roots([Path(task.repo), task.source.parent, root / 'journal.jsonl']), allow_network=True)
    _append(journal, {'event': 'started', 'attempt_id': a.attempt_id})
    t0 = time.time(); status = 'completed'
    proc = subprocess.Popen(argv, cwd=snap.path, env={**os.environ, **env}, stdout=(work / 'agent.jsonl').open('wb'),
                            stderr=(work / 'agent.stderr').open('wb'), start_new_session=True)
    try:
        while proc.poll() is None:
            if time.time() - t0 > cfg.per_run_timeout_s:
                status = 'timeout'; break
            if _run_cost(root / 'state', t0)[0] > cfg.per_run_usd_cap:
                status = 'budget_exceeded'; break
            time.sleep(1)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(10)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()
    if status == 'completed' and proc.returncode != 0:
        status = 'failed'
    elapsed_ms = int((time.time() - t0) * 1000)
    cost, complete, run = _run_cost(root / 'state', t0)
    verdict = 'unknown'
    digest = None
    if status in ('completed', 'failed'):
        g = grade(task, snap.path, base.path, work / 'grade', sandbox=sandbox)
        verdict, digest = g.verdict, g.tree_digest
        (work / 'grade.json').write_text(json.dumps(g.__dict__, default=str, indent=2))
    return {'attempt_id': a.attempt_id, 'task_id': a.task_id, 'arm': a.arm, 'k': a.k, 'execution_status': status,
            'verdict': verdict, 'elapsed_ms': elapsed_ms, 'cost_usd': cost, 'cost_complete': complete,
            'fix_rounds': run.get('fix_rounds'), 'provider_retries': run.get('provider_retries'),
            'run_id': run.get('run_id'), 'tree_digest': digest, 'config_fingerprint': fingerprint,
            'scope_band': task.scope_band, 'risk': task.risk, 'split': task.split}
```

`bench/fake_agent.py`:

```python
#!/usr/bin/env python3
"""Zero-spend stand-in for humain-terminal used by runner tests (spec §2.6)."""
import json, os, subprocess, sys, time
from pathlib import Path

behaviour = os.environ.get('BENCH_FAKE_BEHAVIOUR', 'noop')
state = Path(os.environ['CODING_AGENT_ORCHESTRATOR_HOME']); state.mkdir(parents=True, exist_ok=True)
run_id = f"fake-{int(time.time() * 1000)}"
now = time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime())
with (state / 'metrics.jsonl').open('a') as fh:
    fh.write(json.dumps({'event': 'model_call', 'run_id': run_id, 'task_id': f'{run_id}-t', 'model': 'fake/m', 'cost_usd': 0.01,
                         'cost_source': 'reported', 'input_tokens': 10, 'output_tokens': 5, 'complexity': 2, 'risk': 'low'}) + '\n')
with (state / 'events.jsonl').open('a') as fh:
    fh.write(json.dumps({'event': 'run_started', 'run_id': run_id, 'started_at': now, 'ts': now}) + '\n')
if behaviour.startswith('sleep:'):
    time.sleep(float(behaviour.split(':', 1)[1]))
elif behaviour.startswith('apply:'):
    subprocess.run(['git', 'apply', behaviour.split(':', 1)[1]], check=True)
with (state / 'outcomes.jsonl').open('a') as fh:
    fh.write(json.dumps({'run_id': run_id, 'task_id': 'run-complete', 'outcome': 'verified', 'note': json.dumps({'fix_rounds': 0}),
                         'elapsed_ms': 10, 'elapsed_source': 'monotonic'}) + '\n')
print(json.dumps({'type': 'done', 'run_id': run_id}))
sys.exit(0)
```

`scripts/bench_run.py`: argparse wrapper — `--suite DIR --experiment-root DIR --config JSON --arms direct,current[,tiered] --approve-usd N [--no-sandbox] [--split dev|holdout]`. It prints `attempts × per_run_usd_cap` before calling `run_experiment`, rejects `tiered` unless `method.json` has `rules.workflow_policy` (Phase 2), and writes `experiment.json` (config, fingerprint, suite ids, installed-extension revision) into the root on first run and refuses to continue if a later invocation's fingerprint differs.

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_runner.py tests/test_bench_*.py` — Expected: PASS (sandboxed paths skipped off macOS; runner tests use `sandbox=False`).

- [ ] **Step 5: Commit** `git add bench/runner.py bench/fake_agent.py scripts/bench_run.py tests/test_bench_runner.py tests/conftest.py && git commit -m "feat(bench): experiment runner with journal, caps, resume and fake agent"`

---

### Task 9: Paired statistics and quality verdict

**Files:**
- Create: `bench/stats.py`
- Test: `tests/test_bench_stats.py`

**Interfaces:**
- Produces:
  - `task_means(journal_rows, arm) -> dict[task_id, dict]` with `pass_frac` (passes / all attempts incl. timeout/budget/infra), `all_pass` (pass^k: every attempt passed), `elapsed_ms` (median over attempts), `cost_usd` (sum), `cost_complete`.
  - `paired_lower_bound(diffs: list[float], *, alpha=0.05, reps=10000, seed=0) -> float | None` — one-sided percentile task-cluster bootstrap LB; `None` when `len(diffs) < 10` or all diffs equal.
  - `quality_verdict(control, candidate, *, margin=0.05) -> dict` with `verdict ∈ {'pass','fail','inconclusive'}`, `lb_pass`, `lb_all_pass`, `n_tasks`, `reason`. Rule: `pass` iff `lb_pass > -margin` and `lb_all_pass >= 0`; `fail` iff the corresponding **upper** bound of `pass_frac` diff is `< -margin`; else `inconclusive`.
  - `efficiency_summary(control, candidate) -> dict` — paired median ratio and bootstrap CI for elapsed and cost (cost only over tasks where both arms are `cost_complete`, with coverage reported).

- [ ] **Step 1: Failing tests**

```python
import random
from bench.stats import paired_lower_bound, quality_verdict

def arm(pass_fracs):
    return {f't{i}': {'pass_frac': p, 'all_pass': p == 1.0} for i, p in enumerate(pass_fracs)}

def test_zero_variance_is_inconclusive():
    v = quality_verdict(arm([1.0] * 20), arm([1.0] * 20))
    assert v['verdict'] == 'inconclusive'

def test_too_few_tasks_is_inconclusive():
    assert paired_lower_bound([0.1, 0.2, 0.0]) is None

def test_clear_regression_fails():
    v = quality_verdict(arm([1.0] * 20), arm([0.0] * 10 + [1.0] * 10))
    assert v['verdict'] == 'fail'

def test_lower_bound_coverage_under_null():
    # Under a true zero difference the one-sided 95% LB should fall below 0 in >= ~90% of trials.
    rng = random.Random(3); below = 0; trials = 200
    for _ in range(trials):
        diffs = [rng.choice([-1/3, 0, 0, 1/3]) for _ in range(20)]
        lb = paired_lower_bound(diffs, reps=2000, seed=rng.randint(0, 10**6))
        below += lb is None or lb <= 0
    assert below / trials >= 0.9
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_stats.py` — Expected: FAIL.

- [ ] **Step 3: Implement** `bench/stats.py`:

```python
"""Paired task-cluster statistics (spec §2.4). Repeats are averaged within a task, never pooled."""
from __future__ import annotations

import random
import statistics
from collections import defaultdict

MIN_TASKS = 10
_FAILED_STATUSES = {'timeout', 'budget_exceeded', 'infra_error', 'failed'}


def task_means(rows: list[dict], arm: str) -> dict[str, dict]:
    by = defaultdict(list)
    for r in rows:
        if r.get('arm') == arm and 'replaced_by' not in r:
            by[r['task_id']].append(r)
    out = {}
    for tid, rs in by.items():
        passes = [r.get('verdict') == 'pass' for r in rs]
        out[tid] = {'pass_frac': sum(passes) / len(rs), 'all_pass': all(passes),
                    'elapsed_ms': statistics.median(r['elapsed_ms'] for r in rs),
                    'cost_usd': sum(r.get('cost_usd') or 0 for r in rs),
                    'cost_complete': all(r.get('cost_complete') for r in rs), 'n': len(rs)}
    return out


def _bootstrap(diffs: list[float], reps: int, seed: int) -> list[float]:
    rng = random.Random(seed); n = len(diffs)
    return sorted(sum(rng.choice(diffs) for _ in range(n)) / n for _ in range(reps))


def paired_lower_bound(diffs: list[float], *, alpha: float = 0.05, reps: int = 10000, seed: int = 0) -> float | None:
    if len(diffs) < MIN_TASKS or len(set(diffs)) == 1:
        return None
    return _bootstrap(diffs, reps, seed)[int(alpha * reps)]


def paired_upper_bound(diffs: list[float], *, alpha: float = 0.05, reps: int = 10000, seed: int = 0) -> float | None:
    if len(diffs) < MIN_TASKS or len(set(diffs)) == 1:
        return None
    return _bootstrap(diffs, reps, seed)[int((1 - alpha) * reps) - 1]


def quality_verdict(control: dict, candidate: dict, *, margin: float = 0.05, seed: int = 0) -> dict:
    tasks = sorted(set(control) & set(candidate))
    d_pass = [candidate[t]['pass_frac'] - control[t]['pass_frac'] for t in tasks]
    d_all = [float(candidate[t]['all_pass']) - float(control[t]['all_pass']) for t in tasks]
    lb_p, ub_p = paired_lower_bound(d_pass, seed=seed), paired_upper_bound(d_pass, seed=seed)
    lb_a = paired_lower_bound(d_all, seed=seed + 1)
    if ub_p is not None and ub_p < -margin:
        verdict, reason = 'fail', 'upper bound of completion difference below -margin'
    elif lb_p is not None and lb_p > -margin and lb_a is not None and lb_a >= 0:
        verdict, reason = 'pass', 'lower bounds satisfy margin and consistency'
    else:
        verdict, reason = 'inconclusive', 'insufficient tasks, zero variance, or bounds straddle the margin'
    return {'verdict': verdict, 'reason': reason, 'n_tasks': len(tasks), 'lb_pass': lb_p, 'ub_pass': ub_p, 'lb_all_pass': lb_a,
            'mean_diff_pass': (sum(d_pass) / len(d_pass)) if d_pass else None}


def efficiency_summary(control: dict, candidate: dict, *, seed: int = 0) -> dict:
    tasks = sorted(set(control) & set(candidate))
    def ratios(key, only_complete=False):
        xs = [candidate[t][key] / control[t][key] for t in tasks
              if control[t][key] and (not only_complete or (control[t]['cost_complete'] and candidate[t]['cost_complete']))]
        if len(xs) < MIN_TASKS:
            return {'n': len(xs), 'median_ratio': statistics.median(xs) if xs else None, 'ci': None}
        rng = random.Random(seed); boots = sorted(statistics.median(rng.choice(xs) for _ in xs) for _ in range(2000))
        return {'n': len(xs), 'median_ratio': statistics.median(xs), 'ci': (boots[50], boots[1949])}
    return {'elapsed': ratios('elapsed_ms'), 'cost': ratios('cost_usd', only_complete=True), 'n_tasks': len(tasks)}
```

The `fail`/`pass` precedence also yields `inconclusive` when `lb_all_pass` is `None` (zero variance in pass^k): a deliberately stringent outcome agreed in the spec.

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_stats.py` — Expected: PASS. If the coverage test lands just under 0.9 because percentile bootstrap undercovers at n=20, raise `MIN_TASKS` or switch `paired_lower_bound` to a BCa-free t-based bound over task means and keep the test unchanged; do not weaken the test.

- [ ] **Step 5: Commit** `git add bench/stats.py tests/test_bench_stats.py && git commit -m "feat(bench): paired cluster bootstrap and quality verdict with inconclusive"`

---

### Task 10: Report CLI

**Files:**
- Create: `scripts/bench_report.py`
- Test: `tests/test_bench_report.py`

**Interfaces:**
- Consumes: journal rows, `task_means`, `quality_verdict`, `efficiency_summary`.
- Produces: `render(journal_rows, control='current', candidates=('tiered','direct'), by=('all','scope_band','risk')) -> str` and `--json` machine output. Every table shows all-attempt denominators and status breakdown (`completed/failed/timeout/budget_exceeded/infra_error`); strata with fewer than 10 tasks are labelled `exploratory`.

- [ ] **Step 1: Failing test** — `tests/test_bench_report.py`:

```python
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location('bench_report', Path(__file__).resolve().parents[1] / 'scripts' / 'bench_report.py')
bench_report = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(bench_report)

def test_report_labels_small_strata_exploratory_and_counts_all_attempts():
    rows = [{'attempt_id': f'{t}.{a}.k1', 'task_id': t, 'arm': a, 'k': 1,
             'execution_status': 'timeout' if (t == 't0' and a == 'tiered') else 'completed',
             'verdict': 'unknown' if (t == 't0' and a == 'tiered') else 'pass', 'elapsed_ms': 1000, 'cost_usd': 1.0,
             'cost_complete': True, 'scope_band': 'tiny', 'risk': 'low'} for t in ('t0', 't1', 't2') for a in ('current', 'tiered')]
    text = bench_report.render(rows, control='current', candidates=('tiered',))
    assert 'exploratory' in text and 'timeout 1' in text and 'inconclusive' in text
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_report.py` — Expected: FAIL.

- [ ] **Step 3: Implement** `scripts/bench_report.py`:

```python
#!/usr/bin/env python3
"""Paired benchmark report (spec §2.4). Descriptive per stratum; verdicts only from bench.stats."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bench.stats import MIN_TASKS, efficiency_summary, quality_verdict, task_means  # noqa: E402

STATUSES = ('completed', 'failed', 'timeout', 'budget_exceeded', 'infra_error')


def _groups(rows, by):
    if by == 'all':
        return {'all': rows}
    out: dict = {}
    for r in rows:
        out.setdefault(f'{by}={r.get(by)}', []).append(r)
    return out


def _fmt(v, pct=False):
    if v is None:
        return 'n/a'
    return f'{v * 100:+.1f}pp' if pct else f'{v:.2f}'


def analyse(rows, control, candidates, by):
    result = []
    for dim in by:
        for name, g in sorted(_groups(rows, dim).items()):
            ctrl = task_means(g, control)
            for cand in candidates:
                c = task_means(g, cand)
                status = {arm: Counter(r['execution_status'] for r in g if r['arm'] == arm and 'replaced_by' not in r) for arm in (control, cand)}
                result.append({'group': name, 'control': control, 'candidate': cand, 'status': {k: dict(v) for k, v in status.items()},
                               'quality': quality_verdict(ctrl, c), 'efficiency': efficiency_summary(ctrl, c),
                               'exploratory': len(set(ctrl) & set(c)) < MIN_TASKS})
    return result


def render(rows, control='current', candidates=('tiered', 'direct'), by=('all', 'scope_band', 'risk')) -> str:
    lines = []
    for a in analyse(rows, control, candidates, by):
        q, e = a['quality'], a['efficiency']
        tag = ' [exploratory]' if a['exploratory'] else ''
        lines.append(f"{a['group']}: {a['candidate']} vs {a['control']}{tag}")
        for arm, counts in a['status'].items():
            lines.append('  ' + arm + ': ' + ' '.join(f'{s} {counts.get(s, 0)}' for s in STATUSES))
        lines.append(f"  quality: {q['verdict']} (n={q['n_tasks']}, mean diff {_fmt(q['mean_diff_pass'], True)}, "
                     f"LB {_fmt(q['lb_pass'], True)}, pass^k LB {_fmt(q['lb_all_pass'], True)}) — {q['reason']}")
        lines.append(f"  elapsed ratio {_fmt(e['elapsed']['median_ratio'])} CI {e['elapsed']['ci']}; "
                     f"cost ratio {_fmt(e['cost']['median_ratio'])} CI {e['cost']['ci']} (complete-cost tasks {e['cost']['n']}/{e['n_tasks']})")
    return '\n'.join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--journal', type=Path, required=True)
    p.add_argument('--control', default='current')
    p.add_argument('--candidates', default='tiered,direct')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    rows = [json.loads(l) for l in a.journal.read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r.get('event') != 'started']
    cands = tuple(c for c in a.candidates.split(',') if c)
    if a.json:
        print(json.dumps(analyse(rows, a.control, cands, ('all', 'scope_band', 'risk')), indent=2, default=str))
    else:
        print(render(rows, a.control, cands))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
```

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_bench_report.py` — Expected: PASS.

- [ ] **Step 5: Commit** `git add scripts/bench_report.py tests/test_bench_report.py && git commit -m "feat(bench): paired report with status breakdown and exploratory strata"`

---

### Task 11: Task curation tools, pilot suite and paid smoke run

**Files:**
- Create: `scripts/bench_candidates.py`, `scripts/bench_validate_tasks.py`, `docs/BENCHMARK.md`
- Create (outside the repo, private): the suite directory, e.g. `~/orch-bench/suite/` with `*.json`, `hidden/`, `reference.patch` per task
- Test: `tests/test_bench_validate.py`

**Interfaces:**
- `bench_candidates.py REPO --since 90.days` lists commits touching both source and test files (`git log --name-only`), with size (files/lines) to propose `scope_band`.
- `bench_validate_tasks.py SUITE` for each task: snapshot base → run hidden checks ⇒ must **fail**; apply `reference_patch` → hidden checks ⇒ must **pass** 3/3 (flake guard); writes `validation.json`; exits non-zero listing any task to quarantine.

- [ ] **Step 1: Failing test** — `tests/test_bench_validate.py`:

```python
import importlib.util, json, subprocess, sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location('bench_validate_tasks', Path(__file__).resolve().parents[1] / 'scripts' / 'bench_validate_tasks.py')
validate = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(validate)

def _task(suite, repo, base, tid, check):
    d = suite / tid; (d / 'hidden').mkdir(parents=True)
    (d / 'hidden' / 'check.py').write_text(check)
    patch = subprocess.run(['git', '-C', str(repo), 'diff', base, 'HEAD'], capture_output=True, text=True, check=True).stdout
    (d / 'reference.patch').write_text(patch)
    m = {'id': tid, 'repo': str(repo), 'base_commit': base, 'goal': 'g', 'task_class': 'implementation', 'scope_band': 'tiny',
         'risk': 'low', 'split': 'dev', 'setup': [], 'visible_checks': [], 'hidden_checks': [[sys.executable, 'check.py']],
         'hidden_files': 'hidden', 'reference_patch': 'reference.patch', 'protected_paths': [], 'timeout_s': 30}
    (suite / f'{tid}.json').write_text(json.dumps({**m, 'hidden_files': f'{tid}/hidden', 'reference_patch': f'{tid}/reference.patch'}))

def test_validator_quarantines_tasks_whose_base_already_passes(tmp_path, make_repo):
    repo, base = make_repo(tmp_path)            # base a.txt='base', HEAD a.txt='SOLUTION'
    suite = tmp_path / 'suite'; suite.mkdir()
    _task(suite, repo, base, 'good', "import pathlib,sys; sys.exit(0 if 'SOLUTION' in pathlib.Path('a.txt').read_text() else 1)")
    _task(suite, repo, base, 'broken', 'import sys; sys.exit(0)')
    result = validate.validate_suite(suite, tmp_path / 'work', repeats=3, sandbox=False)
    assert result == {'ok': ['good'], 'quarantine': ['broken']}
```

(`make_repo` is the `conftest.py` fixture from Task 8, returning a factory `make_repo(tmp_path) -> (repo, base_sha)`.)

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_bench_validate.py` — Expected: FAIL.

- [ ] **Step 3: Implement** `scripts/bench_validate_tasks.py`:

```python
#!/usr/bin/env python3
"""Validate a task suite: base must FAIL hidden checks; reference must PASS them every time (spec §2.1)."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bench.grade import grade  # noqa: E402
from bench.manifest import load_suite  # noqa: E402
from bench.snapshot import make_snapshot  # noqa: E402


def validate_task(task, work: Path, *, repeats: int, sandbox: bool) -> str | None:
    """Return None when valid, else the quarantine reason."""
    if work.exists():
        shutil.rmtree(work)
    base = make_snapshot(Path(task.repo), task.base_commit, work / 'base')
    if grade(task, base.path, base.path, work / 'g-base', sandbox=sandbox).verdict != 'fail':
        return 'base does not fail hidden checks'
    ref = make_snapshot(Path(task.repo), task.base_commit, work / 'ref')
    patch = (task.source.parent / task.reference_patch).resolve()
    if subprocess.run(['git', '-C', str(ref.path), 'apply', str(patch)], capture_output=True).returncode != 0:
        return 'reference patch does not apply'
    for i in range(repeats):
        if grade(task, ref.path, base.path, work / f'g-ref-{i}', sandbox=sandbox).verdict != 'pass':
            return f'reference failed hidden checks on repeat {i + 1}'
    return None


def validate_suite(suite: Path, work: Path, *, repeats: int = 3, sandbox: bool = True) -> dict:
    ok, quarantine, reasons = [], [], {}
    for task in load_suite(suite):
        reason = validate_task(task, work / task.id, repeats=repeats, sandbox=sandbox)
        (quarantine if reason else ok).append(task.id)
        if reason:
            reasons[task.id] = reason
    (work / 'validation.json').write_text(json.dumps({'ok': ok, 'quarantine': quarantine, 'reasons': reasons}, indent=2))
    return {'ok': ok, 'quarantine': quarantine}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('suite', type=Path)
    p.add_argument('--work', type=Path, required=True)
    p.add_argument('--repeats', type=int, default=3)
    p.add_argument('--no-sandbox', action='store_true')
    a = p.parse_args()
    a.work.mkdir(parents=True, exist_ok=True)
    result = validate_suite(a.suite, a.work, repeats=a.repeats, sandbox=not a.no_sandbox)
    print(json.dumps(result, indent=2))
    return 1 if result['quarantine'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
```

`scripts/bench_candidates.py`:

```python
#!/usr/bin/env python3
"""List recent commits touching both source and tests, as benchmark replay candidates."""
from __future__ import annotations

import argparse
import re
import subprocess

TEST = re.compile(r'(^|/)(tests?/|test_[^/]+\.py$|[^/]+\.(test|spec)\.[jt]sx?$)')


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('repo'); p.add_argument('--since', default='90.days')
    a = p.parse_args()
    out = subprocess.run(['git', '-C', a.repo, 'log', f'--since={a.since}', '--no-merges', '--name-only', '--format=@@%H%x09%s'],
                         capture_output=True, text=True, check=True).stdout
    for block in out.split('@@')[1:]:
        head, *files = [l for l in block.splitlines() if l.strip()]
        sha, subject = head.split('\t', 1)
        tests = [f for f in files if TEST.search(f)]
        src = [f for f in files if f not in tests]
        if tests and src:
            band = 'tiny' if len(src) == 1 else 'small' if len(src) <= 3 else 'multi_file' if len({f.split('/')[0] for f in src}) <= 2 else 'cross_system'
            print(f'{sha}\t{band}\tsrc={len(src)}\ttests={len(tests)}\t{subject}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
```

The proposed band is a starting label only; a human confirms `scope_band`/`risk` before any arm runs.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Curate the pilot (human-in-the-loop)** — pick ≈16 replay tasks across forge, humain-terminal and this repo from `bench_candidates.py` output, ≈4 synthetic (auth/secrets change, cross-module interface change), ≈5 per scope band; label `task_class`, `scope_band`, `risk`, `split` (≈70% dev / 30% holdout) **before** running any arm; write hidden checks from the real commit's test changes plus any acceptance check the tests miss. Run `bench_validate_tasks.py` until 0 quarantined. Record suite path and `sha256` of every file in `docs/BENCHMARK.md`, never the hidden content.

- [ ] **Step 6: Paid smoke (explicit approval required)** — one dev task × `direct,current` × k=1 with `--approve-usd` covering 2 × cap. Check: journal rows present, grading ran, experiment state root populated, live state root untouched (`shasum` of live streams before/after). Record the result in `docs/BENCHMARK.md`.

- [ ] **Step 7: Commit** `git add scripts/bench_candidates.py scripts/bench_validate_tasks.py tests/test_bench_validate.py docs/BENCHMARK.md && git commit -m "feat(bench): task curation/validation tools and benchmark runbook"`

---

## Spec coverage (Section 2)

| Spec item | Task |
|---|---|
| §2.1 base-fails/reference-passes validation, flake quarantine | 3, 11 |
| §2.1 no worktree leakage; history-free snapshot; denied reads | 4, 5 |
| §2.1 trusted separate grading, tamper checks, no network | 7 |
| §2.2 arms, frozen config, pinned revision/profile | 6, 8 (`experiment.json`) |
| §2.3 isolated root, journal, resume, replacement, budgets, approval | 1, 2, 8 |
| §2.4 all-attempt denominators, pass^k, paired cluster bounds, inconclusive | 9, 10 |
| §2.5 live A/B | Phase 4 plan (uses Phase 2 assignment) |
| §2.6 fake-agent CI, leakage tests, statistical golden tests | 5, 8, 9 |

Deferred with reason: blinded human adjudication (§2.1) is a manual review step recorded in `docs/BENCHMARK.md`, not code; Holm adjustment across strata is applied in the Phase 3 analysis plan where the primary comparisons are fixed.

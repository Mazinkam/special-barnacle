# Phase 2 — Workflow Levels and Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Choose the lightest workflow level (`direct`, `checked`, `led`, `full`) from observable repository evidence, run it under hard safety floors, and escalate upward with carried-forward work — first in `observe` mode (no behaviour change), then behind `enforce`.

**Architecture:** Pure, table-tested modules in the bridge compute signals (`core/workflow-signals.ts`), discover deterministic checks (`core/check-discovery.ts`) and route (`core/workflow-router.ts`) using `method.json` `rules.workflow_policy`. `runOrchestration` records the planned level in every mode. In `enforce`, `direct`/`checked` replace `dispatchHierarchical` with a single implementer (`pipeline/flat-level.ts`) verified by deterministic checks (plus one independent review for `checked`); on persistent failure the run re-enters the existing coordinated pipeline at `led`, carrying the pre-run snapshot, prior results, cost and feedback. `led` and `full` both use today's coordinated pipeline in this phase; `full` differs only by being a floor that nothing can lower.

**Tech Stack:** TypeScript on Bun (`bun:test`), Python 3.9+ for method validation and evidence.

**Spec:** `docs/superpowers/specs/2026-09-29-tiered-workflows-and-eval-design.md` (Section 3). Uses Phase 0's `fix_rounds` and `task_outcomes` (`docs/superpowers/plans/2026-09-29-phase0-trustworthy-measurement.md`). Phase 1's `tiered` arm sets `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE=enforce` and `current` sets `off`; both plans use this name.

## Global Constraints

- Naming: "tier" already means model cost tier (`cheap|mid|premium|frontier`) in `method.json`, `core/args.ts` and `orchestrator/method.py`'s `_tiers` validator. Workflow choices are **levels**; the rule is `rules.workflow_policy`; no key in it may end in `_tier` or `_tiers`.
- Default `mode` is `off`. `off` must not collect signals or change any dispatch.
- Hard floors are never lowered by `--workflow`, env, benchmark arm or exploration: explicit high/critical risk or any risk-path hit ⇒ `full`.
- `task_class` `investigation` and `qa_verification` are excluded from `enforce` (planned level still recorded).
- No new dependencies; no `Bun.*` APIs in runtime code (the extension runs inside humain-terminal, not necessarily Bun).
- Deterministic checks and git calls use `spawn`/`execFileSync` with `shell: false`, bounded timeouts and a hardened git env (`GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, hooks disabled).
- `bridge/extensions/orchestrator/index.ts` has unrelated uncommitted edits; this plan does not modify it.
- Tests: `cd bridge/extensions/orchestrator && bun test`; `bash scripts/typecheck-bridge.sh`; `python3 -m pytest -q`.

## Review Focus

1. A goal that names a file under `**/auth/**` with explicit risk `low` must still route to `full`, and `--workflow direct` must be rejected with the floor reason — Tasks 6 and 7.
2. A repo where check discovery finds nothing must never route to `direct` (no deterministic evidence) — Task 6.
3. After a `direct` attempt fails and escalates to `led`, QA scope must still include files the direct implementer changed (pre-run snapshot carried forward), and total cost must include the direct attempt — Task 10.
4. A deterministic check that hangs must be killed at its timeout and count as a failed check, not a pass or an unhandled rejection — Task 8.
5. `off` mode must produce byte-identical dispatch behaviour to today (no signal collection, no `workflow_level_planned` event) — Task 7.

---

### Task 1: `rules.workflow_policy` in `method.json` with validation on both runtimes

**Files:**
- Modify: `orchestrator/method.json` (`rules`)
- Modify: `orchestrator/method.py` (`_validate`, ~lines 46–90)
- Modify: `bridge/extensions/orchestrator/models.ts` (`MethodFile.rules`, ~lines 64–101)
- Test: `tests/test_method.py`, `bridge/extensions/orchestrator/models.test.ts`

**Interfaces:**
- Produces (JSON):

```json
"workflow_policy": {
  "summary": "Observable repository evidence picks the lightest workflow level; hard floors cannot be lowered; failures escalate upward with work carried forward.",
  "mode": "off",
  "levels": ["direct", "checked", "led", "full"],
  "thresholds": { "led_min_files": 4, "led_min_packages": 3 },
  "fix_rounds_per_level": 1,
  "signal_timeout_ms": 5000,
  "check_timeout_ms": 600000,
  "excluded_task_classes": ["investigation", "qa_verification"],
  "risk_path_globs": ["**/auth/**", "**/*auth*.*", "**/*secret*", "**/*credential*", "**/payments/**", "**/billing/**",
                      ".github/workflows/**", ".gitlab-ci.yml", "**/package.json", "**/bun.lock", "**/bun.lockb", "**/package-lock.json",
                      "**/pnpm-lock.yaml", "**/yarn.lock", "**/pyproject.toml", "**/requirements*.txt", "**/migrations/**", "**/*migration*.*"],
  "interface_globs": ["**/*.d.ts", "**/schema*.json", "**/openapi*.json", "**/openapi*.yaml", "**/contract.json", "**/method.json", "**/index.ts", "**/__init__.py"],
  "rationale": "Spec 2026-09-29 §3: coordination overhead should scale with evidence of scope and risk, not with an LLM complexity score."
}
```

- TS type in `MethodFile.rules`:

```ts
workflow_policy?: WorkflowPolicy;
```

with, exported from `models.ts`:

```ts
export type WorkflowLevel = "direct" | "checked" | "led" | "full";
export type WorkflowMode = "off" | "observe" | "enforce";
export interface WorkflowPolicy {
	mode: WorkflowMode;
	levels: WorkflowLevel[];
	thresholds: { led_min_files: number; led_min_packages: number };
	fix_rounds_per_level: number;
	signal_timeout_ms: number;
	check_timeout_ms: number;
	excluded_task_classes: string[];
	risk_path_globs: string[];
	interface_globs: string[];
}
```

- [ ] **Step 1: Failing tests** — `tests/test_method.py` (inside the existing test class; mirror the `dispatch_spend_cap` mutation test at ~line 131):

```python
    def test_workflow_policy_shape_is_validated(self):
        import copy, json
        from orchestrator import method
        data = json.loads(method.METHOD_PATH.read_text())
        wf = data['rules']['workflow_policy']
        self.assertEqual(wf['mode'], 'off')
        self.assertEqual(wf['levels'], ['direct', 'checked', 'led', 'full'])
        for mutate, match in ((lambda d: d.__setitem__('mode', 'on'), 'workflow_policy.mode'),
                              (lambda d: d.__setitem__('levels', ['direct', 'full']), 'workflow_policy.levels'),
                              (lambda d: d['thresholds'].__setitem__('led_min_files', 0), 'led_min_files'),
                              (lambda d: d.__setitem__('fix_rounds_per_level', -1), 'fix_rounds_per_level')):
            bad = copy.deepcopy(data); mutate(bad['rules']['workflow_policy'])
            with self.assertRaisesRegex(ValueError, match):
                method._validate(bad)
```

`models.test.ts`:

```ts
test("workflow_policy is readable and off by default", () => {
	const wf = METHOD.rules.workflow_policy!;
	expect(wf.mode).toBe("off");
	expect(wf.levels).toEqual(["direct", "checked", "led", "full"]);
	expect(wf.risk_path_globs).toContain("**/auth/**");
});
```

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_method.py -k workflow_policy && (cd bridge/extensions/orchestrator && bun test models.test.ts)` — Expected: FAIL (`KeyError: 'workflow_policy'`).

- [ ] **Step 3: Implement** — add the JSON block above to `rules` in `orchestrator/method.json` (the bridge reads it via the `method.json` symlink). In `method.py::_validate`, after the `dispatch_spend_cap` check:

```python
    wf = m["rules"].get("workflow_policy")
    if wf is not None:
        if wf.get("mode") not in ("off", "observe", "enforce"):
            raise ValueError("rules.workflow_policy.mode must be off|observe|enforce")
        if wf.get("levels") != ["direct", "checked", "led", "full"]:
            raise ValueError("rules.workflow_policy.levels must be exactly direct, checked, led, full")
        for key in ("led_min_files", "led_min_packages"):
            _positive_int(wf.get("thresholds", {}).get(key), f"rules.workflow_policy.thresholds.{key}")
        if not isinstance(wf.get("fix_rounds_per_level"), int) or wf["fix_rounds_per_level"] < 0:
            raise ValueError("rules.workflow_policy.fix_rounds_per_level must be a non-negative integer")
        for key in ("signal_timeout_ms", "check_timeout_ms"):
            _positive_int(wf.get(key), f"rules.workflow_policy.{key}")
        for key in ("excluded_task_classes", "risk_path_globs", "interface_globs"):
            if not isinstance(wf.get(key), list) or not all(isinstance(x, str) and x for x in wf[key]):
                raise ValueError(f"rules.workflow_policy.{key} must be a list of non-empty strings")
```

Check `_positive_int(value, where)` raises `ValueError` whose message contains `where` (`method.py:93`); if not, raise explicitly. Add the TS types above to `models.ts` and `workflow_policy?: WorkflowPolicy;` to `MethodFile.rules`.

- [ ] **Step 4: Run** `python3 -m pytest -q tests/test_method.py tests/test_config_keys.py && (cd bridge/extensions/orchestrator && bun test) && bash scripts/typecheck-bridge.sh` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/method.json orchestrator/method.py bridge/extensions/orchestrator/models.ts bridge/extensions/orchestrator/models.test.ts tests/test_method.py
git commit -m "feat(method): rules.workflow_policy (off by default) validated in both runtimes"
```

---

### Task 2: Mode resolution with env override

**Files:**
- Create: `bridge/extensions/orchestrator/workflow-mode.ts`
- Test: `bridge/extensions/orchestrator/workflow-mode.test.ts`

**Interfaces:**
- Produces: `resolveWorkflowMode(policy: WorkflowPolicy | undefined, env: Record<string, string | undefined>): { mode: WorkflowMode; source: "method" | "env" | "absent"; problems: string[] }`. Env `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE` (`off|observe|enforce`) overrides the method value; an invalid value keeps the method value and reports a problem. No policy ⇒ `off`, source `absent`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { resolveWorkflowMode } from "./workflow-mode.ts";
import { METHOD } from "./models.ts";

const policy = METHOD.rules.workflow_policy!;

describe("resolveWorkflowMode", () => {
	test("method default is off", () => {
		expect(resolveWorkflowMode(policy, {})).toEqual({ mode: "off", source: "method", problems: [] });
	});
	test("env overrides", () => {
		expect(resolveWorkflowMode(policy, { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "observe" }).mode).toBe("observe");
	});
	test("invalid env keeps method value and reports", () => {
		const r = resolveWorkflowMode(policy, { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "yes" });
		expect(r.mode).toBe("off");
		expect(r.problems[0]).toContain("HUMAIN_ORCHESTRATOR_WORKFLOW_MODE");
	});
	test("absent policy is off", () => {
		expect(resolveWorkflowMode(undefined, { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "enforce" })).toEqual({ mode: "off", source: "absent", problems: ["workflow_policy missing from method.json; workflow levels disabled"] });
	});
});
```

- [ ] **Step 2: Run** `bun test workflow-mode.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { WorkflowMode, WorkflowPolicy } from "./models.ts";

const MODES: readonly WorkflowMode[] = ["off", "observe", "enforce"];
export const WORKFLOW_MODE_ENV = "HUMAIN_ORCHESTRATOR_WORKFLOW_MODE";

export function resolveWorkflowMode(
	policy: WorkflowPolicy | undefined,
	env: Record<string, string | undefined>,
): { mode: WorkflowMode; source: "method" | "env" | "absent"; problems: string[] } {
	if (!policy) return { mode: "off", source: "absent", problems: ["workflow_policy missing from method.json; workflow levels disabled"] };
	const raw = env[WORKFLOW_MODE_ENV];
	if (raw === undefined || raw === "") return { mode: policy.mode, source: "method", problems: [] };
	if ((MODES as readonly string[]).includes(raw)) return { mode: raw as WorkflowMode, source: "env", problems: [] };
	return { mode: policy.mode, source: "method", problems: [`Invalid ${WORKFLOW_MODE_ENV}=${raw}; using ${policy.mode}`] };
}
```

- [ ] **Step 4: Run** `bun test workflow-mode.test.ts && bash ../../../scripts/typecheck-bridge.sh` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bridge/extensions/orchestrator/workflow-mode.ts bridge/extensions/orchestrator/workflow-mode.test.ts && git commit -m "feat(bridge): workflow mode resolution with env override"`

---

### Task 3: Path glob matcher

**Files:**
- Create: `bridge/extensions/orchestrator/core/path-glob.ts`
- Test: `bridge/extensions/orchestrator/core/path-glob.test.ts`

**Interfaces:**
- Produces: `globToRegExp(glob: string): RegExp` supporting `**` (any depth incl. zero), `*` (no `/`), `?`, `{a,b}`; `matchesAny(path: string, globs: string[]): string[]` returning the matched globs. Paths are repo-relative POSIX.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { globToRegExp, matchesAny } from "./path-glob.ts";

describe("path-glob", () => {
	test.each([
		["**/auth/**", "src/auth/login.ts", true],
		["**/auth/**", "auth/x.ts", true],
		["**/auth/**", "src/author.ts", false],
		["**/*secret*", "config/app-secrets.json", true],
		[".github/workflows/**", ".github/workflows/ci.yml", true],
		["**/package.json", "package.json", true],
		["**/*.d.ts", "types/x.d.ts", true],
		["**/openapi*.{json,yaml}", "api/openapi.v1.yaml", true],
		["*.md", "docs/a.md", false],
	])("%s vs %s", (glob, path, expected) => {
		expect(globToRegExp(glob).test(path)).toBe(expected);
	});
	test("matchesAny returns the matching globs", () => {
		expect(matchesAny("src/auth/a.ts", ["**/auth/**", "**/*.py"])).toEqual(["**/auth/**"]);
	});
});
```

- [ ] **Step 2: Run** `bun test core/path-glob.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** Minimal, dependency-free glob → RegExp for repo-relative POSIX paths. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			re += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end < 0) { re += "\\{"; continue; }
			re += `(?:${glob.slice(i + 1, end).split(",").map(escape).join("|")})`;
			i = end;
		} else re += escape(c);
	}
	return new RegExp(`^${re}$`);
}

function escape(s: string): string {
	return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: string[]): string[] {
	return globs.filter((g) => globToRegExp(g).test(path));
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `git add bridge/extensions/orchestrator/core/path-glob.ts bridge/extensions/orchestrator/core/path-glob.test.ts && git commit -m "feat(bridge): dependency-free path glob matcher"`

---

### Task 4: Deterministic check discovery

**Files:**
- Create: `bridge/extensions/orchestrator/core/check-discovery.ts`
- Test: `bridge/extensions/orchestrator/core/check-discovery.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DiscoveredCheck { name: string; argv: string[]; cwd: string; source: string }
export interface RepoReader { exists(rel: string): boolean; read(rel: string): string | null }
export function discoverChecks(reader: RepoReader, packageDirs?: string[]): DiscoveredCheck[]
```

Rules, per package dir (default `["."]`): `package.json` scripts `typecheck`, `lint`, `test` (in that order) run via `bun run` if `bun.lock`/`bun.lockb` exists, `pnpm run` if `pnpm-lock.yaml`, `yarn` if `yarn.lock`, else `npm run`; `pyproject.toml`/`pytest.ini`/`setup.cfg` with a `tests/` dir ⇒ `python3 -m pytest -q`; `Makefile` with a `test:` target ⇒ `make test`. Duplicates by argv+cwd removed.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { discoverChecks, type RepoReader } from "./check-discovery.ts";

function reader(files: Record<string, string>): RepoReader {
	return { exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)), read: (p) => files[p] ?? null };
}

describe("discoverChecks", () => {
	test("bun package scripts in typecheck, lint, test order", () => {
		const checks = discoverChecks(reader({ "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "x", build: "y", typecheck: "tsc" } }), "bun.lock": "" }));
		expect(checks.map((c) => c.argv)).toEqual([["bun", "run", "typecheck"], ["bun", "run", "lint"], ["bun", "run", "test"]]);
	});
	test("python repo with tests dir", () => {
		expect(discoverChecks(reader({ "pyproject.toml": "[project]", "tests/test_a.py": "" })).map((c) => c.argv)).toEqual([["python3", "-m", "pytest", "-q"]]);
	});
	test("nothing discoverable yields empty list", () => {
		expect(discoverChecks(reader({ "README.md": "" }))).toEqual([]);
	});
	test("malformed package.json is ignored, not thrown", () => {
		expect(discoverChecks(reader({ "package.json": "{" }))).toEqual([]);
	});
	test("sub-package cwd is preserved", () => {
		const c = discoverChecks(reader({ "pkg/a/package.json": JSON.stringify({ scripts: { test: "t" } }) }), ["pkg/a"]);
		expect(c).toEqual([{ name: "pkg/a:test", argv: ["npm", "run", "test"], cwd: "pkg/a", source: "pkg/a/package.json" }]);
	});
});
```

- [ ] **Step 2: Run** `bun test core/check-discovery.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface DiscoveredCheck { name: string; argv: string[]; cwd: string; source: string }
export interface RepoReader { exists(rel: string): boolean; read(rel: string): string | null }

const SCRIPT_ORDER = ["typecheck", "lint", "test"] as const;

function join(dir: string, file: string): string {
	return dir === "." || dir === "" ? file : `${dir}/${file}`;
}

function runner(reader: RepoReader, dir: string): string[] {
	const at = (f: string) => reader.exists(join(dir, f)) || reader.exists(f);
	if (at("bun.lock") || at("bun.lockb")) return ["bun", "run"];
	if (at("pnpm-lock.yaml")) return ["pnpm", "run"];
	if (at("yarn.lock")) return ["yarn"];
	return ["npm", "run"];
}

function label(dir: string, name: string): string {
	return dir === "." || dir === "" ? name : `${dir}:${name}`;
}

export function discoverChecks(reader: RepoReader, packageDirs: string[] = ["."]): DiscoveredCheck[] {
	const out: DiscoveredCheck[] = [];
	for (const dir of packageDirs) {
		const pkgPath = join(dir, "package.json");
		const pkgText = reader.read(pkgPath);
		if (pkgText !== null) {
			try {
				const scripts = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts ?? {};
				for (const s of SCRIPT_ORDER) {
					if (typeof scripts[s] === "string") out.push({ name: label(dir, s), argv: [...runner(reader, dir), s], cwd: dir, source: pkgPath });
				}
			} catch {
				// malformed package.json: no checks from it
			}
		}
		const py = ["pyproject.toml", "pytest.ini", "setup.cfg"].find((f) => reader.exists(join(dir, f)));
		if (py && reader.exists(join(dir, "tests"))) out.push({ name: label(dir, "pytest"), argv: ["python3", "-m", "pytest", "-q"], cwd: dir, source: join(dir, py) });
		const make = reader.read(join(dir, "Makefile"));
		if (make !== null && /^test\s*:/m.test(make)) out.push({ name: label(dir, "make test"), argv: ["make", "test"], cwd: dir, source: join(dir, "Makefile") });
	}
	const seen = new Set<string>();
	return out.filter((c) => { const k = `${c.cwd}\0${c.argv.join("\0")}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `git add bridge/extensions/orchestrator/core/check-discovery.ts bridge/extensions/orchestrator/core/check-discovery.test.ts && git commit -m "feat(bridge): deterministic check discovery from package/pyproject/Makefile"`

---

### Task 5: Routing signals

**Files:**
- Create: `bridge/extensions/orchestrator/core/workflow-signals.ts`
- Test: `bridge/extensions/orchestrator/core/workflow-signals.test.ts`

**Interfaces:**
- Consumes: `matchesAny` (Task 3), `discoverChecks`/`RepoReader` (Task 4), `WorkflowPolicy` (Task 1).
- Produces:

```ts
export interface WorkflowSignals {
	candidates: string[];          // repo files named or unambiguously referenced by the goal
	packages: string[];            // nearest dir with package.json/pyproject.toml for each candidate ('.' if none)
	riskPathHits: string[];        // "path ⇐ glob"
	interfaceHits: string[];
	testsNearby: boolean;          // every candidate is a test or has an adjacent test
	checks: DiscoveredCheck[];
	ambiguous: boolean;            // no candidates resolved
	triageRisk: string;
	taskClass: string;
}
export function collectWorkflowSignals(input: { goal: string; files: string[]; reader: RepoReader; triageRisk: string; taskClass: string; policy: WorkflowPolicy }): WorkflowSignals
export function listRepoFiles(cwd: string, timeoutMs: number): string[] | null   // git ls-files -z; null on failure
export function fsReader(root: string): RepoReader
```

Candidate extraction: tokens in the goal matching `/[\w@.\-]+(?:\/[\w@.\-]+)*\.[A-Za-z0-9]+|[\w@.\-]+(?:\/[\w@.\-]+)+/g`; a token that equals a repo file (or a directory prefix of repo files, which adds up to 25 of its files) is a candidate; a bare basename (`foo.ts`) is a candidate only if it matches exactly one repo file.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { collectWorkflowSignals } from "./workflow-signals.ts";
import { METHOD } from "../models.ts";

const policy = METHOD.rules.workflow_policy!;
const files = ["package.json", "bun.lock", "src/util/format.ts", "src/util/format.test.ts", "src/auth/login.ts", "src/api/index.ts", "pkg/b/package.json", "pkg/b/x.ts", "README.md"];
const reader = { exists: (p: string) => files.includes(p) || files.some((f) => f.startsWith(`${p}/`)), read: (p: string) => (p === "package.json" ? '{"scripts":{"test":"bun test"}}' : files.includes(p) ? "" : null) };
const collect = (goal: string, triageRisk = "low") => collectWorkflowSignals({ goal, files, reader, triageRisk, taskClass: "implementation", policy });

describe("collectWorkflowSignals", () => {
	test("single localized file with adjacent test", () => {
		const s = collect("Fix rounding in src/util/format.ts");
		expect(s.candidates).toEqual(["src/util/format.ts"]);
		expect(s.testsNearby).toBe(true);
		expect(s.riskPathHits).toEqual([]);
		expect(s.checks.map((c) => c.name)).toEqual(["test"]);
		expect(s.ambiguous).toBe(false);
	});
	test("unique basename resolves", () => {
		expect(collect("tweak format.ts output").candidates).toEqual(["src/util/format.ts"]);
	});
	test("risk path detected regardless of stated risk", () => {
		expect(collect("rename a variable in src/auth/login.ts").riskPathHits[0]).toContain("src/auth/login.ts");
	});
	test("interface file and packages", () => {
		const s = collect("change src/api/index.ts and pkg/b/x.ts");
		expect(s.interfaceHits.length).toBe(1);
		expect(s.packages.sort()).toEqual([".", "pkg/b"]);
	});
	test("vague goal is ambiguous", () => {
		expect(collect("make it faster").ambiguous).toBe(true);
	});
});
```

- [ ] **Step 2: Run** `bun test core/workflow-signals.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowPolicy } from "../models.ts";
import { discoverChecks, type DiscoveredCheck, type RepoReader } from "./check-discovery.ts";
import { matchesAny } from "./path-glob.ts";

export interface WorkflowSignals {
	candidates: string[]; packages: string[]; riskPathHits: string[]; interfaceHits: string[];
	testsNearby: boolean; checks: DiscoveredCheck[]; ambiguous: boolean; triageRisk: string; taskClass: string;
}

const TOKEN = /[\w@.\-]+(?:\/[\w@.\-]+)*\.[A-Za-z0-9]+|[\w@.\-]+(?:\/[\w@.\-]+)+/g;
const MAX_DIR_EXPANSION = 25;

function resolveCandidates(goal: string, files: string[]): string[] {
	const set = new Set(files);
	const out = new Set<string>();
	for (const raw of goal.match(TOKEN) ?? []) {
		const token = raw.replace(/^\.\//, "").replace(/[.,;:)]+$/, "");
		if (set.has(token)) { out.add(token); continue; }
		const underDir = files.filter((f) => f.startsWith(`${token.replace(/\/$/, "")}/`));
		if (underDir.length > 0) { underDir.slice(0, MAX_DIR_EXPANSION).forEach((f) => out.add(f)); continue; }
		if (!token.includes("/")) {
			const byBase = files.filter((f) => f === token || f.endsWith(`/${token}`));
			if (byBase.length === 1) out.add(byBase[0]);
		}
	}
	return [...out].sort();
}

function packageOf(file: string, files: Set<string>): string {
	const parts = file.split("/");
	for (let i = parts.length - 1; i > 0; i--) {
		const dir = parts.slice(0, i).join("/");
		if (files.has(`${dir}/package.json`) || files.has(`${dir}/pyproject.toml`)) return dir;
	}
	return ".";
}

const TEST_FILE = /(^|\/)(tests?\/|test_[^/]+\.py$|[^/]+\.(test|spec)\.[jt]sx?$)/;

function hasAdjacentTest(file: string, files: Set<string>): boolean {
	if (TEST_FILE.test(file)) return true;
	const slash = file.lastIndexOf("/");
	const dir = slash < 0 ? "" : file.slice(0, slash + 1);
	const base = file.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const stem = dot < 0 ? base : base.slice(0, dot);
	const ext = dot < 0 ? "" : base.slice(dot + 1);
	const options = [`${dir}${stem}.test.${ext}`, `${dir}${stem}.spec.${ext}`, `${dir}test_${stem}.py`, `tests/test_${stem}.py`];
	return options.some((o) => files.has(o)) || [...files].some((f) => f.startsWith("tests/") && f.endsWith(`/test_${stem}.py`));
}

export function collectWorkflowSignals(input: { goal: string; files: string[]; reader: RepoReader; triageRisk: string; taskClass: string; policy: WorkflowPolicy }): WorkflowSignals {
	const fileSet = new Set(input.files);
	const candidates = resolveCandidates(input.goal, input.files);
	const packages = [...new Set(candidates.map((f) => packageOf(f, fileSet)))].sort();
	const hits = (globs: string[]) => candidates.flatMap((f) => matchesAny(f, globs).map((g) => `${f} ⇐ ${g}`));
	return {
		candidates,
		packages,
		riskPathHits: hits(input.policy.risk_path_globs),
		interfaceHits: hits(input.policy.interface_globs),
		testsNearby: candidates.length > 0 && candidates.every((f) => hasAdjacentTest(f, fileSet)),
		checks: discoverChecks(input.reader, packages.length ? packages : ["."]),
		ambiguous: candidates.length === 0,
		triageRisk: input.triageRisk,
		taskClass: input.taskClass,
	};
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

export function listRepoFiles(cwd: string, timeoutMs: number): string[] | null {
	try {
		const out = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "ls-files", "-z"], { cwd, env: GIT_ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
		return out.toString("utf8").split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

export function fsReader(root: string): RepoReader {
	return {
		exists: (rel) => existsSync(join(root, rel)),
		read: (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } },
	};
}
```

- [ ] **Step 4: Run** `bun test core/workflow-signals.test.ts && bash ../../../scripts/typecheck-bridge.sh` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bridge/extensions/orchestrator/core/workflow-signals.ts bridge/extensions/orchestrator/core/workflow-signals.test.ts && git commit -m "feat(bridge): deterministic workflow routing signals"`

---

### Task 6: Router, floors and `--workflow` override

**Files:**
- Create: `bridge/extensions/orchestrator/core/workflow-router.ts`
- Modify: `bridge/extensions/orchestrator/core/args.ts` (`OrchestrateArgs`, flag parsing near `--lead-size` ~line 229, known-flags list ~line 122)
- Test: `bridge/extensions/orchestrator/core/workflow-router.test.ts`, `bridge/extensions/orchestrator/core/args.test.ts`

**Interfaces:**
- Produces:

```ts
export interface WorkflowDecision { level: WorkflowLevel; floor: WorkflowLevel; reasons: string[]; uncertainty: string[]; override?: { requested: WorkflowLevel; accepted: boolean; reason: string } }
export const LEVEL_ORDER: readonly WorkflowLevel[]  // ["direct","checked","led","full"]
export function atLeast(a: WorkflowLevel, b: WorkflowLevel): WorkflowLevel
export function routeWorkflow(s: WorkflowSignals, policy: WorkflowPolicy): WorkflowDecision
export function applyWorkflowOverride(d: WorkflowDecision, requested: WorkflowLevel | undefined): WorkflowDecision
```

`OrchestrateArgs.workflowLevel?: WorkflowLevel` parsed from `--workflow direct|checked|led|full`; invalid values go to `unknownFlags`.

- [ ] **Step 1: Failing tests** — `core/workflow-router.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyWorkflowOverride, routeWorkflow } from "./workflow-router.ts";
import type { WorkflowSignals } from "./workflow-signals.ts";
import { METHOD } from "../models.ts";

const policy = METHOD.rules.workflow_policy!;
const check = { name: "test", argv: ["bun", "run", "test"], cwd: ".", source: "package.json" };
const base: WorkflowSignals = { candidates: ["src/a.ts"], packages: ["."], riskPathHits: [], interfaceHits: [], testsNearby: true, checks: [check], ambiguous: false, triageRisk: "low", taskClass: "implementation" };
const route = (o: Partial<WorkflowSignals>) => routeWorkflow({ ...base, ...o }, policy);

describe("routeWorkflow", () => {
	test("one localized low-risk file with tests and checks ⇒ direct", () => expect(route({}).level).toBe("direct"));
	test("no discovered checks ⇒ never direct", () => expect(route({ checks: [] }).level).toBe("checked"));
	test("no adjacent tests ⇒ checked", () => expect(route({ testsNearby: false }).level).toBe("checked"));
	test("medium risk ⇒ checked", () => expect(route({ triageRisk: "medium" }).level).toBe("checked"));
	test("2–3 files ⇒ checked", () => expect(route({ candidates: ["a", "b", "c"] }).level).toBe("checked"));
	test("4+ files ⇒ led", () => expect(route({ candidates: ["a", "b", "c", "d"] }).level).toBe("led"));
	test("3+ packages ⇒ led", () => expect(route({ packages: [".", "p1", "p2"] }).level).toBe("led"));
	test("ambiguous ⇒ led", () => expect(route({ candidates: [], ambiguous: true }).level).toBe("led"));
	test("risk path ⇒ full with full floor", () => {
		const d = route({ riskPathHits: ["src/auth/a.ts ⇐ **/auth/**"] });
		expect([d.level, d.floor]).toEqual(["full", "full"]);
	});
	test("explicit high risk ⇒ full", () => expect(route({ triageRisk: "high" }).level).toBe("full"));
	test("interface change across packages ⇒ full", () => expect(route({ interfaceHits: ["x"], packages: [".", "pkg/b"] }).level).toBe("full"));
	test("local interface change ⇒ checked", () => expect(route({ interfaceHits: ["x"] }).level).toBe("checked"));
});

describe("applyWorkflowOverride", () => {
	test("override above floor accepted", () => {
		const d = applyWorkflowOverride(route({}), "led");
		expect(d.level).toBe("led");
		expect(d.override?.accepted).toBe(true);
	});
	test("override below floor rejected with reason", () => {
		const d = applyWorkflowOverride(route({ riskPathHits: ["x ⇐ **/auth/**"] }), "direct");
		expect(d.level).toBe("full");
		expect(d.override).toEqual({ requested: "direct", accepted: false, reason: "below hard floor full" });
	});
});
```

`core/args.test.ts` (append):

```ts
test("--workflow parses a level and rejects others", () => {
	expect(parseArgs("--workflow direct fix x").workflowLevel).toBe("direct");
	const bad = parseArgs("--workflow tiny fix x");
	expect(bad.workflowLevel).toBeUndefined();
	expect(bad.unknownFlags).toContain("--workflow tiny");
});
```

Use the existing exported parser name from `core/args.ts` (search `export function parse`) in place of `parseArgs` if it differs.

- [ ] **Step 2: Run** `bun test core/workflow-router.test.ts core/args.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `core/workflow-router.ts`:

```ts
import type { WorkflowLevel, WorkflowPolicy } from "../models.ts";
import type { WorkflowSignals } from "./workflow-signals.ts";

export interface WorkflowDecision {
	level: WorkflowLevel; floor: WorkflowLevel; reasons: string[]; uncertainty: string[];
	override?: { requested: WorkflowLevel; accepted: boolean; reason: string };
}

export const LEVEL_ORDER: readonly WorkflowLevel[] = ["direct", "checked", "led", "full"];
const rank = (l: WorkflowLevel) => LEVEL_ORDER.indexOf(l);
export const atLeast = (a: WorkflowLevel, b: WorkflowLevel): WorkflowLevel => (rank(a) >= rank(b) ? a : b);

export function routeWorkflow(s: WorkflowSignals, policy: WorkflowPolicy): WorkflowDecision {
	const uncertainty = [
		...(s.ambiguous ? ["no candidate files resolved from the goal"] : []),
		...(s.checks.length === 0 ? ["no deterministic checks discovered"] : []),
	];
	const highRisk = s.triageRisk === "high" || s.triageRisk === "critical";
	if (highRisk || s.riskPathHits.length > 0) {
		return { level: "full", floor: "full", uncertainty, reasons: [highRisk ? `explicit risk ${s.triageRisk}` : `protected path: ${s.riskPathHits[0]}`] };
	}
	if (s.interfaceHits.length > 0 && s.packages.length > 1) {
		return { level: "full", floor: "direct", uncertainty, reasons: [`interface change across ${s.packages.length} packages`] };
	}
	const t = policy.thresholds;
	if (s.ambiguous || s.candidates.length >= t.led_min_files || s.packages.length >= t.led_min_packages) {
		const why = s.ambiguous ? "scope unresolved" : s.candidates.length >= t.led_min_files ? `${s.candidates.length} candidate files` : `${s.packages.length} packages`;
		return { level: "led", floor: "direct", uncertainty, reasons: [why] };
	}
	if (s.candidates.length === 1 && s.triageRisk === "low" && s.interfaceHits.length === 0 && s.testsNearby && s.checks.length > 0) {
		return { level: "direct", floor: "direct", uncertainty, reasons: ["one localized low-risk file with adjacent tests and runnable checks"] };
	}
	const why = s.checks.length === 0 ? "no runnable checks" : !s.testsNearby ? "no adjacent tests" : s.interfaceHits.length ? "local interface change" : s.triageRisk !== "low" ? `risk ${s.triageRisk}` : `${s.candidates.length} files`;
	return { level: "checked", floor: "direct", uncertainty, reasons: [why] };
}

export function applyWorkflowOverride(d: WorkflowDecision, requested: WorkflowLevel | undefined): WorkflowDecision {
	if (!requested) return d;
	if (rank(requested) < rank(d.floor)) return { ...d, override: { requested, accepted: false, reason: `below hard floor ${d.floor}` } };
	return { ...d, level: requested, reasons: [...d.reasons, `override --workflow ${requested}`], override: { requested, accepted: true, reason: "at or above floor" } };
}
```

In `core/args.ts`: add `workflowLevel?: WorkflowLevel;` to `OrchestrateArgs` (import the type from `../models.ts`), add `"--workflow"` to the value-taking flag list next to `"--lead-size"`, and in the switch:

```ts
			case "--workflow":
				if (next && ["direct", "checked", "led", "full"].includes(next)) { out.workflowLevel = next as WorkflowLevel; i++; }
				else { out.unknownFlags.push(`--workflow ${next ?? ""}`.trim()); if (next) i++; }
				break;
```

Match the surrounding code's exact variable names (`out`, `next`, `i`) as used by the `--lead-size` case at ~line 229.

- [ ] **Step 4: Run** `bun test && bash ../../../scripts/typecheck-bridge.sh` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bridge/extensions/orchestrator/core/workflow-router.ts bridge/extensions/orchestrator/core/workflow-router.test.ts bridge/extensions/orchestrator/core/args.ts bridge/extensions/orchestrator/core/args.test.ts && git commit -m "feat(bridge): workflow router with hard floors and --workflow override"`

---

### Task 7: Observe mode — record the planned level on every run

**Files:**
- Modify: `bridge/extensions/orchestrator/pipeline/run-orchestration.ts` (after the `lead_sized` event/log, ~line 488; the `completeRun` summary ~line 1030)
- Modify: `orchestrator/run_evidence.py` (result dict: pass through `note.get('workflow')`)
- Modify: `orchestrator/analytics/task_outcomes.py` (Phase 0) — add `workflow_level_planned`, `workflow_level_final`, `workflow_escalations`, `workflow_mode`
- Test: `bridge/extensions/orchestrator/pipeline/run-orchestration.test.ts`, `tests/test_task_outcomes.py`

**Interfaces:**
- Consumes: Tasks 2, 5, 6.
- Produces: event `workflow_level_planned {run_id, mode, level, floor, reasons, uncertainty, signal_ms, candidates, packages, risk_path_hits, checks, override}` when mode ≠ `off`; run summary key `workflow: {mode, planned, final, escalations, reasons, signal_ms} | undefined` (absent when `off`, keeping today's summary shape).

- [ ] **Step 1: Failing tests** — in `pipeline/run-orchestration.test.ts`, model two tests on the existing resume test (~line 470) that capture `recordEvent` calls and the `completeRun` summary via `fakeDeps({...})`:

```ts
test("observe mode records workflow_level_planned and a workflow summary without changing dispatch", async () => {
	const events: Array<[string, Record<string, unknown>]> = [];
	let summary: Record<string, unknown> | undefined;
	const deps = fakeDeps({
		env: { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "observe" },
		recordEvent: (e, p) => { events.push([e, p]); },
		completeRun: async (_id, s) => { summary = s; return healthyTelemetry; },
	});
	await runOrchestration(/* same arguments as the neighbouring tests, goal "Fix src/a.ts" */);
	const planned = events.find(([e]) => e === "workflow_level_planned");
	expect(planned?.[1].mode).toBe("observe");
	expect((summary?.workflow as { mode: string }).mode).toBe("observe");
	expect(events.some(([e]) => e === "dispatch_plan_confirmed")).toBe(true);   // coordinated path still ran
});

test("off mode emits no workflow event and no workflow summary key", async () => {
	const events: string[] = [];
	let summary: Record<string, unknown> | undefined;
	const deps = fakeDeps({ env: {}, recordEvent: (e) => { events.push(e); }, completeRun: async (_id, s) => { summary = s; return healthyTelemetry; } });
	await runOrchestration(/* same arguments */);
	expect(events).not.toContain("workflow_level_planned");
	expect(summary && "workflow" in summary).toBe(false);
});
```

Fill the `runOrchestration(...)` argument list by copying it verbatim from the neighbouring resume test. `tests/test_task_outcomes.py` (append):

```python
    def test_workflow_fields_from_summary(self):
        [row] = task_outcomes([call('w')], [], [complete('w', verification_passed=True,
                               workflow={'mode': 'enforce', 'planned': 'direct', 'final': 'led', 'escalations': 1})])
        self.assertEqual((row['workflow_mode'], row['workflow_level_planned'], row['workflow_level_final'], row['workflow_escalations']),
                         ('enforce', 'direct', 'led', 1))
```

- [ ] **Step 2: Run** `(cd bridge/extensions/orchestrator && bun test pipeline/run-orchestration.test.ts) && python3 -m pytest -q tests/test_task_outcomes.py` — Expected: FAIL.

- [ ] **Step 3: Implement** — in `run-orchestration.ts` add imports:

```ts
import { METHOD } from "../models.ts";
import { resolveWorkflowMode } from "../workflow-mode.ts";
import { collectWorkflowSignals, fsReader, listRepoFiles } from "../core/workflow-signals.ts";
import { applyWorkflowOverride, routeWorkflow, type WorkflowDecision } from "../core/workflow-router.ts";
```

After `session.log(\`lead size: …\`)` insert:

```ts
	// Workflow level (spec §3). `off` does nothing at all; `observe` records the plan only.
	const workflowPolicy = METHOD.rules.workflow_policy;
	const workflowMode = resolveWorkflowMode(workflowPolicy, deps.env);
	for (const p of workflowMode.problems) session.log(`workflow: ${p}`);
	let workflow: WorkflowDecision | null = null;
	let workflowSignalMs = 0;
	if (workflowMode.mode !== "off" && workflowPolicy) {
		const t0 = performance.now();
		const root = resolve(cwd);
		const files = listRepoFiles(root, workflowPolicy.signal_timeout_ms) ?? [];
		const signals = collectWorkflowSignals({ goal: parsed.goal, files, reader: fsReader(root), triageRisk: effectiveRisk, taskClass: effectiveTaskClass, policy: workflowPolicy });
		workflow = applyWorkflowOverride(routeWorkflow(signals, workflowPolicy), parsed.workflowLevel);
		workflowSignalMs = Math.round(performance.now() - t0);
		deps.recordEvent("workflow_level_planned", {
			run_id: runId, mode: workflowMode.mode, level: workflow.level, floor: workflow.floor,
			reasons: workflow.reasons, uncertainty: workflow.uncertainty, signal_ms: workflowSignalMs,
			candidates: signals.candidates.length, packages: signals.packages, risk_path_hits: signals.riskPathHits,
			checks: signals.checks.map((c) => c.name), override: workflow.override ?? null,
		});
		session.log(`workflow: ${workflowMode.mode} → ${workflow.level} (floor ${workflow.floor}; ${workflow.reasons.join("; ")}; ${workflowSignalMs}ms)`);
	}
```

(`resolve` is already imported for `repoRoot`; move `const repoRoot = resolve(cwd);` up if needed rather than duplicating.) In the `completeRun` summary object add:

```ts
		...(workflow ? { workflow: { mode: workflowMode.mode, planned: workflow.level, final: workflow.level, escalations: 0, reasons: workflow.reasons, signal_ms: workflowSignalMs } } : {}),
```

In `orchestrator/run_evidence.py` result dict add `'workflow': note.get('workflow') if isinstance(note.get('workflow'), dict) else None,`. In `orchestrator/analytics/task_outcomes.py::task_outcomes` add:

```python
        wf = ev.get('workflow') or {}
```

and the fields:

```python
            'workflow_mode': wf.get('mode'), 'workflow_level_planned': wf.get('planned'),
            'workflow_level_final': wf.get('final'), 'workflow_escalations': wf.get('escalations'),
```

- [ ] **Step 4: Run** `(cd bridge/extensions/orchestrator && bun test) && bash scripts/typecheck-bridge.sh && python3 -m pytest -q` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/extensions/orchestrator/pipeline/run-orchestration.ts bridge/extensions/orchestrator/pipeline/run-orchestration.test.ts orchestrator/run_evidence.py orchestrator/analytics/task_outcomes.py tests/test_task_outcomes.py
git commit -m "feat(workflow): observe mode records planned level and signal overhead"
```

- [ ] **Step 6: Observe window** — enable `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE=observe` for normal use for at least one week; review `workflow_level_planned` distribution and `signal_ms` p90 (must stay under `signal_timeout_ms`) before Task 10's `enforce` is exercised on real work.

---

### Task 8: Deterministic check runner

**Files:**
- Create: `bridge/extensions/orchestrator/pipeline/check-runner.ts`
- Test: `bridge/extensions/orchestrator/pipeline/check-runner.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CheckRunResult { name: string; argv: string[]; status: "pass" | "fail" | "timeout" | "error"; exitCode: number | null; durationMs: number; tail: string }
export async function runChecks(checks: DiscoveredCheck[], repoRoot: string, timeoutMs: number, cancellation?: { isCancelled: boolean }): Promise<CheckRunResult[]>
```

Sequential, `spawn(argv[0], argv.slice(1), { cwd: join(repoRoot, check.cwd), shell: false, detached: true })`; on timeout kill the process group (`process.kill(-pid, "SIGTERM")`, then `SIGKILL` after 5s); output tail capped at 4000 chars; spawn error ⇒ `error`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { runChecks } from "./check-runner.ts";

const node = process.execPath;
const mk = (name: string, code: string) => ({ name, argv: [node, "-e", code], cwd: ".", source: "test" });

describe("runChecks", () => {
	test("pass and fail are reported per check", async () => {
		const r = await runChecks([mk("ok", "process.exit(0)"), mk("bad", "console.error('boom'); process.exit(3)")], process.cwd(), 10_000);
		expect(r.map((x) => [x.name, x.status, x.exitCode])).toEqual([["ok", "pass", 0], ["bad", "fail", 3]]);
		expect(r[1].tail).toContain("boom");
	});
	test("a hanging check times out and is killed", async () => {
		const t0 = Date.now();
		const [r] = await runChecks([mk("hang", "setInterval(() => {}, 1000)")], process.cwd(), 300);
		expect(r.status).toBe("timeout");
		expect(Date.now() - t0).toBeLessThan(8000);
	});
	test("missing binary is an error, not a throw", async () => {
		const [r] = await runChecks([{ name: "nope", argv: ["definitely-not-a-binary-xyz"], cwd: ".", source: "t" }], process.cwd(), 1000);
		expect(r.status).toBe("error");
	});
});
```

- [ ] **Step 2: Run** `bun test pipeline/check-runner.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { DiscoveredCheck } from "../core/check-discovery.ts";

export interface CheckRunResult { name: string; argv: string[]; status: "pass" | "fail" | "timeout" | "error"; exitCode: number | null; durationMs: number; tail: string }
const TAIL = 4000;

function runOne(check: DiscoveredCheck, repoRoot: string, timeoutMs: number): Promise<CheckRunResult> {
	const started = Date.now();
	return new Promise((resolveResult) => {
		let out = "";
		let timedOut = false;
		let settled = false;
		const finish = (status: CheckRunResult["status"], exitCode: number | null) => {
			if (settled) return;
			settled = true;
			resolveResult({ name: check.name, argv: check.argv, status, exitCode, durationMs: Date.now() - started, tail: out.slice(-TAIL) });
		};
		let child;
		try {
			child = spawn(check.argv[0], check.argv.slice(1), { cwd: join(repoRoot, check.cwd), shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
		} catch (err) {
			out = String(err); finish("error", null); return;
		}
		const append = (b: Buffer) => { out = (out + b.toString("utf8")).slice(-TAIL * 2); };
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ } };
		const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 5000).unref(); }, timeoutMs);
		child.on("error", (err) => { clearTimeout(timer); out += String(err); finish("error", null); });
		child.on("close", (code) => { clearTimeout(timer); finish(timedOut ? "timeout" : code === 0 ? "pass" : "fail", code); });
	});
}

export async function runChecks(checks: DiscoveredCheck[], repoRoot: string, timeoutMs: number, cancellation?: { isCancelled: boolean }): Promise<CheckRunResult[]> {
	const results: CheckRunResult[] = [];
	for (const c of checks) {
		if (cancellation?.isCancelled) break;
		results.push(await runOne(c, repoRoot, timeoutMs));
	}
	return results;
}
```

- [ ] **Step 4: Run** `bun test pipeline/check-runner.test.ts && bash ../../../scripts/typecheck-bridge.sh` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bridge/extensions/orchestrator/pipeline/check-runner.ts bridge/extensions/orchestrator/pipeline/check-runner.test.ts && git commit -m "feat(bridge): deterministic check runner with process-group timeouts"`

---

### Task 9: Flat levels — single implementer and flat verification

**Files:**
- Create: `bridge/extensions/orchestrator/pipeline/flat-level.ts`
- Test: `bridge/extensions/orchestrator/pipeline/flat-level.test.ts`

**Interfaces:**
- Consumes: `DispatchTask`/`DispatchResult` (`core/prompts.ts`, `core/records.ts`), `VerificationResult` (`pipeline/verify-loop.ts:91`), `hasExplicitFailVerdict` (`verify-loop.ts:333`), `runChecks` (Task 8), `DiscoveredCheck`.
- Produces:

```ts
export function implementerTask(runId: string, goal: string, providedContext: string, level: "direct" | "checked"): DispatchTask
export async function dispatchFlat(input: { runId: string; goal: string; providedContext: string; level: "direct" | "checked" }, deps: { dispatch(tasks: DispatchTask[]): Promise<DispatchResult[]>; captureDispatchCost(r: DispatchResult): Promise<void> }): Promise<FlatDispatch>
// FlatDispatch has exactly the fields runOrchestration destructures from dispatchHierarchical:
// { leadResults, workerResults: [], architectResult: undefined, skippedLeads: [], leadTasks, resumedLeadTaskIds: [], retriedLeadTaskIds: [], resumedAttemptResults: [], pendingChecks: [] }
export async function runFlatVerification(input: { runId: string; level: "direct" | "checked"; files: string[]; checks: DiscoveredCheck[]; repoRoot: string; checkTimeoutMs: number; goal: string },
	deps: { dispatch(tasks: DispatchTask[]): Promise<DispatchResult[]>; captureDispatchCost(r: DispatchResult): Promise<void>; recordOutcome(o: Record<string, unknown>): void; runChecks?: typeof runChecks }): Promise<VerificationResult>
```

The implementer prompt requires the lead report contract (`## Files Changed` bullets and a final `STATUS: completed|partial|blocked` line) so `parseLeadStatus`/`parseLeadFilesChanged`/`qaScopeEvidenceFor` work unchanged. `runFlatVerification` writes the run-scoped verification outcome `{run_id, task_id: \`${runId}-qa\`, verification_scope: "run", outcome, verification, checks, check_commands, evidence_status, workflow_level}` that `orchestrator/run_evidence.py` already treats as the run verdict.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { dispatchFlat, implementerTask, runFlatVerification } from "./flat-level.ts";

const ok = (taskId: string, capability: string, stdout = "## Files Changed\n- src/a.ts\n\nSTATUS: completed") => ({
	taskId, capability, model: "p/m", exitCode: 0, stdout, stderr: "", filesChanged: ["src/a.ts"], durationMs: 1, costUsd: 0.1, costReported: true,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 1 },
});

describe("flat level", () => {
	test("implementer task carries goal, context and report contract", () => {
		const t = implementerTask("r1", "Fix src/a.ts", "CTX", "direct");
		expect(t.capability).toBe("implementation_strong");
		expect(t.task).toContain("Fix src/a.ts");
		expect(t.task).toContain("CTX");
		expect(t.task).toContain("STATUS: completed|partial|blocked");
	});

	test("dispatchFlat returns the hierarchy shape with one lead-equivalent result", async () => {
		const billed: string[] = [];
		const r = await dispatchFlat({ runId: "r1", goal: "g", providedContext: "", level: "direct" },
			{ dispatch: async (tasks) => tasks.map((t) => ok(t.taskId, t.capability)), captureDispatchCost: async (x) => { billed.push(x.taskId); } });
		expect(r.leadResults).toHaveLength(1);
		expect(r.leadTasks[0].taskId).toBe("r1-impl");
		expect(r.workerResults).toEqual([]);
		expect(billed).toEqual(["r1-impl"]);
	});

	test("direct: failing deterministic check fails verification and records run-scoped outcome", async () => {
		const outcomes: Record<string, unknown>[] = [];
		const v = await runFlatVerification({ runId: "r1", level: "direct", files: ["src/a.ts"], checks: [{ name: "test", argv: ["x"], cwd: ".", source: "p" }], repoRoot: "/r", checkTimeoutMs: 1000, goal: "g" },
			{ dispatch: async () => [], captureDispatchCost: async () => {}, recordOutcome: (o) => outcomes.push(o),
			  runChecks: async () => [{ name: "test", argv: ["x"], status: "fail", exitCode: 1, durationMs: 1, tail: "1 failed" }] });
		expect(v.passed).toBe(false);
		expect(v.failedChecks).toEqual(["test"]);
		expect(outcomes[0]).toMatchObject({ task_id: "r1-qa", verification_scope: "run", outcome: "fail", verification: false, workflow_level: "direct" });
	});

	test("checked: passing checks plus explicit FAIL review verdict fails", async () => {
		const v = await runFlatVerification({ runId: "r1", level: "checked", files: ["src/a.ts"], checks: [{ name: "test", argv: ["x"], cwd: ".", source: "p" }], repoRoot: "/r", checkTimeoutMs: 1000, goal: "g" },
			{ dispatch: async (tasks) => tasks.map((t) => ok(t.taskId, t.capability, "## Verdict\nFAIL\n- off-by-one remains")), captureDispatchCost: async () => {}, recordOutcome: () => {},
			  runChecks: async () => [{ name: "test", argv: ["x"], status: "pass", exitCode: 0, durationMs: 1, tail: "" }] });
		expect(v.passed).toBe(false);
		expect(v.failedChecks).toEqual(["review"]);
		expect(v.dispatch?.capability).toBe("technical_review");
	});

	test("no changed files is skipped (never a pass on nothing)", async () => {
		const v = await runFlatVerification({ runId: "r1", level: "direct", files: [], checks: [], repoRoot: "/r", checkTimeoutMs: 1, goal: "g" },
			{ dispatch: async () => [], captureDispatchCost: async () => {}, recordOutcome: () => {} });
		expect(v.skipped).toBe(true);
	});
});
```

- [ ] **Step 2: Run** `bun test pipeline/flat-level.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { DispatchTask } from "../core/prompts.ts";
import type { DispatchResult } from "../core/records.ts";
import type { DiscoveredCheck } from "../core/check-discovery.ts";
import { runChecks as defaultRunChecks, type CheckRunResult } from "./check-runner.ts";
import { hasExplicitFailVerdict, type VerificationResult } from "./verify-loop.ts";

const REPORT_CONTRACT = [
	"When done, end your reply with:",
	"## Files Changed",
	"- <each repo-relative path you modified, or 'None'>",
	"",
	"STATUS: completed|partial|blocked",
].join("\n");

export function implementerTask(runId: string, goal: string, providedContext: string, level: "direct" | "checked"): DispatchTask {
	return {
		taskId: `${runId}-impl`,
		capability: "implementation_strong",
		task: [
			`Workflow level: ${level}. You are the only implementer; there is no lead or architect.`,
			"Make the smallest correct change for the goal. Run the repository's relevant tests before finishing.",
			"Do not modify tests to make them pass unless the goal asks for it. Do not add dependencies.",
			"",
			"## Goal",
			goal,
			...(providedContext ? ["", "## Provided context", providedContext] : []),
			"",
			REPORT_CONTRACT,
		].join("\n"),
	};
}

export type FlatDispatch = {
	leadResults: DispatchResult[]; workerResults: DispatchResult[]; architectResult: undefined; skippedLeads: never[];
	leadTasks: DispatchTask[]; resumedLeadTaskIds: string[]; retriedLeadTaskIds: string[]; resumedAttemptResults: DispatchResult[]; pendingChecks: never[];
};

export async function dispatchFlat(
	input: { runId: string; goal: string; providedContext: string; level: "direct" | "checked" },
	deps: { dispatch(tasks: DispatchTask[]): Promise<DispatchResult[]>; captureDispatchCost(r: DispatchResult): Promise<void> },
): Promise<FlatDispatch> {
	const task = implementerTask(input.runId, input.goal, input.providedContext, input.level);
	const results = await deps.dispatch([task]);
	for (const r of results) await deps.captureDispatchCost(r);
	return { leadResults: results, workerResults: [], architectResult: undefined, skippedLeads: [], leadTasks: [task],
		resumedLeadTaskIds: [], retriedLeadTaskIds: [], resumedAttemptResults: [], pendingChecks: [] };
}

function reviewTask(runId: string, goal: string, files: string[], checks: CheckRunResult[]): DispatchTask {
	return {
		taskId: `${runId}-review`,
		capability: "technical_review",
		tools: ["read", "grep", "find", "ls"],
		task: [
			"Independently review the change for the goal below. Read the changed files; do not edit anything.",
			"", "## Goal", goal,
			"", "## Changed files", ...files.map((f) => `- ${f}`),
			"", "## Deterministic checks", ...checks.map((c) => `- ${c.name}: ${c.status}`),
			"", "End with `## Verdict` on its own line followed by PASS or FAIL and a short list of blocking issues.",
		].join("\n"),
	};
}

export async function runFlatVerification(
	input: { runId: string; level: "direct" | "checked"; files: string[]; checks: DiscoveredCheck[]; repoRoot: string; checkTimeoutMs: number; goal: string },
	deps: { dispatch(tasks: DispatchTask[]): Promise<DispatchResult[]>; captureDispatchCost(r: DispatchResult): Promise<void>; recordOutcome(o: Record<string, unknown>): void; runChecks?: typeof defaultRunChecks },
): Promise<VerificationResult> {
	if (input.files.length === 0) return { passed: true, skipped: true, summary: "no files changed", failedChecks: [] };
	const results = await (deps.runChecks ?? defaultRunChecks)(input.checks, input.repoRoot, input.checkTimeoutMs);
	const failedChecks = results.filter((r) => r.status !== "pass").map((r) => r.name);
	let dispatch: DispatchResult | undefined;
	if (failedChecks.length === 0 && input.level === "checked") {
		[dispatch] = await deps.dispatch([reviewTask(input.runId, input.goal, input.files, results)]);
		if (dispatch) await deps.captureDispatchCost(dispatch);
		if (!dispatch || dispatch.exitCode !== 0 || hasExplicitFailVerdict(dispatch.stdout)) failedChecks.push("review");
	}
	const passed = failedChecks.length === 0 && results.length > 0;
	if (results.length === 0) failedChecks.push("no deterministic checks ran");
	deps.recordOutcome({
		run_id: input.runId, task_id: `${input.runId}-qa`, verification_scope: "run",
		outcome: passed ? "verified" : "fail", verification: passed, workflow_level: input.level,
		checks: results.map((r) => ({ name: r.name, status: r.status === "pass" ? "pass" : "fail" })),
		check_commands: results.map((r) => r.argv.join(" ")),
		evidence_status: results.length ? "verified" : "unverified_checks_unavailable",
	});
	return { passed, summary: passed ? `${results.length} deterministic check(s) passed` : `failed: ${failedChecks.join(", ")}`, failedChecks, ...(dispatch ? { dispatch } : {}) };
}
```

If `DispatchResult` is not exported from `core/records.ts`, import it from wherever `run-orchestration.ts` imports it (search `DispatchResult` in its import block). If `VerificationResult` requires additional fields, supply them with the same defaults `runVerification` uses when `filesChanged` is empty.

- [ ] **Step 4: Run** `bun test pipeline/flat-level.test.ts && bash ../../../scripts/typecheck-bridge.sh` — Expected: PASS.

- [ ] **Step 5: Commit** `git add bridge/extensions/orchestrator/pipeline/flat-level.ts bridge/extensions/orchestrator/pipeline/flat-level.test.ts && git commit -m "feat(bridge): flat direct/checked implementer and deterministic verification"`

---

### Task 10: Enforce mode with upward escalation and carry-forward

**Files:**
- Modify: `bridge/extensions/orchestrator/pipeline/run-orchestration.ts`
- Test: `bridge/extensions/orchestrator/pipeline/run-orchestration.test.ts`

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces:
  - `runOrchestration(..., deps, carry?: WorkflowCarry)` — new optional last parameter:

```ts
export interface WorkflowCarry {
	fromLevel: "direct" | "checked";
	forceLevel: "led" | "full";
	reason: string;
	priorCostUsd: number;
	priorFixRounds: number;
	priorResults: DispatchResult[];
	dirtyBefore: Map<string, string> | null;
	headBefore: string | null;
}
```

  - Events `workflow_level_escalated {run_id, from, to, reason, failed_checks, prior_cost_usd}`.
  - Summary `workflow.final` reflects the level that produced the verdict; `workflow.escalations` = 1 after escalation; `fix_rounds` includes prior rounds; `total_cost_usd` includes `priorCostUsd`.

- [ ] **Step 1: Failing tests** (same `fakeDeps` pattern as Task 7; env `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE=enforce`; goal naming one file that the fake repo has with an adjacent test; stub `runChecks` through a new optional `deps.runChecks` seam added in Step 3):

```ts
test("enforce direct: implementer + passing checks completes without leads or QA agent", async () => {
	const dispatched: string[] = [];
	let summary: Record<string, unknown> | undefined;
	const deps = fakeDeps({
		env: { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "enforce" },
		runChecks: async () => [{ name: "test", argv: ["bun", "test"], status: "pass", exitCode: 0, durationMs: 1, tail: "" }],
		dispatchParallel: async (_c, _r, tasks) => tasks.map((t) => { dispatched.push(t.capability); return okResult(t); }),
		completeRun: async (_id, s) => { summary = s; return healthyTelemetry; },
	});
	await runOrchestration(/* args, goal "Fix src/util/format.ts", with repo signals yielding direct */);
	expect(dispatched).toEqual(["implementation_strong"]);
	expect((summary!.workflow as { final: string }).final).toBe("direct");
	expect(summary!.verification_passed).toBe(true);
});

test("enforce direct: persistent failure escalates to led, keeps QA scope and prior cost", async () => {
	const dispatched: string[] = [];
	let summary: Record<string, unknown> | undefined;
	const events: string[] = [];
	const deps = fakeDeps({
		env: { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "enforce" },
		runChecks: async () => [{ name: "test", argv: ["bun", "test"], status: "fail", exitCode: 1, durationMs: 1, tail: "1 failed" }],
		dispatchParallel: async (_c, _r, tasks) => tasks.map((t) => { dispatched.push(t.capability); return okResult(t, { costUsd: 0.25 }); }),
		recordEvent: (e) => { events.push(e); },
		completeRun: async (_id, s) => { summary = s; return healthyTelemetry; },
	});
	await runOrchestration(/* same args */);
	// direct attempt, one fix round, then the coordinated pipeline (lead…qa_agent)
	expect(dispatched.slice(0, 2)).toEqual(["implementation_strong", "implementation_strong"]);
	expect(dispatched).toContain("qa_agent");
	expect(events).toContain("workflow_level_escalated");
	const wf = summary!.workflow as { planned: string; final: string; escalations: number };
	expect([wf.planned, wf.final, wf.escalations]).toEqual(["direct", "led", 1]);
	expect(summary!.total_cost_usd as number).toBeGreaterThanOrEqual(0.5);
	expect(summary!.fix_rounds as number).toBeGreaterThanOrEqual(1);
});

test("enforce never runs flat for excluded task classes", async () => {
	const dispatched: string[] = [];
	const deps = fakeDeps({ env: { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "enforce" }, dispatchParallel: async (_c, _r, tasks) => tasks.map((t) => { dispatched.push(t.capability); return okResult(t); }) });
	await runOrchestration(/* args with taskClass "investigation" */);
	expect(dispatched).not.toContain("implementation_strong");
});
```

`okResult(task, overrides)` is a local helper building a successful `DispatchResult` with `stdout` ending in `## Files Changed\n- src/util/format.ts\n\nSTATUS: completed` and `filesChanged: ["src/util/format.ts"]`; copy the result literal shape from the resume test (~line 485). The fake repo for signals: point `cwd` at a temp dir initialised with `git init` containing `package.json` (`{"scripts":{"test":"bun test"}}`), `bun.lock`, `src/util/format.ts`, `src/util/format.test.ts`, all committed.

- [ ] **Step 2: Run** `bun test pipeline/run-orchestration.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** in `run-orchestration.ts`:

1. Add `runChecks?: typeof runChecks;` to `RunOrchestrationDeps` (test seam; production leaves it unset) and import `runChecks`, `dispatchFlat`, `runFlatVerification` and `DiscoveredCheck`.
2. Add the `carry?: WorkflowCarry` parameter and export the interface.
3. In the Task 7 block, keep the collected `signals` in a `let workflowSignals` and, when `carry` is set, force the level: `workflow = { ...workflow, level: atLeast(workflow.level, carry.forceLevel), reasons: [...workflow.reasons, \`escalated from ${carry.fromLevel}: ${carry.reason}\`] }`. When `carry` is set and mode is `off`, still compute the decision (escalation only happens in `enforce`, so this is unreachable in practice; guard with `if (workflowMode.mode !== "off" || carry)`).
4. Decide the path:

```ts
	const flatLevel = workflowMode.mode === "enforce" && !carry && workflow && workflowPolicy
		&& !workflowPolicy.excluded_task_classes.includes(effectiveTaskClass)
		&& (workflow.level === "direct" || workflow.level === "checked") ? workflow.level : null;
```

5. Replace `const dirtyBefore = gitDirtySnapshot(cwd); const headBefore = gitHead(cwd);` with:

```ts
	const dirtyBefore = carry ? carry.dirtyBefore : gitDirtySnapshot(cwd);
	const headBefore = carry ? carry.headBefore : gitHead(cwd);
```

6. Extract the existing `HierarchyDeps` object literal passed to `dispatchHierarchical` into `const hierarchyDeps = { … };` unchanged, then:

```ts
	const dispatched = flatLevel
		? await dispatchFlat({ runId, goal: parsed.goal, providedContext: deps.providedContext, level: flatLevel },
			{ dispatch: hierarchyDeps.dispatch, captureDispatchCost: (r) => deps.captureDispatchCost(captureOpts, r, claimed) })
		: await dispatchHierarchical(runId, plan.plan_id, parsed.goal, plan, adapter, ctx, claimed, leadDecision.capability, hierarchyDeps);
	const { leadResults, workerResults, architectResult, skippedLeads, leadTasks, resumedLeadTaskIds, retriedLeadTaskIds, resumedAttemptResults, pendingChecks } = dispatched;
```

If TypeScript rejects the union, annotate `dispatched` as `Awaited<ReturnType<typeof dispatchHierarchical>>` and cast the flat branch's value with `as unknown as` after confirming field-by-field that the destructured names match (`FlatDispatch` in Task 9 lists them).

7. Carry prior work into QA scope: change `let allFiles = changedSince("lead phase", leadResults);` to `let allFiles = changedSince("lead phase", leadResults, carry?.priorResults ?? []);` and change the `externalChangeFiles(allFiles, qaScopeEvidenceFor(leadResults))` argument to `qaScopeEvidenceFor([...(carry?.priorResults ?? []), ...leadResults])`.
8. Verification and retry budget: before the `while` loop add

```ts
	const retryBudget = flatLevel && workflowPolicy ? workflowPolicy.fix_rounds_per_level : parsed.maxRetries;
	const flatChecks: DiscoveredCheck[] = flatLevel && workflowSignals ? workflowSignals.checks : [];
	const verify = (options?: RunVerificationOptions) => flatLevel && workflowPolicy
		? runFlatVerification({ runId, level: flatLevel, files: allFiles, checks: flatChecks, repoRoot, checkTimeoutMs: workflowPolicy.check_timeout_ms, goal: parsed.goal },
			{ dispatch: (tasks) => deps.dispatchParallel(cwd, runId, tasks, adapter, ctx, claimed), captureDispatchCost: (r) => deps.captureDispatchCost(captureOpts, r, claimed), recordOutcome: deps.recordOutcome, runChecks: deps.runChecks })
		: runVerification(runId, plan.plan_id, allFiles, ctx, claimed, captureOpts, { dispatch: (tasks) => deps.dispatchParallel(cwd, runId, tasks, adapter, ctx, claimed), captureDispatchCost: deps.captureDispatchCost, recordOutcome: deps.recordOutcome }, repoRoot, options);
```

and replace both `runVerification(...)` calls in the loop with `verify()` and `verify({ attempt: 1, reason: … })` respectively. Replace `parsed.maxRetries` with `retryBudget` in the `while` condition, the `session.setPhase` retry text, and the `planEscalation(...)` call. (`planEscalation` retries a non-lead capability with the same capability plus bounded feedback — a fix round.) Import `RunVerificationOptions` from `./verify-loop.ts` if not already imported.

9. Level escalation, immediately after the `while` loop and before `// A lead that failed and was later retried`:

```ts
	if (flatLevel && runOutcome !== "blocked" && !(lastVerification?.passed && !lastVerification.skipped)) {
		const prior = [...leadResults, ...escalationResults, ...verificationResults];
		const priorCostUsd = triageCost.usd + prior.reduce((s, r) => s + r.costUsd + (r.nestedCostUsd ?? 0), 0) + (carry?.priorCostUsd ?? 0);
		const reason = lastVerification?.failedChecks.join(", ") || (dispatchOk ? "verification failed" : "implementer failed");
		deps.recordEvent("workflow_level_escalated", { run_id: runId, from: flatLevel, to: "led", reason, failed_checks: lastVerification?.failedChecks ?? [], prior_cost_usd: priorCostUsd });
		session.log(`workflow: escalating ${flatLevel} → led (${reason})`);
		const feedback = [
			`## Prior ${flatLevel} attempt (escalated)`,
			`Failed: ${reason}`,
			"Files it changed are still in the working tree; build on them or revert them deliberately.",
			...(lastVerification?.summary ? [`Verification: ${lastVerification.summary}`] : []),
			"Last implementer report (tail):",
			(escalationResults.at(-1) ?? leadResults.at(-1))?.stdout.slice(-4000) ?? "(none)",
		].join("\n");
		return runOrchestration(runId, cwd, { ...parsed, taskClass: effectiveTaskClass, complexity: effectiveComplexity, risk: effectiveRisk },
			adapter, resolved, ctx, session, claimed,
			{ ...deps, providedContext: [deps.providedContext, feedback].filter(Boolean).join("\n\n") },
			{ fromLevel: flatLevel, forceLevel: "led", reason, priorCostUsd, priorFixRounds: retries + (carry?.priorFixRounds ?? 0), priorResults: [...(carry?.priorResults ?? []), ...prior], dirtyBefore, headBefore });
	}
```

Setting `taskClass/complexity/risk` on `parsed` skips re-triage (`missingTriage` is false when they differ from the defaults; if a run's triage legitimately returned exactly `implementation/5/medium`, re-triage costs one cheap call — acceptable and logged).

10. Finalize: `let totalCost = triageCost.usd + … + nestedCost + (carry?.priorCostUsd ?? 0);` and in the `completeRun` summary use `retries: retries + (carry?.priorFixRounds ?? 0)`, `fix_rounds: retries + (carry?.priorFixRounds ?? 0)`, and

```ts
		...(workflow ? { workflow: { mode: workflowMode.mode, planned: carry?.fromLevel ?? workflow.level, final: flatLevel ?? workflow.level, escalations: carry ? 1 : 0, reasons: workflow.reasons, signal_ms: workflowSignalMs } } : {}),
```

- [ ] **Step 4: Run** `(cd bridge/extensions/orchestrator && bun test) && bash scripts/typecheck-bridge.sh && python3 -m pytest -q` — Expected: PASS, including every pre-existing `run-orchestration.test.ts` case (off-mode behaviour unchanged).

- [ ] **Step 5: Commit**

```bash
git add bridge/extensions/orchestrator/pipeline/run-orchestration.ts bridge/extensions/orchestrator/pipeline/run-orchestration.test.ts
git commit -m "feat(workflow): enforce direct/checked with fix round and carried-forward escalation to led"
```

---

### Task 11: Documentation and method/skill consistency

**Files:**
- Modify: `SKILL.md` — add a "Rule 6: Workflow levels" subsection after Rule 5 (stage only this hunk: `git add -p SKILL.md`)
- Modify: `tests/test_method.py` — assert SKILL.md quotes the thresholds
- Modify: `bridge/extensions/orchestrator-README.md` — document `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE`, `--workflow`, and the new events

- [ ] **Step 1: Failing test** — in `tests/test_method.py` next to the recon SKILL.md assertions (~lines 74–81):

```python
    def test_skill_md_quotes_workflow_policy(self):
        from orchestrator import method
        text = (Path(__file__).resolve().parents[1] / 'SKILL.md').read_text()
        wf = method.load_method()['rules']['workflow_policy']
        self.assertIn('rules.workflow_policy', text)
        self.assertIn(f"{wf['thresholds']['led_min_files']} or more candidate files", text)
        self.assertIn(f"{wf['thresholds']['led_min_packages']} or more packages", text)
        self.assertIn('HUMAIN_ORCHESTRATOR_WORKFLOW_MODE', text)
```

(Add `from pathlib import Path` if the file lacks it.)

- [ ] **Step 2: Run** `python3 -m pytest -q tests/test_method.py -k workflow` — Expected: FAIL.

- [ ] **Step 3: Write** the SKILL.md subsection:

```markdown
### Rule 6: Workflow levels

`method.json` `rules.workflow_policy` picks a workflow level from observable repository evidence, not from the triage complexity score. Levels: `direct` (one implementer + deterministic checks), `checked` (direct + one independent review), `led` and `full` (the coordinated pipeline; `full` is a floor nothing can lower).

| Evidence | Level |
|---|---|
| explicit high/critical risk, or any `risk_path_globs` hit | full (hard floor) |
| interface change across packages | full |
| 4 or more candidate files, 3 or more packages, or unresolved scope | led |
| exactly one low-risk file with adjacent tests and discovered checks, no interface change | direct |
| anything else | checked |

`mode` is `off` by default; `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE=off|observe|enforce` overrides it. `observe` records `workflow_level_planned` and runs today's pipeline. `enforce` runs `direct`/`checked` with `fix_rounds_per_level` repair rounds, then escalates to `led` carrying the working tree, prior cost and feedback (`workflow_level_escalated`). `--workflow <level>` may raise the level, never lower it below the floor. `investigation` and `qa_verification` tasks are never run flat.
```

Document the same env/flag/events in `bridge/extensions/orchestrator-README.md` under its configuration section.

- [ ] **Step 4: Run** `python3 -m pytest -q && (cd bridge/extensions/orchestrator && bun test) && bash scripts/lint.sh` — Expected: PASS (lint exit 2 = tools missing, report skipped).

- [ ] **Step 5: Commit**

```bash
git add tests/test_method.py bridge/extensions/orchestrator-README.md
git add -p SKILL.md
git commit -m "docs: Rule 6 workflow levels, env switch and events"
```

---

## Spec coverage (Section 3)

| Spec item | Task |
|---|---|
| §3.1 levels, hard floors, excluded task classes, full ≠ forced fan-out | 1, 6, 10 (led/full share the coordinated pipeline) |
| §3.2 deterministic signals with confidence/uncertainty; ambiguous ⇒ led; missing evidence ≠ low risk | 3, 4, 5, 6 |
| §3.2 router rules 1–6; `--workflow` above floor only | 6 |
| §3.3 one fix round per level; provider retries unchanged; skip-to-floor escalation; carry-forward; aggregate cost | 9, 10 |
| §3.3 existing re-review tier rule untouched | 10 (coordinated path unchanged) |
| §3.4 off/observe/enforce; observe overhead measured and labelled | 2, 7 |
| §3.4 lower-level exploration | Deferred: new experiment, disabled by default, planned with Phase 4 rollout |
| §1 measurement of planned/final/escalations | 7 |

Deferred with reason: the optional ambiguity scout (§3.2 "may") — ambiguous scope routes to `led`, whose existing recon covers it; mid-run risk-path detection during a flat attempt beyond the post-attempt QA-scope check — escalation on persistent failure covers the common case, and a `full` floor is already applied at planning time for goal-named protected paths. Both are candidates for the Phase 3 tuning plan once benchmark data shows whether they matter.

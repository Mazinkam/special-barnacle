# Model Backups and Provider Failover Implementation Plan

> **For agentic workers:** this plan is executed by `/orchestrate` (see "Orchestration layout"). A lead
> dispatches one implementer per task, wave by wave. Steps use checkbox (`- [ ]`) syntax. Every task is
> TDD: failing test → minimal code → green → commit.

**Goal:** Stop provider outages from failing runs. Each dispatch gets an ordered list of backup
models that are checked against the role's minimum requirements. On transient or quota errors the
dispatch fails over, with a handoff summary when the dead attempt had already done work.

**Architecture:** Small pure modules in `bridge/extensions/orchestrator/` (catalog, event scan,
failure classification, model health, candidate router, failover policy, handoff, nested audit),
plus one async loop, `dispatchWithFailover`, whose dependencies are injected. `index.ts` only wires
them in: `resolveAdapter` builds the candidates, `dispatchParallel` and triage call the loop, lead
prompts carry backups, and the summary reports failovers.

**Tech Stack:** TypeScript on Bun (`bun test`), Python 3.9 (`python3 -m pytest`), strict `tsc` via
`scripts/typecheck-bridge.sh`.

**Spec:** `docs/superpowers/specs/2026-09-25-model-failover-design.md`. Read it first. Where this
plan and the spec differ, this plan wins (the differences are listed under "Deviations from the
spec").

## Global Constraints

- All paths are relative to the worktree root `.worktrees/model-failover` (branch `feat/model-failover`).
- Verification before **every** commit:
  - `python3 -m pytest -q`
  - `(cd bridge/extensions/orchestrator && ~/.local/bin/bun test)`
  - `bash scripts/typecheck-bridge.sh --all`

  All three must be green. Use `python3`; `python` isn't on PATH.
- New bridge modules are **flat files** in `bridge/extensions/orchestrator/`. Part B4 moves them later.
- Pure modules: no `node:fs`, no `process.env`, no globals, no `Date.now()` except as an injectable
  default argument.
- Error regex, verbatim from the spec:
  `/service unavailable|\b5\d\d\b|overloaded|pending stream has been canceled|stream ended without a stop reason|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|throttl/i`
- Failover defaults (`method.json` `rules.model_failover`):
  `unhealthy_ms 600000`, `same_model_retry_delay_ms 60000`, `wait_schedule_ms [60000,120000,240000]`,
  `max_wait_ms 900000`, `max_switches 4`, `real_work_min_tool_calls 3`.
- Requirement groups (`rules.model_requirements`):
  - default: 128000 / 16000;
  - planning (architect, lead_small, lead, lead_large): 256000 / 64000;
  - review (the 5 reviews, security_review, qa_agent): 200000 / 32000;
  - worker (scout, worker, implementation_fast, implementation_strong, analysis_mid,
    analysis_strong, technical_lead): 128000 / 32000;
  - `effort_control` false everywhere.
- Handoff limits: files 100, last text 4000 characters, whole section 12000 characters.
- Tests never call a live provider. Never write to the real state root `~/.local/state/coding-agent-orchestrator`.
- One commit per task, with a conventional message (`feat(bridge): …`, `test(…)`).

## Deviations from the spec (this plan wins)

1. Flat file layout now; B4 relocates the files. §7's `core/…` paths are therefore flat names.
2. `classifyFailure`/`hadRealWork` live in `failure-class.ts`, `nextStep` lives in
   `failover-policy.ts`, and a shared `event-scan.ts` parses `events.jsonl`. `model-router.ts`
   keeps only candidate resolution.
3. The **primary** model is always usable, even if it fails a minimum requirement. The failed check
   is shown as a warning. This preserves today's behaviour for explicit bindings.
4. The codex→Bedrock quota twin is kept, as an **automatic backup** inserted right after an
   `openai-codex/*` primary (`bedrockFallbackFor`). This avoids a regression for profiles without
   `backups`. `isQuotaError`'s branch in `dispatchParallel` is removed.
5. Billing keeps today's shape. Each superseded attempt gets its own `dispatch_finished` event
   (`superseded_by_fallback: true`, its model and its cost), and the `DispatchResult` sums
   usage and cost across attempts, carrying the final model.
6. A dispatch starts on the **first healthy** candidate, so parallel and later dispatches skip a
   model already known to be dead.

## Review Focus

1. **Numbers that aren't errors must not trigger failover.** Orchestrator diagnostic lines in
   stderr quote shell commands (`tail -500`, `head -503`), and those numbers must never classify as
   `transient`. The test is in Task 3.
2. **A profile without `backups`.** A transient failure on the only candidate waits and retries it
   for up to 15 minutes, then gives up with a clear error listing each attempt. It must not loop
   forever or fail instantly. The test is in Task 9.
3. **An unresolvable backup spec.** A typo in `backups` never aborts a run; it shows as `✗ unresolved`
   and the other candidates are used. The test is in Task 5 (the `nope/x` candidate); Task 10 logs it at run start.
4. **User cancel during a failover wait.** `/orchestrate-cancel` ends a 240 s wait immediately, not
   after it. Tests are in Task 9 (loop) and Task 10 (cancellable sleep).
5. **The spend cap spans attempts.** The second attempt's cap check includes the first attempt's
   cost. The test is in Task 9 (`spentBeforeUsd`), and Task 10 wires it.

## Orchestration layout

| Wave | Tasks (parallel within a wave) | ownerPaths |
|---|---|---|
| 1 | T1 config schema · T2 model catalog · T3 event scan + failure class · T4 model health | T1: `bridge/extensions/orchestrator/models.ts`, `models.test.ts`, `orchestrator/method.json`, `orchestrator/method.py`, `tests/test_method.py` · T2: `model-catalog*.ts` · T3: `event-scan*.ts`, `failure-class*.ts` · T4: `model-health*.ts` |
| 2 | T5 model router · T6 failover policy · T7 handoff · T8 nested audit | `model-router*.ts` · `failover-policy*.ts` · `handoff*.ts` · `nested-audit*.ts` |
| 3 | T9 failover loop | `failover*.ts` (only `failover.ts` and `failover.test.ts`) |
| 4 | T10 → T11 → T12 (sequential: all touch `index.ts`) | `index.ts`, `index.test.ts`, `models.ts`, `bridge/agents/orchestrator-lead.md` |
| 5 | T13 shipped profiles + docs · then T14 verify, merge, push | `bridge/orchestrator-profiles.json`, docs · repo-wide |

The lead dispatches wave N+1 only after every task in wave N is committed and the full verification
is green.

---
## Wave 1

### Task 1: Config schema (profile `backups`, method rules)

**Files:**
- Modify: `bridge/extensions/orchestrator/models.ts` (`ProfileSpec`, `parseProfileSpec`, `MethodFile`)
- Modify: `orchestrator/method.json` (`rules.model_requirements`, `rules.model_failover`); the bridge copy is a symlink, don't touch it
- Modify: `orchestrator/method.py` (`_validate`)
- Test: `bridge/extensions/orchestrator/models.test.ts`, `tests/test_method.py`

**Interfaces:**
- Produces:
  - `ProfileSpec.backups?: Record<string, string[]>`
  - `ModelRequirementSpec`, `ModelRequirementsRule`, `ModelFailoverRule` (exported types)
  - `METHOD.rules.model_requirements`, `METHOD.rules.model_failover`

- [ ] **Step 1: Write failing TS tests.** Append to `models.test.ts`:

```ts
describe("profile backups", () => {
	test("parses tier and capability backup lists, reports bad keys and values", () => {
		const { file, problems } = parseProfilesFile({
			version: 1,
			active_profile: "p",
			profiles: { p: { backups: { frontier: ["astra", " humain-node/glm-5.2 "], security_review: ["a/b"], bogus: ["x"], mid: "no", cheap: [""] } } },
		});
		expect(file.profiles.p.backups).toEqual({ frontier: ["astra", "humain-node/glm-5.2"], security_review: ["a/b"] });
		expect(problems.some((p) => p.includes('backups: unknown tier or capability "bogus"'))).toBe(true);
		expect(problems.some((p) => p.includes("backups.mid must be a list of non-empty strings"))).toBe(true);
		expect(problems.some((p) => p.includes("backups.cheap must be a list of non-empty strings"))).toBe(true);
	});
	test("a non-object backups value is a problem, not a crash", () => {
		const { problems } = parseProfilesFile({ version: 1, active_profile: "p", profiles: { p: { backups: ["x"] } } });
		expect(problems.some((p) => p.includes("backups must be an object"))).toBe(true);
	});
});

describe("method model rules", () => {
	test("every requirement-group capability is declared and appears in one group only", () => {
		const seen = new Map<string, string>();
		for (const [name, g] of Object.entries(METHOD.rules.model_requirements.groups)) {
			for (const cap of g.capabilities) {
				expect(Object.keys(METHOD.capabilities)).toContain(cap);
				expect(seen.has(cap)).toBe(false);
				seen.set(cap, name);
			}
		}
		expect(METHOD.rules.model_requirements.groups.planning.min_context).toBe(256000);
		expect(METHOD.rules.model_failover.max_switches).toBe(4);
	});
});
```

- [ ] **Step 2: Run it and check that it fails.** Run `(cd bridge/extensions/orchestrator && ~/.local/bin/bun test models.test.ts)`. Expected: FAIL (`backups` is undefined, and `model_requirements` is undefined).

- [ ] **Step 3: Implement the TS side.** In `models.ts`, add to `ProfileSpec`:

```ts
	/** tier or capability -> ordered backup specs (alias or provider/id); see model-router.ts */
	backups?: Record<string, string[]>;
```

Add these exported types above `interface MethodFile`, and add the two fields to `MethodFile.rules`:

```ts
export interface ModelRequirementSpec { min_context: number; min_output: number; effort_control?: boolean }
export interface ModelRequirementsRule {
	default: ModelRequirementSpec;
	groups: Record<string, ModelRequirementSpec & { capabilities: string[] }>;
}
export interface ModelFailoverRule {
	unhealthy_ms: number;
	same_model_retry_delay_ms: number;
	wait_schedule_ms: number[];
	max_wait_ms: number;
	max_switches: number;
	real_work_min_tool_calls: number;
}
// inside MethodFile.rules:
		model_requirements: ModelRequirementsRule;
		model_failover: ModelFailoverRule;
```

In `parseProfileSpec`, before `return out;`:

```ts
	if (s.backups !== undefined) {
		if (!s.backups || typeof s.backups !== "object" || Array.isArray(s.backups)) {
			problems.push(`${where}.backups must be an object`);
		} else {
			out.backups = {};
			for (const [key, v] of Object.entries(s.backups as Record<string, unknown>)) {
				if (!isTier(key) && !ALL_CAPABILITIES.includes(key)) {
					problems.push(`${where}.backups: unknown tier or capability "${key}"`);
					continue;
				}
				if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !x.trim())) {
					problems.push(`${where}.backups.${key} must be a list of non-empty strings`);
					continue;
				}
				out.backups[key] = (v as string[]).map((x) => x.trim());
			}
		}
	}
```

- [ ] **Step 4: Add the rules to `orchestrator/method.json`.** Put them inside `"rules"`, after `dispatch_spend_cap`:

```json
    "model_requirements": {
      "summary": "Hard minimums a backup model must meet for a role (see model-router.ts). The primary binding is always usable; its failed checks are warnings.",
      "default": { "min_context": 128000, "min_output": 16000, "effort_control": false },
      "groups": {
        "planning": { "capabilities": ["architect", "lead_small", "lead", "lead_large"], "min_context": 256000, "min_output": 64000, "effort_control": false },
        "review": { "capabilities": ["technical_review", "integration_review", "migration_review", "performance_review", "api_contract_review", "security_review", "qa_agent"], "min_context": 200000, "min_output": 32000, "effort_control": false },
        "worker": { "capabilities": ["scout", "worker", "implementation_fast", "implementation_strong", "analysis_mid", "analysis_strong", "technical_lead"], "min_context": 128000, "min_output": 32000, "effort_control": false }
      }
    },
    "model_failover": {
      "summary": "Provider-failure failover (see failover-policy.ts).",
      "unhealthy_ms": 600000,
      "same_model_retry_delay_ms": 60000,
      "wait_schedule_ms": [60000, 120000, 240000],
      "max_wait_ms": 900000,
      "max_switches": 4,
      "real_work_min_tool_calls": 3
    }
```

- [ ] **Step 5: Write the failing Python tests.** Append these methods to the existing `TestCase` class in `tests/test_method.py`:

```python
    def _method_copy(self):
        import copy
        from orchestrator.method import load_method
        return copy.deepcopy(load_method())

    def test_model_requirements_reject_undeclared_capability(self):
        from orchestrator.method import _validate
        m = self._method_copy()
        m["rules"]["model_requirements"]["groups"]["planning"]["capabilities"].append("nope")
        with self.assertRaisesRegex(ValueError, "undeclared capability 'nope'"):
            _validate(m)

    def test_model_requirements_capability_in_one_group_only(self):
        from orchestrator.method import _validate
        m = self._method_copy()
        m["rules"]["model_requirements"]["groups"]["planning"]["capabilities"].append("worker")
        with self.assertRaisesRegex(ValueError, "'worker' is in groups"):
            _validate(m)

    def test_model_failover_values_are_positive_integers(self):
        from orchestrator.method import _validate
        for key, bad in (("max_switches", 0), ("unhealthy_ms", -1), ("max_wait_ms", True), ("wait_schedule_ms", [])):
            m = self._method_copy()
            m["rules"]["model_failover"][key] = bad
            with self.assertRaises(ValueError, msg=key):
                _validate(m)
```

- [ ] **Step 6: Run and check that it fails.** Run `python3 -m pytest -q tests/test_method.py`. Expected: the 3 new tests FAIL (no error is raised).

- [ ] **Step 7: Implement the Python side.** In `orchestrator/method.py`, add these helpers above `_validate_rule_efforts_and_tiers`:

```python
def _positive_int(value: Any, where: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"method.json: {where} must be a positive integer, got {value!r}")


def _validate_model_rules(m: dict[str, Any]) -> None:
    mr = m["rules"].get("model_requirements")
    if mr:
        for where, spec in [("model_requirements.default", mr["default"])] + [
            (f"model_requirements.groups.{name}", g) for name, g in mr.get("groups", {}).items()
        ]:
            _positive_int(spec.get("min_context"), f"{where}.min_context")
            _positive_int(spec.get("min_output"), f"{where}.min_output")
            if not isinstance(spec.get("effort_control", False), bool):
                raise ValueError(f"method.json: {where}.effort_control must be a boolean")
        seen: dict[str, str] = {}
        for name, g in mr.get("groups", {}).items():
            for cap in g["capabilities"]:
                if cap not in m["capabilities"]:
                    raise ValueError(f"method.json: model_requirements group {name!r} names undeclared capability {cap!r}")
                if cap in seen:
                    raise ValueError(f"method.json: capability {cap!r} is in groups {seen[cap]!r} and {name!r}")
                seen[cap] = name
    mf = m["rules"].get("model_failover")
    if mf:
        for key in ("unhealthy_ms", "same_model_retry_delay_ms", "max_wait_ms", "max_switches", "real_work_min_tool_calls"):
            _positive_int(mf.get(key), f"model_failover.{key}")
        schedule = mf.get("wait_schedule_ms")
        if not isinstance(schedule, list) or not schedule:
            raise ValueError("method.json: model_failover.wait_schedule_ms must be a non-empty list")
        for i, v in enumerate(schedule):
            _positive_int(v, f"model_failover.wait_schedule_ms[{i}]")
```

Then call `_validate_model_rules(m)` in `_validate`, right before `_validate_rule_efforts_and_tiers(...)`.

- [ ] **Step 8: Run the full verification** (see Global Constraints). Expected: everything green.

- [ ] **Step 9: Commit.**

```bash
git add bridge/extensions/orchestrator/models.ts bridge/extensions/orchestrator/models.test.ts orchestrator/method.json orchestrator/method.py tests/test_method.py
git commit -m "feat(method): profile backups and model requirement/failover rules"
```

### Task 2: Model catalog

**Files:**
- Create: `bridge/extensions/orchestrator/model-catalog.ts`
- Test: `bridge/extensions/orchestrator/model-catalog.test.ts`

**Interfaces:**
- Produces:
  - `interface ModelFacts { context?: number; maxOutput?: number; effortControl?: boolean }`
  - `interface RegistryModel { provider: string; id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }`
  - `type Catalog = ReadonlyMap<string, ModelFacts>` (keyed by `provider/id`)
  - `parseModelFacts(raw: unknown): { facts: Record<string, ModelFacts>; problems: string[] }`
  - `buildCatalog(models: RegistryModel[], overrides?: Record<string, ModelFacts>): Catalog`

- [ ] **Step 1: Write the failing test** `model-catalog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildCatalog, parseModelFacts } from "./model-catalog.ts";

describe("model catalog", () => {
	test("takes context, max output and reasoning from the registry", () => {
		const c = buildCatalog([
			{ provider: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true },
			{ provider: "humain-node", id: "minimax-m3", contextWindow: 204_800, maxTokens: 16_384, reasoning: false },
			{ provider: "x", id: "bad", contextWindow: 0, maxTokens: Number.NaN },
		]);
		expect(c.get("amazon-bedrock/global.anthropic.claude-opus-5-5")).toEqual({ context: 1_000_000, maxOutput: 128_000, effortControl: true });
		expect(c.get("humain-node/minimax-m3")).toEqual({ context: 204_800, maxOutput: 16_384, effortControl: false });
		expect(c.get("x/bad")).toEqual({});
	});
	test("overrides win field by field", () => {
		const c = buildCatalog(
			[{ provider: "humain-node", id: "glm-5.2", contextWindow: 1_000_000, maxTokens: 131_072, reasoning: false }],
			{ "humain-node/glm-5.2": { effortControl: true }, "extra/model": { context: 5 } },
		);
		expect(c.get("humain-node/glm-5.2")).toEqual({ context: 1_000_000, maxOutput: 131_072, effortControl: true });
		expect(c.get("extra/model")).toEqual({ context: 5 });
	});
	test("parseModelFacts validates shape and reports problems", () => {
		const { facts, problems } = parseModelFacts({
			version: 1,
			models: { "a/b": { context: 10, max_output: 5, effort_control: true }, nope: {}, "c/d": { context: -1 }, "e/f": "x" },
		});
		expect(facts["a/b"]).toEqual({ context: 10, maxOutput: 5, effortControl: true });
		expect(facts["c/d"]).toEqual({});
		expect(problems).toEqual([
			'model facts: "nope" must be provider/id',
			"model facts: c/d.context must be a positive integer",
			'model facts: "e/f" must be an object',
		]);
		expect(parseModelFacts([]).problems).toEqual(["model facts file is not an object"]);
		expect(parseModelFacts({ version: 2 }).problems).toEqual(["model facts: unsupported version 2 (expected 1)"]);
	});
});
```

- [ ] **Step 2: Run** `(cd bridge/extensions/orchestrator && ~/.local/bin/bun test model-catalog.test.ts)`. Expected: FAIL (the module can't be found).

- [ ] **Step 3: Implement** `model-catalog.ts`:

```ts
/**
 * Model facts used to decide whether a backup model meets a role's minimums
 * (context window, max output, effort control). The source is HT's model registry,
 * with optional per-model overrides from orchestrator-model-facts.json. Pure: no I/O.
 */
export interface ModelFacts {
	context?: number;
	maxOutput?: number;
	effortControl?: boolean;
}

export interface RegistryModel {
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export type Catalog = ReadonlyMap<string, ModelFacts>;

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

export function parseModelFacts(raw: unknown): { facts: Record<string, ModelFacts>; problems: string[] } {
	const facts: Record<string, ModelFacts> = {};
	const problems: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { facts, problems: ["model facts file is not an object"] };
	const r = raw as Record<string, unknown>;
	if (r.version !== 1) problems.push(`model facts: unsupported version ${JSON.stringify(r.version)} (expected 1)`);
	if (r.models === undefined) return { facts, problems };
	if (!r.models || typeof r.models !== "object" || Array.isArray(r.models)) {
		problems.push('model facts: "models" must be an object');
		return { facts, problems };
	}
	for (const [key, value] of Object.entries(r.models as Record<string, unknown>)) {
		if (!key.includes("/")) {
			problems.push(`model facts: "${key}" must be provider/id`);
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			problems.push(`model facts: "${key}" must be an object`);
			continue;
		}
		const f = value as Record<string, unknown>;
		const out: ModelFacts = {};
		if (f.context !== undefined) {
			if (isPositiveInt(f.context)) out.context = f.context;
			else problems.push(`model facts: ${key}.context must be a positive integer`);
		}
		if (f.max_output !== undefined) {
			if (isPositiveInt(f.max_output)) out.maxOutput = f.max_output;
			else problems.push(`model facts: ${key}.max_output must be a positive integer`);
		}
		if (f.effort_control !== undefined) {
			if (typeof f.effort_control === "boolean") out.effortControl = f.effort_control;
			else problems.push(`model facts: ${key}.effort_control must be a boolean`);
		}
		facts[key] = out;
	}
	return { facts, problems };
}

export function buildCatalog(models: RegistryModel[], overrides: Record<string, ModelFacts> = {}): Catalog {
	const out = new Map<string, ModelFacts>();
	for (const m of models) {
		out.set(`${m.provider}/${m.id}`, {
			...(isPositiveInt(m.contextWindow) ? { context: m.contextWindow } : {}),
			...(isPositiveInt(m.maxTokens) ? { maxOutput: m.maxTokens } : {}),
			...(typeof m.reasoning === "boolean" ? { effortControl: m.reasoning } : {}),
		});
	}
	for (const [key, f] of Object.entries(overrides)) out.set(key, { ...(out.get(key) ?? {}), ...f });
	return out;
}
```

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/model-catalog*.ts && git commit -m "feat(bridge): model catalog for failover qualification"`

### Task 3: Event scan and failure classification

**Files:**
- Create: `bridge/extensions/orchestrator/event-scan.ts`, `bridge/extensions/orchestrator/failure-class.ts`
- Test: `bridge/extensions/orchestrator/event-scan.test.ts`, `bridge/extensions/orchestrator/failure-class.test.ts`

**Interfaces:**
- Consumes: `QUOTA_ERROR_RE` from `provider-fallback.ts` (existing export)
- Produces:
  - `interface NestedWorker { id: string; ok: boolean; summary: string }`
  - `interface SubagentCall { toolCallId: string; tasks: Array<{ id?: string; hasRetry: boolean }> }`
  - `interface EventScan { toolCalls: number; toolInFlight: boolean; lastErrorMessage?: string; lastAssistantText: string; finishedWorkers: NestedWorker[]; unfinishedWorkers: string[]; subagentCalls: SubagentCall[] }`
  - `scanEvents(lines: Iterable<string>): EventScan`
  - `type FailureClass = "ok" | "cancelled" | "quota" | "transient" | "stall" | "task"`
  - `interface AttemptSignals { exitCode: number; outcome: string; stderr: string; errorMessage?: string; stopReason?: string; timeoutReason?: "inactivity" | "absolute"; toolInFlight: boolean; cancelled: boolean }`
  - `TRANSIENT_ERROR_RE`
  - `providerText(stderr: string, errorMessage?: string): string`
  - `classifyFailure(s: AttemptSignals): FailureClass`
  - `failureReason(s: AttemptSignals, max?: number): string`
  - `hadRealWork(scan: Pick<EventScan, "toolCalls" | "finishedWorkers">, filesChanged: readonly string[], minToolCalls: number): boolean`

- [ ] **Step 1: Write the failing** `event-scan.test.ts`. The event shapes are copied from real `events.jsonl` files:

```ts
import { describe, expect, test } from "bun:test";
import { scanEvents } from "./event-scan.ts";

const j = (o: unknown) => JSON.stringify(o);
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
	j({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], ...extra } });

describe("scanEvents", () => {
	test("counts finished tools, detects a tool still running, keeps last text and error", () => {
		const s = scanEvents([
			j({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }),
			j({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: {}, isError: false }),
			assistant("first"),
			assistant("second plan"),
			j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Service unavailable: Bedrock is unable to process your request." } }),
			j({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} }),
			"not json",
			"",
		]);
		expect(s.toolCalls).toBe(1);
		expect(s.toolInFlight).toBe(true);
		expect(s.lastAssistantText).toBe("second plan");
		expect(s.lastErrorMessage).toBe("Service unavailable: Bedrock is unable to process your request.");
	});
	test("records subagent calls, finished and unfinished nested workers", () => {
		const s = scanEvents([
			j({ type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: { tasks: [
				{ id: "t1", agent: "orch-worker", task: "x", onFailure: { maxAttempts: 2, retryWith: { model: "openai-codex/gpt-6-luna" } } },
				{ id: "t2", agent: "orch-worker", task: "y" },
			] } }),
			j({ type: "tool_execution_end", toolCallId: "s1", toolName: "subagent", isError: false, result: { content: [{ type: "text", text: "Parallel: 2/2" }], details: { results: [
				{ taskId: "t1", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "## Completed\nfixed bug 1" }] }] },
				{ taskId: "t2", exitCode: 1, messages: [] },
			] } } }),
			j({ type: "tool_execution_start", toolCallId: "s2", toolName: "subagent", args: { agent: "orch-worker", task: "z" } }),
		]);
		expect(s.subagentCalls).toEqual([
			{ toolCallId: "s1", tasks: [{ id: "t1", hasRetry: true }, { id: "t2", hasRetry: false }] },
			{ toolCallId: "s2", tasks: [{ id: undefined, hasRetry: false }] },
		]);
		expect(s.finishedWorkers).toEqual([
			{ id: "t1", ok: true, summary: "## Completed" },
			{ id: "t2", ok: false, summary: "" },
		]);
		expect(s.unfinishedWorkers).toEqual(["s2#0"]);
		expect(s.toolInFlight).toBe(true);
	});
});
```

- [ ] **Step 2: Write the failing** `failure-class.test.ts`. The stderr strings are the exact ones from the runs cited in the spec:

```ts
import { describe, expect, test } from "bun:test";
import { classifyFailure, failureReason, hadRealWork, type AttemptSignals } from "./failure-class.ts";

const base: AttemptSignals = { exitCode: 1, outcome: "failed", stderr: "", toolInFlight: false, cancelled: false };
const cls = (o: Partial<AttemptSignals>) => classifyFailure({ ...base, ...o });

describe("classifyFailure", () => {
	test.each([
		"[provider error] Service unavailable: Bedrock is unable to process your request.",
		"[provider error] The pending stream has been canceled (caused by: )",
		"[provider error] Bedrock stream ended without a stop reason",
		"[provider error] Service unavailable: Bedrock is unable to process your request.Warning: fetch failed",
		"Error: socket hang up",
		"request failed with status 502",
	])("transient: %s", (stderr) => expect(cls({ stderr })).toBe("transient"));

	test("quota wins over transient", () => {
		expect(cls({ stderr: "[provider error] 429 rate limit exceeded; 503 upstream" })).toBe("quota");
		expect(cls({ stderr: "You have hit your usage limit" })).toBe("quota");
	});
	test("the harness error message alone is enough", () => {
		expect(cls({ stderr: "", errorMessage: "Service unavailable: Bedrock is unable to process your request." })).toBe("transient");
	});
	test("inactivity while waiting on the model is a stall; while a tool runs it is a task failure", () => {
		const stderr = [
			"⚠ no meaningful progress for 15min (limit 20min; 5min remaining) — last: bash {\"command\":\"head -503 x | tail -500\"}",
			"[orchestrator] inactivity timeout: dispatch timed out after 20min without meaningful progress (last progress: bash {\"command\":\"tail -500\"} 20min ago; capability=lead_large)",
			"elapsedMs: 1548924",
			"lastProgress: bash {\"command\":\"tail -500 /tmp/log\"}",
			"partialText: Typecheck green across all 15 packages; HTTP 500 handler fixed.",
		].join("\n");
		expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: false })).toBe("stall");
		expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: true })).toBe("task");
		expect(cls({ outcome: "timed_out", timeoutReason: "absolute", stderr, toolInFlight: false })).toBe("task");
	});
	test("ok, cancelled, spend cap and ordinary errors", () => {
		expect(cls({ exitCode: 0, outcome: "completed" })).toBe("ok");
		expect(cls({ exitCode: 0, outcome: "completed_after_process_error" })).toBe("ok");
		expect(cls({ cancelled: true, stderr: "503" })).toBe("cancelled");
		expect(cls({ outcome: "cancelled" })).toBe("cancelled");
		expect(cls({ stopReason: "spend_cap", stderr: "Service unavailable" })).toBe("task");
		expect(cls({ stderr: "TypeError: x is not a function" })).toBe("task");
	});
	test("failureReason names the provider line, bounded", () => {
		expect(failureReason({ ...base, stderr: "noise\n[provider error] Service unavailable: Bedrock is unable to process your request." }))
			.toBe("[provider error] Service unavailable: Bedrock is unable to process your request.");
		expect(failureReason({ ...base, stderr: "", errorMessage: "x".repeat(500) }).length).toBe(160);
	});
});

describe("hadRealWork", () => {
	test("files, finished nested workers or enough tool calls", () => {
		const none = { toolCalls: 2, finishedWorkers: [] };
		expect(hadRealWork(none, [], 3)).toBe(false);
		expect(hadRealWork({ ...none, toolCalls: 3 }, [], 3)).toBe(true);
		expect(hadRealWork(none, ["a.ts"], 3)).toBe(true);
		expect(hadRealWork({ ...none, finishedWorkers: [{ id: "t", ok: true, summary: "" }] }, [], 3)).toBe(true);
	});
});
```

- [ ] **Step 3: Run both** `bun test event-scan.test.ts failure-class.test.ts`. Expected: FAIL (the modules can't be found).

- [ ] **Step 4: Implement** `event-scan.ts`:

```ts
/**
 * One pass over a child's `--mode json` event stream (events.jsonl), giving the
 * facts failover needs: tool activity, the harness error, the last assistant text,
 * nested subagent workers and their onFailure settings. Pure: callers supply the lines.
 */
export interface NestedWorker { id: string; ok: boolean; summary: string }
export interface SubagentCall { toolCallId: string; tasks: Array<{ id?: string; hasRetry: boolean }> }
export interface EventScan {
	toolCalls: number;
	toolInFlight: boolean;
	lastErrorMessage?: string;
	lastAssistantText: string;
	finishedWorkers: NestedWorker[];
	unfinishedWorkers: string[];
	subagentCalls: SubagentCall[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => String((b as { text?: unknown }).text ?? ""))
		.join("\n");
}

function lastAssistantTextOf(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown } | null;
		if (m?.role === "assistant") {
			const t = textOf(m.content).trim();
			if (t) return t;
		}
	}
	return "";
}

const firstLine = (s: string, max = 160) => (s.split("\n")[0] ?? "").slice(0, max);

export function scanEvents(lines: Iterable<string>): EventScan {
	const inFlight = new Set<string>();
	const pendingSubagent = new Map<string, string[]>();
	const subagentCalls: SubagentCall[] = [];
	const finishedWorkers: NestedWorker[] = [];
	let toolCalls = 0;
	let lastAssistantText = "";
	let lastErrorMessage: string | undefined;
	for (const line of lines) {
		if (!line || !line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e || typeof e !== "object") continue;
		if (e.type === "tool_execution_start") {
			const id = String(e.toolCallId ?? "");
			inFlight.add(id);
			if (e.toolName === "subagent") {
				const args = e.args ?? {};
				const tasks: SubagentCall["tasks"] = Array.isArray(args.tasks)
					? args.tasks.map((t: any) => ({
						id: typeof t?.id === "string" ? t.id : undefined,
						hasRetry: typeof t?.onFailure?.retryWith?.model === "string" && t.onFailure.retryWith.model.length > 0,
					}))
					: Array.isArray(args.chain)
						? args.chain.map(() => ({ id: undefined, hasRetry: false }))
						: [{ id: undefined, hasRetry: false }];
				subagentCalls.push({ toolCallId: id, tasks });
				pendingSubagent.set(id, tasks.map((t, i) => t.id ?? `${id}#${i}`));
			}
		} else if (e.type === "tool_execution_end") {
			const id = String(e.toolCallId ?? "");
			inFlight.delete(id);
			toolCalls++;
			if (e.toolName === "subagent") {
				pendingSubagent.delete(id);
				const results = Array.isArray(e.result?.details?.results) ? e.result.details.results : [];
				for (const r of results) {
					finishedWorkers.push({
						id: String(r?.taskId ?? r?.agent ?? "?"),
						ok: r?.exitCode === 0,
						summary: firstLine(lastAssistantTextOf(r?.messages)),
					});
				}
			}
		} else if (e.type === "message_end" && e.message?.role === "assistant") {
			const t = textOf(e.message.content).trim();
			if (t) lastAssistantText = t;
			if (e.message.stopReason === "error" && typeof e.message.errorMessage === "string") {
				lastErrorMessage = e.message.errorMessage;
			}
		}
	}
	return {
		toolCalls,
		toolInFlight: inFlight.size > 0,
		lastErrorMessage,
		lastAssistantText,
		finishedWorkers,
		unfinishedWorkers: [...pendingSubagent.values()].flat(),
		subagentCalls,
	};
}
```

- [ ] **Step 5: Implement** `failure-class.ts`:

```ts
/**
 * Classify a finished dispatch attempt for failover. Only stderr and the harness's
 * own error field are read, never the model's prose. Lines the orchestrator itself
 * writes (timeout diagnostics that quote shell commands) are excluded, so numbers
 * such as `tail -500` are never taken for HTTP 5xx errors.
 */
import type { EventScan } from "./event-scan.ts";
import { QUOTA_ERROR_RE } from "./provider-fallback.ts";

export type FailureClass = "ok" | "cancelled" | "quota" | "transient" | "stall" | "task";

export interface AttemptSignals {
	exitCode: number;
	outcome: string;
	stderr: string;
	errorMessage?: string;
	stopReason?: string;
	timeoutReason?: "inactivity" | "absolute";
	toolInFlight: boolean;
	cancelled: boolean;
}

export const TRANSIENT_ERROR_RE =
	/service unavailable|\b5\d\d\b|overloaded|pending stream has been canceled|stream ended without a stop reason|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|throttl/i;

const ORCHESTRATOR_LINE_RE = /^\s*(\[orchestrator\]|⚠|elapsedMs:|lastProgress:|nestedWorkers:|partialText:)/;

export function providerText(stderr: string, errorMessage?: string): string {
	const lines = stderr.split(/\r?\n/).filter((l) => l.trim() && !ORCHESTRATOR_LINE_RE.test(l));
	return [...lines, errorMessage ?? ""].filter(Boolean).join("\n");
}

export function classifyFailure(s: AttemptSignals): FailureClass {
	if (s.cancelled || s.outcome === "cancelled") return "cancelled";
	if (s.exitCode === 0 && (s.outcome === "completed" || s.outcome === "completed_after_process_error")) return "ok";
	if (s.stopReason === "spend_cap") return "task";
	const text = providerText(s.stderr, s.errorMessage);
	if (QUOTA_ERROR_RE.test(text)) return "quota";
	if (TRANSIENT_ERROR_RE.test(text)) return "transient";
	if (s.outcome === "timed_out" && s.timeoutReason === "inactivity" && !s.toolInFlight) return "stall";
	return "task";
}

export function failureReason(s: AttemptSignals, max = 160): string {
	const lines = providerText(s.stderr, s.errorMessage).split("\n");
	const hit = lines.find((l) => QUOTA_ERROR_RE.test(l) || TRANSIENT_ERROR_RE.test(l)) ?? lines.find((l) => l.trim()) ?? "";
	const fallback = s.outcome === "timed_out" ? `timed out (${s.timeoutReason ?? "unknown"})` : `exit ${s.exitCode}`;
	return (hit.trim() || fallback).slice(0, max);
}

export function hadRealWork(
	scan: Pick<EventScan, "toolCalls" | "finishedWorkers">,
	filesChanged: readonly string[],
	minToolCalls: number,
): boolean {
	return filesChanged.length > 0 || scan.finishedWorkers.length > 0 || scan.toolCalls >= minToolCalls;
}
```

- [ ] **Step 6: Run the full verification.** Expected: green.
- [ ] **Step 7: Commit.** `git add bridge/extensions/orchestrator/event-scan*.ts bridge/extensions/orchestrator/failure-class*.ts && git commit -m "feat(bridge): event scan and provider-failure classification"`

### Task 4: Model health

**Files:**
- Create: `bridge/extensions/orchestrator/model-health.ts`
- Test: `bridge/extensions/orchestrator/model-health.test.ts`

**Interfaces:**
- Produces:
  - `class ModelHealth { constructor(now?: () => number); markUnhealthy(model: string, cls: string, ms: number): void; isHealthy(model: string): boolean; snapshot(): Array<{ model: string; cls: string; until: number }> }`
  - `providerRegion(model: string): string`

- [ ] **Step 1: Write the failing test** `model-health.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ModelHealth, providerRegion } from "./model-health.ts";

describe("ModelHealth", () => {
	test("unhealthy until the window passes; a longer mark extends, a shorter one does not shorten", () => {
		let t = 0;
		const h = new ModelHealth(() => t);
		h.markUnhealthy("a/x", "transient", 100);
		expect(h.isHealthy("a/x")).toBe(false);
		expect(h.isHealthy("b/y")).toBe(true);
		h.markUnhealthy("a/x", "quota", 10);
		t = 50;
		expect(h.snapshot()).toEqual([{ model: "a/x", cls: "transient", until: 100 }]);
		h.markUnhealthy("a/x", "quota", 200);
		t = 150;
		expect(h.isHealthy("a/x")).toBe(false);
		t = 250;
		expect(h.isHealthy("a/x")).toBe(true);
		expect(h.snapshot()).toEqual([]);
	});
});

describe("providerRegion", () => {
	test.each([
		["amazon-bedrock/global.anthropic.claude-opus-5-5", "amazon-bedrock/global"],
		["amazon-bedrock/eu.anthropic.claude-opus-5-5", "amazon-bedrock/eu"],
		["amazon-bedrock/minimax.minimax-m2", "amazon-bedrock"],
		["openai-codex/gpt-6-astra", "openai-codex"],
		["humain-node/glm-5.2", "humain-node"],
		["bare-model", "bare-model"],
	])("%s -> %s", (model, expected) => expect(providerRegion(model)).toBe(expected));
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (the module can't be found).
- [ ] **Step 3: Implement** `model-health.ts`:

```ts
/**
 * Model health for one run: a model that failed with a provider error is skipped
 * by every dispatch in the run until its window passes. Pure apart from the
 * injectable clock.
 */
export class ModelHealth {
	private readonly marks = new Map<string, { until: number; cls: string }>();
	constructor(private readonly now: () => number = Date.now) {}

	markUnhealthy(model: string, cls: string, ms: number): void {
		const until = this.now() + ms;
		const prev = this.marks.get(model);
		if (!prev || prev.until < until) this.marks.set(model, { until, cls });
	}

	isHealthy(model: string): boolean {
		const mark = this.marks.get(model);
		return !mark || mark.until <= this.now();
	}

	snapshot(): Array<{ model: string; cls: string; until: number }> {
		const t = this.now();
		return [...this.marks.entries()]
			.filter(([, m]) => m.until > t)
			.map(([model, m]) => ({ model, cls: m.cls, until: m.until }));
	}
}

const REGION_RE = /^(global|eu|us|apac|ap|jp|au|ca)\./;

/** `amazon-bedrock/global.anthropic.x` -> `amazon-bedrock/global`; other providers -> the provider. */
export function providerRegion(model: string): string {
	const slash = model.indexOf("/");
	if (slash < 0) return model;
	const provider = model.slice(0, slash);
	const region = REGION_RE.exec(model.slice(slash + 1))?.[1];
	return region ? `${provider}/${region}` : provider;
}
```

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/model-health*.ts && git commit -m "feat(bridge): per-run model health"`

---
## Wave 2

### Task 5: Candidate router

**Files:**
- Create: `bridge/extensions/orchestrator/model-router.ts`
- Test: `bridge/extensions/orchestrator/model-router.test.ts`

**Interfaces:**
- Consumes:
  - `resolveAlias`, `tierOf`, `shortName`, `METHOD`, `AliasTable`, `Tier`, `ModelRequirementsRule` (models.ts, Task 1)
  - `Catalog` (Task 2)
  - `providerRegion`, `ModelHealth` (Task 4)
  - `bedrockFallbackFor` (provider-fallback.ts)
- Produces:
  - `interface Requirement { minContext: number; minOutput: number; effortControl: boolean }`
  - `requirementFor(capability: string, rule?: ModelRequirementsRule): Requirement`
  - `interface Candidate { model: string; spec: string; source: "primary" | "twin" | "backup" | "upgrade"; qualified: boolean; reasons: string[]; effortControl: boolean }`
  - `interface CandidateInput { capability: string; primary: string; backups?: Record<string, string[]>; tierPrimaries: Partial<Record<Tier, string>>; table: AliasTable; preference: string[]; catalog: Catalog; requirement?: Requirement }`
  - `resolveCandidates(input: CandidateInput): Candidate[]`
  - `usableModels(cands: Candidate[] | undefined, primary: string): string[]`
  - `pickBackup(models: string[], current: string, isHealthy?: (m: string) => boolean): string | undefined`
  - `formatCandidates(cands: Candidate[]): string`
  - `formatCandidateGroups(table: Record<string, Candidate[]>): string[]`
  - `backupWarnings(table: Record<string, Candidate[]>): string[]`

- [ ] **Step 1: Write the failing test** `model-router.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildAliasTable } from "./models.ts";
import { buildCatalog } from "./model-catalog.ts";
import { ModelHealth } from "./model-health.ts";
import {
	backupWarnings, formatCandidateGroups, formatCandidates, pickBackup, requirementFor, resolveCandidates, usableModels,
} from "./model-router.ts";

const MODELS = [
	["amazon-bedrock", "global.anthropic.claude-opus-5-5", 1_000_000, 128_000, true],
	["amazon-bedrock", "eu.anthropic.claude-opus-5-5", 1_000_000, 128_000, true],
	["amazon-bedrock", "global.anthropic.claude-fable-5-1", 1_000_000, 128_000, true],
	["amazon-bedrock", "global.anthropic.claude-sonnet-5", 1_000_000, 128_000, true],
	["amazon-bedrock", "global.openai.gpt-6-luna", 1_100_000, 128_000, true],
	["openai-codex", "gpt-6-astra", 272_000, 128_000, true],
	["openai-codex", "gpt-6-luna", 272_000, 128_000, true],
	["humain-node", "minimax-m3", 204_800, 16_384, false],
	["humain-node", "glm-5.2", 1_000_000, 131_072, false],
	["humain-node", "claude-opus-5", undefined, undefined, false],
] as const;
const table = buildAliasTable(MODELS.map(([provider, id]) => ({ provider, id })));
const catalog = buildCatalog(MODELS.map(([provider, id, contextWindow, maxTokens, reasoning]) => ({ provider, id, contextWindow, maxTokens, reasoning })));
const base = { table, preference: ["openai-codex", "amazon-bedrock"], catalog, tierPrimaries: {} };
const view = (c: ReturnType<typeof resolveCandidates>) => c.map((x) => [x.model, x.source, x.qualified, x.reasons]);

describe("requirementFor", () => {
	test("group or default", () => {
		expect(requirementFor("lead_large")).toEqual({ minContext: 256000, minOutput: 64000, effortControl: false });
		expect(requirementFor("qa_agent")).toEqual({ minContext: 200000, minOutput: 32000, effortControl: false });
		expect(requirementFor("not_in_any_group")).toEqual({ minContext: 128000, minOutput: 16000, effortControl: false });
	});
});

describe("resolveCandidates", () => {
	test("capability list beats tier list; minimums checked; unresolved kept as excluded", () => {
		const c = resolveCandidates({
			...base,
			capability: "lead_large",
			primary: "amazon-bedrock/global.anthropic.claude-opus-5-5",
			backups: {
				lead_large: ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra", "humain-node/minimax-m3", "humain-node/glm-5.2", "humain-node/claude-opus-5", "nope/x"],
				frontier: ["openai-codex/gpt-6-luna"],
			},
		});
		expect(view(c)).toEqual([
			["amazon-bedrock/global.anthropic.claude-opus-5-5", "primary", true, []],
			["amazon-bedrock/eu.anthropic.claude-opus-5-5", "backup", true, []],
			["openai-codex/gpt-6-astra", "backup", true, []],
			["humain-node/minimax-m3", "backup", false, ["context 204800 < 256000", "min_output 16384 < 64000"]],
			["humain-node/glm-5.2", "backup", true, []],
			["humain-node/claude-opus-5", "backup", false, ["unknown context", "unknown max output"]],
			["nope/x", "backup", false, [expect.stringContaining("unresolved: unknown provider")]],
		]);
		expect(c.find((x) => x.model === "humain-node/glm-5.2")?.effortControl).toBe(false);
	});
	test("tier list, then higher tiers only, duplicates removed", () => {
		const c = resolveCandidates({
			...base,
			capability: "qa_agent",
			primary: "amazon-bedrock/global.anthropic.claude-sonnet-5",
			tierPrimaries: { cheap: "gpt-6-luna", premium: "amazon-bedrock/global.anthropic.claude-opus-5-5", frontier: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
			backups: { mid: ["openai-codex/gpt-6-astra"], premium: ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra"], cheap: ["openai-codex/gpt-6-luna"] },
		});
		expect(c.map((x) => [x.model, x.source])).toEqual([
			["amazon-bedrock/global.anthropic.claude-sonnet-5", "primary"],
			["openai-codex/gpt-6-astra", "backup"],
			["amazon-bedrock/global.anthropic.claude-opus-5-5", "upgrade"],
			["amazon-bedrock/eu.anthropic.claude-opus-5-5", "upgrade"],
			["amazon-bedrock/global.anthropic.claude-fable-5-1", "upgrade"],
		]);
	});
	test("an openai-codex primary gets its Bedrock twin right after it", () => {
		const c = resolveCandidates({ ...base, capability: "worker", primary: "openai-codex/gpt-6-luna", backups: { cheap: ["amazon-bedrock/global.openai.gpt-6-luna"] } });
		expect(c.map((x) => [x.model, x.source])).toEqual([
			["openai-codex/gpt-6-luna", "primary"],
			["amazon-bedrock/global.openai.gpt-6-luna", "twin"],
		]);
	});
	test("the primary is usable even when it fails a minimum; the failure is kept as a warning", () => {
		const c = resolveCandidates({ ...base, capability: "lead_large", primary: "humain-node/minimax-m3" });
		expect(view(c)).toEqual([["humain-node/minimax-m3", "primary", true, ["context 204800 < 256000", "min_output 16384 < 64000"]]]);
	});
});

describe("usableModels / pickBackup", () => {
	const cands = resolveCandidates({
		...base, capability: "lead_large", primary: "amazon-bedrock/global.anthropic.claude-opus-5-5",
		backups: { lead_large: ["humain-node/minimax-m3", "amazon-bedrock/global.anthropic.claude-fable-5-1", "amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra"] },
	});
	test("usable = qualified, primary first; no list means just the primary", () => {
		expect(usableModels(cands, "amazon-bedrock/global.anthropic.claude-opus-5-5")).toEqual([
			"amazon-bedrock/global.anthropic.claude-opus-5-5", "amazon-bedrock/global.anthropic.claude-fable-5-1",
			"amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra",
		]);
		expect(usableModels(undefined, "a/b")).toEqual(["a/b"]);
		expect(usableModels(cands, "x/override")[0]).toBe("x/override");
	});
	test("backup prefers another provider/region, skips unhealthy, else same region, else none", () => {
		const models = usableModels(cands, "amazon-bedrock/global.anthropic.claude-opus-5-5");
		const cur = models[0];
		expect(pickBackup(models, cur)).toBe("amazon-bedrock/eu.anthropic.claude-opus-5-5");
		const h = new ModelHealth(() => 0);
		h.markUnhealthy("amazon-bedrock/eu.anthropic.claude-opus-5-5", "transient", 10);
		h.markUnhealthy("openai-codex/gpt-6-astra", "transient", 10);
		expect(pickBackup(models, cur, (m) => h.isHealthy(m))).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
		expect(pickBackup([cur], cur)).toBeUndefined();
	});
});

describe("formatting", () => {
	const t = {
		lead: resolveCandidates({ ...base, capability: "lead", primary: "amazon-bedrock/global.anthropic.claude-opus-5-5", backups: { lead: ["humain-node/glm-5.2", "humain-node/minimax-m3"] } }),
		architect: resolveCandidates({ ...base, capability: "architect", primary: "amazon-bedrock/global.anthropic.claude-opus-5-5", backups: { architect: ["humain-node/glm-5.2", "humain-node/minimax-m3"] } }),
		scout: resolveCandidates({ ...base, capability: "scout", primary: "humain-node/glm-5.2" }),
	};
	test("one line per candidate list, capabilities grouped", () => {
		expect(formatCandidates(t.lead)).toBe(
			"opus-5-5@amazon-bedrock/global ✓ · glm-5.2@humain-node ✓ (effort n/a) · minimax-m3@humain-node ✗ context 204800 < 256000; min_output 16384 < 64000",
		);
		expect(formatCandidateGroups(t)).toEqual([
			`lead, architect: ${formatCandidates(t.lead)}`,
			`scout: ${formatCandidates(t.scout)}`,
		]);
	});
	test("warns once for capabilities with no usable backup", () => {
		expect(backupWarnings(t)).toEqual(["no qualifying backup for scout; a provider outage will fail those dispatches"]);
	});
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (the module can't be found).
- [ ] **Step 3: Implement** `model-router.ts`:

```ts
/**
 * Ordered, checked backup candidates for a capability (spec §4.2–4.3).
 * The order is: primary, then the codex→Bedrock twin, then the capability's (or its
 * tier's) backups, then higher tiers. Lower tiers are never added. Pure.
 */
import { METHOD, resolveAlias, shortName, tierOf, type AliasTable, type ModelRequirementsRule, type Tier } from "./models.ts";
import type { Catalog } from "./model-catalog.ts";
import { providerRegion } from "./model-health.ts";
import { bedrockFallbackFor } from "./provider-fallback.ts";

export interface Requirement { minContext: number; minOutput: number; effortControl: boolean }

export function requirementFor(capability: string, rule: ModelRequirementsRule = METHOD.rules.model_requirements): Requirement {
	const g = Object.values(rule.groups).find((x) => x.capabilities.includes(capability)) ?? rule.default;
	return { minContext: g.min_context, minOutput: g.min_output, effortControl: g.effort_control ?? false };
}

export interface Candidate {
	model: string;
	spec: string;
	source: "primary" | "twin" | "backup" | "upgrade";
	qualified: boolean;
	reasons: string[];
	effortControl: boolean;
}

export interface CandidateInput {
	capability: string;
	/** Canonical provider/id of the resolved binding. */
	primary: string;
	backups?: Record<string, string[]>;
	/** Tier -> spec (alias or provider/id) from the profile/flags. */
	tierPrimaries: Partial<Record<Tier, string>>;
	table: AliasTable;
	preference: string[];
	catalog: Catalog;
	requirement?: Requirement;
}

const ASCENDING: Tier[] = ["cheap", "mid", "premium", "frontier"];

function check(model: string, catalog: Catalog, req: Requirement): { reasons: string[]; effortControl: boolean } {
	const f = catalog.get(model) ?? {};
	const reasons: string[] = [];
	if (f.context === undefined) reasons.push("unknown context");
	else if (f.context < req.minContext) reasons.push(`context ${f.context} < ${req.minContext}`);
	if (f.maxOutput === undefined) reasons.push("unknown max output");
	else if (f.maxOutput < req.minOutput) reasons.push(`min_output ${f.maxOutput} < ${req.minOutput}`);
	const effortControl = f.effortControl ?? false;
	if (req.effortControl && !effortControl) reasons.push("no effort control");
	return { reasons, effortControl };
}

export function resolveCandidates(input: CandidateInput): Candidate[] {
	const req = input.requirement ?? requirementFor(input.capability);
	const out: Candidate[] = [];
	const seen = new Set<string>();
	const add = (model: string, spec: string, source: Candidate["source"]) => {
		if (seen.has(model)) return;
		seen.add(model);
		const c = check(model, input.catalog, req);
		out.push({ model, spec, source, qualified: source === "primary" || c.reasons.length === 0, reasons: c.reasons, effortControl: c.effortControl });
	};
	const addSpec = (spec: string, source: Candidate["source"]) => {
		const res = resolveAlias(spec, input.table, input.preference);
		if (res.model) return add(res.model, spec, source);
		if (seen.has(`?${spec}`)) return;
		seen.add(`?${spec}`);
		out.push({ model: spec, spec, source, qualified: false, reasons: [`unresolved: ${res.error ?? "unknown model"}`], effortControl: false });
	};

	add(input.primary, input.primary, "primary");
	const twin = bedrockFallbackFor(input.primary, input.table);
	if (twin) add(twin, twin, "twin");
	const tier = tierOf(input.capability);
	const own = input.backups?.[input.capability] ?? (tier ? input.backups?.[tier] : undefined) ?? [];
	for (const spec of own) addSpec(spec, "backup");
	if (tier) {
		for (const higher of ASCENDING.slice(ASCENDING.indexOf(tier) + 1)) {
			const p = input.tierPrimaries[higher];
			if (p) addSpec(p, "upgrade");
			for (const spec of input.backups?.[higher] ?? []) addSpec(spec, "upgrade");
		}
	}
	return out;
}

/** Models a dispatch may use, in order. `primary` (the dispatch's own binding) always comes first. */
export function usableModels(cands: Candidate[] | undefined, primary: string): string[] {
	const list = (cands ?? []).filter((c) => c.qualified).map((c) => c.model);
	return [primary, ...list.filter((m) => m !== primary)];
}

/** The backup for a nested worker: next usable, healthy model, preferring another provider/region. */
export function pickBackup(models: string[], current: string, isHealthy: (m: string) => boolean = () => true): string | undefined {
	const others = models.filter((m) => m !== current && isHealthy(m));
	const region = providerRegion(current);
	return others.find((m) => providerRegion(m) !== region) ?? others[0];
}

function label(c: Candidate): string {
	return c.reasons.some((r) => r.startsWith("unresolved")) ? c.spec : `${shortName(c.model)}@${providerRegion(c.model)}`;
}

export function formatCandidates(cands: Candidate[]): string {
	return cands
		.map((c) => {
			if (!c.qualified) return `${label(c)} ✗ ${c.reasons.join("; ")}`;
			const warn = c.reasons.length > 0 ? ` (warning: ${c.reasons.join("; ")})` : "";
			return `${label(c)} ✓${c.effortControl ? "" : " (effort n/a)"}${warn}`;
		})
		.join(" · ");
}

export function formatCandidateGroups(table: Record<string, Candidate[]>): string[] {
	const groups = new Map<string, string[]>();
	for (const [cap, cands] of Object.entries(table)) {
		const line = formatCandidates(cands);
		groups.set(line, [...(groups.get(line) ?? []), cap]);
	}
	return [...groups.entries()].map(([line, caps]) => `${caps.join(", ")}: ${line}`);
}

export function backupWarnings(table: Record<string, Candidate[]>): string[] {
	const lonely = Object.entries(table)
		.filter(([, cands]) => cands.length > 0 && usableModels(cands, cands[0].model).length < 2)
		.map(([cap]) => cap);
	return lonely.length > 0 ? [`no qualifying backup for ${lonely.join(", ")}; a provider outage will fail those dispatches`] : [];
}
```

> **Note for the implementer:** the primary bedrock opus in the test has `effortControl: true`, so it shows no `(effort n/a)`. If `formatCandidates`' expected string differs only in how `shortName` shortens a model, fix the test's expected string to match `shortName`'s real output. Don't change `shortName`.

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/model-router*.ts && git commit -m "feat(bridge): backup candidate resolution with role minimums"`

### Task 6: Failover policy

**Files:**
- Create: `bridge/extensions/orchestrator/failover-policy.ts`
- Test: `bridge/extensions/orchestrator/failover-policy.test.ts`

**Interfaces:**
- Consumes: `METHOD`, `ModelFailoverRule` (Task 1); `providerRegion` (Task 4)
- Produces:
  - `interface FailoverConfig { unhealthyMs: number; sameModelRetryDelayMs: number; waitScheduleMs: number[]; maxWaitMs: number; maxSwitches: number; realWorkMinToolCalls: number }`
  - `failoverConfig(rule?: ModelFailoverRule): FailoverConfig`
  - `interface PolicyState { candidates: string[]; current: number; attempted: number[]; failedRegions: string[]; sameModelRetried: boolean; switches: number; waitIndex: number; waitedMs: number }`
  - `type Step = { kind: "retry-same"; delayMs: number } | { kind: "switch"; index: number } | { kind: "wait"; delayMs: number } | { kind: "give-up"; reason: "max-switches" | "max-wait" }`
  - `initialState(candidates: string[], start?: number): PolicyState`
  - `pickCandidate(state, isHealthy): number | null`
  - `waitOrGiveUp(state, cfg): Step`
  - `nextStep(state, failure: "quota" | "transient" | "stall", realWork: boolean, isHealthy: (m: string) => boolean, cfg): Step`
  - `applyStep(state, step): PolicyState`
  - `resumeAfterWait(state, index): PolicyState`

- [ ] **Step 1: Write the failing test** `failover-policy.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyStep, failoverConfig, initialState, nextStep, pickCandidate, resumeAfterWait, waitOrGiveUp } from "./failover-policy.ts";

const cfg = failoverConfig();
const C = [
	"amazon-bedrock/global.anthropic.claude-opus-5-5",
	"amazon-bedrock/global.anthropic.claude-fable-5-1",
	"amazon-bedrock/eu.anthropic.claude-opus-5-5",
	"openai-codex/gpt-6-astra",
];
const all = () => true;

describe("failoverConfig", () => {
	test("reads method.json defaults", () => {
		expect(cfg).toEqual({ unhealthyMs: 600000, sameModelRetryDelayMs: 60000, waitScheduleMs: [60000, 120000, 240000], maxWaitMs: 900000, maxSwitches: 4, realWorkMinToolCalls: 3 });
	});
});

describe("nextStep", () => {
	const failedGlobal = { ...initialState(C), failedRegions: ["amazon-bedrock/global"] };
	test("real work gets one same-model retry, but never for quota", () => {
		expect(nextStep(failedGlobal, "transient", true, all, cfg)).toEqual({ kind: "retry-same", delayMs: 60000 });
		expect(nextStep(failedGlobal, "stall", true, all, cfg)).toEqual({ kind: "retry-same", delayMs: 60000 });
		expect(nextStep(failedGlobal, "quota", true, all, cfg)).toEqual({ kind: "switch", index: 2 });
		expect(nextStep({ ...failedGlobal, sameModelRetried: true }, "transient", true, all, cfg)).toEqual({ kind: "switch", index: 2 });
	});
	test("no real work switches, preferring another provider/region", () => {
		expect(nextStep(failedGlobal, "transient", false, all, cfg)).toEqual({ kind: "switch", index: 2 });
	});
	test("skips unhealthy; falls back to the same region last", () => {
		expect(pickCandidate(failedGlobal, (m) => !m.includes("eu."))).toBe(3);
		expect(pickCandidate({ ...failedGlobal, attempted: [0, 2, 3] }, all)).toBe(1);
	});
	test("max switches gives up", () => {
		expect(nextStep({ ...failedGlobal, switches: 4 }, "transient", false, all, cfg)).toEqual({ kind: "give-up", reason: "max-switches" });
	});
	test("nothing left: wait by schedule, capped at max_wait, then give up", () => {
		const s = { ...failedGlobal, attempted: [0, 1, 2, 3] };
		expect(nextStep(s, "transient", false, all, cfg)).toEqual({ kind: "wait", delayMs: 60000 });
		expect(waitOrGiveUp({ ...s, waitIndex: 5 }, cfg)).toEqual({ kind: "wait", delayMs: 240000 });
		expect(waitOrGiveUp({ ...s, waitIndex: 2, waitedMs: 800000 }, cfg)).toEqual({ kind: "wait", delayMs: 100000 });
		expect(waitOrGiveUp({ ...s, waitedMs: 900000 }, cfg)).toEqual({ kind: "give-up", reason: "max-wait" });
	});
});

describe("state transitions", () => {
	test("applyStep and resumeAfterWait", () => {
		const s0 = initialState(C, 1);
		expect(s0).toEqual({ candidates: C, current: 1, attempted: [1], failedRegions: [], sameModelRetried: false, switches: 0, waitIndex: 0, waitedMs: 0 });
		const s1 = applyStep(s0, { kind: "retry-same", delayMs: 1 });
		expect(s1.sameModelRetried).toBe(true);
		const s2 = applyStep(s1, { kind: "switch", index: 3 });
		expect([s2.current, s2.attempted, s2.switches, s2.sameModelRetried]).toEqual([3, [1, 3], 1, false]);
		const s3 = applyStep(s2, { kind: "wait", delayMs: 60000 });
		expect([s3.attempted, s3.waitIndex, s3.waitedMs]).toEqual([[], 1, 60000]);
		const s4 = resumeAfterWait(s3, 0);
		expect([s4.current, s4.attempted, s4.switches]).toEqual([0, [0], 1]);
	});
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (the module can't be found).
- [ ] **Step 3: Implement** `failover-policy.ts`:

```ts
/**
 * Pure failover decisions (spec §5.3): retry the same model once after real work,
 * switch to the next healthy candidate (moving candidates on the failed
 * provider/region to the end), wait by schedule when none are left, and give up
 * after max_switches or max_wait_ms.
 */
import { METHOD, type ModelFailoverRule } from "./models.ts";
import { providerRegion } from "./model-health.ts";

export interface FailoverConfig {
	unhealthyMs: number;
	sameModelRetryDelayMs: number;
	waitScheduleMs: number[];
	maxWaitMs: number;
	maxSwitches: number;
	realWorkMinToolCalls: number;
}

export function failoverConfig(rule: ModelFailoverRule = METHOD.rules.model_failover): FailoverConfig {
	return {
		unhealthyMs: rule.unhealthy_ms,
		sameModelRetryDelayMs: rule.same_model_retry_delay_ms,
		waitScheduleMs: [...rule.wait_schedule_ms],
		maxWaitMs: rule.max_wait_ms,
		maxSwitches: rule.max_switches,
		realWorkMinToolCalls: rule.real_work_min_tool_calls,
	};
}

export interface PolicyState {
	candidates: string[];
	current: number;
	/** Candidate indexes tried since the last wait. */
	attempted: number[];
	failedRegions: string[];
	sameModelRetried: boolean;
	switches: number;
	waitIndex: number;
	waitedMs: number;
}

export type Step =
	| { kind: "retry-same"; delayMs: number }
	| { kind: "switch"; index: number }
	| { kind: "wait"; delayMs: number }
	| { kind: "give-up"; reason: "max-switches" | "max-wait" };

export function initialState(candidates: string[], start = 0): PolicyState {
	return { candidates, current: start, attempted: [start], failedRegions: [], sameModelRetried: false, switches: 0, waitIndex: 0, waitedMs: 0 };
}

export function pickCandidate(state: PolicyState, isHealthy: (m: string) => boolean): number | null {
	const open = state.candidates.map((_, i) => i).filter((i) => !state.attempted.includes(i) && isHealthy(state.candidates[i]));
	const fresh = open.filter((i) => !state.failedRegions.includes(providerRegion(state.candidates[i])));
	const stale = open.filter((i) => !fresh.includes(i));
	return [...fresh, ...stale][0] ?? null;
}

export function waitOrGiveUp(state: PolicyState, cfg: FailoverConfig): Step {
	const remaining = cfg.maxWaitMs - state.waitedMs;
	if (remaining <= 0) return { kind: "give-up", reason: "max-wait" };
	const planned = cfg.waitScheduleMs[Math.min(state.waitIndex, cfg.waitScheduleMs.length - 1)];
	return { kind: "wait", delayMs: Math.min(planned, remaining) };
}

export function nextStep(
	state: PolicyState,
	failure: "quota" | "transient" | "stall",
	realWork: boolean,
	isHealthy: (m: string) => boolean,
	cfg: FailoverConfig,
): Step {
	if (failure !== "quota" && realWork && !state.sameModelRetried) return { kind: "retry-same", delayMs: cfg.sameModelRetryDelayMs };
	if (state.switches >= cfg.maxSwitches) return { kind: "give-up", reason: "max-switches" };
	const index = pickCandidate(state, isHealthy);
	return index === null ? waitOrGiveUp(state, cfg) : { kind: "switch", index };
}

export function applyStep(state: PolicyState, step: Step): PolicyState {
	switch (step.kind) {
		case "retry-same":
			return { ...state, sameModelRetried: true };
		case "switch":
			return { ...state, current: step.index, attempted: [...state.attempted, step.index], switches: state.switches + 1, sameModelRetried: false };
		case "wait":
			return { ...state, attempted: [], waitIndex: state.waitIndex + 1, waitedMs: state.waitedMs + step.delayMs };
		case "give-up":
			return state;
	}
}

/** After a wait, start again on `index` without counting it as a switch. */
export function resumeAfterWait(state: PolicyState, index: number): PolicyState {
	return { ...state, current: index, attempted: [index], sameModelRetried: false };
}
```

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/failover-policy*.ts && git commit -m "feat(bridge): pure failover policy"`

### Task 7: Handoff summary

**Files:**
- Create: `bridge/extensions/orchestrator/handoff.ts`
- Test: `bridge/extensions/orchestrator/handoff.test.ts`

**Interfaces:**
- Consumes: `EventScan` (Task 3)
- Produces:
  - `interface HandoffInput { taskId: string; attempt: number; previousModel: string; failureClass: string; reason: string; filesChanged: readonly string[]; scan: EventScan; redact?: (s: string) => string }`
  - `buildHandoff(input: HandoffInput): string`
  - `HANDOFF_MAX_CHARS = 12000`

- [ ] **Step 1: Write the failing test** `handoff.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { EventScan } from "./event-scan.ts";
import { HANDOFF_MAX_CHARS, buildHandoff } from "./handoff.ts";

const scan = (o: Partial<EventScan> = {}): EventScan => ({
	toolCalls: 5, toolInFlight: false, lastAssistantText: "Batch A done; starting batch B.", finishedWorkers: [], unfinishedWorkers: [], subagentCalls: [], ...o,
});
const input = { taskId: "run-lead-0", attempt: 2, previousModel: "amazon-bedrock/global.anthropic.claude-fable-5-1", failureClass: "transient", reason: "[provider error] Service unavailable" };

describe("buildHandoff", () => {
	test("carries header, files, workers, last text and the closing instruction", () => {
		const h = buildHandoff({
			...input,
			filesChanged: ["orchestrator/cli.py", "tests/test_cli_args.py"],
			scan: scan({ finishedWorkers: [{ id: "t205", ok: true, summary: "## Completed" }, { id: "t206", ok: false, summary: "" }], unfinishedWorkers: ["t210"] }),
		});
		expect(h.split("\n")).toEqual([
			"## Resume from a failed attempt (attempt 2 of run-lead-0; previous model amazon-bedrock/global.anthropic.claude-fable-5-1 failed: transient [provider error] Service unavailable)",
			"Work already on disk: verify it, don't redo it.",
			"- Files changed since this dispatch started: orchestrator/cli.py, tests/test_cli_args.py",
			"- Finished nested workers: t205 ✓ ## Completed; t206 ✗   Unfinished: t210",
			"- Last plan/report text from the previous attempt (bounded): Batch A done; starting batch B.",
			"Continue from here. Re-run the verification before claiming success.",
		]);
	});
	test("bounds the file list, redacts, and handles empty input", () => {
		const files = Array.from({ length: 150 }, (_, i) => `/Users/someone/repo/f${i}.ts`);
		const h = buildHandoff({ ...input, filesChanged: files, scan: scan(), redact: (s) => s.replaceAll("/Users/someone", "~") });
		expect(h).toContain("~/repo/f99.ts +50 more");
		expect(h).not.toContain("f100.ts");
		expect(h).not.toContain("/Users/someone");
		const empty = buildHandoff({ ...input, filesChanged: [], scan: scan({ lastAssistantText: "" }) });
		expect(empty).toContain("Files changed since this dispatch started: (none detected)");
		expect(empty).toContain("Finished nested workers: (none)   Unfinished: (none)");
		expect(empty).toContain("(bounded): (none)");
	});
	test("caps the whole section and keeps the closing line", () => {
		const files = Array.from({ length: 100 }, (_, i) => `repo/${"d".repeat(200)}/f${i}.ts`);
		const h = buildHandoff({ ...input, filesChanged: files, scan: scan({ lastAssistantText: "x".repeat(9000) }) });
		expect(h.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
		expect(h.endsWith("Continue from here. Re-run the verification before claiming success.")).toBe(true);
	});
	test("keeps the END of a long last text", () => {
		const h = buildHandoff({ ...input, filesChanged: [], scan: scan({ lastAssistantText: "a".repeat(5000) + "TAIL" }) });
		expect(h).toContain("…" + "a".repeat(3995) + "TAIL");
	});
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (the module can't be found).
- [ ] **Step 3: Implement** `handoff.ts`:

```ts
/**
 * The "Resume from a failed attempt" section added to a dispatch's original prompt
 * when the previous attempt did real work (spec §5.4). Pure and bounded.
 */
import type { EventScan } from "./event-scan.ts";

export const HANDOFF_MAX_CHARS = 12_000;
const FILES_MAX = 100;
const LAST_TEXT_MAX = 4_000;
const CLOSING = "Continue from here. Re-run the verification before claiming success.";

export interface HandoffInput {
	taskId: string;
	attempt: number;
	previousModel: string;
	failureClass: string;
	reason: string;
	filesChanged: readonly string[];
	scan: EventScan;
	redact?: (s: string) => string;
}

export function buildHandoff(i: HandoffInput): string {
	const redact = i.redact ?? ((s: string) => s);
	const files = i.filesChanged.length === 0
		? "(none detected)"
		: i.filesChanged.slice(0, FILES_MAX).join(", ") + (i.filesChanged.length > FILES_MAX ? ` +${i.filesChanged.length - FILES_MAX} more` : "");
	const finished = i.scan.finishedWorkers.map((w) => `${w.id} ${w.ok ? "✓" : "✗"}${w.summary ? ` ${w.summary}` : ""}`).join("; ") || "(none)";
	const unfinished = i.scan.unfinishedWorkers.join(", ") || "(none)";
	const text = i.scan.lastAssistantText;
	const last = !text ? "(none)" : text.length > LAST_TEXT_MAX ? `…${text.slice(-(LAST_TEXT_MAX - 1))}` : text;
	const body = redact([
		`## Resume from a failed attempt (attempt ${i.attempt} of ${i.taskId}; previous model ${i.previousModel} failed: ${i.failureClass} ${i.reason})`,
		"Work already on disk: verify it, don't redo it.",
		`- Files changed since this dispatch started: ${files}`,
		`- Finished nested workers: ${finished}   Unfinished: ${unfinished}`,
		`- Last plan/report text from the previous attempt (bounded): ${last}`,
	].join("\n"));
	const room = HANDOFF_MAX_CHARS - CLOSING.length - 1;
	return `${body.length <= room ? body : `${body.slice(0, room - 1)}…`}\n${CLOSING}`;
}
```

> Check on the "keeps the END" test: `LAST_TEXT_MAX - 1 = 3999` characters are kept, i.e. `3995 × "a"` plus `"TAIL"`, after a leading `…`.

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/handoff*.ts && git commit -m "feat(bridge): bounded handoff summary for failover retries"`

### Task 8: Nested failover audit

**Files:**
- Create: `bridge/extensions/orchestrator/nested-audit.ts`
- Test: `bridge/extensions/orchestrator/nested-audit.test.ts`

**Interfaces:**
- Consumes: `EventScan` (Task 3)
- Produces:
  - `interface NestedAudit { missing: number; total: number }`
  - `auditNestedFailover(scan: Pick<EventScan, "subagentCalls">): NestedAudit`
  - `formatNestedAuditLine(audits: Array<NestedAudit | undefined>): string | null`

- [ ] **Step 1: Write the failing test** `nested-audit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { auditNestedFailover, formatNestedAuditLine } from "./nested-audit.ts";

describe("auditNestedFailover", () => {
	test("counts tasks without onFailure.retryWith", () => {
		expect(auditNestedFailover({ subagentCalls: [] })).toEqual({ missing: 0, total: 0 });
		expect(auditNestedFailover({ subagentCalls: [
			{ toolCallId: "a", tasks: [{ id: "t1", hasRetry: true }, { id: "t2", hasRetry: false }] },
			{ toolCallId: "b", tasks: [{ hasRetry: false }] },
		] })).toEqual({ missing: 2, total: 3 });
	});
	test("summary line only when something is missing", () => {
		expect(formatNestedAuditLine([{ missing: 0, total: 4 }, undefined])).toBeNull();
		expect(formatNestedAuditLine([{ missing: 2, total: 3 }, { missing: 1, total: 7 }])).toBe("⚠ 3/10 nested dispatches had no backup");
	});
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (the module can't be found).
- [ ] **Step 3: Implement** `nested-audit.ts`:

```ts
/** After-the-fact check that a lead gave every nested subagent task a backup (spec §6). Pure. */
import type { EventScan } from "./event-scan.ts";

export interface NestedAudit { missing: number; total: number }

export function auditNestedFailover(scan: Pick<EventScan, "subagentCalls">): NestedAudit {
	let missing = 0;
	let total = 0;
	for (const call of scan.subagentCalls) {
		for (const t of call.tasks) {
			total++;
			if (!t.hasRetry) missing++;
		}
	}
	return { missing, total };
}

export function formatNestedAuditLine(audits: Array<NestedAudit | undefined>): string | null {
	let missing = 0;
	let total = 0;
	for (const a of audits) {
		if (!a) continue;
		missing += a.missing;
		total += a.total;
	}
	return missing > 0 ? `⚠ ${missing}/${total} nested dispatches had no backup` : null;
}
```

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/nested-audit*.ts && git commit -m "feat(bridge): audit nested subagent backups"`

---
## Wave 3

### Task 9: Failover loop `dispatchWithFailover`

**Files:**
- Create: `bridge/extensions/orchestrator/failover.ts`
- Test: `bridge/extensions/orchestrator/failover.test.ts`

**Interfaces:**
- Consumes:
  - `scanEvents`, `EventScan` (T3)
  - `classifyFailure`, `failureReason`, `hadRealWork`, `FailureClass` (T3)
  - `ModelHealth`, `providerRegion` (T4)
  - `applyStep`, `initialState`, `nextStep`, `pickCandidate`, `resumeAfterWait`, `waitOrGiveUp`, `FailoverConfig`, `Step` (T6)
  - `buildHandoff` (T7)
  - `shortName` (models.ts)
- Produces:
  - `interface AttemptLike { exitCode: number; outcome: string; stderr: string; stopReason?: string; timeoutReason?: "inactivity" | "absolute"; costUsd: number; nestedCostUsd?: number }`
  - `interface AttemptRecord { model: string; cls: FailureClass; reason: string; costUsd: number; realWork: boolean }`
  - `interface FailoverSwitch { from: string; to: string; cls: FailureClass; reason: string }`
  - `interface FailoverTask { taskId: string; capability: string; prompt: string }`
  - `interface FailoverDeps<R> { runAttempt(model, prompt, attempt, spentBeforeUsd): Promise<R>; readEvents(r: R): Iterable<string>; snapshot(): unknown; changedSince(snap: unknown): string[]; sleep(ms): Promise<void>; health: ModelHealth; isCancelled(): boolean; recordEvent(event, payload): void; log(line): void; config: FailoverConfig; redact?(s): string; effortDropped?(model): boolean }`
  - `interface FailoverResult<R> { result: R; attempts: Array<{ model: string; result: R; record: AttemptRecord }>; switches: FailoverSwitch[]; finalModel: string; finalScan: EventScan; exhausted: boolean }`
  - `dispatchWithFailover<R extends AttemptLike>(task: FailoverTask, candidates: string[], deps: FailoverDeps<R>): Promise<FailoverResult<R>>`
  - `formatFailoverLine(results: Array<{ failovers?: FailoverSwitch[] }>): string | null`

- [ ] **Step 1: Write the failing test** `failover.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { failoverConfig } from "./failover-policy.ts";
import { ModelHealth } from "./model-health.ts";
import { dispatchWithFailover, formatFailoverLine, type AttemptLike, type FailoverDeps } from "./failover.ts";

interface Fake extends AttemptLike { model: string; events: string[]; files: string[] }
const A = "amazon-bedrock/global.anthropic.claude-fable-5-1";
const B = "openai-codex/gpt-6-astra";
const E503 = "[provider error] Service unavailable: Bedrock is unable to process your request.";
const toolEnd = (id: string) => JSON.stringify({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: {}, isError: false });
const fail = (model: string, o: Partial<Fake> = {}): Fake => ({ exitCode: 1, outcome: "failed", stderr: E503, costUsd: 0.5, model, events: [], files: [], ...o });
const ok = (model: string): Fake => ({ exitCode: 0, outcome: "completed", stderr: "", costUsd: 1, model, events: [], files: [] });

function harness(script: (model: string, n: number) => Fake, o: { health?: ModelHealth; cancelAfterSleeps?: number } = {}) {
	let clock = 0;
	const calls: Array<{ model: string; prompt: string; n: number; spent: number }> = [];
	const sleeps: number[] = [];
	const events: Array<[string, Record<string, unknown>]> = [];
	let lastFiles: string[] = [];
	const health = o.health ?? new ModelHealth(() => clock);
	const deps: FailoverDeps<Fake> = {
		runAttempt: async (model, prompt, n, spent) => {
			calls.push({ model, prompt, n, spent });
			const r = script(model, n);
			lastFiles = r.files;
			return r;
		},
		readEvents: (r) => r.events,
		snapshot: () => null,
		changedSince: () => lastFiles,
		sleep: async (ms) => { sleeps.push(ms); clock += ms; },
		health,
		isCancelled: () => o.cancelAfterSleeps !== undefined && sleeps.length >= o.cancelAfterSleeps,
		recordEvent: (e, p) => events.push([e, p]),
		log: () => {},
		config: failoverConfig(),
	};
	return { deps, calls, sleeps, events, health };
}
const task = { taskId: "run-lead-0", capability: "lead_large", prompt: "ORIGINAL" };

describe("dispatchWithFailover", () => {
	test("503 with no work: switch straight to the backup", async () => {
		const h = harness((m) => (m === A ? fail(A) : ok(B)));
		const r = await dispatchWithFailover(task, [A, B], h.deps);
		expect(r.finalModel).toBe(B);
		expect(r.exhausted).toBe(false);
		expect(r.switches).toEqual([{ from: A, to: B, cls: "transient", reason: E503 }]);
		expect(h.sleeps).toEqual([]);
		expect(h.calls.map((c) => [c.model, c.prompt])).toEqual([[A, "ORIGINAL"], [B, "ORIGINAL"]]);
		expect(h.events.map(([e]) => e)).toEqual(["model_unhealthy", "route_degraded"]);
	});
	test("real work: one delayed same-model retry with a handoff, then switch; spend is cumulative", async () => {
		const worked = { events: [toolEnd("1"), toolEnd("2"), toolEnd("3")], files: ["a.ts"] };
		const h = harness((m, n) => (n <= 2 ? fail(A, worked) : ok(B)));
		const r = await dispatchWithFailover(task, [A, B], h.deps);
		expect(h.calls.map((c) => c.model)).toEqual([A, A, B]);
		expect(h.sleeps).toEqual([60000]);
		expect(h.calls[1].prompt.startsWith("ORIGINAL\n\n## Resume from a failed attempt (attempt 2 of run-lead-0")).toBe(true);
		expect(h.calls[2].prompt).toContain("attempt 3 of run-lead-0");
		expect(h.calls[2].prompt.split("## Resume").length).toBe(2);
		expect(h.calls.map((c) => c.spent)).toEqual([0, 0.5, 1]);
		expect(r.attempts.map((a) => a.record.realWork)).toEqual([true, true, false]);
	});
	test("quota switches immediately even after real work", async () => {
		const h = harness((m) => (m === A ? fail(A, { stderr: "429 rate limit", events: [toolEnd("1"), toolEnd("2"), toolEnd("3")] }) : ok(B)));
		await dispatchWithFailover(task, [A, B], h.deps);
		expect(h.sleeps).toEqual([]);
		expect(h.calls.map((c) => c.model)).toEqual([A, B]);
	});
	test("a task failure passes through untouched", async () => {
		const h = harness(() => fail(A, { stderr: "TypeError: boom" }));
		const r = await dispatchWithFailover(task, [A, B], h.deps);
		expect(h.calls.length).toBe(1);
		expect(r.attempts[0].record.cls).toBe("task");
		expect(r.result.stderr).toBe("TypeError: boom");
	});
	test("a single candidate waits by schedule, retries after the unhealthy window, then gives up at max_wait", async () => {
		const h = harness(() => fail(A));
		const r = await dispatchWithFailover(task, [A], h.deps);
		expect(h.calls.length).toBe(2);
		expect(h.sleeps).toEqual([60000, 120000, 240000, 240000, 240000]);
		expect(r.exhausted).toBe(true);
		expect(r.result.stderr.startsWith("[orchestrator] all candidates unavailable (max-wait):")).toBe(true);
		expect(h.events.map(([e]) => e).at(-1)).toBe("failover_exhausted");
	});
	test("dispatches share health: a later dispatch starts on the healthy backup", async () => {
		let clock = 0;
		const health = new ModelHealth(() => clock);
		const first = harness((m) => (m === A ? fail(A) : ok(B)), { health });
		await dispatchWithFailover(task, [A, B], first.deps);
		const second = harness(() => ok(B), { health });
		const r = await dispatchWithFailover({ ...task, taskId: "run-lead-1" }, [A, B], second.deps);
		expect(second.calls.map((c) => c.model)).toEqual([B]);
		expect(r.switches).toEqual([]);
	});
	test("cancel during a wait returns at once", async () => {
		const h = harness(() => fail(A), { cancelAfterSleeps: 1 });
		const r = await dispatchWithFailover(task, [A], h.deps);
		expect(h.calls.length).toBe(1);
		expect(h.sleeps).toEqual([60000]);
		expect(r.exhausted).toBe(false);
	});
});

describe("formatFailoverLine", () => {
	test("null without failovers; otherwise one compact line", () => {
		expect(formatFailoverLine([{}, { failovers: [] }])).toBeNull();
		expect(formatFailoverLine([{ failovers: [{ from: A, to: B, cls: "transient", reason: "503" }] }])).toBe("failovers: 1 — fable-5-1→gpt-6-astra (transient 503)");
	});
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (the module can't be found).
- [ ] **Step 3: Implement** `failover.ts`:

```ts
/**
 * Run one dispatch across its candidate models (spec §5.3). All I/O is injected
 * through `deps`, so tests use a fake clock and fake attempts.
 */
import { scanEvents, type EventScan } from "./event-scan.ts";
import { classifyFailure, failureReason, hadRealWork, type AttemptSignals, type FailureClass } from "./failure-class.ts";
import { applyStep, initialState, nextStep, pickCandidate, resumeAfterWait, waitOrGiveUp, type FailoverConfig, type Step } from "./failover-policy.ts";
import { buildHandoff } from "./handoff.ts";
import { providerRegion, type ModelHealth } from "./model-health.ts";
import { shortName } from "./models.ts";

export interface AttemptLike {
	exitCode: number;
	outcome: string;
	stderr: string;
	stopReason?: string;
	timeoutReason?: "inactivity" | "absolute";
	costUsd: number;
	nestedCostUsd?: number;
}
export interface AttemptRecord { model: string; cls: FailureClass; reason: string; costUsd: number; realWork: boolean }
export interface FailoverSwitch { from: string; to: string; cls: FailureClass; reason: string }
export interface FailoverTask { taskId: string; capability: string; prompt: string }

export interface FailoverDeps<R> {
	runAttempt: (model: string, prompt: string, attempt: number, spentBeforeUsd: number) => Promise<R>;
	readEvents: (result: R) => Iterable<string>;
	snapshot: () => unknown;
	changedSince: (snapshot: unknown) => string[];
	sleep: (ms: number) => Promise<void>;
	health: ModelHealth;
	isCancelled: () => boolean;
	recordEvent: (event: string, payload: Record<string, unknown>) => void;
	log: (line: string) => void;
	config: FailoverConfig;
	redact?: (s: string) => string;
	effortDropped?: (model: string) => boolean;
}

export interface FailoverResult<R> {
	result: R;
	attempts: Array<{ model: string; result: R; record: AttemptRecord }>;
	switches: FailoverSwitch[];
	finalModel: string;
	finalScan: EventScan;
	exhausted: boolean;
}

export async function dispatchWithFailover<R extends AttemptLike>(
	task: FailoverTask,
	candidates: string[],
	deps: FailoverDeps<R>,
): Promise<FailoverResult<R>> {
	if (candidates.length === 0) throw new Error(`dispatchWithFailover: no candidate models for ${task.taskId}`);
	const healthy = (m: string) => deps.health.isHealthy(m);
	const start = candidates.findIndex(healthy);
	let state = initialState(candidates, start >= 0 ? start : 0);
	let prompt = task.prompt;
	let spent = 0;
	const files = new Set<string>();
	const attempts: FailoverResult<R>["attempts"] = [];
	const switches: FailoverSwitch[] = [];

	for (;;) {
		const model = candidates[state.current];
		const snap = deps.snapshot();
		const n = attempts.length + 1;
		const result = await deps.runAttempt(model, prompt, n, spent);
		spent += result.costUsd;
		const scan = scanEvents(deps.readEvents(result));
		const signals: AttemptSignals = {
			exitCode: result.exitCode,
			outcome: result.outcome,
			stderr: result.stderr,
			errorMessage: scan.lastErrorMessage,
			stopReason: result.stopReason,
			timeoutReason: result.timeoutReason,
			toolInFlight: scan.toolInFlight,
			cancelled: deps.isCancelled(),
		};
		const cls = classifyFailure(signals);
		const changed = deps.changedSince(snap);
		for (const f of changed) files.add(f);
		const realWork = hadRealWork(scan, changed, deps.config.realWorkMinToolCalls);
		const reason = cls === "ok" ? "" : failureReason(signals);
		attempts.push({ model, result, record: { model, cls, reason, costUsd: result.costUsd + (result.nestedCostUsd ?? 0), realWork } });
		const done = (exhausted: boolean, r: R = result): FailoverResult<R> => ({ result: r, attempts, switches, finalModel: model, finalScan: scan, exhausted });
		if (cls === "ok" || cls === "task" || cls === "cancelled") return done(false);

		deps.health.markUnhealthy(model, cls, deps.config.unhealthyMs);
		deps.recordEvent("model_unhealthy", { task_id: task.taskId, model, class: cls, for_ms: deps.config.unhealthyMs, reason });
		state = { ...state, failedRegions: [...state.failedRegions, providerRegion(model)] };
		if (realWork) {
			prompt = `${task.prompt}\n\n${buildHandoff({
				taskId: task.taskId, attempt: n + 1, previousModel: model, failureClass: cls, reason,
				filesChanged: [...files], scan, redact: deps.redact,
			})}`;
		}

		let step: Step = nextStep(state, cls, realWork, healthy, deps.config);
		let resumed = false;
		while (step.kind === "wait") {
			deps.log(`${task.taskId}: no healthy candidate; waiting ${Math.round(step.delayMs / 1000)}s before retrying the list`);
			await deps.sleep(step.delayMs);
			state = applyStep(state, step);
			if (deps.isCancelled()) return done(false);
			const index = pickCandidate(state, healthy);
			if (index !== null) {
				state = resumeAfterWait(state, index);
				step = { kind: "switch", index };
				resumed = true;
			} else {
				step = waitOrGiveUp(state, deps.config);
			}
		}

		if (step.kind === "give-up") {
			const summary = attempts.map((a) => `${a.model}: ${a.record.cls} ${a.record.reason}`).join("; ");
			deps.recordEvent("failover_exhausted", { task_id: task.taskId, capability: task.capability, reason: step.reason, attempts: attempts.map((a) => a.record) });
			deps.log(`${task.taskId}: all candidates unavailable (${step.reason})`);
			return done(true, { ...result, stderr: `[orchestrator] all candidates unavailable (${step.reason}): ${summary}\n${result.stderr}` });
		}
		if (step.kind === "retry-same") {
			deps.log(`${task.taskId}: ${model} failed (${cls}: ${reason}) after real work; retrying it once in ${Math.round(step.delayMs / 1000)}s with a handoff`);
			await deps.sleep(step.delayMs);
			if (deps.isCancelled()) return done(false);
			state = applyStep(state, step);
			continue;
		}
		const to = candidates[step.index];
		if (!resumed) state = applyStep(state, step);
		switches.push({ from: model, to, cls, reason });
		deps.recordEvent("route_degraded", {
			task_id: task.taskId, capability: task.capability, from_model: model, to_model: to, class: cls, reason,
			attempt: n + 1, real_work: realWork, handoff: realWork, effort_dropped: deps.effortDropped?.(to) ?? false,
		});
		deps.log(`${task.taskId}: ${model} failed (${cls}: ${reason}); switching to ${to}`);
	}
}

export function formatFailoverLine(results: Array<{ failovers?: FailoverSwitch[] }>): string | null {
	const all = results.flatMap((r) => r.failovers ?? []);
	if (all.length === 0) return null;
	return `failovers: ${all.length} — ${all.map((s) => `${shortName(s.from)}→${shortName(s.to)} (${s.cls} ${s.reason.slice(0, 80)})`).join(", ")}`;
}
```

> **Trace for the single-candidate test** (so the implementer can check the expected sleeps):
> 1. A fails at t=0 and is unhealthy until t=600k. Waits of 60k, 120k and 240k bring t to 420k, and A is still unhealthy.
> 2. A 240k wait brings t to 660k. A is now healthy, so it resumes and fails again, becoming unhealthy until 1260k.
> 3. The next wait is capped at the remaining 240k, bringing t to 900k.
> 4. `waitOrGiveUp` gives up with `max-wait`.
>
> That's 2 attempts and sleeps of `[60k,120k,240k,240k,240k]`.

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/failover*.ts && git commit -m "feat(bridge): dispatchWithFailover loop"` (the files are `failover.ts` and `failover.test.ts`; `failover-policy*` was committed in Task 6)

---
## Wave 4 (sequential; every task edits `index.ts`)

### Task 10: Wire failover into resolution, dispatch and triage

**Files:**
- Modify: `bridge/extensions/orchestrator/models.ts` (`AvailableModel` gains optional facts)
- Modify: `bridge/extensions/orchestrator/index.ts`
- Test: `bridge/extensions/orchestrator/index.test.ts`

**Interfaces:**
- Consumes everything from Tasks 1–9.
- Produces (exported from `index.ts`):
  - `cancellableSleep(ms: number, cancellation?: RunCancellation): Promise<void>`
  - `failoverDepsFor(cwd, session, recordEventFn, override?): Omit<FailoverDeps<SubagentProcessResult>, "runAttempt">`
  - `loadModelFacts(path?: string): { facts; problems }`
  - `diagnosticName(taskId: string): string`
  - `DispatchResult.failovers?: FailoverSwitch[]`
  - `RunSession.modelHealth: ModelHealth`, `RunSession.candidates: Record<string, Candidate[]>`
  - `FullResolution.candidates: Record<string, Candidate[]>`
  - `dispatchParallel` `deps.candidates?`, `deps.failover?`

- [ ] **Step 1: Update and add the failing tests in `index.test.ts`.** Replace the whole `describe("codex -> Bedrock quota fallback (Phase A)", …)` block with this one. It keeps the same `table`, `proc` and `task` helpers:

```ts
describe("provider failover in dispatchParallel", () => {
	const table = buildAliasTable([
		{ provider: "openai-codex", id: "gpt-6-astra" },
		{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
		{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
	]);
	const proc = (over: Partial<Awaited<ReturnType<typeof orchestrator.runSubagentProcess>>>) => ({
		exitCode: 0, stdout: "ok", finalText: "ok", rawStdout: "", personaCanMutate: false, stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
		costUsd: 0.01, costReported: true, durationMs: 5, outcome: "completed" as const, processExitCode: 0, ...over,
	});
	const task = (): DispatchTask[] => [{ capability: "security_review", task: "review", taskId: "run-sec" }];
	const quiet = { sleep: async () => {}, snapshot: () => null, changedSince: () => [] as string[], readEvents: () => [] as string[] };

	test("quota on codex fails over to the Bedrock twin (no profile backups needed)", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const models: string[] = [];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", task(),
			{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, 0, {
				recordEvent: (e, p) => { events.push([e, p]); },
				aliasTable: table,
				failover: quiet,
				runProcess: async (opts) => {
					models.push(opts.model);
					return models.length === 1
						? proc({ exitCode: 1, outcome: "failed", stderr: "usage limit reached for this account", costUsd: 0 })
						: proc({ model: "amazon-bedrock/global.openai.gpt-6-astra" });
				},
			});
		expect(models).toEqual(["openai-codex/gpt-6-astra", "amazon-bedrock/global.openai.gpt-6-astra"]);
		expect(result.exitCode).toBe(0);
		expect(result.model).toBe("amazon-bedrock/global.openai.gpt-6-astra");
		expect(result.taskId).toBe("run-sec");
		expect(result.failovers).toEqual([{ from: "openai-codex/gpt-6-astra", to: "amazon-bedrock/global.openai.gpt-6-astra", cls: "quota", reason: "usage limit reached for this account" }]);
		const degraded = events.filter(([e]) => e === "route_degraded");
		expect(degraded).toHaveLength(1);
		expect(degraded[0][1]).toMatchObject({ from_model: "openai-codex/gpt-6-astra", to_model: "amazon-bedrock/global.openai.gpt-6-astra", class: "quota" });
		expect(events.filter(([e, p]) => e === "dispatch_finished" && p.superseded_by_fallback === true)).toHaveLength(1);
	});

	test("no backup: waits, then fails with all candidates unavailable (sleep stubbed)", async () => {
		let calls = 0;
		const events: string[] = [];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", task(),
			{ security_review: { model: "openai-codex/gpt-5.3-codex-spark" } }, {} as never, 0, {
				recordEvent: (e) => { events.push(e); },
				aliasTable: table,
				failover: quiet,
				runProcess: async () => { calls++; return proc({ exitCode: 1, outcome: "failed", stderr: "429 Too Many Requests" }); },
			});
		expect(calls).toBe(1);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("all candidates unavailable");
		expect(events).toContain("failover_exhausted");
		expect(events).not.toContain("route_degraded");
	});

	test("non-provider failure is not retried", async () => {
		let calls = 0;
		await orchestrator.dispatchParallel(process.cwd(), "run", task(),
			{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, 0, {
				recordEvent: () => {}, aliasTable: table, failover: quiet,
				runProcess: async () => { calls++; return proc({ exitCode: 1, outcome: "failed", stderr: "TypeError: boom" }); },
			});
		expect(calls).toBe(1);
	});

	test("profile candidates drive the order; spend cap key and offset carry across attempts", async () => {
		const seen: Array<{ model: string; key?: string; offset?: number; taskId?: string }> = [];
		const cand = (model: string, source: "primary" | "backup") => ({ model, spec: model, source, qualified: true, reasons: [], effortControl: true });
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", task(),
			{ security_review: { model: "amazon-bedrock/global.openai.gpt-6-astra" } }, {} as never, 0, {
				recordEvent: () => {}, aliasTable: table, failover: quiet,
				candidates: { security_review: [cand("amazon-bedrock/global.openai.gpt-6-astra", "primary"), cand("openai-codex/gpt-6-astra", "backup")] },
				runProcess: async (opts) => {
					seen.push({ model: opts.model, key: opts.spendCapKey, offset: opts.spendOffsetUsd, taskId: opts.taskId });
					return seen.length === 1
						? proc({ exitCode: 1, outcome: "failed", stderr: "[provider error] Service unavailable: Bedrock is unable to process your request.", costUsd: 0.25 })
						: proc({ model: "openai-codex/gpt-6-astra" });
				},
			});
		expect(seen).toEqual([
			{ model: "amazon-bedrock/global.openai.gpt-6-astra", key: "run-sec", offset: 0, taskId: "run-sec" },
			{ model: "openai-codex/gpt-6-astra", key: "run-sec", offset: 0.25, taskId: "run-sec~a2" },
		]);
		expect(result.costUsd).toBeCloseTo(0.26);
	});
});

describe("failover plumbing", () => {
	test("cancellableSleep ends early on cancel", async () => {
		const c = new RunCancellation();
		const t0 = Date.now();
		const p = orchestrator.cancellableSleep(60_000, c);
		c.cancel();
		await p;
		expect(Date.now() - t0).toBeLessThan(1000);
	});
	test("loadModelFacts: missing file is empty, bad JSON is a problem", () => {
		const dir = mkdtempSync(join(tmpdir(), "facts-"));
		expect(orchestrator.loadModelFacts(join(dir, "none.json"))).toEqual({ facts: {}, problems: [] });
		writeFileSync(join(dir, "bad.json"), "{");
		expect(orchestrator.loadModelFacts(join(dir, "bad.json")).problems.length).toBe(1);
		writeFileSync(join(dir, "ok.json"), JSON.stringify({ version: 1, models: { "a/b": { context: 5 } } }));
		expect(orchestrator.loadModelFacts(join(dir, "ok.json")).facts).toEqual({ "a/b": { context: 5 } });
	});
	test("diagnosticName sanitises like the event log names", () => {
		expect(orchestrator.diagnosticName("run-lead-0~a2")).toBe("run-lead-0_a2");
	});
});
```

Add the imports the new tests need at the top of `index.test.ts`, if they're missing: `RunCancellation` from `./cancellation.ts`, and `mkdtempSync`, `writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`.

- [ ] **Step 2: Run** `(cd bridge/extensions/orchestrator && ~/.local/bin/bun test index.test.ts)`. Expected: the new and replaced tests FAIL (`failover`, `candidates`, `cancellableSleep`, `loadModelFacts` and `diagnosticName` don't exist yet).

- [ ] **Step 3: models.ts.** Extend `AvailableModel`:

```ts
export interface AvailableModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}
```

- [ ] **Step 4: index.ts imports.** Add these next to the other local imports:

```ts
import { buildCatalog, parseModelFacts, type ModelFacts } from "./model-catalog.ts";
import { ModelHealth } from "./model-health.ts";
import { backupWarnings, formatCandidateGroups, resolveCandidates, usableModels, type Candidate } from "./model-router.ts";
import { failoverConfig } from "./failover-policy.ts";
import { dispatchWithFailover, type FailoverDeps, type FailoverResult, type FailoverSwitch } from "./failover.ts";
```

Remove `isQuotaError` from the `./provider-fallback.ts` import. Remove `bedrockFallbackFor` too if nothing else in `index.ts` uses it after Step 10 (check with `rg -n bedrockFallbackFor index.ts`).

- [ ] **Step 5: Model facts and the registry.**

Replace `availableModels`' mapping with:
```ts
		return ctx.modelRegistry.getAvailable().map((m) => ({
			provider: m.provider, id: m.id, name: m.name,
			contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning,
		}));
```

Add these after `PROFILES_PATH`:
```ts
const MODEL_FACTS_PATH =
	process.env.HUMAIN_ORCHESTRATOR_MODEL_FACTS_FILE ?? join(dirname(PROFILES_PATH), "orchestrator-model-facts.json");

export function loadModelFacts(path: string = MODEL_FACTS_PATH): { facts: Record<string, ModelFacts>; problems: string[] } {
	if (!existsSync(path)) return { facts: {}, problems: [] };
	try {
		const parsed = parseModelFacts(JSON.parse(readFileSync(path, "utf-8")));
		return { facts: parsed.facts, problems: parsed.problems.map((p) => `${path}: ${p}`) };
	} catch (err) {
		return { facts: {}, problems: [`${path}: ${(err as Error).message}`] };
	}
}
```

- [ ] **Step 6: Candidates in `resolveAdapter`.** Add `candidates: Record<string, Candidate[]>;` to `interface FullResolution`. In `resolveAdapter`, keep the model list in a variable: `const models = availableModels(ctx); const table = buildAliasTable(models);`. Replace the final `return` with:

```ts
	const facts = loadModelFacts();
	const catalog = buildCatalog(models, facts.facts);
	const tierPrimaries = { ...(profile?.tiers ?? {}), ...overrides.tiers };
	const candidates: Record<string, Candidate[]> = {};
	for (const [cap, binding] of Object.entries(merged.adapter)) {
		candidates[cap] = resolveCandidates({ capability: cap, primary: binding.model, backups: profile?.backups, tierPrimaries, table, preference, catalog });
	}
	return {
		...merged,
		warnings: [...warnings, ...facts.problems, ...merged.warnings],
		profileName,
		profiles,
		table,
		preference,
		candidates,
	};
```

- [ ] **Step 7: RunSession state and the start-of-run log.** In `class RunSession`, next to `spendCaps`:

```ts
	/** Per-run model health shared by every dispatch (spec §5.3). */
	modelHealth = new ModelHealth();
	/** capability -> ordered backup candidates for this run (set at run start). */
	candidates: Record<string, Candidate[]> = {};
```

In the `/orchestrate` handler, right after `session.log(\`models (profile …`)`, add:

```ts
			session.candidates = resolved.candidates;
			session.log(`backups (✓ usable, ✗ excluded):\n${formatCandidateGroups(resolved.candidates).map((l) => `  ${l}`).join("\n")}`);
			for (const w of backupWarnings(resolved.candidates)) session.log(`warning: ${w}`);
```

- [ ] **Step 8: `runSubagentProcess`: a spend-cap key and offset, plus a shared name helper.**

Add to its `opts` type:
```ts
	/** Spend-cap identity shared by every failover attempt of one dispatch (defaults to taskId). */
	spendCapKey?: string;
	/** Cost already spent by earlier failover attempts; counted towards this dispatch's cap. */
	spendOffsetUsd?: number;
```

Add this exported helper above `runSubagentProcess`, and use it for `safeTaskId`:
```ts
export function diagnosticName(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
// in runSubagentProcess:
	const safeTaskId = diagnosticName(taskId);
```

Change **both** `session?.spendCaps.observe(taskId, …, spentSoFar())` calls to:
```ts
session?.spendCaps.observe(opts.spendCapKey ?? taskId, opts.capability ?? "unknown", spentSoFar() + (opts.spendOffsetUsd ?? 0))
```

Add `eventsPath?: string;` to `interface SubagentProcessResult`, with the doc comment "Path of this attempt's events.jsonl (set by failover callers)".

- [ ] **Step 9: Failover plumbing helpers.** Add these to `index.ts`, below `dispatchParallel`'s interfaces:

```ts
export function cancellableSleep(ms: number, cancellation?: RunCancellation): Promise<void> {
	return new Promise((resolve) => {
		let off: () => void = () => {};
		const timer = setTimeout(() => { off(); resolve(); }, ms);
		off = cancellation?.onCancel(() => { clearTimeout(timer); resolve(); }) ?? off;
	});
}

function readEventLines(path?: string): string[] {
	if (!path) return [];
	try {
		return readFileSync(path, "utf-8").split("\n");
	} catch {
		return [];
	}
}

export function failoverDepsFor(
	cwd: string,
	session: RunSession | null | undefined,
	recordEventFn: typeof recordEvent,
	override: Partial<Omit<FailoverDeps<SubagentProcessResult>, "runAttempt">> = {},
): Omit<FailoverDeps<SubagentProcessResult>, "runAttempt"> {
	return {
		readEvents: (r) => readEventLines(r.eventsPath),
		snapshot: () => ({ head: gitHead(cwd), dirty: gitDirtySnapshot(cwd) }),
		changedSince: (snap) => {
			const s = snap as { head: string | null; dirty: Map<string, string> | null };
			return s?.dirty ? changedFilesSinceRunStart(cwd, s.head, s.dirty, []).changed : [];
		},
		sleep: (ms) => cancellableSleep(ms, session?.cancellation),
		health: session?.modelHealth ?? new ModelHealth(),
		isCancelled: () => session?.cancellation.isCancelled ?? false,
		recordEvent: (event, payload) => recordEventFn(event, { run_id: session?.runId, ...payload }),
		log: (line) => session?.log(line),
		config: failoverConfig(),
		redact: redactPaths,
		effortDropped: (model) => {
			const c = Object.values(session?.candidates ?? {}).flat().find((x) => x.model === model);
			return c ? !c.effortControl : false;
		},
		...override,
	};
}

/** Build a failover `runAttempt` for one dispatch; attempt n>1 gets `<taskId>~a<n>` diagnostics. */
function attemptRunner(
	base: Omit<Parameters<typeof runSubagentProcess>[0], "model" | "task" | "taskId" | "label" | "spendCapKey" | "spendOffsetUsd">,
	taskId: string,
	label: string,
	session: RunSession | null | undefined,
	runProcess: typeof runSubagentProcess = runSubagentProcess,
): FailoverDeps<SubagentProcessResult>["runAttempt"] {
	return async (model, task, attempt, spent) => {
		const id = attempt === 1 ? taskId : `${taskId}~a${attempt}`;
		const r = await runProcess({ ...base, model, task, taskId: id, label: attempt === 1 ? label : `${label}↻${attempt - 1}`, spendCapKey: taskId, spendOffsetUsd: spent });
		return { ...r, eventsPath: session ? join(session.dir, `${diagnosticName(id)}.events.jsonl`) : undefined };
	};
}

/** One billed result for a dispatch that ran several attempts (usage and cost summed; final model). */
function combineAttempts(fo: FailoverResult<SubagentProcessResult>): SubagentProcessResult {
	const all = fo.attempts.map((a) => a.result);
	if (all.length <= 1) return fo.result;
	return {
		...fo.result,
		usage: all.slice(1).reduce((u, r) => sumUsage(u, r.usage), all[0].usage),
		costUsd: all.reduce((s, r) => s + r.costUsd, 0),
		nestedCostUsd: all.reduce((s, r) => s + (r.nestedCostUsd ?? 0), 0),
		costReported: all.every((r) => r.costReported),
		durationMs: all.reduce((s, r) => s + r.durationMs, 0),
	};
}
```

- [ ] **Step 10: `dispatchParallel`.**
  - Add to its `deps` type:
    ```ts
    		/** capability -> candidates; defaults to the active run's (tests inject). */
    		candidates?: Record<string, Candidate[]>;
    		/** Overrides for failover I/O (tests stub sleep/snapshot/readEvents). */
    		failover?: Partial<Omit<FailoverDeps<SubagentProcessResult>, "runAttempt">>;
    ```
  - Add `failovers?: FailoverSwitch[];` to `interface DispatchResult`.
  - Inside the `try` of the per-task mapper, replace everything from `const runOn = …` up to (but not including) the final `deps.recordEvent("dispatch_finished", …)` with:

```ts
			const table = deps.aliasTable === undefined ? CURRENT_ALIAS_TABLE : deps.aliasTable;
			const cap = input._capability ?? "unknown";
			// No profile candidates (tests, model-check): primary plus its codex->Bedrock twin, as before.
			const listed = (deps.candidates ?? session?.candidates)?.[cap];
			const twin = !listed && table ? bedrockFallbackFor(input.model, table) : null;
			const models = listed ? usableModels(listed, input.model) : [input.model, ...(twin ? [twin] : [])];
			const baseTaskId = input._taskId ?? `${runId}-${shortId}`;
			const fo = await dispatchWithFailover<SubagentProcessResult>(
				{ taskId: baseTaskId, capability: cap, prompt: input.task },
				models,
				{
					...failoverDepsFor(input.cwd, session, deps.recordEvent, deps.failover),
					runAttempt: attemptRunner(
						{ cwd: input.cwd, agentName: input.agent, effort: input.effort, capability: input._capability, depth, tools: input.tools, ctx },
						baseTaskId, shortId, session, deps.runProcess,
					),
				},
			);
			for (const a of fo.attempts.slice(0, -1)) {
				deps.recordEvent("dispatch_finished", {
					run_id: runId, task_id: input._taskId, capability: input._capability, model: a.result.model ?? a.model,
					exit_code: a.result.exitCode, duration_ms: a.result.durationMs, cost_usd: a.result.costUsd, turns: a.result.usage.turns,
					stop_reason: a.result.stopReason, log_dir: ACTIVE_RUN?.dir, superseded_by_fallback: true, failure_class: a.record.cls,
				});
			}
			const r = combineAttempts(fo);
```

  - In the returned object, keep `model: r.model ?? input.model` but change it to `model: r.model ?? fo.finalModel`. Then add:
    ```ts
    				...(fo.switches.length > 0 ? { failovers: fo.switches } : {}),
    ```
  - Keep `bedrockFallbackFor` imported (it's used above). `isQuotaError` stays removed.

- [ ] **Step 11: Triage.** In `triageTask`, replace the `cheapest` selection and the `runSubagentProcess` call with:

```ts
	const cheapestCap = ["implementation_fast", "worker", "scout"].find((c) => adapter[c]?.model) ?? Object.keys(adapter)[0];
	const cheapest = cheapestCap ? adapter[cheapestCap] : undefined;
	if (!cheapest || !cheapest.model) {
		console.warn("[orchestrator] triage skipped: adapter has no dispatchable model");
		return null;
	}

	const prompt = TRIAGE_PROMPT + "\n" + goal + "\n\nJSON:\n";
	try {
		const fo = await dispatchWithFailover<SubagentProcessResult>(
			{ taskId: "triage", capability: cheapestCap, prompt },
			usableModels(ACTIVE_RUN?.candidates[cheapestCap], cheapest.model),
			{
				...failoverDepsFor(cwd, ACTIVE_RUN, recordEvent),
				runAttempt: attemptRunner({ cwd, agentName: "orch-implementation-fast", ctx, capability: cheapestCap }, "triage", "triage", ACTIVE_RUN),
			},
		);
		const r = combineAttempts(fo);
```

Leave the rest of the function (`costSink.usd += r?.costUsd ?? 0;` and the parsing) unchanged.

- [ ] **Step 12: Run the full verification.** Expected: green. If an older test asserted the removed `reason: "provider_quota"` field or the `-fallback` taskId suffix, update it to the new `class: "quota"` / `~a2` form. Don't weaken any other assertion.

- [ ] **Step 13: Commit.**

```bash
git add bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/index.test.ts bridge/extensions/orchestrator/models.ts
git commit -m "feat(bridge): fail over dispatches and triage across checked backup models"
```

### Task 11: Nested-worker backups in the lead prompt, audit and summary

**Files:**
- Modify: `bridge/extensions/orchestrator/index.ts` (`modelTableForLead`, `leadPrompt`, the `dispatchReconAndLeads` call site, `dispatchParallel` result, the summary)
- Modify: `bridge/agents/orchestrator-lead.md`
- Test: `bridge/extensions/orchestrator/index.test.ts`

**Interfaces:**
- Consumes:
  - `pickBackup`, `usableModels`, `Candidate` (T5)
  - `ModelHealth` (T4)
  - `auditNestedFailover`, `formatNestedAuditLine`, `NestedAudit` (T8)
  - `formatFailoverLine` (T9)
- Produces:
  - `NESTED_FAILOVER_RULE: string`
  - `interface LeadRouting { candidates: Record<string, Candidate[]>; health: ModelHealth }`
  - `leadPrompt(…, assignment?, routing?: LeadRouting)`
  - `DispatchResult.nestedAudit?: NestedAudit`
  - `failoverSummaryLines(results: Array<Pick<DispatchResult, "failovers" | "nestedAudit">>): string[]`

- [ ] **Step 1: Write the failing tests** (append to `index.test.ts`):

```ts
describe("nested worker backups", () => {
	const cand = (model: string, source: "primary" | "backup" = "backup") => ({ model, spec: model, source, qualified: true, reasons: [], effortControl: true });
	const adapter = { worker: { model: "openai-codex/gpt-6-luna" }, scout: { model: "openai-codex/gpt-6-luna" } } as never;
	const routing = (health = new orchestratorModelHealth()) => ({
		candidates: { worker: [cand("openai-codex/gpt-6-luna", "primary"), cand("amazon-bedrock/global.openai.gpt-6-luna"), cand("humain-node/qwen3.8-27b")] },
		health,
	});
	test("model table lists a backup and the rule requires onFailure", () => {
		const p = orchestrator.leadPrompt("goal", planFixture, undefined, "", 0, 1, adapter, undefined, routing());
		expect(p).toContain('- orch-worker: model "openai-codex/gpt-6-luna"; backup "amazon-bedrock/global.openai.gpt-6-luna"');
		expect(p).toContain(orchestrator.NESTED_FAILOVER_RULE);
	});
	test("an unhealthy primary is replaced by its backup in the table", () => {
		const h = new orchestratorModelHealth(() => 0);
		h.markUnhealthy("openai-codex/gpt-6-luna", "transient", 10);
		const p = orchestrator.leadPrompt("goal", planFixture, undefined, "", 0, 1, adapter, undefined, routing(h));
		expect(p).toContain('- orch-worker: model "amazon-bedrock/global.openai.gpt-6-luna"; backup "humain-node/qwen3.8-27b"');
	});
	test("without routing the table is unchanged (no backup column)", () => {
		const p = orchestrator.leadPrompt("goal", planFixture, undefined, "", 0, 1, adapter);
		expect(p).toContain('- orch-worker: model "openai-codex/gpt-6-luna"\n');
	});
	test("summary lines: failovers and missing nested backups", () => {
		expect(orchestrator.failoverSummaryLines([{}, {}])).toEqual([]);
		expect(orchestrator.failoverSummaryLines([
			{ failovers: [{ from: "amazon-bedrock/global.anthropic.claude-fable-5-1", to: "openai-codex/gpt-6-astra", cls: "transient", reason: "503" }], nestedAudit: { missing: 1, total: 4 } },
		])).toEqual(["failovers: 1 — fable-5-1→gpt-6-astra (transient 503)", "⚠ 1/4 nested dispatches had no backup"]);
	});
});
```

At the top of `index.test.ts`, add `import { ModelHealth as orchestratorModelHealth } from "./model-health.ts";`. (`planFixture` already exists in the file; if it's declared after this block, move the block below its declaration.)

- [ ] **Step 2: Run** `bun test index.test.ts`. Expected: FAIL (`NESTED_FAILOVER_RULE` and `failoverSummaryLines` are undefined, and `leadPrompt` ignores routing).

- [ ] **Step 3: Implement the lead prompt.** Add the imports `import { auditNestedFailover, formatNestedAuditLine, type NestedAudit } from "./nested-audit.ts";`. Add `formatFailoverLine` to the `./failover.ts` import and `pickBackup` to the `./model-router.ts` import. Then:

```ts
export const NESTED_FAILOVER_RULE =
	"Backups (REQUIRED): call the subagent tool with `tasks: [...]` even for a single worker, and give every task `onFailure: { maxAttempts: 2, retryWith: { model: \"<that agent's backup below>\" } }` whenever the table lists a backup. The orchestrator audits this from your event log.";

export interface LeadRouting { candidates: Record<string, Candidate[]>; health: ModelHealth }

function modelTableForLead(adapter: Adapter, routing?: LeadRouting): string[] {
	const row = (agent: string, cap: string) => {
		const primary = adapter[cap]?.model ?? adapter.worker?.model ?? "unknown";
		if (!routing) return `- ${agent}: model "${primary}"`;
		const models = usableModels(routing.candidates[cap], primary);
		const healthy = (m: string) => routing.health.isHealthy(m);
		const current = models.find(healthy) ?? primary;
		const backup = pickBackup(models, current, healthy);
		return backup ? `- ${agent}: model "${current}"; backup "${backup}"` : `- ${agent}: model "${current}"`;
	};
	return [
		"Model routing (REQUIRED): every `subagent` call MUST pass the `model` field below for the agent it dispatches. The subagent tool does not read the agent's frontmatter; omitting `model` runs the child on your own model and breaks the cost policy.",
		...(routing ? [NESTED_FAILOVER_RULE] : []),
		row("orch-scout", "scout"),
		row("orch-worker", "worker"),
		row("orch-implementation-fast", "implementation_fast"),
		row("orch-implementation-strong", "implementation_strong"),
		row("orch-technical-lead", "technical_lead"),
		row("orch-technical-review", "technical_review"),
		row("orch-security-review", "security_review"),
		// No orch-qa-agent row: final QA is the orchestrator's own dispatch, not the lead's.
		row("orch-architect", "architect"),
	];
}
```

Add `routing?: LeadRouting` as the last parameter of `leadPrompt`, and pass it through: `modelTableForLead(adapter, routing)`. At the call site in `dispatchReconAndLeads` (`task: leadPrompt(goal, plan, architectResult, reconEvidence, i, leadCount, adapter, assignments?.[i])`), append:
`, ACTIVE_RUN ? { candidates: ACTIVE_RUN.candidates, health: ACTIVE_RUN.modelHealth } : undefined`.

- [ ] **Step 4: Nested audit on lead results.** In `dispatchParallel`, right after `const r = combineAttempts(fo);`:

```ts
			const nestedAudit = isLeadCapability(cap) ? auditNestedFailover(fo.finalScan) : undefined;
			if (nestedAudit && nestedAudit.missing > 0) {
				deps.recordEvent("nested_failover_missing", { run_id: runId, task_id: input._taskId, missing: nestedAudit.missing, total: nestedAudit.total });
			}
```

Add `nestedAudit?: NestedAudit;` to `DispatchResult`, and `...(nestedAudit ? { nestedAudit } : {}),` to the returned object.

- [ ] **Step 5: Summary lines.** Add:

```ts
export function failoverSummaryLines(results: Array<Pick<DispatchResult, "failovers" | "nestedAudit">>): string[] {
	return [formatFailoverLine(results), formatNestedAuditLine(results.map((r) => r.nestedAudit))].filter((l): l is string => Boolean(l));
}
```

In the `/orchestrate` summary array, directly after the `total cost: …` line, insert `...failoverSummaryLines(billedResults),`.

- [ ] **Step 6: Persona.** In `bridge/agents/orchestrator-lead.md`, add under the section that describes how to call `subagent`:

```markdown
- **Backups are mandatory.** Always call `subagent` with `tasks: [...]` (even for one worker) and set
  `onFailure: { maxAttempts: 2, retryWith: { model: "<backup from the model table>" } }` on every task
  whose agent has a backup in the table. The orchestrator audits this and reports missing backups.
```

- [ ] **Step 7: Run the full verification.** Expected: green.
- [ ] **Step 8: Commit.** `git add bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/index.test.ts bridge/agents/orchestrator-lead.md && git commit -m "feat(bridge): nested-worker backups in lead prompts, audit and run summary"`

### Task 12: `/orchestrator-models show` and `check` include backups

**Files:**
- Modify: `bridge/extensions/orchestrator/index.ts` (`showResolved`, `checkModels`)
- Test: `bridge/extensions/orchestrator/index.test.ts`

**Interfaces:**
- Produces: `modelsToProbe(resolved: Pick<FullResolution, "adapter"> & { candidates?: Record<string, Candidate[]> }): Map<string, string[]>` (exported)

- [ ] **Step 1: Write the failing test:**

```ts
describe("orchestrator-models backups", () => {
	test("modelsToProbe includes usable backups once, labelled", () => {
		const cand = (model: string, source: "primary" | "backup", qualified = true) => ({ model, spec: model, source, qualified, reasons: [], effortControl: true });
		const m = orchestrator.modelsToProbe({
			adapter: { lead: { model: "a/x" }, architect: { model: "a/x" } },
			candidates: { lead: [cand("a/x", "primary"), cand("b/y", "backup"), cand("c/z", "backup", false)], architect: [cand("a/x", "primary"), cand("b/y", "backup")] },
		} as never);
		expect([...m.entries()]).toEqual([["a/x", ["lead", "architect"]], ["b/y", ["lead (backup)", "architect (backup)"]]]);
	});
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (`modelsToProbe` is undefined).
- [ ] **Step 3: Implement.**

```ts
export function modelsToProbe(resolved: Pick<ResolvedAdapter, "adapter"> & { candidates?: Record<string, Candidate[]> }): Map<string, string[]> {
	const byModel = new Map<string, string[]>();
	const add = (model: string, label: string) => byModel.set(model, [...(byModel.get(model) ?? []), label]);
	for (const [cap, b] of Object.entries(resolved.adapter)) add(b.model, cap);
	for (const [cap, cands] of Object.entries(resolved.candidates ?? {})) {
		for (const c of cands) if (c.qualified && c.source !== "primary") add(c.model, `${cap} (backup)`);
	}
	return byModel;
}
```

In `checkModels`, change the parameter type to `resolved: ResolvedAdapter & { candidates?: Record<string, Candidate[]> }` and replace its `byModel` loop with `const byModel = modelsToProbe(resolved);`. In `showResolved`'s `lines`, after the `formatAdapterTable` spread, add:

```ts
					"backups (✓ usable, ✗ excluded):",
					...formatCandidateGroups(resolved.candidates).map((l) => `  ${l}`),
					...backupWarnings(resolved.candidates).map((w) => `  warning: ${w}`),
```

- [ ] **Step 4: Run the full verification.** Expected: green.
- [ ] **Step 5: Commit.** `git add bridge/extensions/orchestrator/index.ts bridge/extensions/orchestrator/index.test.ts && git commit -m "feat(bridge): /orchestrator-models shows and probes backups"`

---

## Wave 5

### Task 13: Shipped default backups and docs

**Files:**
- Modify: `bridge/orchestrator-profiles.json`
- Modify: `bridge/README.md`, `bridge/extensions/orchestrator-README.md`, `docs/superpowers/specs/2026-09-25-model-failover-design.md` (status line and the "Deviations" note)
- Test: `bridge/extensions/orchestrator/models.test.ts`

- [ ] **Step 1: Write the failing test** (append to `models.test.ts`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("shipped profiles", () => {
	test("parse cleanly and every profile ships backups for every tier", () => {
		const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "orchestrator-profiles.json"), "utf-8"));
		const { file, problems } = parseProfilesFile(raw);
		expect(problems).toEqual([]);
		for (const [name, spec] of Object.entries(file.profiles)) {
			for (const tier of ["cheap", "mid", "premium", "frontier"]) {
				expect(spec.backups?.[tier]?.length ?? 0, `${name}.${tier}`).toBeGreaterThan(0);
			}
		}
	});
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (no `backups` yet).
- [ ] **Step 3: Add `backups` to each profile** in `bridge/orchestrator-profiles.json`, keeping every existing key:

```jsonc
// premium
"backups": {
  "frontier": ["amazon-bedrock/eu.anthropic.claude-fable-5", "openai-codex/gpt-6-astra", "humain-node/claude-fable-5", "humain-node/glm-5.2"],
  "premium":  ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra", "humain-node/claude-opus-5"],
  "mid":      ["amazon-bedrock/eu.anthropic.claude-sonnet-5", "openai-codex/gpt-6-sol", "humain-node/claude-sonnet-5", "humain-node/kimi-k3"],
  "cheap":    ["amazon-bedrock/global.openai.gpt-6-luna", "humain-node/qwen3.8-27b"],
  "security_review": ["amazon-bedrock/global.openai.gpt-6-astra", "amazon-bedrock/eu.anthropic.claude-opus-5-5"]
}
// anthropic
"backups": {
  "frontier": ["amazon-bedrock/eu.anthropic.claude-fable-5", "humain-node/claude-fable-5"],
  "premium":  ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "humain-node/claude-opus-5"],
  "mid":      ["amazon-bedrock/eu.anthropic.claude-sonnet-5", "humain-node/claude-sonnet-5"],
  "cheap":    ["amazon-bedrock/eu.anthropic.claude-sonnet-5", "humain-node/claude-sonnet-5"]
}
// openai
"backups": {
  "frontier": ["amazon-bedrock/global.openai.gpt-6-astra"],
  "premium":  ["amazon-bedrock/global.openai.gpt-6-sol", "openai-codex/gpt-6-astra"],
  "mid":      ["amazon-bedrock/global.openai.gpt-6-sol"],
  "cheap":    ["amazon-bedrock/global.openai.gpt-6-luna"]
}
// oss
"backups": {
  "frontier": ["humain-node/kimi-k3", "humain-node/grok-4.5"],
  "premium":  ["humain-node/kimi-k3", "humain-node/grok-4.5"],
  "mid":      ["humain-node/kimi-k3", "humain-node/glm-5.2"],
  "cheap":    ["humain-node/nemotron-super-3-120b", "humain-node/minimax-m3"]
}
```

(Real JSON, no comments.)

- [ ] **Step 4: Docs.**
  - In `bridge/README.md` and `bridge/extensions/orchestrator-README.md`, add a "Backup models and failover" section. It should cover: the `backups` key; `rules.model_requirements`; `orchestrator-model-facts.json` (path, format, and the fact that `HUMAIN_ORCHESTRATOR_MODEL_FACTS_FILE` overrides it); the error classes; the 10-minute unhealthy window and the 15-minute wait limit; the `failovers:` and `⚠ nested` summary lines; and the fact that a user's existing `~/.humain-terminal/agent/orchestrator-profiles.json` doesn't get `backups` automatically (copy the block from the shipped file).
  - In the spec, set `Status: implemented (feat/model-failover)`, and add one paragraph pointing to this plan's "Deviations from the spec".
- [ ] **Step 5: Run the full verification.** Expected: green.
- [ ] **Step 6: Commit.** `git add bridge/orchestrator-profiles.json bridge/README.md bridge/extensions/orchestrator-README.md bridge/extensions/orchestrator/models.test.ts docs/superpowers/specs/2026-09-25-model-failover-design.md && git commit -m "feat(profiles): ship default backups; document failover"`

### Task 14: Final verification, merge to main, push

Dispatch this to an **implementation** worker. Leads have no write access, and a merge is a write.

- [ ] **Step 1: Full verification in the worktree.** Run all three commands from Global Constraints. All must be green. Also run `git status --porcelain`; it must be empty.
- [ ] **Step 2: Coverage check against the spec.** `rg -n "dispatchWithFailover|resolveCandidates|auditNestedFailover|failoverSummaryLines|modelsToProbe" bridge/extensions/orchestrator/index.ts` must show every one of them in use.
- [ ] **Step 3: Check the main checkout is clean.** `MAIN=/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator; git -C "$MAIN" status --porcelain` must be empty. If it isn't, **stop** and report BLOCKED with that output. Never stash or discard someone else's changes.
- [ ] **Step 4: Merge.** `git -C "$MAIN" merge --no-ff feat/model-failover -m "Merge feat/model-failover: model backups and provider failover"`.
  - If there are conflicts, resolve them only where the resolution is mechanical and clear: import lists, and neighbouring additions in the same file where both sides must be kept.
  - Otherwise run `git -C "$MAIN" merge --abort` and report BLOCKED, listing the conflicting files and hunks.
- [ ] **Step 5: Verify on main.** Run the three verification commands from Global Constraints with `cd "$MAIN"`. On failure, fix it in a new commit on main, re-verify, and never push red.
- [ ] **Step 6: Push.** `git -C "$MAIN" push origin main`.
- [ ] **Step 7: Report.** Include the merge commit hash, the test counts (pytest / bun / tsc), and a reminder for the user to `/reload` HUMAIN Terminal and copy the `backups` block into `~/.humain-terminal/agent/orchestrator-profiles.json`. Keep the worktree (don't remove it) until the user confirms.

import { basename } from "node:path";

import { describe, expect, mock, test } from "bun:test";

// Mirrors the real bridge/agents/ personas the dispatcher resolves by name: a
// write-capable implementer, and the read-only scout Rule-2 recon binds to.
// orch-scout carries a non-empty body so the --append-system-prompt path (and
// its temp-file cleanup) is exercised rather than skipped.
mock.module("@humain/terminal", () => ({
	discoverAgents: () => ({ agents: [
		{ name: "orch-implementation-fast", tools: ["read", "write", "edit", "bash"], systemPrompt: "" },
		{ name: "orch-scout", tools: ["read", "grep", "find", "ls", "bash"], systemPrompt: "scout persona" },
	] }),
	renderTaskWithContext: (task: string) => task,
}));

const { dispatchParallel, agentNameFor } = await import("./parallel.ts");
const { runSubagentProcess } = await import("./child-process.ts");
const { planReconTasks } = await import("../recon.ts");
const { METHOD, TIER_CAPABILITIES, buildAliasTable } = await import("../models.ts");

describe("recon tool boundary", () => {
	test("carries read-only tools and the configured model from planned recon to subprocess creation", async () => {
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon,
			complexity: 5, taskClass: "implementation", goal: "repair flow", runId: "run" });
		const invocations: string[][] = [];
		// depth 0, then the injected deps: `dispatchParallel` takes both since the
		// progress-view nesting depth and the test seam landed independently.
		await dispatchParallel(process.cwd(), "run", tasks,
			{ scout: { model: "provider/recon-model", effort: "low" } }, {} as never, null, 0, {
			recordEvent: async () => {},
			maxConcurrentDispatches: 5,
			runProcess: (opts) => runSubagentProcess({
				...opts,
				env: () => process.env,
				spawnChild: (_command, args) => {
					invocations.push([...args]);
					throw new Error("test: stop at subprocess creation");
				},
			}),
		});
		expect(invocations).toHaveLength(3);
		for (const args of invocations) {
			expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
			expect(args[args.indexOf("--provider") + 1]).toBe("provider");
			expect(args[args.indexOf("--model") + 1]).toBe("recon-model");
		}
	});

	// method.json binds recon to the `scout` capability so the dispatch lands on
	// the purpose-built read-only `orch-scout` persona rather than an
	// implementer persona that merely happens to be tool-restricted.
	test("runs recon under the orch-scout persona at the cheap tier", () => {
		const policy = METHOD.rules.pre_implementation_recon;
		expect(policy.worker_capability).toBe("scout");
		expect(TIER_CAPABILITIES.cheap).toContain(policy.worker_capability);
	});

	test("passes the orch-scout persona prompt to the recon subprocess", async () => {
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon,
			complexity: 5, taskClass: "implementation", goal: "repair flow", runId: "run" });
		const personas: string[] = [];
		await dispatchParallel(process.cwd(), "run", tasks,
			{ scout: { model: "provider/recon-model", effort: "low" } }, {} as never, null, 0, {
			recordEvent: async () => {},
			maxConcurrentDispatches: 5,
			runProcess: (opts) => runSubagentProcess({
				...opts,
				env: () => process.env,
				spawnChild: (_command, args) => {
					const list = [...args];
					const at = list.indexOf("--append-system-prompt");
					personas.push(at === -1 ? "(none)" : basename(String(list[at + 1])));
					throw new Error("test: stop at subprocess creation");
				},
			}),
		});
		expect(personas).toEqual(["orch-scout.md", "orch-scout.md", "orch-scout.md"]);
	});
});

describe("codex -> Bedrock quota fallback (Phase A)", () => {
	const table = buildAliasTable([
		{ provider: "openai-codex", id: "gpt-6-astra" },
		{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
		{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
	]);
	const proc = (over: Partial<Awaited<ReturnType<typeof runSubagentProcess>>>) => ({
		exitCode: 0, stdout: "ok", finalText: "ok", rawStdout: "", personaCanMutate: false, stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
		costUsd: 0.01, costReported: true, durationMs: 5, outcome: "completed" as const, processExitCode: 0, ...over,
	});
	const task = (_model: string) => [{ capability: "security_review", task: "review", taskId: "run-sec" }];

	test("quota failure on codex retries once on the Bedrock twin and records route_degraded", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const models: string[] = [];
		const [result] = await dispatchParallel(process.cwd(), "run", task(""),
			{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, null, 0, {
				recordEvent: (e, p) => { events.push([e, p]); },
				aliasTable: table,
				maxConcurrentDispatches: 5,
				runProcess: async (opts) => {
					models.push(opts.model);
					return models.length === 1
						? proc({ exitCode: 1, stderr: "usage limit reached for this account", costUsd: 0, costReported: true,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } })
						: proc({ model: "amazon-bedrock/global.openai.gpt-6-astra" });
				},
			});
		expect(models).toEqual(["openai-codex/gpt-6-astra", "amazon-bedrock/global.openai.gpt-6-astra"]);
		expect(result.exitCode).toBe(0);
		expect(result.model).toBe("amazon-bedrock/global.openai.gpt-6-astra");
		expect(result.taskId).toBe("run-sec");
		const degraded = events.filter(([e]) => e === "route_degraded");
		expect(degraded).toHaveLength(1);
		expect(degraded[0][1]).toMatchObject({ from_model: "openai-codex/gpt-6-astra", to_model: "amazon-bedrock/global.openai.gpt-6-astra", reason: "provider_quota" });
	});

	test("no Bedrock twin: the original failure is returned, no redispatch", async () => {
		let calls = 0;
		const events: string[] = [];
		const [result] = await dispatchParallel(process.cwd(), "run", task(""),
			{ security_review: { model: "openai-codex/gpt-5.3-codex-spark" } }, {} as never, null, 0, {
				recordEvent: (e) => { events.push(e); },
				aliasTable: table,
				maxConcurrentDispatches: 5,
				runProcess: async () => { calls++; return proc({ exitCode: 1, stderr: "429 Too Many Requests" }); },
			});
		expect(calls).toBe(1);
		expect(result.exitCode).toBe(1);
		expect(events).not.toContain("route_degraded");
	});

	test("non-quota failure is not retried", async () => {
		let calls = 0;
		await dispatchParallel(process.cwd(), "run", task(""),
			{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, null, 0, {
				recordEvent: () => {}, aliasTable: table,
				maxConcurrentDispatches: 5,
				runProcess: async () => { calls++; return proc({ exitCode: 1, stderr: "TypeError: boom" }); },
			});
		expect(calls).toBe(1);
	});
});

describe("review fixes (Phase A review)", () => {
	test("every lead size runs the orchestrator-lead persona with the lead timeout policy", async () => {
		const { ORCHESTRATING_CAPABILITIES, resolveDispatchTimeoutPolicy } = await import("../dispatch-progress.ts");
		for (const cap of ["lead_small", "lead", "lead_large"]) {
			expect(agentNameFor(cap)).toBe("orchestrator-lead");
			expect(ORCHESTRATING_CAPABILITIES.has(cap)).toBe(true);
			expect(resolveDispatchTimeoutPolicy(cap, {}).mode).toBe("lead");
		}
		expect(agentNameFor("scout")).toBe("orch-scout");
	});

	test("re-review escalation picks a model from a capability that belongs to the target tier", async () => {
		// oss-like: `lead` (premium capability) overridden to a mid model must not
		// become the premium escalation target; premium-like: security_review
		// overridden to another vendor is not preferred for technical re-review.
		const { pickModel } = await import("../core/routing.ts");
		const adapter = {
			technical_review: { model: "humain-node/kimi-k3" },
			implementation_strong: { model: "humain-node/minimax-m3" },
			lead: { model: "humain-node/minimax-m3" },
			analysis_strong: { model: "humain-node/glm-5.2" },
			architect: { model: "humain-node/glm-5.2" },
			security_review: { model: "openai-codex/gpt-6-astra" },
			lead_large: { model: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
		};
		const picked = pickModel("technical_review", adapter, 1, "medium");
		expect(picked).toBe("humain-node/glm-5.2");
	});

	test("quota fallback is not attempted for a timed-out or cancelled dispatch, or for quota words only in the model's prose", async () => {
		const table = buildAliasTable([
			{ provider: "openai-codex", id: "gpt-6-astra" },
			{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
		]);
		const base = {
			exitCode: 124, stdout: "", finalText: "", rawStdout: "", personaCanMutate: false, stderr: "usage limit reached",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			costUsd: 0, costReported: false, durationMs: 1, processExitCode: 124,
		};
		for (const over of [
			{ outcome: "timed_out" as const },
			{ outcome: "cancelled" as const, exitCode: 137 },
			{ outcome: "failed" as const, exitCode: 125, stopReason: "spend_cap" },
			{ outcome: "failed" as const, exitCode: 1, stderr: "exit 1", finalText: "the API returned 429 rate limit earlier" },
		]) {
			let calls = 0;
			await dispatchParallel(process.cwd(), "run", [{ capability: "security_review", task: "t", taskId: "run-sec" }],
				{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, null, 0, {
					recordEvent: () => {}, aliasTable: table,
					maxConcurrentDispatches: 5,
					runProcess: async () => { calls++; return { ...base, ...over }; },
				});
			expect(calls).toBe(1);
		}
	});
});

describe("capability persona overrides", () => {
	test("method.json capability_personas matches the formerly hard-coded CAPABILITY_AGENT_ALIASES in index.ts", () => {
		// Snapshot of the static overrides that used to live in index.ts before they
		// moved into method.json's capability_personas (B1 step 5). The lead-size
		// overrides (lead_small/lead/lead_large -> orchestrator-lead) are excluded
		// here because they were already derived from rules.lead_sizing.sizes.
		expect(METHOD.capability_personas).toEqual({
			analysis_mid: "orch-technical-lead",
			analysis_strong: "orch-architect",
			integration_review: "orch-technical-review",
			migration_review: "orch-technical-review",
			performance_review: "orch-technical-review",
			api_contract_review: "orch-technical-review",
		});
	});

	test("agentNameFor still resolves every previously-aliased capability", () => {
		expect(agentNameFor("analysis_mid")).toBe("orch-technical-lead");
		expect(agentNameFor("analysis_strong")).toBe("orch-architect");
		expect(agentNameFor("integration_review")).toBe("orch-technical-review");
		expect(agentNameFor("migration_review")).toBe("orch-technical-review");
		expect(agentNameFor("performance_review")).toBe("orch-technical-review");
		expect(agentNameFor("api_contract_review")).toBe("orch-technical-review");
		expect(agentNameFor("implementation_strong")).toBe("orch-implementation-strong");
	});
});

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

const { dispatchParallel } = await import("./parallel.ts");
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

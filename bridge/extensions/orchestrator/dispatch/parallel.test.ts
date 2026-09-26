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
const { METHOD, TIER_CAPABILITIES } = await import("../models.ts");

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

import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { planReconTasks } from "./recon.ts";
import { METHOD, TIER_CAPABILITIES } from "./models.ts";
import type { DispatchResult, DispatchTask } from "./index.ts";
import { RunCancellation } from "./cancellation.ts";

mock.module("@humain/terminal", () => ({
	BorderedLoader: class {
		onAbort?: () => void;
		constructor(..._args: unknown[]) {}
	},
	// Mirrors the real bridge/agents/ personas the dispatcher resolves by name:
	// a write-capable implementer, and the read-only scout Rule-2 recon binds to.
	// orch-scout carries a non-empty body so the --append-system-prompt path (and
	// its temp-file cleanup) is exercised rather than skipped.
	discoverAgents: () => ({ agents: [
		{ name: "orch-implementation-fast", tools: ["read", "write", "edit", "bash"], systemPrompt: "" },
		{ name: "orch-scout", tools: ["read", "grep", "find", "ls", "bash"], systemPrompt: "scout persona" },
	] }),
	renderTaskWithContext: (task: string) => task,
}));

const testStateRoot = mkdtempSync(join(tmpdir(), "orch-run-session-test-"));
process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT = testStateRoot;
const orchestrator = await import("./index.ts");
afterAll(() => {
	rmSync(testStateRoot, { recursive: true, force: true });
});

describe("/orchestrate argument parsing", () => {
	test("runs without confirmation unless interactive mode is explicitly requested", () => {
		expect(orchestrator.parseArgs).toBeFunction();
		const parsed = orchestrator.parseArgs!("repair the login race");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(false);
	});

	test("enables confirmation gates when --interactive is supplied", () => {
		expect(orchestrator.parseArgs).toBeFunction();
		const parsed = orchestrator.parseArgs!("repair the login race --interactive");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(true);
		expect(parsed.unknownFlags).toEqual([]);
	});

	test("normalises --complexity onto the integer 1-10 scale Rule-2 bands use", () => {
		const parse = orchestrator.parseArgs!;
		expect(parse("repair flow --complexity 6.5").complexity).toBe(7);
		expect(parse("repair flow --complexity 12").complexity).toBe(10);
		expect(parse("repair flow --complexity 0").complexity).toBe(1);
		expect(parse("repair flow --complexity abc").complexity).toBe(5);
		// Previously 6.5 matched no workers_by_complexity band and planned zero recon.
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon, complexity: parse("repair flow --complexity 6.5").complexity,
			taskClass: "implementation", goal: "repair flow", runId: "run" });
		expect(tasks.length).toBe(4);
	});

	test("clampComplexity treats absent or non-numeric triage values as the fallback, not the minimum", () => {
		const clamp = orchestrator.clampComplexity;
		for (const absent of [undefined, null, "", "  ", true, false, [], [7], {}, "abc", Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(clamp(absent)).toBe(5);
		}
		expect(clamp(7)).toBe(7);
		expect(clamp("7")).toBe(7);
		expect(clamp(-3)).toBe(1);
		expect(clamp(12)).toBe(10);
		expect(clamp(6.5)).toBe(7);
	});
});

describe("RunSession cancellation presentation", () => {
	test("keeps the cancelled goal and stopped dispatch visible after cleanup", () => {
		const widgets: unknown[] = [];
		const statuses: unknown[] = [];
		const ctx = {
			ui: {
				setWidget: (_id: string, value: unknown) => widgets.push(value),
				setStatus: (_id: string, value: unknown) => statuses.push(value),
				notify: mock(),
			},
		};
		const session = new orchestrator.RunSession!("cancel-ui-test", ctx as never, "update the payments page");
		session.startDispatch("lead-1", "lead", "provider/model");
		session.cancel();
		session.endDispatch("lead-1", 137, 0);
		session.close(true);

		const finalWidget = widgets.at(-1) as string[];
		expect(finalWidget).toContain("Goal: update the payments page");
		expect(finalWidget.some((line) => line.includes("lead") && line.includes("cancelled by user"))).toBe(true);
		expect(statuses.at(-1)).toContain("cancelled");
	});
});

describe("recon tool boundary", () => {
	test("carries read-only tools and the configured model from planned recon to subprocess creation", async () => {
		expect(orchestrator.dispatchParallel).toBeFunction();
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon,
			complexity: 5, taskClass: "implementation", goal: "repair flow", runId: "run" });
		const invocations: string[][] = [];
		await orchestrator.dispatchParallel(process.cwd(), "run", tasks,
			{ scout: { model: "provider/recon-model", effort: "low" } }, {} as never, {
			recordEvent: async () => {},
			runProcess: (opts) => orchestrator.runSubagentProcess(opts, (_command, args) => {
				invocations.push([...(args ?? [])]);
				throw new Error("test: stop at subprocess creation");
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
		await orchestrator.dispatchParallel(process.cwd(), "run", tasks,
			{ scout: { model: "provider/recon-model", effort: "low" } }, {} as never, {
			recordEvent: async () => {},
			runProcess: (opts) => orchestrator.runSubagentProcess(opts, (_command, args) => {
				const list = [...(args ?? [])];
				const at = list.indexOf("--append-system-prompt");
				personas.push(at === -1 ? "(none)" : basename(String(list[at + 1])));
				throw new Error("test: stop at subprocess creation");
			}),
		});
		expect(personas).toEqual(["orch-scout.md", "orch-scout.md", "orch-scout.md"]);
	});
});

// The Rule-2 fan-out is parent-owned and billed. If the lead persona also told
// leads to dispatch their own `orch-scout` recon, every qualifying run would pay
// for recon twice and the second round would be invisible to the bridge's worker
// accounting. Guard the instruction, not just the code.
describe("lead persona recon contract", () => {
	const raw = readFileSync(
		join(import.meta.dir, "..", "..", "agents", "orchestrator-lead.md"),
		"utf-8",
	);
	// Match on prose, not formatting: `**not**` must not be able to slip a
	// prohibition past these assertions.
	const leadPersona = raw.replace(/\*/g, "");

	test("does not instruct leads to dispatch their own recon scouts", () => {
		expect(leadPersona).not.toMatch(/dispatch\s+3[–-]5\s+`?orch-scout/i);
		expect(leadPersona).toMatch(/do not dispatch your own `orch-scout`/i);
	});

	test("tells leads recon evidence arrives from the parent", () => {
		expect(leadPersona).toMatch(/parent-owned/i);
		expect(leadPersona).toMatch(/Recon evidence/);
	});
});

const planFixture: Parameters<typeof orchestrator.leadPrompt>[1] = {
		plan_id: "plan-1",
		run_id: "run-1",
		task_class: "implementation",
		complexity: 6,
		risk: "medium",
		topology: { depth: 2, leads: 1, workers: 3, shape: "lead-workers" },
		route: {
			selected: { capability: "lead", effort: "standard", verification_depth: "targeted" },
			recommended: { capability: "lead", effort: "standard", verification_depth: "targeted" },
			mode: "adaptive",
			history_sufficient: true,
			explanation: {},
		},
		effective_quality_floor: 0.8,
		cost_aggressiveness: 0.5,
	};
const adapterFixture: Parameters<typeof orchestrator.leadPrompt>[6] = {
	lead: { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
};

describe("leadPrompt recon evidence handoff", () => {

	test("adds completed recon evidence to the lead prompt", () => {
		const prompt = orchestrator.leadPrompt(
			"repair flow",
			planFixture,
			undefined,
			"### run-recon-0\naffected: src/a.ts",
			0,
			1,
			adapterFixture,
		);
		expect(prompt).toContain("Recon evidence");
		expect(prompt).toContain("affected: src/a.ts");
		expect(prompt).toContain("Do not repeat broad repository discovery");
	});

	test("states no parent-owned recon was required when evidence is empty", () => {
		expect(orchestrator.leadPrompt).toBeFunction();
		const prompt = orchestrator.leadPrompt!(
			"repair flow",
			planFixture,
			undefined,
			"",
			0,
			1,
			adapterFixture,
		);
		expect(prompt).toContain("Recon evidence");
		expect(prompt).toContain("none");
	});

	test("tells the lead nested subagent fan-out is not authoritative worker accounting", () => {
		const prompt = orchestrator.leadPrompt(
			"repair flow",
			planFixture,
			undefined,
			"### run-recon-0\naffected: src/a.ts",
			0,
			1,
			adapterFixture,
		);
		expect(prompt).not.toContain("workers fan out inside each lead");
		expect(prompt).toContain("not authoritative worker accounting");
	});
});

function dispatchResult(task: DispatchTask, exitCode = 0): DispatchResult {
	return {
		taskId: task.taskId, capability: task.capability, model: "provider/model", exitCode,
		stdout: exitCode === 0 ? `evidence for ${task.taskId}` : "",
		stderr: exitCode === 0 ? "" : "Error: unavailable",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
		durationMs: 1, costUsd: 0.01, filesChanged: [],
	};
}

const reconLeadInput = { runId: "run", goal: "repair flow", plan: planFixture, adapter: adapterFixture };

/**
 * Explicit deadline for tests that await a rejection: a regression that stops
 * honouring cancellation must fail fast with a named reason, not hang the
 * whole suite until an external killer intervenes.
 */
function withDeadline<T>(promise: Promise<T>, ms = 2_000, label = "operation"): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`test deadline: ${label} did not settle within ${ms}ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Capture a promise's rejection without `expect(p).rejects`: on this Bun
 * version that matcher spins the event loop synchronously while `p` is still
 * pending, so a test that settles `p` later (e.g. resolving recon after
 * cancelling) never gets to run and the whole suite hangs.
 */
async function rejectionOf(promise: Promise<unknown>, ms = 2_000, label = "operation"): Promise<Error> {
	try {
		await withDeadline(promise, ms, label);
	} catch (err) {
		return err as Error;
	}
	throw new Error(`${label} resolved but was expected to reject`);
}

describe("parent-owned recon dispatch seam", () => {
	test("a run cancelled before recon dispatches nothing and bills nothing", async () => {
		const cancellation = new RunCancellation();
		cancellation.cancel();
		const dispatched: string[] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		const run = orchestrator.dispatchReconAndLeads(reconLeadInput, {
			dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
			capture: async (r) => { billed.push(r); },
			setPhase: (phase) => { phases.push(phase); },
			throwIfCancelled: () => cancellation.throwIfCancelled(),
		});
		expect((await rejectionOf(run, 2_000, "pre-cancelled run")).message).toBe("Orchestration cancelled");
		expect(dispatched).toEqual([]);
		expect(billed).toEqual([]);
		expect(phases).toEqual([]);
	});

	test.each(["recon", "billing"])("cancellation during %s bills finished recon but never starts or announces leads", async (cancelDuring) => {
		const cancellation = new RunCancellation();
		const events: string[] = [];
		const phases: string[] = [];
		const billed: DispatchResult[] = [];
		let checks = 0;
		let finishRecon!: (results: DispatchResult[]) => void;
		const pendingRecon = new Promise<DispatchResult[]>((resolve) => { finishRecon = resolve; });
		let workers: DispatchResult[] = [];
		const run = orchestrator.dispatchReconAndLeads(reconLeadInput, {
			dispatch: async (tasks) => {
				for (const task of tasks) events.push(`dispatch_started:${task.taskId}`);
				if (tasks[0].capability === "lead") return tasks.map((task) => dispatchResult(task));
				workers = tasks.map((task) => dispatchResult(task, 137));
				return pendingRecon;
			},
			capture: async (r) => {
				billed.push(r);
				if (cancelDuring === "billing") cancellation.cancel();
			},
			setPhase: (phase) => { phases.push(phase); },
			throwIfCancelled: () => { checks++; cancellation.throwIfCancelled(); },
		});
		if (cancelDuring === "recon") cancellation.cancel();
		const rejection = rejectionOf(run, 2_000, `cancel during ${cancelDuring}`);
		finishRecon(workers);
		expect((await rejection).message).toBe("Orchestration cancelled");
		expect(checks).toBeGreaterThan(0);
		// Every finished recon worker is billed exactly once, even though the run
		// was cancelled while they ran / while they were being billed.
		expect(billed).toEqual(workers);
		expect(events).toEqual(["dispatch_started:run-recon-0", "dispatch_started:run-recon-1", "dispatch_started:run-recon-2"]);
		expect(phases.some((phase) => phase.includes("lead"))).toBe(false);
	});

	test("cancellation after leads finish still bills every lead exactly once, then rejects", async () => {
		const cancellation = new RunCancellation();
		const billed: DispatchResult[] = [];
		let leadTasks: DispatchTask[] = [];
		const run = orchestrator.dispatchReconAndLeads({ ...reconLeadInput,
			plan: { ...planFixture, topology: { ...planFixture.topology, leads: 2 } },
		}, {
			dispatch: async (tasks) => {
				if (tasks[0].capability === "lead") leadTasks = tasks;
				return tasks.map((task) => dispatchResult(task));
			},
			capture: async (r) => {
				billed.push(r);
				// Cancel while the FIRST lead is being billed; the second must still be billed.
				if (r.taskId === "run-lead-0") cancellation.cancel();
			},
			setPhase: () => {},
			throwIfCancelled: () => cancellation.throwIfCancelled(),
		});
		expect((await rejectionOf(run, 2_000, "cancel during lead billing")).message).toBe("Orchestration cancelled");
		expect(leadTasks.map((t) => t.taskId)).toEqual(["run-lead-0", "run-lead-1"]);
		expect(billed.map((r) => r.taskId)).toEqual(["run-recon-0", "run-recon-1", "run-recon-2", "run-lead-0", "run-lead-1"]);
		expect(new Set(billed.map((r) => r.taskId)).size).toBe(billed.length);
	});

	test("awaits recon and its billing before dispatching every lead, returning original worker results", async () => {
		expect(orchestrator.dispatchReconAndLeads).toBeFunction();
		const batches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		let finishRecon!: (results: DispatchResult[]) => void;
		const pendingRecon = new Promise<DispatchResult[]>((resolve) => { finishRecon = resolve; });
		const run = orchestrator.dispatchReconAndLeads({ ...reconLeadInput,
			plan: { ...planFixture, topology: { ...planFixture.topology, leads: 2 } },
		}, {
			dispatch: async (tasks) => {
				batches.push(tasks);
				if (tasks[0].capability !== "lead") return pendingRecon;
				expect(billed.map((r) => r.taskId)).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
				return tasks.map((task) => dispatchResult(task));
			},
			capture: async (result) => { billed.push(result); },
			setPhase: (phase) => { phases.push(phase); },
			throwIfCancelled: () => {},
		});
		expect(batches).toHaveLength(1);
		expect(batches[0].map((t) => t.taskId)).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
		expect(phases.some((p) => p.includes("lead"))).toBe(false);
		const workers = batches[0].map((task) => dispatchResult(task));
		finishRecon(workers);
		const result = await run;
		expect(result.workerResults).toBe(workers);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0", "run-lead-1"]);
		expect(batches).toHaveLength(2);
		for (const lead of batches[1]) {
			for (const worker of workers) expect(lead.task).toContain(worker.stdout);
		}
		expect(billed).toEqual([...workers, ...result.leadResults]);
		expect(billed.reduce((sum, r) => sum + r.costUsd, 0)).toBeCloseTo(0.05);
	});

	test.each([
		["investigation", 8], ["qa_verification", 8], ["implementation", 4],
	] as const)("skips recon for %s at complexity %i without billing phantom workers", async (taskClass, complexity) => {
		expect(orchestrator.dispatchReconAndLeads).toBeFunction();
		const batches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		const result = await orchestrator.dispatchReconAndLeads({ ...reconLeadInput,
			plan: { ...planFixture, task_class: taskClass, complexity },
		}, {
			dispatch: async (tasks) => { batches.push(tasks); return tasks.map((task) => dispatchResult(task)); },
			capture: async (r) => { billed.push(r); },
			setPhase: (phase) => { phases.push(phase); }, throwIfCancelled: () => {},
		});
		expect(batches.map((tasks) => tasks.map((t) => t.taskId))).toEqual([["run-lead-0"]]);
		expect(result.workerResults).toEqual([]);
		expect(billed).toEqual(result.leadResults);
		expect(phases[0]).toContain("no parent-owned recon required");
		expect(phases[0]).toContain(
			complexity < METHOD.rules.pre_implementation_recon.min_complexity
				? `complexity ${complexity} is below the Rule-2 threshold`
				: `task class "${taskClass}" is exempt`,
		);
		if (complexity >= METHOD.rules.pre_implementation_recon.min_complexity) expect(phases[0]).not.toContain("below");
		expect(phases.join("\n")).not.toContain("0/0");
	});

	test.each([false, true])("keeps failed workers visible and billed (allFailed=%s)", async (allFailed) => {
		expect(orchestrator.dispatchReconAndLeads).toBeFunction();
		const billed: DispatchResult[] = [];
		let leadTask = "";
		const result = await orchestrator.dispatchReconAndLeads(reconLeadInput, {
			dispatch: async (tasks) => {
				if (tasks[0].capability === "lead") {
					leadTask = tasks[0].task;
					return tasks.map((task) => dispatchResult(task));
				}
				return tasks.map((task, index) => dispatchResult(task, allFailed || index > 0 ? 1 : 0));
			},
			capture: async (r) => { billed.push(r); }, setPhase: () => {}, throwIfCancelled: () => {},
		});
		expect(result.workerResults).toHaveLength(3);
		expect(billed).toEqual([...result.workerResults, ...result.leadResults]);
		for (const worker of result.workerResults) {
			expect(leadTask).toContain(worker.taskId);
			if (worker.exitCode !== 0) expect(leadTask).toContain(`${worker.taskId} unavailable`);
		}
		if (allFailed) {
			expect(leadTask).toContain("DEGRADED");
			expect(leadTask).toContain("no verified recon evidence");
		} else {
			expect(leadTask).toContain("evidence for run-recon-0");
			expect(leadTask).not.toContain("DEGRADED");
		}
	});
});

describe("final accounting", () => {
	const architect = { ...dispatchResult({ taskId: "run-architect", capability: "architect", task: "" }), costUsd: 0.2 };
	const worker = { ...dispatchResult({ taskId: "run-recon-0", capability: "scout", task: "" }), costUsd: 0.02 };
	const lead = { ...dispatchResult({ taskId: "run-lead-0", capability: "lead", task: "" }), costUsd: 0.2 };

	test("includes parent-owned worker results in billed dispatches exactly once", () => {
		const billed = orchestrator.collectBilledResults({
			architectResult: architect, workerResults: [worker], leadResults: [lead],
			verificationResults: [], escalationResults: [],
		});
		expect(billed).toEqual([architect, worker, lead]);
		expect(billed.reduce((total, result) => total + result.costUsd, 0)).toBeCloseTo(0.42);
		expect(new Set(billed.map((r) => r.taskId)).size).toBe(billed.length);
	});

	test("omits the architect when none ran and keeps lifecycle order", () => {
		const qa = { ...dispatchResult({ taskId: "run-qa-0", capability: "qa_agent", task: "" }) };
		const esc = { ...dispatchResult({ taskId: "run-esc-0", capability: "implementation_strong", task: "" }) };
		const billed = orchestrator.collectBilledResults({
			workerResults: [worker], leadResults: [lead], verificationResults: [qa], escalationResults: [esc],
		});
		expect(billed.map((r) => r.taskId)).toEqual(["run-recon-0", "run-lead-0", "run-qa-0", "run-esc-0"]);
	});

	test("summarizes recon workers with counts, cost, and summarized failure diagnostics", () => {
		const failed = {
			...dispatchResult({ taskId: "run-recon-1", capability: "scout", task: "" }, 1),
			stderr: `${"noise\n".repeat(50)}Error: provider unavailable\n    at stack frame\n`,
			costUsd: 0.01,
		};
		const line = orchestrator.summarizeReconWorkers([worker, failed]);
		expect(line).toContain("recon workers: 1/2 completed · $0.0300");
		expect(line).toContain("run-recon-1 exit 1");
		expect(line).toContain("provider unavailable");
		expect(line).not.toContain("noise\nnoise");
		expect(line.length).toBeLessThan(400);
	});

	test("states that no recon workers were required when none ran", () => {
		expect(orchestrator.summarizeReconWorkers([])).toBe("recon workers: none (not required for this task)");
	});
});

describe("confirmation gates", () => {
	test.each([false, true])("dispatch call passes separate confirmation arguments (interactive=%s)", async (interactive) => {
		// Execute the actual call expression after the plan summary, not a copy of it.
		// This isolates argument construction without planning or dispatching agents.
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const afterSummary = source.slice(source.indexOf("session.log(planSummary.join"));
		const call = afterSummary.match(/confirmStep\([\s\S]*?\n\s*\)/)?.[0];
		if (!call) throw new Error("Dispatch confirmation call not found after plan summary");
		const invoke = new Function("ctx", "pipeline", "parsed", "DISPATCH_TIMEOUT_MS", "confirmStep", `return ${call};`);
		const confirm = mock(() => Promise.resolve(false));
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };
		const confirmStep = mock(orchestrator.confirmStep);

		const result = await invoke(ctx, "lead → workers → qa", { interactive }, 120000, confirmStep);

		expect(confirmStep).toHaveBeenCalledWith(
			ctx,
			"Dispatch this plan?",
			"lead → workers → qa\n\nEach stage runs headless (up to 2 min per dispatch); live progress shows above the editor.",
			interactive,
		);
		expect(result).toBe(!interactive);
		if (interactive) {
			expect(confirm).toHaveBeenCalledWith(
				"Dispatch this plan?",
				"lead → workers → qa\n\nEach stage runs headless (up to 2 min per dispatch); live progress shows above the editor.",
			);
		} else {
			expect(confirm).not.toHaveBeenCalled();
		}
	});

	test("auto-confirms when interactive confirmation is not requested", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const confirm = mock(() => false);
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", false)).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	test("opens the confirmation dialog in interactive mode", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const confirm = mock(() => Promise.resolve(false));
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(confirm).toHaveBeenCalledWith("Dispatch?", "details");
	});

	test("aborts an interactive confirmation request without a UI", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const notify = mock();
		const ctx = { hasUI: false, ui: { confirm: mock(), notify } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"Dispatch?: no UI to confirm — remove --interactive to run automatically",
			"error",
		);
	});
});

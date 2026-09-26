import { describe, expect, test } from "bun:test";
import { dispatchReconAndLeads, isTransientLeadFailure, collectBilledResults, summarizeReconWorkers } from "./hierarchy.ts";
import { RunCancellation } from "../cancellation.ts";
import { METHOD } from "../models.ts";
import { architectPrompt, leadPrompt, QA_SCOPE_RULES } from "../core/prompts.ts";
import { runCompletionOutcomeFor } from "../core/records.ts";
import type { DispatchResult } from "../core/records.ts";
import type { DispatchTask, PlanResponse } from "../core/prompts.ts";

/**
 * C3 ("resume a lead after a transient provider failure instead of
 * discarding it", docs/architecture-review.md): a lead that exits because of
 * a transient provider error, and not a bad result/blocked status/
 * cancellation, is re-dispatched exactly once with a `## Resume` prompt.
 * Tests exercise `dispatchReconAndLeads` directly with injected `effects`
 * fakes, the same pattern `index.test.ts`'s "parent-owned recon dispatch
 * seam" describe block already uses for this function — no global
 * `child_process` mock.
 */

const plan: PlanResponse = {
	plan_id: "plan-1",
	run_id: "run",
	task_class: "implementation",
	complexity: 3, // below the Rule-2 recon threshold: no recon tasks, one lead dispatch batch to observe
	risk: "medium",
	topology: { depth: 1, leads: 1, workers: 0, shape: "flat" },
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

const adapter = { lead: { model: "provider/model" } };

function baseInput() {
	return {
		runId: "run",
		goal: "repair flow",
		plan,
		adapter,
		evidenceMaxChars: 4000,
		maxLeads: 4,
		repoRoot: "/repo",
	};
}

function dispatchResult(task: DispatchTask, exitCode = 0): DispatchResult {
	return {
		taskId: task.taskId, capability: task.capability, model: "provider/model", exitCode,
		stdout: exitCode === 0 ? `evidence for ${task.taskId}` : "",
		stderr: exitCode === 0 ? "" : "Error: unavailable",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
		durationMs: 1, costUsd: 0.01, costReported: true, filesChanged: [],
	};
}

function transientFailure(task: DispatchTask, opts: Partial<DispatchResult> = {}): DispatchResult {
	return {
		taskId: task.taskId, capability: task.capability, model: "provider/model", exitCode: 1,
		stdout: "", stderr: "Service unavailable: Bedrock is unable to process your request.",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
		durationMs: 1, costUsd: 0.01, costReported: true, filesChanged: [], outcome: "failed",
		...opts,
	};
}

describe("pipeline/hierarchy.ts dispatchReconAndLeads lead resume after a transient provider failure (C3)", () => {
	test("(a) transient failure once then success: exactly 2 lead dispatches; resume prompt carries the last report and changed files; run succeeds", async () => {
		const leadBatches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];
		let leadCall = 0;

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				leadCall++;
				if (leadCall === 1) return [transientFailure(tasks[0], { stdout: "partial progress: did step 1" })];
				return tasks.map((t) => dispatchResult(t));
			},
			capture: async (r) => { billed.push(r); },
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => ["src/a.ts", "src/b.ts"],
		});

		expect(leadBatches).toHaveLength(2);
		expect(leadBatches[1][0].taskId).toBe("run-lead-0");
		expect(leadBatches[1][0].task).toContain("## Resume");
		expect(leadBatches[1][0].task).toContain("partial progress: did step 1");
		expect(leadBatches[1][0].task).toContain("- src/a.ts");
		expect(leadBatches[1][0].task).toContain("- src/b.ts");
		expect(leadBatches[1][0].task).toContain("continue");

		expect(result.leadResults).toHaveLength(1);
		expect(result.leadResults[0].exitCode).toBe(0);
		expect(result.resumedLeadTaskIds).toEqual(["run-lead-0"]);

		// (f) Both attempts are billed exactly once each.
		expect(billed.filter((r) => r.taskId === "run-lead-0")).toHaveLength(2);
	});

	test("(b) transient failure twice: exactly 2 lead dispatches total (no third); the lead result stays failed", async () => {
		const leadBatches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				return [transientFailure(tasks[0])];
			},
			capture: async (r) => { billed.push(r); },
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => [],
		});

		expect(leadBatches).toHaveLength(2);
		expect(result.leadResults).toHaveLength(1);
		expect(result.leadResults[0].exitCode).toBe(1);
		expect(result.resumedLeadTaskIds).toEqual(["run-lead-0"]);
		expect(billed.filter((r) => r.taskId === "run-lead-0")).toHaveLength(2);
	});

	test("(c) non-transient failure (lead reports FAIL): no resume, exactly 1 lead dispatch", async () => {
		const leadBatches: DispatchTask[][] = [];

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				return [{
					taskId: tasks[0].taskId, capability: tasks[0].capability, model: "provider/model", exitCode: 1,
					stdout: "## Result\n\nFAIL: the implementation does not compile.\n\nSTATUS: blocked",
					stderr: "exit 1",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
					durationMs: 1, costUsd: 0.01, costReported: true, filesChanged: [],
				}];
			},
			capture: async () => {},
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => [],
		});

		expect(leadBatches).toHaveLength(1);
		expect(result.resumedLeadTaskIds).toEqual([]);
	});

	test("(d) quota error: no resume", async () => {
		const leadBatches: DispatchTask[][] = [];

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				return [transientFailure(tasks[0], { stderr: "usage limit reached for this billing period" })];
			},
			capture: async () => {},
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => [],
		});

		expect(leadBatches).toHaveLength(1);
		expect(result.resumedLeadTaskIds).toEqual([]);
	});

	test("blocked status (STATUS: blocked): no resume even with transient-looking stderr", async () => {
		const leadBatches: DispatchTask[][] = [];

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				return [transientFailure(tasks[0], { stdout: "STATUS: blocked" })];
			},
			capture: async () => {},
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => [],
		});

		expect(leadBatches).toHaveLength(1);
		expect(result.resumedLeadTaskIds).toEqual([]);
	});

	test("cancelled dispatch: no resume even with transient-looking stderr", async () => {
		const leadBatches: DispatchTask[][] = [];

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				return [transientFailure(tasks[0], { outcome: "cancelled" })];
			},
			capture: async () => {},
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => [],
		});

		expect(leadBatches).toHaveLength(1);
		expect(result.resumedLeadTaskIds).toEqual([]);
	});

	test("markFiles/filesChangedSince omitted (an older caller): resume still happens, falling back to the failed attempt's own filesChanged", async () => {
		const leadBatches: DispatchTask[][] = [];
		let leadCall = 0;

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				leadCall++;
				if (leadCall === 1) return [transientFailure(tasks[0], { filesChanged: ["src/c.ts"] })];
				return tasks.map((t) => dispatchResult(t));
			},
			capture: async () => {},
			setPhase: () => {},
			throwIfCancelled: () => {},
		});

		expect(leadBatches).toHaveLength(2);
		expect(leadBatches[1][0].task).toContain("- src/c.ts");
		expect(result.resumedLeadTaskIds).toEqual(["run-lead-0"]);
	});

	test("dispatch's own timeout (outcome: timed_out) with transient-looking stderr: no resume, exactly 1 lead dispatch", async () => {
		const leadBatches: DispatchTask[][] = [];

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				return [transientFailure(tasks[0], { outcome: "timed_out", timeoutReason: "inactivity" })];
			},
			capture: async () => {},
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => [],
		});

		expect(leadBatches).toHaveLength(1);
		expect(result.resumedLeadTaskIds).toEqual([]);
	});

	test("spend-cap stop (stopReason: spend_cap) with transient-looking stderr: no resume, exactly 1 lead dispatch", async () => {
		const leadBatches: DispatchTask[][] = [];

		const result = await dispatchReconAndLeads(baseInput(), {
			dispatch: async (tasks) => {
				leadBatches.push(tasks);
				return [transientFailure(tasks[0], { stopReason: "spend_cap" })];
			},
			capture: async () => {},
			setPhase: () => {},
			throwIfCancelled: () => {},
			markFiles: () => "mark",
			filesChangedSince: () => [],
		});

		expect(leadBatches).toHaveLength(1);
		expect(result.resumedLeadTaskIds).toEqual([]);
	});
});

describe("pipeline/hierarchy.ts isTransientLeadFailure (docs/architecture-review.md C3)", () => {
	function baseResult(opts: Partial<DispatchResult> = {}): DispatchResult {
		return {
			taskId: "t", capability: "lead", model: "provider/model", exitCode: 1,
			stdout: "", stderr: "Service unavailable: Bedrock is unable to process your request.",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
			durationMs: 1, costUsd: 0.01, costReported: true, filesChanged: [], outcome: "failed",
			...opts,
		};
	}

	test("a genuinely transient failure is resumable", () => {
		expect(isTransientLeadFailure(baseResult())).toBe(true);
	});

	test("outcome: timed_out is never resumed, even with transient-looking stderr", () => {
		expect(isTransientLeadFailure(baseResult({ outcome: "timed_out" }))).toBe(false);
	});

	test("stopReason: spend_cap is never resumed, even with transient-looking stderr", () => {
		expect(isTransientLeadFailure(baseResult({ stopReason: "spend_cap" }))).toBe(false);
	});

	test("a clean exit (exitCode 0) is never resumed", () => {
		expect(isTransientLeadFailure(baseResult({ exitCode: 0 }))).toBe(false);
	});

	test("a cancelled dispatch is never resumed", () => {
		expect(isTransientLeadFailure(baseResult({ outcome: "cancelled" }))).toBe(false);
	});

	test("STATUS: blocked is never resumed", () => {
		expect(isTransientLeadFailure(baseResult({ stdout: "STATUS: blocked" }))).toBe(false);
	});

	test("stdout mentioning timeout/503 does not make a non-transient failure resumable (docs/architecture-review.md C3): only stderr/stopReason/timeoutReason are inspected, never stdout", () => {
		expect(
			isTransientLeadFailure(
				baseResult({
					stdout: "## Completed\n\nfixed the timeout test, HTTP 503 handling\n\nSTATUS: partial",
					stderr: "TypeError: cannot read properties of undefined (reading 'foo')",
				}),
			),
		).toBe(false);
	});
});

/** Two independent leads, as the architect must now declare them (one wave). */
const twoIndependentLeads = {
	taskId: "run-architect", capability: "architect", model: "m", exitCode: 0, stderr: "",
	stdout: "## Lead assignments\nLead 1: backend (depends on: none)\nLead 2: frontend (depends on: none)\n",
	usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
} as DispatchResult;

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

/** Distinct from the C3 `plan` fixture above: complexity 6 clears the Rule-2 recon
 *  threshold, so a bare `dispatchReconAndLeads` call plans 3 recon workers before leads. */
const reconLeadPlan: PlanResponse = {
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
function reconLeadInput() {
	return { runId: "run", goal: "repair flow", plan: reconLeadPlan, adapter, evidenceMaxChars: 4000, maxLeads: 4, repoRoot: "/repo" };
}

describe("parent-owned recon dispatch seam", () => {
	test("a run cancelled before recon dispatches nothing and bills nothing", async () => {
		const cancellation = new RunCancellation();
		cancellation.cancel();
		const dispatched: string[] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		const run = dispatchReconAndLeads(reconLeadInput(), {
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
		const run = dispatchReconAndLeads(reconLeadInput(), {
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
		const run = dispatchReconAndLeads({ ...reconLeadInput(),
			plan: { ...reconLeadPlan, topology: { ...reconLeadPlan.topology, leads: 2 } },
			architectResult: twoIndependentLeads,
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
		expect(dispatchReconAndLeads).toBeFunction();
		const batches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		let finishRecon!: (results: DispatchResult[]) => void;
		const pendingRecon = new Promise<DispatchResult[]>((resolve) => { finishRecon = resolve; });
		const run = dispatchReconAndLeads({ ...reconLeadInput(),
			plan: { ...reconLeadPlan, topology: { ...reconLeadPlan.topology, leads: 2 } },
			architectResult: twoIndependentLeads,
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
		expect(dispatchReconAndLeads).toBeFunction();
		const batches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		const result = await dispatchReconAndLeads({ ...reconLeadInput(),
			plan: { ...reconLeadPlan, task_class: taskClass, complexity },
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
		expect(dispatchReconAndLeads).toBeFunction();
		const billed: DispatchResult[] = [];
		let leadTask = "";
		const result = await dispatchReconAndLeads(reconLeadInput(), {
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
		const billed = collectBilledResults({
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
		const billed = collectBilledResults({
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
		const line = summarizeReconWorkers([worker, failed]);
		expect(line).toContain("recon workers: 1/2 completed · $0.0300");
		expect(line).toContain("run-recon-1 exit 1");
		expect(line).toContain("provider unavailable");
		expect(line).not.toContain("noise\nnoise");
		expect(line.length).toBeLessThan(400);
	});

	test("states that no recon workers were required when none ran", () => {
		expect(summarizeReconWorkers([])).toBe("recon workers: none (not required for this task)");
	});
});



describe("orchestrator fixes from run ht-orch-1790237987755-lyjkn8 (A8)", () => {
	const threeLeadPlan = { ...reconLeadPlan, complexity: 8, topology: { depth: 3, leads: 3, workers: 0, shape: "multi_lead" } };
	const architect = (text: string) => ({
		taskId: "r-architect", capability: "architect", model: "m", exitCode: 0, stdout: text, stderr: "",
		usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
	} as DispatchResult);
	const run = async (architectText: string, statusFor: (taskId: string) => string) => {
		const batches: string[][] = [];
		const phases: string[] = [];
		const { leadResults, skippedLeads } = await dispatchReconAndLeads(
			{ runId: "r", goal: "g", plan: { ...threeLeadPlan, task_class: "investigation" }, adapter: { lead: { model: "p/opus-5-5" } }, architectResult: architect(architectText),
				evidenceMaxChars: 4000, maxLeads: 4, repoRoot: "/repo" },
			{
				dispatch: async (tasks) => {
					batches.push(tasks.map((t) => t.taskId));
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "m", exitCode: 0, stdout: `report\nSTATUS: ${statusFor(t.taskId)}`,
						stderr: "", usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
					} as DispatchResult));
				},
				capture: async () => {}, setPhase: (p) => phases.push(p), throwIfCancelled: () => {},
			},
		);
		return { batches, phases, leadResults, skipped: skippedLeads };
	};
	const chain = "## Lead assignments\nLead 1: phase 0 (depends on: none)\nLead 2: A1-A3 (depends on: 1)\nLead 3: A4-A7 (depends on: 2)\n";

	test("dependent leads run in sequential waves, each with its scope", async () => {
		const { batches, leadResults } = await run(chain, () => "completed");
		expect(batches).toEqual([["r-lead-0"], ["r-lead-1"], ["r-lead-2"]]);
		expect(leadResults).toHaveLength(3);
	});

	test("a blocked lead stops the leads that depend on it", async () => {
		const { batches, phases, leadResults } = await run(chain, (id) => (id === "r-lead-0" ? "blocked" : "completed"));
		expect(batches).toEqual([["r-lead-0"]]);
		expect(leadResults).toHaveLength(1);
		expect(phases.join("\n")).toContain("not starting lead(s) 2");
		expect((await run(chain, (id) => (id === "r-lead-0" ? "blocked" : "completed"))).skipped).toBe(2);
	});

	test("no valid Lead assignments collapses to a single lead instead of N clones", async () => {
		const { batches, phases } = await run("## Tasks\n1. do it", () => "completed");
		expect(batches).toEqual([["r-lead-0"]]);
		expect(phases.join("\n")).toContain("running a single lead");
	});

	test("architect is asked for Lead assignments only when there are several leads", () => {
		expect(architectPrompt("g", threeLeadPlan)).toContain("## Lead assignments");
		expect(architectPrompt("g", reconLeadPlan)).not.toContain("## Lead assignments");
	});

	test("lead prompt carries the assigned scope and its dependencies", () => {
		const p = leadPrompt("g", threeLeadPlan, undefined, "", 1, 3, adapter, "/repo", { index: 1, scope: "A1-A3", dependsOn: [0] });
		expect(p).toContain("Your scope (from the architect's Lead assignments): A1-A3");
		expect(p).toContain("Leads 1 ran before you");
	});

	test("a blocked run is recorded as blocked, not fail or verified", () => {
		expect(runCompletionOutcomeFor("r", { blocked: true, verification_passed: false }).outcome).toBe("blocked");
		expect(runCompletionOutcomeFor("r", { verification_passed: false }).outcome).toBe("fail");
		expect(runCompletionOutcomeFor("r", { verification_passed: true }).outcome).toBe("verified");
	});

	test("QA is told to stay in scope and not debug the environment", () => {
		expect(QA_SCOPE_RULES.join(" ")).toContain("verify ONLY the files listed above");
		expect(QA_SCOPE_RULES.join(" ")).toContain("after 2 attempts");
	});
});

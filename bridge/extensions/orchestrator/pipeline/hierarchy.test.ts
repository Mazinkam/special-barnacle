import { describe, expect, test } from "bun:test";
import { dispatchReconAndLeads, isTransientLeadFailure } from "./hierarchy.ts";
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

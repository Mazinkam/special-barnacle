import { describe, expect, test } from "bun:test";
import { effectiveLeadCount, formatTaskPrompt, type PlanResponse } from "./prompts.ts";

function plan(leads: number): PlanResponse {
	return {
		plan_id: "p1",
		run_id: "r1",
		task_class: "implementation",
		complexity: 5,
		risk: "medium",
		topology: { depth: 1, leads, workers: 0, shape: "single" },
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
}

describe("core/prompts.ts effectiveLeadCount", () => {
	test("clamps to the given maxLeads ceiling, defaulting to 8", () => {
		expect(effectiveLeadCount(plan(20))).toBe(8);
		expect(effectiveLeadCount(plan(20), 4)).toBe(4);
	});

	test("non-finite lead counts fall back to 1", () => {
		expect(effectiveLeadCount(plan(Number.NaN))).toBe(1);
	});
});

describe("core/prompts.ts formatTaskPrompt", () => {
	test("includes the retry note only on a retry", () => {
		const base = formatTaskPrompt({ taskId: "t1", capability: "worker", task: "do it" }, "run-1");
		expect(base).not.toContain("Retry context");
		const retry = formatTaskPrompt({ taskId: "t1", capability: "worker", task: "do it", retryOf: "t0", retryCount: 1 }, "run-1");
		expect(retry).toContain("Retry context: this is retry #2");
	});

	test("appends operator messages when present", () => {
		const withMsg = formatTaskPrompt({ taskId: "t1", capability: "worker", task: "do it" }, "run-1", ["stop early"]);
		expect(withMsg).toContain("stop early");
		expect(withMsg).toContain("User messages while this run was in progress");
	});
});

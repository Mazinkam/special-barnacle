import { describe, expect, test } from "bun:test";
import { NestedCostTracker } from "./nested-cost.ts";

const update = (toolCallId: string, results: unknown[]) => ({ type: "tool_execution_update", toolName: "subagent", toolCallId, partialResult: { details: { results } } });
const end = (toolCallId: string, results: unknown[]) => ({ type: "tool_execution_end", toolName: "subagent", toolCallId, result: { details: { results } } });

describe("NestedCostTracker", () => {
	test("cumulative update snapshots are not double-counted; the end result wins", () => {
		const t = new NestedCostTracker();
		expect(t.observe(update("c1", [{ taskId: "a", usage: { cost: 0.04 } }]))).toBe(true);
		expect(t.observe(update("c1", [{ taskId: "a", usage: { cost: 7.8 } }]))).toBe(true);
		expect(t.observe(update("c1", [{ taskId: "a", usage: { cost: 7.8 } }]))).toBe(false);
		t.observe(end("c1", [{ taskId: "a", usage: { cost: 10.14 } }]));
		expect(t.total()).toBeCloseTo(10.14);
	});

	test("sums across calls and across parallel results in one call", () => {
		const t = new NestedCostTracker();
		t.observe(end("c1", [{ taskId: "impl", usage: { cost: 10.14 } }]));
		t.observe(end("c2", [{ taskId: "r1", usage: { cost: 0 } }, { taskId: "r2", usage: { cost: 0.63 } }]));
		t.observe(end("c3", [{ usage: { cost: 1.97 } }]));
		expect(t.total()).toBeCloseTo(12.74);
	});

	test("ignores other tools, missing details and invalid costs", () => {
		const t = new NestedCostTracker();
		expect(t.observe({ type: "tool_execution_end", toolName: "bash", toolCallId: "x", result: { details: { results: [{ usage: { cost: 5 } }] } } })).toBe(false);
		expect(t.observe({ type: "tool_execution_end", toolName: "subagent", toolCallId: "y", result: { content: [] } })).toBe(false);
		expect(t.observe(end("z", [{ usage: { cost: Number.NaN } }, { usage: { cost: -1 } }, { usage: {} }]))).toBe(false);
		expect(t.total()).toBe(0);
	});
});

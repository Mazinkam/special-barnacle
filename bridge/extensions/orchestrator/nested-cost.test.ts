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

describe("NestedCostTracker.entries() (Phase 1 item 2 detail rows)", () => {
	test("duplicate delivery of the same attempt collapses to one entry", () => {
		const t = new NestedCostTracker();
		t.observe(update("c1", [{ taskId: "impl-0", attempt: 0, agent: "orch-implementation-strong", usage: { cost: 1.2 } }]));
		t.observe(update("c1", [{ taskId: "impl-0", attempt: 0, agent: "orch-implementation-strong", usage: { cost: 1.2 } }]));
		expect(t.entries()).toHaveLength(1);
		expect(t.entries()[0].usage.cost).toBe(1.2);
	});

	test("a new attempt on the same taskId is a distinct entry, not a collapse", () => {
		const t = new NestedCostTracker();
		t.observe(end("c1", [{ taskId: "impl-0", attempt: 0, usage: { cost: 0.5 }, exitCode: 1 }]));
		t.observe(end("c1", [{ taskId: "impl-0", attempt: 1, usage: { cost: 0.7 }, exitCode: 0 }]));
		expect(t.entries()).toHaveLength(2);
		expect(t.total()).toBeCloseTo(1.2);
	});

	test("a later update lacking a valid cost preserves the earlier reported cost (Phase 1 review T5)", () => {
		const t = new NestedCostTracker();
		t.observe(update("c1", [{ taskId: "impl-0", attempt: 0, agent: "orch-implementation-strong", usage: { cost: 4.19 } }]));
		// A final `tool_execution_end` whose own usage lacks a cost (crash/partial report) must not
		// erase the 4.19 already reported by an earlier update for the SAME key.
		const changed = t.observe(end("c1", [{ taskId: "impl-0", attempt: 0, agent: "orch-implementation-strong", usage: {}, exitCode: 1 }]));
		expect(changed).toBe(false);
		expect(t.entries()).toHaveLength(1);
		expect(t.entries()[0].usage.cost).toBe(4.19);
		expect(t.entries()[0].costReported).toBe(true);
		// Non-cost fields still refresh to the later observation's values.
		expect(t.entries()[0].exitCode).toBe(1);
		expect(t.total()).toBeCloseTo(4.19);
	});

	test("an invalid (NaN/negative) cost on a later update also preserves the earlier reported cost", () => {
		const t = new NestedCostTracker();
		t.observe(end("c1", [{ taskId: "impl-0", usage: { cost: 2.5 } }]));
		t.observe(update("c1", [{ taskId: "impl-0", usage: { cost: Number.NaN } }]));
		expect(t.entries()[0].usage.cost).toBe(2.5);
		t.observe(update("c1", [{ taskId: "impl-0", usage: { cost: -1 } }]));
		expect(t.entries()[0].usage.cost).toBe(2.5);
	});

	test("unreported cost stays undefined, never coerced to 0, and does not mark a change", () => {
		const t = new NestedCostTracker();
		const changed = t.observe(end("c1", [{ taskId: "impl-0", agent: "orch-scout", usage: {} }]));
		expect(changed).toBe(false);
		const [entry] = t.entries();
		expect(entry.costReported).toBe(false);
		expect(entry.usage.cost).toBeUndefined();
		expect(t.total()).toBe(0);
	});

	test("depth is carried through when the runtime reports it (grandchild-of-grandchild vantage point)", () => {
		const t = new NestedCostTracker();
		t.observe(end("c1", [{ taskId: "impl-0", depth: 2, usage: { cost: 0.3 } }]));
		expect(t.entries()[0].depth).toBe(2);
	});

	test("keeps agent/model/taskId/parentTaskId/stopReason for row-building", () => {
		const t = new NestedCostTracker();
		t.observe(end("c1", [{
			taskId: "impl-0", agent: "orch-implementation-fast", model: "provider/m",
			parentTaskId: "run-lead", stopReason: "stop", usage: { input: 3, output: 4, cost: 0.9 },
		}]));
		expect(t.entries()[0]).toMatchObject({
			taskId: "impl-0", agent: "orch-implementation-fast", model: "provider/m",
			parentTaskId: "run-lead", stopReason: "stop",
		});
	});
});

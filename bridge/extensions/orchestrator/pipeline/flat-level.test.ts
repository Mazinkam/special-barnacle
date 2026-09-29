import { describe, expect, test } from "bun:test";
import { dispatchFlat, implementerTask, runFlatVerification } from "./flat-level.ts";

const ok = (taskId: string, capability: string, stdout = "## Files Changed\n- src/a.ts\n\nSTATUS: completed") => ({
	taskId, capability, model: "p/m", exitCode: 0, stdout, stderr: "", filesChanged: ["src/a.ts"], durationMs: 1, costUsd: 0.1, costReported: true,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 1 },
});

describe("flat level", () => {
	test("implementer task carries goal, context and report contract", () => {
		const t = implementerTask("r1", "Fix src/a.ts", "CTX", "direct");
		expect(t.capability).toBe("implementation_strong");
		expect(t.task).toContain("Fix src/a.ts");
		expect(t.task).toContain("CTX");
		expect(t.task).toContain("STATUS: completed|partial|blocked");
	});

	test("dispatchFlat returns the hierarchy shape with one lead-equivalent result", async () => {
		const billed: string[] = [];
		const r = await dispatchFlat({ runId: "r1", goal: "g", providedContext: "", level: "direct" },
			{ dispatch: async (tasks) => tasks.map((t) => ok(t.taskId, t.capability)), captureDispatchCost: async (x) => { billed.push(x.taskId); } });
		expect(r.leadResults).toHaveLength(1);
		expect(r.leadTasks[0].taskId).toBe("r1-impl");
		expect(r.workerResults).toEqual([]);
		expect(billed).toEqual(["r1-impl"]);
	});

	test("direct: failing deterministic check fails verification and records run-scoped outcome", async () => {
		const outcomes: Record<string, unknown>[] = [];
		const v = await runFlatVerification({ runId: "r1", level: "direct", files: ["src/a.ts"], checks: [{ name: "test", argv: ["x"], cwd: ".", source: "p" }], repoRoot: "/r", checkTimeoutMs: 1000, goal: "g" },
			{ dispatch: async () => [], captureDispatchCost: async () => {}, recordOutcome: (o) => outcomes.push(o),
			  runChecks: async () => [{ name: "test", argv: ["x"], status: "fail", exitCode: 1, durationMs: 1, tail: "1 failed" }] });
		expect(v.passed).toBe(false);
		expect(v.failedChecks).toEqual(["test"]);
		expect(outcomes[0]).toMatchObject({ task_id: "r1-qa", verification_scope: "run", outcome: "fail", verification: false, workflow_level: "direct" });
	});

	test("checked: passing checks plus explicit FAIL review verdict fails", async () => {
		const v = await runFlatVerification({ runId: "r1", level: "checked", files: ["src/a.ts"], checks: [{ name: "test", argv: ["x"], cwd: ".", source: "p" }], repoRoot: "/r", checkTimeoutMs: 1000, goal: "g" },
			{ dispatch: async (tasks) => tasks.map((t) => ok(t.taskId, t.capability, "## Verdict\nFAIL\n- off-by-one remains")), captureDispatchCost: async () => {}, recordOutcome: () => {},
			  runChecks: async () => [{ name: "test", argv: ["x"], status: "pass", exitCode: 0, durationMs: 1, tail: "" }] });
		expect(v.passed).toBe(false);
		expect(v.failedChecks).toEqual(["review"]);
		expect(v.dispatch?.capability).toBe("technical_review");
	});

	test("no changed files is skipped (never a pass on nothing)", async () => {
		const v = await runFlatVerification({ runId: "r1", level: "direct", files: [], checks: [], repoRoot: "/r", checkTimeoutMs: 1, goal: "g" },
			{ dispatch: async () => [], captureDispatchCost: async () => {}, recordOutcome: () => {} });
		expect(v.skipped).toBe(true);
	});
});

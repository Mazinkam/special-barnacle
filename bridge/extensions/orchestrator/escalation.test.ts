import { describe, expect, test } from "bun:test";
import { FEEDBACK_TAIL_CHARS, leadsToRetry, planEscalation, type EscalationLeadInput } from "./escalation.ts";

function lead(overrides: Partial<EscalationLeadInput["task"]> = {}, resultOverrides: Partial<EscalationLeadInput["result"]> = {}): EscalationLeadInput {
	return {
		task: { taskId: "r-lead-0", capability: "lead_small", task: "Original goal: do X.\nScope: a, b.\nModel: p/sonnet-5.", ...overrides },
		result: { exitCode: 0, stdout: "REPORT: did X.\nSTATUS: completed", filesChanged: [], ...resultOverrides },
	};
}

describe("planEscalation", () => {
	test("retry task carries the original prompt verbatim, with the failed report only in a delimited feedback section", () => {
		const bigReport = "x".repeat(5000) + "END-OF-REPORT-MARKER";
		const leads = [lead({}, { stdout: bigReport })];
		const [retry] = planEscalation(["tests failed"], leads, 2, "low", 0, 2);
		expect(retry.task.startsWith(leads[0].task.task)).toBe(true);
		expect(retry.task).toContain("BEGIN failed verification feedback");
		expect(retry.task).toContain("END failed verification feedback");
		// Only the last FEEDBACK_TAIL_CHARS chars of the report appear.
		const tail = bigReport.slice(-FEEDBACK_TAIL_CHARS);
		expect(retry.task).toContain(tail);
		expect(retry.task).not.toContain(bigReport); // full untruncated report never appears
		// The report text is confined to the delimited section: everything after
		// END must not repeat the report body.
		const afterEnd = retry.task.split("END failed verification feedback")[1];
		expect(afterEnd).not.toContain("END-OF-REPORT-MARKER");
	});

	test("produces one retry task per failed lead, with distinct taskIds and retryOf", () => {
		const leads = [
			lead({ taskId: "r-lead-0" }, { exitCode: 1 }),
			lead({ taskId: "r-lead-1" }, { exitCode: 1 }),
			lead({ taskId: "r-lead-2" }, { exitCode: 1 }),
		];
		const tasks = planEscalation(["tests failed"], leads, 2, "low", 0, 2);
		expect(tasks).toHaveLength(3);
		expect(new Set(tasks.map((t) => t.taskId)).size).toBe(3);
		expect(tasks.map((t) => t.retryOf)).toEqual(["r-lead-0", "r-lead-1", "r-lead-2"]);
		expect(tasks.every((t) => t.retryCount === 1)).toBe(true);
	});

	test("stops at maxRetries, not a hard-coded 2", () => {
		const leads = [lead()];
		expect(planEscalation(["x"], leads, 2, "low", 2, 4).length).toBe(1);
		expect(planEscalation(["x"], leads, 2, "low", 3, 4).length).toBe(1);
		expect(planEscalation(["x"], leads, 2, "low", 4, 4)).toEqual([]);
		expect(planEscalation(["x"], leads, 2, "low", 2, 2)).toEqual([]); // existing default behaviour preserved
	});

	test("escalates lead size one step per retry, capped at large", () => {
		const leads = [lead({ capability: "lead_small" })];
		expect(planEscalation(["tests failed"], leads, 2, "low", 0, 2)[0].capability).toBe("lead");
		expect(planEscalation(["tests failed"], leads, 2, "low", 1, 2)[0].capability).toBe("lead_large");
		expect(planEscalation(["tests failed"], [lead({ capability: "lead_large" })], 9, "low", 0, 2)[0].capability).toBe("lead_large");
		expect(planEscalation(["tests failed"], [lead({ capability: "technical_review" })], 5, "low", 0, 2)[0].capability).toBe("technical_review");
	});

	test("high/critical risk requires at least the premium tier in the retry note", () => {
		expect(planEscalation(["x"], [lead({ capability: "lead" })], 5, "high", 0, 2)[0].task).toContain("at least the premium tier");
		expect(planEscalation(["x"], [lead({ capability: "lead" })], 5, "low", 0, 2)[0].task).toContain("at least the mid tier");
	});

	test("no failed checks or no leads -> no retries", () => {
		expect(planEscalation([], [lead()], 2, "low", 0, 2)).toEqual([]);
		expect(planEscalation(["x"], [], 2, "low", 0, 2)).toEqual([]);
	});
});

describe("leadsToRetry", () => {
	test("retries only leads whose own dispatch failed, when that's non-empty", () => {
		const leads = [
			lead({ taskId: "a" }, { exitCode: 0 }),
			lead({ taskId: "b" }, { exitCode: 1 }),
		];
		expect(leadsToRetry(leads, ["some check"]).map((l) => l.task.taskId)).toEqual(["b"]);
	});

	test("retries leads whose changed files overlap a failed check", () => {
		const leads = [
			lead({ taskId: "a" }, { exitCode: 0, filesChanged: ["src/foo.ts"] }),
			lead({ taskId: "b" }, { exitCode: 0, filesChanged: ["src/bar.ts"] }),
		];
		expect(leadsToRetry(leads, ["src/foo.ts: type error"]).map((l) => l.task.taskId)).toEqual(["a"]);
	});

	test("retries every lead when overlap is not determinable", () => {
		const leads = [
			lead({ taskId: "a" }, { exitCode: 0, filesChanged: [] }),
			lead({ taskId: "b" }, { exitCode: 0, filesChanged: [] }),
		];
		expect(leadsToRetry(leads, ["some unrelated check"]).map((l) => l.task.taskId)).toEqual(["a", "b"]);
	});

	test("union of failed-dispatch and overlap-matched leads, deduplicated", () => {
		const leads = [
			lead({ taskId: "a" }, { exitCode: 1, filesChanged: [] }),
			lead({ taskId: "b" }, { exitCode: 0, filesChanged: ["src/bar.ts"] }),
			lead({ taskId: "c" }, { exitCode: 0, filesChanged: [] }),
		];
		expect(leadsToRetry(leads, ["src/bar.ts: lint error"]).map((l) => l.task.taskId)).toEqual(["a", "b"]);
	});
});

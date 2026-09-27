import { describe, expect, test } from "bun:test";
import { attemptFailureReason, collectLeadAttempts, formatLeadAttemptLines, leadTaskIdFor } from "./lead-attempts.ts";
import type { DispatchResult } from "../core/records.ts";

const usage = { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 };

function fakeResult(overrides: Partial<DispatchResult> & { taskId: string }): DispatchResult {
	return {
		capability: "lead",
		model: "p/lead",
		exitCode: 0,
		stdout: "",
		stderr: "",
		usage,
		durationMs: 1,
		costUsd: 0,
		costReported: true,
		filesChanged: [],
		...overrides,
	};
}

describe("pipeline/lead-attempts.ts leadTaskIdFor", () => {
	test("strips a -retry-N suffix", () => {
		expect(leadTaskIdFor("run-1-lead-0-retry-1")).toBe("run-1-lead-0");
		expect(leadTaskIdFor("run-1-lead-0-retry-12")).toBe("run-1-lead-0");
	});

	test("leaves a non-retry taskId unchanged", () => {
		expect(leadTaskIdFor("run-1-lead-0")).toBe("run-1-lead-0");
	});
});

describe("pipeline/lead-attempts.ts attemptFailureReason", () => {
	test("cancelled outcome reads as cancelled", () => {
		expect(attemptFailureReason(fakeResult({ taskId: "t", exitCode: 1, outcome: "cancelled" }))).toBe("cancelled");
	});

	test("timed_out outcome reads as its timeoutReason", () => {
		expect(attemptFailureReason(fakeResult({ taskId: "t", exitCode: 1, outcome: "timed_out", timeoutReason: "inactivity" }))).toBe("inactivity");
		expect(attemptFailureReason(fakeResult({ taskId: "t", exitCode: 1, outcome: "timed_out", timeoutReason: "absolute" }))).toBe("absolute");
	});

	test("timed_out with no timeoutReason falls back to a generic label", () => {
		expect(attemptFailureReason(fakeResult({ taskId: "t", exitCode: 1, outcome: "timed_out" }))).toBe("timed out");
	});

	test("plain failure reads as exit N", () => {
		expect(attemptFailureReason(fakeResult({ taskId: "t", exitCode: 1 }))).toBe("exit 1");
	});
});

describe("pipeline/lead-attempts.ts collectLeadAttempts", () => {
	test("a lead with a single successful attempt: one attempt, succeeded", () => {
		const lead = fakeResult({ taskId: "run-1-lead-0", exitCode: 0 });
		const attempts = collectLeadAttempts([lead], [], []);
		expect(attempts).toEqual([{ leadTaskId: "run-1-lead-0", attempts: [{ label: "original", result: lead }], final: lead, succeeded: true }]);
	});

	test("a lead resumed once (C3): original (discarded) + resume (kept), final is the resume", () => {
		const discarded = fakeResult({ taskId: "run-1-lead-0", exitCode: 1, outcome: "failed", stderr: "503" });
		const resumed = fakeResult({ taskId: "run-1-lead-0", exitCode: 0, stdout: "done" });
		const attempts = collectLeadAttempts([resumed], [discarded], []);
		expect(attempts).toEqual([{
			leadTaskId: "run-1-lead-0",
			attempts: [{ label: "original", result: discarded }, { label: "resume", result: resumed }],
			final: resumed,
			succeeded: true,
		}]);
	});

	test("a lead escalated once after a failed verification: original (failed) + retry-1 (succeeded)", () => {
		const original = fakeResult({ taskId: "run-1-lead-0", exitCode: 1 });
		const retry1 = fakeResult({ taskId: "run-1-lead-0-retry-1", exitCode: 0 });
		const attempts = collectLeadAttempts([original], [], [retry1]);
		expect(attempts).toEqual([{
			leadTaskId: "run-1-lead-0",
			attempts: [{ label: "original", result: original }, { label: "retry-1", result: retry1 }],
			final: retry1,
			succeeded: true,
		}]);
	});

	test("a lead escalated twice, still failing: original + retry-1 + retry-2, all failed, in order", () => {
		const original = fakeResult({ taskId: "run-1-lead-0", exitCode: 1 });
		const retry2 = fakeResult({ taskId: "run-1-lead-0-retry-2", exitCode: 1 });
		const retry1 = fakeResult({ taskId: "run-1-lead-0-retry-1", exitCode: 1 });
		// Escalation results deliberately supplied out of chronological order — collectLeadAttempts
		// must sort them by retry number regardless of the order they were pushed in.
		const attempts = collectLeadAttempts([original], [], [retry2, retry1]);
		expect(attempts[0]!.attempts.map((a) => a.label)).toEqual(["original", "retry-1", "retry-2"]);
		expect(attempts[0]!.succeeded).toBe(false);
		expect(attempts[0]!.final).toBe(retry2);
	});

	test("multiple leads: retries/resumes are attributed to the correct lead by taskId, unaffected leads pass through untouched", () => {
		const lead0Original = fakeResult({ taskId: "run-1-lead-0", exitCode: 1 });
		const lead0Retry1 = fakeResult({ taskId: "run-1-lead-0-retry-1", exitCode: 0 });
		const lead1 = fakeResult({ taskId: "run-1-lead-1", exitCode: 0 });
		const attempts = collectLeadAttempts([lead0Original, lead1], [], [lead0Retry1]);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]!.leadTaskId).toBe("run-1-lead-0");
		expect(attempts[0]!.attempts).toHaveLength(2);
		expect(attempts[0]!.succeeded).toBe(true);
		expect(attempts[1]!.leadTaskId).toBe("run-1-lead-1");
		expect(attempts[1]!.attempts).toEqual([{ label: "original", result: lead1 }]);
		expect(attempts[1]!.succeeded).toBe(true);
	});
});

describe("pipeline/lead-attempts.ts formatLeadAttemptLines", () => {
	test("a lead that succeeded on its first (only) attempt produces no line", () => {
		const lead = fakeResult({ taskId: "run-1-lead-0", exitCode: 0 });
		const lines = formatLeadAttemptLines("run-1", collectLeadAttempts([lead], [], []));
		expect(lines).toEqual([]);
	});

	test("a lead that failed once then succeeded on retry: 'lead-0: failed (exit 1) \u2192 retry-1 succeeded'", () => {
		const original = fakeResult({ taskId: "run-1-lead-0", exitCode: 1 });
		const retry1 = fakeResult({ taskId: "run-1-lead-0-retry-1", exitCode: 0 });
		const lines = formatLeadAttemptLines("run-1", collectLeadAttempts([original], [], [retry1]));
		expect(lines).toEqual(["lead-0: failed (exit 1) \u2192 retry-1 succeeded"]);
	});

	test("a lead resumed after a transient (inactivity) timeout then succeeded: 'lead-1: failed (inactivity) \u2192 resume succeeded'", () => {
		const discarded = fakeResult({ taskId: "run-1-lead-1", exitCode: 1, outcome: "timed_out", timeoutReason: "inactivity" });
		const resumed = fakeResult({ taskId: "run-1-lead-1", exitCode: 0 });
		const lines = formatLeadAttemptLines("run-1", collectLeadAttempts([resumed], [discarded], []));
		expect(lines).toEqual(["lead-1: failed (inactivity) \u2192 resume succeeded"]);
	});

	test("A3: a lead recovered via in-wave retry (not C3's transient resume) reads as 'in-wave retry', not 'resume'", () => {
		const discarded = fakeResult({ taskId: "run-1-lead-0", exitCode: 1, outcome: "timed_out", timeoutReason: "inactivity" });
		const retried = fakeResult({ taskId: "run-1-lead-0", exitCode: 0 });
		const attempts = collectLeadAttempts([retried], [discarded], [], ["run-1-lead-0"]);
		expect(attempts[0]!.attempts).toEqual([
			{ label: "original", result: discarded },
			{ label: "in-wave retry", result: retried },
		]);
		const lines = formatLeadAttemptLines("run-1", attempts);
		expect(lines).toEqual(["lead-0: failed (inactivity) \u2192 in-wave retry succeeded"]);
	});

	test("A3: the same taskId not listed in retriedLeadTaskIds still reads as 'resume' (C3, unchanged)", () => {
		const discarded = fakeResult({ taskId: "run-1-lead-0", exitCode: 1, outcome: "failed" });
		const resumed = fakeResult({ taskId: "run-1-lead-0", exitCode: 0 });
		const attempts = collectLeadAttempts([resumed], [discarded], [], []);
		expect(attempts[0]!.attempts.map((a) => a.label)).toEqual(["original", "resume"]);
	});

	test("a lead that failed, retried, and failed again: 'lead-2: failed (exit 1) \u2192 retry-1 failed (exit 1)'", () => {
		const original = fakeResult({ taskId: "run-1-lead-2", exitCode: 1 });
		const retry1 = fakeResult({ taskId: "run-1-lead-2-retry-1", exitCode: 1 });
		const lines = formatLeadAttemptLines("run-1", collectLeadAttempts([original], [], [retry1]));
		expect(lines).toEqual(["lead-2: failed (exit 1) \u2192 retry-1 failed (exit 1)"]);
	});

	test("a lead that failed with no retry at all still gets a line (no arrow)", () => {
		const original = fakeResult({ taskId: "run-1-lead-3", exitCode: 1 });
		const lines = formatLeadAttemptLines("run-1", collectLeadAttempts([original], [], []));
		expect(lines).toEqual(["lead-3: failed (exit 1)"]);
	});

	test("multiple leads: one line per lead needing one, in lead order, run-id prefix stripped", () => {
		const lead0Original = fakeResult({ taskId: "run-1-lead-0", exitCode: 1 });
		const lead0Retry1 = fakeResult({ taskId: "run-1-lead-0-retry-1", exitCode: 0 });
		const lead1 = fakeResult({ taskId: "run-1-lead-1", exitCode: 0 });
		const lines = formatLeadAttemptLines("run-1", collectLeadAttempts([lead0Original, lead1], [], [lead0Retry1]));
		expect(lines).toEqual(["lead-0: failed (exit 1) \u2192 retry-1 succeeded"]);
	});
});

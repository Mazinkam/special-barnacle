import { describe, expect, test } from "bun:test";

import { BoundedCapture, classifyDispatchOutcome, summarizeStderr, trimEventForLog } from "./dispatch-outcome.ts";

const recoveredInput = {
	exitCode: 1,
	sawAgentSettled: true,
	sawAgentEnd: true,
	hasFinalText: true,
	lastStopReason: "stop",
	timedOut: false,
	spawnFailed: false,
	stderrSummary: "Error: teardown failed",
};

describe("classifyDispatchOutcome", () => {
	test("keeps a settled stop result when the child later exits non-zero", () => {
		expect(classifyDispatchOutcome(recoveredInput)).toEqual({
			status: "completed_after_process_error",
			effectiveExitCode: 0,
			note: "completed; process exited 1 after settle: Error: teardown failed",
		});
	});

	test("does not recover a result without agent_settled", () => {
		expect(classifyDispatchOutcome({ ...recoveredInput, sawAgentSettled: false }).status).toBe("failed");
	});

	for (const lastStopReason of ["error", "aborted", undefined]) {
		test(`does not recover a ${lastStopReason ?? "missing"} stop reason`, () => {
			expect(classifyDispatchOutcome({ ...recoveredInput, lastStopReason }).status).toBe("failed");
		});
	}

	test("marks a dispatch timeout as timed_out", () => {
		expect(classifyDispatchOutcome({ ...recoveredInput, exitCode: 124, timedOut: true })).toMatchObject({
			status: "timed_out",
			effectiveExitCode: 124,
		});
	});

	test("does not recover a spawn failure", () => {
		expect(classifyDispatchOutcome({ ...recoveredInput, spawnFailed: true }).status).toBe("failed");
	});

	test("keeps a zero exit as completed", () => {
		expect(classifyDispatchOutcome({ ...recoveredInput, exitCode: 0 })).toEqual({
			status: "completed",
			effectiveExitCode: 0,
		});
	});
});

describe("summarizeStderr", () => {
	test("extracts the error after a long bundled runtime source line", () => {
		const stderr = [
			"file:///x/chunk.js:968",
			"x".repeat(84_000),
			"^",
			"",
			"Error: This extension ctx is stale after session replacement",
			"    at applyName (file:///x/chunk.js:12:34)",
			"",
			"Node.js v26.9.0",
		].join("\n");

		expect(summarizeStderr(stderr)).toStartWith("Error: This extension ctx is stale after session replacement");
	});

	test("reports a buried diagnostic when a 64 KiB child pipe truncates bundled output", () => {
		const header = "file:///x/chunk.js:968\n";
		const stderr = header + "x".repeat(65_536 - header.length);

		const summary = summarizeStderr(stderr);
		expect(summary).toContain("diagnostic buried in 65536 bytes of bundled runtime output");
		expect(summary).toContain("[stderr truncated by child pipe]");
	});

	test("prefers the latest orchestrator marker", () => {
		expect(
			summarizeStderr("Error: ignored\n[orchestrator] dispatch timed out after 10min\nError: also ignored"),
		).toBe("[orchestrator] dispatch timed out after 10min");
	});
});

describe("BoundedCapture", () => {
	test("elides the middle while retaining the head and tail", () => {
		const capture = new BoundedCapture(4, 6);
		capture.append("ABCDEFGH");
		capture.append("IJKL");

		expect(capture.elidedBytes).toBe(2);
		expect(capture.text()).toBe("ABCD\n[orchestrator] … 2 bytes elided …\nGHIJKL");
	});

	test("keeps retained text bounded after more than 100 MiB of input", () => {
		const capture = new BoundedCapture(8 * 1024, 56 * 1024);
		const chunk = "x".repeat(1024 * 1024);
		for (let index = 0; index < 200; index++) capture.append(chunk);

		expect(capture.elidedBytes).toBeGreaterThan(100 * 1024 * 1024);
		expect(capture.text().length).toBeLessThanOrEqual(65 * 1024);
	});
});

describe("trimEventForLog", () => {
	test("removes nested worker histories while preserving tool execution metadata", () => {
		const event = {
			type: "tool_execution_update",
			partialResult: {
				details: {
					results: [{
						taskId: "worker-1",
						agent: "worker",
						model: "provider/model",
						exitCode: 0,
						usage: { input: 4, output: 2 },
						messages: [{ role: "assistant", content: "very large worker history" }],
					}],
				},
			},
		};

		expect(trimEventForLog(event)).toEqual({
			type: "tool_execution_update",
			partialResult: {
				details: {
					results: [{
						taskId: "worker-1",
						agent: "worker",
						model: "provider/model",
						exitCode: 0,
						usage: { input: 4, output: 2 },
					}],
				},
			},
		});
		expect(event.partialResult.details.results[0]).toHaveProperty("messages");
	});
});

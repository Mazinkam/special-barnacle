import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BoundedCapture,
	capChildStderrFile,
	classifyDispatchOutcome,
	MAX_CHILD_STDERR_DISK_BYTES,
	readStderrFileBounded,
	rewriteFileInPlace,
	summarizeStderr,
	trimEventForLog,
} from "./stderr-sink.ts";

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

	test("cancellation cannot recover a settled stop result", () => {
		expect(classifyDispatchOutcome({ ...recoveredInput, cancelled: true })).toEqual({
			status: "cancelled",
			effectiveExitCode: 137,
			note: "Error: teardown failed",
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

	// HT's --mode json exits 0 even when the final turn is a provider error
	// (print-mode only sets exit 1 in text mode), so the stop reason decides.
	for (const lastStopReason of ["error", "aborted"]) {
		test(`a zero exit whose final turn ended in ${lastStopReason} is a failure`, () => {
			expect(classifyDispatchOutcome({ ...recoveredInput, exitCode: 0, lastStopReason, stderrSummary: "usage limit reached" })).toEqual({
				status: "failed",
				effectiveExitCode: 1,
				note: "usage limit reached",
			});
		});
	}

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

describe("capChildStderrFile", () => {
	function writeFixture(totalBytes: number, tailMarker: string): string {
		const dir = mkdtempSync(join(tmpdir(), "orch-cap-stderr-"));
		const path = join(dir, "stderr.log");
		const headFiller = "h".repeat(Math.max(0, totalBytes - tailMarker.length));
		writeFileSync(path, headFiller + tailMarker, "utf8");
		return path;
	}

	test("leaves a file at or under the cap untouched", () => {
		const path = writeFixture(1024, "END");
		expect(capChildStderrFile(path, 4096)).toBeUndefined();
	});

	test("caps an oversized file to a head + marker + tail within the limit, preserving the tail", () => {
		const tailMarker = "HAO_STDERR_SENTINEL_7f3c at the very end";
		const path = writeFixture(200_000, tailMarker);
		const capped = capChildStderrFile(path, 8192, 1024);
		expect(capped).toBeDefined();
		expect(capped!.length).toBeLessThan(8192 + 512); // within cap + marker overhead
		expect(capped).toContain(tailMarker);
		expect(capped).toMatch(/bytes elided \(on-disk stderr exceeded the 8192-byte cap\)/);
		// The rewritten content must actually be written back to stay useful.
		rewriteFileInPlace(path, capped!);
		expect(readFileSync(path, "utf8")).toBe(capped!);
	});

	test("default cap constant is 8 MiB", () => {
		expect(MAX_CHILD_STDERR_DISK_BYTES).toBe(8 * 1024 * 1024);
	});
});

describe("readStderrFileBounded", () => {
	test("returns empty string for a missing file", () => {
		expect(readStderrFileBounded(join(tmpdir(), "orch-does-not-exist-stderr.log"))).toBe("");
	});

	test("keeps the tail of a large file within its own bound", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-read-stderr-"));
		const path = join(dir, "stderr.log");
		const tailMarker = "HAO_STDERR_SENTINEL_7f3c\n    at somewhere (file.js:1:1)\n";
		writeFileSync(path, "x".repeat(200_000) + tailMarker, "utf8");
		const text = readStderrFileBounded(path, 1024, 4096);
		expect(text).toContain(tailMarker.trim());
		expect(text.length).toBeLessThan(1024 + 4096 + 200);
	});
});

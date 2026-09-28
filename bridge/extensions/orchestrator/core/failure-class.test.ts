import { describe, expect, test } from "bun:test";
import { classifyFailure, failureReason, hadRealWork, type AttemptSignals } from "./failure-class.ts";
import {
	DispatchProgressTracker,
	renderInterruptionReport,
	type InterruptionReport,
} from "../dispatch-progress.ts";

const base: AttemptSignals = { exitCode: 1, outcome: "failed", stderr: "", toolInFlight: false, cancelled: false };
const cls = (o: Partial<AttemptSignals>) => classifyFailure({ ...base, ...o });

/**
 * Build stderr the way index.ts really does: orchestrator diagnostic lines
 * (optionally with a real provider error line ahead of them), then the
 * interruption note from renderInterruptionReport appended last as `\n${note}`.
 */
function stderrWithInterruptionReport(
	report: Partial<InterruptionReport> & { partialText: string },
	leadLines: string[] = [],
): string {
	const full: InterruptionReport = {
		taskId: "t-1",
		reason: "inactivity_timeout",
		elapsedMs: 1548924,
		sinceLastProgressMs: 1200000,
		turns: 12,
		toolCalls: 9,
		repeatedToolCalls: 2,
		lastProgress: 'bash {"command":"tail -500 /tmp/log"}',
		nestedWorkers: [],
		verified: false,
		...report,
	};
	const note = renderInterruptionReport(full);
	return [...leadLines, `[orchestrator] inactivity timeout: dispatch timed out after 20min without meaningful progress`].join("\n") + `\n${note}`;
}

describe("classifyFailure", () => {
	test.each([
		"[provider error] Service unavailable: Bedrock is unable to process your request.",
		"[provider error] The pending stream has been canceled (caused by: )",
		"[provider error] Bedrock stream ended without a stop reason",
		"[provider error] Service unavailable: Bedrock is unable to process your request.Warning: fetch failed",
		"Error: socket hang up",
		"request failed with status 502",
	])("transient: %s", (stderr) => expect(cls({ stderr })).toBe("transient"));

	test("quota wins over transient", () => {
		expect(cls({ stderr: "[provider error] 429 rate limit exceeded; 503 upstream" })).toBe("quota");
		expect(cls({ stderr: "You have hit your usage limit" })).toBe("quota");
	});
	test("the harness error message alone is enough", () => {
		expect(cls({ stderr: "", errorMessage: "Service unavailable: Bedrock is unable to process your request." })).toBe("transient");
	});
	test("inactivity while waiting on the model is a stall; while a tool runs it is a task failure", () => {
		const stderr = [
			"⚠ no meaningful progress for 15min (limit 20min; 5min remaining) — last: bash {\"command\":\"head -503 x | tail -500\"}",
			"[orchestrator] inactivity timeout: dispatch timed out after 20min without meaningful progress (last progress: bash {\"command\":\"tail -500\"} 20min ago; capability=lead_large)",
			"elapsedMs: 1548924",
			"lastProgress: bash {\"command\":\"tail -500 /tmp/log\"}",
			"partialText: Typecheck green across all 15 packages; HTTP 500 handler fixed.",
		].join("\n");
		expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: false })).toBe("stall");
		expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: true })).toBe("task");
		expect(cls({ outcome: "timed_out", timeoutReason: "absolute", stderr, toolInFlight: false })).toBe("task");
	});
	test("ok, cancelled, spend cap and ordinary errors", () => {
		expect(cls({ exitCode: 0, outcome: "completed" })).toBe("ok");
		expect(cls({ exitCode: 0, outcome: "completed_after_process_error" })).toBe("ok");
		expect(cls({ cancelled: true, stderr: "503" })).toBe("cancelled");
		expect(cls({ outcome: "cancelled" })).toBe("cancelled");
		expect(cls({ stopReason: "spend_cap", stderr: "Service unavailable" })).toBe("task");
		expect(cls({ stderr: "TypeError: x is not a function" })).toBe("task");
	});
	test("failureReason names the provider line, bounded", () => {
		expect(failureReason({ ...base, stderr: "noise\n[provider error] Service unavailable: Bedrock is unable to process your request." }))
			.toBe("[provider error] Service unavailable: Bedrock is unable to process your request.");
		expect(failureReason({ ...base, stderr: "", errorMessage: "x".repeat(500) }).length).toBe(160);
	});
	describe("the interruption report (renderInterruptionReport) never leaks into classification", () => {
		// (1) an inactivity timeout with a tool in flight, with partialText
		// spanning multiple lines whose *continuation* line reads "Service
		// unavailable", still gives "task" (not "transient") because the whole
		// report block -- including partialText's continuation lines -- is dropped.
		test("partialText continuation lines never trigger transient", () => {
			const stderr = stderrWithInterruptionReport({ partialText: "ordinary report\nService unavailable" });
			expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: true })).toBe("task");
		});

		// (2) the same report, but with no tool in flight, is a stall.
		test("the same interruption with no tool in flight is a stall", () => {
			const stderr = stderrWithInterruptionReport({ partialText: "ordinary report\nService unavailable" });
			expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: false })).toBe("stall");
		});

		// (3) a taskId that reads like an HTTP status code must not be mistaken
		// for a transient provider error.
		test("a taskId that looks like an HTTP status code does not trigger transient", () => {
			const stderr = stderrWithInterruptionReport({ taskId: "t-503", partialText: "still working" });
			expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: true })).not.toBe("transient");
		});

		// (4) a real provider error line that appears *before* the report block
		// must still be classified as transient: only the report itself, not
		// everything in stderr, is dropped.
		test("a real provider error before the report block still gives transient", () => {
			const stderr = stderrWithInterruptionReport(
				{ partialText: "still working" },
				["Error: 503 Service Unavailable"],
			);
			expect(cls({ outcome: "timed_out", timeoutReason: "inactivity", stderr, toolInFlight: true })).toBe("transient");
		});

		// (5) failureReason must never surface text from the report block, even
		// when nothing else in stderr matches a known pattern.
		test("failureReason never returns text from the report block", () => {
			const stderr = stderrWithInterruptionReport({ partialText: "ordinary report\nService unavailable" });
			const reason = failureReason({ ...base, outcome: "timed_out", timeoutReason: "inactivity", stderr });
			expect(reason).not.toContain("Service unavailable");
			expect(reason).not.toContain("UNVERIFIED PARTIAL WORK");
			expect(reason).toBe("timed out (inactivity)");
		});
	});
});

describe("real DispatchProgressTracker output never classifies as transient (regression for embedded-newline detail)", () => {
	const leadPolicy = { mode: "lead" as const, inactivityMs: 20 * 60_000, absoluteMs: 6 * 60 * 60 * 1000, notes: [] };
	const minute = 60_000;

	/**
	 * Build stderr the way index.ts really does: `\n${warning.text}` for each
	 * fired warning (per-tick loop), then `\n[orchestrator] ${reason} timeout:
	 * ${explanation}` from describeExpiry (handleExpiry).
	 */
	function driveTrackerStderr(seedEvent: unknown): { stderr: string; warningTexts: string[]; explanation: string } {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(seedEvent, 1);
		const check = tracker.check(16 * minute); // > 0.75 * 20min inactivity threshold, < 20min expiry
		const explanation = tracker.describeExpiry("inactivity", "lead", 20 * minute);
		let stderr = "";
		for (const warning of check.warnings) stderr += `\n${warning.text}`;
		stderr += `\n[orchestrator] inactivity timeout: ${explanation}`;
		return { stderr, warningTexts: check.warnings.map((w) => w.text), explanation };
	}

	test.each([
		[
			"assistant text with an embedded newline (message_end)",
			{ type: "message_end", message: { role: "assistant", content: "ordinary report\nService unavailable" } },
		],
		[
			"a bash tool arg with an embedded newline (tail)",
			{ type: "tool_execution_start", toolName: "bash", args: ["\ntail -500 /tmp/log"], toolCallId: "c-1" },
		],
		[
			"a bash tool arg with an embedded newline (head)",
			{ type: "tool_execution_start", toolName: "bash", args: ["\nhead -503 /tmp/log"], toolCallId: "c-2" },
		],
	] as const)("%s never classifies as transient", (_label, seedEvent) => {
		const { stderr, warningTexts, explanation } = driveTrackerStderr(seedEvent);
		// The regression itself: real tracker output must already be single-line.
		expect(warningTexts.length).toBeGreaterThan(0);
		expect(warningTexts.every((text) => !text.includes("\n"))).toBe(true);
		expect(explanation).not.toContain("\n");

		const signals = { ...base, outcome: "timed_out" as const, timeoutReason: "inactivity" as const, stderr };
		expect(classifyFailure({ ...signals, toolInFlight: true })).toBe("task");
		expect(classifyFailure({ ...signals, toolInFlight: false })).toBe("stall");
		expect(classifyFailure({ ...signals, toolInFlight: true })).not.toBe("transient");
		expect(classifyFailure({ ...signals, toolInFlight: false })).not.toBe("transient");

		const reason = failureReason(signals);
		expect(reason).not.toContain("Service unavailable");
		expect(reason).not.toContain("tail -500");
		expect(reason).not.toContain("head -503");
		expect(reason).toBe("timed out (inactivity)");
	});
});

describe("hadRealWork", () => {
	test("files, finished nested workers or enough tool calls", () => {
		const none = { toolCalls: 2, finishedWorkers: [] };
		expect(hadRealWork(none, [], 3)).toBe(false);
		expect(hadRealWork({ ...none, toolCalls: 3 }, [], 3)).toBe(true);
		expect(hadRealWork(none, ["a.ts"], 3)).toBe(true);
		expect(hadRealWork({ ...none, finishedWorkers: [{ id: "t", ok: true, summary: "" }] }, [], 3)).toBe(true);
	});
});

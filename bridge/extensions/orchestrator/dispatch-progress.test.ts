import { describe, expect, test } from "bun:test";

import {
	DispatchProgressTracker,
	buildInterruptionReport,
	renderInterruptionReport,
	summarizeInterruption,
	resolveDispatchTimeoutPolicy,
	resolveLeadTimeoutConfig,
	applyLeadTimeoutOverride,
} from "./dispatch-progress.ts";

const minute = 60_000;
const hour = 60 * minute;
const leadPolicy = { mode: "lead" as const, inactivityMs: 30 * minute, absoluteMs: 6 * hour, notes: [] };

function start(toolName = "bash", args: unknown = ["bun", "test"], toolCallId = "call-1") {
	return { type: "tool_execution_start", toolName, args, toolCallId };
}
function assistantText(text: string) {
	return { type: "message_end", message: { role: "assistant", content: text } };
}
function nestedResult(taskId: string, turns: number, latestText = "working", exitCode = -1) {
	return {
		taskId, agent: "worker", depth: 1, exitCode, latestText,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 100, turns },
	};
}
function nestedUpdate(...results: unknown[]) {
	return { type: "tool_execution_update", partialResult: { details: { results } } };
}

describe("resolveDispatchTimeoutPolicy", () => {
	test("uses progress-aware lead defaults and the fixed leaf default", () => {
		expect(resolveDispatchTimeoutPolicy("lead", {})).toMatchObject({ mode: "lead", inactivityMs: 20 * minute, absoluteMs: 6 * hour, notes: [] });
		expect(resolveDispatchTimeoutPolicy("worker", {})).toMatchObject({ mode: "leaf", inactivityMs: Infinity, absoluteMs: 20 * minute });
	});
	test("resolves lead timeout config through the compatibility convenience API", () => {
		expect(resolveLeadTimeoutConfig({
			HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS: "1200",
			HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS: "3400",
		})).toEqual({ inactivityMs: 1200, maxMs: 3400, notes: [] });
	});
	test("resolves lead timeout config with the leaf-sized default and never raises the ceiling", () => {
		expect(resolveLeadTimeoutConfig({})).toEqual({ inactivityMs: 20 * minute, maxMs: 6 * hour, notes: [] });
		expect(resolveLeadTimeoutConfig({
			HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS: "2000",
			HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS: "1000",
		})).toEqual({
			inactivityMs: 1000,
			maxMs: 1000,
			notes: ["Lead inactivity timeout 2000ms exceeds the absolute ceiling 1000ms; clamped to the ceiling."],
		});
	});
	test("applies explicit lead overrides, ignores invalid values, and clamps inactivity to the ceiling", () => {
		const base = resolveDispatchTimeoutPolicy("lead", {});
		expect(applyLeadTimeoutOverride(base, { inactivityMs: 100, maxMs: 1000 })).toMatchObject({ inactivityMs: 100, absoluteMs: 1000, notes: [] });
		const invalid = applyLeadTimeoutOverride(base, { inactivityMs: -5, maxMs: Number.NaN });
		expect(invalid).toMatchObject({ inactivityMs: 20 * minute, absoluteMs: 6 * hour });
		expect(invalid.notes).toHaveLength(2);
		const clamped = applyLeadTimeoutOverride(base, { inactivityMs: 500, maxMs: 200 });
		expect(clamped).toMatchObject({ inactivityMs: 200, absoluteMs: 200 });
		expect(clamped.notes.join(" ")).toContain("clamped");
		expect(applyLeadTimeoutOverride(resolveDispatchTimeoutPolicy("worker", {}), { inactivityMs: 1, maxMs: 2 }).mode).toBe("leaf");
	});
	test("maps the legacy lead timeout to the absolute ceiling when the new setting is absent", () => {
		const config = resolveLeadTimeoutConfig({
			HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS: "1000",
			HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS: "2345",
		});
		expect(config.maxMs).toBe(2345);
		expect(config.notes.join(" ")).toContain("legacy setting");
	});
	test("uses the legacy lead timeout as the absolute ceiling and records compatibility", () => {
		const policy = resolveDispatchTimeoutPolicy("technical_lead", { HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS: String(2 * hour) });
		expect(policy.absoluteMs).toBe(2 * hour);
		expect(policy.notes.join(" ")).toContain("HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS");
		expect(policy.notes.join(" ")).toMatch(/legacy|compat/i);
	});
	test("falls back from invalid configuration and explains the fallback", () => {
		const policy = resolveDispatchTimeoutPolicy("architect", {
			HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS: "garbage",
			HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS: "NaN",
		});
		expect(policy.inactivityMs).toBe(20 * minute);
		expect(policy.absoluteMs).toBe(6 * hour);
		expect(policy.notes).toHaveLength(2);
	});
	test("clamps inactivity down to the absolute ceiling and records the clamp", () => {
		const policy = resolveDispatchTimeoutPolicy("lead", {
			HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS: String(3 * hour),
			HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS: String(2 * hour),
		});
		expect(policy.inactivityMs).toBe(2 * hour);
		expect(policy.absoluteMs).toBe(2 * hour);
		expect(policy.notes.join(" ")).toMatch(/clamp/i);
	});
});

describe("DispatchProgressTracker", () => {
	test("renders an explicit unverified interruption report", () => {
		const rendered = renderInterruptionReport({
			taskId: "lead-1",
			reason: "inactivity_timeout",
			elapsedMs: 5000,
			sinceLastProgressMs: 3000,
			turns: 2,
			toolCalls: 4,
			repeatedToolCalls: 2,
			lastProgress: "tool read index.ts",
			nestedWorkers: [{ id: "worker-1", turns: 3, finished: false }],
			partialText: "partial answer",
			verified: false,
		});
		expect(rendered).toContain("UNVERIFIED PARTIAL WORK — inactivity");
		expect(rendered).toContain("repeatedToolCalls: 2");
		expect(rendered).toContain("worker-1 (3 turns, running)");
		expect(rendered).toContain("partial answer");
	});

	test("builds the complete interruption schema with bounded partial text", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 100);
		tracker.observe(start("read", { path: "index.ts" }), 150);
		tracker.observe(start("read", { path: "index.ts" }, "loop-2"), 160);
		tracker.observe(start("read", { path: "index.ts" }, "loop-3"), 170);
		tracker.observe(start("read", { path: "index.ts" }, "loop-4"), 180);
		tracker.observe({
			type: "tool_execution_update",
			partialResult: { details: {
				results: [nestedResult("worker-a", 3, "partial")],
				taskEvents: [{ type: "complete", taskId: "worker-a" }],
			} },
		}, 190);
		const report = buildInterruptionReport({
			taskId: "lead-1",
			reason: "absolute_timeout",
			startedAt: 100,
			now: 250,
			turns: 2,
			toolCalls: 4,
			partialText: "x".repeat(2501),
			tracker,
		});
		 expect(report).toMatchObject({
			taskId: "lead-1", reason: "absolute_timeout", elapsedMs: 150,
			sinceLastProgressMs: 60, turns: 2, toolCalls: 4,
			repeatedToolCalls: 1, lastProgress: "nested worker progress: worker-a",
			nestedWorkers: [{ id: "worker-a", turns: 3, finished: true }], verified: false,
		});
		expect(report.partialText).toHaveLength(2000);
	});

	test("schedules checks at the next warning threshold", () => {
		const tracker = new DispatchProgressTracker({ mode: "lead", inactivityMs: 1000, absoluteMs: 2000, notes: [] }, 0);
		expect(tracker.check(0).nextCheckMs).toBe(750);
		expect(tracker.check(750)).toMatchObject({
			nextCheckMs: 250,
			warnings: [{ kind: "inactivity", text: expect.stringContaining("no meaningful progress") }],
		});
	});

	test("peek does not consume warnings that check should return", () => {
		const tracker = new DispatchProgressTracker({ mode: "lead", inactivityMs: 1000, absoluteMs: 2000, notes: [] }, 0);
		expect(tracker.peek(750)).toMatchObject({ expired: false, inactiveMs: 750, elapsedMs: 750 });
		expect(tracker.check(750).warnings).toHaveLength(1);
	});

	test("renders sub-minute warning and expiry durations in seconds", () => {
		const tracker = new DispatchProgressTracker({ mode: "lead", inactivityMs: 45_000, absoluteMs: 90_000, notes: [] }, 0);
		expect(tracker.check(34_000).warnings[0].text).toContain("34s");
		expect(tracker.check(45_000).expired).toBe("inactivity");
		expect(tracker.describeExpiry("inactivity", "lead", 45_000)).toContain("after 45s");
	});

	test("counts loop-suspect tool calls", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		for (let index = 0; index < 6; index++) tracker.observe(start(), index);
		expect(tracker.repeatedToolCalls).toBe(3);
	});

	test("bounds outstanding tool-call records and removes completed records", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		for (let index = 0; index < 300; index++) tracker.observe(start("tool", { index }, `call-${index}`), index);
		expect(tracker.observe({ type: "tool_execution_end", toolCallId: "call-0" }, 301).kind).toBe("heartbeat");
		expect(tracker.observe({ type: "tool_execution_end", toolCallId: "call-299" }, 302).kind).toBe("progress");
		expect(tracker.observe({ type: "tool_execution_end", toolCallId: "call-299" }, 303).kind).toBe("heartbeat");
	});

	test("stays alive on regular progress and expires only at the absolute ceiling", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		for (let elapsed = 10 * minute; elapsed < 3 * hour; elapsed += 10 * minute) {
			tracker.observe(start("bash", ["step", elapsed]), elapsed);
			expect(tracker.check(elapsed).expired).toBe(false);
		}
		expect(tracker.check(90 * minute).expired).toBe(false);
		expect(tracker.check(6 * hour)).toMatchObject({ expired: "absolute", nextCheckMs: 0 });
	});
	test("expires idle work at the inactivity limit and warns only once per idle period", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		expect(tracker.check(22 * minute + 30_000).warnings).toHaveLength(1);
		expect(tracker.check(23 * minute).warnings).toEqual([]);
		expect(tracker.check(30 * minute).expired).toBe("inactivity");
	});
	test("re-arms inactivity warning after meaningful progress", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.check(23 * minute);
		tracker.observe(start("bash", ["new-work"]), 24 * minute);
		expect(tracker.check(46 * minute + 30_000).warnings).toHaveLength(1);
	});
	test("reports the relevant limit, remaining time, and configuration variable in warnings", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		const warning = tracker.check(23 * minute).warnings[0];
		expect(warning.kind).toBe("inactivity");
		expect(warning.text).toContain("30min");
		expect(warning.text).toContain("7min");
		expect(warning.text).toContain("HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS");
		const absoluteWarning = tracker.check(5 * hour + 25 * minute).warnings;
		expect(absoluteWarning.map(({ text }) => text).join(" ")).toContain("HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS");
	});
	test("classifies repeated tool calls and assistant text as loop/duplicate rather than progress", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		const observations = Array.from({ length: 4 }, (_, index) => tracker.observe(start(), index * minute));
		expect(observations.map(({ kind }) => kind)).toEqual(["progress", "progress", "progress", "loop"]);
		expect(tracker.observe(assistantText("same answer"), 5 * minute).kind).toBe("progress");
		expect(tracker.observe(assistantText("same answer"), 6 * minute).kind).toBe("duplicate");
		expect(tracker.observe(assistantText("same answer with new work"), 7 * minute).kind).toBe("progress");
		expect(tracker.check(38 * minute).expired).toBe("inactivity");
	});
	test("uses stable argument key ordering and a twelve-fingerprint loop window", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		expect(tracker.observe(start("tool", { a: 1, b: 2 }), 0).kind).toBe("progress");
		expect(tracker.observe(start("tool", { b: 2, a: 1 }), 1).kind).toBe("progress");
		tracker.observe(start("other", {}), 2);
		tracker.observe(start("other", {}), 3);
		tracker.observe(start("other", {}), 4);
		expect(tracker.observe(start("tool", { a: 1, b: 2 }), 5).kind).toBe("progress");
	});
	test("resets inactivity only when a successful end matches counted work", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(start("bash", ["work"], "counted"), 1);
		expect(tracker.observe({ type: "tool_execution_end", toolCallId: "unknown" }, 2).kind).toBe("heartbeat");
		expect(tracker.observe({ type: "tool_execution_end", toolCallId: "counted" }, 3).kind).toBe("progress");
		expect(tracker.lastProgressAt).toBe(3);
	});
	test("does not count failed tool ends as progress", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(start("bash", ["work"], "failed"), 1);
		expect(tracker.observe({ type: "tool_execution_end", toolCallId: "failed", isError: true }, 2).kind).toBe("heartbeat");
		expect(tracker.lastProgressAt).toBe(1);
	});
	test("advances nested progress on turns and ignores token-only growth", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		expect(tracker.observe(nestedUpdate(nestedResult("a", 1)), 1).kind).toBe("progress");
		expect(tracker.observe(nestedUpdate(nestedResult("a", 1)), 2).kind).toBe("duplicate");
		const tokensOnly = nestedResult("a", 1);
		tokensOnly.usage.input += 100;
		expect(tracker.observe(nestedUpdate(tokensOnly), 3).kind).toBe("duplicate");
		expect(tracker.observe(nestedUpdate(nestedResult("a", 2)), 4).kind).toBe("progress");
	});

	test("merges interleaved parallel placeholders monotonically without resetting duplicate progress", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		const result = (taskId: string, turns: number, latestText: string) => ({
			...nestedResult(taskId, turns, latestText),
			exitCode: -1,
		});
		const placeholder = (taskId: string) => result(taskId, 0, "");
		const updates = Array.from({ length: 12 }, (_, index) => {
			const aEmits = index % 2 === 0;
			return nestedUpdate(
				aEmits ? result("worker-a", 3, "same A") : placeholder("worker-a"),
				aEmits ? placeholder("worker-b") : result("worker-b", 4, "same B"),
			);
		});
		const observations = updates.map((event, index) => tracker.observe(event, (index + 1) * 100));
		expect(observations.slice(2).every(({ kind }) => kind === "duplicate")).toBe(true);
		expect(tracker.lastProgressAt).toBe(200);
		expect(tracker.nestedWorkers().map(({ taskId, turns, latestText }) => ({ taskId, turns, latestText }))).toEqual([
			{ taskId: "worker-a", turns: 3, latestText: "same A" },
			{ taskId: "worker-b", turns: 4, latestText: "same B" },
		]);
	});

	test("counts nested turn growth, ignores regressive placeholders, and finishes task events", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(nestedUpdate(nestedResult("worker-a", 3, "latest A")), 100);
		const placeholder = tracker.observe(nestedUpdate(nestedResult("worker-a", 0, "")), 200);
		expect(placeholder.kind).toBe("duplicate");
		expect(tracker.lastProgressAt).toBe(100);
		expect(tracker.nestedWorkers()[0]).toMatchObject({ turns: 3, latestText: "latest A", finished: false });
		expect(tracker.observe(nestedUpdate(nestedResult("worker-a", 4, "latest A")), 300).kind).toBe("progress");
		const completed = tracker.observe({
			type: "tool_execution_update",
			partialResult: { details: {
				taskEvents: [{ type: "complete", taskId: "worker-a" }],
			} },
		}, 400);
		expect(completed.kind).toBe("progress");
		expect(tracker.nestedWorkers()[0].finished).toBe(true);
	});
	test("keeps one stable nested worker row per task id and marks snapshot changes", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(nestedUpdate(nestedResult("a", 1), nestedResult("b", 1)), 1);
		tracker.observe(nestedUpdate(nestedResult("a", 1), nestedResult("b", 1)), 2);
		const workers = tracker.nestedWorkers();
		expect(workers).toHaveLength(2);
		expect(workers.map(({ taskId }) => taskId)).toEqual(["a", "b"]);
		expect(workers.every(({ changed }) => !changed)).toBe(true);
	});
	test("recognizes nested terminal transitions and latest-text changes", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(nestedUpdate(nestedResult("a", 1, "first", -1)), 1);
		expect(tracker.observe(nestedUpdate(nestedResult("a", 1, "first", 0)), 2).kind).toBe("progress");
		expect(tracker.observe(nestedUpdate(nestedResult("a", 1, "new text", 0)), 3).kind).toBe("progress");
		expect(tracker.observe(nestedUpdate(nestedResult("a", 1, "new text", -1)), 4).kind).toBe("duplicate");
		expect(tracker.nestedWorkers()[0].exitCode).toBe(0);
	});
	test("skips nested results without string task ids and bounds stored rows", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		expect(tracker.observe(nestedUpdate({ agent: "worker" }), 1).nested).toEqual([]);
		for (let index = 0; index < 35; index++) tracker.observe(nestedUpdate(nestedResult(`task-${index}`, 1)), index + 2);
		expect(tracker.nestedWorkers()).toHaveLength(32);
		expect(tracker.nestedWorkers()[0].taskId).toBe("task-3");
	});
	test("does not treat an unchanged re-sighting of an evicted worker as progress", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(nestedUpdate(nestedResult("evicted-worker", 1)), 1);
		for (let index = 0; index < 32; index++) {
			tracker.observe(nestedUpdate(nestedResult(`worker-${index}`, 1)), index + 2);
		}
		const resighting = tracker.observe(nestedUpdate(nestedResult("evicted-worker", 1)), 40);
		expect(resighting.kind).toBe("duplicate");
		expect(resighting.nested?.some((worker) => worker.taskId === "evicted-worker" && worker.changed)).toBe(false);
	});
	test("keeps leaf dispatches alive past inactivity while tracking progress", () => {
		const policy = resolveDispatchTimeoutPolicy("worker", { HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS: String(20 * minute) });
		const tracker = new DispatchProgressTracker(policy, 0);
		tracker.observe(start(), 18 * minute);
		expect(tracker.check(19 * minute).expired).toBe(false);
		expect(tracker.check(20 * minute).expired).toBe("absolute");
		expect(tracker.check(20 * minute).nextCheckMs).toBe(0);
	});
	test("never resets the absolute ceiling during continuous progress", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		for (let elapsed = 10 * minute; elapsed < 6 * hour; elapsed += 10 * minute) tracker.observe(start("step", [elapsed]), elapsed);
		expect(tracker.check(6 * hour).expired).toBe("absolute");
	});
	test("emits the absolute warning once per dispatch", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(start("bash", ["still-working"]), 5 * hour + 20 * minute);
		expect(tracker.check(5 * hour + 24 * minute).warnings).toHaveLength(1);
		expect(tracker.check(5 * hour + 25 * minute).warnings).toEqual([]);
	});
	test("returns ignored for malformed events and heartbeat for well-formed unknown events", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		for (const event of [null, "message_end", {}, { type: "tool_execution_start" }]) {
			expect(() => tracker.observe(event, 1)).not.toThrow();
			expect(tracker.observe(event, 1).kind).toBe("ignored");
		}
		expect(tracker.observe({ type: "future_child_event", payload: true }, 1).kind).toBe("heartbeat");
		expect(tracker.lastProgressAt).toBe(0);
	});
	test("describes the configured inactivity limit separately from actual idle time", () => {
		const tracker = new DispatchProgressTracker(leadPolicy, 0);
		tracker.observe(start("bash", ["bun", "test"]), 0);
		expect(tracker.describeExpiry("inactivity", "lead", 31 * minute)).toContain("dispatch timed out after 30min without meaningful progress (last progress: bash bun test 31min ago; capability=lead)");
		expect(tracker.describeExpiry("absolute", "lead", 6 * hour)).toContain("dispatch exceeded absolute ceiling 360min (capability=lead)");
	});

	test("summarizes interruption reports into one line without leaking partial text", () => {
		const summary = summarizeInterruption({
			taskId: "lead-1", reason: "inactivity_timeout", elapsedMs: 1000,
			sinceLastProgressMs: 500, turns: 1, toolCalls: 2, repeatedToolCalls: 0,
			lastProgress: "read", nestedWorkers: [], partialText: "private\\npartial report", verified: false,
		});
		expect(summary).toContain("UNVERIFIED PARTIAL WORK — inactivity");
		expect(summary).not.toContain("private");
		expect(summary).not.toContain("\\n");
	});
});

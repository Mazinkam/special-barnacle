import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunSession } from "./session.ts";

const repoDir = mkdtempSync(join(tmpdir(), "orch-session-test-repo-"));
const runsDir = mkdtempSync(join(tmpdir(), "orch-session-test-runs-"));
afterAll(() => {
	rmSync(repoDir, { recursive: true, force: true });
	rmSync(runsDir, { recursive: true, force: true });
});

function createSession(id: string, ctx: unknown, goal: string) {
	return new RunSession(id, ctx as never, goal, repoDir, {
		runsDir: () => runsDir,
		telemetrySnapshot: () => ({ recorded: 0, failed: 0, replayed: 0 }) as never,
	});
}

describe("RunSession cancellation presentation", () => {
	test("clears the widget and status after cancellation cleanup, keeping the trace in run.log", () => {
		const widgets: unknown[] = [];
		const statuses: unknown[] = [];
		const ctx = {
			ui: {
				setWidget: (_id: string, value: unknown) => widgets.push(value),
				setStatus: (_id: string, value: unknown) => statuses.push(value),
				notify: mock(),
			},
		};
		const session = createSession("cancel-ui-test", ctx, "update the payments page");
		session.startDispatch("lead-1", "lead", "provider/model");
		session.cancel();
		session.endDispatch("lead-1", 137, 0);

		// While the run is still live, the cancelled dispatch and goal are visible.
		const liveWidget = widgets.at(-1) as string[];
		expect(liveWidget.some((line) => line.includes("Goal:") && line.includes("update the payments page"))).toBe(true);
		expect(liveWidget.some((line) => line.includes("lead") && line.includes("cancelled by user"))).toBe(true);
		expect(statuses.at(-1)).toContain("cancelling");

		// Cleanup clears the widget/status unconditionally — cancellation no longer
		// pins the board to the screen; run.log is the durable trace instead.
		session.close();
		expect(widgets.at(-1)).toBeUndefined();
		expect(statuses.at(-1)).toBeUndefined();
		const log = readFileSync(session.file("run.log"), "utf8");
		expect(log).toContain("cancellation requested (user)");
	});

	test("render() and setPhase() swallow a ctx.ui getter that throws after shutdown, including on the tick-timer path", () => {
		let uiInvalidated = false;
		const ui = { notify: mock(), setWidget: mock(), setStatus: mock() };
		const ctx = {
			// Mirrors a real session ending mid-drain: `ctx.ui` throws once invalidated,
			// which must not propagate out of render()/setPhase() (directly or via the
			// once-a-second tick timer).
			get ui() {
				if (uiInvalidated) throw new Error("ctx invalidated: ui is unavailable after this session ended");
				return ui;
			},
		};
		const session = createSession("ui-throws-after-shutdown-test", ctx, "goal");
		try {
			uiInvalidated = true;
			// render() is what the once-a-second tick timer calls; setPhase() also renders.
			expect(() => session.render()).not.toThrow();
			expect(() => session.setPhase("x")).not.toThrow();
		} finally {
			uiInvalidated = false;
			session.close();
		}
	});
});

describe("RunSession progress reporting", () => {
	test("renders stable nested workers, progress age, and tracker warnings without notify spam", () => {
		const widgets: unknown[] = [];
		const notify = mock();
		const ctx = {
			ui: {
				setWidget: (_id: string, value: unknown) => widgets.push(value),
				setStatus: (_id: string, _value: unknown) => {},
				notify,
			},
		};
		const session = createSession("progress-ui-test", ctx, "track worker progress");
		session.startDispatch("lead-1", "lead", "p/m");
		const initialSnapshots = ["worker-1", "worker-2"].map((taskId) => ({
			taskId,
			agent: "worker",
			depth: 1,
			turns: 1,
			exitCode: -1,
			costUsd: 0.01,
			latestText: "working",
			finished: false,
			changed: true,
		}));
		const warning = { kind: "inactivity" as const, text: "⚠ no meaningful progress for 23min (limit 30min; raise HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS) — last: inspect absolute path" };
		session.recordProgress("lead-1", { kind: "progress", detail: "bash bun test", nested: initialSnapshots }, { expired: false, nextCheckMs: 1_000, inactiveMs: 0, elapsedMs: 0, warnings: [] });
		session.recordProgress("lead-1", {
			kind: "duplicate",
			detail: "nested worker snapshot unchanged",
			nested: initialSnapshots.map((snapshot) => ({ ...snapshot, changed: false, turns: 2, exitCode: 0, latestText: "ignored duplicate" })),
		}, { expired: false, nextCheckMs: 1_000, inactiveMs: 1_000, elapsedMs: 1_000, warnings: [warning] });
		session.recordProgress("lead-1", {
			kind: "duplicate",
			detail: "nested worker snapshot unchanged",
			nested: initialSnapshots.map((snapshot) => ({ ...snapshot, changed: false, turns: 2, exitCode: 0, latestText: "ignored duplicate" })),
		}, { expired: false, nextCheckMs: 1_000, inactiveMs: 1_000, elapsedMs: 1_000, warnings: [warning] });
		session.render();
		const widget = widgets.at(-1) as string[];
		session.close();

		expect(widget.filter((line) => line.includes("latest:"))).toHaveLength(2);
		expect(widget.some((line) => line.includes("2 workers (2 turns)"))).toBe(true);
		expect(widget.filter((line) => line.includes("latest:")).every((line) => !line.includes("✓"))).toBe(true);
		expect(widget.some((line) => line.includes("progress") && line.includes("ago"))).toBe(true);
		expect(widget.some((line) => line.includes("⚠"))).toBe(true);
		expect(notify).not.toHaveBeenCalled();
		const log = readFileSync(session.file("run.log"), "utf8");
		// Identical warning text is logged at most once within the UI's five-minute suppression window.
		expect(log.split(warning.text).length - 1).toBe(1);
	});

	test("throttles ordinary progress logs but keeps nested progress and sanitizes details", () => {
		const ctx = { ui: { setWidget: () => {}, setStatus: () => {}, notify: () => {} } };
		const session = createSession("progress-log-test", ctx, "log progress carefully");
		session.startDispatch("lead-1", "lead", "p/m");
		const check = { expired: false as const, nextCheckMs: 1_000, inactiveMs: 0, elapsedMs: 0, warnings: [] as Array<{ kind: "inactivity" | "absolute"; text: string }> };
		session.recordProgress("lead-1", { kind: "progress", detail: " initial\nprogress " }, check, 1_000);
		session.recordProgress("lead-1", { kind: "progress", detail: "tool start" }, check, 30_000);
		session.recordProgress("lead-1", { kind: "progress", detail: "nested worker progress: worker-1" }, check, 30_001);
		session.recordProgress("lead-1", { kind: "progress", detail: "tool execution completed" }, check, 90_001);
		session.recordProgress("lead-1", { kind: "progress", detail: "tool end" }, check, 90_002);
		session.recordProgress("lead-1", { kind: "progress", detail: "tool end" }, check, 150_001);
		session.close();

		const log = readFileSync(session.file("run.log"), "utf8");
		expect(log).toContain("progress: initial progress");
		expect(log).toContain("progress: nested worker progress: worker-1");
		expect(log).toContain("progress: tool end");
		expect(log).not.toContain("progress: tool start");
		expect(log).not.toContain("progress: tool execution completed");
		expect(log.split("progress: tool end").length - 1).toBe(1);
	});
});

describe("RunSession queued messages with owned diagnostics", () => {
	test("delivers each batch once and preserves queue/delivery UI and logs through sealing", async () => {
		const widgets: string[][] = [];
		const session = createSession("message-queue-sealed", {
			ui: { notify() {}, setStatus() {}, setWidget: (_id: string, lines?: string[]) => { if (lines) widgets.push(lines); } },
		}, "steer the running lead");
		try {
			expect(session.enqueueMessage("  verify accessibility  ")).toBe(1);
			expect(session.enqueueMessage("   ")).toBe(1);
			expect(widgets.at(-1)?.some((line) => line.includes("1 message queued"))).toBe(true);
			expect(session.drainMessages("qa")).toEqual(["verify accessibility"]);
			expect(session.drainMessages("retry")).toEqual([]);
			expect(session.queuedDepth()).toBe(0);
			expect(widgets.at(-1)?.some((line) => line.includes("1 message delivered to qa"))).toBe(true);
			session.close();
			expect(await session.sealDiagnostics(Promise.resolve(true))).toBe(true);
			const log = readFileSync(session.file("run.log"), "utf8");
			expect(log).toContain("user message queued (depth=1): verify accessibility");
			expect(log).toContain("delivered 1 user message(s) to qa");
		} finally {
			session.close();
		}
	});
});

describe("RunSession terminal timing", () => {
	function fakeCtx() {
		return { ui: { setWidget: () => {}, setStatus: () => {}, notify: mock() } };
	}

	test("reports wall-clock start/finish stamps and a monotonic elapsed_ms", async () => {
		const before = Date.now();
		const session = createSession("timing-test", fakeCtx(), "goal");
		await new Promise((r) => setTimeout(r, 25));
		const timing = session.terminalTiming();
		const after = Date.now();

		expect(typeof timing.started_at).toBe("string");
		expect(typeof timing.finished_at).toBe("string");
		expect(Number.isNaN(Date.parse(timing.started_at))).toBe(false);
		expect(Date.parse(timing.started_at)).toBeGreaterThanOrEqual(before - 1);
		expect(Date.parse(timing.finished_at)).toBeLessThanOrEqual(after + 1);
		expect(Date.parse(timing.finished_at)).toBeGreaterThanOrEqual(Date.parse(timing.started_at));
		expect(Number.isInteger(timing.elapsed_ms)).toBe(true);
		expect(timing.elapsed_ms).toBeGreaterThanOrEqual(20);
		expect(timing.elapsed_ms).toBeLessThanOrEqual(after - before + 5);
		expect(timing.elapsed_source).toBe("monotonic");
		session.close();
	});

	test("elapsed_ms is never negative even if the wall clock steps backwards", () => {
		const session = createSession("timing-test-2", fakeCtx(), "goal");
		const original = performance.now;
		try {
			performance.now = () => -1e9;
			expect(session.terminalTiming().elapsed_ms).toBe(0);
		} finally {
			performance.now = original;
			session.close();
		}
	});

	test("started_at is derived from the session's single wall-clock start read", () => {
		// Two independent wall-clock reads at construction can disagree; the ISO stamp written to
		// outcomes must be the same instant the UI's elapsed counter uses.
		const fixed = Date.UTC(2026, 8, 23, 10, 0, 0, 123);
		const original = Date.now;
		try {
			Date.now = () => fixed;
			const session = createSession("timing-test-3", fakeCtx(), "goal");
			expect(session.terminalTiming().started_at).toBe(new Date(fixed).toISOString());
			session.close();
		} finally {
			Date.now = original;
		}
	});

	test("run terminal outcomes carry the timing fields", () => {
		const finalizeSource = readFileSync(new URL("./finalize.ts", import.meta.url), "utf8");
		const complete = finalizeSource.slice(finalizeSource.indexOf("async function completeRun("), finalizeSource.indexOf("async function failRun("));
		const fail = finalizeSource.slice(finalizeSource.indexOf("async function failRun("), finalizeSource.indexOf("export function createDispatchCostCapture("));
		for (const fn of [complete, fail]) {
			expect(fn).toContain("...timing");
		}
		// Every terminal call inside the /orchestrate handler must pass the session timing.
		const orchestrateSource = readFileSync(new URL("../commands/orchestrate.ts", import.meta.url), "utf8");
		const pipelineSource = readFileSync(new URL("../pipeline/run-orchestration.ts", import.meta.url), "utf8");
		const handler = orchestrateSource.slice(orchestrateSource.indexOf('pi.registerCommand("orchestrate"')) + pipelineSource;
		const calls = handler.match(/await deps\.(?:completeRun|failRun)\([^;]*?\);/gs) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(6);
		for (const call of calls) expect(call).toContain("session.terminalTiming()");
	});
});

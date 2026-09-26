import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@humain/terminal";

import { runOrchestration, writeLeadReportsDiagnostic, type RunOrchestrationDeps } from "./run-orchestration.ts";
import { RunCancellation } from "../cancellation.ts";
import type { RunSession } from "../run/session.ts";
import type { RunContext } from "../run/context.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";
import type { OrchestrateArgs } from "../core/args.ts";
import type { FlushReport } from "../record-queue.ts";
import type { PlanResponse } from "../core/prompts.ts";

/** A `RunSession` fake with only the surface `runOrchestration` touches on the
 *  paths under test: no timers, no disk I/O. Cast past the real class's
 *  private fields (nominal typing) the same way any hand-rolled test double
 *  for a class with private state has to. */
function fakeSession(): RunSession {
	const cancellation = new RunCancellation();
	const logs: string[] = [];
	return {
		cancellation,
		log: (line: string) => { logs.push(line); },
		setPhase: () => {},
		file: (name: string) => `/tmp/run/${name}`,
		dir: "/tmp/run",
		telemetryBaseline: { enqueued: 0, acknowledged: 0 },
		terminalTiming: () => ({ started_at: "2024-01-01T00:00:00.000Z", finished_at: "2024-01-01T00:00:01.000Z", elapsed_ms: 1000, elapsed_source: "monotonic" as const }),
		writeDiagnostic: () => true,
		// Exposed for assertions in a couple of tests below.
		_logs: logs,
	} as unknown as RunSession;
}

function fakeCtx(overrides: Partial<{ hasUI: boolean; confirm: (title: string, message: string) => Promise<boolean> | boolean }> = {}): { ctx: ExtensionContext; notifications: Array<{ text: string; level: string }> } {
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		hasUI: overrides.hasUI ?? true,
		ui: {
			notify: (text: string, level: string) => { notifications.push({ text, level }); },
			confirm: overrides.confirm ?? (() => Promise.resolve(true)),
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications };
}

function fakeAdapter(): Adapter {
	return {
		implementation_fast: { model: "p/fast" },
		architect: { model: "p/architect" },
		lead: { model: "p/lead" },
		worker: { model: "p/worker" },
		qa_agent: { model: "p/qa" },
	};
}

function fakeResolution(adapter: Adapter): FullResolution {
	return {
		adapter,
		sources: Object.fromEntries(Object.keys(adapter).map((k) => [k, "fallback"])) as FullResolution["sources"],
		specs: {},
		warnings: [],
		notes: [],
		profileName: "test-profile",
		profiles: { active_profile: "test-profile", profiles: {}, problems: [], notes: [] } as unknown as FullResolution["profiles"],
		table: null as unknown as FullResolution["table"],
		preference: [],
	};
}

function fakeArgs(overrides: Partial<OrchestrateArgs> = {}): OrchestrateArgs {
	return {
		goal: "do the thing",
		taskClass: "bugfix", // deliberately not the "implementation"/5/"medium" defaults: skip triage
		complexity: 5,
		risk: "medium",
		fanOut: false,
		maxRetries: 1,
		interactive: false,
		check: false,
		models: { tiers: {}, capabilities: {} },
		unknownFlags: [],
		...overrides,
	};
}

const healthyTelemetry: FlushReport = { ok: true, batches: 1, acknowledged: 1, failed: 0, derivedStale: 0 };

function fakeDeps(overrides: Partial<RunOrchestrationDeps> = {}): RunOrchestrationDeps {
	return {
		triageTask: async () => null,
		planRun: async () => {
			throw new Error("planRun not stubbed for this test");
		},
		recordEvent: () => {},
		recordOutcome: () => {},
		captureDispatchCost: async () => {},
		dispatchParallel: async () => [],
		completeRun: async () => healthyTelemetry,
		failRun: async () => healthyTelemetry,
		maxLeads: 4,
		reconEvidenceMaxChars: 4000,
		stateRoot: "/tmp/state",
		...overrides,
	};
}

const claimed: RunContext<RunSession> = { session: undefined as unknown as RunSession, tags: {}, aliasTable: null };

describe("pipeline/run-orchestration.ts runOrchestration", () => {
	test("plan failing outright aborts the run: failRun'd, notified, no RunReport", async () => {
		const session = fakeSession();
		const { ctx, notifications } = fakeCtx();
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		let failRunCalls = 0;
		const deps = fakeDeps({
			planRun: async () => {
				throw new Error("boom");
			},
			failRun: async (runId, error) => {
				failRunCalls++;
				expect(error).toBe("plan failed: boom");
				return healthyTelemetry;
			},
		});

		const result = await runOrchestration(
			"ht-orch-1700000000000-abcdef",
			"/tmp/cwd",
			fakeArgs(),
			adapter,
			resolved,
			ctx,
			session,
			{ ...claimed, session },
			deps,
		);

		expect(result).toEqual({ kind: "aborted" });
		expect(failRunCalls).toBe(1);
		expect(notifications.some((n) => n.text === "Plan failed: boom" && n.level === "error")).toBe(true);
	});

	test("declining the dispatch confirmation aborts the run without dispatching anything", async () => {
		const session = fakeSession();
		const { ctx, notifications } = fakeCtx({ confirm: () => Promise.resolve(false) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const plan: PlanResponse = {
			plan_id: "plan-123456789012",
			run_id: "ht-orch-1700000000000-abcdef",
			task_class: "bugfix",
			complexity: 5,
			risk: "medium",
			topology: { depth: 1, leads: 1, workers: 1, shape: "flat" },
			route: {
				selected: { capability: "lead", effort: "medium", verification_depth: "standard" },
				recommended: { capability: "lead", effort: "medium", verification_depth: "standard" },
				mode: "auto",
				history_sufficient: true,
				explanation: {},
			},
			effective_quality_floor: 0.5,
			cost_aggressiveness: 0.5,
		};
		let dispatchCalls = 0;
		let failRunCalls = 0;
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async () => {
				dispatchCalls++;
				return [];
			},
			failRun: async (runId, error) => {
				failRunCalls++;
				expect(error).toBe("cancelled by user at plan confirmation");
				return healthyTelemetry;
			},
		});

		const result = await runOrchestration(
			"ht-orch-1700000000000-abcdef",
			"/tmp/cwd",
			fakeArgs({ interactive: true }),
			adapter,
			resolved,
			ctx,
			session,
			{ ...claimed, session },
			deps,
		);

		expect(result).toEqual({ kind: "aborted" });
		expect(dispatchCalls).toBe(0);
		expect(failRunCalls).toBe(1);
		expect(notifications.some((n) => n.text === "Cancelled." && n.level === "info")).toBe(true);
	});
});

describe("pipeline/run-orchestration.ts writeLeadReportsDiagnostic", () => {
	test("no lead reports: does not write, is not logged, and hasLeadReports is false", () => {
		const logs: string[] = [];
		let writeCalls = 0;
		const session = {
			writeDiagnostic: () => { writeCalls++; return true; },
			log: (line: string) => { logs.push(line); },
		};
		const written = writeLeadReportsDiagnostic(session as never, []);
		expect(written).toBe(false);
		expect(writeCalls).toBe(0);
		expect(logs).toEqual([]);
	});

	test("write succeeds: returns true, no failure logged", () => {
		const logs: string[] = [];
		const writes: Array<{ name: string; text: string }> = [];
		const session = {
			writeDiagnostic: (name: string, text: string) => { writes.push({ name, text }); return true; },
			log: (line: string) => { logs.push(line); },
		};
		const written = writeLeadReportsDiagnostic(session as never, ["### lead-0\n\nreport body"]);
		expect(written).toBe(true);
		expect(writes).toEqual([{ name: "lead-report.md", text: "### lead-0\n\nreport body" }]);
		expect(logs).toEqual([]);
	});

	test("writeDiagnostic returning false (rejected, e.g. diagnostics sealed): returns false and logs the failure", () => {
		const logs: string[] = [];
		const session = {
			writeDiagnostic: () => false,
			log: (line: string) => { logs.push(line); },
		};
		const written = writeLeadReportsDiagnostic(session as never, ["### lead-0\n\nreport body"]);
		expect(written).toBe(false);
		expect(logs).toEqual(["lead-report.md write failed: diagnostics writer rejected the write (sealed/closing)"]);
	});

	test("writeDiagnostic throwing: returns false and logs the error message instead of swallowing it", () => {
		const logs: string[] = [];
		const session = {
			writeDiagnostic: () => { throw new Error("ENOSPC: no space left on device"); },
			log: (line: string) => { logs.push(line); },
		};
		const written = writeLeadReportsDiagnostic(session as never, ["### lead-0\n\nreport body"]);
		expect(written).toBe(false);
		expect(logs).toEqual(["lead-report.md write failed: ENOSPC: no space left on device"]);
	});
});

describe("pipeline/run-orchestration.ts runOrchestration elapsedMs (B4.7)", () => {
	test("elapsed time comes from the session's recorded start, not a timestamp parsed out of the run id", async () => {
		// A run id whose third `-`-separated segment is not a timestamp at all — the old
		// `Number(runId.split("-")[2])` parse produced `NaN` here, and `Date.now() - NaN` is
		// `NaN`, silently breaking the "Orchestration complete in ..." line.
		const runId = "ht-orch-not-a-timestamp-abcdef";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const plan: PlanResponse = {
			plan_id: "plan-123456789012",
			run_id: runId,
			task_class: "bugfix",
			complexity: 3,
			risk: "medium",
			topology: { depth: 1, leads: 1, workers: 0, shape: "flat" },
			route: {
				selected: { capability: "lead", effort: "medium", verification_depth: "standard" },
				recommended: { capability: "lead", effort: "medium", verification_depth: "standard" },
				mode: "auto",
				history_sufficient: true,
				explanation: {},
			},
			effective_quality_floor: 0.5,
			cost_aggressiveness: 0.5,
		};
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async (_cwd, runId2, tasks) => tasks.map((t) => ({
				taskId: t.taskId,
				capability: t.capability,
				model: "p/lead",
				exitCode: 0,
				stdout: "STATUS: done\n\nFiles Changed: None",
				stderr: "",
				usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
				durationMs: 1,
				costUsd: 0,
				nestedCostUsd: 0,
				costReported: true,
				outcome: "completed" as const,
				filesChanged: [],
			})),
		});

		const result = await runOrchestration(
			runId,
			"/tmp/cwd-not-a-git-repo",
			fakeArgs(),
			adapter,
			resolved,
			ctx,
			session,
			{ ...claimed, session },
			deps,
		);

		expect(result.kind).toBe("completed");
		if (result.kind === "completed") {
			// fakeSession()'s terminalTiming() always returns elapsed_ms: 1000, regardless of
			// the run id's shape — the fix must read that instead of parsing the run id.
			expect(result.report.elapsedMs).toBe(1000);
			expect(Number.isNaN(result.report.elapsedMs)).toBe(false);
		}
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@humain/terminal";

import { runOrchestration, writeLeadReportsDiagnostic, type RunOrchestrationDeps } from "./run-orchestration.ts";
import { buildRunSummary } from "../core/report.ts";
import { RunCancellation } from "../cancellation.ts";
import type { RunSession } from "../run/session.ts";
import type { RunContext } from "../run/context.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";
import type { OrchestrateArgs } from "../core/args.ts";
import type { FlushReport } from "../record-queue.ts";
import type { DispatchTask, PlanResponse } from "../core/prompts.ts";

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
		contextFiles: [],
		withLastReply: false,
		force: false,
		liveQa: false,
		liveQaOff: false,
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
		providedContext: "",
		env: {},
		recordModelCall: () => {},
		...overrides,
	};
}

const claimed: RunContext<RunSession> = { session: undefined as unknown as RunSession, tags: {}, aliasTable: null };

describe("pipeline/run-orchestration.ts runOrchestration", () => {
	test.each([
		{ name: "unflagged triage", args: { taskClass: "implementation" as const, complexity: 5, risk: "medium" as const }, triage: { task_class: "bugfix" as const, complexity: 2, risk: "low" as const, reasoning: "small fix" }, expected: "small" },
		{ name: "auto lead sizing", args: { complexity: 8, risk: "high" as const }, triage: null, expected: "large" },
		{ name: "explicit lead size", args: { complexity: 8, risk: "high" as const, leadSize: "small" as const }, triage: null, expected: "small" },
	])("logs one effective run settings line after $name selection before dispatch, without the goal", async ({ args, triage, expected }) => {
		const session = fakeSession();
		let confirmations = 0;
		const { ctx } = fakeCtx({ confirm: () => ++confirmations === 1 && triage !== null });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		resolved.profileName = "lean";
		const logs = (session as unknown as { _logs: string[] })._logs;
		const deps = fakeDeps({
			triageTask: async () => triage,
			planRun: async () => ({
				plan_id: "plan-123456789012", run_id: "run", task_class: "bugfix", complexity: 5, risk: "medium",
				topology: { depth: 1, leads: 1, workers: 1, shape: "flat" },
				route: { selected: { capability: "lead", effort: "medium", verification_depth: "standard" }, recommended: { capability: "lead", effort: "medium", verification_depth: "standard" }, mode: "auto", history_sufficient: true, explanation: {} },
				effective_quality_floor: 0.5, cost_aggressiveness: 0.5,
			}),
		});
		const result = await runOrchestration("run", "/tmp/cwd", fakeArgs({ goal: "confidential auth flow", interactive: true, ...args }), adapter, resolved, ctx, session, { ...claimed, session }, deps);
		expect(result.kind).toBe("aborted");
		const settings = logs.filter((line) => line.startsWith("run settings:"));
		expect(settings).toEqual([`run settings: profile=lean complexity=${triage?.complexity ?? args.complexity} risk=${triage?.risk ?? args.risk} lead-size=${expected} lead-count=1`]);
		expect(settings[0]).not.toContain("confidential auth flow");
		const leadIndex = logs.findIndex((line) => line.startsWith("lead size:"));
		expect(logs.indexOf(settings[0])).toBeGreaterThan(leadIndex);
	});
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

describe("pipeline/run-orchestration.ts out-of-tree warning (A6/N2)", () => {
	test("running against this extension's own repo warns at start without blocking planning", async () => {
		const session = fakeSession();
		const { ctx, notifications } = fakeCtx();
		const events: string[] = [];
		const deps = fakeDeps({
			planRun: async () => { throw new Error("plan marker"); },
			recordEvent: (event) => { events.push(event); },
		});
		const result = await runOrchestration("ht-orch-1700000000000-live", process.cwd(), fakeArgs(), fakeAdapter(), fakeResolution(fakeAdapter()), ctx, session, { ...claimed, session }, deps);
		expect(result.kind).toBe("aborted");
		expect(events).toContain("live_extension_tree");
		expect(notifications.some((n) => n.level === "warning" && n.text.includes("Live extension tree:"))).toBe(true);
		expect(notifications.some((n) => n.level === "error" && n.text.includes("plan marker"))).toBe(true);
	});
	test("a lead editing another git worktree leaves this run at zero files but warns and names that worktree", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "orch-out-of-tree-"));
		const repo = join(tmp, "repo");
		const other = join(tmp, "other-worktree");
		mkdirSync(repo);
		const git = (args: string[]) => {
			const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
			if (result.status !== 0) throw new Error(result.stderr);
		};
		try {
			git(["init", "-q"]);
			git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "baseline"]);
			git(["worktree", "add", "-q", "--detach", other]);
			const runId = "ht-orch-1700000000000-foreign";
			const plan: PlanResponse = {
				plan_id: "plan-123456789012", run_id: runId, task_class: "bugfix", complexity: 3, risk: "medium",
				topology: { depth: 1, leads: 1, workers: 0, shape: "flat" },
				route: {
					selected: { capability: "lead", effort: "medium", verification_depth: "standard" },
					recommended: { capability: "lead", effort: "medium", verification_depth: "standard" },
					mode: "auto", history_sufficient: true, explanation: {},
				},
				effective_quality_floor: 0.5, cost_aggressiveness: 0.5,
			};
			for (const { claims, localEdit, earlierCommands } of [
				{ claims: [] as string[], localEdit: false, earlierCommands: 0 },
				{ claims: ["a.ts"], localEdit: false, earlierCommands: 0 },
				{ claims: ["a.ts"], localEdit: true, earlierCommands: 0 },
				// A foreign cd as command 21 in the bounded log must not be lost to the first 20.
				{ claims: [] as string[], localEdit: false, earlierCommands: 20 },
			]) {
				const session = fakeSession();
				// The child actually issued the command; assistant prose is not tool evidence.
				const commandEvent = (command: string) => JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command } });
				writeFileSync(join(tmp, `${runId}-lead-0.events.jsonl`), [
					...Array.from({ length: earlierCommands }, () => commandEvent(`cd ${repo} && true`)),
					commandEvent(`cd ${other} && touch a.ts`),
				].join("\n") + "\n");
				session.file = (name: string) => join(tmp, name);
				const { ctx, notifications } = fakeCtx();
				const events: string[] = [];
				const deps = fakeDeps({
					planRun: async () => plan,
					recordEvent: (event) => { events.push(event); },
					dispatchParallel: async (_cwd, _id, tasks) => {
						if (tasks[0]?.capability !== "lead") {
							if (!localEdit) throw new Error("QA must not run on the wrong worktree");
							return tasks.map((t) => ({
								taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 0,
								stdout: "## Verdict\nPASS", stderr: "",
								usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
								durationMs: 1, costUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
							}));
						}
						writeFileSync(join(other, "a.ts"), "edited in another worktree\n");
						if (localEdit) writeFileSync(join(repo, "unrelated.ts"), "changed locally\n");
						return tasks.map((t) => ({
							taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
							stdout: "STATUS: completed\nWrote a.ts", stderr: "",
							usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
							durationMs: 1, costUsd: 0, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: claims,
						}));
					},
				});
				const result = await runOrchestration(runId, repo, fakeArgs(), fakeAdapter(), fakeResolution(fakeAdapter()), ctx, session, { ...claimed, session }, deps);
				expect(result.kind).toBe("completed");
				if (result.kind !== "completed") continue;
				expect(result.report.filesChangedCount).toBe(localEdit ? 1 : 0);
				expect(result.report.outOfTreeChangesLine).toBe(`changes outside run tree: ${other}`);
				expect(buildRunSummary(result.report).text).toContain(`changes outside run tree: ${other}`);
				expect(notifications.some((n) => n.level === "warning" && n.text.includes(`changes outside run tree: ${other}`))).toBe(true);
				expect(events).toContain("out_of_tree_changes");
			}
			// A bare report claim that the lead visited another worktree is not an edit.
			rmSync(join(tmp, `${runId}-lead-0.events.jsonl`));
			const proseSession = fakeSession();
			proseSession.file = (name: string) => join(tmp, name);
			const proseCtx = fakeCtx();
			const proseDeps = fakeDeps({
				planRun: async () => plan,
				dispatchParallel: async (_cwd, _id, tasks) => tasks.map((t) => ({
					taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
					stdout: `STATUS: completed\nI considered cd ${other} but made no edits.`, stderr: "",
					usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
					durationMs: 1, costUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
				})),
			});
			const proseResult = await runOrchestration(runId, repo, fakeArgs(), fakeAdapter(), fakeResolution(fakeAdapter()), proseCtx.ctx, proseSession, { ...claimed, session: proseSession }, proseDeps);
			expect(proseResult.kind).toBe("completed");
			if (proseResult.kind === "completed") expect(proseResult.report.outOfTreeChangesLine).toBeNull();
			expect(proseCtx.notifications.some((n) => n.text.includes("changes outside run tree:"))).toBe(false);
			// A run may start in a subdirectory. A lead cd'ing to its repository root
			// has not left the run tree and must not produce the foreign-worktree warning.
			const nested = join(repo, "src");
			mkdirSync(nested);
			const session = fakeSession();
			session.file = (name: string) => join(tmp, name);
			const { ctx, notifications } = fakeCtx();
			const deps = fakeDeps({
				planRun: async () => plan,
				dispatchParallel: async (_cwd, _id, tasks) => tasks.map((t) => ({
					taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
					stdout: `STATUS: completed\nRan: cd ${repo} && read files`, stderr: "",
					usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
					durationMs: 1, costUsd: 0, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
				})),
			});
			const result = await runOrchestration(runId, nested, fakeArgs(), fakeAdapter(), fakeResolution(fakeAdapter()), ctx, session, { ...claimed, session }, deps);
			expect(result.kind).toBe("completed");
			if (result.kind === "completed") expect(result.report.outOfTreeChangesLine).toBeNull();
			expect(notifications.some((n) => n.text.includes("changes outside run tree:"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("pipeline/run-orchestration.ts runOrchestration QA skip when no lead succeeded (C4)", () => {
	test("every lead failing dispatches no QA agent, and the summary says verification was skipped because no lead succeeded", async () => {
		const runId = "ht-orch-1700000000000-allfailed";
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
		const dispatchedCapabilities: string[] = [];
		const deps = fakeDeps({
			planRun: async () => plan,
			// The lead itself fails (exit 1) but reports files changed — the exact
			// shape of the incident this regression guards: a failed lead's partial,
			// unreported work must never reach QA.
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				dispatchedCapabilities.push(...tasks.map((t) => t.capability));
				return tasks.map((t) => ({
					taskId: t.taskId,
					capability: t.capability,
					model: "p/lead",
					exitCode: 1,
					stdout: "boom mid-way through",
					stderr: "lead crashed",
					usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
					durationMs: 1,
					costUsd: 0,
					nestedCostUsd: 0,
					costReported: true,
					outcome: "failed" as const,
					filesChanged: ["src/a.ts"],
				}));
			},
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
		expect(dispatchedCapabilities).not.toContain("qa_agent");
		if (result.kind === "completed") {
			expect(result.report.dispatchOk).toBe(false);
			expect(result.report.outOfTreeChangesLine).toBeNull(); // no git observation; don't trust scraped claims
			expect(result.report.verificationSkipped).toBe(false);
			expect(result.report.passedVerification).toBe(false);
			const { text } = buildRunSummary(result.report);
			expect(text).toContain("verification: NOT RUN (no lead succeeded)");
		}
	});
});

describe("pipeline/run-orchestration.ts runOrchestration lead resume after a transient provider failure (C3)", () => {
	function resumePlan(runId: string): PlanResponse {
		return {
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
	}

	test("a lead that fails once with a transient (503) error then succeeds on resume: run completes, resumedLeadIds populated, both attempts billed, and the summary shows a resumes line", async () => {
		const runId = "ht-orch-1700000000000-resume-a";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		let leadCalls = 0;
		let completedSummary: Record<string, unknown> | undefined;
		const deps = fakeDeps({
			planRun: async () => resumePlan(runId),
			completeRun: async (_runId, summary) => {
				completedSummary = summary;
				return healthyTelemetry;
			},
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				if (tasks[0].capability !== "lead") return tasks.map((t) => ({
					taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 0,
					stdout: "PASS", stderr: "", usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
					durationMs: 1, costUsd: 0, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
				}));
				leadCalls++;
				if (leadCalls === 1) {
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 1,
						stdout: "", stderr: "Service unavailable: Bedrock is unable to process your request.",
						usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
						durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "failed" as const, filesChanged: [],
					}));
				}
				return tasks.map((t) => ({
					taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
					stdout: "STATUS: completed\n\nFiles Changed: None", stderr: "",
					usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
					durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
				}));
			},
		});

		const result = await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);

		expect(leadCalls).toBe(2);
		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(result.report.dispatchOk).toBe(true);
		expect(completedSummary?.verification_passed).toBe(true);
		expect(completedSummary?.fix_rounds).toBe(completedSummary?.retries);
		expect(typeof completedSummary?.fix_rounds).toBe("number");
		expect(result.report.resumedLeadIds).toEqual(["lead-0"]);
		// (e) A resume is not a verification retry: the QA retry counter is untouched.
		expect(result.report.retries).toBe(0);
		// (f) Both lead attempts billed exactly once each: 2 model_call-equivalent
		// dispatch results (no QA dispatch happens: both leads report no files changed).
		expect(result.report.dispatchCount).toBe(2);
		const { text } = buildRunSummary(result.report);
		expect(text).toContain("resumes: 1 (lead-0)");
	});

	test("a lead that fails transiently twice: exactly 2 lead dispatches, run FAILED, resumes line still present (the resume attempt happened even though it also failed)", async () => {
		const runId = "ht-orch-1700000000000-resume-b";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		let leadCalls = 0;
		const deps = fakeDeps({
			planRun: async () => resumePlan(runId),
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				if (tasks[0].capability !== "lead") return [];
				leadCalls++;
				return tasks.map((t) => ({
					taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 1,
					stdout: "", stderr: "Service unavailable: Bedrock is unable to process your request.",
					usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
					durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "failed" as const, filesChanged: [],
				}));
			},
		});

		const result = await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);

		expect(leadCalls).toBe(2);
		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(result.report.dispatchOk).toBe(false);
		expect(result.report.resumedLeadIds).toEqual(["lead-0"]);
		const { text } = buildRunSummary(result.report);
		expect(text.startsWith("Orchestration FAILED")).toBe(true);
		expect(text).toContain("resumes: 1 (lead-0)");
	});
});

describe("pipeline/run-orchestration.ts runOrchestration lead escalation retry succeeding (bug fix: final attempt, not first, decides the lead's status)", () => {
	test("lead-0 fails (exit 1), lead-1 succeeds, QA fails naming checks, escalation retries lead-0 as lead-0-retry-1 which succeeds, QA #2 passes: report shows every lead succeeded, no first-failure line, and an attempt line for lead-0", async () => {
		const runId = "ht-orch-1700000000000-escalate";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const plan: PlanResponse = {
			plan_id: "plan-123456789012",
			run_id: runId,
			task_class: "investigation", // exempt from Rule-2 recon (method.json skip_for_task_classes) so the fake dispatcher only has to model architect/lead/qa
			complexity: 8,
			risk: "medium",
			topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" },
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
		const usage = { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 };
		let qaCalls = 0;
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				const cap = tasks[0]?.capability;
				if (cap === "architect") {
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/architect", exitCode: 0,
						stdout: "## Lead assignments\nLead 1: backend (depends on: none)\nLead 2: frontend (depends on: none)\n",
						stderr: "", usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
					}));
				}
				if (cap === "qa_agent") {
					qaCalls++;
					const stdout = qaCalls === 1 ? "## Verdict\nFAIL\n\nnaming checks failed." : "## Verdict\nPASS\n";
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 0, stdout, stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
					}));
				}
				// Lead capability: either the initial 2-lead wave, or the lead-0 escalation retry.
				if (tasks.some((t) => t.taskId.includes("-retry-"))) {
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
						stdout: "STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"],
					}));
				}
				return tasks.map((t) => {
					if (t.taskId.endsWith("-lead-0")) {
						return {
							taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 1,
							stdout: "boom mid-way through", stderr: "lead crashed",
							usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "failed" as const, filesChanged: ["src/a.ts"],
						};
					}
					return {
						taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
						stdout: "STATUS: completed\n\n## Files Changed\n- `src/b.ts`", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/b.ts"],
					};
				});
			},
		});

		const result = await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(qaCalls).toBe(2);
		expect(result.report.succeededLeads).toBe(result.report.totalLeads);
		expect(result.report.totalLeads).toBe(2);
		expect(result.report.dispatchOk).toBe(true);
		expect(result.report.leadAttemptLines).toEqual(["lead-0: failed (exit 1) \u2192 retry-1 succeeded"]);
		const { text } = buildRunSummary(result.report);
		expect(text).toContain("lead-0: failed (exit 1) \u2192 retry-1 succeeded");
		expect(text).not.toContain("first failure:");
	});

	test("A2 regression: both leads succeed originally, QA #1 fails with an undeterminable (non-overlapping) check so escalation hedges and retries EVERY lead, lead-1's retry fails but lead-0's retry succeeds, QA #2 passes: verdict is PASS, succeededLeads is 2, no 'NOT RUN' text", async () => {
		const runId = "ht-orch-1700000000000-escalate-all";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const plan: PlanResponse = {
			plan_id: "plan-123456789013",
			run_id: runId,
			task_class: "investigation",
			complexity: 8,
			risk: "medium",
			topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" },
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
		const usage = { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 };
		let qaCalls = 0;
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				const cap = tasks[0]?.capability;
				if (cap === "architect") {
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/architect", exitCode: 0,
						stdout: "## Lead assignments\nLead 1: backend (depends on: none)\nLead 2: frontend (depends on: none)\n",
						stderr: "", usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
					}));
				}
				if (cap === "qa_agent") {
					qaCalls++;
					// QA #1 names a generic failing check ("verdict") that overlaps neither lead's files —
					// undeterminable from the verification output alone, so `leadsToRetry` hedges and
					// retries EVERY lead, including the two that already succeeded.
					const stdout = qaCalls === 1 ? "## Verdict\nFAIL\n\nnaming checks failed." : "## Verdict\nPASS\n";
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 0, stdout, stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
					}));
				}
				// Lead capability: either the initial 2-lead wave (both succeed), or the escalation
				// retry wave (lead-0's retry succeeds, lead-1's retry fails).
				if (tasks.some((t) => t.taskId.includes("-retry-"))) {
					return tasks.map((t) => {
						if (t.taskId.includes("-lead-1-")) {
							return {
								taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 1,
								stdout: "boom during retry", stderr: "lead crashed on retry",
								usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "failed" as const, filesChanged: [],
							};
						}
						return {
							taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
							stdout: "STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
							usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"],
						};
					});
				}
				return tasks.map((t) => {
					if (t.taskId.endsWith("-lead-0")) {
						return {
							taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
							stdout: "STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
							usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"],
						};
					}
					return {
						taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
						stdout: "STATUS: completed\n\n## Files Changed\n- `src/b.ts`", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/b.ts"],
					};
				});
			},
		});

		const result = await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(qaCalls).toBe(2);
		expect(result.report.succeededLeads).toBe(2);
		expect(result.report.totalLeads).toBe(2);
		expect(result.report.passedVerification).toBe(true);
		const { text } = buildRunSummary(result.report);
		expect(text).toContain("verification: PASS");
		expect(text).not.toContain("NOT RUN");
	});
});

describe("pipeline/run-orchestration.ts runOrchestration escalation feedback/selection uses the LATEST attempt, not the original leadResults (A2 review fix)", () => {
	test("QA fails twice with maxRetries 2: retry-2's prompt carries retry-1's stdout as feedback (not the original report), and lead-1 (whose retry-1 succeeded with no overlap) is not re-selected on round 2 when lead-0's retry-1 failed", async () => {
		const runId = "ht-orch-1700000000000-escalate-latest";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const plan: PlanResponse = {
			plan_id: "plan-123456789099",
			run_id: runId,
			task_class: "investigation",
			complexity: 8,
			risk: "medium",
			topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" },
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
		const usage = { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 };
		let qaCalls = 0;
		const capturedTasks: Array<{ taskId: string; task: string }> = [];
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				for (const t of tasks) capturedTasks.push({ taskId: t.taskId, task: t.task });
				const cap = tasks[0]?.capability;
				if (cap === "architect") {
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/architect", exitCode: 0,
						stdout: "## Lead assignments\nLead 1: backend (depends on: none)\nLead 2: frontend (depends on: none)\n",
						stderr: "", usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
					}));
				}
				if (cap === "qa_agent") {
					qaCalls++;
					// Deliberately generic/undeterminable: names no specific file, so `leadsToRetry`'s
					// only handle is `failedDispatch` (each lead's latest exit code) -- never `overlap`.
					const stdout = qaCalls < 3 ? "## Verdict\nFAIL\n\ngeneric failure, no specific files named." : "## Verdict\nPASS\n";
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 0, stdout, stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
					}));
				}
				// Round 2 escalation retry: only lead-0 should ever be dispatched here (lead-1's
				// retry-1 succeeded with no overlap and must not be re-selected).
				if (tasks.some((t) => t.taskId.includes("-retry-2"))) {
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
						stdout: "RETRY2_MARKER_XYZ STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"],
					}));
				}
				// Round 1 escalation retry: QA #1's undeterminable failure hedges and retries BOTH
				// leads. lead-0's retry-1 fails again; lead-1's retry-1 succeeds unchanged.
				if (tasks.some((t) => t.taskId.includes("-retry-1"))) {
					return tasks.map((t) => {
						if (t.taskId.includes("-lead-0-retry-1")) {
							return {
								taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 1,
								stdout: "RETRY1_MARKER_XYZ boom during retry-1", stderr: "lead crashed on retry-1",
								usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "failed" as const, filesChanged: ["src/a.ts"],
							};
						}
						return {
							taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
							stdout: "STATUS: completed\n\n## Files Changed\n- `src/b.ts`", stderr: "",
							usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/b.ts"],
						};
					});
				}
				// Initial wave: both leads succeed.
				return tasks.map((t) => {
					if (t.taskId.endsWith("-lead-0")) {
						return {
							taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
							stdout: "ORIGINAL_MARKER_XYZ STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
							usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"],
						};
					}
					return {
						taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
						stdout: "STATUS: completed\n\n## Files Changed\n- `src/b.ts`", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/b.ts"],
					};
				});
			},
		});

		const result = await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs({ maxRetries: 2 }), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(qaCalls).toBe(3);
		expect(result.report.retries).toBe(2);
		expect(result.report.passedVerification).toBe(true);
		expect(result.report.succeededLeads).toBe(2);
		expect(result.report.totalLeads).toBe(2);

		// Round 2 escalation retried ONLY lead-0 -- lead-1's retry-1 (exit 0, no overlap with
		// QA's generic, non-file-naming failure) must never be re-selected just because QA
		// failed again.
		const lead1Retry2Tasks = capturedTasks.filter((t) => t.taskId.includes("-lead-1-retry-2"));
		expect(lead1Retry2Tasks).toEqual([]);
		const lead0Retry2Task = capturedTasks.find((t) => t.taskId.includes("-lead-0-retry-2"));
		expect(lead0Retry2Task).toBeDefined();

		// Retry-2's prompt carries retry-1's own report as feedback, not the ORIGINAL report --
		// the bug this test guards against fed every later round the stale original report.
		expect(lead0Retry2Task?.task).toContain("RETRY1_MARKER_XYZ");
		expect(lead0Retry2Task?.task).not.toContain("ORIGINAL_MARKER_XYZ");
	});
});

describe("pipeline/run-orchestration.ts runOrchestration QA dispatch timing out (A4)", () => {
	function flatPlan(runId: string): PlanResponse {
		return {
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
	}
	const usage = { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 };

	test("QA #1 times out, re-run passes: run passes, no lead escalation dispatched, retries stay 0", async () => {
		const runId = "ht-orch-1700000000000-qatimeout1";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const plan = flatPlan(runId);
		const dispatchedTaskIds: string[] = [];
		let qaCalls = 0;
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				dispatchedTaskIds.push(...tasks.map((t) => t.taskId));
				const cap = tasks[0]?.capability;
				if (cap === "qa_agent") {
					qaCalls++;
					if (qaCalls === 1) {
						return tasks.map((t) => ({
							taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 1,
							stdout: "| unit | FAIL |\n(killed by timeout)", stderr: "",
							usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "timed_out" as const, filesChanged: [],
						}));
					}
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 0,
						stdout: "## Verdict\nPASS\n", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
					}));
				}
				return tasks.map((t) => ({
					taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
					stdout: "STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
					usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"],
				}));
			},
		});

		const result = await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(qaCalls).toBe(2);
		expect(dispatchedTaskIds).toContain(`${runId}-qa`);
		expect(dispatchedTaskIds).toContain(`${runId}-qa-rerun-1`);
		expect(dispatchedTaskIds.some((id) => id.includes("-retry-"))).toBe(false);
		expect(result.report.retries).toBe(0);
		expect(result.report.verificationTimedOut).toBe(false);
		expect(result.report.passedVerification).toBe(true);
		expect(result.report.failedChecks).toEqual([]);
		const { text, succeeded } = buildRunSummary(result.report);
		expect(succeeded).toBe(true);
		expect(text).toContain("verification: PASS");
	});

	test.each([false, true])("QA provider failure with zero tools re-runs once; second provider failure=%s never reports check FAIL", async (secondFails) => {
		const runId = `ht-orch-1700000000000-qaprovider${secondFails ? "2" : "1"}`;
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const plan = flatPlan(runId);
		const dispatchedTaskIds: string[] = [];
		let qaCalls = 0;
		const outcomes: Record<string, unknown>[] = [];
		// hv4i5g QA event 9: zero-tool provider failure; the stderr from that run
		// repeats this same ENOTFOUND diagnostic, not a test/check failure.
		const qaEvent = JSON.parse(readFileSync(new URL("../fixtures/hv4i5g-qa-provider-error.jsonl", import.meta.url), "utf8"));
		expect(qaEvent._fixture.source).toContain("qa.events.jsonl:9");
		expect(qaEvent.message.usage.input).toBe(0);
		const qaStderr = readFileSync(new URL("../fixtures/hv4i5g-qa-provider-error.stderr.log", import.meta.url), "utf8");
		expect(qaStderr).toContain(qaEvent.message.errorMessage);
		const deps = fakeDeps({
			planRun: async () => plan,
			recordOutcome: (row) => { outcomes.push(row); },
			dispatchParallel: async (_cwd, _id, tasks) => {
				dispatchedTaskIds.push(...tasks.map((t) => t.taskId));
				return tasks.map((t) => {
					if (t.capability === "qa_agent") {
						qaCalls++;
						const failed = qaCalls === 1 || secondFails;
						return { taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: failed ? 1 : 0,
							stdout: failed ? "" : "## Verdict\nPASS", stderr: failed ? qaStderr : "",
							usage, durationMs: 1, costUsd: 0.01, costReported: true, outcome: failed ? "failed" as const : "completed" as const, filesChanged: [] };
					}
					return { taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
						stdout: "STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"] };
				});
			},
		});
		const result = await runOrchestration(runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, fakeResolution(adapter), ctx, session, { ...claimed, session }, deps);
		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(qaCalls).toBe(2);
		expect(dispatchedTaskIds).toContain(`${runId}-qa-rerun-1`);
		expect(dispatchedTaskIds.some((id) => id.includes("-lead-0-retry-"))).toBe(false);
		expect(result.report.failedChecks).toEqual([]);
		expect(outcomes.some((o) => o.task_id === `${runId}-qa` && o.outcome === "fail")).toBe(false);
		if (secondFails) {
			expect(result.report.verificationTimedOut).toBe(false);
			expect(result.report.verificationProviderStall).toBe(true);
			const { text, succeeded } = buildRunSummary(result.report);
			expect(text).toContain("verification: QA PROVIDER STALL (QA dispatch did not complete)");
			expect(text).not.toContain("verification: QA TIMED OUT");
			expect(text).not.toContain("verification: FAIL");
			expect(succeeded).toBe(false);
		} else expect(result.report.passedVerification).toBe(true);
	});

	test("vcy00z nested provider evidence drives lead resume and dependent wave; injected QA timeout re-runs without unit failure", async () => {
		// The lead event is historical; QA's timeout response below is an injected scenario,
		// not a claim that a QA timeout appears in the vcy00z event tail.
		const tail = readFileSync(new URL("../fixtures/vcy00z-lead-0-tail.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
		const nested = tail.at(-1)?.partialResult?.details?.results?.[0];
		expect(nested.errorMessage).toContain("Bedrock stream ended without a stop reason");
		const runId = "ht-orch-1700000000000-vcy00zreplay";
		const session = fakeSession();
		const { ctx } = fakeCtx();
		const adapter = fakeAdapter();
		const plan = { ...flatPlan(runId), complexity: 8, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } } as PlanResponse;
		const batches: string[][] = [];
		let leadAttempts = 0;
		let qaAttempts = 0;
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, tool_calls: 0 };
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async (_cwd, _id, tasks) => {
				batches.push(tasks.map(t => t.taskId));
				return tasks.map(t => {
					const common = { taskId: t.taskId, capability: t.capability, model: "p/lead", usage, durationMs: 1, costUsd: 0, costReported: true, filesChanged: [] };
					if (t.capability === "architect") return { ...common, exitCode: 0, stdout: "## Lead assignments\nLead 1: repair (depends on: none)\nLead 2: dependent (depends on: 1)\n", stderr: "", outcome: "completed" as const };
					if (t.capability === "qa_agent") {
						qaAttempts++;
						return { ...common, exitCode: qaAttempts === 1 ? 1 : 0, stdout: qaAttempts === 1 ? "| unit | FAIL |\n(killed by timeout)" : "## Verdict\nPASS", stderr: "", outcome: qaAttempts === 1 ? "timed_out" as const : "completed" as const };
					}
					if (t.taskId.endsWith("-lead-0") && leadAttempts++ === 0) return { ...common, exitCode: 124, stdout: "", stderr: "[orchestrator] inactivity timeout", outcome: "timed_out" as const, timeoutReason: "inactivity" as const,
						interruption: { taskId: t.taskId, reason: "inactivity_timeout" as const, elapsedMs: 1, sinceLastProgressMs: 1, turns: 1, toolCalls: 1, repeatedToolCalls: 0, lastProgress: "nested worker", nestedWorkers: [{ id: "t11", turns: nested.usage.turns, finished: false, latestText: nested.latestText, errorMessage: nested.errorMessage }], partialText: "", verified: false } };
					return { ...common, exitCode: 0, stdout: "STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "", outcome: "completed" as const, filesChanged: ["src/a.ts"] };
				});
			},
		});
		const output = await runOrchestration(runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, fakeResolution(adapter), ctx, session, { ...claimed, session }, deps);
		expect(output.kind).toBe("completed");
		if (output.kind !== "completed") return;
		expect(batches.slice(-4)).toEqual([[`${runId}-lead-0`], [`${runId}-lead-1`], [`${runId}-qa`], [`${runId}-qa-rerun-1`]]);
		expect(leadAttempts).toBe(2);
		expect(qaAttempts).toBe(2);
		expect(output.report.resumedLeadIds).toContain("lead-0");
		expect(output.report.failedChecks).not.toContain("unit");
		expect(output.report.passedVerification).toBe(true);
		const { text } = buildRunSummary(output.report);
		expect(text).toContain("verification: PASS");
		expect(text).not.toContain("verification failed: `unit`");
	});

	test("injected QA timeout seam (not fixture replay): two timed-out QA attempts are counted, but unit is not a failed check", async () => {
		const runId = "ht-orch-1700000000000-qatimeout2";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const plan = flatPlan(runId);
		const dispatchedTaskIds: string[] = [];
		let qaCalls = 0;
		const deps = fakeDeps({
			planRun: async () => plan,
			dispatchParallel: async (_cwd, _runId2, tasks) => {
				dispatchedTaskIds.push(...tasks.map((t) => t.taskId));
				const cap = tasks[0]?.capability;
				if (cap === "qa_agent") {
					qaCalls++;
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "p/qa", exitCode: 1,
						stdout: "| unit | FAIL |\n(killed by timeout)", stderr: "",
						usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "timed_out" as const, filesChanged: [],
					}));
				}
				return tasks.map((t) => ({
					taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
					stdout: "STATUS: completed\n\n## Files Changed\n- `src/a.ts`", stderr: "",
					usage, durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: ["src/a.ts"],
				}));
			},
		});

		const result = await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs(), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") return;
		expect(qaCalls).toBe(2);
		expect(dispatchedTaskIds).toContain(`${runId}-qa`);
		expect(dispatchedTaskIds).toContain(`${runId}-qa-rerun-1`);
		expect(dispatchedTaskIds.some((id) => id.includes("-retry-"))).toBe(false);
		// The QA re-run is counted as a dispatch, not as a lead escalation retry.
		expect(result.report.dispatchCount).toBe(3); // one lead + two QA attempts
		expect(dispatchedTaskIds).toEqual([`${runId}-lead-0`, `${runId}-qa`, `${runId}-qa-rerun-1`]);
		expect(result.report.retries).toBe(0);
		expect(result.report.verificationTimedOut).toBe(true);
		expect(result.report.passedVerification).toBe(false);
		expect(result.report.failedChecks).toEqual([]);
		const { text, succeeded } = buildRunSummary(result.report);
		expect(succeeded).toBe(false);
		expect(text).toContain("verification: QA TIMED OUT");
		expect(text).not.toContain("unit");
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

describe("pipeline/run-orchestration.ts runOrchestration: efficiency warnings", () => {
	test("removed scoped_leads env warns at run start", async () => {
		const session = fakeSession();
		const { ctx, notifications } = fakeCtx();
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const recordedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const deps = fakeDeps({
			env: { HUMAIN_ORCHESTRATOR_EFFICIENCY_SCOPED_LEADS: "on" },
			recordEvent: (event, payload) => { recordedEvents.push({ event, payload }); },
			planRun: async () => {
				throw new Error("stop here -- the switch check under test runs before this");
			},
			failRun: async () => healthyTelemetry,
		});

		await runOrchestration(
			"ht-orch-1700000000000-effswitch",
			"/tmp/cwd",
			fakeArgs(),
			adapter,
			resolved,
			ctx,
			session,
			{ ...claimed, session },
			deps,
		);

		expect(notifications).toContainEqual({ text: "HUMAIN_ORCHESTRATOR_EFFICIENCY_SCOPED_LEADS was removed; ignoring", level: "warning" });
		expect(recordedEvents.some((e) => e.event === "efficiency_switch_unsupported")).toBe(false);
	});

	test("report mode is supported; removed recon switch warns", async () => {
		const session = fakeSession();
		const { ctx, notifications } = fakeCtx();
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const recordedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const deps = fakeDeps({
			env: {
				HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP: "report",
				HUMAIN_ORCHESTRATOR_EFFICIENCY_RECON_BEFORE_ARCHITECT: "on",
			},
			recordEvent: (event, payload) => { recordedEvents.push({ event, payload }); },
			planRun: async () => {
				throw new Error("stop here -- the switch check under test runs before this");
			},
			failRun: async () => healthyTelemetry,
		});

		await runOrchestration(
			"ht-orch-1700000000000-effswitch2",
			"/tmp/cwd",
			fakeArgs(),
			adapter,
			resolved,
			ctx,
			session,
			{ ...claimed, session },
			deps,
		);

		expect(notifications.some((n) => n.text.includes("RECON_BEFORE_ARCHITECT") && n.text.includes("removed"))).toBe(true);
		expect(notifications.some((n) => n.text.includes("file_ownership"))).toBe(false);
		expect(recordedEvents.some((e) => e.event === "efficiency_switch_unsupported")).toBe(false);
	});

	test("no unsupported switch enabled (default env) never warns or records efficiency_switch_unsupported", async () => {
		const session = fakeSession();
		const { ctx, notifications } = fakeCtx();
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const recordedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const deps = fakeDeps({
			recordEvent: (event, payload) => { recordedEvents.push({ event, payload }); },
			planRun: async () => {
				throw new Error("boom");
			},
			failRun: async () => healthyTelemetry,
		});

		await runOrchestration(
			"ht-orch-1700000000000-effswitch3",
			"/tmp/cwd",
			fakeArgs(),
			adapter,
			resolved,
			ctx,
			session,
			{ ...claimed, session },
			deps,
		);

		expect(notifications.some((n) => n.text.includes("efficiency_switch_unsupported") || n.text.includes("not supported"))).toBe(false);
		expect(recordedEvents.some((e) => e.event === "efficiency_switch_unsupported")).toBe(false);
	});
});

describe("pipeline/run-orchestration.ts runOrchestration workflow observe mode", () => {
	async function runWith(env: Record<string, string>, workflowSetting?: string) {
		const runId = "ht-orch-1700000000000-wf-a";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		if (workflowSetting !== undefined) {
			(resolved as unknown as { profiles: { file: Record<string, unknown> } }).profiles.file = { version: 1, active_profile: "test-profile", profiles: {}, workflow_mode: workflowSetting };
		}
		const events: Array<[string, Record<string, unknown>]> = [];
		let summary: Record<string, unknown> | undefined;
		const deps = fakeDeps({
			env,
			planRun: async () => ({
				plan_id: "plan-123456789012", run_id: runId, task_class: "bugfix", complexity: 3, risk: "medium",
				topology: { depth: 1, leads: 1, workers: 0, shape: "flat" },
				route: {
					selected: { capability: "lead", effort: "medium", verification_depth: "standard" },
					recommended: { capability: "lead", effort: "medium", verification_depth: "standard" },
					mode: "auto", history_sufficient: true, explanation: {},
				},
				effective_quality_floor: 0.5,
				cost_aggressiveness: 0.5,
			}),
			recordEvent: (e, p) => { events.push([e, p]); },
			completeRun: async (_id, s) => { summary = s; return healthyTelemetry; },
			dispatchParallel: async (_cwd, _runId2, tasks) => tasks.map((t) => ({
				taskId: t.taskId, capability: t.capability, model: "p/lead", exitCode: 0,
				stdout: t.capability === "lead" ? "STATUS: completed\n\nFiles Changed: None" : "PASS", stderr: "",
				usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
				durationMs: 1, costUsd: 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const, filesChanged: [],
			})),
		});
		await runOrchestration(
			runId, "/tmp/cwd-not-a-git-repo", fakeArgs({ goal: "Fix src/a.ts" }), adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);
		return { events, summary };
	}

	test("observe mode records workflow_level_planned and a workflow summary without changing dispatch", async () => {
		const { events, summary } = await runWith({ HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "observe" });
		const planned = events.find(([e]) => e === "workflow_level_planned");
		expect(planned?.[1].mode).toBe("observe");
		expect((summary?.workflow as { mode: string }).mode).toBe("observe");
		expect(events.some(([e]) => e === "dispatch_plan_confirmed")).toBe(true);
	});

	test("the persisted orchestrator-profiles.json workflow_mode enables observe without any env var", async () => {
		const { events, summary } = await runWith({}, "observe");
		const planned = events.find(([e]) => e === "workflow_level_planned");
		expect(planned?.[1].mode).toBe("observe");
		expect(planned?.[1].mode_source).toBe("setting");
		expect((summary?.workflow as { mode: string }).mode).toBe("observe");
	});

	test("the env var still overrides the persisted setting", async () => {
		const { events, summary } = await runWith({ HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "off" }, "observe");
		expect(events.map(([e]) => e)).not.toContain("workflow_level_planned");
		expect(summary !== undefined && "workflow" in summary).toBe(false);
	});

	test("off mode emits no workflow event and no workflow summary key", async () => {
		const { events, summary } = await runWith({});
		expect(events.map(([e]) => e)).not.toContain("workflow_level_planned");
		expect(summary !== undefined && "workflow" in summary).toBe(false);
	});
});

describe("pipeline/run-orchestration.ts runOrchestration workflow enforce mode", () => {
	const IMPL_REPORT = "done\n## Files Changed\n- src/util/format.ts\n\nSTATUS: completed";
	// Real temp git repo + sync git calls: fresh-repo `git add -A` was measured stalling >5s on
	// slow hosts, so these tests need an explicit timeout above bun's 5s default.
	const GIT_IO_TIMEOUT_MS = 30_000;
	let repo = "";
	afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); repo = ""; });

	function makeRepo(extra: Record<string, string> = {}): string {
		const dir = mkdtempSync(join(tmpdir(), "wf-enforce-"));
		try {
		const files: Record<string, string> = {
			"package.json": '{"scripts":{"test":"bun test"}}',
			"bun.lock": "",
			"src/util/format.ts": "export const f = 1;\n",
			"src/util/format.test.ts": "export {};\n",
			...extra,
		};
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(join(dir, rel, ".."), { recursive: true });
			writeFileSync(join(dir, rel), body);
		}
		const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" });
		git("init");
		git("add", "-A");
		git("commit", "-m", "init");
		return dir;
		} catch (err) {
			rmSync(dir, { recursive: true, force: true });
			throw err;
		}
	}

	const passing = async () => [{ name: "test", argv: ["bun", "test"], status: "pass" as const, exitCode: 0, durationMs: 1, tail: "" }];
	const failing = async () => [{ name: "test", argv: ["bun", "test"], status: "fail" as const, exitCode: 1, durationMs: 1, tail: "1 failed" }];

	async function runWith(opts: {
		args?: Partial<OrchestrateArgs>;
		runChecks?: RunOrchestrationDeps["runChecks"];
		extraFiles?: Record<string, string>;
		onLead?: (repo: string) => void;
		qaStdout?: string;
	}) {
		repo = makeRepo(opts.extraFiles);
		const runId = "ht-orch-1700000000000-wf-e";
		const session = fakeSession();
		const { ctx } = fakeCtx({ confirm: () => Promise.resolve(true) });
		const adapter = fakeAdapter();
		const resolved = fakeResolution(adapter);
		const events: Array<[string, Record<string, unknown>]> = [];
		const dispatched: string[] = [];
		const tasks: DispatchTask[] = [];
		let summary: Record<string, unknown> | undefined;
		let completes = 0;
		let dispatchCostUsd = 0;
		const deps = fakeDeps({
			env: { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "enforce" },
			runChecks: opts.runChecks,
			planRun: async () => ({
				plan_id: "plan-123456789012", run_id: runId, task_class: "bugfix", complexity: 2, risk: "low",
				topology: { depth: 1, leads: 1, workers: 0, shape: "flat" },
				route: {
					selected: { capability: "lead", effort: "medium", verification_depth: "standard" },
					recommended: { capability: "lead", effort: "medium", verification_depth: "standard" },
					mode: "auto", history_sufficient: true, explanation: {},
				},
				effective_quality_floor: 0.5,
				cost_aggressiveness: 0.5,
			}),
			recordEvent: (e, p) => { events.push([e, p]); },
			completeRun: async (_id, s) => { summary = s; completes++; return healthyTelemetry; },
			dispatchParallel: async (_cwd, _r, ts) => ts.map((t) => {
				dispatched.push(t.capability);
				tasks.push(t);
				const impl = t.capability === "implementation_strong";
				if (t.capability.startsWith("lead")) opts.onLead?.(repo);
				dispatchCostUsd += impl ? 0.25 : 0.01;
				if (impl) appendFileSync(join(repo, "src/util/format.ts"), `export const g${dispatched.length} = 1;\n`);
				return {
					taskId: t.taskId, capability: t.capability, model: "p/x", exitCode: 0,
					stdout: impl ? IMPL_REPORT : t.capability.startsWith("lead") ? "STATUS: completed\n\nFiles Changed: None" : (opts.qaStdout ?? "PASS"), stderr: "",
					usage: { turns: 0, tool_calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
					durationMs: 1, costUsd: impl ? 0.25 : 0.01, nestedCostUsd: 0, costReported: true, outcome: "completed" as const,
					filesChanged: impl ? ["src/util/format.ts"] : [],
				};
			}),
		});
		const result = await runOrchestration(
			runId, repo,
			fakeArgs({ goal: "Fix src/util/format.ts", taskClass: "bugfix", complexity: 2, risk: "low", ...opts.args }),
			adapter, resolved, ctx, session, { ...claimed, session }, deps,
		);
		return { events, dispatched, tasks, summary, completes, result, dispatchCostUsd };
	}

	test("enforce direct: implementer + passing checks completes without leads or QA agent", async () => {
		const { dispatched, summary, events } = await runWith({ runChecks: passing });
		expect(dispatched).toEqual(["implementation_strong"]);
		expect((summary!.workflow as { final: string }).final).toBe("direct");
		expect(summary!.verification_passed).toBe(true);
		expect(events.map(([e]) => e)).not.toContain("workflow_level_escalated");
	}, GIT_IO_TIMEOUT_MS);

	test("enforce direct: persistent failure escalates to led, keeps QA scope and prior cost", async () => {
		const { dispatched, tasks, summary, events, completes } = await runWith({ runChecks: failing });
		expect(dispatched.slice(0, 2)).toEqual(["implementation_strong", "implementation_strong"]);
		expect(dispatched).toContain("qa_agent");
		const qa = tasks.find((t) => t.capability === "qa_agent");
		expect(qa!.task).toContain("src/util/format.ts");
		expect(events.map(([e]) => e)).toContain("workflow_level_escalated");
		const wf = summary!.workflow as { planned: string; final: string; escalations: number };
		expect([wf.planned, wf.final, wf.escalations]).toEqual(["direct", "led", 1]);
		expect(summary!.total_cost_usd as number).toBeGreaterThanOrEqual(0.5);
		expect(summary!.fix_rounds as number).toBeGreaterThanOrEqual(1);
		expect(completes).toBe(1);
	}, GIT_IO_TIMEOUT_MS);

	test("escalated led run that reverts the flat changes is not reported as verified", async () => {
		const { summary, result, dispatched } = await runWith({
			runChecks: failing,
			onLead: (r) => execFileSync("git", ["checkout", "--", "src/util/format.ts"], { cwd: r, stdio: "ignore" }),
		});
		expect(dispatched.some((c) => c.startsWith("lead"))).toBe(true);
		expect(summary!.verification_passed).toBe(false);
		expect(result.kind).toBe("completed");
		const report = (result as { report: { passedVerification: boolean } }).report;
		expect(report.passedVerification).toBe(false);
	}, GIT_IO_TIMEOUT_MS);

	test("escalated led retry rescope keeps the flat attempt's files when git observation is unavailable", async () => {
		const { summary } = await runWith({
			args: { maxRetries: 2 },
			runChecks: failing,
			qaStdout: "## Verdict\nFAIL\n- test",
			// Destroying .git during the led phase makes every later git snapshot fail, so scope
			// falls back to claimed file paths (flat attempt claims live in carry.priorResults).
			onLead: (r) => rmSync(join(r, ".git"), { recursive: true, force: true }),
		});
		expect(summary!.fix_rounds as number).toBeGreaterThanOrEqual(2);
		expect(summary!.files_changed as string[]).toContain("src/util/format.ts");
	}, GIT_IO_TIMEOUT_MS);

	test("escalated led QA that exits 0 with no check evidence is not reported as verified", async () => {
		const { summary, result } = await runWith({ runChecks: failing, qaStdout: "all good" });
		expect(summary!.verification_passed).toBe(false);
		expect(result.kind).toBe("completed");
		const report = (result as { report: { passedVerification: boolean } }).report;
		expect(report.passedVerification).toBe(false);
	}, GIT_IO_TIMEOUT_MS);

	test("escalated run report.retries equals summary.fix_rounds and includes the prior round", async () => {
		const { summary, result } = await runWith({ runChecks: failing });
		const report = (result as { report: { retries: number } }).report;
		expect(summary!.fix_rounds as number).toBeGreaterThanOrEqual(1);
		expect(report.retries).toBe(summary!.fix_rounds as number);
	}, GIT_IO_TIMEOUT_MS);

	test("escalated run total cost equals the sum of every dispatch cost", async () => {
		const { summary, dispatchCostUsd } = await runWith({ runChecks: failing });
		expect(summary!.total_cost_usd as number).toBeCloseTo(dispatchCostUsd, 6);
	}, GIT_IO_TIMEOUT_MS);

	test("enforce never runs flat for excluded task classes", async () => {
		const { dispatched } = await runWith({ args: { taskClass: "investigation" }, runChecks: passing });
		expect(dispatched).not.toContain("implementation_strong");
	}, GIT_IO_TIMEOUT_MS);

	test("enforce never runs flat for a risk-path goal even with --workflow direct", async () => {
		const { dispatched, summary } = await runWith({
			args: { goal: "Fix src/auth/login.ts", workflowLevel: "direct" },
			extraFiles: { "src/auth/login.ts": "export const a = 1;\n" },
			runChecks: passing,
		});
		expect(dispatched[0]).not.toBe("implementation_strong");
		const wf = summary!.workflow as { planned: string; final: string };
		expect([wf.planned, wf.final]).toEqual(["full", "full"]);
	}, GIT_IO_TIMEOUT_MS);
});

import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionIngestScheduler } from "./ingest.ts";
import { planReconTasks } from "./recon.ts";
import { METHOD, TIER_CAPABILITIES, buildAliasTable } from "./models.ts";
import type { DispatchResult, DispatchTask } from "./index.ts";
import { RunCancellation } from "./cancellation.ts";
import { MAX_CHILD_STDERR_DISK_BYTES } from "./dispatch/stderr-sink.ts";
import contract from "./contract.json";
import { planEscalation } from "./escalation.ts";
import { pickModel } from "./core/routing.ts";

mock.module("@humain/terminal", () => ({
	BorderedLoader: class {
		onAbort?: () => void;
		constructor(..._args: unknown[]) {}
	},
	// Mirrors the real bridge/agents/ personas the dispatcher resolves by name:
	// a write-capable implementer, and the read-only scout Rule-2 recon binds to.
	// orch-scout carries a non-empty body so the --append-system-prompt path (and
	// its temp-file cleanup) is exercised rather than skipped. Every other agent
	// name still resolves to nothing, which is what main's tests assume.
	discoverAgents: () => ({ agents: [
		{ name: "orch-implementation-fast", tools: ["read", "write", "edit", "bash"], systemPrompt: "" },
		{ name: "orch-scout", tools: ["read", "grep", "find", "ls", "bash"], systemPrompt: "scout persona" },
	] }),
	renderTaskWithContext: (task: string) => task,
}));

// Capture env that runModule forwards to spawned children. Existing tests rely
// on real spawn behavior, so the mock forwards to the real implementation
// outside of capture mode.
let captureRunModuleEnv = false;
const capturedRunModuleEnvs: NodeJS.ProcessEnv[] = [];
mock.module("node:child_process", () => {
	const real = require("node:child_process");
	const fakeSpawn = ((command: any, args: any, options: any) => {
		if (captureRunModuleEnv) capturedRunModuleEnvs.push(options?.env ?? {});
		return real.spawn(command, args, options);
	}) as typeof real.spawn;
	return { ...real, spawn: fakeSpawn };
});

// TypeBox isn't installed in this standalone bridge checkout (no package.json/node_modules of
// its own — see scripts/typecheck-bridge.sh). The real package is only reachable when HT loads
// the extension from inside its own workspace. This stub provides just enough of the `Type`
// namespace for `registerOrchestratorStatusTool`'s schema construction; nothing in these tests
// runs TypeBox's validator against it, so structural fidelity beyond that is unnecessary.
mock.module("typebox", () => {
	const schema = (extra: Record<string, unknown>) => (options?: Record<string, unknown>) => ({ ...extra, ...options });
	return {
		Type: {
			Object: (properties: unknown, options?: Record<string, unknown>) => ({ type: "object", properties, ...options }),
			Optional: (inner: unknown) => ({ ...(inner as object), optional: true }),
			Number: schema({ type: "number" }),
			String: schema({ type: "string" }),
			Boolean: schema({ type: "boolean" }),
		},
	};
});

const testStateRoot = mkdtempSync(join(tmpdir(), "orch-run-session-test-"));
process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT = testStateRoot;
process.env.HUMAIN_ORCHESTRATOR_PROFILES_FILE = join(testStateRoot, "profiles.json");
process.env.HUMAIN_ORCHESTRATOR_ADAPTER_FILE = join(testStateRoot, "adapter.json");
// Python spawned by the bridge must import THIS worktree's package, never the installed skill
// checkout, and must write to a temp state root, never the live ~/.local/state root.
process.env.HUMAIN_ORCHESTRATOR_SKILL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
process.env.PYTHONDONTWRITEBYTECODE = "1";
// Main forwards the bridge state root to every Python call, including batches.
const pythonStateRoot = testStateRoot;
process.env.CODING_AGENT_ORCHESTRATOR_HOME = pythonStateRoot;
const orchestrator = await import("./index.ts");
afterAll(() => {
	rmSync(testStateRoot, { recursive: true, force: true });
});

// B4.4: activeRunForTest()/setActiveRunForTest() were free functions reading/
// writing the (now-deleted) ACTIVE_RUN global. `orchestrator.runRegistry` is
// the module's one allowed piece of state now; these helpers give tests the
// same two operations, built only from the registry's real claim()/release()
// API — release() always succeeds here because it is handed back exactly the
// context active() just returned, so identity trivially matches.
function activeSession(): InstanceType<typeof orchestrator.RunSession> | null {
	return orchestrator.runRegistry.active()?.session ?? null;
}
function forceActiveSession(session: InstanceType<typeof orchestrator.RunSession> | null): void {
	const current = orchestrator.runRegistry.active();
	if (current) orchestrator.runRegistry.release(current);
	if (session) orchestrator.runRegistry.claim(session, {}, null);
}

describe("session ingest hook wiring (index.ts wiring)", () => {
	test("registered settled hook runs real debounced CLI ingestion and replay refreshes without duplicates", async () => {
		const sessionRoot = mkdtempSync(join(tmpdir(), "orch-hook-session-"));
		try {
			const sessionDir = join(sessionRoot, "sessions", "--Users-test-Projects-app--");
			mkdirSync(sessionDir, { recursive: true });
			const sessionFile = join(sessionDir, "turn.jsonl");
			const marker = "MARKER_DO_NOT_LEAK_7f3a";
			writeFileSync(sessionFile, [
				{ type: "session", id: "event-session" },
				{
					type: "message", id: "assistant-1", timestamp: "2026-09-23T10:00:00Z",
					message: {
						role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: marker }],
						usage: { input: 40, output: 8, totalTokens: 48 },
					},
				},
			].map((row) => JSON.stringify(row)).join("\n") + "\n");

			const handlers: Record<string, (...args: any[]) => unknown> = {};
			const api = new Proxy({
				on: (event: string, handler: (...args: any[]) => unknown) => { handlers[event] = handler; },
			}, {
				get(target, property: string) {
					return property in target ? target[property as "on"] : () => {};
				},
			});
			orchestrator.default!(api as never);
			expect(handlers.agent_settled).toBeFunction();
			const context = { sessionManager: { getSessionFile: () => sessionFile } };
			// `cli.process_ingest` writes ingest_status.json, then `refresh()` renames dashboard.html
			// into place and finally writes dashboard.version.json, a receipt of each stream's
			// [st_dev, st_ino, st_size, st_mtime_ns]. A new status alone does not prove the dashboard
			// was regenerated, so wait until the receipt attests the ingest_status.json we just read.
			// st_mtime_ns exceeds 2^53, so compare against the raw receipt text with bigint stats.
			const dashboardAttestsStatus = () => {
				const statusStat = statSync(join(testStateRoot, "ingest_status.json"), { bigint: true });
				const expected = `"ingest_status.json":[${statusStat.dev},${statusStat.ino},${statusStat.size},${statusStat.mtimeNs}]`;
				const receipt = readFileSync(join(testStateRoot, "dashboard.version.json"), "utf8").replace(/\s+/g, "");
				return receipt.includes(expected) && statSync(join(testStateRoot, "dashboard.html")).size > 0;
			};
			const waitForMaterialization = async (previousAttempt?: string) => {
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					try {
						const status = JSON.parse(readFileSync(join(testStateRoot, "ingest_status.json"), "utf8"));
						if (status.status === "ok" && status.last_attempt_at !== previousAttempt &&
							dashboardAttestsStatus()) return status;
					} catch {
						// Wait for the debounced CLI to create its materialized files.
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				throw new Error("settled-session ingest did not materialize within 10 seconds");
			};

			await handlers.agent_settled({}, context);
			const firstStatus = await waitForMaterialization();
			const metricsPath = join(testStateRoot, "metrics.jsonl");
			const metricRows = readFileSync(metricsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(metricRows).toHaveLength(1);
			expect(metricRows[0].covers_calls).toBe(1);
			expect(firstStatus.emitted).toBe(1);
			expect(readFileSync(join(testStateRoot, "ledger.json"), "utf8")).toBeTruthy();
			expect(readFileSync(join(testStateRoot, "dashboard.html"), "utf8")).toContain("Session ingest health");

			const beforeReplayDashboard = statSync(join(testStateRoot, "dashboard.html")).mtimeMs;
			await handlers.agent_settled({}, context);
			const replayStatus = await waitForMaterialization(firstStatus.last_attempt_at);
			const dashboardText = readFileSync(join(testStateRoot, "dashboard.html"), "utf8");
			expect(replayStatus.emitted).toBe(0);
			expect(replayStatus.status).toBe("ok");
			expect(statSync(join(testStateRoot, "dashboard.html")).mtimeMs).toBeGreaterThan(beforeReplayDashboard);
			expect(readFileSync(metricsPath, "utf8").trim().split("\n")).toHaveLength(1);
			for (const output of [readFileSync(metricsPath, "utf8"),
				readFileSync(join(testStateRoot, "ingest_status.json"), "utf8"), dashboardText]) {
				expect(output).not.toContain(marker);
			}
		} finally {
			rmSync(sessionRoot, { recursive: true, force: true });
		}
	}, 25_000);

	test("runModule forwards STATE_ROOT as CODING_AGENT_ORCHESTRATOR_HOME", async () => {
		const customRoot = mkdtempSync(join(tmpdir(), "orch-runmodule-state-"));
		// 2.3: CODING_AGENT_ORCHESTRATOR_HOME (canonical) now wins over the deprecated
		// HUMAIN_ORCHESTRATOR_STATE_ROOT alias when both are set, so set the canonical name here
		// (the file-level setup above already sets both to the same testStateRoot).
		const previousCanonical = process.env.CODING_AGENT_ORCHESTRATOR_HOME;
		process.env.CODING_AGENT_ORCHESTRATOR_HOME = customRoot;
		try {
			// Re-import the module so STATE_ROOT (read at module load time) reflects
			// the freshly-set CODING_AGENT_ORCHESTRATOR_HOME. The cache-busting query
			// string forces a fresh module evaluation under Bun's test runner.
			const fresh = (await import(`./index.ts?propagate=${Date.now()}-${Math.random()}`)) as typeof orchestrator;
			expect(fresh.runModule).toBeFunction();
			// Capture the env that `runModule` forwards to its child via the file-level
			// captureRunModuleEnv seam; restore the flag in `finally` so the rest of the
			// suite keeps using real spawns.
			captureRunModuleEnv = true;
			capturedRunModuleEnvs.length = 0;
			try {
				await fresh.runModule!("noop", []);
			} finally {
				captureRunModuleEnv = false;
			}
			expect(capturedRunModuleEnvs.length).toBeGreaterThan(0);
			expect(capturedRunModuleEnvs.at(-1)?.CODING_AGENT_ORCHESTRATOR_HOME).toBe(customRoot);
		} finally {
			if (previousCanonical === undefined) delete process.env.CODING_AGENT_ORCHESTRATOR_HOME;
			else process.env.CODING_AGENT_ORCHESTRATOR_HOME = previousCanonical;
			rmSync(customRoot, { recursive: true, force: true });
		}
	});
});



const planFixture: Parameters<typeof orchestrator.leadPrompt>[1] = {
		plan_id: "plan-1",
		run_id: "run-1",
		task_class: "implementation",
		complexity: 6,
		risk: "medium",
		topology: { depth: 2, leads: 1, workers: 3, shape: "lead-workers" },
		route: {
			selected: { capability: "lead", effort: "standard", verification_depth: "targeted" },
			recommended: { capability: "lead", effort: "standard", verification_depth: "targeted" },
			mode: "adaptive",
			history_sufficient: true,
			explanation: {},
		},
		effective_quality_floor: 0.8,
		cost_aggressiveness: 0.5,
	};
const adapterFixture: Parameters<typeof orchestrator.leadPrompt>[6] = {
	lead: { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
};
const repoRootFixture = "/repo";




describe("batched telemetry through the Python batch CLI (index.ts wiring)", () => {
	function rows(file: string): Record<string, unknown>[] {
		const path = join(pythonStateRoot, file);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	}
	function timing() {
		return { started_at: new Date().toISOString(), finished_at: new Date().toISOString(), elapsed_ms: 1, elapsed_source: "monotonic" as const };
	}

	test("record helpers enqueue synchronously without spawning Python", () => {
		expect(orchestrator.recordQueue).toBeDefined();
		const before = orchestrator.recordQueue!.stats.batches;
		const result = orchestrator.recordEvent!("dispatch_started", { run_id: "ht-sync", task_id: "t1" });
		expect(result).not.toBeInstanceOf(Promise);
		expect(orchestrator.recordQueue!.stats.batches).toBe(before);
		expect(orchestrator.recordQueue!.pending).toBeGreaterThanOrEqual(1);
	});

	test("one dispatch boundary plus run completion is one Python spawn, and the terminal outcome is durable when completeRun resolves", async () => {
		const runId = `ht-batch-${Date.now()}`;
		const before = orchestrator.recordQueue!.stats.batches;
		orchestrator.recordEvent!("dispatch_started", { run_id: runId, task_id: `${runId}-lead-0`, capability: "lead", model: "p/m" });
		orchestrator.recordEvent!("dispatch_finished", { run_id: runId, task_id: `${runId}-lead-0`, exit_code: 0 });
		orchestrator.recordModelCall!({ event: "model_call", run_id: runId, task_id: `${runId}-lead-0`, model: "p/m", provider: "p", cost_usd: 0.02, input_tokens: 10, output_tokens: 5, result: "pass" });
		orchestrator.recordModelCall!({ event: "route_executed", run_id: runId, task_id: `${runId}-lead-0`, executed_model: "p/m", executed_cost_usd: 0.02 });
		const report = await orchestrator.completeRun!(runId, { success_rate: 1, total_cost_usd: 0.02 }, timing());

		expect(report).toMatchObject({ ok: true, failed: 0 });
		// The terminal outcome must already be on disk — no delayed terminal status.
		const outcome = rows("outcomes.jsonl").find((r) => r.run_id === runId && r.task_id === "run-complete");
		expect(outcome).toBeDefined();
		expect(outcome).toMatchObject({ outcome: "verified", elapsed_source: "monotonic", agent_runtime: "humain-terminal" });
		const events = rows("events.jsonl").filter((r) => r.run_id === runId).map((r) => r.event);
		expect(events).toEqual(["dispatch_started", "dispatch_finished", "run_completed"]);
		expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("completed");
		const metrics = rows("metrics.jsonl").filter((r) => r.run_id === runId).map((r) => r.event);
		expect(metrics).toEqual(["model_call", "route_executed"]);
		// One successful batch also refreshed the derived views once (ledger checkpoint + dashboard).
		const ledger = JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8"));
		expect(ledger.checkpoint.events_replayed).toBeGreaterThanOrEqual(2);
		expect(existsSync(join(pythonStateRoot, "dashboard.html"))).toBe(true);
		// Everything above (plus whatever the previous test left pending) went through one `batch` process.
		expect(orchestrator.recordQueue!.stats.batches - before).toBe(1);
		expect(orchestrator.recordQueue!.pending).toBe(0);
	}, 30_000);

	test("cancellation drains the queue: failRun resolves only after the cancelled outcome is durable", async () => {
		const runId = `ht-cancel-${Date.now()}`;
		orchestrator.recordEvent!("dispatch_started", { run_id: runId, task_id: `${runId}-lead-0` });
		const report = await orchestrator.failRun!(runId, "cancelled by user (/orchestrate-cancel)", timing());
		expect(report.ok).toBe(true);
		const outcome = rows("outcomes.jsonl").find((r) => r.run_id === runId);
		expect(outcome).toMatchObject({ task_id: "run-failed", outcome: "fail", note: "cancelled by user (/orchestrate-cancel)" });
		expect(rows("events.jsonl").some((r) => r.run_id === runId)).toBe(true);
		expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("failed");
		expect(orchestrator.recordQueue!.pending).toBe(0);
	}, 30_000);

	test("session shutdown drains records still inside the coalescing window", async () => {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void>)[]>();
		const pi = {
			on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => {
				handlers.set(name, [...(handlers.get(name) ?? []), fn]);
			},
			registerCommand: () => {},
			registerTool: () => {},
			sendMessage: () => {},
		};
		orchestrator.default(pi as never);
		const shutdown = handlers.get("session_shutdown") ?? [];
		expect(shutdown.length).toBeGreaterThanOrEqual(1);

		const runId = `ht-shutdown-${Date.now()}`;
		orchestrator.recordEvent!("dispatch_plan_confirmed", { run_id: runId, plan_id: "p1" });
		expect(orchestrator.recordQueue!.pending).toBeGreaterThanOrEqual(1);
		const ctx = { sessionManager: { getSessionFile: () => undefined } };
		for (const fn of shutdown) await fn({}, ctx);
		expect(orchestrator.recordQueue!.pending).toBe(0);
		expect(rows("events.jsonl").some((r) => r.run_id === runId && r.event === "dispatch_plan_confirmed")).toBe(true);
	}, 30_000);

	test("a rejected record is surfaced in the terminal report and the run log instead of failing silently", async () => {
		const runId = `ht-invalid-${Date.now()}`;
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		try {
			orchestrator.recordEvent!("dispatch_started", { run_id: runId, task_id: 12 as unknown as string });
			const report = await orchestrator.completeRun!(runId, { success_rate: 1 }, timing());
			expect(report.ok).toBe(false);
			expect(report.failed).toBe(1);
			expect(report.error).toContain("task_id");
			expect(warnings.join("\n")).toContain("task_id");
			// The valid terminal outcome still landed.
			expect(rows("outcomes.jsonl").some((r) => r.run_id === runId && r.task_id === "run-complete")).toBe(true);
			expect(rows("events.jsonl").filter((r) => r.run_id === runId).map(r => r.event)).toEqual(["run_completed"]);
		} finally {
			console.warn = originalWarn;
		}
	}, 30_000);

	test("a record lost in an earlier timer flush is still counted in the terminal report when the final drain succeeds", async () => {
		const runId = `ht-cumulative-${Date.now()}`;
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			await orchestrator.recordQueue!.flush(); // start from an empty queue
			const baseline = orchestrator.recordQueue!.snapshot();
			// Mid-run: an invalid record goes out with the coalescing-window flush and is rejected there.
			orchestrator.recordEvent!("dispatch_started", { run_id: runId, task_id: 12 as unknown as string });
			const midRun = await orchestrator.recordQueue!.flush();
			expect(midRun.failed).toBe(1);
			// Run end: only valid records are left, so the final drain itself is clean.
			orchestrator.recordEvent!("dispatch_finished", { run_id: runId, task_id: `${runId}-lead-0` });
			const report = await orchestrator.completeRun!(runId, { success_rate: 1 }, timing(), baseline);
			expect(report.ok).toBe(false);
			expect(report.failed).toBe(1);
			expect(report.acknowledged).toBe(3);
			expect(report.error).toContain("task_id");
			expect(orchestrator.telemetryWarning!(report).join("\n")).toMatch(/1 record\(s\) could not be written/);
			// Without a baseline the report covers the final drain only, which is what the old code showed.
			orchestrator.recordEvent!("dispatch_started", { run_id: runId, task_id: 13 as unknown as string });
			await orchestrator.recordQueue!.flush();
			const finalOnly = await orchestrator.completeRun!(runId, { success_rate: 1 }, timing());
			expect(finalOnly).toMatchObject({ ok: true, failed: 0 });
		} finally {
			console.warn = originalWarn;
		}
	}, 30_000);

	test("the run summary distinguishes lost records from durable records whose ledger/dashboard refresh failed", () => {
		const lost = orchestrator.telemetryWarning!({ ok: false, batches: 1, acknowledged: 0, failed: 2, derivedStale: 0, error: "exit -1: python3: not found" });
		expect(lost).toHaveLength(1);
		expect(lost[0]).toMatch(/2 record\(s\) could not be written/);
		expect(lost[0]).toContain("python3: not found");

		const stale = orchestrator.telemetryWarning!({ ok: true, batches: 3, acknowledged: 5, failed: 0, derivedStale: 5, staleReason: "dashboard refresh failed: disk full" });
		expect(stale).toHaveLength(1);
		expect(stale[0]).not.toMatch(/could not be written|lost/);
		expect(stale[0]).toMatch(/5 record\(s\).*durable/);
		expect(stale[0]).toMatch(/ledger|dashboard/);
		expect(stale[0]).toContain("disk full");

		expect(orchestrator.telemetryWarning!({ ok: true, batches: 1, acknowledged: 1, failed: 0, derivedStale: 0 })).toEqual([]);
		expect(orchestrator.telemetryHealthy!({ ok: true, batches: 1, acknowledged: 1, failed: 0, derivedStale: 0 })).toBe(true);
		expect(orchestrator.telemetryHealthy!({ ok: true, batches: 1, acknowledged: 1, failed: 0, derivedStale: 1 })).toBe(false);
		expect(orchestrator.telemetryHealthy!({ ok: false, batches: 1, acknowledged: 0, failed: 1, derivedStale: 0 })).toBe(false);
	});

	test("a Python executable that does not exist fails the batch promptly with the spawn error, instead of hanging the terminal flush", async () => {
		const missing = join(testStateRoot, "no-such-python");
		const result = await orchestrator.runModule!("orchestrator.cli", ["batch", "-"], "[]", { python: missing });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("spawn error");
		expect(result.stderr).toMatch(/ENOENT|no such file/i);

		// Through the queue: the spawn failure is an ambiguous exit, retried and then reported, never a hang or a throw.
		const { RecordQueue } = await import("./record-queue.ts");
		const errors: string[] = [];
		const q = new RecordQueue({
			run: (records) => orchestrator.runModule!("orchestrator.cli", ["batch", "-"], JSON.stringify(records), { python: missing }),
			maxAttempts: 2,
			delay: async () => {},
			onError: (m) => errors.push(m),
		});
		q.enqueue("outcome", { run_id: "ht-nopython", task_id: "run-complete", outcome: "verified" });
		const report = await q.flush();
		expect(report).toMatchObject({ ok: false, failed: 1, acknowledged: 0, batches: 2 });
		expect(report.error).toMatch(/ENOENT|no such file/i);
		expect(errors).toHaveLength(1);
	}, 10_000);

	test("every terminal path in the /orchestrate handler awaits the drained terminal write", () => {
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const finalizeSource = readFileSync(new URL("./run/finalize.ts", import.meta.url), "utf8");
		const complete = finalizeSource.slice(finalizeSource.indexOf("async function completeRun("), finalizeSource.indexOf("async function failRun("));
		const fail = finalizeSource.slice(finalizeSource.indexOf("async function failRun("), finalizeSource.indexOf("export function createDispatchCostCapture("));
		for (const fn of [complete, fail]) expect(fn).toContain("flush()");
		// Every terminal call reports telemetry cumulatively since the run started, not just the final drain.
		const orchestrateSource = readFileSync(new URL("./commands/orchestrate.ts", import.meta.url), "utf8");
		const pipelineSource = readFileSync(new URL("./pipeline/run-orchestration.ts", import.meta.url), "utf8");
		const handler = orchestrateSource.slice(orchestrateSource.indexOf('pi.registerCommand("orchestrate"')) + pipelineSource;
		const calls = handler.match(/await deps\.(?:completeRun|failRun)\([^;]*?\);/gs) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(6);
		for (const call of calls) expect(call).toContain("session.telemetryBaseline");
		// Non-terminal records must not block dispatch: no awaited single-record spawns remain.
		for (const combined of [source, orchestrateSource, pipelineSource]) {
			expect(combined).not.toMatch(/await (?:deps\.)?recordEvent\(/);
			expect(combined).not.toMatch(/await (?:deps\.)?recordModelCall\(/);
			expect(combined).not.toMatch(/await (?:deps\.)?recordOutcome\(/);
		}
		// The legacy single-record CLI commands are for other runtimes; the bridge uses `batch`.
		expect(source).toContain('"batch"');
	});
});


describe("runSubagentProcess process/event handling (index.ts wiring)", () => {
	test("exported runSubagentProcess falls back to the active run when opts.session is omitted (B4.4)", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "orch-subagent-process-wiring-test-"));
		const session = new orchestrator.RunSession!("active-run-fallback", {
			ui: { setWidget: () => {}, setStatus: () => {}, notify: mock() },
		} as never, "progress timeout test", repoDir);
		forceActiveSession(session);
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
		});
		try {
			const pending = orchestrator.runSubagentProcess!({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "active-run-fallback",
				// No `session` here — must fall back to `runRegistry.active()?.session`
				// (matching the pre-B4.4 `opts.session ?? ACTIVE_RUN` behaviour), not just
				// silently dispatch with no session at all.
				leadTimeouts: { inactivityMs: 100, maxMs: 1000 },
				spawnChild: () => child as never,
			});
			// The active run's own cancellation must be honoured: only wired up if
			// this dispatch actually landed on `session` internally.
			session.cancel();
			const result = await pending;
			expect(result.outcome).toBe("cancelled");
			expect(result.exitCode).toBe(137);
			expect(session.cancelledDispatches()).toEqual(["__no_persona__"]);
			// And its diagnostics/progress line landed on the active run's own log,
			// not a private per-call temp file (the "no session" fallback path).
			const runLog = readFileSync(session.file("run.log"), "utf8");
			expect(runLog.match(/\ntaskId: active-run-fallback\n/g) ?? []).toHaveLength(1);
		} finally {
			child.emit("close", 137);
			forceActiveSession(null);
			session.close();
			rmSync(repoDir, { recursive: true, force: true });
		}
	});
});



describe("diagnostic writer ownership and sealing (index.ts wiring)", () => {
	test("terminal cleanup clears the widget/status after the background run settles, and admits the next run", async () => {
		let handler!: (args: string, context: never) => Promise<void>;
		const oldTmp = process.env.TMPDIR;
		try {
			// Activation's orphan scan must not inspect or remove real persona directories.
			process.env.TMPDIR = testStateRoot;
			orchestrator.default({
				on: () => {},
				registerCommand: (name: string, command: { handler: typeof handler }) => {
					if (name === "orchestrate") handler = command.handler;
				},
				registerTool: () => {},
				sendMessage: () => {},
			} as never);
		} finally {
			if (oldTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = oldTmp;
		}
		const sessions: InstanceType<typeof orchestrator.RunSession>[] = [];
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) {
			sessions.push(this);
			this.diagnostics.writer().append("task.events.jsonl", "open pipe\n");
			// Fail before planning/dispatch: no agent or live service is launched.
			throw new Error("synthetic pre-dispatch failure");
		});
		const realSeal = orchestrator.RunSession.prototype.sealDiagnostics;
		const seal = spyOn(orchestrator.RunSession.prototype, "sealDiagnostics").mockImplementation(async function (this: InstanceType<typeof orchestrator.RunSession>, terminal) {
			const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
				queueMicrotask(callback); // fake the terminal seal deadline, not dispatch/telemetry timers
				return 123;
			}) as typeof setTimeout);
			try { return await realSeal.call(this, terminal); }
			finally { timer.mockRestore(); }
		});
		const notices: string[] = [];
		let widget: unknown = "active";
		let status: unknown = "active";
		const context = {
			ui: {
				notify: (message: string) => notices.push(message),
				setWidget: (_id: string, value: unknown) => { widget = value; },
				setStatus: (_id: string, value: unknown) => { status = value; },
			},
		};
		try {
			await handler("synthetic cleanup test --complexity 4", context as never);
			// /orchestrate returns before the run settles; wait for the background
			// run's cleanup (the single place widget/status get cleared) to finish.
			await sessions[0]?.runPromise;
			expect(widget).toBeUndefined();
			expect(status).toBeUndefined();
			await handler("next synthetic run --complexity 4", context as never);
			await sessions[1]?.runPromise;
			expect(sessions).toHaveLength(2);
			expect(sessions[0].runId).not.toBe(sessions[1].runId);
			expect(notices.some(n => n.includes("already running"))).toBe(false);
			expect(notices.filter(n => n.includes("UNSEALED"))).toHaveLength(2);
			for (const session of sessions) expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
		} finally {
			phase.mockRestore();
			seal.mockRestore();
		}
	});
});

describe("final triage and shutdown integration (index.ts wiring)", () => {
	function activate() {
		let handler!: (args: string, ctx: never) => Promise<void>;
		let cancelHandler!: (args: string, ctx: never) => Promise<void>;
		let omsgHandler!: (args: string, ctx: never) => Promise<void>;
		const shutdown: Array<(event: unknown, ctx: never) => Promise<void>> = [];
		const sent: Array<{ message: { customType?: string; content?: unknown; display?: boolean; details?: { runId?: string; outcome?: string; costUsd?: number } }; options: unknown }> = [];
		let statusTool: {
			execute: (toolCallId: string, params: { logLines?: number }, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
		} | undefined;
		const oldTmp = process.env.TMPDIR;
		try {
			process.env.TMPDIR = testStateRoot;
			orchestrator.default({
				on: (name: string, fn: typeof shutdown[number]) => { if (name === "session_shutdown") shutdown.push(fn); },
				registerCommand: (name: string, command: { handler: typeof handler }) => {
					if (name === "orchestrate") handler = command.handler;
					if (name === "orchestrate-cancel") cancelHandler = command.handler;
					if (name === "omsg") omsgHandler = command.handler;
				},
				registerTool: (tool: typeof statusTool) => { statusTool = tool; },
				sendMessage: (message: typeof sent[number]["message"], options: unknown) => { sent.push({ message, options }); },
			} as never);
		} finally {
			if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
		}
		return { handler, cancelHandler, omsgHandler, shutdown, sent, statusTool };
	}
	// The models FALLBACK_ADAPTER binds (mirrors the shipped premium profile).
	function registry() {
		return { getAvailable: () => [
			"global.openai.gpt-6-luna", "global.openai.gpt-6-sol", "global.anthropic.claude-sonnet-5",
			"global.anthropic.claude-opus-5-5", "global.anthropic.claude-fable-5-1",
		].map((id) => ({ provider: "amazon-bedrock", id })) };
	}
	function readRows(name: string): any[] {
		return readFileSync(join(pythonStateRoot, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	}

	test("a shipped-profile alias missing from the registry aborts /orchestrate before any dispatch", async () => {
		const profilesPath = process.env.HUMAIN_ORCHESTRATOR_PROFILES_FILE!;
		writeFileSync(profilesPath, readFileSync(join(import.meta.dir, "..", "..", "orchestrator-profiles.json"), "utf8"));
		const { handler } = activate();
		const notices: string[] = [];
		const spawned = spyOn(childProcess, "spawn");
		try {
			const noOpus = { getAvailable: () => registry().getAvailable().filter((m) => !m.id.includes("opus-5-5")) };
			await handler("do a thing --task-class implementation --complexity 5 --risk low", {
				modelRegistry: noOpus, ui: { notify: (n: string) => notices.push(n), setWidget() {}, setStatus() {} },
			} as never);
			expect(notices.join("\n")).toContain("Model configuration is invalid — nothing was dispatched");
			expect(notices.join("\n")).toContain("opus-5-5");
			expect(spawned.mock.calls.filter(([, args]) => (args as string[] | undefined)?.includes("--mode"))).toHaveLength(0);
		} finally {
			spawned.mockRestore();
			rmSync(profilesPath, { force: true });
		}
	});
	for (const { model, costs, source, expected } of [
		{ model: "unknown-final-model", costs: [undefined], source: "unmetered", expected: undefined },
		{ model: "claude-sonnet-4-5", costs: [undefined], source: "estimated-from-reported-tokens", expected: .0039 },
		{ model: "claude-sonnet-4-5", costs: [{ total: 0 }], source: "reported", expected: 0 },
		{ model: "unknown-final-model", costs: [{ total: 0 }], source: "reported", expected: 0 },
		{ model: "claude-sonnet-4-5", costs: [{ total: -1 }], source: "estimated-from-reported-tokens", expected: .0039 },
		{ model: "claude-sonnet-4-5", costs: [{ total: "0" }], source: "estimated-from-reported-tokens", expected: .0039 },
		{ model: "claude-sonnet-4-5", costs: [{ total: .1 }, undefined], source: "estimated-from-reported-tokens", expected: .0078 },
		{ model: "claude-sonnet-4-5", costs: [undefined, { total: .1 }], source: "estimated-from-reported-tokens", expected: .0078 },
	]) {
		test(`malformed triage is billed to the real run with honest pricing: ${model} ${source} ${JSON.stringify(costs)}`, async () => {
			const { handler } = activate();
			const notices: string[] = [];
			let runId = "";
			const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>, value) {
				runId = this.runId;
				if (value.startsWith("planning")) throw new Error("stop after triage; no real worker");
			});
			const original = childProcess.spawn;
			const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
				if (!args.includes("--mode")) return original(command, args, opts);
				const events = costs.map(cost => ({ type: "message_end", message: { role: "assistant", model, usage: { input: 1000, cacheRead: 2500, output: 10, cost }, content: [{ type: "text", text: "not JSON" }], stopReason: "stop" } }));
				return original(process.execPath, ["-e", `${events.map(event => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("")}console.log('{"type":"agent_end"}');`], opts);
			}) as typeof childProcess.spawn);
			try {
				await handler("synthetic triage", { modelRegistry: registry(), ui: { notify: (n: string) => notices.push(n), setWidget() {}, setStatus() {} } } as never);
				await activeSession()?.runPromise;
				const rows = readRows("metrics.jsonl").filter(row => row.run_id === runId && row.event === "model_call");
				expect(rows).toHaveLength(1);
				expect(rows[0].role).toBe("triage");
				const priced = expected !== undefined;
				expect(rows[0].cost_source).toBe(source);
				expect(rows[0].cost_usd).toBe(expected);
				expect(rows[0].input_tokens).toBe(3500 * costs.length);
				expect(rows[0].cached_input_tokens).toBe(2500 * costs.length);
				const executed = readRows("metrics.jsonl").find(row => row.run_id === runId && row.event === "route_executed");
				expect(executed?.executed_cost_usd).toBe(source === "reported" ? expected : undefined);
				const html = readFileSync(join(pythonStateRoot, "dashboard.html"), "utf8");
				const data = JSON.parse(html.split("const D=")[1].split(";const $=")[0]);
				const run = data.runs.find((r: any) => r.run_id === runId);
				expect(run.call_rows).toBe(1);
				expect(run.metered_calls).toBe(priced ? 1 : 0);
				if (priced) expect(run.overhead_by_role.triage).toBe(rows[0].cost_usd);
			} finally { phase.mockRestore(); spawn.mockRestore(); }
		}, 30_000);
	}

	test("/orchestrate-cancel without child close flushes terminal billing and admits the next run", async () => {
		const { handler, cancelHandler } = activate();
		const sessions: InstanceType<typeof orchestrator.RunSession>[] = [];
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) {
			sessions.push(this);
			if (sessions.length > 1) throw new Error("stop next run before dispatch");
		});
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
		});
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("--mode")) return original(command, args, opts);
			setTimeout(() => {
				void cancelHandler("", ctx as never); // no session_shutdown safety net
				setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "message_end", message: {
					role: "assistant", model: "claude-sonnet-4-5", content: "partial triage",
					usage: { input: 10, output: 2, cost: { total: .03 } }, stopReason: "stop",
				} })}\n`), 10);
			}, 0);
			return child;
		}) as typeof childProcess.spawn);
		const notices: string[] = [];
		const ctx = {
			modelRegistry: registry(),
			ui: { notify: (message: string) => notices.push(message), setWidget() {}, setStatus() {} },
		};
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		await handler("synthetic Esc triage", ctx as never);
		try {
			const completed = await Promise.race([
				sessions[0].runPromise!.then(() => true),
				new Promise<boolean>(resolve => { watchdog = setTimeout(() => resolve(false), 8000); }),
			]);
			expect(completed).toBe(true);
			const runId = sessions[0].runId;
			const calls = readRows("metrics.jsonl").filter(row => row.run_id === runId && row.event === "model_call");
			expect(calls).toHaveLength(1);
			expect(calls[0].cost_usd).toBe(.03);
			expect(readRows("outcomes.jsonl").filter(row => row.run_id === runId && row.task_id === "run-failed")).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("failed");
			expect(notices.some(message => message.includes("UNSEALED"))).toBe(true);
			expect(existsSync(sessions[0].file(".diagnostics-sealed.json"))).toBe(false);
			await handler("next synthetic run --complexity 4", ctx as never);
			expect(sessions).toHaveLength(2);
			expect(notices.some(message => message.includes("already running"))).toBe(false);
		} finally {
			if (watchdog !== undefined) clearTimeout(watchdog);
			child.emit("close", 137);
			await sessions[0]?.runPromise;
			await sessions[1]?.runPromise;
			child.stdout.destroy(); child.stderr.destroy();
			phase.mockRestore(); spawn.mockRestore();
		}
	}, 15_000);

	test("shutdown is bounded even when session ingestion never exits", async () => {
		const { shutdown } = activate();
		const original = childProcess.spawn;
		let child: ReturnType<typeof childProcess.spawn> | undefined;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("ingest")) return original(command,args,opts);
			child = original(process.execPath,["-e","setInterval(()=>{},1000)"],opts);
			return child;
		}) as typeof childProcess.spawn);
		const realTimer = globalThis.setTimeout;
		const timer = spyOn(globalThis,"setTimeout").mockImplementation(((fn: () => void, ms: number) => realTimer(fn, ms === 2000 ? 10 : ms)) as typeof setTimeout);
		const ctx = { sessionManager: { getSessionFile: () => join(testStateRoot,"synthetic-session.jsonl") } };
		const draining = (async () => { for (const fn of shutdown) await fn({},ctx as never); return true; })();
		try {
			expect(await Promise.race([draining,new Promise<boolean>(resolve=>realTimer(()=>resolve(false),150))])).toBe(true);
			const status = JSON.parse(readFileSync(join(testStateRoot, "ingest_status.json"), "utf8"));
			expect(status.status).toBe("error");
			expect(status.error).toContain("shutdown ingestion timed out");
		} finally {
			child?.kill();
			await draining;
			timer.mockRestore(); spawn.mockRestore();
		}
	});

	test("shutdown deadline leaves a stalled plan unsealed even after late completion", async () => {
		const { handler, shutdown } = activate();
		const original = childProcess.spawn;
		let child: ReturnType<typeof childProcess.spawn> | undefined;
		let ready!: () => void;
		const started = new Promise<void>(resolve => { ready = resolve; });
		let session: InstanceType<typeof orchestrator.RunSession> | undefined;
		const phase = spyOn(orchestrator.RunSession.prototype,"setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) { session=this; });
		const spawn = spyOn(childProcess,"spawn").mockImplementation(((command: string,args: string[],opts: object) => {
			if (!args.includes("plan")) return original(command,args,opts);
			child=original(process.execPath,["-e","setInterval(()=>{},1000)"],opts); ready(); return child;
		}) as typeof childProcess.spawn);
		const ctx={ui:{notify() {},setWidget() {},setStatus() {}},sessionManager:{getSessionFile:()=>undefined}};
		await handler("stalled synthetic plan --complexity 4",ctx as never);
		const realTimer=globalThis.setTimeout;
		let timer: ReturnType<typeof spyOn> | undefined;
		try {
			await started;
			timer=spyOn(globalThis,"setTimeout").mockImplementation(((fn:()=>void,ms:number)=>realTimer(fn,ms===2000?10:ms)) as typeof setTimeout);
			for (const fn of shutdown) await fn({},ctx as never);
			expect(session?.cancellation.isCancelled).toBe(true);
			expect(existsSync(session!.file(".diagnostics-sealed.json"))).toBe(false);
			child?.kill(); await session?.runPromise;
			expect(existsSync(session!.file(".diagnostics-sealed.json"))).toBe(false);
		} finally { child?.kill(); await session?.runPromise; timer?.mockRestore(); phase.mockRestore(); spawn.mockRestore(); }
	});

	test("shutdown captures active escalation usage before cancellation unwinds the retry", async () => {
		const { handler, shutdown } = activate();
		const cwd = process.cwd();
		const repo = mkdtempSync(join(testStateRoot, "escalation-repo-"));
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, "work.txt"), "before\n");
		execFileSync("git", ["-C", repo, "add", "work.txt"]);
		let session: InstanceType<typeof orchestrator.RunSession> | undefined;
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) { session = this; });
		let childReady!: () => void;
		const ready = new Promise<void>(resolve => { childReady = resolve; });
		const original = childProcess.spawn;
		let dispatches = 0;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("--mode")) return original(command, args, opts);
			dispatches++;
			const retry = dispatches === 3;
			const text = dispatches === 2 ? "- unit tests: FAIL" : "Changed work.txt";
			const event = { type: "message_end", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input: 1000, output: 10, cost: { total: retry ? .3 : .01 } }, content: [{ type: "text", text }], stopReason: "stop" } };
			const modify = dispatches === 1 ? 'require("node:fs").writeFileSync("work.txt","after\\n");' : "";
			const finish = retry ? "setInterval(()=>{},1000);" : 'console.log(\'{"type":"agent_end"}\');';
			const child = original(process.execPath, ["-e", `${modify}console.log(${JSON.stringify(JSON.stringify(event))});${finish}`], opts);
			if (retry) child.stdout?.once("data", () => queueMicrotask(childReady));
			return child;
		}) as typeof childProcess.spawn);
		const ctx = { modelRegistry: registry(), ui: { notify() {}, setWidget() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		process.chdir(repo);
		await handler("synthetic escalation --complexity 3 --risk low", ctx as never);
		try {
			await Promise.race([ready, session!.runPromise!.then(() => { throw new Error("run ended before escalation usage"); })]);
			for (const fn of shutdown) await fn({}, ctx as never);
			const runId = session!.runId;
			const retryId = `${runId}-lead-0-retry-1`;
			const calls = readRows("metrics.jsonl").filter(row => row.run_id === runId && row.event === "model_call");
			expect(calls.filter(row => row.task_id === retryId)).toHaveLength(1);
			expect(calls.find(row => row.task_id === retryId)?.cost_usd).toBe(.3);
			expect(calls).toHaveLength(3);
			expect(readRows("events.jsonl").find(row => row.task_id === retryId && row.event === "dispatch_started")?.retry_of).toBe(`${runId}-lead-0`);
			expect(readRows("outcomes.jsonl").filter(row => row.run_id === runId && row.task_id === "run-failed")).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("failed");
			const data = JSON.parse(readFileSync(join(pythonStateRoot, "dashboard.html"), "utf8").split("const D=")[1].split(";const $=")[0]);
			expect(data.runs.find((row: any) => row.run_id === runId).cost_known_usd).toBeCloseTo(.32);
		} finally {
			session?.cancel();
			await session?.runPromise;
			process.chdir(cwd);
			phase.mockRestore(); spawn.mockRestore();
		}
	}, 30_000);

	test("shutdown awaits active child settlement and late terminal telemetry", async () => {
		const { handler, shutdown } = activate();
		let runId = "";
		let childReady!: () => void;
		const ready = new Promise<void>(r => { childReady = r; });
		let activeSession: InstanceType<typeof orchestrator.RunSession> | undefined;
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) { runId = this.runId; activeSession = this; });
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("--mode")) return original(command, args, opts);
			const event = { type: "message_end", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input: 1000, output: 10, cost: { total: .1 } }, content: [{ type: "text", text: "not JSON" }] } };
			const child = original(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(event))});setTimeout(()=>{},30000);`], opts);
			child.stdout?.once("data", () => { setTimeout(childReady, 10); });
			return child;
		}) as typeof childProcess.spawn);
		const ctx = { modelRegistry: registry(), ui: { notify() {}, setWidget() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		await handler("synthetic shutdown triage", ctx as never);
		try {
			await ready;
			for (const fn of shutdown) await fn({}, ctx as never);
			expect(readRows("outcomes.jsonl").some(row => row.run_id === runId && row.task_id === "run-failed")).toBe(true);
			expect(readRows("metrics.jsonl").find(row => row.run_id === runId && row.event === "model_call")?.cost_usd).toBe(.1);
			expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("failed");
		} finally {
			// Also cleans up the pre-fix reproduction, whose shutdown hook did not cancel.
			activeSession?.cancel();
			await activeSession?.runPromise;
			phase.mockRestore(); spawn.mockRestore();
		}
	}, 30_000);

	test("the handler returns before the run finishes; /omsg still reaches the live run", async () => {
		const { handler, omsgHandler } = activate();
		let ready!: () => void;
		const started = new Promise<void>(resolve => { ready = resolve; });
		let child: ReturnType<typeof childProcess.spawn> | undefined;
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("plan")) return original(command, args, opts);
			child = original(process.execPath, ["-e", "setInterval(()=>{},1000)"], opts);
			ready();
			return child;
		}) as typeof childProcess.spawn);
		const notices: string[] = [];
		const ctx = {
			ui: { notify: (m: string) => notices.push(m), setWidget() {}, setStatus() {} },
			sessionManager: { getSessionFile: () => undefined },
		};
		try {
			await handler("gated synthetic run --complexity 4", ctx as never);
			// The command returned already; the background run is still going.
			const session = activeSession();
			expect(session).not.toBeNull();
			await started; // background reached the real (mocked) plan spawn
			expect(activeSession()).toBe(session);
			await omsgHandler("check the staging config", ctx as never);
			expect(notices.some(n => n.includes("Queued for next dispatch"))).toBe(true);
			expect(session!.queuedDepth()).toBe(1);
		} finally {
			child?.kill();
			await activeSession()?.runPromise;
			spawn.mockRestore();
		}
	}, 15_000);

	test("a second /orchestrate while one is live is rejected", async () => {
		const { handler } = activate();
		let ready!: () => void;
		const started = new Promise<void>(resolve => { ready = resolve; });
		let child: ReturnType<typeof childProcess.spawn> | undefined;
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("plan")) return original(command, args, opts);
			child = original(process.execPath, ["-e", "setInterval(()=>{},1000)"], opts);
			ready();
			return child;
		}) as typeof childProcess.spawn);
		const notices: string[] = [];
		const ctx = { ui: { notify: (m: string) => notices.push(m), setWidget() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		try {
			await handler("first synthetic run --complexity 4", ctx as never);
			const first = activeSession();
			await started;
			await handler("second synthetic run --complexity 4", ctx as never);
			expect(activeSession()).toBe(first);
			expect(notices.some(n => n.includes("already running"))).toBe(true);
		} finally {
			child?.kill();
			await activeSession()?.runPromise;
			spawn.mockRestore();
		}
	}, 15_000);

	test("two /orchestrate invocations racing across the resolveAdapter await result in exactly one live run", async () => {
		const { handler } = activate();
		let readyCount = 0;
		let ready!: () => void;
		const started = new Promise<void>(resolve => { ready = resolve; });
		const children: ReturnType<typeof childProcess.spawn>[] = [];
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("plan")) return original(command, args, opts);
			const child = original(process.execPath, ["-e", "setInterval(()=>{},1000)"], opts);
			children.push(child);
			readyCount++;
			ready();
			return child;
		}) as typeof childProcess.spawn);
		const notices: string[] = [];
		const ctx = { ui: { notify: (m: string) => notices.push(m), setWidget() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		let active: InstanceType<typeof orchestrator.RunSession> | null = null;
		try {
			// Neither call is awaited before the other starts, so both run their synchronous
			// prelude — including the first "already running" guard, which sees ACTIVE_RUN
			// still null for both — before either resumes past its `await resolveAdapter`. That
			// is exactly the window the second, pre-assignment re-check has to close.
			const p1 = handler("racer one --complexity 4", ctx as never);
			const p2 = handler("racer two --complexity 4", ctx as never);
			await Promise.all([p1, p2]);
			active = activeSession();
			expect(active).not.toBeNull();
			await started;
			expect(notices.some(n => n.includes("already running"))).toBe(true);
			// The loser backed off before spawning a background run at all: only the winner
			// ever reached the (mocked) plan dispatch.
			expect(readyCount).toBe(1);
		} finally {
			for (const child of children) child.kill();
			await active?.runPromise;
			spawn.mockRestore();
		}
	}, 15_000);

	test("a stale run's finally does not clobber ACTIVE_RUN once a newer run has taken it", async () => {
		const { handler } = activate();
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("plan")) return original(command, args, opts);
			// Fail the plan dispatch immediately so the run reaches its terminal finally fast.
			return original(process.execPath, ["-e", "process.exit(1)"], opts);
		}) as typeof childProcess.spawn);
		const ctx = { ui: { notify() {}, setWidget() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		try {
			await handler("stale finally synthetic run --complexity 4", ctx as never);
			const sessionA = activeSession()!;
			expect(sessionA).not.toBeNull();
			// The race guard above makes it impossible for a second run to take ACTIVE_RUN while
			// sessionA still owns it, so simulate the state directly: a newer run has since become
			// ACTIVE_RUN. sessionA's own finally must recognize it no longer owns the singleton and
			// leave it alone rather than unconditionally nulling it out.
			const sessionB = new orchestrator.RunSession!("newer-run-stale-finally-test", ctx as never, "a different goal");
			forceActiveSession(sessionB);
			await sessionA.runPromise;
			expect(activeSession()).toBe(sessionB);
			sessionB.close();
			await sessionB.sealDiagnostics();
			sessionB.finish();
			forceActiveSession(null);
		} finally {
			spawn.mockRestore();
		}
	}, 15_000);

	test("/orchestrate-cancel cancels the live run, clears widget/status/ACTIVE_RUN, posts a cancelled summary, and admits a new run", async () => {
		const { handler, cancelHandler, sent } = activate();
		let ready!: () => void;
		const started = new Promise<void>(resolve => { ready = resolve; });
		let child: ReturnType<typeof childProcess.spawn> | undefined;
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("plan")) return original(command, args, opts);
			child = original(process.execPath, ["-e", "setInterval(()=>{},1000)"], opts);
			ready();
			return child;
		}) as typeof childProcess.spawn);
		let widget: unknown = "active";
		let status: unknown = "active";
		const notices: string[] = [];
		const ctx = {
			ui: {
				notify: (m: string) => notices.push(m),
				setWidget: (_id: string, v: unknown) => { widget = v; },
				setStatus: (_id: string, v: unknown) => { status = v; },
			},
			sessionManager: { getSessionFile: () => undefined },
		};
		try {
			await handler("cancel-me synthetic run --complexity 4", ctx as never);
			const session = activeSession()!;
			await started;
			await cancelHandler("", ctx as never);
			child?.kill();
			await session.runPromise;
			expect(activeSession()).toBeNull();
			expect(widget).toBeUndefined();
			expect(status).toBeUndefined();
			const cancelled = sent.find((s) => s.message.details?.runId === session.runId);
			expect(cancelled).toBeDefined();
			expect(cancelled?.message.details?.outcome).toBe("cancelled");
			expect(cancelled?.message.customType).toBe("orchestrator-run");
			expect(cancelled?.message.display).toBe(true);
			expect(cancelled?.options).toEqual({ triggerTurn: false });

			// A new run is admitted now that the previous one has fully cleaned up.
			let ready2!: () => void;
			const started2 = new Promise<void>(resolve => { ready2 = resolve; });
			let child2: ReturnType<typeof childProcess.spawn> | undefined;
			spawn.mockImplementation(((command: string, args: string[], opts: object) => {
				if (!args.includes("plan")) return original(command, args, opts);
				child2 = original(process.execPath, ["-e", "setInterval(()=>{},1000)"], opts);
				ready2();
				return child2;
			}) as typeof childProcess.spawn);
			await handler("next synthetic run --complexity 4", ctx as never);
			await started2;
			expect(notices.some(n => n.includes("already running"))).toBe(false);
			child2?.kill();
			await activeSession()?.runPromise;
		} finally {
			spawn.mockRestore();
		}
	}, 15_000);

	test("a completed run posts its full summary to chat with triggerTurn: false", async () => {
		const { handler, sent } = activate();
		const cwd = process.cwd();
		const repo = mkdtempSync(join(testStateRoot, "completion-repo-"));
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, "work.txt"), "before\n");
		execFileSync("git", ["-C", repo, "add", "work.txt"]);
		let session: InstanceType<typeof orchestrator.RunSession> | undefined;
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) { session = this; });
		const original = childProcess.spawn;
		let dispatches = 0;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("--mode")) return original(command, args, opts);
			dispatches++;
			const modify = dispatches === 1 ? 'require("node:fs").writeFileSync("work.txt","after\\n");' : "";
			const text = dispatches === 1 ? "## Files Changed\n- work.txt\n\nSTATUS: completed" : "no issues found";
			const event = { type: "message_end", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input: 100, output: 10, cost: { total: .01 } }, content: [{ type: "text", text }], stopReason: "stop" } };
			return original(process.execPath, ["-e", `${modify}console.log(${JSON.stringify(JSON.stringify(event))});console.log('{"type":"agent_end"}');`], opts);
		}) as typeof childProcess.spawn);
		const ctx = { modelRegistry: registry(), ui: { notify() {}, setWidget() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		process.chdir(repo);
		try {
			await handler("synthetic completion --complexity 2 --risk low", ctx as never);
			await session!.runPromise;
			const runId = session!.runId;
			const completion = sent.find((s) => s.message.details?.runId === runId);
			expect(completion).toBeDefined();
			expect(completion?.options).toEqual({ triggerTurn: false });
			expect(completion?.message.customType).toBe("orchestrator-run");
			expect(completion?.message.display).toBe(true);
			expect(completion?.message.details?.outcome).toBe("completed");
			expect(String(completion?.message.content ?? "")).toContain(`run_id: ${runId}`);
			expect(typeof completion?.message.details?.costUsd).toBe("number");
		} finally {
			process.chdir(cwd);
			phase.mockRestore(); spawn.mockRestore();
		}
	}, 30_000);

	test("orchestrator_status reports phase/dispatch progress/cost/log tail for a live run, and says no run is active when idle", async () => {
		const { handler, statusTool } = activate();
		expect(statusTool).toBeDefined();
		const idle = await statusTool!.execute("call-1", {});
		expect(idle.content[0].text).toBe("No orchestrator run is active.");
		expect(idle.details).toBeUndefined();

		let session: InstanceType<typeof orchestrator.RunSession> | undefined;
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) { session = this; });
		let childReady!: () => void;
		const ready = new Promise<void>(resolve => { childReady = resolve; });
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("--mode")) return original(command, args, opts);
			const toolEvent = { type: "tool_execution_start", toolName: "bash", args: { command: "echo hi" } };
			const turnEvent = { type: "message_end", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input: 100, output: 10, cost: { total: .02 } }, content: [{ type: "text", text: "working" }], stopReason: "stop" } };
			const child = original(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(toolEvent))});console.log(${JSON.stringify(JSON.stringify(turnEvent))});setInterval(()=>{},1000);`], opts);
			child.stdout?.once("data", () => setTimeout(childReady, 10));
			return child;
		}) as typeof childProcess.spawn);
		const ctx = { modelRegistry: registry(), ui: { notify() {}, setWidget() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		await handler("synthetic status check --complexity 3 --risk low", ctx as never);
		try {
			await ready;
			const result = await statusTool!.execute("call-2", { logLines: 5 });
			expect(result.details).toBeDefined();
			const snapshot = result.details as any;
			expect(snapshot.runId).toBe(session!.runId);
			expect(snapshot.phase).toBeTruthy();
			expect(snapshot.dispatches.length).toBeGreaterThan(0);
			const dispatch = snapshot.dispatches[0];
			expect(typeof dispatch.model).toBe("string");
			expect(dispatch.model.length).toBeGreaterThan(0);
			expect(dispatch.turns).toBe(1);
			expect(dispatch.lastTool).toBe("bash");
			expect(dispatch.costUsd).toBeCloseTo(.02);
			expect(snapshot.totalCostUsd).toBeGreaterThan(0);
			expect(snapshot.recentLog.length).toBeGreaterThan(0);
			expect(snapshot.recentLog.length).toBeLessThanOrEqual(5);
			expect(result.content[0].text).toContain(session!.runId);
			expect(result.content[0].text).toContain("bash");
		} finally {
			session?.cancel();
			await session?.runPromise;
			phase.mockRestore(); spawn.mockRestore();
		}
	}, 30_000);

	test("session shutdown cancels the live run, records it failed, and clears ACTIVE_RUN/widget/status", async () => {
		const { handler, shutdown, sent } = activate();
		let childReady!: () => void;
		const ready = new Promise<void>(resolve => { childReady = resolve; });
		let session: InstanceType<typeof orchestrator.RunSession> | undefined;
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) { session = this; });
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("--mode")) return original(command, args, opts);
			const event = { type: "message_end", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input: 10, output: 2, cost: { total: .01 } }, content: [{ type: "text", text: "not JSON" }] } };
			const child = original(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(event))});setTimeout(()=>{},30000);`], opts);
			child.stdout?.once("data", () => setTimeout(childReady, 10));
			return child;
		}) as typeof childProcess.spawn);
		let widget: unknown = "active";
		let status: unknown = "active";
		const ctx = {
			modelRegistry: registry(),
			ui: { notify() {}, setWidget: (_id: string, v: unknown) => { widget = v; }, setStatus: (_id: string, v: unknown) => { status = v; } },
			sessionManager: { getSessionFile: () => undefined },
		};
		await handler("synthetic shutdown clears state", ctx as never);
		try {
			await ready;
			for (const fn of shutdown) await fn({}, ctx as never);
			expect(activeSession()).toBeNull();
			expect(widget).toBeUndefined();
			expect(status).toBeUndefined();
			expect(session?.cancelReason).toBe("shutdown");
			const runId = session!.runId;
			expect(readRows("outcomes.jsonl").some(row => row.run_id === runId && row.task_id === "run-failed")).toBe(true);
			// A shutdown-initiated cancel has no live session to post into; the chat must stay silent for this run.
			expect(sent.some((s) => s.message.details?.runId === runId)).toBe(false);
		} finally {
			session?.cancel();
			await session?.runPromise;
			phase.mockRestore(); spawn.mockRestore();
		}
	}, 30_000);

	test("a ctx whose ui getter throws after shutdown still ends with ACTIVE_RUN null and a recorded failed outcome", async () => {
		const { handler, shutdown } = activate();
		let childReady!: () => void;
		const ready = new Promise<void>(resolve => { childReady = resolve; });
		let session: InstanceType<typeof orchestrator.RunSession> | undefined;
		const phase = spyOn(orchestrator.RunSession.prototype, "setPhase").mockImplementation(function (this: InstanceType<typeof orchestrator.RunSession>) { session = this; });
		const original = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], opts: object) => {
			if (!args.includes("--mode")) return original(command, args, opts);
			const event = { type: "message_end", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input: 10, output: 2, cost: { total: .01 } }, content: [{ type: "text", text: "not JSON" }] } };
			const child = original(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(event))});setTimeout(()=>{},30000);`], opts);
			child.stdout?.once("data", () => setTimeout(childReady, 10));
			return child;
		}) as typeof childProcess.spawn);
		let uiInvalidated = false;
		const ui = { notify() {}, setWidget() {}, setStatus() {} };
		const ctx = {
			modelRegistry: registry(),
			// `ctx.ui` becomes unavailable once this test's session has "moved on" — mirrors a real
			// session ending mid-drain, where the terminal path may still run after that point.
			get ui() {
				if (uiInvalidated) throw new Error("ctx invalidated: ui is unavailable after this session ended");
				return ui;
			},
			sessionManager: { getSessionFile: () => undefined },
		};
		const errors: unknown[][] = [];
		const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
		await handler("synthetic shutdown with dead ui", ctx as never);
		try {
			await ready;
			uiInvalidated = true;
			for (const fn of shutdown) await fn({}, ctx as never);
			await session?.runPromise;
			expect(activeSession()).toBeNull();
			const runId = session!.runId;
			expect(readRows("outcomes.jsonl").some(row => row.run_id === runId && row.task_id === "run-failed")).toBe(true);
			expect(errors.some((args) => String(args[0] ?? "").includes("rejected unexpectedly"))).toBe(false);
		} finally {
			uiInvalidated = false;
			session?.cancel();
			await session?.runPromise;
			phase.mockRestore(); spawn.mockRestore(); errSpy.mockRestore();
		}
	}, 30_000);
});





describe("review fixes (Phase A review)", () => {
	test("every lead size runs the orchestrator-lead persona with the lead timeout policy", async () => {
		const { ORCHESTRATING_CAPABILITIES, resolveDispatchTimeoutPolicy } = await import("./dispatch-progress.ts");
		for (const cap of ["lead_small", "lead", "lead_large"]) {
			expect(orchestrator.agentNameFor(cap)).toBe("orchestrator-lead");
			expect(ORCHESTRATING_CAPABILITIES.has(cap)).toBe(true);
			expect(resolveDispatchTimeoutPolicy(cap, {}).mode).toBe("lead");
		}
		expect(orchestrator.agentNameFor("scout")).toBe("orch-scout");
	});

	test("re-review escalation picks a model from a capability that belongs to the target tier", () => {
		// oss-like: `lead` (premium capability) overridden to a mid model must not
		// become the premium escalation target; premium-like: security_review
		// overridden to another vendor is not preferred for technical re-review.
		const adapter = {
			technical_review: { model: "humain-node/kimi-k3" },
			implementation_strong: { model: "humain-node/minimax-m3" },
			lead: { model: "humain-node/minimax-m3" },
			analysis_strong: { model: "humain-node/glm-5.2" },
			architect: { model: "humain-node/glm-5.2" },
			security_review: { model: "openai-codex/gpt-6-astra" },
			lead_large: { model: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
		};
		const picked = pickModel("technical_review", adapter, 1, "medium");
		expect(picked).toBe("humain-node/glm-5.2");
	});

	test("quota fallback is not attempted for a timed-out or cancelled dispatch, or for quota words only in the model's prose", async () => {
		const table = buildAliasTable([
			{ provider: "openai-codex", id: "gpt-6-astra" },
			{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
		]);
		const base = {
			exitCode: 124, stdout: "", finalText: "", rawStdout: "", personaCanMutate: false, stderr: "usage limit reached",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			costUsd: 0, costReported: false, durationMs: 1, processExitCode: 124,
		};
		for (const over of [
			{ outcome: "timed_out" as const },
			{ outcome: "cancelled" as const, exitCode: 137 },
			{ outcome: "failed" as const, exitCode: 125, stopReason: "spend_cap" },
			{ outcome: "failed" as const, exitCode: 1, stderr: "exit 1", finalText: "the API returned 429 rate limit earlier" },
		]) {
			let calls = 0;
			await orchestrator.dispatchParallel(process.cwd(), "run", [{ capability: "security_review", task: "t", taskId: "run-sec" }],
				{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, null, 0, {
					recordEvent: () => {}, aliasTable: table,
					runProcess: async () => { calls++; return { ...base, ...over }; },
				});
			expect(calls).toBe(1);
		}
	});
});

describe("effort telemetry vocabulary", () => {
	test("thinking levels map onto method.json efforts", () => {
		expect(orchestrator.methodEffortFor(undefined)).toBe("standard");
		expect(orchestrator.methodEffortFor("medium")).toBe("standard");
		expect(orchestrator.methodEffortFor("low")).toBe("low");
		expect(orchestrator.methodEffortFor("high")).toBe("high");
		expect(orchestrator.methodEffortFor("xhigh")).toBe("maximum");
		expect(orchestrator.methodEffortFor("off")).toBe("minimal");
		for (const t of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(METHOD.effort_levels).toContain(orchestrator.methodEffortFor(t));
		}
	});

	test("method.json effort_aliases matches the formerly hard-coded switch in index.ts", () => {
		// Snapshot of the literal switch that used to live in index.ts before it moved
		// into method.json's effort_aliases (B1 step 5). "medium" and any unlisted
		// thinking level fell through to the `default: return "standard"` branch.
		expect(METHOD.effort_aliases).toEqual({
			off: "minimal",
			minimal: "minimal",
			low: "low",
			medium: "standard",
			high: "high",
			xhigh: "maximum",
			max: "maximum",
		});
	});
});

describe("capability persona overrides", () => {
	test("method.json capability_personas matches the formerly hard-coded CAPABILITY_AGENT_ALIASES in index.ts", () => {
		// Snapshot of the static overrides that used to live in index.ts before they
		// moved into method.json's capability_personas (B1 step 5). The lead-size
		// overrides (lead_small/lead/lead_large -> orchestrator-lead) are excluded
		// here because they were already derived from rules.lead_sizing.sizes.
		expect(METHOD.capability_personas).toEqual({
			analysis_mid: "orch-technical-lead",
			analysis_strong: "orch-architect",
			integration_review: "orch-technical-review",
			migration_review: "orch-technical-review",
			performance_review: "orch-technical-review",
			api_contract_review: "orch-technical-review",
		});
	});

	test("agentNameFor still resolves every previously-aliased capability", () => {
		expect(orchestrator.agentNameFor("analysis_mid")).toBe("orch-technical-lead");
		expect(orchestrator.agentNameFor("analysis_strong")).toBe("orch-architect");
		expect(orchestrator.agentNameFor("integration_review")).toBe("orch-technical-review");
		expect(orchestrator.agentNameFor("migration_review")).toBe("orch-technical-review");
		expect(orchestrator.agentNameFor("performance_review")).toBe("orch-technical-review");
		expect(orchestrator.agentNameFor("api_contract_review")).toBe("orch-technical-review");
		expect(orchestrator.agentNameFor("implementation_strong")).toBe("orch-implementation-strong");
	});
});


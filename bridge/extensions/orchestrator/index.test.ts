import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionIngestScheduler } from "./ingest.ts";
import { planReconTasks } from "./recon.ts";
import { METHOD, TIER_CAPABILITIES, buildAliasTable } from "./models.ts";
import type { DispatchResult, DispatchTask } from "./index.ts";
import { RunCancellation } from "./cancellation.ts";
import { MAX_CHILD_STDERR_DISK_BYTES } from "./dispatch-outcome.ts";
import { loadEfficiencyControls, type EfficiencyControls } from "./efficiency-flags.ts";
import { externalChangeFiles } from "./run-outcome.ts";

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
		// Mirrors bridge/agents/orchestrator-lead.md and orch-architect.md's real
		// frontmatter `tools:` lists — neither carries `write`/`edit` (see the
		// "Delegation rule (hard)" section of orchestrator-lead.md). Added for the
		// lead/architect tool-permissions test below; every other agent name still
		// resolves to nothing, which is what main's tests assume.
		{ name: "orchestrator-lead", tools: ["read", "bash", "grep", "find", "ls", "subagent"], systemPrompt: "" },
		{ name: "orch-architect", tools: ["read", "grep", "find", "ls", "bash"], systemPrompt: "" },
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

describe("session ingest hook wiring", () => {
	test("both lifecycle hooks use the current session file and the supplied scheduler", async () => {
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		const scheduled: string[] = [];
		const flushed: string[] = [];
		const scheduler = {
			schedule: (file: string | undefined) => { if (file) scheduled.push(file); },
			flush: async (file: string | undefined) => { if (file) flushed.push(file); },
		};
		orchestrator.registerSessionIngestHooks!({
			on: (event: string, handler: (...args: any[]) => unknown) => { handlers[event] = handler; },
		} as never, scheduler as never);

		const ctxFor = (file: string) => ({ sessionManager: { getSessionFile: () => file } });
		await handlers.agent_settled({}, ctxFor("/sessions/current-settled.jsonl"));
		await handlers.session_shutdown({}, ctxFor("/sessions/current-shutdown.jsonl"));
		expect(scheduled).toEqual(["/sessions/current-settled.jsonl"]);
		expect(flushed).toEqual(["/sessions/current-shutdown.jsonl"]);
	});

	test("shared shutdown hook bounds a stalled ingest and reports failure without abandoning its drain", async () => {
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const errors: string[] = [];
		const realTimer = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) =>
			realTimer(fn, ms === 2000 ? 5 : ms)) as typeof setTimeout);
		try {
			orchestrator.registerSessionIngestHooks({
				on: (event: string, handler: (...args: any[]) => unknown) => { handlers[event] = handler; },
			} as never, { schedule: () => {}, flush: () => pending }, (message) => errors.push(message));
			const result = await Promise.race([
				Promise.resolve(handlers.session_shutdown({}, { sessionManager: { getSessionFile: () => "/session.jsonl" } })).then(() => true),
				new Promise<boolean>((resolve) => realTimer(() => resolve(false), 100)),
			]);
			expect(result).toBe(true);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("shutdown ingestion timed out");
		} finally {
			release();
			timer.mockRestore();
		}
	});

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

	test("same-session append during an in-flight run is consumed by the queued rerun", async () => {
		const root = mkdtempSync(join(tmpdir(), "orch-queued-ingest-test-"));
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(sessionFile, "initial\n");
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		let markSecondFinished!: () => void;
		const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const secondFinished = new Promise<void>((resolve) => { markSecondFinished = resolve; });
		const snapshots: string[] = [];
		const scheduler = new SessionIngestScheduler({
			debounceMs: 0,
			run: async (file) => {
				snapshots.push(readFileSync(file, "utf8"));
				if (snapshots.length === 1) {
					markFirstStarted();
					await firstGate;
				} else {
					markSecondFinished();
				}
				return { ok: true };
			},
		});
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		orchestrator.registerSessionIngestHooks!({
			on: (event: string, handler: (...args: any[]) => unknown) => { handlers[event] = handler; },
		} as never, scheduler);
		const context = { sessionManager: { getSessionFile: () => sessionFile } };
		try {
			await handlers.agent_settled({}, context);
			await firstStarted;
			writeFileSync(sessionFile, "initial\nappended-during-ingest\n");
			await handlers.agent_settled({}, context);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(snapshots).toHaveLength(1);
			releaseFirst();
			await secondFinished;
			await scheduler.flush(null);
			expect(snapshots).toHaveLength(2);
			expect(snapshots[0]).toBe("initial\n");
			expect(snapshots[1]).toContain("appended-during-ingest");
		} finally {
			releaseFirst();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("empty CLI failure detail falls back to the previous status error", () => {
		const root = mkdtempSync(join(tmpdir(), "orch-hook-empty-error-test-"));
		try {
			writeFileSync(join(root, "ingest_status.json"), JSON.stringify({
				version: 1,
				last_success_at: "2025-12-31T23:00:00Z",
				status: "partial",
				error: "previous useful failure detail",
			}));
			orchestrator.recordHookFailure!(root, "ingest /session.jsonl: exit 2:   ");

			const status = JSON.parse(readFileSync(join(root, "ingest_status.json"), "utf8"));
			expect(status.error).toBe("previous useful failure detail");
			expect(status.last_success_at).toBe("2025-12-31T23:00:00Z");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("final hook failure atomically records bounded status and preserves last success", () => {
		const root = mkdtempSync(join(tmpdir(), "orch-hook-failure-test-"));
		try {
			writeFileSync(join(root, "ingest_status.json"), JSON.stringify({
				version: 1,
				last_attempt_at: "2026-01-01T00:00:00Z",
				last_success_at: "2025-12-31T23:00:00Z",
				status: "ok",
				files_scanned: 1,
				emitted: 2,
				failure_count: 0,
				error: null,
				sweep_interval_seconds: 900,
			}));
			orchestrator.recordHookFailure!(root, `failed\n${"x".repeat(2000)}`);

			const status = JSON.parse(readFileSync(join(root, "ingest_status.json"), "utf8"));
			expect(status.status).toBe("error");
			expect(status.last_success_at).toBe("2025-12-31T23:00:00Z");
			expect(status.failure_count).toBe(1);
			expect(status.error.length).toBeLessThanOrEqual(240);
			expect(status.error).not.toContain("\n");
			expect(readdirSync(root).sort()).toEqual(["ingest_status.json"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("recordHookFailure redacts absolute paths and bounds error to 240 chars", () => {
		const root = mkdtempSync(join(tmpdir(), "orch-hook-redact-test-"));
		try {
			orchestrator.recordHookFailure!(root, "ingest failed at /Users/alice/.local/state/foo/bar.jsonl: " + "x".repeat(2000));
			const status = JSON.parse(readFileSync(join(root, "ingest_status.json"), "utf8"));
			expect(status.status).toBe("error");
			expect(status.error.length).toBeLessThanOrEqual(240);
			expect(status.error).not.toContain("/Users/alice");
			expect(status.error).toContain("<path>");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("runModule forwards STATE_ROOT as CODING_AGENT_ORCHESTRATOR_HOME", async () => {
		const customRoot = mkdtempSync(join(tmpdir(), "orch-runmodule-state-"));
		const previousState = process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT;
		process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT = customRoot;
		try {
			// Re-import the module so STATE_ROOT (read at module load time) reflects
			// the freshly-set HUMAIN_ORCHESTRATOR_STATE_ROOT. The cache-busting query
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
			if (previousState === undefined) delete process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT;
			else process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT = previousState;
			rmSync(customRoot, { recursive: true, force: true });
		}
	});
});


describe("/orchestrate argument parsing", () => {
	test("runs without confirmation unless interactive mode is explicitly requested", () => {
		expect(orchestrator.parseArgs).toBeFunction();
		const parsed = orchestrator.parseArgs!("repair the login race");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(false);
	});

	test("enables confirmation gates when --interactive is supplied", () => {
		expect(orchestrator.parseArgs).toBeFunction();
		const parsed = orchestrator.parseArgs!("repair the login race --interactive");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(true);
		expect(parsed.unknownFlags).toEqual([]);
	});

	test("normalises --complexity onto the integer 1-10 scale Rule-2 bands use", () => {
		const parse = orchestrator.parseArgs!;
		expect(parse("repair flow --complexity 6.5").complexity).toBe(7);
		expect(parse("repair flow --complexity 12").complexity).toBe(10);
		expect(parse("repair flow --complexity 0").complexity).toBe(1);
		expect(parse("repair flow --complexity abc").complexity).toBe(5);
		// Previously 6.5 matched no workers_by_complexity band and planned zero recon.
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon, complexity: parse("repair flow --complexity 6.5").complexity,
			taskClass: "implementation", goal: "repair flow", runId: "run" });
		expect(tasks.length).toBe(4);
	});

	test("clampComplexity treats absent or non-numeric triage values as the fallback, not the minimum", () => {
		const clamp = orchestrator.clampComplexity;
		for (const absent of [undefined, null, "", "  ", true, false, [], [7], {}, "abc", Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(clamp(absent)).toBe(5);
		}
		expect(clamp(7)).toBe(7);
		expect(clamp("7")).toBe(7);
		expect(clamp(-3)).toBe(1);
		expect(clamp(12)).toBe(10);
		expect(clamp(6.5)).toBe(7);
	});
});

describe("child stream handler safety", () => {
	test("converts a stdout handler throw into a failed dispatch", async () => {
		expect(orchestrator.guardChildStreamHandler).toBeFunction();
		let stderr = "";
		let killed = false;
		const exitCode = await new Promise<number>((resolve) => {
			orchestrator.guardChildStreamHandler!(
				"stdout",
				() => {
					throw new Error("capture overflow");
				},
				{
					appendStderr: (text: string) => {
						stderr += text;
					},
					kill: () => {
						killed = true;
					},
					finish: resolve,
				},
			);
		});

		expect(exitCode).toBe(1);
		expect(killed).toBe(true);
		expect(stderr).toBe("\n[orchestrator] stdout handler failed: capture overflow");
	});

	test("still fails the dispatch when error formatting fails", async () => {
		let stderr = "";
		const exitCode = await new Promise<number>((resolve) => {
			orchestrator.guardChildStreamHandler!(
				"stdout",
				() => {
					throw { toString: () => { throw new Error("cannot format"); } };
				},
				{
					appendStderr: (text: string) => {
						stderr += text;
					},
					kill: () => {},
					finish: resolve,
				},
			);
		});

		expect(exitCode).toBe(1);
		expect(stderr).toBe("\n[orchestrator] stdout handler failed: unknown error");
	});
});

describe("dispatch event logging", () => {
	test("writes tool updates without nested worker histories", () => {
		expect(orchestrator.appendTrimmedEventLog).toBeFunction();
		const dir = mkdtempSync(join(tmpdir(), "orch-event-log-test-"));
		const eventsLog = join(dir, "worker.events.jsonl");
		try {
			orchestrator.appendTrimmedEventLog!(eventsLog, {
				type: "tool_execution_update",
				partialResult: {
					details: {
						results: [{
							taskId: "worker-1",
							agent: "worker",
							usage: { input: 1, output: 2 },
							messages: [{ role: "assistant", content: "x".repeat(1024 * 1024) }],
						}],
					},
				},
			});

			const logged = JSON.parse(readFileSync(eventsLog, "utf8"));
			expect(logged.partialResult.details.results[0]).toEqual({
				taskId: "worker-1",
				agent: "worker",
				usage: { input: 1, output: 2 },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

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
		const session = new orchestrator.RunSession!("cancel-ui-test", ctx as never, "update the payments page");
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
		const session = new orchestrator.RunSession!("ui-throws-after-shutdown-test", ctx as never, "goal");
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

describe("recon tool boundary", () => {
	test("carries read-only tools and the configured model from planned recon to subprocess creation", async () => {
		expect(orchestrator.dispatchParallel).toBeFunction();
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon,
			complexity: 5, taskClass: "implementation", goal: "repair flow", runId: "run" });
		const invocations: string[][] = [];
		// depth 0, then the injected deps: `dispatchParallel` takes both since the
		// progress-view nesting depth and the test seam landed independently.
		await orchestrator.dispatchParallel(process.cwd(), "run", tasks,
			{ scout: { model: "provider/recon-model", effort: "low" } }, {} as never, 0, {
			recordEvent: async () => {},
			runProcess: (opts) => orchestrator.runSubagentProcess({
				...opts,
				spawnChild: (_command, args) => {
					invocations.push([...args]);
					throw new Error("test: stop at subprocess creation");
				},
			}),
		});
		expect(invocations).toHaveLength(3);
		for (const args of invocations) {
			expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
			expect(args[args.indexOf("--provider") + 1]).toBe("provider");
			expect(args[args.indexOf("--model") + 1]).toBe("recon-model");
		}
	});

	// method.json binds recon to the `scout` capability so the dispatch lands on
	// the purpose-built read-only `orch-scout` persona rather than an
	// implementer persona that merely happens to be tool-restricted.
	test("runs recon under the orch-scout persona at the cheap tier", () => {
		const policy = METHOD.rules.pre_implementation_recon;
		expect(policy.worker_capability).toBe("scout");
		expect(TIER_CAPABILITIES.cheap).toContain(policy.worker_capability);
	});

	test("passes the orch-scout persona prompt to the recon subprocess", async () => {
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon,
			complexity: 5, taskClass: "implementation", goal: "repair flow", runId: "run" });
		const personas: string[] = [];
		await orchestrator.dispatchParallel(process.cwd(), "run", tasks,
			{ scout: { model: "provider/recon-model", effort: "low" } }, {} as never, 0, {
			recordEvent: async () => {},
			runProcess: (opts) => orchestrator.runSubagentProcess({
				...opts,
				spawnChild: (_command, args) => {
					const list = [...args];
					const at = list.indexOf("--append-system-prompt");
					personas.push(at === -1 ? "(none)" : basename(String(list[at + 1])));
					throw new Error("test: stop at subprocess creation");
				},
			}),
		});
		expect(personas).toEqual(["orch-scout.md", "orch-scout.md", "orch-scout.md"]);
	});
});

// Phase 2 item 3 (tool permissions): a lead/architect dispatch's own tool
// allow-list comes ONLY from its persona frontmatter (`--tools`, see
// runSubagentProcess's `tools = opts.tools && opts.tools.length > 0 ? opts.tools
// : persona?.tools`) — dispatchParallel never passes a `tools:` override for
// these capabilities (that is reserved for recon, see the boundary above).
// This proves the child process is actually launched WITHOUT `edit`/`write` in
// its allow-list, not just that the persona file on disk lacks them.
describe("lead/architect tool permissions", () => {
	for (const capability of ["lead", "architect"] as const) {
		test(`${capability} dispatch passes --tools without edit/write`, async () => {
			const invocations: string[][] = [];
			const tasks: DispatchTask[] = [{ taskId: `run-${capability}`, capability, task: "do the thing" }];
			await orchestrator.dispatchParallel(process.cwd(), "run", tasks,
				{ [capability]: { model: "provider/some-model" } }, {} as never, 0, {
				recordEvent: async () => {},
				runProcess: (opts) => orchestrator.runSubagentProcess({
					...opts,
					spawnChild: (_command, args) => {
						invocations.push([...args]);
						throw new Error("test: stop at subprocess creation");
					},
				}),
			});
			expect(invocations).toHaveLength(1);
			const args = invocations[0];
			const toolsIndex = args.indexOf("--tools");
			expect(toolsIndex).toBeGreaterThan(-1);
			const tools = args[toolsIndex + 1].split(",");
			expect(tools).not.toContain("edit");
			expect(tools).not.toContain("write");
			// Sanity: the allow-list is real, not accidentally empty/absent.
			expect(tools.length).toBeGreaterThan(0);
		});
	}

	// Ties the mock persona's `tools:` list above to the real frontmatter on disk,
	// so the mock cannot silently drift from what production actually resolves.
	test("mock personas' tool lists match the real bridge/agents frontmatter", () => {
		const real: Record<string, string> = {
			lead: readFileSync(join(import.meta.dir, "..", "..", "agents", "orchestrator-lead.md"), "utf-8"),
			architect: readFileSync(join(import.meta.dir, "..", "..", "agents", "orch-architect.md"), "utf-8"),
		};
		const mocked: Record<string, string[]> = {
			lead: ["read", "bash", "grep", "find", "ls", "subagent"],
			architect: ["read", "grep", "find", "ls", "bash"],
		};
		for (const key of ["lead", "architect"] as const) {
			const m = /^tools:\s*(.+)$/m.exec(real[key]);
			expect(m).not.toBeNull();
			const realTools = m![1].split(",").map((t) => t.trim());
			expect(mocked[key].sort()).toEqual([...realTools].sort());
		}
	});
});

// The Rule-2 fan-out is parent-owned and billed. If the lead persona also told
// leads to dispatch their own `orch-scout` recon, every qualifying run would pay
// for recon twice and the second round would be invisible to the bridge's worker
// accounting. Guard the instruction, not just the code.
describe("lead persona recon contract", () => {
	const raw = readFileSync(
		join(import.meta.dir, "..", "..", "agents", "orchestrator-lead.md"),
		"utf-8",
	);
	// Match on prose, not formatting: `**not**` must not be able to slip a
	// prohibition past these assertions.
	const leadPersona = raw.replace(/\*/g, "");

	test("does not instruct leads to dispatch their own recon scouts", () => {
		expect(leadPersona).not.toMatch(/dispatch\s+3[–-]5\s+`?orch-scout/i);
		expect(leadPersona).toMatch(/do not dispatch your own `orch-scout`/i);
	});

	test("tells leads recon evidence arrives from the parent", () => {
		expect(leadPersona).toMatch(/parent-owned/i);
		expect(leadPersona).toMatch(/Recon evidence/);
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

describe("leadPrompt recon evidence handoff", () => {

	test("adds completed recon evidence to the lead prompt", () => {
		const prompt = orchestrator.leadPrompt(
			"repair flow",
			planFixture,
			undefined,
			"### run-recon-0\naffected: src/a.ts",
			0,
			1,
			adapterFixture,
		);
		expect(prompt).toContain("Recon evidence");
		expect(prompt).toContain("affected: src/a.ts");
		expect(prompt).toContain("Do not repeat broad repository discovery");
	});

	test("states no parent-owned recon was required when evidence is empty", () => {
		expect(orchestrator.leadPrompt).toBeFunction();
		const prompt = orchestrator.leadPrompt!(
			"repair flow",
			planFixture,
			undefined,
			"",
			0,
			1,
			adapterFixture,
		);
		expect(prompt).toContain("Recon evidence");
		expect(prompt).toContain("none");
	});

	test("tells the lead nested subagent fan-out is not authoritative worker accounting", () => {
		const prompt = orchestrator.leadPrompt(
			"repair flow",
			planFixture,
			undefined,
			"### run-recon-0\naffected: src/a.ts",
			0,
			1,
			adapterFixture,
		);
		expect(prompt).not.toContain("workers fan out inside each lead");
		expect(prompt).toContain("not authoritative worker accounting");
	});

	test("leaves final QA to the orchestrator instead of asking the lead to run orch-qa-agent", () => {
		// Regression: ht-orch-1790256789245-1a3fms ran QA twice (lead's orch-qa-agent, then the bridge's).
		const prompt = orchestrator.leadPrompt("repair flow", planFixture, undefined, "", 0, 1, adapterFixture);
		expect(prompt).not.toContain("run QA via orch-qa-agent");
		expect(prompt).toContain("Do not dispatch orch-qa-agent");
		expect(prompt).not.toContain("does not see, log, or bill");
		expect(prompt).not.toMatch(/- orch-qa-agent: model/);
	});
});

function dispatchResult(task: DispatchTask, exitCode = 0): DispatchResult {
	return {
		taskId: task.taskId, capability: task.capability, model: "provider/model", exitCode,
		stdout: exitCode === 0 ? `evidence for ${task.taskId}` : "",
		stderr: exitCode === 0 ? "" : "Error: unavailable",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
		// `costReported` became a required field on DispatchResult when priced
		// terminal telemetry landed on main; true here because the fixture supplies
		// a concrete cost, matching what a provider-reported dispatch looks like.
		durationMs: 1, costUsd: 0.01, costReported: true, filesChanged: [],
	};
}

const reconLeadInput = { runId: "run", goal: "repair flow", plan: planFixture, adapter: adapterFixture };
/** Two independent leads, as the architect must now declare them (one wave). */
const twoIndependentLeads = {
	taskId: "run-architect", capability: "architect", model: "m", exitCode: 0, stderr: "",
	stdout: "## Lead assignments\nLead 1: backend (depends on: none)\nLead 2: frontend (depends on: none)\n",
	usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
} as DispatchResult;

/**
 * Explicit deadline for tests that await a rejection: a regression that stops
 * honouring cancellation must fail fast with a named reason, not hang the
 * whole suite until an external killer intervenes.
 */
function withDeadline<T>(promise: Promise<T>, ms = 2_000, label = "operation"): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`test deadline: ${label} did not settle within ${ms}ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Capture a promise's rejection without `expect(p).rejects`: on this Bun
 * version that matcher spins the event loop synchronously while `p` is still
 * pending, so a test that settles `p` later (e.g. resolving recon after
 * cancelling) never gets to run and the whole suite hangs.
 */
async function rejectionOf(promise: Promise<unknown>, ms = 2_000, label = "operation"): Promise<Error> {
	try {
		await withDeadline(promise, ms, label);
	} catch (err) {
		return err as Error;
	}
	throw new Error(`${label} resolved but was expected to reject`);
}

describe("parent-owned recon dispatch seam", () => {
	test("a run cancelled before recon dispatches nothing and bills nothing", async () => {
		const cancellation = new RunCancellation();
		cancellation.cancel();
		const dispatched: string[] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		const run = orchestrator.dispatchReconAndLeads(reconLeadInput, {
			dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
			capture: async (r) => { billed.push(r); },
			setPhase: (phase) => { phases.push(phase); },
			throwIfCancelled: () => cancellation.throwIfCancelled(),
		});
		expect((await rejectionOf(run, 2_000, "pre-cancelled run")).message).toBe("Orchestration cancelled");
		expect(dispatched).toEqual([]);
		expect(billed).toEqual([]);
		expect(phases).toEqual([]);
	});

	test.each(["recon", "billing"])("cancellation during %s bills finished recon but never starts or announces leads", async (cancelDuring) => {
		const cancellation = new RunCancellation();
		const events: string[] = [];
		const phases: string[] = [];
		const billed: DispatchResult[] = [];
		let checks = 0;
		let finishRecon!: (results: DispatchResult[]) => void;
		const pendingRecon = new Promise<DispatchResult[]>((resolve) => { finishRecon = resolve; });
		let workers: DispatchResult[] = [];
		const run = orchestrator.dispatchReconAndLeads(reconLeadInput, {
			dispatch: async (tasks) => {
				for (const task of tasks) events.push(`dispatch_started:${task.taskId}`);
				if (tasks[0].capability === "lead") return tasks.map((task) => dispatchResult(task));
				workers = tasks.map((task) => dispatchResult(task, 137));
				return pendingRecon;
			},
			capture: async (r) => {
				billed.push(r);
				if (cancelDuring === "billing") cancellation.cancel();
			},
			setPhase: (phase) => { phases.push(phase); },
			throwIfCancelled: () => { checks++; cancellation.throwIfCancelled(); },
		});
		if (cancelDuring === "recon") cancellation.cancel();
		const rejection = rejectionOf(run, 2_000, `cancel during ${cancelDuring}`);
		finishRecon(workers);
		expect((await rejection).message).toBe("Orchestration cancelled");
		expect(checks).toBeGreaterThan(0);
		// Every finished recon worker is billed exactly once, even though the run
		// was cancelled while they ran / while they were being billed.
		expect(billed).toEqual(workers);
		expect(events).toEqual(["dispatch_started:run-recon-0", "dispatch_started:run-recon-1", "dispatch_started:run-recon-2"]);
		expect(phases.some((phase) => phase.includes("lead"))).toBe(false);
	});

	test("cancellation after leads finish still bills every lead exactly once, then rejects", async () => {
		const cancellation = new RunCancellation();
		const billed: DispatchResult[] = [];
		let leadTasks: DispatchTask[] = [];
		const run = orchestrator.dispatchReconAndLeads({ ...reconLeadInput,
			plan: { ...planFixture, topology: { ...planFixture.topology, leads: 2 } },
			architectResult: twoIndependentLeads,
		}, {
			dispatch: async (tasks) => {
				if (tasks[0].capability === "lead") leadTasks = tasks;
				return tasks.map((task) => dispatchResult(task));
			},
			capture: async (r) => {
				billed.push(r);
				// Cancel while the FIRST lead is being billed; the second must still be billed.
				if (r.taskId === "run-lead-0") cancellation.cancel();
			},
			setPhase: () => {},
			throwIfCancelled: () => cancellation.throwIfCancelled(),
		});
		expect((await rejectionOf(run, 2_000, "cancel during lead billing")).message).toBe("Orchestration cancelled");
		expect(leadTasks.map((t) => t.taskId)).toEqual(["run-lead-0", "run-lead-1"]);
		expect(billed.map((r) => r.taskId)).toEqual(["run-recon-0", "run-recon-1", "run-recon-2", "run-lead-0", "run-lead-1"]);
		expect(new Set(billed.map((r) => r.taskId)).size).toBe(billed.length);
	});

	test("awaits recon and its billing before dispatching every lead, returning original worker results", async () => {
		expect(orchestrator.dispatchReconAndLeads).toBeFunction();
		const batches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		let finishRecon!: (results: DispatchResult[]) => void;
		const pendingRecon = new Promise<DispatchResult[]>((resolve) => { finishRecon = resolve; });
		const run = orchestrator.dispatchReconAndLeads({ ...reconLeadInput,
			plan: { ...planFixture, topology: { ...planFixture.topology, leads: 2 } },
			architectResult: twoIndependentLeads,
		}, {
			dispatch: async (tasks) => {
				batches.push(tasks);
				if (tasks[0].capability !== "lead") return pendingRecon;
				expect(billed.map((r) => r.taskId)).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
				return tasks.map((task) => dispatchResult(task));
			},
			capture: async (result) => { billed.push(result); },
			setPhase: (phase) => { phases.push(phase); },
			throwIfCancelled: () => {},
		});
		expect(batches).toHaveLength(1);
		expect(batches[0].map((t) => t.taskId)).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
		expect(phases.some((p) => p.includes("lead"))).toBe(false);
		const workers = batches[0].map((task) => dispatchResult(task));
		finishRecon(workers);
		const result = await run;
		expect(result.workerResults).toBe(workers);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0", "run-lead-1"]);
		expect(batches).toHaveLength(2);
		for (const lead of batches[1]) {
			for (const worker of workers) expect(lead.task).toContain(worker.stdout);
		}
		expect(billed).toEqual([...workers, ...result.leadResults]);
		expect(billed.reduce((sum, r) => sum + r.costUsd, 0)).toBeCloseTo(0.05);
	});

	test.each([
		["investigation", 8], ["qa_verification", 8], ["implementation", 4],
	] as const)("skips recon for %s at complexity %i without billing phantom workers", async (taskClass, complexity) => {
		expect(orchestrator.dispatchReconAndLeads).toBeFunction();
		const batches: DispatchTask[][] = [];
		const billed: DispatchResult[] = [];
		const phases: string[] = [];
		const result = await orchestrator.dispatchReconAndLeads({ ...reconLeadInput,
			plan: { ...planFixture, task_class: taskClass, complexity },
		}, {
			dispatch: async (tasks) => { batches.push(tasks); return tasks.map((task) => dispatchResult(task)); },
			capture: async (r) => { billed.push(r); },
			setPhase: (phase) => { phases.push(phase); }, throwIfCancelled: () => {},
		});
		expect(batches.map((tasks) => tasks.map((t) => t.taskId))).toEqual([["run-lead-0"]]);
		expect(result.workerResults).toEqual([]);
		expect(billed).toEqual(result.leadResults);
		expect(phases[0]).toContain("no parent-owned recon required");
		expect(phases[0]).toContain(
			complexity < METHOD.rules.pre_implementation_recon.min_complexity
				? `complexity ${complexity} is below the Rule-2 threshold`
				: `task class "${taskClass}" is exempt`,
		);
		if (complexity >= METHOD.rules.pre_implementation_recon.min_complexity) expect(phases[0]).not.toContain("below");
		expect(phases.join("\n")).not.toContain("0/0");
	});

	test.each([false, true])("keeps failed workers visible and billed (allFailed=%s)", async (allFailed) => {
		expect(orchestrator.dispatchReconAndLeads).toBeFunction();
		const billed: DispatchResult[] = [];
		let leadTask = "";
		const result = await orchestrator.dispatchReconAndLeads(reconLeadInput, {
			dispatch: async (tasks) => {
				if (tasks[0].capability === "lead") {
					leadTask = tasks[0].task;
					return tasks.map((task) => dispatchResult(task));
				}
				return tasks.map((task, index) => dispatchResult(task, allFailed || index > 0 ? 1 : 0));
			},
			capture: async (r) => { billed.push(r); }, setPhase: () => {}, throwIfCancelled: () => {},
		});
		expect(result.workerResults).toHaveLength(3);
		expect(billed).toEqual([...result.workerResults, ...result.leadResults]);
		for (const worker of result.workerResults) {
			expect(leadTask).toContain(worker.taskId);
			if (worker.exitCode !== 0) expect(leadTask).toContain(`${worker.taskId} unavailable`);
		}
		if (allFailed) {
			expect(leadTask).toContain("DEGRADED");
			expect(leadTask).toContain("no verified recon evidence");
		} else {
			expect(leadTask).toContain("evidence for run-recon-0");
			expect(leadTask).not.toContain("DEGRADED");
		}
	});
});

describe("final accounting", () => {
	const architect = { ...dispatchResult({ taskId: "run-architect", capability: "architect", task: "" }), costUsd: 0.2 };
	const worker = { ...dispatchResult({ taskId: "run-recon-0", capability: "scout", task: "" }), costUsd: 0.02 };
	const lead = { ...dispatchResult({ taskId: "run-lead-0", capability: "lead", task: "" }), costUsd: 0.2 };

	test("includes parent-owned worker results in billed dispatches exactly once", () => {
		const billed = orchestrator.collectBilledResults({
			architectResult: architect, workerResults: [worker], leadResults: [lead],
			verificationResults: [], escalationResults: [],
		});
		expect(billed).toEqual([architect, worker, lead]);
		expect(billed.reduce((total, result) => total + result.costUsd, 0)).toBeCloseTo(0.42);
		expect(new Set(billed.map((r) => r.taskId)).size).toBe(billed.length);
	});

	test("omits the architect when none ran and keeps lifecycle order", () => {
		const qa = { ...dispatchResult({ taskId: "run-qa-0", capability: "qa_agent", task: "" }) };
		const esc = { ...dispatchResult({ taskId: "run-esc-0", capability: "implementation_strong", task: "" }) };
		const billed = orchestrator.collectBilledResults({
			workerResults: [worker], leadResults: [lead], verificationResults: [qa], escalationResults: [esc],
		});
		expect(billed.map((r) => r.taskId)).toEqual(["run-recon-0", "run-lead-0", "run-qa-0", "run-esc-0"]);
	});

	test("summarizes recon workers with counts, cost, and summarized failure diagnostics", () => {
		const failed = {
			...dispatchResult({ taskId: "run-recon-1", capability: "scout", task: "" }, 1),
			stderr: `${"noise\n".repeat(50)}Error: provider unavailable\n    at stack frame\n`,
			costUsd: 0.01,
		};
		const line = orchestrator.summarizeReconWorkers([worker, failed]);
		expect(line).toContain("recon workers: 1/2 completed · $0.0300");
		expect(line).toContain("run-recon-1 exit 1");
		expect(line).toContain("provider unavailable");
		expect(line).not.toContain("noise\nnoise");
		expect(line.length).toBeLessThan(400);
	});

	test("states that no recon workers were required when none ran", () => {
		expect(orchestrator.summarizeReconWorkers([])).toBe("recon workers: none (not required for this task)");
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
		const session = new orchestrator.RunSession!("progress-ui-test", ctx as never, "track worker progress");
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
		const session = new orchestrator.RunSession!("progress-log-test", ctx as never, "log progress carefully");
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
		const session = new orchestrator.RunSession("message-queue-sealed", {
			ui: { notify() {}, setStatus() {}, setWidget: (_id: string, lines?: string[]) => { if (lines) widgets.push(lines); } },
		} as never, "steer the running lead");
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
		const session = new orchestrator.RunSession!("timing-test", fakeCtx() as never, "goal");
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
		const session = new orchestrator.RunSession!("timing-test-2", fakeCtx() as never, "goal");
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
			const session = new orchestrator.RunSession!("timing-test-3", fakeCtx() as never, "goal");
			expect(session.terminalTiming().started_at).toBe(new Date(fixed).toISOString());
			session.close();
		} finally {
			Date.now = original;
		}
	});

	test("run terminal outcomes carry the timing fields", () => {
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const complete = source.slice(source.indexOf("async function completeRun("), source.indexOf("async function failRun("));
		const fail = source.slice(source.indexOf("async function failRun("), source.indexOf("async function cancelRun("));
		const cancel = source.slice(source.indexOf("async function cancelRun("), source.indexOf("// Subagent dispatch"));
		for (const fn of [complete, fail, cancel]) {
			expect(fn).toContain("...timing");
		}
		// Every terminal call inside the /orchestrate handler must pass the session timing.
		const handler = source.slice(source.indexOf('pi.registerCommand("orchestrate"'), source.indexOf('pi.registerCommand("orchestrator-models"'));
		const calls = handler.match(/await (?:completeRun|failRun|cancelRun)\([^;]*?\);/gs) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(6);
		for (const call of calls) expect(call).toContain("session.terminalTiming()");
	});
});

describe("batched telemetry through the Python batch CLI", () => {
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

	test("recordRunStarted records durable ownership evidence (pid/hostname/process-start identity/session id)", async () => {
		const runId = `ht-started-${Date.now()}`;
		orchestrator.recordRunStarted!(runId, "/sessions/some-session.jsonl");
		await orchestrator.recordQueue!.flush();
		const events = readFileSync(join(pythonStateRoot, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const started = events.find((e) => e.run_id === runId && e.event === "run_started");
		// The session_id is reduced to its basename (review note, Phase A review): the full absolute
		// path is never needed downstream (`run_evidence.classify_liveness` reads only pid/hostname)
		// and would otherwise leak the OS username / home-directory layout into a durable, shared log.
		expect(started).toMatchObject({ session_id: "some-session.jsonl", pid: process.pid, hostname: require("node:os").hostname() });
		expect(typeof started?.process_started_at_ms).toBe("number");
		expect(Number.isFinite(started?.process_started_at_ms)).toBe(true);
		expect(typeof started?.started_at).toBe("string");
	});

	test("recordRunStarted accepts a null session id when the runtime has none", async () => {
		const runId = `ht-started-nosession-${Date.now()}`;
		orchestrator.recordRunStarted!(runId, null);
		await orchestrator.recordQueue!.flush();
		const events = readFileSync(join(pythonStateRoot, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const started = events.find((e) => e.run_id === runId && e.event === "run_started");
		expect(started).toMatchObject({ session_id: null });
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

	test("cancelRun writes a distinct run_cancelled event and run-cancelled outcome, never run-failed", async () => {
		const runId = `ht-cancelrun-${Date.now()}`;
		orchestrator.recordEvent!("dispatch_started", { run_id: runId, task_id: `${runId}-lead-0` });
		const report = await orchestrator.cancelRun!(runId, "orchestrate_cancel", timing());
		expect(report.ok).toBe(true);
		const outcome = rows("outcomes.jsonl").find((r) => r.run_id === runId && r.task_id === "run-cancelled");
		expect(outcome).toMatchObject({ outcome: "cancelled", note: "orchestrate_cancel", elapsed_source: "monotonic" });
		expect(rows("outcomes.jsonl").some((r) => r.run_id === runId && r.task_id === "run-failed")).toBe(false);
		const events = rows("events.jsonl").filter((r) => r.run_id === runId).map((r) => r.event);
		expect(events).toEqual(["dispatch_started", "run_cancelled"]);
		const cancelEvent = rows("events.jsonl").find((r) => r.run_id === runId && r.event === "run_cancelled");
		expect(cancelEvent).toMatchObject({ reason: "orchestrate_cancel", elapsed_source: "monotonic" });
		expect(typeof cancelEvent?.started_at).toBe("string");
		expect(typeof cancelEvent?.finished_at).toBe("string");
		expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("cancelled");
	}, 30_000);

	test("cancelReasonLabel maps every cancellation source to its documented label", () => {
		expect(orchestrator.cancelReasonLabel!("user")).toBe("orchestrate_cancel");
		expect(orchestrator.cancelReasonLabel!("shutdown")).toBe("session_shutdown");
		expect(orchestrator.cancelReasonLabel!("signal")).toBe("signal");
		expect(orchestrator.cancelReasonLabel!(undefined)).toBe("unknown");
	});

	test("exactly one terminal event/outcome is ever written per run_id, even if two terminal paths race", async () => {
		const runId = `ht-single-terminal-${Date.now()}`;
		orchestrator.recordEvent!("dispatch_started", { run_id: runId, task_id: `${runId}-lead-0` });
		const first = await orchestrator.cancelRun!(runId, "signal", timing());
		expect(first.ok).toBe(true);
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		try {
			// A second terminal path (e.g. a crash unwind racing an already-recorded cancel)
			// must not add a second run_failed/run_cancelled event or outcome row for the same run.
			const second = await orchestrator.failRun!(runId, "crashed: too late", timing());
			expect(second.ok).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings.some((w) => w.includes(runId) && w.includes("already has a terminal event"))).toBe(true);
		const terminalEvents = rows("events.jsonl").filter((r) => r.run_id === runId && (r.event === "run_cancelled" || r.event === "run_failed" || r.event === "run_completed"));
		expect(terminalEvents).toHaveLength(1);
		expect(terminalEvents[0].event).toBe("run_cancelled");
		const terminalOutcomes = rows("outcomes.jsonl").filter((r) => r.run_id === runId && ["run-cancelled", "run-failed", "run-complete"].includes(String(r.task_id)));
		expect(terminalOutcomes).toHaveLength(1);
		expect(terminalOutcomes[0].task_id).toBe("run-cancelled");
	}, 30_000);

	test("completeRun/failRun/cancelRun each carry elapsed_ms, started_at and finished_at when timing is supplied, and omit them (never zero) when it is not", async () => {
		const runId = `ht-elapsed-${Date.now()}`;
		const withTiming = await orchestrator.cancelRun!(runId, "signal", timing());
		expect(withTiming.ok).toBe(true);
		const outcome = rows("outcomes.jsonl").find((r) => r.run_id === runId);
		expect(outcome?.elapsed_ms).toBe(1);
		expect(typeof outcome?.started_at).toBe("string");
		expect(typeof outcome?.finished_at).toBe("string");

		const runId2 = `ht-elapsed-unknown-${Date.now()}`;
		const withoutTiming = await orchestrator.cancelRun!(runId2, "signal");
		expect(withoutTiming.ok).toBe(true);
		const outcome2 = rows("outcomes.jsonl").find((r) => r.run_id === runId2);
		// No session/timing to derive elapsed from: the field must be absent, never a fabricated 0.
		expect(outcome2?.elapsed_ms).toBeUndefined();
		expect("elapsed_ms" in (outcome2 ?? {})).toBe(false);
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
		const complete = source.slice(source.indexOf("async function completeRun("), source.indexOf("async function failRun("));
		const fail = source.slice(source.indexOf("async function failRun("), source.indexOf("async function cancelRun("));
		const cancel = source.slice(source.indexOf("async function cancelRun("), source.indexOf("// Subagent dispatch"));
		for (const fn of [complete, fail, cancel]) expect(fn).toContain("flush()");
		// Every terminal call reports telemetry cumulatively since the run started, not just the final drain.
		const handler = source.slice(source.indexOf('pi.registerCommand("orchestrate"'), source.indexOf('pi.registerCommand("orchestrator-models"'));
		const calls = handler.match(/await (?:completeRun|failRun|cancelRun)\([^;]*?\);/gs) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(6);
		for (const call of calls) expect(call).toContain("session.telemetryBaseline");
		// Non-terminal records must not block dispatch: no awaited single-record spawns remain.
		expect(source).not.toMatch(/await recordEvent\(/);
		expect(source).not.toMatch(/await recordModelCall\(/);
		expect(source).not.toMatch(/await recordOutcome\(/);
		// The legacy single-record CLI commands are for other runtimes; the bridge uses `batch`.
		expect(source).toContain('"batch"');
	});
});

describe("confirmation gates", () => {
	// Kept this branch's parameterised version over main's single-case variant:
	// it covers interactive=true as well, asserts the return value, and asserts
	// the ctx.confirm delegation. The expected detail string is main's wording,
	// which the merged confirmation call now uses (progress-aware timeouts made
	// "up to N min per dispatch" wrong).
	test.each([false, true])("dispatch call passes separate confirmation arguments (interactive=%s)", async (interactive) => {
		// Execute the actual call expression after the plan summary, not a copy of it.
		// This isolates argument construction without planning or dispatching agents.
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const afterSummary = source.slice(source.indexOf("session.log(planSummary.join"));
		const call = afterSummary.match(/confirmStep\([\s\S]*?\n\s*\)/)?.[0];
		if (!call) throw new Error("Dispatch confirmation call not found after plan summary");
		const invoke = new Function("ctx", "pipeline", "parsed", "DISPATCH_TIMEOUT_MS", "confirmStep", `return ${call};`);
		const confirm = mock(() => Promise.resolve(false));
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };
		const confirmStep = mock(orchestrator.confirmStep);

		const result = await invoke(ctx, "lead → workers → qa", { interactive }, 120000, confirmStep);

		const details =
			"lead → workers → qa\n\nOrchestrating stages use an inactivity limit plus an absolute ceiling (leaf dispatches use a fixed timeout); live progress shows above the editor.";
		expect(confirmStep).toHaveBeenCalledWith(
			ctx,
			"Dispatch this plan?",
			details,
			interactive,
		);
		expect(result).toBe(!interactive);
		if (interactive) {
			expect(confirm).toHaveBeenCalledWith("Dispatch this plan?", details);
		} else {
			expect(confirm).not.toHaveBeenCalled();
		}
	});

	test("auto-confirms when interactive confirmation is not requested", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const confirm = mock(() => false);
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", false)).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	test("opens the confirmation dialog in interactive mode", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const confirm = mock(() => Promise.resolve(false));
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(confirm).toHaveBeenCalledWith("Dispatch?", "details");
	});

	test("aborts an interactive confirmation request without a UI", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const notify = mock();
		const ctx = { hasUI: false, ui: { confirm: mock(), notify } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"Dispatch?: no UI to confirm — remove --interactive to run automatically",
			"error",
		);
	});
});

describe("runSubagentProcess process/event handling", () => {
	// `fileURLToPath` (not `.pathname`) so this resolves correctly on paths with
	// spaces or non-ASCII characters, which `.pathname` percent-encodes instead
	// of decoding.
	const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
	const repoDir = mkdtempSync(join(tmpdir(), "orch-subagent-process-test-"));
	afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

	function spawnFixtureScript(script: string) {
		return (_command: string, _args: readonly string[], options: unknown) =>
			nodeSpawn(process.execPath, [join(fixturesDir, script)], options as never);
	}

	function spawnInlineScript(code: string) {
		return (_command: string, _args: readonly string[], options: unknown) =>
			nodeSpawn(process.execPath, ["-e", code], options as never);
	}

	function createSession(id: string, widgets: string[][] = []) {
		const ctx = {
			ui: {
				setWidget: (_id: string, value: string[] | undefined) => {
					if (value) widgets.push(value);
				},
				setStatus: () => {},
				notify: mock(),
			},
		};
		return new orchestrator.RunSession!(id, ctx as never, "progress timeout test", repoDir);
	}

	function runLead(code: string, taskId: string, timeouts: { inactivityMs: number; maxMs: number }, session?: InstanceType<typeof orchestrator.RunSession>) {
		return orchestrator.runSubagentProcess!({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			capability: "lead",
			taskId,
			label: "lead",
			leadTimeouts: timeouts,
			session,
			spawnChild: spawnInlineScript(code),
		});
	}

	test("active lead stays alive on distinct tool progress beyond inactivity and settles", async () => {
		const result = await runLead(
			`let i=0;const timer=setInterval(()=>{process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"file-"+i++}})+"\\n");if(i===12){clearInterval(timer);setTimeout(()=>{for(const e of [{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"done"}],usage:{input:1,output:1,cost:{total:0}}}},{type:"agent_end"},{type:"agent_settled"}])process.stdout.write(JSON.stringify(e)+"\\n");},30)}},50);`,
			"active-lead",
			{ inactivityMs: 1000, maxMs: 5000 },
		);

		expect(result.outcome).toBe("completed");
		expect(result.exitCode).toBe(0);
	});

	test("idle lead times out on message_start heartbeats with an inactivity report", async () => {
		const result = await runLead(
			`const timer=setInterval(()=>process.stdout.write(JSON.stringify({type:"message_start",message:{role:"assistant"}})+"\\n"),20);setTimeout(()=>clearInterval(timer),1500);`,
			"idle-lead",
			{ inactivityMs: 600, maxMs: 3000 },
		);

		expect(result.exitCode).toBe(124);
		expect(result.outcome).toBe("timed_out");
		expect(result.timeoutReason).toBe("inactivity");
		expect(result.stderr).toContain("UNVERIFIED PARTIAL WORK — inactivity");
	});

	test("looping lead reports repeated tool calls before inactivity timeout", async () => {
		const result = await runLead(
			`setInterval(()=>process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"same.ts"}})+"\\n"),20);`,
			"looping-lead",
			{ inactivityMs: 1500, maxMs: 5000 },
		);

		expect(result.outcome).toBe("timed_out");
		expect(result.timeoutReason).toBe("inactivity");
		expect(result.stderr).toContain("UNVERIFIED PARTIAL WORK — inactivity");
		expect(result.stderr).toMatch(/repeatedToolCalls: [1-9]/);
	});

	test("active lead expires at its absolute ceiling despite ongoing progress", async () => {
		const result = await runLead(
			`let i=0;setInterval(()=>process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"file-"+i++}})+"\\n"),25);`,
			"absolute-lead",
			{ inactivityMs: 2000, maxMs: 1000 },
		);

		expect(result.exitCode).toBe(124);
		expect(result.outcome).toBe("timed_out");
		expect(result.timeoutReason).toBe("absolute");
		expect(result.stderr).toContain("clamped to the ceiling");
		expect(result.stderr).toContain("UNVERIFIED PARTIAL WORK — absolute");
	});

	test("cancellation kills the child and records an unverified cancelled report", async () => {
		const widgets: string[][] = [];
		const session = createSession("cancelled-progress-lead", widgets);
		try {
			const pending = runLead(
				`process.stdout.write(JSON.stringify({type:"message_start",message:{role:"assistant"}})+"\\n");setInterval(()=>{},1000);`,
				"cancelled-lead",
				{ inactivityMs: 1000, maxMs: 2000 },
				session,
			);
			setTimeout(() => session.cancellation.cancel(), 60);
			const result = await pending;

			expect(result.exitCode).toBe(137);
			expect(result.outcome).toBe("cancelled");
			expect(session.cancelledDispatches()).toEqual(["lead"]);
			const runLog = readFileSync(session.file("run.log"), "utf8");
			expect(runLog).toContain("UNVERIFIED PARTIAL WORK — cancelled");
			expect(runLog.match(/\ntaskId: cancelled-lead\n/g) ?? []).toHaveLength(1);
			expect(runLog.match(/partialText:/g) ?? []).toHaveLength(1);
			const doneRow = widgets.flat().find((line) => line.includes("UNVERIFIED PARTIAL WORK — cancelled"));
			expect(doneRow).toBeDefined();
			expect(doneRow).not.toContain("partialText:");
			expect(doneRow).not.toContain("\\n");
		} finally {
			session.close();
		}
	});

	test("timed-out progress dispatch retains trailing diagnostics until pipe close without revising its result", async () => {
		const session = createSession("timed-out-diagnostic-drain");
		// Model the real gap between kill/early settlement and stdio close deterministically.
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
		});
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "draining-lead", session,
				leadTimeouts: { inactivityMs: 100, maxMs: 1000 },
				spawnChild: () => child as never,
			});
			emit({ type: "message_end", message: { role: "assistant", content: "partial work", usage: { input: 10, output: 2, cost: { total: 0.02 } } } });
			const result = await pending;
			expect(result.outcome).toBe("timed_out");
			expect(result.interruption?.partialText).toBe("partial work");
			expect(result.costUsd).toBe(0.02);
			expect(result.costReported).toBe(true);
			session.close();
			const sealing = session.sealDiagnostics(Promise.resolve(true));
			emit({ type: "agent_settled" });
			child.stderr.write("trailing teardown diagnostic\n");
			expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
			child.emit("close", 137);
			expect(await sealing).toBe(true);
			const events = readFileSync(session.file("draining-lead.events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(events.map((event) => event.type)).toEqual(["message_end", "agent_settled"]);
			expect(readFileSync(session.file("draining-lead.stderr.log"), "utf8")).toContain("trailing teardown diagnostic");
			expect(result.outcome).toBe("timed_out");
			expect(result.usage.turns).toBe(1);
		} finally {
			child.emit("close", 137);
			session.close();
		}
	});

	test("cancellation drains already-buffered usage before returning the billed result", async () => {
		const session = createSession("cancelled-usage-drain");
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
		});
		try {
			let returned = false;
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "usage-drain", session,
				spawnChild: () => child as never,
			}).then((result) => { returned = true; return result; });
			session.cancel();
			await Promise.resolve();
			expect(returned).toBe(false);
			child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "buffered work", usage: { input: 10, output: 2, cost: { total: 0.03 } }, stopReason: "stop" } })}\n`);
			child.stdout.write('{"type":"agent_settled"}\n');
			child.emit("close", 0);
			const result = await pending;
			expect(result.outcome).toBe("cancelled");
			expect(result.exitCode).toBe(137);
			expect(result.costUsd).toBe(0.03);
			expect(result.costReported).toBe(true);
			expect(result.usage.turns).toBe(1);
			expect(result.interruption?.reason).toBe("cancelled");
		} finally {
			child.emit("close", 137);
			session.close();
		}
	});

	test("spend cap enforce stops a dispatch once, on the first message that crosses it", async () => {
		const { SpendCapTracker } = await import("./spend-cap.ts");
		const session = createSession("spend-cap-enforce");
		session.spendCaps = new SpendCapTracker({ mode: "enforce", usd_by_capability: { lead: 4 }, default_usd: 1 });
		const kill = mock(() => true);
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill, pid: undefined });
		const emit = (cost: number) => child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: `turn ${cost}`, usage: { input: 1, output: 1, cost: { total: cost } } } })}\n`);
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "capped-lead", session,
				spawnChild: () => child as never,
			});
			emit(3);
			emit(9); // one big jump from $3 to $12
			const result = await pending;
			expect(result.stopReason).toBe("spend_cap");
			expect(result.exitCode).toBe(125);
			expect(result.outcome).toBe("failed");
			expect(result.costUsd).toBe(12);
			expect(result.stderr).toContain("dispatch stopped (dispatch_spend_cap.mode=enforce)");
			const log = readFileSync(session.file("run.log"), "utf8");
			expect(log.match(/exceeded by capped-lead at \$\d+\.\d+ \(stopping it\)/g) ?? []).toHaveLength(1);
			// Exactly one cancel for the single large jump, and the crossing turn's text is kept.
			expect(kill).toHaveBeenCalledTimes(1);
			expect(result.stdout).toContain("turn 9");
		} finally {
			child.emit("close", 137);
			session.close();
		}
	});

	test("spend cap enforce does not kill a turn that is already the final answer", async () => {
		const { SpendCapTracker } = await import("./spend-cap.ts");
		const session = createSession("spend-cap-final-turn");
		session.spendCaps = new SpendCapTracker({ mode: "enforce", usd_by_capability: { lead: 4 }, default_usd: 1 });
		const kill = mock(() => true);
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "final-turn-lead", session,
				spawnChild: () => child as never,
			});
			emit({ type: "message_end", message: { role: "assistant", content: "final report\nSTATUS: completed", usage: { input: 1, output: 1, cost: { total: 9 } }, stopReason: "stop" } });
			emit({ type: "agent_settled" });
			child.emit("close", 0);
			const result = await pending;
			expect(kill).not.toHaveBeenCalled();
			expect(result.exitCode).toBe(0);
			expect(result.finalText).toContain("STATUS: completed");
			expect(readFileSync(session.file("run.log"), "utf8")).toContain("warn only");
		} finally {
			session.close();
		}
	});

	test("a provider error turn in json mode (exit 0) fails the dispatch and surfaces errorMessage in stderr", async () => {
		const session = createSession("provider-error-exit0");
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "openai-codex/gpt-6-astra",
				ctx: {} as never, capability: "security_review", taskId: "quota-sec", session,
				spawnChild: () => child as never,
			});
			emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "You have hit your usage limit. Try again later.", usage: { input: 0, output: 0, cost: { total: 0 } } } });
			emit({ type: "agent_end", messages: [] });
			emit({ type: "agent_settled" });
			child.emit("close", 0);
			const result = await pending;
			expect(result.exitCode).toBe(1);
			expect(result.outcome).toBe("failed");
			expect(result.stderr).toContain("usage limit");
		} finally {
			session.close();
		}
	});

	test("spend cap warn logs once and lets the dispatch finish", async () => {
		const { SpendCapTracker } = await import("./spend-cap.ts");
		const session = createSession("spend-cap-warn");
		session.spendCaps = new SpendCapTracker({ mode: "warn", usd_by_capability: { lead: 4 }, default_usd: 1 });
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "warned-lead", session,
				spawnChild: () => child as never,
			});
			for (const cost of [5, 5]) emit({ type: "message_end", message: { role: "assistant", content: "w", usage: { input: 1, output: 1, cost: { total: cost } } } });
			emit({ type: "message_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1, cost: { total: 0 } }, stopReason: "stop" } });
			emit({ type: "agent_settled" });
			child.emit("close", 0);
			const result = await pending;
			expect(result.exitCode).toBe(0);
			expect(result.stopReason).toBe("stop");
			const log = readFileSync(session.file("run.log"), "utf8");
			expect(log.match(/exceeded by warned-lead/g) ?? []).toHaveLength(1);
			expect(log).toContain("warn only");
		} finally {
			session.close();
		}
	});

	test("a lead's own subagent spend is billed and counts toward its spend cap", async () => {
		// Regression: ht-orch-1790256789245-1a3fms reported $1.56; the lead's implementer alone cost $10.14.
		const { SpendCapTracker } = await import("./spend-cap.ts");
		const session = createSession("nested-spend");
		session.spendCaps = new SpendCapTracker({ mode: "enforce", usd_by_capability: { lead: 4 }, default_usd: 1 });
		const kill = mock(() => true);
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill, pid: undefined });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		const nested = (type: string, cost: number) => ({
			type, toolName: "subagent", toolCallId: "call-1",
			[type === "tool_execution_end" ? "result" : "partialResult"]: { details: { results: [{ taskId: "impl", usage: { cost } }] } },
		});
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "nested-lead", session,
				spawnChild: () => child as never,
			});
			emit({ type: "message_end", message: { role: "assistant", content: "plan", usage: { input: 1, output: 1, cost: { total: 0.5 } } } });
			emit(nested("tool_execution_update", 1.0));
			emit(nested("tool_execution_update", 2.0)); // cumulative snapshot, not +2
			expect(session.totalCost()).toBeCloseTo(2.5);
			emit(nested("tool_execution_update", 3.8)); // $0.50 own + $3.80 nested crosses the $4 lead cap
			const result = await pending;
			expect(result.stopReason).toBe("spend_cap");
			expect(result.costUsd).toBe(0.5);
			expect(result.nestedCostUsd).toBeCloseTo(3.8);
			expect(kill).toHaveBeenCalledTimes(1);
			expect(readFileSync(session.file("run.log"), "utf8")).toContain("($3.8000 in its subagents)");
		} finally {
			child.emit("close", 137);
			session.close();
		}
	});

	test("cancellation settles without close after bounded usage drain and retains the diagnostic lease", async () => {
		const session = createSession("cancelled-without-close");
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(), stderr: new PassThrough(), kill: mock(() => true),
		});
		const emitUsage = (cost: number) => child.stdout.write(`${JSON.stringify({ type: "message_end", message: {
			role: "assistant", content: "buffered work", usage: { input: 10, output: 2, cost: { total: cost } }, stopReason: "stop",
		} })}\n`);
		let deadline: (() => void) | undefined;
		let deadlineMs: number | undefined;
		const realTimer = globalThis.setTimeout;
		const timers: ReturnType<typeof setTimeout>[] = [];
		let timer: ReturnType<typeof spyOn> | undefined;
		try {
			let settlements = 0;
			let result: Awaited<ReturnType<typeof orchestrator.runSubagentProcess>> | undefined;
			void orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "no-close", session,
				spawnChild: () => child as never,
			}).then(value => { settlements++; result = value; });
			// Capture only the cancellation deadline, not the normal progress timer.
			timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
				deadline = callback; deadlineMs = ms;
				const handle = realTimer(() => {}, 60_000);
				timers.push(handle);
				return handle;
			}) as typeof setTimeout);
			session.cancellation.cancel();
			const cancelDeadline = deadline;
			const cancelDeadlineMs = deadlineMs;
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
			await Promise.resolve();
			expect(result).toBeUndefined();
			// A later pipe callback arrives inside the grace period, without close.
			await new Promise<void>(resolve => realTimer(() => { emitUsage(.03); resolve(); }, 10));
			expect(result).toBeUndefined();
			expect(cancelDeadline).toBeDefined();
			expect(cancelDeadlineMs).toBeGreaterThan(0);
			expect(cancelDeadlineMs).toBeLessThanOrEqual(2000);
			cancelDeadline?.();
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(result?.outcome).toBe("cancelled");
			expect(result?.exitCode).toBe(137);
			expect(result?.costUsd).toBe(.03);
			expect(result?.costReported).toBe(true);
			expect(result?.usage.turns).toBe(1);
			expect(result?.interruption?.partialText).toBe("buffered work");
			session.close();
			const sealing = session.sealDiagnostics(Promise.resolve(true));
			deadline?.(); // the existing bounded seal deadline must fail, not revoke the lease
			expect(await sealing).toBe(false);
			emitUsage(.5);
			child.stderr.write("late teardown diagnostic\n");
			expect(readFileSync(session.file("no-close.events.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
			expect(result?.usage.turns).toBe(1);
			expect(result?.usage.cost).toBe(.03);
			child.emit("close", 0); // eventual real close may release, but never re-bill or seal
			await Promise.resolve();
			expect(settlements).toBe(1);
			expect(await session.sealDiagnostics(Promise.resolve(true))).toBe(false);
			expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
			expect(readFileSync(session.file("no-close.stderr.log"), "utf8")).toContain("late teardown diagnostic");
			expect(readFileSync(session.file("run.log"), "utf8").match(/\ntaskId: no-close\n/g) ?? []).toHaveLength(1);
		} finally {
			timer?.mockRestore();
			for (const handle of timers) clearTimeout(handle);
			child.emit("close", 137);
			child.stdout.destroy(); child.stderr.destroy();
			session.close();
		}
	});

	test("pre-cancelled leaf does not arm a stale timeout", async () => {
		const session = createSession("pre-cancelled-leaf");
		const previousTimeout = process.env.HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS;
		const originalSetTimeout = globalThis.setTimeout;
		const scheduledTimeouts: Array<{ delay: number; timer: ReturnType<typeof setTimeout> }> = [];
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const timer = originalSetTimeout(...args);
			scheduledTimeouts.push({ delay: Number(args[1] ?? 0), timer });
			return timer;
		}) as typeof setTimeout;
		process.env.HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS = "2000";
		try {
			const result = await orchestrator.runSubagentProcess!({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never,
				taskId: "pre-cancelled-leaf",
				capability: "worker",
				session,
				spawnChild: (_command: string, _args: readonly string[], options: unknown) => {
					const child = nodeSpawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], options as never);
					session.cancellation.cancel();
					return child;
				},
			});

			expect(result.outcome).toBe("cancelled");
			expect(result.exitCode).toBe(137);
			const runLog = readFileSync(session.file("run.log"), "utf8");
			expect(runLog.match(/\ntaskId: pre-cancelled-leaf\n/g) ?? []).toHaveLength(1);
			expect(scheduledTimeouts.filter(({ delay }) => delay === 2000)).toHaveLength(0);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			for (const { timer } of scheduledTimeouts) clearTimeout(timer);
			if (previousTimeout === undefined) delete process.env.HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS;
			else process.env.HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS = previousTimeout;
			session.close();
		}
	});

	test("cancellation racing a synchronous spawn failure records one interruption report", async () => {
		const session = createSession("cancelled-spawn-race");
		try {
			const result = await orchestrator.runSubagentProcess!({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never,
				taskId: "spawn-race-lead",
				capability: "lead",
				session,
				spawnChild: () => {
					session.cancellation.cancel();
					throw new Error("synchronous spawn failure");
				},
			});

			expect(result.outcome).toBe("cancelled");
			expect(result.exitCode).toBe(137);
			expect(result.interruption?.reason).toBe("cancelled");
			const runLog = readFileSync(session.file("run.log"), "utf8");
			expect(runLog.match(/\ntaskId: spawn-race-lead\n/g) ?? []).toHaveLength(1);
		} finally {
			session.close();
		}
	});

	test("nested worker turn growth keeps the lead alive and renders one worker summary", async () => {
		const widgets: string[][] = [];
		const session = createSession("nested-progress-lead", widgets);
		const script = `const emit=(turns)=>process.stdout.write(JSON.stringify({type:"tool_execution_update",partialResult:{details:{results:[{taskId:"worker-1",agent:"worker",depth:1,exitCode:-1,latestText:"working",usage:{turns}}]}}})+"\\n");emit(1);setTimeout(()=>emit(1),200);setTimeout(()=>emit(2),500);setTimeout(()=>emit(2),700);setTimeout(()=>{},900);setInterval(()=>{},1000);`;
		try {
			const result = await runLead(script, "nested-lead", { inactivityMs: 1500, maxMs: 6000 }, session);
			session.render();
			const dispatch = (session as unknown as { dispatches: Map<string, { progress: { nested: Map<string, { turns: number }> } }> }).dispatches.get("nested-lead");
			expect(result.outcome).toBe("timed_out");
			expect(result.timeoutReason).toBe("inactivity");
			expect(result.stderr).toContain("UNVERIFIED PARTIAL WORK — inactivity");
			expect(dispatch?.progress.nested.size).toBe(1);
			expect([...dispatch!.progress.nested.values()][0].turns).toBe(2);
		} finally {
			session.close();
		}
	});

	test("recovers a settled, stop-reason result when the child exits non-zero afterward", async () => {
		expect(orchestrator.runSubagentProcess).toBeFunction();
		const result = await orchestrator.runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			spawnChild: spawnFixtureScript("child-exit-after-settle.mjs"),
		});

		expect(result.finalText).toBe("fixture task completed");
		expect(result.processExitCode).toBe(1);
		expect(result.outcome).toBe("completed_after_process_error");
		expect(result.stderr).toContain("fixture shutdown failure");
		expect(result.exitCode).toBe(0);
		expect(result.postCompletionError).toContain("process exited 1");
		expect(result.postCompletionError).toContain("fixture shutdown failure");
	});

	test("long minified-bundle-style source line surfaces the sentinel and a stack frame past the 64 KiB pipe boundary (no session)", async () => {
		// Reproduces HT's real failure mode: an uncaught exception on a source
		// line long enough to model a minified bundle. Node prints that source
		// line first, then the error name/message/stack — over a pipe, anything
		// past ~64 KiB at process exit is silently dropped, so the sentinel and
		// stack never arrive. See fixtures/long-line-throw.mjs for why the
		// generated (>300 KB) child script itself is not committed.
		const { writeLongLineThrowFixture, SENTINEL } = await import("./fixtures/long-line-throw.mjs");
		const fixtureDir = mkdtempSync(join(tmpdir(), "orch-long-line-fixture-"));
		const scriptPath = join(fixtureDir, "long-line-throw.mjs");
		writeLongLineThrowFixture(scriptPath);
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never,
				spawnChild: (_command, _args, options) => nodeSpawn(process.execPath, [scriptPath], options as never),
			});

			expect(result.stderr).toContain(SENTINEL);
			expect(result.stderr).toMatch(/\n\s+at /);
		} finally {
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	test("long minified-bundle-style source line surfaces the sentinel and a stack frame in the persisted <taskId>.stderr.log (with session)", async () => {
		const { writeLongLineThrowFixture, SENTINEL } = await import("./fixtures/long-line-throw.mjs");
		const fixtureDir = mkdtempSync(join(tmpdir(), "orch-long-line-fixture-"));
		const scriptPath = join(fixtureDir, "long-line-throw.mjs");
		writeLongLineThrowFixture(scriptPath);
		const session = createSession("long-line-session");
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never,
				taskId: "long-line",
				session,
				spawnChild: (_command, _args, options) => nodeSpawn(process.execPath, [scriptPath], options as never),
			});

			expect(result.stderr).toContain(SENTINEL);
			expect(result.stderr).toMatch(/\n\s+at /);

			const logged = readFileSync(session.file("long-line.stderr.log"), "utf8");
			expect(logged).toContain(SENTINEL);
			expect(logged).toMatch(/\n\s+at /);
		} finally {
			session.close();
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	test("long minified-bundle-style source line surfaces the sentinel and a stack frame through a real Node parent", async () => {
		// The two tests above spawn the long-line fixture directly from bun (the
		// test runner), which happens to drain a fast-exiting child's stderr
		// pipe in full — they pass on pre-fix code too, so they do not actually
		// exercise the bug this file's fix commits address. HT's real parent
		// process is Node, and Node's async pipe read is what silently drops
		// the tail. This test runs the real `runSubagentProcess` inside a real
		// `node` child. The outer bun<->node spawn/read below only carries a
		// small JSON result file, never the megabyte-scale fixture stderr — the
		// pipe under test is the inner one, between the fixture script and the
		// bundled driver's real-Node parent.
		const nodeBin = Bun.which("node");
		if (!nodeBin) {
			throw new Error(
				"`node` binary not found on PATH — this regression test requires a real Node parent process " +
					"(reproducing bun's own pipe-reading behavior does not exercise HT's actual failure mode).",
			);
		}

		const { writeLongLineThrowFixture, SENTINEL } = await import("./fixtures/long-line-throw.mjs");
		const fixtureDir = mkdtempSync(join(tmpdir(), "orch-long-line-node-fixture-"));
		const scriptPath = join(fixtureDir, "long-line-throw.mjs");
		writeLongLineThrowFixture(scriptPath);

		const buildDir = mkdtempSync(join(tmpdir(), "orch-node-driver-build-"));
		const nodeStateRoot = mkdtempSync(join(tmpdir(), "orch-node-driver-state-"));
		const driverRepoDir = mkdtempSync(join(tmpdir(), "orch-node-driver-repo-"));
		const outFile = join(buildDir, "result.json");
		try {
			// index.ts imports "@humain/terminal" for the persona/UI helpers, which
			// only resolves inside HT's own runtime. index.test.ts's `bun:test`
			// mock.module registers a virtual module for it, but that mock is a
			// bun:test runtime feature and does not apply to a plain `Bun.build`
			// bundle later run under real `node`. Stub it at build time instead —
			// this test's code path (`agentName: "__no_persona__"`) never calls
			// `discoverAgents`/`BorderedLoader`, so the stubs only need to satisfy
			// the module's top-level named imports.
			const build = await Bun.build({
				entrypoints: [join(fixturesDir, "run-subagent-under-node.ts")],
				outdir: buildDir,
				target: "node",
				format: "esm",
				plugins: [
					{
						name: "stub-humain-terminal",
						setup(b) {
							b.onResolve({ filter: /^@humain\/terminal$/ }, () => ({
								path: "@humain/terminal",
								namespace: "stub-humain-terminal",
							}));
							// Same reason as above for `typebox` (see the mock.module stub at the top of this file):
							// it only resolves inside HT, and this path never builds the status tool's schema.
							b.onResolve({ filter: /^typebox$/ }, () => ({ path: "typebox", namespace: "stub-typebox" }));
							b.onLoad({ filter: /.*/, namespace: "stub-typebox" }, () => ({
								contents: `
									const schema = (extra) => (options) => ({ ...extra, ...options });
									export const Type = {
										Object: (properties, options) => ({ type: "object", properties, ...options }),
										Optional: (inner) => ({ ...inner, optional: true }),
										Number: schema({ type: "number" }),
										String: schema({ type: "string" }),
										Boolean: schema({ type: "boolean" }),
									};
								`,
								loader: "js",
							}));
							b.onLoad({ filter: /.*/, namespace: "stub-humain-terminal" }, () => ({
								contents: `
									export const discoverAgents = () => ({ agents: [] });
									export class BorderedLoader { constructor() {} }
									export const renderTaskWithContext = (task) => task;
								`,
								loader: "js",
							}));
						},
					},
				],
			});
			if (!build.success) {
				throw new Error(`Bun.build of the Node driver failed:\n${build.logs.map((l) => String(l.message ?? l)).join("\n")}`);
			}

			const driverPath = join(buildDir, "run-subagent-under-node.js");
			// `Bun.which("node")` above already requires a real `node` binary on PATH
			// (this test's whole point is exercising Node's own async-pipe-read
			// behavior, which bun's runner does not reproduce); a `timeout` here bounds
			// a hung driver (e.g. a regression that leaves the run's diagnostics lease
			// open) instead of hanging the whole test run indefinitely.
			execFileSync(nodeBin, [driverPath, driverRepoDir, scriptPath, "long-line-node", outFile], {
				timeout: 60_000,
				env: {
					...process.env,
					HUMAIN_ORCHESTRATOR_STATE_ROOT: nodeStateRoot,
					HUMAIN_ORCHESTRATOR_SKILL_ROOT: fileURLToPath(new URL("../../../", import.meta.url)),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			const { stderrText, stderrLogPath, stderrLogSize } = JSON.parse(readFileSync(outFile, "utf8")) as {
				stderrText: string;
				stderrLogPath: string;
				stderrLogSize: number;
			};

			expect(stderrText).toContain(SENTINEL);
			expect(stderrText).toMatch(/\n\s+at /);

			expect(stderrLogSize).toBeGreaterThan(0);
			const logged = readFileSync(stderrLogPath, "utf8");
			expect(logged).toContain(SENTINEL);
			expect(logged).toMatch(/\n\s+at /);
		} catch (err) {
			const stderr = (err as { stderr?: Buffer | string }).stderr;
			throw new Error(
				`Node driver failed: ${(err as Error).message}${stderr ? `\n--- driver stderr ---\n${stderr}` : ""}`,
			);
		} finally {
			rmSync(fixtureDir, { recursive: true, force: true });
			rmSync(buildDir, { recursive: true, force: true });
			rmSync(nodeStateRoot, { recursive: true, force: true });
			rmSync(driverRepoDir, { recursive: true, force: true });
		}
	});

	test("does not recover a result that never reaches agent_settled", async () => {
		const result = await orchestrator.runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			spawnChild: spawnInlineScript(
				`const e=[{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"never settled"}]}}];for(const x of e)process.stdout.write(JSON.stringify(x)+"\\n");process.exitCode=1;`,
			),
		});

		expect(result.outcome).toBe("failed");
		expect(result.exitCode).toBe(1);
	});

	test("does not recover a settled result with no final assistant text", async () => {
		// Isolates the final-text guard specifically: the assistant DOES stop
		// cleanly (`stopReason: "stop"`) and the child DOES settle, but its only
		// text block is whitespace-only, so `hasFinalText` must be the reason
		// this stays failed — not a missing stop reason or missing settlement.
		const result = await orchestrator.runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			spawnChild: spawnInlineScript(
				`const e=[{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"   "}]}},{type:"agent_end",messages:[]},{type:"agent_settled"}];for(const x of e)process.stdout.write(JSON.stringify(x)+"\\n");process.exitCode=1;`,
			),
		});

		expect(result.outcome).toBe("failed");
		expect(result.finalText).toBe("");
		expect(result.exitCode).toBe(1);
	});

	test("does not recover an error stop reason even after agent_settled", async () => {
		const result = await orchestrator.runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			spawnChild: spawnInlineScript(
				`const e=[{type:"message_end",message:{role:"assistant",stopReason:"error",content:[{type:"text",text:"went wrong"}]}},{type:"agent_end",messages:[]},{type:"agent_settled"}];for(const x of e)process.stdout.write(JSON.stringify(x)+"\\n");process.exitCode=1;`,
			),
		});

		expect(result.outcome).toBe("failed");
		expect(result.exitCode).toBe(1);
	});

	test("treats a synchronous spawnChild throw as a failed dispatch, not a recoverable result", async () => {
		// `spawn()` itself can throw synchronously on argument-validation errors
		// (as opposed to ENOENT, which arrives asynchronously via the child's
		// 'error' event — see the next test). This exercises that separate,
		// synchronous-throw code path in runSubagentProcess's own try/catch
		// around the spawnChild(...) call.
		const result = await orchestrator.runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			spawnChild: () => {
				throw new Error("spawn ENOENT");
			},
		});

		expect(result.outcome).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("spawn ENOENT");
	});

	test("treats an asynchronous spawn error (ENOENT) as a failed dispatch, not a recoverable result", async () => {
		// Exercises the real `proc.on("error", ...)` handler: spawnChild returns a
		// real child process (no synchronous throw) for a deliberately nonexistent
		// executable, so Node's child_process module emits an async 'error' event
		// carrying the real ENOENT diagnostic.
		const nonexistentExecutable = join(repoDir, "definitely-does-not-exist-orch-fixture-binary");
		const result = await orchestrator.runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			spawnChild: (_command, _args, options) => nodeSpawn(nonexistentExecutable, [], options),
		});

		expect(result.outcome).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("ENOENT");
	});

	test("BLOCKING 1: a provider-error note is written exactly once when the child emits no stderr", async () => {
		// Regression for the double-write: finish() sees an empty backing file and
		// writes the provider-error note into it; the 'close' handler used to
		// re-stat the file, see the bytes finish() had just written, mistake them
		// for real child bytes, and append the same note a second time.
		const session = createSession("provider-error-once");
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "openai-codex/gpt-6-astra",
				ctx: {} as never, capability: "security_review", taskId: "provider-error-once", session,
				spawnChild: () => child as never,
			});
			emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "You have hit your usage limit.", usage: { input: 0, output: 0, cost: { total: 0 } } } });
			emit({ type: "agent_end", messages: [] });
			emit({ type: "agent_settled" });
			child.emit("close", 0);
			const result = await pending;
			expect(result.outcome).toBe("failed");
			const log = readFileSync(session.file("provider-error-once.stderr.log"), "utf8");
			expect((log.match(/usage limit/g) ?? []).length).toBe(1);
			expect((result.stderr.match(/usage limit/g) ?? []).length).toBe(1);
		} finally {
			session.close();
		}
	});

	test("BLOCKING 1: a timeout note is written exactly once when the child is silent on stderr", async () => {
		const session = createSession("timeout-once");
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "timeout-once", session,
				leadTimeouts: { inactivityMs: 50, maxMs: 5000 },
				spawnChild: () => child as never,
			});
			expect(result.outcome).toBe("timed_out");
			// The real process 'close' event arrives after finish() already settled
			// (as it does in production: kill() races the OS reporting exit).
			child.emit("close", 124);
			await Promise.resolve();
			const log = readFileSync(session.file("timeout-once.stderr.log"), "utf8");
			expect((log.match(/UNVERIFIED PARTIAL WORK/g) ?? []).length).toBe(1);
		} finally {
			child.emit("close", 137);
			session.close();
		}
	});

	test("the recovered-result warning prefix stays a prefix, in both the returned stderr and stderr.log", async () => {
		const session = createSession("recovered-prefix");
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "recovered-prefix", session,
				spawnChild: () => child as never,
			});
			emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fixture task completed" }] } });
			emit({ type: "agent_end", messages: [] });
			emit({ type: "agent_settled" });
			// The child completed the JSON protocol cleanly, then the process itself
			// exits non-zero — the "recovered" path. No real bytes ever land on the
			// backing fd here (this is a test double), so this exercises finish()'s
			// own file write (the `fileBytes === 0` branch), matching the scenario
			// the review comment names.
			child.emit("close", 1);
			const result = await pending;

			expect(result.outcome).toBe("completed_after_process_error");
			const prefix = "[orchestrator] child produced a terminal result";
			expect(result.stderr.startsWith(prefix)).toBe(true);
			const log = readFileSync(session.file("recovered-prefix.stderr.log"), "utf8");
			expect(log.startsWith(prefix)).toBe(true);
		} finally {
			session.close();
		}
	});

	test("a colliding taskId falls back to a temp file, logs the fallback, and preserves the child's stderr under a non-clobbering name", async () => {
		const session = createSession("fallback-collision");
		const child1 = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		try {
			const first = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "dup-task", session,
				spawnChild: () => child1 as never,
			});
			child1.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "first" } })}\n`);
			child1.emit("close", 0);
			await first;

			// A second dispatch under the SAME session reuses the same taskId (an
			// unexpected but not fatal collision: openChildStderrFile refuses to
			// reopen an existing name). It gets a REAL child (spawnInlineScript),
			// not a test double, so real bytes land on the fallback temp file's fd
			// -- proving the content is actually preserved, not merely absent.
			const result2 = await orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "dup-task", session,
				spawnChild: spawnInlineScript(
					`process.stderr.write("second dispatch stderr\\n");` +
						`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:"second"}})+"\\n");`,
				),
			});
			expect(result2.stderr).toContain("second dispatch stderr");

			// The first dispatch's own log is untouched by the collision.
			const firstLog = readFileSync(session.file("dup-task.stderr.log"), "utf8");
			expect(firstLog).not.toContain("second dispatch stderr");
			// The fallback is logged, not silent.
			expect(readFileSync(session.file("run.log"), "utf8")).toContain("fell back to a private temp file");
			// The second dispatch's real stderr is preserved in the run's own
			// diagnostics under a name that cannot collide with dup-task.stderr.log.
			expect(readFileSync(session.file("dup-task.stderr.log.fallback"), "utf8")).toContain("second dispatch stderr");

			// The collision must not have invalidated the first dispatch's own
			// release()-time snapshot: sealing the run must still succeed.
			session.close();
			expect(await session.sealDiagnostics(Promise.resolve(true))).toBe(true);
		} finally {
			session.close();
		}
	});

	test("REVIEW ROUND 2 / BLOCKING 1: a taskId collision where the second child is silent leaves the first dispatch's log byte-for-byte untouched, and the run seals", async () => {
		const session = createSession("collision-silent");
		const child1 = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		try {
			const first = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "collide-silent", session,
				spawnChild: () => child1 as never,
			});
			child1.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "first" } })}\n`);
			child1.stderr.write("first dispatch stderr\n");
			child1.emit("close", 0);
			await first;
			const firstLogBefore = readFileSync(session.file("collide-silent.stderr.log"), "utf8");
			expect(firstLogBefore).toContain("first dispatch stderr");

			// Second dispatch reuses the same taskId and is completely silent on
			// stderr (a test double: nothing ever writes to the real backing fd).
			const child2 = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
			const second = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "collide-silent", session,
				spawnChild: () => child2 as never,
			});
			child2.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "second" } })}\n`);
			child2.emit("close", 0);
			await second;

			// The first dispatch's log must not have been truncated to "" (or
			// otherwise altered) by the second dispatch's collision handling.
			const firstLogAfter = readFileSync(session.file("collide-silent.stderr.log"), "utf8");
			expect(firstLogAfter).toBe(firstLogBefore);
			expect(firstLogAfter.length).toBeGreaterThan(0);

			session.close();
			expect(await session.sealDiagnostics(Promise.resolve(true))).toBe(true);
		} finally {
			session.close();
		}
	});

	test("REVIEW ROUND 2 / BLOCKING 1: a taskId collision where the second child times out appends its notes to the fallback file, not the first dispatch's log, and the run seals", async () => {
		const session = createSession("collision-timeout");
		const child1 = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		try {
			const first = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "collide-timeout", session,
				spawnChild: () => child1 as never,
			});
			child1.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "first" } })}\n`);
			child1.emit("close", 0);
			await first;
			const firstLogBefore = readFileSync(session.file("collide-timeout.stderr.log"), "utf8");

			// Second dispatch reuses the same taskId and times out (inactivity):
			// its interruption note must land on the fallback file, not clobber or
			// append into the first dispatch's already-sealed-worthy log.
			const child2 = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
			const second = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "collide-timeout", session,
				leadTimeouts: { inactivityMs: 50, maxMs: 5000 },
				spawnChild: () => child2 as never,
			});
			const result2 = await second;
			expect(result2.outcome).toBe("timed_out");
			child2.emit("close", 137);
			await Promise.resolve();

			const firstLogAfter = readFileSync(session.file("collide-timeout.stderr.log"), "utf8");
			expect(firstLogAfter).toBe(firstLogBefore);
			expect(readFileSync(session.file("run.log"), "utf8")).toContain("fell back to a private temp file");
			const fallback = readFileSync(session.file("collide-timeout.stderr.log.fallback"), "utf8");
			expect(fallback).toContain("UNVERIFIED PARTIAL WORK");

			session.close();
			expect(await session.sealDiagnostics(Promise.resolve(true))).toBe(true);
		} finally {
			session.close();
		}
	});

	test("REVIEW ROUND 2 / BLOCKING 2: a recovered result's persisted stderr.log leads with the warning prefix, then the child's real bytes, not the reverse", async () => {
		const session = createSession("recovered-real-bytes");
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "recovered-real-bytes", session,
				// A real Node child (not a test double): stderr bytes land on the
				// backing fd for real, exercising the `fileBytes > 0` branch of the
				// close handler, not finish()'s own no-real-bytes-yet write.
				spawnChild: spawnInlineScript(
					`const e=[{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"done"}]}},{type:"agent_end",messages:[]},{type:"agent_settled"}];` +
						`for(const x of e)process.stdout.write(JSON.stringify(x)+"\\n");` +
						`process.stderr.write("teardown boom\\n");process.exitCode=1;`,
				),
			});

			expect(result.outcome).toBe("completed_after_process_error");
			const prefix = "[orchestrator] child produced a terminal result";
			expect(result.stderr.startsWith(prefix)).toBe(true);
			const log = readFileSync(session.file("recovered-real-bytes.stderr.log"), "utf8");
			expect(log.startsWith(prefix)).toBe(true);
			expect(log).toContain("teardown boom");
			expect(log.indexOf(prefix)).toBeLessThan(log.indexOf("teardown boom"));
		} finally {
			session.close();
		}
	});

	test("REVIEW ROUND 2 / WARNING: real bytes written to the backing fd between settle (0 bytes) and close are appended, not truncated away", async () => {
		const session = createSession("late-bytes-warning");
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "late-bytes-warning", session,
				leadTimeouts: { inactivityMs: 50, maxMs: 5000 },
				spawnChild: () => child as never,
			});
			// Let the inactivity timeout settle the dispatch with 0 bytes observed
			// on the backing file (the test double never writes to the real fd).
			await new Promise((resolve) => setTimeout(resolve, 150));
			// Real bytes now land on the backing file through an independent fd
			// (O_APPEND-opened, like a genuine child's own duplicate would be),
			// simulating a child that keeps writing briefly during its own
			// teardown after the orchestrator has already settled and written
			// its timeout note.
			const fd = openSync(session.file("late-bytes-warning.stderr.log"), "a");
			try { writeSync(fd, "late child bytes after settle\n"); } finally { closeSync(fd); }
			child.emit("close", 137);
			const result = await pending;

			expect(result.outcome).toBe("timed_out");
			const log = readFileSync(session.file("late-bytes-warning.stderr.log"), "utf8");
			expect(log).toContain("UNVERIFIED PARTIAL WORK");
			expect(log).toContain("late child bytes after settle");
			// The orchestrator's own note must remain a prefix; the late bytes are
			// appended after it, never overwriting it.
			expect(log.indexOf("UNVERIFIED PARTIAL WORK")).toBeLessThan(log.indexOf("late child bytes after settle"));
			// The late bytes already landed in place on the backing file through the
			// same O_APPEND fd as everything else in this (non-fallback) log; the
			// close handler must never re-read and re-append them, or they show up
			// twice in the sealed log (BLOCKING, review round 3).
			const occurrences = log.split("late child bytes after settle").length - 1;
			expect(occurrences).toBe(1);
		} finally {
			session.close();
		}
	});

	test("REVIEW ROUND 3 / BLOCKING: late bytes that push the backing file past the disk cap are capped in place, never unboundedly duplicated", async () => {
		const session = createSession("late-bytes-over-cap");
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		try {
			const pending = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "late-bytes-over-cap", session,
				leadTimeouts: { inactivityMs: 50, maxMs: 5000 },
				spawnChild: () => child as never,
			});
			// Settle at 0 bytes observed on the backing file, exactly like the WARNING
			// test above, but this time the "late bytes" that land afterward through
			// the independent O_APPEND fd exceed MAX_CHILD_STDERR_DISK_BYTES on their
			// own. The close handler must cap the file (bounded head/tail reads via
			// capChildStderrFile), never allocate a same-sized in-memory buffer for
			// the whole delta and never duplicate any of it.
			await new Promise((resolve) => setTimeout(resolve, 150));
			const tailMarker = "HAO_LATE_BYTES_TAIL_SENTINEL_9c1a";
			const oversized = "L".repeat(MAX_CHILD_STDERR_DISK_BYTES + 1024) + tailMarker;
			const fd = openSync(session.file("late-bytes-over-cap.stderr.log"), "a");
			try { writeSync(fd, oversized); } finally { closeSync(fd); }
			child.emit("close", 137);
			const result = await pending;

			expect(result.outcome).toBe("timed_out");
			const log = readFileSync(session.file("late-bytes-over-cap.stderr.log"), "utf8");
			expect(log).toContain("UNVERIFIED PARTIAL WORK");
			// Capped, not duplicated: the sentinel that marks the true end of the
			// late bytes appears exactly once, and the whole file stays within the
			// disk cap (plus the small, fixed marker/note overhead).
			const occurrences = log.split(tailMarker).length - 1;
			expect(occurrences).toBe(1);
			expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(MAX_CHILD_STDERR_DISK_BYTES + 4096);
			expect(log).toMatch(/bytes elided \(on-disk stderr exceeded the \d+-byte cap\)/);
		} finally {
			session.close();
		}
	});

	test("REVIEW ROUND 3 / WARNING: a recovered result's persisted log reserves room for the prefix when capping oversized real content", async () => {
		const session = createSession("cap-with-prefix");
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "cap-with-prefix", session,
				// A real Node child (not a test double) whose stderr fd is oversized
				// (well past MAX_CHILD_STDERR_DISK_BYTES) before it settles and then
				// exits non-zero after a terminal result, exercising the
				// completed_after_process_error prefix together with the cap.
				spawnChild: spawnInlineScript(
					`process.stderr.write("B".repeat(${MAX_CHILD_STDERR_DISK_BYTES} + 65536) + "HAO_CAP_PREFIX_TAIL_SENTINEL\\n");` +
						`const e=[{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"done"}]}},{type:"agent_end",messages:[]},{type:"agent_settled"}];` +
						`for(const x of e)process.stdout.write(JSON.stringify(x)+"\\n");` +
						`process.exitCode=1;`,
				),
			});

			expect(result.outcome).toBe("completed_after_process_error");
			const prefix = "[orchestrator] child produced a terminal result";
			expect(result.stderr.startsWith(prefix)).toBe(true);
			const log = readFileSync(session.file("cap-with-prefix.stderr.log"), "utf8");
			expect(log.startsWith(prefix)).toBe(true);
			expect(log).toContain("HAO_CAP_PREFIX_TAIL_SENTINEL");
			expect(log.split("HAO_CAP_PREFIX_TAIL_SENTINEL").length - 1).toBe(1);
			// The prefix itself must be reserved room for, not squeezed out by the
			// content cap: the whole persisted file (prefix + capped content) stays
			// within MAX_CHILD_STDERR_DISK_BYTES.
			expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(MAX_CHILD_STDERR_DISK_BYTES);
		} finally {
			session.close();
		}
	});

	test("REVIEW ROUND 3 / WARNING: a fallback target's persisted log reserves room for both the content cap and the interruption notes", async () => {
		const session = createSession("cap-with-notes-fallback");
		const child1 = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		try {
			// First dispatch reserves the real backing file for this taskId.
			const first = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, taskId: "cap-with-notes-fallback", session,
				spawnChild: () => child1 as never,
			});
			child1.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "first" } })}\n`);
			child1.emit("close", 0);
			await first;

			// Second dispatch reuses the same taskId (forcing the collision fallback
			// to a private temp file) with a real child that writes oversized real
			// content, then times out via inactivity (producing an interruption
			// note). Both the cap and the note must be reserved for in the same
			// persisted-file budget.
			const tailMarker = "HAO_CAP_NOTES_TAIL_SENTINEL";
			const second = orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "cap-with-notes-fallback", session,
				leadTimeouts: { inactivityMs: 100, maxMs: 5000 },
				spawnChild: spawnInlineScript(
					`process.stderr.write("C".repeat(${MAX_CHILD_STDERR_DISK_BYTES} + 65536) + "${tailMarker}\\n");` +
						"setInterval(() => {}, 1000);",
				),
			});
			const result = await second;
			// finish() resolves the promise from the timeout handler, which races the
			// real process's actual SIGKILL + 'close' event; the close handler's own
			// diagnosticWriter work (including this test's fallback file) runs after
			// that event fires, not before the promise settles. Give the real OS
			// process time to actually exit and 'close' to fire.
			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(result.outcome).toBe("timed_out");
			expect(readFileSync(session.file("run.log"), "utf8")).toContain("fell back to a private temp file");
			const fallback = readFileSync(session.file("cap-with-notes-fallback.stderr.log.fallback"), "utf8");
			expect(fallback).toContain("UNVERIFIED PARTIAL WORK");
			expect(fallback).toContain(tailMarker);
			expect(fallback.split(tailMarker).length - 1).toBe(1);
			expect(Buffer.byteLength(fallback, "utf8")).toBeLessThanOrEqual(MAX_CHILD_STDERR_DISK_BYTES);
		} finally {
			session.close();
		}
	});

	test("BLOCKING 2: a detached grandchild that escapes the process group and writes after settle does not overwrite earlier content, and seal detects the growth", async () => {
		const session = createSession("escaped-grandchild");
		const fixtureDir = mkdtempSync(join(tmpdir(), "orch-escaped-grandchild-"));
		const scriptPath = join(fixtureDir, "escaped-grandchild.mjs");
		// The immediate child never settles (so the lead's own absolute timeout
		// kills it) and spawns its own detached (own-process-group) grandchild that
		// inherits fd 2 and writes to it only after a delay — by which time the
		// orchestrator has already settled, written its timeout note into the
		// file, capped/appended, and released the lease. `detached: true` here is
		// exactly the escape: `killProcessTree`'s `process.kill(-pid, "SIGKILL")`
		// only reaches the immediate child's own process group.
		writeFileSync(scriptPath, [
			"import { spawn } from \"node:child_process\";",
			"const grandchild = spawn(process.execPath, [\"-e\",",
			"  \"setTimeout(()=>{try{require('fs').writeSync(2,'grandchild wrote after settle\\\\n');}catch{}process.exit(0);},500);\"",
			"], { stdio: [\"ignore\", \"ignore\", 2], detached: true });",
			"grandchild.unref();",
			"setInterval(() => {}, 1000);",
		].join("\n"), "utf8");
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "escaped-grandchild", session,
				leadTimeouts: { inactivityMs: 100, maxMs: 5000 },
				spawnChild: (_command, _args, options) => nodeSpawn(process.execPath, [scriptPath], options as never),
			});
			expect(result.outcome).toBe("timed_out");
			const beforeGrandchild = readFileSync(session.file("escaped-grandchild.stderr.log"), "utf8");
			expect(beforeGrandchild).toContain("UNVERIFIED PARTIAL WORK");
			// Give the detached grandchild time to write after settle/close/release.
			await new Promise((resolve) => setTimeout(resolve, 900));
			const afterGrandchild = readFileSync(session.file("escaped-grandchild.stderr.log"), "utf8");
			// Earlier content must not have been overwritten at offset 0.
			expect(afterGrandchild.startsWith(beforeGrandchild)).toBe(true);
			expect(afterGrandchild).toContain("grandchild wrote after settle");
			session.close();
			// The file changed after the orchestrator's own final write; seal must veto.
			expect(await session.sealDiagnostics(Promise.resolve(true))).toBe(false);
		} finally {
			session.close();
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	// Phase 2 telemetry (observational only): the dispatch's own tool mix, peak
	// context tokens, and observable polls, counted from the real child event
	// stream `runSubagentProcess` already parses.
	test("telemetry counts own tool mix, delegated subagent calls, and observable polls", async () => {
		const session = createSession("telemetry-tool-mix");
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "telemetry-mix", session,
				spawnChild: spawnInlineScript([
					'const events=[',
					'{type:"tool_execution_start",toolName:"bash",args:{command:"sleep 5"}},',
					'{type:"tool_execution_start",toolName:"orchestrator_status",args:{}},',
					'{type:"tool_execution_start",toolName:"bash",args:{command:"ls"}},',
					'{type:"tool_execution_start",toolName:"subagent",args:{tasks:[1,2]}},',
					'{type:"tool_execution_start",toolName:"read",args:{path:"a.ts"}},',
					'{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"done"}],usage:{input:1,output:1,cost:{total:0},totalTokens:4200}}},',
					'{type:"agent_end"},{type:"agent_settled"}];',
					'for(const e of events) process.stdout.write(JSON.stringify(e)+"\\n");',
				].join("")),
			});
			expect(result.telemetry?.turns).toBe(1);
			expect(result.telemetry?.peak_context_tokens).toBe(4200);
			expect(result.telemetry?.context_token_semantics).toBe("provider_total_tokens_per_message");
			expect(result.telemetry?.own_tool_calls).toBe(5);
			expect(result.telemetry?.own_tool_mix).toEqual({ bash: 2, orchestrator_status: 1, subagent: 1, read: 1 });
			expect(result.telemetry?.delegated_subagent_calls).toBe(1);
			expect(result.telemetry?.observable_poll_calls).toBe(2);
		} finally {
			session.close();
		}
	});

	test("telemetry's peak_context_tokens is null (never 0) when no usage was ever reported", async () => {
		const session = createSession("telemetry-no-usage");
		try {
			const result = await orchestrator.runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, capability: "lead", taskId: "telemetry-no-usage", session,
				spawnChild: spawnInlineScript([
					'const events=[',
					'{type:"tool_execution_start",toolName:"read",args:{path:"a.ts"}},',
					'{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"done"}]}},',
					'{type:"agent_end"},{type:"agent_settled"}];',
					'for(const e of events) process.stdout.write(JSON.stringify(e)+"\\n");',
				].join("")),
			});
			expect(result.telemetry?.peak_context_tokens).toBeNull();
		} finally {
			session.close();
		}
	});
});

describe("verification outcome records", () => {
	test("QA gate outcomes are marked run-scoped, not task attestations", () => {
		expect(orchestrator.qaVerificationOutcomeFor).toBeFunction();
		expect(orchestrator.qaVerificationOutcomeFor!("run-1", true, 0.95, "ok")).toMatchObject({
			run_id: "run-1",
			task_id: "run-1-qa",
			outcome: "verified",
			verification_scope: "run",
		});
	});

	test("qaVerificationOutcomeFor records factual evidence additively, without a manufactured score", () => {
		const outcome = orchestrator.qaVerificationOutcomeFor("run-9", true, 0.95, "ok", {
			checks: [{ id: "typecheck", result: "pass" }, { id: "environment", result: "unavailable" }],
			tested_revision: "abc123",
			tested_revision_dirty: false,
			review_verdicts: [{ role: "qa_agent", verdict: "pass" }],
			artifacts: [],
		});
		expect(outcome).toMatchObject({
			checks: [{ id: "typecheck", result: "pass" }, { id: "environment", result: "unavailable" }],
			checks_unavailable: ["environment"],
			check_commands: null,
			tested_revision: "abc123",
			tested_revision_dirty: false,
			review_verdicts: [{ role: "qa_agent", verdict: "pass" }],
			artifacts: [],
			outcome_finality: "immediate",
			evidence_status: "verified",
		});
		expect(outcome).not.toHaveProperty("quality_evidence_score");
	});

	test("Phase 1 review T8: an exit-0 gate whose checks are all skipped/unavailable still passes, but its evidence is marked unverified", () => {
		// Gate control flow is deliberately UNCHANGED: `passed=true` (the caller's own
		// `qaResult.exitCode === 0 && failedChecks.length === 0` computation) still produces
		// `outcome: "verified"` here — only `evidence_status` differs from a real pass.
		const allSkipped = orchestrator.qaVerificationOutcomeFor("run-11", true, 0.95, "ok", {
			checks: [{ id: "typecheck", result: "skipped" }, { id: "lint", result: "unavailable" }],
		});
		expect(allSkipped).toMatchObject({ outcome: "verified", evidence_status: "unverified_checks_unavailable" });

		// No checks parsed at all is the same gap: nothing proves the exit code reflects real checks.
		const noChecks = orchestrator.qaVerificationOutcomeFor("run-12", true, 0.95, "ok");
		expect(noChecks).toMatchObject({ outcome: "verified", evidence_status: "unverified_checks_unavailable" });

		// One real pass/fail among a mix of skipped/unavailable checks IS factual evidence.
		const mixed = orchestrator.qaVerificationOutcomeFor("run-13", true, 0.95, "ok", {
			checks: [{ id: "typecheck", result: "pass" }, { id: "lint", result: "skipped" }],
		});
		expect(mixed).toMatchObject({ outcome: "verified", evidence_status: "verified" });
	});

	test("evidenceStatusFor: verified only when at least one check actually ran to pass/fail", () => {
		expect(orchestrator.evidenceStatusFor([])).toBe("unverified_checks_unavailable");
		expect(orchestrator.evidenceStatusFor([{ id: "a", result: "skipped" }])).toBe("unverified_checks_unavailable");
		expect(orchestrator.evidenceStatusFor([{ id: "a", result: "unavailable" }, { id: "b", result: "skipped" }]))
			.toBe("unverified_checks_unavailable");
		expect(orchestrator.evidenceStatusFor([{ id: "a", result: "fail" }])).toBe("verified");
		expect(orchestrator.evidenceStatusFor([{ id: "a", result: "pass" }])).toBe("verified");
	});

	test("qaVerificationOutcomeFor defaults evidence fields to explicit absence, never a guess", () => {
		const outcome = orchestrator.qaVerificationOutcomeFor("run-10", false, 0.0, "fail");
		expect(outcome).toMatchObject({
			checks: [],
			checks_unavailable: [],
			check_commands: null,
			tested_revision: null,
			tested_revision_dirty: null,
			review_verdicts: [],
			artifacts: [],
			outcome_finality: "immediate",
		});
		expect(typeof outcome.check_commands_unavailable_reason).toBe("string");
	});

	test("failed verification does not write a run-complete verified outcome", () => {
		expect(orchestrator.runCompletionOutcomeFor).toBeFunction();
		expect(orchestrator.runCompletionOutcomeFor!("run-1", {
			success_rate: 0,
			verification_passed: false,
		})).toMatchObject({
			run_id: "run-1",
			task_id: "run-complete",
			outcome: "fail",
			verification_scope: "run",
		});
	});

	test("passed verification writes a run-complete verified outcome", () => {
		expect(orchestrator.runCompletionOutcomeFor).toBeFunction();
		expect(orchestrator.runCompletionOutcomeFor!("run-2", {
			success_rate: 1,
			verification_passed: true,
		})).toMatchObject({
			run_id: "run-2",
			task_id: "run-complete",
			outcome: "verified",
			verification_scope: "run",
		});
	});
});

describe("dispatch records (T6)", () => {
	/**
	 * These replace six tests that asserted only the exit-code-to-event mapping of the
	 * deleted `verificationRecordFor` (`exitCode 0` -> `task_verified`). That mapping was
	 * itself the defect, so tests pinning it could only ever pass: they asserted the
	 * conflation instead of the property that matters, which is WHICH RECORDS a dispatch is
	 * allowed to write. Every assertion below is over the full record set from
	 * `dispatchRecordsFor`, so a future re-introduction of an attested verdict fails here no
	 * matter what it is named.
	 */
	const ATTESTED_EVENTS = ["task_verified", "task_failed", "verification_result"];

	function captureOpts(overrides: Record<string, unknown> = {}) {
		return {
			runId: "run-1",
			planId: "plan-1",
			taskClass: "crud",
			complexity: 4,
			risk: "low",
			recommended: { capability: "implementation_fast", effort: "low", verification_depth: "targeted" },
			mode: "adaptive",
			...overrides,
		} as Parameters<typeof orchestrator.dispatchRecordsFor>[0];
	}

	function dispatchResult(overrides: Record<string, unknown> = {}) {
		return {
			taskId: "run-1-worker-a",
			capability: "implementation_fast",
			model: "provider/model",
			exitCode: 0,
			stdout: "",
			stderr: "",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			durationMs: 10,
			costUsd: 0.01,
			costReported: true,
			filesChanged: [],
			...overrides,
		} as Parameters<typeof orchestrator.dispatchRecordsFor>[1];
	}

	const recordsFor = (result: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
		orchestrator.dispatchRecordsFor!(captureOpts(opts), dispatchResult(result));

	test("a QA dispatch that exits 0 while reporting failed checks attests nothing", () => {
		// The reproducer: `runVerification` bills the QA dispatch BEFORE computing
		// `exitCode === 0 && failedChecks.length === 0`, then writes `outcome: 'fail'` for the
		// same task_id. An attested `task_verified` here made the contradictory pair resolve to
		// verified — the one number this branch exists to stop overstating.
		expect(orchestrator.dispatchRecordsFor).toBeFunction();
		const records = recordsFor({
			taskId: "run-1-qa",
			capability: "qa_agent",
			exitCode: 0,
			stdout: "| typecheck | FAIL |\n| tests | FAIL |",
		});

		expect(records.map((r) => r.event)).toEqual(["model_call", "route_executed"]);
		for (const record of records) {
			expect(ATTESTED_EVENTS).not.toContain(record.event as string);
			expect(record.result).not.toBe("verified");
		}
	});

	test.each([
		["architect", "run-1-architect", "architect"],
		["lead", "run-1-lead-0", "lead"],
		["triage", "triage-repair-the-login-race", "implementation_fast"],
		["escalation retry", "run-1-lead-0-retry-1", "lead"],
	])("a %s dispatch never attests a task verdict", (_label, taskId, capability) => {
		// These task ids are coordination bookkeeping, not deliverable tasks, so an attested
		// verdict about them is meaningless regardless of how the subprocess exited.
		for (const exitCode of [0, 1]) {
			const records = recordsFor({ taskId, capability, exitCode });
			expect(records.map((r) => r.event)).toEqual(["model_call", "route_executed"]);
			expect(records.some((r) => ATTESTED_EVENTS.includes(r.event as string))).toBe(false);
		}
	});

	test("no dispatch outcome, at any exit code, produces an attested record", () => {
		for (const exitCode of [0, 1, 137, -1]) {
			const events = recordsFor({ exitCode }).map((r) => r.event);
			expect(events).toEqual(["model_call", "route_executed"]);
		}
	});

	test("the dispatch-level verdict is still reported, as dispatch-strength evidence", () => {
		// records.py reads `result` as DISPATCH strength and `executed_passes` as the executed
		// route's outcome. Dropping the attested row must not drop the honest signal.
		const [call, route] = recordsFor({ exitCode: 0 });
		expect(call.result).toBe("pass");
		expect(route.executed_passes).toBe(true);

		const [failedCall, failedRoute] = recordsFor({ exitCode: 1 });
		expect(failedCall.result).toBe("fail");
		expect(failedRoute.executed_passes).toBe(false);
	});

	test("both records carry the routing context, so neither is orphaned from its route group", () => {
		for (const record of recordsFor({}, { taskClass: "refactor", complexity: 7, risk: "high" })) {
			expect(record.run_id).toBe("run-1");
			expect(record.task_id).toBe("run-1-worker-a");
			expect(record.plan_id).toBe("plan-1");
			expect(record.task_class).toBe("refactor");
			expect(record.complexity).toBe(7);
			expect(record.risk).toBe("high");
			expect(record.capability_class).toBe("implementation_fast");
		}
	});

	test("the two records agree on task_id, including the unknown-run fallback", () => {
		// One dispatch must not be able to write two rows under different ids, or a task-level
		// join sees two half-instrumented tasks.
		const records = recordsFor({ taskId: undefined });
		expect(new Set(records.map((r) => r.task_id))).toEqual(new Set(["unknown-run-1"]));
	});

	test("cost is reported exactly once, on the model_call row", () => {
		const [call, route] = recordsFor({ costUsd: 5.5 });
		expect(call.cost_usd).toBe(5.5);
		expect(route).not.toHaveProperty("cost_usd");
		expect(route.executed_cost_usd).toBe(5.5);
	});

	test("never fabricates quality_evidence_score or review_wait_ms", () => {
		// records.py registers the first as emitted only by Engine.verify_task and the second as
		// having no producer at all; a zero here would invent a measurement.
		for (const record of recordsFor({})) {
			expect(record).not.toHaveProperty("quality_evidence_score");
			expect(record).not.toHaveProperty("review_wait_ms");
		}
	});

	test("the attested-verdict emission is gone from the module, not merely unused", () => {
		// Guards the deletion itself: a re-added builder would otherwise be reachable from
		// captureDispatchCost without any test noticing.
		expect(orchestrator).not.toHaveProperty("verificationRecordFor");
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		for (const event of ["task_verified", "task_failed"]) {
			expect(source).not.toContain(`event: passed ? "${event}"`);
			expect(source).not.toContain(`event: "${event}"`);
		}
	});

	// Phase 2, item 1/2: telemetry + canary fields are ADDED to the model_call row;
	// every field this suite already asserted above must stay byte-identical.
	test("telemetry/canary/experiment_flags are additive: the pre-existing model_call fields are unchanged", () => {
		const withoutExtras = recordsFor({})[0];
		const withExtras = recordsFor({
			telemetry: { turns: 3, peak_context_tokens: 12000, context_token_semantics: "provider_total_tokens_per_message", own_tool_calls: 4, own_tool_mix: { bash: 4 }, delegated_subagent_calls: 0, observable_poll_calls: 0 },
			canary: { canary_cohort: "baseline", canary_candidate_id: null, canary_activation: "disabled", canary_reason: "canary_disabled", canary_policy_version: "unversioned", baseline_model: "provider/model", candidate_model: null, requested_model: "provider/model", executed_model: "provider/model", canary_attempt_id: "run-1-worker-a", canary_deviation: null },
			experimentFlags: [],
		})[0];
		const preExistingKeys = Object.keys(withoutExtras);
		for (const key of preExistingKeys) expect(withExtras[key]).toEqual(withoutExtras[key]);
	});

	test("model_call carries the dispatch's telemetry fields when present", () => {
		const [call] = recordsFor({
			telemetry: {
				turns: 5,
				peak_context_tokens: 48000,
				context_token_semantics: "provider_total_tokens_per_message",
				own_tool_calls: 7,
				own_tool_mix: { bash: 3, read: 4 },
				delegated_subagent_calls: 2,
				observable_poll_calls: 1,
				dispatch_phase: "implementation",
			},
		});
		expect(call.turns).toBe(5);
		expect(call.peak_context_tokens).toBe(48000);
		expect(call.context_token_semantics).toBe("provider_total_tokens_per_message");
		expect(call.own_tool_calls).toBe(7);
		expect(call.own_tool_mix).toEqual({ bash: 3, read: 4 });
		expect(call.delegated_subagent_calls).toBe(2);
		expect(call.observable_poll_calls).toBe(1);
		expect(call.dispatch_phase).toBe("implementation");
	});

	test("model_call carries peak_context_tokens as null (never 0) when no usage was observed", () => {
		const [call] = recordsFor({
			telemetry: { turns: 0, peak_context_tokens: null, context_token_semantics: "provider_total_tokens_per_message", own_tool_calls: 0, own_tool_mix: {}, delegated_subagent_calls: 0, observable_poll_calls: 0 },
		});
		expect(call.peak_context_tokens).toBeNull();
	});

	test("model_call carries the canary assignment and experiment_flags when present", () => {
		const [call] = recordsFor({
			canary: {
				canary_cohort: "baseline", canary_candidate_id: "impl-gpt-6-sol", canary_activation: "disabled",
				canary_reason: "canary_disabled", canary_policy_version: "2026-09-25.1", baseline_model: "provider/model",
				candidate_model: "other/candidate", requested_model: "provider/model", executed_model: "provider/model",
				canary_attempt_id: "run-1-worker-a", canary_deviation: null,
			},
			experimentFlags: ["scoped_leads"],
		});
		expect(call.canary_cohort).toBe("baseline");
		expect(call.requested_model).toBe("provider/model");
		expect(call.executed_model).toBe("provider/model");
		expect(call.canary_deviation).toBeNull();
		expect(call.experiment_flags).toEqual(["scoped_leads"]);
	});
});

describe("factual verification evidence helpers", () => {
	test("parseCheckResults reports pass/fail/skip/unavailable per check, not just failures", () => {
		const out = [
			"| Check | Result |",
			"| --- | --- |",
			"| typecheck | PASS |",
			"| unit-tests | FAIL |",
			"| lint | SKIPPED |",
		].join("\n");
		expect(orchestrator.parseCheckResults(out)).toEqual([
			{ id: "typecheck", result: "pass" },
			{ id: "unit-tests", result: "fail" },
			{ id: "lint", result: "skipped" },
		]);
	});

	test("parseCheckResults normalizes a failed `environment` check to unavailable", () => {
		// QA_SCOPE_RULES tells the QA agent to report a broken environment as FAIL under the
		// check name `environment` — that means the check never ran, not that code failed it.
		const out = "| environment | FAIL: python3 not found |";
		expect(orchestrator.parseCheckResults(out)).toEqual([{ id: "environment", result: "unavailable" }]);
	});

	test("parseCheckResults also reads bullet-point check reports", () => {
		const out = "- typecheck: PASS\n- lint: unavailable (no linter configured)";
		expect(orchestrator.parseCheckResults(out)).toEqual([
			{ id: "typecheck", result: "pass" },
			{ id: "lint", result: "unavailable" },
		]);
	});

	test("parseCheckResults returns nothing for freeform text with no recognized status", () => {
		expect(orchestrator.parseCheckResults("Looks good overall, no issues found.")).toEqual([]);
	});

	test("testedRevisionFor reports the HEAD sha and dirty state for a git worktree", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-tested-revision-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			git("init", "-q");
			git("config", "user.email", "t@example.com");
			git("config", "user.name", "t");
			git("config", "commit.gpgsign", "false");
			writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
			git("add", "a.ts");
			git("commit", "-q", "-m", "init");
			const head = git("rev-parse", "HEAD").toString().trim();
			expect(orchestrator.testedRevisionFor(dir)).toEqual({ revision: head, dirty: false });
			writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
			expect(orchestrator.testedRevisionFor(dir)).toEqual({ revision: head, dirty: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("testedRevisionFor reports an explicit unavailable reason outside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-tested-revision-no-git-"));
		try {
			const result = orchestrator.testedRevisionFor(dir);
			expect(result.revision).toBeNull();
			expect(result.dirty).toBeNull();
			expect(typeof result.unavailable_reason).toBe("string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("changed-file detection around the lead phase", () => {
	function initRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "orch-dirty-snapshot-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		git("config", "commit.gpgsign", "false");
		writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
		git("add", "tracked.ts");
		git("commit", "-q", "-m", "init");
		return dir;
	}

	test("committed work is reported while untouched pre-existing dirty files stay excluded", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			writeFileSync(join(dir, "old-scratch.md"), "existing\n");
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = orchestrator.gitDirtySnapshot(dir);
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "change tracked file");
			// This is the reported failure: a committed change has no dirty snapshot entry.
			expect(orchestrator.gitDirtySnapshot(dir)?.has("tracked.ts")).toBe(false);
			const result = orchestrator.changedFilesSinceRunStart(dir, beforeHead, beforeDirty, ["tracked.ts", "old-scratch.md"]);
			expect(result.changed).toEqual(["tracked.ts"]);
			expect(result.phantom).toEqual(["old-scratch.md"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committed and new dirty files are both reported without duplicates", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = orchestrator.gitDirtySnapshot(dir);
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "change tracked file");
			writeFileSync(join(dir, "tracked.ts"), "export const a = 3;\n");
			writeFileSync(join(dir, "new.ts"), "export {};\n");
			expect(orchestrator.changedFilesSinceRunStart(dir, beforeHead, beforeDirty, []).changed.sort()).toEqual(["new.ts", "tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committing untouched pre-existing dirty content does not claim it as new work", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			writeFileSync(join(dir, "tracked.ts"), "existing dirty content\n");
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = orchestrator.gitDirtySnapshot(dir);
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "commit old dirty file");
			const result = orchestrator.changedFilesSinceRunStart(dir, beforeHead, beforeDirty, ["tracked.ts"]);
			expect(result.changed).toEqual([]);
			expect(result.phantom).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committing an untouched pre-existing staged rename does not claim either path", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			git("mv", "tracked.ts", "renamed.ts");
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = orchestrator.gitDirtySnapshot(dir);
			git("commit", "-q", "-m", "commit old rename");
			const result = orchestrator.changedFilesSinceRunStart(dir, beforeHead, beforeDirty, ["tracked.ts", "renamed.ts"]);
			expect(result.changed).toEqual([]);
			expect(result.phantom).toEqual(["tracked.ts", "renamed.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unborn repository reports files committed in its first commit", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-unborn-run-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			git("init", "-q");
			git("config", "user.email", "t@example.com");
			git("config", "user.name", "t");
			git("config", "commit.gpgsign", "false");
			const beforeHead = orchestrator.gitHead(dir);
			const beforeDirty = orchestrator.gitDirtySnapshot(dir);
			writeFileSync(join(dir, "new.ts"), "export {};\n");
			git("add", "new.ts");
			git("commit", "-q", "-m", "first commit");
			expect(orchestrator.changedFilesSinceRunStart(dir, beforeHead, beforeDirty, []).changed).toEqual(["new.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing start HEAD falls back to claimed files rather than a report-only verdict", () => {
		const dir = initRepo();
		try {
			const beforeDirty = orchestrator.gitDirtySnapshot(dir);
			expect(orchestrator.changedFilesSinceRunStart(dir, null, beforeDirty, ["tracked.ts"]).changed).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committed files remain visible if the pre-run dirty snapshot is unavailable", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "change tracked file");
			expect(orchestrator.changedFilesSinceRunStart(dir, beforeHead, null, []).changed).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failed history comparison cannot silently mark reported work as report-only", () => {
		const dir = initRepo();
		try {
			const beforeDirty = orchestrator.gitDirtySnapshot(dir);
			// A missing commit can occur after a branch rewrite while leads execute.
			const result = orchestrator.changedFilesSinceRunStart(dir, "f".repeat(40), beforeDirty, ["tracked.ts"]);
			expect(result.changed).toEqual(["tracked.ts"]);
			expect(result.phantom).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("pre-existing untracked scratch file named in lead prose is a phantom, not a change", () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "scratch.js"), "console.log(1)\n");
			const before = orchestrator.gitDirtySnapshot(dir);
			// Lead runs, touches nothing, but its report mentions `scratch.js`.
			const after = orchestrator.gitDirtySnapshot(dir);
			const result = orchestrator.diffDirtySnapshots(before, after, ["scratch.js"]);
			expect(result.changed).toEqual([]);
			expect(result.phantom).toEqual(["scratch.js"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("pre-dirty file whose content changed during the run is reported as changed", () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "scratch.js"), "v1\n");
			const before = orchestrator.gitDirtySnapshot(dir);
			writeFileSync(join(dir, "scratch.js"), "v2\n");
			const after = orchestrator.gitDirtySnapshot(dir);
			expect(orchestrator.diffDirtySnapshots(before, after, []).changed).toEqual(["scratch.js"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("new, modified-tracked, and deleted-tracked files are all detected", () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "old-untracked.md"), "keep\n");
			const before = orchestrator.gitDirtySnapshot(dir);
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "new file.ts"), "export {};\n");
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			const after = orchestrator.gitDirtySnapshot(dir);
			const changed = orchestrator.diffDirtySnapshots(before, after, ["old-untracked.md"]).changed.sort();
			expect(changed).toEqual(["src/new file.ts", "tracked.ts"]);

			unlinkSync(join(dir, "tracked.ts"));
			const afterDelete = orchestrator.gitDirtySnapshot(dir);
			expect(afterDelete?.get("tracked.ts")).toBe("<deleted>");
			expect(orchestrator.diffDirtySnapshots(after, afterDelete, []).changed).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resolves paths against the repo root when cwd is a subdirectory", () => {
		const dir = initRepo();
		try {
			mkdirSync(join(dir, "pkg"));
			writeFileSync(join(dir, "pkg", "scratch.js"), "v1\n");
			const before = orchestrator.gitDirtySnapshot(join(dir, "pkg"));
			expect(before?.get("pkg/scratch.js")).not.toBe("<deleted>");
			writeFileSync(join(dir, "pkg", "scratch.js"), "v2\n");
			const after = orchestrator.gitDirtySnapshot(join(dir, "pkg"));
			expect(orchestrator.diffDirtySnapshots(before, after, []).changed).toEqual(["pkg/scratch.js"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("nested repos and staged renames do not abort the snapshot", () => {
		const dir = initRepo();
		try {
			const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
			mkdirSync(join(dir, "inner"));
			execFileSync("git", ["init", "-q"], { cwd: join(dir, "inner"), stdio: "pipe" });
			writeFileSync(join(dir, "inner", "x.txt"), "x\n");
			git("mv", "tracked.ts", "renamed.ts");
			const snap = orchestrator.gitDirtySnapshot(dir);
			expect(snap).not.toBeNull();
			expect(snap?.get("inner/")).toBe("<non-file>");
			expect(snap?.get("renamed.ts")).toMatch(/^[0-9a-f]{40,64}$/);
			expect(snap?.has("tracked.ts")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("diffDirtySnapshots falls back to the de-duplicated scraped list without git snapshots", () => {
		const result = orchestrator.diffDirtySnapshots(null, new Map(), ["a.ts", "a.ts", "b.ts"]);
		expect(result.changed).toEqual(["a.ts", "b.ts"]);
		expect(result.phantom).toEqual([]);
	});
});

describe("diagnostic writer ownership and sealing", () => {
	const ctx = { ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} } };
	test("terminal drain and all producer closes precede seal; late callbacks cannot reopen diagnostics", async () => {
		const session = new orchestrator.RunSession("seal-writers", ctx as never, "test");
		const writer = session.diagnostics.writer();
		writer.write("task.prompt.md", "prompt");
		writer.append("task.events.jsonl", "first\n");
		session.writeDiagnostic("lead-report.md", "report");
		// A real pipe delivers data after the run's UI has closed, as on timeout/error.
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["-e", 'setTimeout(() => { process.stdout.write("late\\n"); process.stderr.write("error\\n"); }, 50)']);
		child.stdout.on("data", data => writer.append("task.events.jsonl", data.toString()));
		child.stderr.on("data", data => writer.append("task.stderr.log", data.toString()));
		const drained = new Promise<void>(resolve => child.on("close", () => { writer.close(); resolve(); }));
		let terminal!: () => void;
		const terminalDrain = new Promise<boolean>(resolve => { terminal = () => resolve(true); });
		session.close();
		const sealing = session.sealDiagnostics(terminalDrain);
		await drained;
		expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
		terminal();
		expect(await sealing).toBe(true);
		const seal = JSON.parse(readFileSync(session.file(".diagnostics-sealed.json"), "utf8"));
		expect(seal.files["task.events.jsonl"].raw_bytes).toBe(11);
		expect(readFileSync(session.file("task.stderr.log"), "utf8")).toBe("error\n");
		expect(writer.append("task.events.jsonl", "too late")).toBe(false);
		expect(session.writeDiagnostic("lead-report.md", "overwrite")).toBe(false);
		orchestrator.appendTrimmedEventLog(session.file("task.events.jsonl"), { type: "late" });
		expect(readFileSync(session.file("task.events.jsonl"), "utf8")).toBe("first\nlate\n");
		expect(() => session.diagnostics.writer()).toThrow();
		expect(() => new orchestrator.RunSession("seal-writers", ctx as never, "reopen")).toThrow();
		// Consume the actual HT seal with Python, not a hand-built Python-only marker.
		const recovered = JSON.parse(execFileSync("python3", ["-B", "-c", `
import json, sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from orchestrator.archive import archive_runs, restore_run
from tempfile import TemporaryDirectory
from shutil import copytree
# Archive fixtures must not overwrite the shared bridge/Python telemetry ledger.
fixture = TemporaryDirectory(); root = Path(fixture.name)
source = Path(sys.argv[1]); run = root/'runs'/source.name
copytree(source, run)
originals = {p.name:p.read_bytes() for p in run.iterdir() if not p.name.startswith('.')}
now = datetime.now(timezone.utc)
(root/'outcomes.jsonl').write_text(json.dumps({'run_id':run.name,'task_id':'run-complete','ts':now.isoformat()})+'\\n')
result = next(e for e in archive_runs(root, execute=True, now=now+timedelta(days=40)) if e['run_id']==run.name)
assert result['status']=='archived', result
assert not (run/'task.events.jsonl').exists()
assert (run/'run.log').read_bytes()==originals['run.log']
assert restore_run(root,run.name)['status']=='restored'
assert all((run/n).read_bytes()==data for n,data in originals.items())
print(json.dumps({'removed':result['raw_bytes_removed'],'ownership':result['ownership']}))
`, session.dir], { env: { ...process.env, PYTHONPATH: process.env.HUMAIN_ORCHESTRATOR_SKILL_ROOT }, encoding: "utf8" }));
		expect(recovered.ownership).toBe("sealed");
		expect(recovered.removed).toBe(29); // prompt 6 + events 11 + stderr 6 + report 6
	});

	// Removing the cleanup deadline must fail promptly rather than hang this test.
	for (const lateClose of [false, true]) {
		test(`seal deadline leaves managed diagnostics archive-ineligible (${lateClose ? "late close" : "lease never closes"})`, async () => {
			const notices: Array<{ message: string; level: string }> = [];
			const session = new orchestrator.RunSession(`seal-timeout-${lateClose}`, {
				ui: { ...ctx.ui, notify: (message: string, level: string) => notices.push({ message, level }) },
			} as never, "test");
			const writer = session.diagnostics.writer();
			writer.append("task.events.jsonl", "before\n");
			session.close();
			let expire: (() => void) | undefined;
			let deadlineMs: number | undefined;
			const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
				expire = callback;
				deadlineMs = ms;
				return 123;
			}) as typeof setTimeout);
			const cleared: unknown[] = [];
			const clear = spyOn(globalThis, "clearTimeout").mockImplementation(id => { cleared.push(id); });
			try {
				let settled: boolean | undefined;
				const sealing = session.sealDiagnostics(Promise.resolve(true));
				void sealing.then(result => { settled = result; });
				expire?.();
				// Flush promise continuations without relying on a real timeout.
				for (let i = 0; i < 20; i++) await Promise.resolve();
				expect(settled).toBe(false);
				expect(deadlineMs).toBeGreaterThan(0);
				expect(deadlineMs).toBeLessThanOrEqual(2000);
				expect(cleared).toContain(123);
				expect(notices.some(n => n.level === "warning" && /UNSEALED/.test(n.message) && /archive-ineligible/.test(n.message))).toBe(true);
				expect(existsSync(session.file(".diagnostics-owner.json"))).toBe(true);
				expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
				expect(() => session.diagnostics.writer()).toThrow();
				expect(session.writeDiagnostic("task.events.jsonl", "overwrite")).toBe(false);
				// Deadline does not revoke a producer's lease or lose its trailing bytes.
				expect(writer.append("task.events.jsonl", "late\n")).toBe(true);
				if (lateClose) {
					writer.close();
					writer.close(); // idempotent close after the abandoned seal attempt
					expect(writer.append("task.events.jsonl", "after close")).toBe(false);
				}
				for (let i = 0; i < 20; i++) await Promise.resolve();
				expect(await session.sealDiagnostics(Promise.resolve(true))).toBe(false);
				orchestrator.appendTrimmedEventLog(session.file("task.events.jsonl"), { type: "bypass" });
				expect(readFileSync(session.file("task.events.jsonl"), "utf8")).toBe("before\nlate\n");
				expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
				// Exercise the Python archive gate with the real timed-out owner marker.
				const result = JSON.parse(execFileSync("python3", ["-B", "-c", `
import json, sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from orchestrator.archive import archive_runs
from tempfile import TemporaryDirectory
from shutil import copytree
fixture = TemporaryDirectory(); root = Path(fixture.name)
source = Path(sys.argv[1]); run = root/'runs'/source.name
copytree(source, run)
now = datetime.now(timezone.utc)
(root/'outcomes.jsonl').write_text(json.dumps({'run_id':run.name,'task_id':'run-complete','ts':now.isoformat()})+'\\n')
before = {p.name:p.read_bytes() for p in run.iterdir()}
result = next(e for e in archive_runs(root, execute=True, now=now+timedelta(days=40)) if e['run_id']==run.name)
assert {p.name:p.read_bytes() for p in run.iterdir()} == before
print(json.dumps(result))
`, session.dir], { env: { ...process.env, PYTHONPATH: process.env.HUMAIN_ORCHESTRATOR_SKILL_ROOT }, encoding: "utf8" }));
				expect(result.status).toBe("skipped");
				expect(result.reason).toBe("writers_unsealed");
			} finally {
				timer.mockRestore();
				clear.mockRestore();
			}
		});
	}

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

	test("a shutdown failure vetoes an in-flight diagnostic seal before the last producer closes", async () => {
		const session = new orchestrator.RunSession("seal-shutdown-veto", ctx as never, "test");
		const writer = session.diagnostics.writer();
		writer.append("late.events.jsonl", "before\n");
		session.close();
		const sealing = session.sealDiagnostics(Promise.resolve(true));
		const abandoned = session.sealDiagnostics(Promise.resolve(false));
		writer.append("late.events.jsonl", "after\n");
		writer.close();
		expect(await sealing).toBe(false);
		expect(await abandoned).toBe(false);
		expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
		expect(readFileSync(session.file("late.events.jsonl"), "utf8")).toBe("before\nafter\n");
	});

	test("failed terminal drain never seals, even with all writers closed", async () => {
		const session = new orchestrator.RunSession("seal-failed-drain", ctx as never, "test");
		session.close();
		expect(await session.sealDiagnostics(Promise.resolve(false))).toBe(false);
		expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
	});
});

describe("final triage and shutdown integration", () => {
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
				await orchestrator.activeRunForTest()?.runPromise;
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
			expect(readRows("outcomes.jsonl").filter(row => row.run_id === runId && row.task_id === "run-cancelled")).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("cancelled");
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
			expect(readRows("outcomes.jsonl").filter(row => row.run_id === runId && row.task_id === "run-cancelled")).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("cancelled");
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
			expect(readRows("outcomes.jsonl").some(row => row.run_id === runId && row.task_id === "run-cancelled")).toBe(true);
			expect(readRows("metrics.jsonl").find(row => row.run_id === runId && row.event === "model_call")?.cost_usd).toBe(.1);
			expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("cancelled");
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
			const session = orchestrator.activeRunForTest();
			expect(session).not.toBeNull();
			await started; // background reached the real (mocked) plan spawn
			expect(orchestrator.activeRunForTest()).toBe(session);
			await omsgHandler("check the staging config", ctx as never);
			expect(notices.some(n => n.includes("Queued for next dispatch"))).toBe(true);
			expect(session!.queuedDepth()).toBe(1);
		} finally {
			child?.kill();
			await orchestrator.activeRunForTest()?.runPromise;
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
			const first = orchestrator.activeRunForTest();
			await started;
			await handler("second synthetic run --complexity 4", ctx as never);
			expect(orchestrator.activeRunForTest()).toBe(first);
			expect(notices.some(n => n.includes("already running"))).toBe(true);
		} finally {
			child?.kill();
			await orchestrator.activeRunForTest()?.runPromise;
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
			active = orchestrator.activeRunForTest();
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
			const sessionA = orchestrator.activeRunForTest()!;
			expect(sessionA).not.toBeNull();
			// The race guard above makes it impossible for a second run to take ACTIVE_RUN while
			// sessionA still owns it, so simulate the state directly: a newer run has since become
			// ACTIVE_RUN. sessionA's own finally must recognize it no longer owns the singleton and
			// leave it alone rather than unconditionally nulling it out.
			const sessionB = new orchestrator.RunSession!("newer-run-stale-finally-test", ctx as never, "a different goal");
			orchestrator.setActiveRunForTest!(sessionB);
			await sessionA.runPromise;
			expect(orchestrator.activeRunForTest()).toBe(sessionB);
			sessionB.close();
			await sessionB.sealDiagnostics();
			sessionB.finish();
			orchestrator.setActiveRunForTest!(null);
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
			const session = orchestrator.activeRunForTest()!;
			await started;
			await cancelHandler("", ctx as never);
			child?.kill();
			await session.runPromise;
			expect(orchestrator.activeRunForTest()).toBeNull();
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
			await orchestrator.activeRunForTest()?.runPromise;
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

	test("session shutdown cancels the live run, records it cancelled, and clears ACTIVE_RUN/widget/status", async () => {
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
			expect(orchestrator.activeRunForTest()).toBeNull();
			expect(widget).toBeUndefined();
			expect(status).toBeUndefined();
			expect(session?.cancelReason).toBe("shutdown");
			const runId = session!.runId;
			const outcome = readRows("outcomes.jsonl").find(row => row.run_id === runId && row.task_id === "run-cancelled");
			expect(outcome).toMatchObject({ outcome: "cancelled", note: "session_shutdown" });
			expect(readRows("events.jsonl").some(row => row.run_id === runId && row.event === "run_cancelled")).toBe(true);
			expect(JSON.parse(readFileSync(join(pythonStateRoot, "ledger.json"), "utf8")).runs[runId].status).toBe("cancelled");
			// A shutdown-initiated cancel has no live session to post into; the chat must stay silent for this run.
			expect(sent.some((s) => s.message.details?.runId === runId)).toBe(false);
		} finally {
			session?.cancel();
			await session?.runPromise;
			phase.mockRestore(); spawn.mockRestore();
		}
	}, 30_000);

	test("a ctx whose ui getter throws after shutdown still ends with ACTIVE_RUN null and a recorded cancelled outcome", async () => {
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
			expect(orchestrator.activeRunForTest()).toBeNull();
			const runId = session!.runId;
			expect(readRows("outcomes.jsonl").some(row => row.run_id === runId && row.task_id === "run-cancelled")).toBe(true);
			expect(errors.some((args) => String(args[0] ?? "").includes("rejected unexpectedly"))).toBe(false);
		} finally {
			uiInvalidated = false;
			session?.cancel();
			await session?.runPromise;
			phase.mockRestore(); spawn.mockRestore(); errSpy.mockRestore();
		}
	}, 30_000);
});

describe("archived run diagnostics lookup", () => {
	test("a readable path is returned unchanged; an archived one names the .gz and the restore command; a missing one says so", () => {
		const runDir = join(testStateRoot, "runs", "ht-orch-1790000000000-abcdef");
		mkdirSync(runDir, { recursive: true });
		const log = join(runDir, "run.log");
		writeFileSync(log, "2026-08-01T00:00:00Z run started\n");
		expect(orchestrator.describeRunArtifact(log)).toBe(log);

		const report = join(runDir, "lead-report.md");
		writeFileSync(`${report}.gz`, "not really gzip, existence is what matters here");
		writeFileSync(
			join(runDir, "archive.manifest.json"),
			JSON.stringify({ format_version: 1, run_id: "ht-orch-1790000000000-abcdef", files: { "lead-report.md": { archive: "lead-report.md.gz", sha256: "00" } } }),
		);
		const described = orchestrator.describeRunArtifact(report);
		expect(described).toContain(report);
		expect(described).toContain(`${report}.gz`);
		expect(described).toContain("restore-run ht-orch-1790000000000-abcdef");

		// once restored (or never archived) the plain path wins again
		writeFileSync(report, "report\n");
		expect(orchestrator.describeRunArtifact(report)).toBe(report);

		// a .gz without a manifest entry is not ours to describe as archived
		const stray = join(runDir, "other.stderr.log");
		writeFileSync(`${stray}.gz`, "x");
		expect(orchestrator.describeRunArtifact(stray)).toBe(`${stray} (missing)`);
		expect(orchestrator.describeRunArtifact(join(runDir, "never.txt"))).toBe(`${join(runDir, "never.txt")} (missing)`);
	});
});

describe("lead sizing wiring (Phase A)", () => {
	const lowPlan = { ...planFixture, complexity: 2, risk: "low", topology: { depth: 2, leads: 1, workers: 0, shape: "lead-workers" } };
	const fakeResult = (t: DispatchTask) => ({
		taskId: t.taskId, capability: t.capability, model: "m", exitCode: 0, stdout: "STATUS: completed", stderr: "",
		usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
	} as DispatchResult);

	test("--lead-size parses and rejects junk", () => {
		expect(orchestrator.parseArgs("do x --lead-size small").leadSize).toBe("small");
		expect(orchestrator.parseArgs("do x --lead-size small").goal).toBe("do x");
		const bad = orchestrator.parseArgs("do x --lead-size huge");
		expect(bad.leadSize).toBeUndefined();
		expect(bad.unknownFlags.join()).toContain("--lead-size huge");
		expect(orchestrator.parseArgs("do x --lead-size").unknownFlags.join()).toContain("missing value");
	});

	test("flags named inside the goal prose stay goal text and do not take effect", () => {
		// Regression: ht-orch-1790256789245-1a3fms. "Keep --interactive confirmations blocking" in the
		// goal switched interactive mode on (12 min idle at the plan dialog) and was cut out of the spec.
		const p = orchestrator.parseArgs("Fix X. Keep --interactive confirmations blocking and --risk handling intact. --risk high");
		expect(p.interactive).toBe(false);
		expect(p.risk).toBe("high");
		expect(p.goal).toBe("Fix X. Keep --interactive confirmations blocking and --risk handling intact.");
		expect(p.unknownFlags).toEqual([]);
		// Unknown --words inside prose are text, not errors.
		expect(orchestrator.parseArgs("explain what --frobnicate does").unknownFlags).toEqual([]);
	});

	test("leading and trailing flags still parse", () => {
		const p = orchestrator.parseArgs("--risk low --interactive do the thing --complexity 3 --lead-size small");
		expect(p).toMatchObject({ risk: "low", interactive: true, complexity: 3, leadSize: "small", goal: "do the thing" });
		expect(orchestrator.parseArgs("do x --bogus").unknownFlags).toEqual(["--bogus"]);
	});

	test("--max-retries 0 is honoured, not coerced to the default", () => {
		expect(orchestrator.parseArgs("do x --max-retries 0").maxRetries).toBe(0);
		expect(orchestrator.parseArgs("do x --max-retries 4").maxRetries).toBe(4);
		expect(orchestrator.parseArgs("do x --max-retries -1").maxRetries).toBe(2);
		expect(orchestrator.parseArgs("do x --max-retries nope").maxRetries).toBe(2);
		expect(orchestrator.parseArgs("do x").maxRetries).toBe(2);
	});

	test("dispatchReconAndLeads dispatches the sized lead capability", async () => {
		const dispatched: string[] = [];
		await orchestrator.dispatchReconAndLeads(
			{ runId: "r1", goal: "g", plan: lowPlan, adapter: { lead_small: { model: "p/sonnet-5" } }, leadCapability: "lead_small" },
			{
				dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.capability)); return tasks.map(fakeResult); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
			},
		);
		expect(dispatched).toEqual(["lead_small"]);
	});

	test("failed verification escalates the lead one size per retry, capped at large", () => {
		const t = (capability: string) => [
			{ task: { capability, task: "t", taskId: "r-lead-0" }, result: { exitCode: 0, stdout: "report", filesChanged: [] } },
		];
		expect(orchestrator.planEscalationForTest(["tests failed"], t("lead_small"), 2, "low", 0, 2)[0].capability).toBe("lead");
		expect(orchestrator.planEscalationForTest(["tests failed"], t("lead_small"), 2, "low", 1, 2)[0].capability).toBe("lead_large");
		expect(orchestrator.planEscalationForTest(["tests failed"], t("lead_large"), 9, "low", 0, 2)[0].capability).toBe("lead_large");
		expect(orchestrator.planEscalationForTest(["tests failed"], t("technical_review"), 5, "low", 0, 2)[0].capability).toBe("technical_review");
		expect(orchestrator.planEscalationForTest(["x"], t("lead"), 5, "high", 0, 2)[0].task).toContain("at least the premium tier");
	});

	test("policyIdFor is stable for identical bindings and changes with them", () => {
		const a = { lead: { model: "x/opus-5-5" }, scout: { model: "x/luna", effort: "low" } };
		expect(orchestrator.policyIdFor("premium", a)).toBe(orchestrator.policyIdFor("premium", { scout: a.scout, lead: a.lead }));
		expect(orchestrator.policyIdFor("premium", a)).toMatch(/^premium-[0-9a-f]{8}$/);
		expect(orchestrator.policyIdFor("premium", { ...a, lead: { model: "x/fable-5-1" } })).not.toBe(orchestrator.policyIdFor("premium", a));
	});

	test("leadSelfImplemented flags a lead that changed files without dispatching implementers", () => {
		expect(orchestrator.leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "I edited a.ts" })).toBe(true);
		expect(orchestrator.leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "dispatched orch-implementation-strong" })).toBe(false);
		expect(orchestrator.leadSelfImplemented({ filesChanged: [], stdout: "" })).toBe(false);
	});

	test("lead prompt states the delegation rule and the STATUS contract", () => {
		const p = orchestrator.leadPrompt("goal", planFixture, undefined, "", 0, 1, adapterFixture);
		expect(p).toContain(orchestrator.LEAD_DELEGATION_RULE);
		expect(p).toContain(orchestrator.LEAD_STATUS_CONTRACT);
	});

	test("lead persona cannot write or edit", () => {
		const persona = readFileSync(new URL("../../agents/orchestrator-lead.md", import.meta.url), "utf8");
		const tools = /^tools:\s*(.+)$/m.exec(persona)?.[1].split(",").map((t) => t.trim()) ?? [];
		expect(tools).toContain("subagent");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("edit");
	});
});

describe("codex -> Bedrock quota fallback (Phase A)", () => {
	const table = buildAliasTable([
		{ provider: "openai-codex", id: "gpt-6-astra" },
		{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
		{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
	]);
	const proc = (over: Partial<Awaited<ReturnType<typeof orchestrator.runSubagentProcess>>>) => ({
		exitCode: 0, stdout: "ok", finalText: "ok", rawStdout: "", personaCanMutate: false, stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
		costUsd: 0.01, costReported: true, durationMs: 5, outcome: "completed" as const, processExitCode: 0, ...over,
	});
	const task = (model: string): DispatchTask[] => [{ capability: "security_review", task: "review", taskId: "run-sec" }];

	test("quota failure on codex retries once on the Bedrock twin and records route_degraded", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const models: string[] = [];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", task(""),
			{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, 0, {
				recordEvent: (e, p) => { events.push([e, p]); },
				aliasTable: table,
				runProcess: async (opts) => {
					models.push(opts.model);
					return models.length === 1
						? proc({ exitCode: 1, stderr: "usage limit reached for this account", costUsd: 0, costReported: true,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } })
						: proc({ model: "amazon-bedrock/global.openai.gpt-6-astra" });
				},
			});
		expect(models).toEqual(["openai-codex/gpt-6-astra", "amazon-bedrock/global.openai.gpt-6-astra"]);
		expect(result.exitCode).toBe(0);
		expect(result.model).toBe("amazon-bedrock/global.openai.gpt-6-astra");
		expect(result.taskId).toBe("run-sec");
		const degraded = events.filter(([e]) => e === "route_degraded");
		expect(degraded).toHaveLength(1);
		expect(degraded[0][1]).toMatchObject({ from_model: "openai-codex/gpt-6-astra", to_model: "amazon-bedrock/global.openai.gpt-6-astra", reason: "provider_quota" });
	});

	test("no Bedrock twin: the original failure is returned, no redispatch", async () => {
		let calls = 0;
		const events: string[] = [];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", task(""),
			{ security_review: { model: "openai-codex/gpt-5.3-codex-spark" } }, {} as never, 0, {
				recordEvent: (e) => { events.push(e); },
				aliasTable: table,
				runProcess: async () => { calls++; return proc({ exitCode: 1, stderr: "429 Too Many Requests" }); },
			});
		expect(calls).toBe(1);
		expect(result.exitCode).toBe(1);
		expect(events).not.toContain("route_degraded");
	});

	test("Phase 1 review T1/T2: each fallback attempt's dispatch_finished carries only its own nested cost, and detail rows never collide across attempts", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const calls: Record<string, unknown>[] = [];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", task(""),
			{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, 0, {
				recordEvent: (e, p) => { events.push([e, p]); },
				recordModelCall: (m) => { calls.push(m); },
				aliasTable: table,
				runProcess: async (opts) => opts.model === "openai-codex/gpt-6-astra"
					? proc({
						exitCode: 1, stderr: "usage limit reached for this account", costUsd: 1, costReported: true,
						nestedCostUsd: 2, nestedCalls: [{
							key: "tc1:impl-0:0", toolCallId: "tc1", taskId: "impl-0",
							agent: "orch-implementation-strong", model: "provider/impl-model",
							usage: { cost: 2 }, costReported: true, exitCode: 0,
						}],
					})
					: proc({
						model: "amazon-bedrock/global.openai.gpt-6-astra", costUsd: 3, costReported: true,
						nestedCostUsd: 5, nestedCalls: [{
							// SAME (toolCallId, taskId, attempt) as the first attempt's nested call — a
							// separate child process can legitimately reuse tool-call ids, so the two
							// must not collide (Phase 1 review finding T2).
							key: "tc1:impl-0:0", toolCallId: "tc1", taskId: "impl-0",
							agent: "orch-implementation-strong", model: "provider/impl-model",
							usage: { cost: 5 }, costReported: true, exitCode: 0,
						}],
					}),
			});
		const finished = events.filter(([e]) => e === "dispatch_finished");
		expect(finished).toHaveLength(2);
		const [superseded, final] = finished;
		expect(superseded[1]).toMatchObject({
			dispatch_attempt: 0, nested_cost_usd: 2, nested_rows_emitted: 1, superseded_by_fallback: true,
		});
		expect(final[1]).toMatchObject({ dispatch_attempt: 1, nested_cost_usd: 5, nested_rows_emitted: 1 });
		expect(final[1].superseded_by_fallback).toBeUndefined();
		// The RETURNED DispatchResult still reports the dispatch's TRUE total across both billed
		// attempts (2 + 5 = 7) — only the per-event telemetry is split per attempt.
		expect(result.nestedCostUsd).toBe(7);
		// Two detail rows, one per attempt, never deduplicated into one despite the identical
		// (toolCallId, taskId, nested-attempt) key.
		expect(calls).toHaveLength(2);
		expect(new Set(calls.map((c) => c.record_id)).size).toBe(2);
		expect(calls.map((c) => c.dispatch_attempt).sort()).toEqual([0, 1]);
		expect(calls.map((c) => c.cost_usd).sort()).toEqual([2, 5]);
	});

	test("non-quota failure is not retried", async () => {
		let calls = 0;
		await orchestrator.dispatchParallel(process.cwd(), "run", task(""),
			{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, 0, {
				recordEvent: () => {}, aliasTable: table,
				runProcess: async () => { calls++; return proc({ exitCode: 1, stderr: "TypeError: boom" }); },
			});
		expect(calls).toBe(1);
	});
});

describe("model canary telemetry through dispatchParallel (Phase 2 item 2)", () => {
	const nestedProc = (over: Partial<Awaited<ReturnType<typeof orchestrator.runSubagentProcess>>>) => ({
		exitCode: 0, stdout: "ok", finalText: "ok", rawStdout: "", personaCanMutate: false, stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
		costUsd: 0.01, costReported: true, durationMs: 5, outcome: "completed" as const, processExitCode: 0, ...over,
	});
	const implTask: DispatchTask[] = [{ capability: "implementation_fast", task: "impl work", taskId: "run-impl-0" }];

	test("under the shipped (disabled) config, cohort is baseline and requested === executed === baseline model", async () => {
		// `worker` (cheap tier, not implementation_fast/strong) has no matching
		// candidate at all, so eligibility is decided without needing an alias
		// table — exercising the common case for most capabilities.
		const workerTask: DispatchTask[] = [{ capability: "worker", task: "work", taskId: "run-worker-0" }];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", workerTask,
			{ worker: { model: "provider/worker-model" } }, {} as never, 0, {
				recordEvent: () => {},
				runProcess: async (opts) => nestedProc({ model: opts.model }),
			});
		expect(result.canary).toMatchObject({
			canary_cohort: "baseline",
			canary_activation: "disabled",
			canary_reason: "no_matching_candidate",
			baseline_model: "provider/worker-model",
			requested_model: "provider/worker-model",
			executed_model: "provider/worker-model",
			canary_deviation: null,
		});
		// Observational only: the model actually dispatched never changes.
		expect(result.model).toBe("provider/worker-model");
	});

	test("a resolvable matching candidate still stays on baseline while canaries are globally disabled", async () => {
		// implementation_fast matches the "impl-gpt-6-sol" candidate by capability name;
		// with an alias table that CAN resolve it, this exercises the full eligibility
		// path (resolvable, not tier-lowering, not equal-to-baseline) down to the
		// `activation === "disabled"` branch, which still returns cohort "baseline".
		const table = buildAliasTable([{ provider: "some-provider", id: "gpt-6-sol" }]);
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", implTask,
			{ implementation_fast: { model: "provider/impl-model" } }, {} as never, 0, {
				recordEvent: () => {},
				aliasTable: table,
				runProcess: async (opts) => nestedProc({ model: opts.model }),
			});
		expect(result.canary).toMatchObject({
			canary_cohort: "baseline",
			canary_activation: "disabled",
			canary_reason: "canary_disabled",
			canary_candidate_id: "impl-gpt-6-sol",
			candidate_model: "some-provider/gpt-6-sol",
			baseline_model: "provider/impl-model",
			requested_model: "provider/impl-model",
			executed_model: "provider/impl-model",
			canary_deviation: null,
		});
		expect(result.model).toBe("provider/impl-model");
	});

	test("an explicit operator override (binding source 'flag') makes the assignment ineligible", async () => {
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", implTask,
			{ implementation_fast: { model: "provider/impl-model" } }, {} as never, 0, {
				recordEvent: () => {},
				runProcess: async (opts) => nestedProc({ model: opts.model }),
				modelSources: { implementation_fast: "flag" },
			});
		expect(result.canary?.canary_cohort).toBe("ineligible");
		expect(result.canary?.canary_reason).toBe("explicit_user_override");
		expect(result.model).toBe("provider/impl-model");
	});

	test("a codex -> Bedrock quota fallback labels canary_deviation from executed vs requested model", async () => {
		const table = buildAliasTable([
			{ provider: "openai-codex", id: "gpt-6-astra" },
			{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
		]);
		const fallbackTask: DispatchTask[] = [{ capability: "implementation_fast", task: "impl work", taskId: "run-impl-fb" }];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", fallbackTask,
			{ implementation_fast: { model: "openai-codex/gpt-6-astra" } }, {} as never, 0, {
				recordEvent: () => {},
				aliasTable: table,
				runProcess: async (opts) => opts.model === "openai-codex/gpt-6-astra"
					? nestedProc({ exitCode: 1, stderr: "usage limit reached for this account", model: opts.model })
					: nestedProc({ model: opts.model }),
			});
		expect(result.model).toBe("amazon-bedrock/global.openai.gpt-6-astra");
		expect(result.canary?.requested_model).toBe("openai-codex/gpt-6-astra");
		expect(result.canary?.executed_model).toBe("amazon-bedrock/global.openai.gpt-6-astra");
		// Same underlying baseline, different provider after the quota fallback:
		// executed != requested, so a deviation must be labelled, never silently null.
		expect(result.canary?.canary_deviation).not.toBeNull();
	});

	test("security_review is excluded from canary comparison entirely", async () => {
		const secTask: DispatchTask[] = [{ capability: "security_review", task: "review", taskId: "run-sec-canary" }];
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", secTask,
			{ security_review: { model: "provider/sec-model" } }, {} as never, 0, {
				recordEvent: () => {},
				runProcess: async (opts) => nestedProc({ model: opts.model }),
			});
		expect(result.canary?.canary_reason).toBe("capability_excluded");
		expect(result.canary?.canary_cohort).toBe("baseline");
	});

	test("experiment_flags reflects loadEfficiencyControls().enabled at dispatch time", async () => {
		const [result] = await orchestrator.dispatchParallel(process.cwd(), "run", implTask,
			{ implementation_fast: { model: "provider/impl-model" } }, {} as never, 0, {
				recordEvent: () => {},
				runProcess: async (opts) => nestedProc({ model: opts.model }),
				efficiencyControls: { controls: {} as never, problems: [], enabled: ["scoped_leads"] },
			});
		expect(result.experimentFlags).toEqual(["scoped_leads"]);
	});
});

describe("nested subagent cost rows (Phase 1 item 2)", () => {
	const nestedProc = (over: Partial<Awaited<ReturnType<typeof orchestrator.runSubagentProcess>>>) => ({
		exitCode: 0, stdout: "ok", finalText: "ok", rawStdout: "", personaCanMutate: false, stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
		costUsd: 0.01, costReported: true, durationMs: 5, outcome: "completed" as const, processExitCode: 0, ...over,
	});
	const leadTask: DispatchTask[] = [{ capability: "lead", task: "lead work", taskId: "run-lead" }];

	test("one row per nested call, tagged nested/nesting_depth, and nested_rows_emitted matches", async () => {
		const calls: Record<string, unknown>[] = [];
		const events: Array<[string, Record<string, unknown>]> = [];
		await orchestrator.dispatchParallel(process.cwd(), "run", leadTask,
			{ lead: { model: "provider/lead-model" } }, {} as never, 0, {
				recordEvent: (e, p) => { events.push([e, p]); },
				recordModelCall: (m) => { calls.push(m); },
				runProcess: async () => nestedProc({
					nestedCostUsd: 4.19,
					nestedCalls: [{
						key: "tc1:impl-0:0", toolCallId: "tc1", taskId: "impl-0",
						agent: "orch-implementation-strong", model: "provider/impl-model",
						usage: { input: 10, output: 20, cost: 4.19, turns: 1 },
						costReported: true, exitCode: 0,
					}],
				}),
			});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			event: "model_call", run_id: "run", parent_task_id: "run-lead",
			role: "implementation_strong", capability_class: "implementation_strong",
			provider: "provider", model: "provider/impl-model",
			cost_usd: 4.19, cost_source: "reported", nested: true, nesting_depth: 1,
		});
		const finished = events.filter(([e]) => e === "dispatch_finished");
		expect(finished).toHaveLength(1);
		expect(finished[0][1]).toMatchObject({ nested_cost_usd: 4.19, nested_rows_emitted: 1 });
	});

	test("unknown agent name maps to role 'unknown', never guessed", async () => {
		const calls: Record<string, unknown>[] = [];
		await orchestrator.dispatchParallel(process.cwd(), "run", leadTask,
			{ lead: { model: "provider/lead-model" } }, {} as never, 0, {
				recordEvent: () => {},
				recordModelCall: (m) => { calls.push(m); },
				runProcess: async () => nestedProc({
					nestedCalls: [{
						key: "tc1:t-0:0", toolCallId: "tc1", taskId: "t-0",
						agent: "totally-custom-agent", model: "provider/m",
						usage: { cost: 1 }, costReported: true, exitCode: 0,
					}],
				}),
			});
		expect(calls[0]).toMatchObject({ role: "unknown", capability_class: "unknown" });
	});

	test("unknown cost stays absent (never coerced to 0)", async () => {
		const calls: Record<string, unknown>[] = [];
		await orchestrator.dispatchParallel(process.cwd(), "run", leadTask,
			{ lead: { model: "provider/lead-model" } }, {} as never, 0, {
				recordEvent: () => {},
				recordModelCall: (m) => { calls.push(m); },
				runProcess: async () => nestedProc({
					nestedCalls: [{
						key: "tc1:t-0:0", toolCallId: "tc1", taskId: "t-0",
						agent: "orch-scout", model: "provider/m",
						usage: {}, costReported: false, exitCode: 0,
					}],
				}),
			});
		expect(calls).toHaveLength(1);
		expect("cost_usd" in calls[0]).toBe(false);
		expect("cost_source" in calls[0]).toBe(false);
	});

	test("retries: distinct attempts on the same taskId each get their own row", async () => {
		const calls: Record<string, unknown>[] = [];
		await orchestrator.dispatchParallel(process.cwd(), "run", leadTask,
			{ lead: { model: "provider/lead-model" } }, {} as never, 0, {
				recordEvent: () => {},
				recordModelCall: (m) => { calls.push(m); },
				runProcess: async () => nestedProc({
					nestedCalls: [
						{ key: "tc1:t-0:0", toolCallId: "tc1", taskId: "t-0", attempt: 0,
						  agent: "orch-implementation-fast", model: "provider/m", usage: { cost: 0.5 }, costReported: true, exitCode: 1 },
						{ key: "tc1:t-0:1", toolCallId: "tc1", taskId: "t-0", attempt: 1,
						  agent: "orch-implementation-fast", model: "provider/m", usage: { cost: 0.7 }, costReported: true, exitCode: 0 },
					],
				}),
			});
		expect(calls).toHaveLength(2);
		expect(new Set(calls.map((c) => c.record_id)).size).toBe(2);
		expect(calls.map((c) => c.cost_usd).sort()).toEqual([0.5, 0.7]);
	});

	test("emits nothing when the dispatch had no nested subagent calls", async () => {
		const calls: Record<string, unknown>[] = [];
		const events: Array<[string, Record<string, unknown>]> = [];
		await orchestrator.dispatchParallel(process.cwd(), "run", leadTask,
			{ lead: { model: "provider/lead-model" } }, {} as never, 0, {
				recordEvent: (e, p) => { events.push([e, p]); },
				recordModelCall: (m) => { calls.push(m); },
				runProcess: async () => nestedProc({}),
			});
		expect(calls).toHaveLength(0);
		const finished = events.filter(([e]) => e === "dispatch_finished");
		expect(finished[0][1]).toMatchObject({ nested_rows_emitted: 0 });
	});

	test("roleForAgentName: known aliases, orch-<capability>, and unknown fallback", () => {
		expect(orchestrator.roleForAgentName("orch-scout")).toBe("scout");
		expect(orchestrator.roleForAgentName("orch-implementation-strong")).toBe("implementation_strong");
		expect(orchestrator.roleForAgentName("orch-technical-review")).toBe("api_contract_review");
		expect(orchestrator.roleForAgentName("orchestrator-lead")).toBe("lead_large");
		expect(orchestrator.roleForAgentName(undefined)).toBe("unknown");
		expect(orchestrator.roleForAgentName("something-else")).toBe("unknown");
	});
});

describe("orchestrator fixes from run ht-orch-1790237987755-lyjkn8 (A8)", () => {
	const threeLeadPlan = { ...planFixture, complexity: 8, topology: { depth: 3, leads: 3, workers: 0, shape: "multi_lead" } };
	const architect = (text: string) => ({
		taskId: "r-architect", capability: "architect", model: "m", exitCode: 0, stdout: text, stderr: "",
		usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
	} as DispatchResult);
	const run = async (architectText: string, statusFor: (taskId: string) => string) => {
		const batches: string[][] = [];
		const phases: string[] = [];
		const { leadResults, skippedLeads } = await orchestrator.dispatchReconAndLeads(
			{ runId: "r", goal: "g", plan: { ...threeLeadPlan, task_class: "investigation" }, adapter: { lead: { model: "p/opus-5-5" } }, architectResult: architect(architectText) },
			{
				dispatch: async (tasks) => {
					batches.push(tasks.map((t) => t.taskId));
					return tasks.map((t) => ({
						taskId: t.taskId, capability: t.capability, model: "m", exitCode: 0, stdout: `report\nSTATUS: ${statusFor(t.taskId)}`,
						stderr: "", usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
					} as DispatchResult));
				},
				capture: async () => {}, setPhase: (p) => phases.push(p), throwIfCancelled: () => {},
			},
		);
		return { batches, phases, leadResults, skipped: skippedLeads };
	};
	const chain = "## Lead assignments\nLead 1: phase 0 (depends on: none)\nLead 2: A1-A3 (depends on: 1)\nLead 3: A4-A7 (depends on: 2)\n";

	test("dependent leads run in sequential waves, each with its scope", async () => {
		const { batches, leadResults } = await run(chain, () => "completed");
		expect(batches).toEqual([["r-lead-0"], ["r-lead-1"], ["r-lead-2"]]);
		expect(leadResults).toHaveLength(3);
	});

	test("a blocked lead stops the leads that depend on it", async () => {
		const { batches, phases, leadResults } = await run(chain, (id) => (id === "r-lead-0" ? "blocked" : "completed"));
		expect(batches).toEqual([["r-lead-0"]]);
		expect(leadResults).toHaveLength(1);
		expect(phases.join("\n")).toContain("not starting lead(s) 2");
		expect((await run(chain, (id) => (id === "r-lead-0" ? "blocked" : "completed"))).skipped).toBe(2);
	});

	test("no valid Lead assignments collapses to a single lead instead of N clones", async () => {
		const { batches, phases } = await run("## Tasks\n1. do it", () => "completed");
		expect(batches).toEqual([["r-lead-0"]]);
		expect(phases.join("\n")).toContain("running a single lead");
	});

	test("architect is asked for Lead assignments only when there are several leads", () => {
		expect(orchestrator.architectPrompt("g", threeLeadPlan)).toContain("## Lead assignments");
		expect(orchestrator.architectPrompt("g", planFixture)).not.toContain("## Lead assignments");
	});

	test("lead prompt carries the assigned scope and its dependencies", () => {
		const p = orchestrator.leadPrompt("g", threeLeadPlan, undefined, "", 1, 3, adapterFixture, { index: 1, scope: "A1-A3", dependsOn: [0] });
		expect(p).toContain("Your scope (from the architect's Lead assignments): A1-A3");
		expect(p).toContain("Leads 1 ran before you");
	});

	test("a blocked run is recorded as blocked, not fail or verified", () => {
		expect(orchestrator.runCompletionOutcomeFor("r", { blocked: true, verification_passed: false }).outcome).toBe("blocked");
		expect(orchestrator.runCompletionOutcomeFor("r", { verification_passed: false }).outcome).toBe("fail");
		expect(orchestrator.runCompletionOutcomeFor("r", { verification_passed: true }).outcome).toBe("verified");
	});

	test("QA is told to stay in scope and not debug the environment", () => {
		expect(orchestrator.QA_SCOPE_RULES.join(" ")).toContain("verify ONLY the files listed above");
		expect(orchestrator.QA_SCOPE_RULES.join(" ")).toContain("after 2 attempts");
	});
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
		const picked = orchestrator.pickModelForTest("technical_review", adapter, 1, "medium");
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
				{ security_review: { model: "openai-codex/gpt-6-astra" } }, {} as never, 0, {
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
});


// -----------------------------------------------------------------------------
// Efficiency controls (efficiency-flags.ts) wiring: recon_before_architect,
// delegation_guidance, event_waiting_guidance, file_ownership. All four
// switches default OFF; every test below that omits `controls` relies on that
// default via loadEfficiencyControls(), matching production behaviour.
// -----------------------------------------------------------------------------

describe("efficiency controls wiring: off is byte-identical to today", () => {
	const offControls = loadEfficiencyControls().controls;
	const multiLeadPlan = { ...planFixture, complexity: 8, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } };

	test("architectPrompt: explicit off controls match the default (no controls arg)", () => {
		expect(orchestrator.architectPrompt("g", multiLeadPlan, offControls)).toBe(orchestrator.architectPrompt("g", multiLeadPlan));
		expect(orchestrator.architectPrompt("g", planFixture, offControls)).toBe(orchestrator.architectPrompt("g", planFixture));
	});

	test("leadPrompt: explicit off controls match the default (no controls arg)", () => {
		const assignment = { index: 1, scope: "A1-A3", dependsOn: [0], owns: ["src/a.ts"] };
		const withOff = orchestrator.leadPrompt("g", multiLeadPlan, undefined, "", 1, 2, adapterFixture, assignment, offControls);
		const withDefault = orchestrator.leadPrompt("g", multiLeadPlan, undefined, "", 1, 2, adapterFixture, assignment);
		expect(withOff).toBe(withDefault);
	});

	test("dispatchReconAndLeads: explicit off controls dispatch the same task ids/prompts as the default", async () => {
		const run = async (controls?: EfficiencyControls) => {
			const dispatched: DispatchTask[] = [];
			await orchestrator.dispatchReconAndLeads(
				{ ...reconLeadInput,
				  plan: { ...planFixture, topology: { ...planFixture.topology, leads: 2 } },
				  architectResult: twoIndependentLeads,
				  controls },
				{
					dispatch: async (tasks) => { dispatched.push(...tasks); return tasks.map((t) => dispatchResult(t)); },
					capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				},
			);
			return dispatched;
		};
		const withOff = await run(offControls);
		const withDefault = await run(undefined);
		expect(withOff.map((t) => t.taskId)).toEqual(withDefault.map((t) => t.taskId));
		expect(withOff.map((t) => t.task)).toEqual(withDefault.map((t) => t.task));
	});
});

describe("recon_before_architect", () => {
	const architectNeededPlan = { ...planFixture, complexity: 6, topology: { depth: 2, leads: 1, workers: 3, shape: "lead-workers" } };
	const belowThresholdPlan = { ...planFixture, complexity: 3, topology: { depth: 2, leads: 1, workers: 0, shape: "lead-workers" } };
	const onControls: EfficiencyControls = structuredClone(loadEfficiencyControls().controls);
	onControls.recon_before_architect.enabled = true;

	test("runs recon once, feeds the architect prompt, and dispatchReconAndLeads reuses it instead of re-dispatching", async () => {
		const reconDispatched: string[] = [];
		const captured: DispatchResult[] = [];
		const precomputed = await orchestrator.runParentOwnedRecon(
			{ runId: "run", goal: "repair flow", plan: architectNeededPlan },
			{
				dispatch: async (tasks) => { reconDispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async (r) => { captured.push(r); },
				setPhase: () => {}, throwIfCancelled: () => {},
			},
			"; dispatching architect",
		);
		expect(reconDispatched).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
		expect(captured).toHaveLength(3);
		expect(precomputed.reconEvidence).toContain("run-recon-0");

		const architectText = orchestrator.architectPrompt("repair flow", architectNeededPlan, onControls, precomputed.reconEvidence);
		expect(architectText).toContain("Recon evidence:");
		expect(architectText).toContain("run-recon-0");

		const leadDispatched: DispatchTask[] = [];
		await orchestrator.dispatchReconAndLeads(
			{ runId: "run", goal: "repair flow", plan: architectNeededPlan, adapter: adapterFixture, controls: onControls, precomputedRecon: precomputed },
			{
				dispatch: async (tasks) => { leadDispatched.push(...tasks); return tasks.map((t) => dispatchResult(t)); },
				capture: async (r) => { captured.push(r); },
				setPhase: () => {}, throwIfCancelled: () => {},
			},
		);
		// Only the lead was dispatched here; recon was NOT dispatched a second time.
		expect(leadDispatched.map((t) => t.taskId)).toEqual(["run-lead-0"]);
		expect(reconDispatched).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
		// Billed exactly once: 3 recon captures + 1 lead capture, no duplicates.
		expect(captured.map((r) => r.taskId).sort()).toEqual(["run-lead-0", "run-recon-0", "run-recon-1", "run-recon-2"].sort());
	});

	test("below-threshold task dispatches no recon fan-out even with the switch on", async () => {
		const dispatched: string[] = [];
		const result = await orchestrator.runParentOwnedRecon(
			{ runId: "run", goal: "small fix", plan: belowThresholdPlan },
			{
				dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
			},
		);
		expect(dispatched).toEqual([]);
		expect(result.reconTasks).toEqual([]);
		expect(result.reconEvidence).toBe("");
		expect(result.unavailableReason).toContain("below the Rule-2 threshold");
	});

	test("cancellation between recon and architect: recon is billed but nothing further is dispatched", async () => {
		const cancellation = new RunCancellation();
		const dispatched: string[] = [];
		const captured: DispatchResult[] = [];
		const run = orchestrator.runParentOwnedRecon(
			{ runId: "run", goal: "repair flow", plan: architectNeededPlan },
			{
				dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async (r) => { captured.push(r); cancellation.cancel(); },
				setPhase: () => {}, throwIfCancelled: () => cancellation.throwIfCancelled(),
			},
			"; dispatching architect",
		);
		const err = await rejectionOf(run, 2_000, "cancel between recon and architect");
		expect(err.message).toBe("Orchestration cancelled");
		// Every recon worker that finished is billed exactly once.
		expect(captured).toHaveLength(3);
		// Nothing past recon (an architect dispatch, or a lead dispatch) ever happens:
		// the caller (dispatchHierarchical) never gets past the rejected promise.
		expect(dispatched).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
	});

	test("when no architect is needed, behaviour is unchanged regardless of the switch", async () => {
		const singleLeadNoArchitect = { ...planFixture, complexity: 2, topology: { depth: 1, leads: 1, workers: 0, shape: "lead-only" } };
		const run = async (controls?: EfficiencyControls) => {
			const dispatched: string[] = [];
			await orchestrator.dispatchReconAndLeads(
				{ runId: "run", goal: "g", plan: singleLeadNoArchitect, adapter: adapterFixture, controls },
				{
					dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
					capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				},
			);
			return dispatched;
		};
		expect(await run(onControls)).toEqual(await run(offControlsFixture()));
	});
});

describe("dispatchHierarchical: recon -> architect -> leads sequencing (test seam via deps)", () => {
	// Item 8: exercises the recon_before_architect switch's ordering, recon-billed-once,
	// and cancellation-stops-everything-further contract at the `dispatchHierarchical`
	// level itself (not just `dispatchReconAndLeads`), plus the off-default ordering
	// (architect -> recon -> leads), using the `deps` test seam added for this purpose.
	// `deps` is never supplied by production code; every field there defaults to exactly
	// today's real wiring (see dispatchHierarchical's parameter doc comment).
	const architectNeededPlan = { ...planFixture, complexity: 6, topology: { depth: 2, leads: 1, workers: 3, shape: "lead-workers" } };
	const fakeCtx = { ui: { notify: () => {} } } as unknown as Parameters<typeof orchestrator.dispatchHierarchical>[6];

	test("recon_before_architect on: recon is billed exactly once, feeds the architect prompt, then a lead runs", async () => {
		const onControls: EfficiencyControls = structuredClone(loadEfficiencyControls().controls);
		onControls.recon_before_architect.enabled = true;
		const dispatched: string[] = [];
		const billed: string[] = [];
		const architectPrompts: string[] = [];
		const dispatch = async (tasks: DispatchTask[]) => {
			dispatched.push(...tasks.map((t) => t.taskId));
			return tasks.map((t) => {
				if (t.capability === "architect") architectPrompts.push(t.task);
				return dispatchResult(t);
			});
		};
		const result = await orchestrator.dispatchHierarchical(
			process.cwd(), "run", "plan-1", "repair flow", architectNeededPlan, adapterFixture, fakeCtx, "lead", onControls,
			{
				dispatch, capture: async (r) => { billed.push(r.taskId); },
				setPhase: () => {}, throwIfCancelled: () => {},
				gitHead: () => "head1", treeSnapshot: () => new Map(),
			},
		);
		expect(dispatched).toEqual(["run-recon-0", "run-recon-1", "run-recon-2", "run-architect", "run-lead-0"]);
		expect(billed).toEqual(dispatched);
		expect(new Set(billed).size).toBe(billed.length);
		expect(architectPrompts[0]).toContain("Recon evidence:");
		expect(architectPrompts[0]).toContain("run-recon-0");
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
	});

	test("recon_before_architect on: cancellation right after recon dispatches nothing further (no architect, no lead)", async () => {
		const onControls: EfficiencyControls = structuredClone(loadEfficiencyControls().controls);
		onControls.recon_before_architect.enabled = true;
		const cancellation = new RunCancellation();
		const dispatched: string[] = [];
		const dispatch = async (tasks: DispatchTask[]) => { dispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); };
		const run = orchestrator.dispatchHierarchical(
			process.cwd(), "run", "plan-1", "repair flow", architectNeededPlan, adapterFixture, fakeCtx, "lead", onControls,
			{
				dispatch, capture: async () => { cancellation.cancel(); },
				setPhase: () => {}, throwIfCancelled: () => cancellation.throwIfCancelled(),
				gitHead: () => "head1", treeSnapshot: () => new Map(),
			},
		);
		const err = await rejectionOf(run, 2_000, "cancel after recon in dispatchHierarchical");
		expect(err.message).toBe("Orchestration cancelled");
		expect(dispatched).toEqual(["run-recon-0", "run-recon-1", "run-recon-2"]);
	});

	test("controls off (default): architect is dispatched before recon, matching today's ordering", async () => {
		const dispatched: string[] = [];
		const dispatch = async (tasks: DispatchTask[]) => { dispatched.push(...tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); };
		await orchestrator.dispatchHierarchical(
			process.cwd(), "run", "plan-1", "repair flow", architectNeededPlan, adapterFixture, fakeCtx, "lead", loadEfficiencyControls().controls,
			{
				dispatch, capture: async () => {},
				setPhase: () => {}, throwIfCancelled: () => {},
				gitHead: () => "head1", treeSnapshot: () => new Map(),
			},
		);
		expect(dispatched).toEqual(["run-architect", "run-recon-0", "run-recon-1", "run-recon-2", "run-lead-0"]);
	});
});

function offControlsFixture(): EfficiencyControls {
	return loadEfficiencyControls().controls;
}

describe("delegation_guidance", () => {
	const onControls: EfficiencyControls = structuredClone(loadEfficiencyControls().controls);
	onControls.delegation_guidance.enabled = true;
	const multiLeadPlan = { ...planFixture, complexity: 8, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } };

	test("architect prompt carries own-tool-budget guidance only when enabled", () => {
		const on = orchestrator.architectPrompt("g", multiLeadPlan, onControls);
		const off = orchestrator.architectPrompt("g", multiLeadPlan);
		expect(on).toContain("Delegation guidance");
		expect(on).toContain("own-tool budget of about 12 tool calls");
		expect(on).toContain("orch-scout");
		expect(off).not.toContain("Delegation guidance");
	});

	test("lead prompt carries own-tool-budget guidance only when enabled, and is never killed for exceeding it", () => {
		const on = orchestrator.leadPrompt("g", planFixture, undefined, "", 0, 1, adapterFixture, undefined, onControls);
		const off = orchestrator.leadPrompt("g", planFixture, undefined, "", 0, 1, adapterFixture);
		expect(on).toContain("Delegation guidance");
		expect(on).toContain("own-tool budget of about 25 tool calls");
		expect(on).toContain("never killed or blocked for exceeding it");
		expect(on).toContain("orch-worker");
		expect(off).not.toContain("Delegation guidance");
	});
});

describe("event_waiting_guidance", () => {
	const onControls: EfficiencyControls = structuredClone(loadEfficiencyControls().controls);
	onControls.event_waiting_guidance.enabled = true;

	test("lead and architect prompts carry the waiting guidance only when enabled", () => {
		const leadOn = orchestrator.leadPrompt("g", planFixture, undefined, "", 0, 1, adapterFixture, undefined, onControls);
		const leadOff = orchestrator.leadPrompt("g", planFixture, undefined, "", 0, 1, adapterFixture);
		expect(leadOn).toContain("block until completion");
		expect(leadOn).toContain("Do not `sleep`");
		expect(leadOn).not.toMatch(/setTimeout|setInterval/);
		expect(leadOff).not.toContain("block until completion");

		const architectOn = orchestrator.architectPrompt("g", planFixture, onControls);
		expect(architectOn).toContain("block until completion");
		expect(orchestrator.architectPrompt("g", planFixture)).not.toContain("block until completion");
	});
});

describe("file_ownership", () => {
	const twoOwnedLeadsOverlap = {
		taskId: "run-architect", capability: "architect", model: "m", exitCode: 0, stderr: "",
		stdout: "## Lead assignments\nLead 1: backend (depends on: none) (owns: src/shared.ts, src/a.ts)\nLead 2: frontend (depends on: none) (owns: src/shared.ts, src/b.ts)\n",
		usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
	} as DispatchResult;
	const twoOwnedLeadsDisjoint = {
		...twoOwnedLeadsOverlap,
		stdout: "## Lead assignments\nLead 1: backend (depends on: none) (owns: src/a.ts)\nLead 2: frontend (depends on: none) (owns: src/b.ts)\n",
	} as DispatchResult;
	const oneUndeclaredLead = {
		...twoOwnedLeadsOverlap,
		stdout: "## Lead assignments\nLead 1: backend (depends on: none) (owns: src/a.ts)\nLead 2: frontend (depends on: none)\n",
	} as DispatchResult;
	const twoLeadPlan = { ...planFixture, complexity: 2, topology: { ...planFixture.topology, leads: 2 } };
	const unsafeOwnedLead = {
		...twoOwnedLeadsOverlap,
		stdout: "## Lead assignments\nLead 1: backend (depends on: none) (owns: /etc/passwd)\nLead 2: frontend (depends on: none) (owns: src/b.ts)\n",
	} as DispatchResult;

	function controlsWithMode(mode: "off" | "report" | "serialize"): EfficiencyControls {
		const c = structuredClone(loadEfficiencyControls().controls);
		c.file_ownership.mode = mode;
		return c;
	}

	test("architect prompt asks for (owns: ...) only when mode != off", () => {
		const multiLeadPlan = { ...planFixture, complexity: 8, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } };
		expect(orchestrator.architectPrompt("g", multiLeadPlan, controlsWithMode("report"))).toContain("(owns: path, ...)");
		expect(orchestrator.architectPrompt("g", multiLeadPlan, controlsWithMode("serialize"))).toContain("(owns: path, ...)");
		expect(orchestrator.architectPrompt("g", multiLeadPlan, controlsWithMode("off"))).not.toContain("(owns:");
	});

	test("off: waves unchanged, no ownership evidence emitted", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const dispatched: string[][] = [];
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: twoOwnedLeadsOverlap, controls: controlsWithMode("off") },
			{
				dispatch: async (tasks) => { dispatched.push(tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				recordEvent: (e, p) => { events.push([e, p]); },
			},
		);
		expect(dispatched).toEqual([["run-lead-0", "run-lead-1"]]);
		expect(events.filter(([e]) => e === "lead_ownership")).toEqual([]);
	});

	test("report: waves unchanged, but overlap evidence is emitted per row", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const dispatched: string[][] = [];
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: twoOwnedLeadsOverlap, controls: controlsWithMode("report") },
			{
				dispatch: async (tasks) => { dispatched.push(tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				recordEvent: (e, p) => { events.push([e, p]); },
			},
		);
		expect(dispatched).toEqual([["run-lead-0", "run-lead-1"]]);
		const ownershipEvents = events.filter(([e]) => e === "lead_ownership");
		expect(ownershipEvents).toHaveLength(1);
		expect(ownershipEvents[0][1]).toMatchObject({ run_id: "run", kind: "ownership_overlap", a: 0, b: 1 });
	});

	test("report: an unsafe declared path is surfaced as its own lead_ownership evidence row", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: unsafeOwnedLead, controls: controlsWithMode("report") },
			{
				dispatch: async (tasks) => tasks.map((t) => dispatchResult(t)),
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				recordEvent: (e, p) => { events.push([e, p]); },
			},
		);
		const unsafeEvents = events.filter(([e, p]) => e === "lead_ownership" && p.kind === "ownership_unsafe_path");
		expect(unsafeEvents).toHaveLength(1);
		expect(unsafeEvents[0][1]).toMatchObject({ run_id: "run", lead: 0 });
	});

	test("serialize: overlapping leads are split into separate waves, evidence emitted", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const dispatched: string[][] = [];
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: twoOwnedLeadsOverlap, controls: controlsWithMode("serialize") },
			{
				dispatch: async (tasks) => { dispatched.push(tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				recordEvent: (e, p) => { events.push([e, p]); },
			},
		);
		expect(dispatched).toEqual([["run-lead-0"], ["run-lead-1"]]);
		const ownershipEvents = events.filter(([e]) => e === "lead_ownership");
		expect(ownershipEvents.some(([, p]) => p.kind === "ownership_serialized")).toBe(true);
	});

	test("serialize: disjoint declared ownership is left in one wave", async () => {
		const dispatched: string[][] = [];
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: twoOwnedLeadsDisjoint, controls: controlsWithMode("serialize") },
			{
				dispatch: async (tasks) => { dispatched.push(tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
			},
		);
		expect(dispatched).toEqual([["run-lead-0", "run-lead-1"]]);
	});

	test("serialize: undeclared ownership always runs alone, never sharing a wave", async () => {
		const dispatched: string[][] = [];
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: oneUndeclaredLead, controls: controlsWithMode("serialize") },
			{
				dispatch: async (tasks) => { dispatched.push(tasks.map((t) => t.taskId)); return tasks.map((t) => dispatchResult(t)); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
			},
		);
		expect(dispatched).toEqual([["run-lead-0"], ["run-lead-1"]]);
	});

	test("conflict events are emitted only for real file overlaps observed after leads finish", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const withFiles = (t: DispatchTask, files: string[]): DispatchResult => ({ ...dispatchResult(t), filesChanged: files });
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: twoOwnedLeadsDisjoint, controls: controlsWithMode("report") },
			{
				dispatch: async (tasks) => tasks.map((t) => withFiles(t, t.taskId === "run-lead-0" ? ["src/a.ts", "src/shared.ts"] : ["src/b.ts", "src/shared.ts"])),
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				recordEvent: (e, p) => { events.push([e, p]); },
			},
		);
		const conflicts = events.filter(([e]) => e === "lead_edit_conflict");
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0][1]).toMatchObject({ run_id: "run", file: "src/shared.ts", leads: [0, 1] });
	});

	test("no conflict events when leads touch disjoint files", async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const withFiles = (t: DispatchTask, files: string[]): DispatchResult => ({ ...dispatchResult(t), filesChanged: files });
		await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: twoLeadPlan, architectResult: twoOwnedLeadsDisjoint, controls: controlsWithMode("report") },
			{
				dispatch: async (tasks) => tasks.map((t) => withFiles(t, t.taskId === "run-lead-0" ? ["src/a.ts"] : ["src/b.ts"])),
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
				recordEvent: (e, p) => { events.push([e, p]); },
			},
		);
		expect(events.filter(([e]) => e === "lead_edit_conflict")).toEqual([]);
	});

	test("lead prompt states owned paths and instructs passing ownerPaths, only when mode != off and paths are declared", () => {
		const assignment = { index: 0, scope: "backend", dependsOn: [], owns: ["src/a.ts", "src/b/**"] };
		const on = orchestrator.leadPrompt("g", twoLeadPlan, undefined, "", 0, 2, adapterFixture, assignment, controlsWithMode("report"));
		const off = orchestrator.leadPrompt("g", twoLeadPlan, undefined, "", 0, 2, adapterFixture, assignment, controlsWithMode("off"));
		const noOwns = orchestrator.leadPrompt("g", twoLeadPlan, undefined, "", 0, 2, adapterFixture, { index: 0, scope: "backend", dependsOn: [] }, controlsWithMode("report"));
		expect(on).toContain("File ownership");
		expect(on).toContain("src/a.ts");
		expect(on).toContain("ownerPaths");
		expect(off).not.toContain("File ownership");
		expect(noOwns).not.toContain("File ownership");
	});
});

describe("scoped_leads", () => {
	const scopedLeadPlan = { ...planFixture, complexity: 2, risk: "low" as const, topology: { depth: 2, leads: 1, workers: 0, shape: "lead-workers" } };
	const twoLeadChainPlan = { ...planFixture, complexity: 4, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } };
	const chainArchitect = {
		taskId: "run-architect", capability: "architect", model: "m", exitCode: 0, stderr: "",
		stdout: "## Lead assignments\nLead 1: backend (depends on: none)\nLead 2: frontend (depends on: 1)\n",
		usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
	} as DispatchResult;

	function scopedControls(): EfficiencyControls {
		const c = structuredClone(loadEfficiencyControls().controls);
		c.scoped_leads.enabled = true;
		return c;
	}

	function leadHandoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			schema_version: 1,
			phase: "plan",
			run_id: "run",
			lead_task_id: "run-lead-0",
			base_revision: "head1",
			decisions: [{ decision: "use approach A", rationale: "fits constraints" }],
			constraints: ["no new deps"],
			file_ownership: {},
			work: [{ task_id: "w1", summary: "did the plan", result: "planned approach A" }],
			unresolved_risks: ["risk: edge case X unhandled"],
			verification: [],
			artifacts: [],
			...overrides,
		};
	}

	function handoffStdout(overrides: Record<string, unknown> = {}): string {
		return `report body\n\n## Handoff\n\`\`\`json\n${JSON.stringify(leadHandoff(overrides))}\n\`\`\`\n`;
	}

	function scopedDispatchResult(taskId: string, stdout: string, over: Partial<DispatchResult> = {}): DispatchResult {
		return {
			taskId, capability: "lead", model: "provider/model", exitCode: 0, stdout, stderr: "",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
			durationMs: 1, costUsd: 0.01, costReported: true, filesChanged: [],
			...over,
		};
	}

	async function runScopedDispatch(opts: {
		controls: EfficiencyControls;
		respond: (taskId: string) => DispatchResult;
		gitHead?: () => string | null;
		/** Bridge-observed dirty-tree fingerprint effect (see `gitDirtySnapshot`). Defaults to a
		 *  stable empty snapshot every call (an "unchanged tree" — matches the intent of every
		 *  test written before the freshness gate existed). Pass `treeSnapshot: undefined`
		 *  explicitly to simulate the effect never being wired (an unknown tree state). */
		treeSnapshot?: (() => Map<string, string> | null) | undefined;
		plan?: typeof planFixture;
		architectResult?: DispatchResult;
	}) {
		const dispatched: DispatchTask[] = [];
		const batches: string[][] = [];
		const billed: DispatchResult[] = [];
		const events: Array<[string, Record<string, unknown>]> = [];
		const result = await orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: opts.plan ?? scopedLeadPlan, controls: opts.controls, architectResult: opts.architectResult },
			{
				dispatch: async (tasks) => { batches.push(tasks.map((t) => t.taskId)); dispatched.push(...tasks); return tasks.map((t) => opts.respond(t.taskId)); },
				capture: async (r) => { billed.push(r); },
				setPhase: () => {}, throwIfCancelled: () => {},
				recordEvent: (e, p) => { events.push([e, p]); },
				gitHead: opts.gitHead,
				treeSnapshot: "treeSnapshot" in opts ? opts.treeSnapshot : () => new Map(),
			},
		);
		return { dispatched, batches, billed, events, result };
	}

	test("off: dispatches the single long-lived lead task, no phases", async () => {
		const { batches, result } = await runScopedDispatch({
			controls: loadEfficiencyControls().controls,
			respond: (taskId) => scopedDispatchResult(taskId, "report\nSTATUS: completed"),
		});
		expect(batches).toEqual([["run-lead-0"]]);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		expect(result.scopedLeadPhaseResults).toEqual([]);
	});

	test("on: valid handoffs run plan -> integrate -> report, forwarding the bounded handoff with its decisions and unresolved risks", async () => {
		const { batches, dispatched, billed, events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, handoffStdout({
					phase: "integrate", base_revision: "head1",
					decisions: [{ decision: "integrated approach A", rationale: "matches plan" }],
				}));
				if (taskId === "run-lead-0-report") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(batches).toEqual([["run-lead-0-plan"], ["run-lead-0-integrate"], ["run-lead-0-report"]]);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0-report"]);
		expect(result.scopedLeadPhaseResults.map((r) => r.taskId)).toEqual(["run-lead-0-plan", "run-lead-0-integrate"]);
		const integrateTask = dispatched.find((t) => t.taskId === "run-lead-0-integrate")!;
		expect(integrateTask.phase).toBe("integrate");
		expect(integrateTask.task).toContain("use approach A");
		expect(integrateTask.task).toContain("risk: edge case X unhandled");
		// Item 4: the report phase forwards the bounded INTEGRATE handoff (not the plan one).
		const reportTask = dispatched.find((t) => t.taskId === "run-lead-0-report")!;
		expect(reportTask.phase).toBe("report");
		expect(reportTask.task).toContain("Prior handoff:");
		expect(reportTask.task).toContain("integrated approach A");
		expect(billed.map((r) => r.taskId)).toEqual(["run-lead-0-plan", "run-lead-0-integrate", "run-lead-0-report"]);
		expect(events.filter(([e]) => e === "scoped_lead_fallback")).toEqual([]);
		const planEvent = events.find(([e, p]) => e === "scoped_lead_phase" && p.phase === "plan");
		expect(planEvent?.[1]).toMatchObject({ run_id: "run", lead_task_id: "run-lead-0", handoff_valid: true, stale: false, truncated: false });
		const integrateEvent = events.find(([e, p]) => e === "scoped_lead_phase" && p.phase === "integrate");
		expect(integrateEvent?.[1]).toMatchObject({ handoff_valid: true, stale: false });
	});

	test("invalid plan handoff falls back to the ordinary long-lived lead, and the already-captured plan phase is still billed", async () => {
		const { batches, events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, "report with no handoff section\nSTATUS: completed");
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(batches).toEqual([["run-lead-0-plan"], ["run-lead-0"]]);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		// BLOCKER fix: the plan phase was already captured before the fallback dispatch
		// happened, so it must still show up in `scopedLeadPhaseResults` for billing.
		expect(result.scopedLeadPhaseResults.map((r) => r.taskId)).toEqual(["run-lead-0-plan"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1]).toMatchObject({ run_id: "run", lead_task_id: "run-lead-0", phase: "plan" });
	});

	test("plan handoff whose base_revision doesn't match the current head falls back (stale)", async () => {
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head-now",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head-old" }));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason as string).toContain("base_revision");
	});

	test("no gitHead effect (unknown current head) always falls back", async () => {
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout());
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason as string).toContain("unknown");
	});

	test("invalid integrate handoff: the integrate result stands, no report is dispatched", async () => {
		const { batches, events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, "no handoff here\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(batches).toEqual([["run-lead-0-plan"], ["run-lead-0-integrate"]]);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0-integrate"]);
		expect(result.scopedLeadPhaseResults.map((r) => r.taskId)).toEqual(["run-lead-0-plan"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1]).toMatchObject({ phase: "integrate" });
	});

	test("plan failure is a lead failure exactly like today; dependent leads are skipped", async () => {
		const { batches, result } = await runScopedDispatch({
			controls: scopedControls(),
			plan: twoLeadChainPlan,
			architectResult: chainArchitect,
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, "boom", { exitCode: 1, stderr: "boom" });
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(batches).toEqual([["run-lead-0-plan"]]);
		expect(result.leadResults).toHaveLength(1);
		expect(result.leadResults[0].exitCode).toBe(1);
		expect(result.skippedLeads).toBe(1);
	});

	test("cancellation after the plan phase bills the plan but dispatches nothing further", async () => {
		const cancellation = new RunCancellation();
		const dispatched: DispatchTask[] = [];
		const billed: DispatchResult[] = [];
		const run = orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan: scopedLeadPlan, controls: scopedControls() },
			{
				dispatch: async (tasks) => { dispatched.push(...tasks); return tasks.map((t) => scopedDispatchResult(t.taskId, handoffStdout({ base_revision: "head1" }))); },
				capture: async (r) => { billed.push(r); cancellation.cancel(); },
				setPhase: () => {}, throwIfCancelled: () => cancellation.throwIfCancelled(),
				gitHead: () => "head1",
				treeSnapshot: () => new Map(),
			},
		);
		expect((await rejectionOf(run, 2_000, "cancel between scoped phases")).message).toBe("Orchestration cancelled");
		expect(dispatched.map((t) => t.taskId)).toEqual(["run-lead-0-plan"]);
		expect(billed.map((r) => r.taskId)).toEqual(["run-lead-0-plan"]);
	});

	test("an oversized handoff is bounded before being forwarded to the integrate prompt", async () => {
		const controls = scopedControls();
		// Large enough that shrinking `work[].summary`/`result` alone brings the handoff
		// within budget (see the dedicated `handoff_over_budget` test for the case where
		// even a fully shrunk handoff can't fit).
		controls.scoped_leads.max_handoff_chars = 600;
		const { dispatched, events } = await runScopedDispatch({
			controls,
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") {
					return scopedDispatchResult(taskId, handoffStdout({
						base_revision: "head1",
						work: [{ task_id: "w1", summary: "s".repeat(50), result: "x".repeat(2000) }],
						artifacts: [{ ref: "run-lead-0-plan.stdout.log", description: "full plan output" }],
					}));
				}
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, handoffStdout({ phase: "integrate", base_revision: "head1" }));
				if (taskId === "run-lead-0-report") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		const integrateTask = dispatched.find((t) => t.taskId === "run-lead-0-integrate")!;
		expect(integrateTask.task).toContain("truncated");
		const planEvent = events.find(([e, p]) => e === "scoped_lead_phase" && p.phase === "plan");
		expect(planEvent?.[1].truncated).toBe(true);
	});

	test("bounding: a handoff still over budget after shrinking falls back with a fixed reason code instead of forwarding it", async () => {
		const controls = scopedControls();
		controls.scoped_leads.max_handoff_chars = 10;
		const { batches, events, result } = await runScopedDispatch({
			controls,
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(batches).toEqual([["run-lead-0-plan"], ["run-lead-0"]]);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		expect(result.scopedLeadPhaseResults.map((r) => r.taskId)).toEqual(["run-lead-0-plan"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1]).toMatchObject({ phase: "plan", reason: "handoff_over_budget" });
	});

	test("bounding: an over-budget integrate handoff stands as final, no report dispatched", async () => {
		const controls = scopedControls();
		controls.scoped_leads.max_handoff_chars = 2000;
		// `decisions` is never shrunk by `boundHandoff` (only `work[].summary`/`result` are),
		// so a large-but-otherwise-valid `decisions` array reliably stays over budget even
		// after the shrink loop maxes out.
		const bigDecisions = Array.from({ length: 20 }, (_, i) => ({
			decision: `decision number ${i} `.padEnd(150, "x"),
			rationale: `rationale number ${i} `.padEnd(150, "y"),
		}));
		const { batches, events, result } = await runScopedDispatch({
			controls,
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, handoffStdout({
					phase: "integrate", base_revision: "head1", decisions: bigDecisions,
				}));
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(batches).toEqual([["run-lead-0-plan"], ["run-lead-0-integrate"]]);
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0-integrate"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1]).toMatchObject({ phase: "integrate", reason: "handoff_over_budget" });
	});

	test("every phase is billed exactly once and collectBilledResults includes each without double-counting", async () => {
		const { billed, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, handoffStdout({ phase: "integrate", base_revision: "head1" }));
				if (taskId === "run-lead-0-report") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(new Set(billed.map((r) => r.taskId)).size).toBe(billed.length);
		expect(billed).toHaveLength(3);
		const billedResults = orchestrator.collectBilledResults({
			workerResults: [], leadResults: result.leadResults, verificationResults: [], escalationResults: [],
			scopedLeadPhaseResults: result.scopedLeadPhaseResults,
		});
		expect(billedResults.map((r) => r.taskId).sort()).toEqual(["run-lead-0-integrate", "run-lead-0-plan", "run-lead-0-report"].sort());
		expect(new Set(billedResults.map((r) => r.taskId)).size).toBe(billedResults.length);
	});

	test("BLOCKER: plan-fallback bills the already-captured plan phase exactly once via collectBilledResults", async () => {
		const { result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, "no handoff section\nSTATUS: completed");
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		expect(result.scopedLeadPhaseResults.map((r) => r.taskId)).toEqual(["run-lead-0-plan"]);
		const billedResults = orchestrator.collectBilledResults({
			workerResults: [], leadResults: result.leadResults, verificationResults: [], escalationResults: [],
			scopedLeadPhaseResults: result.scopedLeadPhaseResults,
		});
		expect(billedResults.map((r) => r.taskId).sort()).toEqual(["run-lead-0", "run-lead-0-plan"]);
		expect(new Set(billedResults.map((r) => r.taskId)).size).toBe(billedResults.length);
		expect(billedResults.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(0.02);
	});

	test("BLOCKER: integrate-fallback bills plan and integrate exactly once via collectBilledResults, no report billed", async () => {
		const { result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, "no handoff here\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0-integrate"]);
		expect(result.scopedLeadPhaseResults.map((r) => r.taskId)).toEqual(["run-lead-0-plan"]);
		const billedResults = orchestrator.collectBilledResults({
			workerResults: [], leadResults: result.leadResults, verificationResults: [], escalationResults: [],
			scopedLeadPhaseResults: result.scopedLeadPhaseResults,
		});
		expect(billedResults.map((r) => r.taskId).sort()).toEqual(["run-lead-0-integrate", "run-lead-0-plan"]);
		expect(new Set(billedResults.map((r) => r.taskId)).size).toBe(billedResults.length);
		expect(billedResults.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(0.02);
	});

	test("freshness: a relevant file changed between plan and integrate falls back (stale:tree_changed)", async () => {
		let call = 0;
		const snapshots = [new Map([["src/a.ts", "hash1"]]), new Map([["src/a.ts", "hash2"]])];
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			treeSnapshot: () => snapshots[Math.min(call++, snapshots.length - 1)],
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({
					base_revision: "head1", file_ownership: { "src/a.ts": ["owner"] },
				}));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason).toBe("stale:tree_changed");
	});

	test("freshness: an unchanged relevant file between plan and integrate does not force a fallback", async () => {
		const snapshot = new Map([["src/a.ts", "hash1"]]);
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			treeSnapshot: () => snapshot,
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({
					base_revision: "head1", file_ownership: { "src/a.ts": ["owner"] },
				}));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, handoffStdout({ phase: "integrate", base_revision: "head1" }));
				if (taskId === "run-lead-0-report") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0-report"]);
		expect(events.filter(([e]) => e === "scoped_lead_fallback")).toEqual([]);
	});

	test("freshness: no treeSnapshot effect (unknown tree state) falls back even with a fresh, valid plan handoff", async () => {
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			treeSnapshot: undefined,
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason).toBe("stale:tree_unknown");
	});

	test("freshness: a glob scope (src/**) detects a change to a file it covers", async () => {
		let call = 0;
		const snapshots = [new Map([["src/a.ts", "hash1"]]), new Map([["src/a.ts", "hash2"]])];
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			treeSnapshot: () => snapshots[Math.min(call++, snapshots.length - 1)],
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({
					base_revision: "head1", file_ownership: { "src/**": ["owner"] },
				}));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason).toBe("stale:tree_changed");
	});

	test("freshness: a directory scope (src/) detects a change to a file inside it", async () => {
		let call = 0;
		const snapshots = [new Map([["src/a.ts", "hash1"]]), new Map([["src/a.ts", "hash2"]])];
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			treeSnapshot: () => snapshots[Math.min(call++, snapshots.length - 1)],
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({
					base_revision: "head1", file_ownership: { "src/": ["owner"] },
				}));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason).toBe("stale:tree_changed");
	});

	test("freshness: a change to a file outside every declared scope is ignored (no fallback)", async () => {
		let call = 0;
		const snapshots = [
			new Map([["src/a.ts", "hash1"], ["other/file.ts", "o1"]]),
			new Map([["src/a.ts", "hash1"], ["other/file.ts", "o2"]]),
		];
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			treeSnapshot: () => snapshots[Math.min(call++, snapshots.length - 1)],
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({
					base_revision: "head1", file_ownership: { "src/a.ts": ["owner"] },
				}));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, handoffStdout({ phase: "integrate", base_revision: "head1" }));
				if (taskId === "run-lead-0-report") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0-report"]);
		expect(events.filter(([e]) => e === "scoped_lead_fallback")).toEqual([]);
	});

	function rawHandoffStdout(raw: Record<string, unknown>): string {
		return `report body\n\n## Handoff\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`\n`;
	}

	test.each([
		["empty object", {}],
		["wrong-typed file_ownership", { file_ownership: 5 }],
		["wrong-typed work", { work: "x" }],
	])("malformed plan handoff (%s) falls back instead of throwing", async (_label, raw) => {
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, rawHandoffStdout(raw as Record<string, unknown>));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1]).toMatchObject({ phase: "plan" });
		expect((fallback?.[1].reason as string)).toMatch(/^handoff_invalid:/);
	});

	test.each([
		["empty object", {}],
		["wrong-typed file_ownership", { file_ownership: 5 }],
		["wrong-typed work", { work: "x" }],
	])("malformed integrate handoff (%s) falls back (integrate result stands) instead of throwing", async (_label, raw) => {
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }));
				if (taskId === "run-lead-0-integrate") return scopedDispatchResult(taskId, rawHandoffStdout(raw as Record<string, unknown>));
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0-integrate"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1]).toMatchObject({ phase: "integrate" });
		expect((fallback?.[1].reason as string)).toMatch(/^handoff_invalid:/);
	});

	test("concurrency: a sibling chain's cancellation stops OTHER chains from starting a further phase, but not before their own in-flight phase finishes and is billed", async () => {
		const plan = { ...planFixture, complexity: 4, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } };
		const cancellation = new RunCancellation();
		const dispatched: string[] = [];
		const billed: string[] = [];
		let resolveIntegrate1: ((r: DispatchResult) => void) | undefined;
		const dispatch = async (tasks: DispatchTask[]) => Promise.all(tasks.map((t) => {
			dispatched.push(t.taskId);
			if (t.taskId === "run-lead-1-integrate") {
				return new Promise<DispatchResult>((resolve) => { resolveIntegrate1 = resolve; });
			}
			if (t.taskId === "run-lead-0-plan") {
				return Promise.resolve(scopedDispatchResult(t.taskId, handoffStdout({ base_revision: "head1", lead_task_id: "run-lead-0" })));
			}
			if (t.taskId === "run-lead-1-plan") {
				return Promise.resolve(scopedDispatchResult(t.taskId, handoffStdout({ base_revision: "head1", lead_task_id: "run-lead-1" })));
			}
			if (t.taskId === "run-lead-0-integrate") {
				return Promise.resolve(scopedDispatchResult(t.taskId, "no handoff\nSTATUS: completed"));
			}
			return Promise.resolve(scopedDispatchResult(t.taskId, "report\nSTATUS: completed"));
		}));
		const run = orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan, controls: scopedControls(), architectResult: twoIndependentLeads },
			{
				dispatch,
				capture: async (r) => {
					billed.push(r.taskId);
					// Lead 0's integrate phase (invalid handoff -> fallback decision) is what
					// cancels the run, WHILE lead 1's own integrate dispatch is still in flight.
					if (r.taskId === "run-lead-0-integrate") cancellation.cancel();
				},
				setPhase: () => {}, throwIfCancelled: () => cancellation.throwIfCancelled(),
				gitHead: () => "head1", treeSnapshot: () => new Map(),
			},
		);
		// Wait for lead 1's integrate dispatch to be in flight (deferred, unresolved).
		for (let i = 0; i < 50 && !resolveIntegrate1; i++) await Promise.resolve();
		expect(resolveIntegrate1).toBeDefined();
		// Flush more microtasks: lead 0's chain has by now thrown (cancellation), but the
		// overall function must NOT have settled yet, because lead 1's in-flight dispatch
		// has not resolved.
		let settled = false;
		run.then(() => { settled = true; }, () => { settled = true; });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(settled).toBe(false);
		expect(dispatched).not.toContain("run-lead-1-report");
		// Now let lead 1's integrate dispatch resolve. Its chain must still capture
		// (bill) that finished phase, then stop — no report phase is ever dispatched.
		resolveIntegrate1!(scopedDispatchResult("run-lead-1-integrate", handoffStdout({ phase: "integrate", base_revision: "head1", lead_task_id: "run-lead-1" })));
		const err = await rejectionOf(run, 2_000, "cancel while a sibling chain is in flight");
		expect(err.message).toBe("Orchestration cancelled");
		expect(billed).toContain("run-lead-1-integrate");
		expect(dispatched).not.toContain("run-lead-1-report");
	});

	test("telemetry: a hostile handoff never leaks into recorded events, and fallback reasons are bounded to 10 codes", async () => {
		const hostileHandoff = {
			schema_version: "SECRET_TOKEN_123",
			phase: "SECRET_TOKEN_123",
			run_id: 123,
			lead_task_id: 123,
			base_revision: 123,
			tested_revision: 123,
			decisions: "SECRET_TOKEN_123",
			constraints: "SECRET_TOKEN_123",
			file_ownership: "SECRET_TOKEN_123",
			work: "SECRET_TOKEN_123",
			unresolved_risks: "SECRET_TOKEN_123",
			verification: "SECRET_TOKEN_123",
			artifacts: "SECRET_TOKEN_123",
		};
		const stdout = `report body SECRET_TOKEN_123\n\n## Handoff\n\`\`\`json\n${JSON.stringify(hostileHandoff)}\n\`\`\`\n`;
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, stdout);
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		expect(JSON.stringify(events)).not.toContain("SECRET_TOKEN_123");
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason as string).toMatch(/^handoff_invalid:/);
		const reason = fallback?.[1].reason as string;
		const codes = reason.slice(reason.indexOf(":") + 1).split(",");
		// 13 fields are malformed above; the recorded reason must never grow unbounded.
		expect(codes.length).toBeLessThanOrEqual(11);
	});

	test("concurrency: two independent leads in the same wave run their plan phases concurrently, not one-at-a-time", async () => {
		const plan = { ...planFixture, complexity: 4, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } };
		const started: string[] = [];
		const planDeferred: Record<string, (r: DispatchResult) => void> = {};
		const dispatch = async (tasks: DispatchTask[]) => Promise.all(tasks.map((t) => {
			started.push(t.taskId);
			if (t.taskId === "run-lead-0-plan" || t.taskId === "run-lead-1-plan") {
				return new Promise<DispatchResult>((resolve) => { planDeferred[t.taskId] = resolve; });
			}
			return Promise.resolve(scopedDispatchResult(t.taskId, "report\nSTATUS: completed"));
		}));
		const run = orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan, controls: scopedControls(), architectResult: twoIndependentLeads },
			{ dispatch, capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {}, gitHead: () => "head1", treeSnapshot: () => new Map() },
		);
		// Both leads' plan phases must already be in flight — a sequential
		// implementation would only have dispatched lead 0's plan at this point.
		// (`dispatchReconAndLeads` has several `await`s of already-resolved values
		// before it reaches the wave loop, so flush microtasks rather than assert
		// synchronously.)
		for (let i = 0; i < 50 && started.length < 2; i++) await Promise.resolve();
		expect(started).toEqual(["run-lead-0-plan", "run-lead-1-plan"]);
		planDeferred["run-lead-0-plan"](scopedDispatchResult("run-lead-0-plan", "no handoff\nSTATUS: completed"));
		planDeferred["run-lead-1-plan"](scopedDispatchResult("run-lead-1-plan", "no handoff\nSTATUS: completed"));
		const result = await run;
		expect(result.leadResults.map((r) => r.taskId).sort()).toEqual(["run-lead-0", "run-lead-1"]);
	});

	test("concurrency: billing-before-cancellation still holds for each lead's own chain when leads run concurrently", async () => {
		const plan = { ...planFixture, complexity: 4, topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" } };
		const cancellation = new RunCancellation();
		const billed: string[] = [];
		const dispatch = async (tasks: DispatchTask[]) => tasks.map((t) => scopedDispatchResult(t.taskId, "no handoff\nSTATUS: completed"));
		const run = orchestrator.dispatchReconAndLeads(
			{ ...reconLeadInput, plan, controls: scopedControls(), architectResult: twoIndependentLeads },
			{
				dispatch,
				capture: async (r) => {
					billed.push(r.taskId);
					// Cancel while lead 0's plan phase is being billed; lead 1's own
					// in-flight plan phase must still finish and be billed.
					if (r.taskId === "run-lead-0-plan") cancellation.cancel();
				},
				setPhase: () => {}, throwIfCancelled: () => cancellation.throwIfCancelled(),
				gitHead: () => "head1", treeSnapshot: () => new Map(),
			},
		);
		expect((await rejectionOf(run, 2_000, "cancel during concurrent scoped leads")).message).toBe("Orchestration cancelled");
		expect(billed).toContain("run-lead-0-plan");
		expect(billed).toContain("run-lead-1-plan");
		expect(new Set(billed).size).toBe(billed.length);
	});

	test("leadTasks keeps the original long-lived lead prompt regardless of which phase became the final result", async () => {
		const controls = scopedControls();
		const { result } = await runScopedDispatch({
			controls,
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, "no handoff");
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadTasks).toHaveLength(1);
		expect(result.leadTasks[0].taskId).toBe("run-lead-0");
		expect(result.leadTasks[0].task).toBe(
			orchestrator.leadPrompt("repair flow", scopedLeadPlan, undefined, "", 0, 1, adapterFixture, undefined, controls),
		);
	});

	test("QA-scope bypass fix: the final result's filesChanged is the union of plan + integrate + report, even though the report itself changed nothing", async () => {
		const { result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") {
					return scopedDispatchResult(taskId, handoffStdout({ base_revision: "head1" }), { filesChanged: ["src/auth.ts"] });
				}
				if (taskId === "run-lead-0-integrate") {
					return scopedDispatchResult(taskId, handoffStdout({ phase: "integrate", base_revision: "head1" }), {
						filesChanged: ["src/auth.ts", "src/session.ts"],
					});
				}
				if (taskId === "run-lead-0-report") {
					// The report phase itself made no NEW edits — its own "Files Changed" is empty —
					// but plan/integrate already changed real files in this same chain.
					return scopedDispatchResult(taskId, "## Files Changed\nNone\nSTATUS: completed", { filesChanged: [] });
				}
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults).toHaveLength(1);
		expect(result.leadResults[0].taskId).toBe("run-lead-0-report");
		expect([...result.leadResults[0].filesChanged].sort()).toEqual(["src/auth.ts", "src/session.ts"]);
		// The already-billed phase results themselves are never mutated (they still
		// report only what THEY individually changed).
		expect(result.scopedLeadPhaseResults.find((r) => r.taskId === "run-lead-0-plan")?.filesChanged).toEqual(["src/auth.ts"]);
		expect(result.scopedLeadPhaseResults.find((r) => r.taskId === "run-lead-0-integrate")?.filesChanged).toEqual(["src/auth.ts", "src/session.ts"]);
	});

	test("QA-scope bypass fix: a fallback-after-plan dispatch's result still carries the plan phase's own filesChanged", async () => {
		const { result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") {
					// No handoff -> invalid -> falls back after plan, but plan already edited a file.
					return scopedDispatchResult(taskId, "no handoff section\nSTATUS: completed", { filesChanged: ["src/partial.ts"] });
				}
				if (taskId === "run-lead-0") {
					return scopedDispatchResult(taskId, "## Files Changed\nNone\nSTATUS: completed", { filesChanged: [] });
				}
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults).toHaveLength(1);
		expect(result.leadResults[0].taskId).toBe("run-lead-0");
		expect(result.leadResults[0].filesChanged).toEqual(["src/partial.ts"]);
	});

	test("QA-scope computation path: externalChangeFiles no longer excludes files a scoped lead's report phase didn't mention", () => {
		// Exercises the ACTUAL QA-scope computation `qaScopeEvidenceFor` feeds into
		// `externalChangeFiles` (run-outcome.ts), reproducing the HIGH bug: a scoped
		// lead's final (report) result whose own prose says "Files Changed: None", but
		// whose plan phase's own report lists `src/auth.ts`, must not be classified as
		// "changed by someone else" and dropped from QA.
		const finalLeadResult = {
			exitCode: 0,
			stdout: "## Completed\nDone.\n## Files Changed\nNone\n## Verification\nn/a\nSTATUS: completed",
			filesChanged: ["src/auth.ts"],
			scopedPhaseReports: [
				{ phase: "plan", exitCode: 0, stdout: "## Files Changed\n- `src/auth.ts`\nSTATUS: completed" },
				{ phase: "report", exitCode: 0, stdout: "## Files Changed\nNone\nSTATUS: completed" },
			],
		};
		const ordinaryLeadResult = { exitCode: 0, stdout: finalLeadResult.stdout, filesChanged: [] };
		const evidence = orchestrator.qaScopeEvidenceFor([ordinaryLeadResult, finalLeadResult]);
		// Results without scoped phase reports pass through byte-identically.
		expect(evidence[0]).toEqual({ exitCode: 0, stdout: finalLeadResult.stdout });
		expect(externalChangeFiles(["src/auth.ts"], [evidence[0]!])).toEqual(["src/auth.ts"]);
		// Scoped reports determine classification regardless of the current switch state.
		expect(externalChangeFiles(["src/auth.ts"], [evidence[1]!])).toEqual([]);
	});

	test("QA-scope bypass fix: an unbackticked, extensionless path in a phase report (e.g. `Dockerfile`) is not dropped from QA scope just because the filesChanged union missed it", () => {
		// `parseFilesChanged` (index.ts) only recognizes backtick-quoted paths with a
		// known extension, so a report phase listing `- Dockerfile` contributes nothing
		// to `filesChanged`. Reparsing every phase's own stdout with `parseLeadFilesChanged`
		// (what `externalChangeFiles` itself uses) must still catch it.
		const lead = {
			exitCode: 0,
			stdout: "irrelevant — final phase stdout is not consulted for Files Changed here",
			filesChanged: [] as string[],
			scopedPhaseReports: [
				{ phase: "report", exitCode: 0, stdout: "## Files Changed\n- Dockerfile\nSTATUS: completed" },
			],
		};
		const evidence = orchestrator.qaScopeEvidenceFor([lead]);
		expect(externalChangeFiles(["Dockerfile"], evidence)).toEqual([]);
	});

	test("QA-scope bypass fix: an unbackticked plan-phase path (`- src/a.ts`) is kept in scope even though the report phase says None", () => {
		const lead = {
			exitCode: 0,
			stdout: "irrelevant",
			filesChanged: [] as string[],
			scopedPhaseReports: [
				{ phase: "plan", exitCode: 0, stdout: "## Files Changed\n- src/a.ts\nSTATUS: completed" },
				{ phase: "report", exitCode: 0, stdout: "## Files Changed\nNone\nSTATUS: completed" },
			],
		};
		const evidence = orchestrator.qaScopeEvidenceFor([lead]);
		expect(externalChangeFiles(["src/a.ts"], evidence)).toEqual([]);
	});

	test("QA-scope: every phase explicitly None, union empty, all exit 0 — external classification preserved exactly as before the fix", () => {
		const lead = {
			exitCode: 0,
			stdout: "irrelevant",
			filesChanged: [] as string[],
			scopedPhaseReports: [
				{ phase: "plan", exitCode: 0, stdout: "## Files Changed\nNone\nSTATUS: completed" },
				{ phase: "integrate", exitCode: 0, stdout: "## Files Changed\nNone\nSTATUS: completed" },
				{ phase: "report", exitCode: 0, stdout: "## Files Changed\nNone\nSTATUS: completed" },
			],
		};
		const evidence = orchestrator.qaScopeEvidenceFor([lead]);
		expect(externalChangeFiles(["src/unrelated.ts"], evidence)).toEqual(["src/unrelated.ts"]);
	});

	test("QA-scope: a phase report with no Files Changed section parses unknown, not none — not excluded from QA", () => {
		const lead = {
			exitCode: 0,
			stdout: "irrelevant",
			filesChanged: [] as string[],
			scopedPhaseReports: [
				{ phase: "plan", exitCode: 0, stdout: "No files changed section here.\nSTATUS: completed" },
				{ phase: "report", exitCode: 0, stdout: "## Files Changed\nNone\nSTATUS: completed" },
			],
		};
		const evidence = orchestrator.qaScopeEvidenceFor([lead]);
		expect(externalChangeFiles(["src/x.ts"], evidence)).toEqual([]);
	});

	test("QA-scope: a non-zero phase exit keeps the chain out of the 'all clean' external classification", () => {
		const lead = {
			exitCode: 0,
			stdout: "irrelevant",
			filesChanged: [] as string[],
			scopedPhaseReports: [
				{ phase: "plan", exitCode: 1, stdout: "## Files Changed\nNone\nSTATUS: blocked" },
				{ phase: "report", exitCode: 0, stdout: "## Files Changed\nNone\nSTATUS: completed" },
			],
		};
		const evidence = orchestrator.qaScopeEvidenceFor([lead]);
		expect(evidence[0]!.exitCode).not.toBe(0);
		expect(externalChangeFiles(["src/y.ts"], evidence)).toEqual([]);
	});

	test("QA-scope: scopedPhaseReports trigger scoped classification; absent reports pass through unchanged", () => {
		const lead = {
			exitCode: 0,
			stdout: "## Files Changed\nNone\nSTATUS: completed",
			filesChanged: ["src/auth.ts"],
			scopedPhaseReports: [
				{ phase: "plan", exitCode: 0, stdout: "## Files Changed\n- `src/auth.ts`" },
			],
		};
		const evidence = orchestrator.qaScopeEvidenceFor([lead]);
		expect(externalChangeFiles(["src/auth.ts"], evidence)).toEqual([]);
	});

	test("freshness: a symlink sentinel in the plan handoff's declared scope forces a fallback (stale:tree_unknown) even though the fingerprint didn't change", async () => {
		const snapshot = new Map([["src/link", "<non-file>"]]);
		const { events, result } = await runScopedDispatch({
			controls: scopedControls(),
			gitHead: () => "head1",
			treeSnapshot: () => snapshot,
			respond: (taskId) => {
				if (taskId === "run-lead-0-plan") return scopedDispatchResult(taskId, handoffStdout({
					base_revision: "head1", file_ownership: { "src/link": ["owner"] },
				}));
				if (taskId === "run-lead-0") return scopedDispatchResult(taskId, "report\nSTATUS: completed");
				throw new Error(`unexpected dispatch ${taskId}`);
			},
		});
		expect(result.leadResults.map((r) => r.taskId)).toEqual(["run-lead-0"]);
		const fallback = events.find(([e]) => e === "scoped_lead_fallback");
		expect(fallback?.[1].reason).toBe("stale:tree_unknown");
	});
});

describe("scoped_leads: treeUnchangedFor sentinel fingerprints", () => {
	const RELEVANT = ["src/link"];

	test("a symlink/non-file (<non-file>) fingerprint unchanged in a relevant key is unknown, not unchanged", () => {
		const before = new Map([["src/link", "<non-file>"]]);
		const after = new Map([["src/link", "<non-file>"]]);
		expect(orchestrator.treeUnchangedFor(before, after, RELEVANT)).toBeNull();
	});

	test("an unhashable (<unhashable>) fingerprint unchanged in a relevant key is unknown, not unchanged", () => {
		const before = new Map([["src/link", "<unhashable>"]]);
		const after = new Map([["src/link", "<unhashable>"]]);
		expect(orchestrator.treeUnchangedFor(before, after, RELEVANT)).toBeNull();
	});

	test("a sentinel fingerprint on an IRRELEVANT key does not force unknown", () => {
		const before = new Map([["src/link", "<non-file>"], ["src/a.ts", "hash1"]]);
		const after = new Map([["src/link", "<non-file>"], ["src/a.ts", "hash1"]]);
		expect(orchestrator.treeUnchangedFor(before, after, ["src/a.ts"])).toBe(true);
	});

	test("whole-tree mode (no declared scope): a sentinel fingerprint anywhere is unknown", () => {
		const before = new Map([["src/link", "<non-file>"]]);
		const after = new Map([["src/link", "<non-file>"]]);
		expect(orchestrator.treeUnchangedFor(before, after, [])).toBeNull();
	});

	test("a DELETED_FINGERPRINT stays comparable (a real state, not a sentinel)", () => {
		const before = new Map([["src/link", "<deleted>"]]);
		const after = new Map([["src/link", "<deleted>"]]);
		expect(orchestrator.treeUnchangedFor(before, after, RELEVANT)).toBe(true);
		const afterRecreated = new Map([["src/link", "hash1"]]);
		expect(orchestrator.treeUnchangedFor(before, afterRecreated, RELEVANT)).toBe(false);
	});

	test("a relevant key present only in `after` with a sentinel fingerprint is unknown", () => {
		const before = new Map<string, string>();
		const after = new Map([["src/link", "<unhashable>"]]);
		expect(orchestrator.treeUnchangedFor(before, after, RELEVANT)).toBeNull();
	});
});

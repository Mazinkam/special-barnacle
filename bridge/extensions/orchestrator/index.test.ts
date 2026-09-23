import { afterAll, describe, expect, mock, test } from "bun:test";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionIngestScheduler } from "./ingest.ts";

mock.module("@humain/terminal", () => ({
	BorderedLoader: class {
		onAbort?: () => void;
		constructor(..._args: unknown[]) {}
	},
	discoverAgents: () => [],
	renderTaskWithContext: (task: string) => task,
}));

const testStateRoot = mkdtempSync(join(tmpdir(), "orch-run-session-test-"));
process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT = testStateRoot;
process.env.CODING_AGENT_ORCHESTRATOR_HOME = testStateRoot;
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
			const waitForMaterialization = async (previousAttempt?: string) => {
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					try {
						const status = JSON.parse(readFileSync(join(testStateRoot, "ingest_status.json"), "utf8"));
						if (status.status === "ok" && status.last_attempt_at !== previousAttempt &&
							statSync(join(testStateRoot, "dashboard.html")).size > 0) return status;
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
			expect(status.error.length).toBeLessThanOrEqual(500);
			expect(status.error).not.toContain("\n");
			expect(readdirSync(root).sort()).toEqual(["ingest_status.json"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
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
	test("keeps the cancelled goal and stopped dispatch visible after cleanup", () => {
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
		session.close(true);

		const finalWidget = widgets.at(-1) as string[];
		expect(finalWidget.some((line) => line.includes("Goal:") && line.includes("update the payments page"))).toBe(true);
		expect(finalWidget.some((line) => line.includes("lead") && line.includes("cancelled by user"))).toBe(true);
		expect(statuses.at(-1)).toContain("cancelled");
	});
});

describe("confirmation gates", () => {
	test("passes the dispatch title and details as separate confirmation arguments", async () => {
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const planSummary = source.indexOf("const planSummary = [");
		const callStart = source.indexOf("confirmStep(", planSummary);
		const callEnd = source.indexOf("\n\t\t\t\t)", callStart) + "\n\t\t\t\t)".length;
		expect(planSummary).toBeGreaterThanOrEqual(0);
		expect(callStart).toBeGreaterThan(planSummary);
		expect(callEnd).toBeGreaterThan(callStart);

		const runCall = new Function(
			"confirmStep",
			"ctx",
			"pipeline",
			"parsed",
			"DISPATCH_TIMEOUT_MS",
			`return ${source.slice(callStart, callEnd)};`,
		) as (
			confirmStep: (...args: unknown[]) => Promise<boolean>,
			ctx: object,
			pipeline: string,
			parsed: { interactive: boolean },
			DISPATCH_TIMEOUT_MS: number,
		) => Promise<boolean>;
		const confirmStep = mock(async (..._args: unknown[]) => true);

		await expect(
			runCall(confirmStep, {}, "lead → workers → qa", { interactive: false }, 300_000),
		).resolves.toBe(true);
		expect(confirmStep).toHaveBeenCalledWith(
			{},
			"Dispatch this plan?",
			"lead → workers → qa\n\nEach stage runs headless (up to 5 min per dispatch); live progress shows above the editor.",
			false,
		);
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
		expect(orchestrator.verificationRecordFor).toBeUndefined();
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		for (const event of ["task_verified", "task_failed"]) {
			expect(source).not.toContain(`event: passed ? "${event}"`);
			expect(source).not.toContain(`event: "${event}"`);
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
			expect(snap?.has("tracked.ts")).toBe(false);
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

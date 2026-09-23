import { afterAll, describe, expect, mock, test } from "bun:test";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const orchestrator = await import("./index.ts");
afterAll(() => {
	rmSync(testStateRoot, { recursive: true, force: true });
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
		session.close(true);

		const widget = widgets.at(-1) as string[];
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
		session.close(true);

		const log = readFileSync(session.file("run.log"), "utf8");
		expect(log).toContain("progress: initial progress");
		expect(log).toContain("progress: nested worker progress: worker-1");
		expect(log).toContain("progress: tool end");
		expect(log).not.toContain("progress: tool start");
		expect(log).not.toContain("progress: tool execution completed");
		expect(log.split("progress: tool end").length - 1).toBe(1);
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
			"lead → workers → qa\n\nOrchestrating stages use an inactivity limit plus an absolute ceiling (leaf dispatches use a fixed timeout); live progress shows above the editor.",
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

import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { MAX_CHILD_STDERR_DISK_BYTES } from "./stderr-sink.ts";

// `child-process.ts` imports real bindings (not just types) from `@humain/terminal`, which has
// no `node_modules` entry in this standalone bridge checkout (see scripts/typecheck-bridge.sh's
// doc comment). Mirrors index.test.ts's stub: enough of `discoverAgents`/`renderTaskWithContext`
// to load the module; this test never exercises the real `discoverAgents` (it injects
// `discoverAgentsFn` instead), so the stub's own behaviour is irrelevant here.
mock.module("@humain/terminal", () => ({
	discoverAgents: () => ({ agents: [] }),
	renderTaskWithContext: (task: string) => task,
}));

const { guardChildStreamHandler, runSubagentProcess } = await import("./child-process.ts");
const { RunSession } = await import("../run/session.ts");

const NO_PERSONA = "__no_persona__";

const repoDir = mkdtempSync(join(tmpdir(), "orch-child-process-test-"));
const runsDir = mkdtempSync(join(tmpdir(), "orch-child-process-runs-"));
afterAll(() => {
	rmSync(repoDir, { recursive: true, force: true });
	rmSync(runsDir, { recursive: true, force: true });
});

function createSession(id: string) {
	const ctx = {
		ui: { setWidget: () => {}, setStatus: () => {}, notify: () => {} },
	};
	return new RunSession(id, ctx as never, "persona error test", repoDir, {
		runsDir: () => runsDir,
		telemetrySnapshot: () => ({ recorded: 0, failed: 0, replayed: 0 }) as never,
	});
}

/** A `--mode json` script that immediately emits a minimal `result` event and exits 0. */
function spawnResultScript() {
	const code = "console.log(JSON.stringify({type:'result',subtype:'success',result:'done',total_cost_usd:0,duration_ms:1}));";
	return (_command: string, _args: readonly string[], options: unknown) =>
		nodeSpawn(process.execPath, ["-e", code], options as never);
}

describe("runSubagentProcess persona resolution failure (B4.7)", () => {
	test("a persona write failure is logged to the session and surfaced as a diagnostic instead of proceeding silently", async () => {
		const session = createSession("run-persona-error");

		await runSubagentProcess({
			cwd: repoDir,
			agentName: "orch-scout",
			task: "do it",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
			taskId: "t1",
			session,
			env: () => ({}),
			spawnChild: spawnResultScript(),
			discoverAgentsFn: () => {
				throw new Error("agents dir unreadable");
			},
		});

		const log = readFileSync(join(session.dir, "run.log"), "utf-8");
		expect(log).toContain("persona resolution for orch-scout failed: agents dir unreadable");

		const diagnostic = readFileSync(join(session.dir, "t1.persona-error.log"), "utf-8");
		expect(diagnostic).toContain("agents dir unreadable");
	});

	test("no persona (sentinel agent name) never triggers the error path", async () => {
		const session = createSession("run-no-persona-error");

		await runSubagentProcess({
			cwd: repoDir,
			agentName: NO_PERSONA,
			task: "do it",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
			taskId: "t2",
			session,
			env: () => ({}),
			spawnChild: spawnResultScript(),
			discoverAgentsFn: () => {
				throw new Error("must not be called for the no-persona sentinel");
			},
		});

		const log = readFileSync(join(session.dir, "run.log"), "utf-8");
		expect(log).not.toContain("persona resolution");
	});
});

describe("runSubagentProcess process/event handling", () => {
	// `fileURLToPath` (not `.pathname`) so this resolves correctly on paths with
	// spaces or non-ASCII characters, which `.pathname` percent-encodes instead
	// of decoding.
	const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
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
		return new RunSession(id, ctx as never, "progress timeout test", repoDir, {
			runsDir: () => runsDir,
			telemetrySnapshot: () => ({ recorded: 0, failed: 0, replayed: 0 }) as never,
		});
	}

	function runLead(code: string, taskId: string, timeouts: { inactivityMs: number; maxMs: number }, session?: InstanceType<typeof RunSession>) {
		return runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "draining-lead", session,
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "usage-drain", session,
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
		const { SpendCapTracker } = await import("../spend-cap.ts");
		const session = createSession("spend-cap-enforce");
		session.spendCaps = new SpendCapTracker({ mode: "enforce", usd_by_capability: { lead: 4 }, default_usd: 1 });
		const kill = mock(() => true);
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill, pid: undefined });
		const emit = (cost: number) => child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: `turn ${cost}`, usage: { input: 1, output: 1, cost: { total: cost } } } })}\n`);
		try {
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "capped-lead", session,
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
		const { SpendCapTracker } = await import("../spend-cap.ts");
		const session = createSession("spend-cap-final-turn");
		session.spendCaps = new SpendCapTracker({ mode: "enforce", usd_by_capability: { lead: 4 }, default_usd: 1 });
		const kill = mock(() => true);
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "final-turn-lead", session,
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "openai-codex/gpt-6-astra",
				ctx: {} as never, env: () => process.env, capability: "security_review", taskId: "quota-sec", session,
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
		const { SpendCapTracker } = await import("../spend-cap.ts");
		const session = createSession("spend-cap-warn");
		session.spendCaps = new SpendCapTracker({ mode: "warn", usd_by_capability: { lead: 4 }, default_usd: 1 });
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
		const emit = (event: unknown) => child.stdout.write(`${JSON.stringify(event)}\n`);
		try {
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "warned-lead", session,
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
		const { SpendCapTracker } = await import("../spend-cap.ts");
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "nested-lead", session,
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
			let result: Awaited<ReturnType<typeof runSubagentProcess>> | undefined;
			void runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "no-close", session,
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
			const result = await runSubagentProcess({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never, env: () => process.env,
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
			const result = await runSubagentProcess({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never, env: () => process.env,
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
		expect(runSubagentProcess).toBeFunction();
		const result = await runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
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
		const { writeLongLineThrowFixture, SENTINEL } = await import("../fixtures/long-line-throw.mjs");
		const fixtureDir = mkdtempSync(join(tmpdir(), "orch-long-line-fixture-"));
		const scriptPath = join(fixtureDir, "long-line-throw.mjs");
		writeLongLineThrowFixture(scriptPath);
		try {
			const result = await runSubagentProcess({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never, env: () => process.env,
				spawnChild: (_command, _args, options) => nodeSpawn(process.execPath, [scriptPath], options as never),
			});

			expect(result.stderr).toContain(SENTINEL);
			expect(result.stderr).toMatch(/\n\s+at /);
		} finally {
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	test("long minified-bundle-style source line surfaces the sentinel and a stack frame in the persisted <taskId>.stderr.log (with session)", async () => {
		const { writeLongLineThrowFixture, SENTINEL } = await import("../fixtures/long-line-throw.mjs");
		const fixtureDir = mkdtempSync(join(tmpdir(), "orch-long-line-fixture-"));
		const scriptPath = join(fixtureDir, "long-line-throw.mjs");
		writeLongLineThrowFixture(scriptPath);
		const session = createSession("long-line-session");
		try {
			const result = await runSubagentProcess({
				cwd: repoDir,
				agentName: "__no_persona__",
				task: "do the fixture task",
				model: "provider/model",
				ctx: {} as never, env: () => process.env,
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

		const { writeLongLineThrowFixture, SENTINEL } = await import("../fixtures/long-line-throw.mjs");
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
		const result = await runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
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
		const result = await runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
			spawnChild: spawnInlineScript(
				`const e=[{type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"   "}]}},{type:"agent_end",messages:[]},{type:"agent_settled"}];for(const x of e)process.stdout.write(JSON.stringify(x)+"\\n");process.exitCode=1;`,
			),
		});

		expect(result.outcome).toBe("failed");
		expect(result.finalText).toBe("");
		expect(result.exitCode).toBe(1);
	});

	test("does not recover an error stop reason even after agent_settled", async () => {
		const result = await runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
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
		const result = await runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
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
		const result = await runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never, env: () => process.env,
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "openai-codex/gpt-6-astra",
				ctx: {} as never, env: () => process.env, capability: "security_review", taskId: "provider-error-once", session,
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
			const result = await runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "timeout-once", session,
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "recovered-prefix", session,
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
			const first = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "dup-task", session,
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
			const result2 = await runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "dup-task", session,
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
			const first = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "collide-silent", session,
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
			const second = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "collide-silent", session,
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
			const first = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "collide-timeout", session,
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
			const second = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "collide-timeout", session,
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
			const result = await runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "recovered-real-bytes", session,
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "late-bytes-warning", session,
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
			const pending = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "late-bytes-over-cap", session,
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
			const result = await runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "cap-with-prefix", session,
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
			const first = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, taskId: "cap-with-notes-fallback", session,
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
			const second = runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "cap-with-notes-fallback", session,
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
			const result = await runSubagentProcess({
				cwd: repoDir, agentName: "__no_persona__", task: "fixture", model: "p/m",
				ctx: {} as never, env: () => process.env, capability: "lead", taskId: "escaped-grandchild", session,
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
});


describe("child stream handler safety", () => {
	test("converts a stdout handler throw into a failed dispatch", async () => {
		let stderr = "";
		let killed = false;
		const exitCode = await new Promise<number>((resolve) => {
			guardChildStreamHandler(
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
			guardChildStreamHandler(
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

import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeRunArtifact, RunSession } from "./session.ts";

// The diagnostic-sealing tests below shell out to python3's orchestrator.archive to check the
// TS/Python archive contract against the real seal marker; PYTHONPATH must resolve THIS
// worktree's package, never an installed skill checkout.
process.env.HUMAIN_ORCHESTRATOR_SKILL_ROOT ??= fileURLToPath(new URL("../../../../", import.meta.url));

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

describe("diagnostic writer ownership and sealing", () => {
	const ctx = { ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} } };
	test("terminal drain and all producer closes precede seal; late callbacks cannot reopen diagnostics", async () => {
		const session = createSession("seal-writers", ctx as never, "test");
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
		expect(readFileSync(session.file("task.events.jsonl"), "utf8")).toBe("first\nlate\n");
		expect(() => session.diagnostics.writer()).toThrow();
		expect(() => createSession("seal-writers", ctx as never, "reopen")).toThrow();
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
			const session = createSession(`seal-timeout-${lateClose}`, {
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

	test("a shutdown failure vetoes an in-flight diagnostic seal before the last producer closes", async () => {
		const session = createSession("seal-shutdown-veto", ctx as never, "test");
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
		const session = createSession("seal-failed-drain", ctx as never, "test");
		session.close();
		expect(await session.sealDiagnostics(Promise.resolve(false))).toBe(false);
		expect(existsSync(session.file(".diagnostics-sealed.json"))).toBe(false);
	});
});

describe("archived run diagnostics lookup", () => {
	test("a readable path is returned unchanged; an archived one names the .gz and the restore command; a missing one says so", () => {
		const runRoot = mkdtempSync(join(tmpdir(), "orch-archived-diag-test-"));
		const runDir = join(runRoot, "runs", "ht-orch-1790000000000-abcdef");
		mkdirSync(runDir, { recursive: true });
		try {
			const log = join(runDir, "run.log");
			writeFileSync(log, "2026-08-01T00:00:00Z run started\n");
			expect(describeRunArtifact(log)).toBe(log);

			const report = join(runDir, "lead-report.md");
			writeFileSync(`${report}.gz`, "not really gzip, existence is what matters here");
			writeFileSync(
				join(runDir, "archive.manifest.json"),
				JSON.stringify({ format_version: 1, run_id: "ht-orch-1790000000000-abcdef", files: { "lead-report.md": { archive: "lead-report.md.gz", sha256: "00" } } }),
			);
			const described = describeRunArtifact(report);
			expect(described).toContain(report);
			expect(described).toContain(`${report}.gz`);
			expect(described).toContain("restore-run ht-orch-1790000000000-abcdef");

			// once restored (or never archived) the plain path wins again
			writeFileSync(report, "report\n");
			expect(describeRunArtifact(report)).toBe(report);

			// a .gz without a manifest entry is not ours to describe as archived
			const stray = join(runDir, "other.stderr.log");
			writeFileSync(`${stray}.gz`, "x");
			expect(describeRunArtifact(stray)).toBe(`${stray} (missing)`);
			expect(describeRunArtifact(join(runDir, "never.txt"))).toBe(`${join(runDir, "never.txt")} (missing)`);
		} finally {
			rmSync(runRoot, { recursive: true, force: true });
		}
	});
});

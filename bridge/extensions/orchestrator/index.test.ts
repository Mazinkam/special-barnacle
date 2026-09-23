import { afterAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
		expect(finalWidget).toContain("Goal: update the payments page");
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

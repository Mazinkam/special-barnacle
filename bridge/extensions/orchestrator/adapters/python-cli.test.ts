import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createPythonCli, type SpawnFn } from "./python-cli.ts";

/** A fake ChildProcess: EventEmitter + real streams so `.on("data")` / `.write()` work. */
function fakeChild(opts: { pid?: number } = { pid: 4242 }) {
	const stdin = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin,
		pid: opts.pid,
		kill: () => true,
	});
	return child;
}

describe("createPythonCli", () => {
	test("a spawn ENOENT emitted via the child's error event resolves instead of throwing or hanging", async () => {
		const child = fakeChild();
		const spawn = mock(() => child as never) as unknown as SpawnFn;
		const cli = createPythonCli({
			python: "/no/such/python",
			skillRoot: "/skill",
			stateRoot: "/state",
			spawn,
			defaultTimeoutMs: 5_000,
		});

		const pending = cli.run("orchestrator.cli", ["plan"]);
		// Simulate the old failure mode this fixes: a spawn error with no accompanying
		// "close" event. Before this change, `loadDynamicAdapter`/the ROI handler had no
		// `error` listener at all, so this would have produced an uncaught async error
		// instead of resolving.
		child.emit("error", new Error("spawn /no/such/python ENOENT"));

		const result = await pending;
		expect(result.code).toBeNull();
		expect(result.error).toContain("ENOENT");
		expect(result.stderr).toContain("ENOENT");
	});

	test("a hung child is killed via the process group and the run resolves with timedOut", async () => {
		const child = fakeChild({ pid: 777 });
		const spawn = mock(() => child as never) as unknown as SpawnFn;
		const kill = mock(() => true);
		const cli = createPythonCli({
			python: "python3",
			skillRoot: "/skill",
			stateRoot: "/state",
			spawn,
			defaultTimeoutMs: 20,
			kill,
		});

		// The fake child never emits "close" — models a hung Python process.
		const result = await cli.run("orchestrator.cli", ["plan"]);

		expect(result.timedOut).toBe(true);
		expect(result.code).toBeNull();
		expect(kill).toHaveBeenCalledWith(-777, "SIGKILL");
	});

	test("a non-zero exit surfaces the exit code and captured stderr", async () => {
		const child = fakeChild();
		const spawn = mock(() => child as never) as unknown as SpawnFn;
		const cli = createPythonCli({
			python: "python3",
			skillRoot: "/skill",
			stateRoot: "/state",
			spawn,
			defaultTimeoutMs: 5_000,
		});

		const pending = cli.run("orchestrator.cli", ["plan"]);
		child.stderr.write("Traceback: boom\n");
		child.emit("close", 1);

		const result = await pending;
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Traceback: boom");
	});

	test("module and script calls build identical envs, always including CODING_AGENT_ORCHESTRATOR_HOME and a PYTHONPATH that starts with skillRoot", async () => {
		const seenEnvs: NodeJS.ProcessEnv[] = [];
		const spawn = mock((_cmd, _args, options) => {
			seenEnvs.push(options.env ?? {});
			const child = fakeChild();
			queueMicrotask(() => child.emit("close", 0));
			return child as never;
		}) as unknown as SpawnFn;

		const cli = createPythonCli({
			python: "python3",
			skillRoot: "/skill/root",
			stateRoot: "/custom/state/root",
			spawn,
			defaultTimeoutMs: 5_000,
			baseEnv: { PATH: "/usr/bin", PYTHONPATH: "/other" },
		});

		await cli.run("orchestrator.cli", ["plan"]);
		await cli.run("/skill/root/scripts/skill_vs_baseline.py", []);

		expect(seenEnvs).toHaveLength(2);
		for (const env of seenEnvs) {
			expect(env.CODING_AGENT_ORCHESTRATOR_HOME).toBe("/custom/state/root");
			expect(env.PYTHONPATH?.startsWith("/skill/root")).toBe(true);
			expect(env.PATH).toBe("/usr/bin");
		}
		// Module call: `-m <module>`.
		expect(spawn).toHaveBeenNthCalledWith(1, "python3", ["-m", "orchestrator.cli", "plan"], expect.anything());
		// Script call (absolute path ending in .py): run directly, no `-m`.
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			"python3",
			["/skill/root/scripts/skill_vs_baseline.py"],
			expect.anything(),
		);
	});

	test("stdin content is written to the child before it is closed", async () => {
		const child = fakeChild();
		let written = "";
		child.stdin.on("data", (b) => (written += b.toString()));
		const spawn = mock(() => child as never) as unknown as SpawnFn;
		const cli = createPythonCli({
			python: "python3",
			skillRoot: "/skill",
			stateRoot: "/state",
			spawn,
			defaultTimeoutMs: 5_000,
		});

		const pending = cli.run("orchestrator.cli", ["batch", "-"], { stdin: '[{"a":1}]' });
		queueMicrotask(() => child.emit("close", 0));
		await pending;

		expect(written).toBe('[{"a":1}]');
	});

	test("extraEnv is applied on top of the base env builder", async () => {
		let seenEnv: NodeJS.ProcessEnv = {};
		const spawn = mock((_cmd, _args, options) => {
			seenEnv = options.env ?? {};
			const child = fakeChild();
			queueMicrotask(() => child.emit("close", 0));
			return child as never;
		}) as unknown as SpawnFn;

		const cli = createPythonCli({
			python: "python3",
			skillRoot: "/skill",
			stateRoot: "/state",
			spawn,
			defaultTimeoutMs: 5_000,
			extraEnv: { CODING_AGENT_RUNTIME: "humain-terminal" },
		});

		await cli.run("orchestrator.cli", []);
		expect(seenEnv.CODING_AGENT_RUNTIME).toBe("humain-terminal");
		expect(seenEnv.CODING_AGENT_ORCHESTRATOR_HOME).toBe("/state");
	});
});

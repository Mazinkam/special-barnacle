import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createOrchestratorCli } from "./orchestrator-cli.ts";

/** A fake ChildProcess: EventEmitter + real streams so `.on("data")` / `.write()` work. */
function fakeChild() {
	const stdin = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin,
		pid: 4242,
		kill: () => true,
	});
	return child;
}

function validPlanJson(): string {
	return JSON.stringify({
		plan_id: "p1",
		run_id: "run-1",
		task_class: "coding",
		complexity: 0.6,
		risk: "medium",
		topology: { depth: 1, leads: 1, workers: 0, shape: "single" },
		route: {
			selected: { capability: "lead", effort: "standard", verification_depth: "targeted" },
			recommended: { capability: "lead", effort: "standard", verification_depth: "targeted" },
			mode: "adaptive",
			history_sufficient: true,
			explanation: {},
		},
		effective_quality_floor: 0.8,
		cost_aggressiveness: 0.5,
	});
}

describe("createOrchestratorCli planRun", () => {
	test("does not pass --coupling/--parallelizable — the Python CLI's own defaults for both are 0.5", async () => {
		let capturedArgs: string[] = [];
		const spawn = spyOn(childProcess, "spawn").mockImplementation(((_python: string, args: string[]) => {
			capturedArgs = args;
			const child = fakeChild();
			queueMicrotask(() => {
				child.stdout.end(validPlanJson());
				child.emit("close", 0);
			});
			return child as never;
		}) as never);

		const cli = createOrchestratorCli({
			python: "python3",
			skillRoot: "/skill",
			stateRoot: "/state",
			defaultTimeoutMs: 5_000,
			baseEnv: () => ({}),
		});

		await cli.planRun("run-1", { goal: "do it", taskClass: "coding", complexity: 0.6, risk: "medium" });

		expect(capturedArgs).not.toContain("--coupling");
		expect(capturedArgs).not.toContain("--parallelizable");

		spawn.mockRestore();
	});
});

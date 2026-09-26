import { afterAll, describe, expect, mock, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `child-process.ts` imports real bindings (not just types) from `@humain/terminal`, which has
// no `node_modules` entry in this standalone bridge checkout (see scripts/typecheck-bridge.sh's
// doc comment). Mirrors index.test.ts's stub: enough of `discoverAgents`/`renderTaskWithContext`
// to load the module; this test never exercises the real `discoverAgents` (it injects
// `discoverAgentsFn` instead), so the stub's own behaviour is irrelevant here.
mock.module("@humain/terminal", () => ({
	discoverAgents: () => ({ agents: [] }),
	renderTaskWithContext: (task: string) => task,
}));

const { runSubagentProcess } = await import("./child-process.ts");
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
			ctx: {} as never,
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
			ctx: {} as never,
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

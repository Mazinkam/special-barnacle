// Driver for the "real Node parent" regression test in index.test.ts.
//
// bun test's own subprocess plumbing does NOT reproduce HT's real failure
// mode: bun's parent-side pipe reads happen to drain a fast-exiting child's
// stderr pipe in full, so a test that spawns the long-line fixture directly
// from bun (as the "no session" / "with session" tests above do) passes on
// both the pre-fix and post-fix code — it exercises the fix's code path
// without ever exercising the bug it fixes. HT's actual parent process is
// real Node, and real Node's async pipe read silently drops the tail of a
// fast-exiting child's stderr past its ~64 KiB pipe buffer at process exit.
// This driver runs the real `runSubagentProcess` (imported from ../index.ts,
// unmodified) inside a real `node` process so that boundary is exercised for
// real.
//
// Node cannot import ../index.ts directly: run-diagnostics.ts uses a TS
// constructor parameter property (`constructor(readonly dir: string, ...)`),
// which is not erasable syntax, so Node's native type-stripping refuses to
// load it. index.test.ts bundles this driver (and everything it imports)
// with `Bun.build` into plain JS first, then spawns real `node` on the
// bundled output.
import { spawn } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { RunSession, runSubagentProcess } from "../index.ts";

async function main(): Promise<void> {
	const [repoDir, scriptPath, taskId, outFile] = process.argv.slice(2);
	if (!repoDir || !scriptPath || !taskId || !outFile) {
		throw new Error(
			"usage: run-subagent-under-node.js <repoDir> <scriptPath> <taskId> <outFile>",
		);
	}

	const ctx = {
		ui: {
			setWidget: (_id: string, _value: string[] | undefined) => {},
			setStatus: () => {},
			notify: () => {},
		},
	};
	const session = new RunSession(`${taskId}-session`, ctx as never, "node-parent driver run", repoDir);

	try {
		const result = await runSubagentProcess({
			cwd: repoDir,
			agentName: "__no_persona__",
			task: "do the fixture task",
			model: "provider/model",
			ctx: {} as never,
			taskId,
			session,
			spawnChild: (_command, _args, options) => spawn(process.execPath, [scriptPath], options as never),
		});

		const stderrLogPath = session.file(`${taskId}.stderr.log`);
		let stderrLogSize = -1;
		try {
			stderrLogSize = statSync(stderrLogPath).size;
		} catch {
			/* log file may legitimately not exist */
		}

		// Written to a file (never stdout): the JSON payload itself can be
		// hundreds of KB (the minified-bundle-style source line the fixture
		// reproduces), and this driver's own stdout pipe back to the test
		// runner is exactly the kind of pipe this regression test exists to
		// route around.
		writeFileSync(
			outFile,
			JSON.stringify({ stderrText: result.stderr, stderrLogPath, stderrLogSize }),
			"utf8",
		);
	} finally {
		session.close();
	}
}

main().catch((err) => {
	process.stderr.write(String((err as Error)?.stack ?? err));
	process.exitCode = 1;
});

/**
 * One place that spawns Python for the orchestrator extension.
 *
 * Every caller (dynamic adapter resolution, `orchestrator.cli` module calls,
 * the ROI report) used to build its own `spawn()` call with its own environment,
 * its own (often missing) `error` listener, and no timeout. That meant: a bad
 * `HUMAIN_ORCHESTRATOR_PYTHON` could throw an uncaught async error past a
 * surrounding `try`, a hung Python process could hang the run's terminal path
 * forever, and at least one caller never set `CODING_AGENT_ORCHESTRATOR_HOME`
 * so it could touch the *default* state root even when the user configured
 * another one.
 *
 * `createPythonCli()` fixes all three by centralizing the env builder, the
 * `error` handler, and a timeout that kills the whole process group (the
 * child is spawned `detached` so a hung child's own children die with it).
 * `run()` never rejects and never throws asynchronously: every outcome —
 * spawn error, timeout, non-zero exit, clean exit — resolves the same
 * `CliResult` shape exactly once.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { delimiter, isAbsolute } from "node:path";

export interface CliResult {
	/** `null` on spawn error or timeout; the child's exit code otherwise. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Set when the timeout fired and the process group was killed. */
	timedOut?: boolean;
	/** The `Error#message` from a spawn `error` event, when one occurred. */
	error?: string;
}

export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

/** Matches `process.kill`'s signature; injectable so tests can assert the call. */
export type KillFn = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export interface PythonCliOptions {
	python: string;
	skillRoot: string;
	stateRoot: string;
	spawn: SpawnFn;
	defaultTimeoutMs: number;
	/** Merged in last, so it wins over PYTHONPATH/CODING_AGENT_ORCHESTRATOR_HOME if set. */
	extraEnv?: Record<string, string | undefined>;
	/** The env every call starts from. Callers pass `process.env`; this module never reads it. */
	baseEnv?: NodeJS.ProcessEnv;
	/** Injectable for tests; defaults to `process.kill`. */
	kill?: KillFn;
}

export interface PythonCliRunOptions {
	stdin?: string;
	timeoutMs?: number;
	cwd?: string;
}

export interface PythonCli {
	/**
	 * Runs `moduleOrScript` under `python`. A value ending in `.py`, or an
	 * absolute path, runs as a script (`python <path> ...args`); anything else
	 * runs as a module (`python -m <name> ...args`). Both go through the same
	 * env builder and the same error/timeout/close handling.
	 */
	run(moduleOrScript: string, args: string[], options?: PythonCliRunOptions): Promise<CliResult>;
}

function isScriptTarget(moduleOrScript: string): boolean {
	return moduleOrScript.endsWith(".py") || isAbsolute(moduleOrScript);
}

export function createPythonCli(opts: PythonCliOptions): PythonCli {
	const { python, skillRoot, stateRoot, spawn, defaultTimeoutMs, extraEnv, baseEnv = {}, kill = process.kill } = opts;

	function buildEnv(): NodeJS.ProcessEnv {
		const existingPythonPath = baseEnv.PYTHONPATH;
		return {
			...baseEnv,
			PYTHONPATH: existingPythonPath ? `${skillRoot}${delimiter}${existingPythonPath}` : skillRoot,
			CODING_AGENT_ORCHESTRATOR_HOME: stateRoot,
			...extraEnv,
		};
	}

	function run(
		moduleOrScript: string,
		args: string[] = [],
		options: PythonCliRunOptions = {},
	): Promise<CliResult> {
		return new Promise((resolve) => {
			const spawnArgs = isScriptTarget(moduleOrScript)
				? [moduleOrScript, ...args]
				: ["-m", moduleOrScript, ...args];

			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const clearTimer = () => {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
			};

			const settle = (result: CliResult) => {
				if (settled) return;
				settled = true;
				clearTimer();
				resolve(result);
			};

			let child: ChildProcess;
			try {
				child = spawn(python, spawnArgs, {
					env: buildEnv(),
					cwd: options.cwd,
					stdio: ["pipe", "pipe", "pipe"],
					// So a timeout can kill the whole group: a Python child may itself
					// spawn children, and SIGKILL on the bare pid alone would orphan them.
					detached: true,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				resolve({ code: null, stdout: "", stderr: `[orchestrator] spawn error: ${message}`, error: message });
				return;
			}

			child.stdout?.on("data", (b) => (stdout += b.toString()));
			child.stderr?.on("data", (b) => (stderr += b.toString()));

			child.on("error", (err) => {
				stderr += `\n[orchestrator] spawn error: ${err.message}`;
				settle({ code: null, stdout, stderr, error: err.message });
			});

			child.on("close", (code) => {
				settle({ code, stdout, stderr });
			});

			const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
			timer = setTimeout(() => {
				const pid = child.pid;
				if (typeof pid === "number") {
					try {
						kill(-pid, "SIGKILL");
					} catch {
						/* already reaped, or never became a group leader */
					}
				}
				stderr += `\n[orchestrator] timed out after ${timeoutMs}ms`;
				settle({ code: null, stdout, stderr, timedOut: true });
			}, timeoutMs);

			// A child that exits before reading its payload closes the pipe under us;
			// that is reported through the exit code, not as an uncaught EPIPE.
			child.stdin?.on("error", () => {});
			if (options.stdin !== undefined) child.stdin?.end(options.stdin);
			else child.stdin?.end();
		});
	}

	return { run };
}

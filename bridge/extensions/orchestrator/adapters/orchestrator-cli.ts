/**
 * The Python CLI bridge for this extension (B4.6, finishing the C1/B4.3
 * `python-cli.ts` move): `orchestratorPythonCli()`/`runModule()`/`planRun()`
 * used to live in index.ts as free functions closed over module-level config
 * consts. `createOrchestratorCli(config)` takes the same config as explicit
 * parameters instead; index.ts calls it once at module load and re-exports
 * the result.
 *
 * `spawn` is imported directly here (not threaded through `config`) so every
 * call to `cli()` reads whatever `node:child_process`'s `spawn` binding
 * currently is at the moment it runs, exactly like the pre-move code did.
 * Passing `spawn` through `config` instead would capture whatever the
 * binding resolved to when `createOrchestratorCli()` was called (module
 * load, before index.test.ts's `spyOn(childProcess, "spawn")` calls run),
 * permanently missing every later spy — see python-cli.test.ts and
 * index.test.ts's `mock.module("node:child_process", ...)`.
 */
import { spawn } from "node:child_process";

import { createPythonCli, type PythonCli } from "./python-cli.ts";
import type { PlanResponse } from "../core/prompts.ts";

export interface OrchestratorCliConfig {
	/** Default Python interpreter; a per-call `runModule` `options.python` overrides it. */
	python: string;
	skillRoot: string;
	stateRoot: string;
	defaultTimeoutMs: number;
	/** Read fresh on every `cli()` call, matching the pre-move `liveEnv()` semantics. */
	baseEnv: () => NodeJS.ProcessEnv;
	extraEnv?: Record<string, string | undefined>;
}

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface PlanOptions {
	goal: string;
	taskClass: string;
	complexity: number;
	risk: string;
	qualityFloor?: number;
	costAggressiveness?: number;
}

export interface OrchestratorCli {
	/**
	 * Built fresh per call — see the module doc comment for why. `pythonOverride`
	 * is `runModule`'s test-only `python` option.
	 */
	cli(pythonOverride?: string): PythonCli;
	/**
	 * Run a Python module through `cli()`. Always resolves exactly once — on
	 * close, spawn error, or timeout — because `python-cli.ts`'s `run()` does. A
	 * spawn failure or timeout is reported as exit code -1 with the error in
	 * `stderr`, which the record queue treats as ambiguous and replays.
	 */
	runModule(module: string, args?: string[], stdin?: string, options?: { python?: string }): Promise<CliResult>;
	planRun(runId: string, opts: PlanOptions): Promise<PlanResponse>;
}

export function createOrchestratorCli(config: OrchestratorCliConfig): OrchestratorCli {
	function cli(pythonOverride?: string): PythonCli {
		return createPythonCli({
			python: pythonOverride ?? config.python,
			skillRoot: config.skillRoot,
			stateRoot: config.stateRoot,
			spawn,
			defaultTimeoutMs: config.defaultTimeoutMs,
			baseEnv: config.baseEnv(),
			extraEnv: config.extraEnv,
		});
	}

	function runModule(
		module: string,
		args: string[] = [],
		stdin?: string,
		options: { python?: string } = {},
	): Promise<CliResult> {
		return cli(options.python)
			.run(module, args, { stdin })
			.then((r) => ({
				stdout: r.stdout,
				stderr: r.stderr,
				exitCode: r.code ?? -1,
			}));
	}

	async function planRun(runId: string, opts: PlanOptions): Promise<PlanResponse> {
		const args = [
			"plan",
			runId,
			opts.taskClass,
			String(opts.complexity),
			opts.risk,
			"--coupling",
			"0.5",
			"--parallelizable",
			"0.5",
		];
		if (opts.qualityFloor !== undefined) args.push("--quality-floor", String(opts.qualityFloor));
		if (opts.costAggressiveness !== undefined)
			args.push("--cost-aggressiveness", String(opts.costAggressiveness));
		const res = await runModule("orchestrator.cli", args);
		if (res.exitCode !== 0) {
			throw new Error(`plan failed (exit ${res.exitCode}): ${res.stderr}`);
		}
		// The plan command emits a single pretty-printed JSON object on stdout.
		return JSON.parse(res.stdout.trim());
	}

	return { cli, runModule, planRun };
}

/**
 * The Python CLI bridge for this extension (B4.6, finishing the C1/B4.3
 * `python-cli.ts` move): `orchestratorPythonCli()`/`runModule()`/`planRun()`
 * used to live in index.ts as free functions closed over module-level config
 * consts. `createOrchestratorCli(config)` takes the same config as explicit
 * parameters instead; index.ts calls it once at module load and re-exports
 * the result.
 *
 * `spawn` defaults to node:child_process's own `spawn`, read from this
 * module's live ESM import binding inside `cli()` itself (not captured into
 * a local at module load), so a caller that never supplies `config.spawn`
 * keeps seeing whatever that binding currently resolves to on every call —
 * unchanged from before this seam existed. Tests inject `config.spawn`
 * directly (a capturing fake) instead of patching the real binding globally;
 * see adapters/orchestrator-cli.test.ts and python-cli.ts, which already
 * takes `spawn` the same way.
 */
import { spawn as nodeSpawn } from "node:child_process";

import { createPythonCli, type PythonCli, type SpawnFn } from "./python-cli.ts";
import { parsePlanResponse, type PlanResponse } from "../core/prompts.ts";

export interface OrchestratorCliConfig {
	/** Default Python interpreter; a per-call `runModule` `options.python` overrides it. */
	python: string;
	skillRoot: string;
	stateRoot: string;
	defaultTimeoutMs: number;
	/** Read fresh on every `cli()` call, matching the pre-move `liveEnv()` semantics. */
	baseEnv: () => NodeJS.ProcessEnv;
	extraEnv?: Record<string, string | undefined>;
	/** Test seam: overrides node:child_process's `spawn`. Defaults to this module's live
	 *  `nodeSpawn` import binding, looked up inside `cli()` at call time (see the module doc
	 *  comment) — production callers never set this. */
	spawn?: SpawnFn;
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
			spawn: config.spawn ?? nodeSpawn,
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
		// `--coupling`/`--parallelizable` are omitted: the Python CLI's `plan` subparser already
		// defaults both to 0.5 (`orchestrator/cli/routing_cmds.py`), so sending them was a no-op
		// that just duplicated the default in two places (B4.7).
		const args = ["plan", runId, opts.taskClass, String(opts.complexity), opts.risk];
		if (opts.qualityFloor !== undefined) args.push("--quality-floor", String(opts.qualityFloor));
		if (opts.costAggressiveness !== undefined)
			args.push("--cost-aggressiveness", String(opts.costAggressiveness));
		const res = await runModule("orchestrator.cli", args);
		if (res.exitCode !== 0) {
			throw new Error(`plan failed (exit ${res.exitCode}): ${res.stderr}`);
		}
		// The plan command emits a single pretty-printed JSON object on stdout. Validate its
		// shape before trusting it as a `PlanResponse` — an unvalidated cast let a malformed
		// response through as a plan the pipeline would silently misread (B4.7).
		let parsed: unknown;
		try {
			parsed = JSON.parse(res.stdout.trim());
		} catch (err) {
			throw new Error(`plan response is not valid JSON: ${(err as Error).message}`);
		}
		return parsePlanResponse(parsed);
	}

	return { cli, runModule, planRun };
}

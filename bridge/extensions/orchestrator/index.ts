/**
 * Hierarchical Agent Orchestrator — HUMAIN Terminal extension (composition root).
 *
 * This file is wiring only: build `CONFIG` from `config.ts`, construct the
 * adapters/pipeline/run modules with their real dependencies, bind the thin
 * wrappers that let dispatch/pipeline modules stay free of module-level
 * imports of this file, and register commands/tools/hooks in the default
 * export. All logic lives in `core/*` (pure), `adapters/*` (I/O), `run/*`
 * (per-run state), `pipeline/*` (dispatch orchestration), `dispatch/*`
 * (child-process mechanics), `hooks/*`, and `commands/*`. See
 * docs/architecture-review.md B4 for the module layout and git history for
 * how each piece got here.
 *
 * `createOrchestratorExtension(deps)` (B5) is this file's one remaining test
 * seam: everything spawn-dependent — the Python CLI (`adapters/orchestrator-cli.ts`)
 * and the subagent child launcher (`dispatch/child-process.ts`'s `spawnChild`
 * default) — is built inside it from `deps.spawn`, instead of index.test.ts
 * globally patching `node:child_process`'s `spawn` export with `spyOn`. The
 * returned value is the `(pi: ExtensionAPI) => void` registration function
 * itself, with this instance's `RunSession`/`runRegistry`/`runModule`/etc.
 * attached as properties on it, so a test can build an isolated instance with
 * a fake spawn and still reach everything the production singleton exposes.
 * `export default createOrchestratorExtension()` is production's one instance,
 * built with no injected spawn (so every seam falls through to its own real
 * `node:child_process` `spawn`) — behaviour is unchanged from before this seam
 * existed.
 */

import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

import { type ExtensionAPI, type ExtensionContext } from "@humain/terminal";

import {
	runSubagentProcess as runSubagentProcessCore,
	PERSONA_TMP_PREFIX,
	liveDispatchPids,
} from "./dispatch/child-process.ts";
import { dispatchParallel as dispatchParallelCore } from "./dispatch/parallel.ts";
import { createOrchestratorCli } from "./adapters/orchestrator-cli.ts";
import { reapOrphanedPersonaDirs } from "./adapters/process-reaper.ts";
import { createTelemetry } from "./adapters/telemetry.ts";
import { availableModels } from "./adapters/model-registry.ts";
import { createRunFinalizer, createDispatchCostCapture } from "./run/finalize.ts";
import { createCheckModels } from "./commands/check-models.ts";
import {
	type Adapter,
	type FullResolution,
	resolveAdapter as resolveAdapterAdapter,
} from "./adapters/adapter-resolver.ts";
import { createProfilesStore } from "./adapters/profiles-store.ts";
import { type SpawnFn } from "./adapters/python-cli.ts";
import { emptyOverrides, type ModelOverrides } from "./core/args.ts";
import { loadBridgeConfig, liveEnv, runsDir, shippedProfilesPath } from "./config.ts";
import { type TriageResult } from "./core/triage.ts";
import { type DispatchTask } from "./core/prompts.ts";
import { RunRegistry, type RunContext } from "./run/context.ts";
import {
	RunSession as RunSessionCore,
	type RunSessionDeps,
} from "./run/session.ts";
import { triageTask as triageTaskCore } from "./pipeline/triage-step.ts";
import { dispatchReconAndLeads as dispatchReconAndLeadsCore } from "./pipeline/hierarchy.ts";
import { registerOrchestratorStatusTool } from "./tools/status.ts";
import { installSessionIngest } from "./hooks/ingest.ts";
import { installShutdownHooks } from "./hooks/shutdown.ts";
import { registerOrchestrateCancelCommand } from "./commands/cancel.ts";
import { registerOmsgCommand } from "./commands/omsg.ts";
import { registerOrchestratorRoiCommand } from "./commands/roi.ts";
import { registerOrchestratorModelsCommand } from "./commands/orchestrator-models.ts";
import { registerOrchestrateCommand } from "./commands/orchestrate.ts";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CONFIG = loadBridgeConfig(liveEnv(), homedir());
const {
	stateRoot: STATE_ROOT,
	python: PYTHON,
	expandedSkillRoot,
	profilesPath: PROFILES_PATH,
	legacyAdapterPath: LEGACY_ADAPTER_PATH,
	pythonTimeoutMs: PYTHON_TIMEOUT_MS,
	maxConcurrentDispatches: MAX_CONCURRENT_DISPATCHES,
	maxLeads: MAX_LEADS,
	telemetryFlushMs: TELEMETRY_FLUSH_MS,
	telemetryMaxBatch: TELEMETRY_MAX_BATCH,
	reconEvidenceMaxChars: RECON_EVIDENCE_MAX_CHARS,
	pythonExtraEnv: PYTHON_EXTRA_ENV,
	personaTmpTtlMs: PERSONA_TMP_TTL_MS,
} = CONFIG;

// -----------------------------------------------------------------------------
// Model profiles
// -----------------------------------------------------------------------------

const profilesStore = createProfilesStore({
	profilesPath: PROFILES_PATH,
	legacyAdapterPath: LEGACY_ADAPTER_PATH,
	shippedProfilesPath,
});
const loadProfiles = profilesStore.loadProfiles;
const writeProfilesFile = profilesStore.writeProfilesFile;

// -----------------------------------------------------------------------------
// Extension instance factory (B5: the injected-spawn test seam)
// -----------------------------------------------------------------------------

export interface OrchestratorExtensionDeps {
	/**
	 * Test seam: overrides `node:child_process`'s `spawn` for every seam this
	 * extension instance spawns through — the Python CLI
	 * (adapters/orchestrator-cli.ts) and the subagent child launcher
	 * (dispatch/child-process.ts's `spawnChild` default). Omitted entirely by
	 * production (`export default`); each seam then falls through to its own
	 * real `spawn` import binding, unchanged from before this seam existed.
	 */
	spawn?: SpawnFn;
}

/**
 * The `(pi: ExtensionAPI) => void` registration function for one orchestrator
 * extension instance, with everything a caller might otherwise reach through
 * a module-level export attached to it: this instance's own `RunSession`
 * class, `runRegistry`, telemetry queue/recorders, run finalizers, and
 * dispatch wrappers. `createOrchestratorExtension({ spawn })` (below) builds
 * an isolated instance of all of these from one injected spawn function, so a
 * test can exercise the real registration/dispatch wiring against a fake
 * child launcher instead of patching `node:child_process` globally.
 *
 * Deliberately not given an explicit return-type annotation: this instance's
 * `RunSession` is a real (local) subclass with its own 4-argument
 * constructor, and annotating the return type as some `typeof RunSessionCore`
 * base-class shape would widen every `new extension.RunSession(...)` call
 * site back to the base class's 5-argument constructor. Let TypeScript infer
 * the exact shape from `Object.assign(register, {...})` below instead.
 */
export function createOrchestratorExtension(deps: OrchestratorExtensionDeps = {}) {
	const orchestratorCli = createOrchestratorCli({
		python: PYTHON,
		skillRoot: expandedSkillRoot,
		stateRoot: CONFIG.expandedStateRoot,
		defaultTimeoutMs: PYTHON_TIMEOUT_MS,
		baseEnv: liveEnv,
		extraEnv: PYTHON_EXTRA_ENV,
		spawn: deps.spawn,
	});
	const orchestratorPythonCli = orchestratorCli.cli;
	const runModule = orchestratorCli.runModule;
	const planRun = orchestratorCli.planRun;

	/**
	 * Build the capability -> model table for a run. Precedence, highest first:
	 * flags > profile capabilities > profile tiers > dynamic resolver > fallback.
	 */
	async function resolveAdapter(
		ctx: ExtensionContext,
		overrides: ModelOverrides = emptyOverrides(),
	): Promise<FullResolution> {
		return resolveAdapterAdapter(
			{
				profilesPath: PROFILES_PATH,
				loadProfiles,
				availableModels: () => availableModels(ctx),
				dynamicCli: orchestratorPythonCli(),
			},
			overrides,
		);
	}

	// -------------------------------------------------------------------------
	// Run session
	// -------------------------------------------------------------------------

	/**
	 * Binds run/session.ts's RunSessionDeps to this instance's real runs
	 * directory and telemetry queue snapshot, so every `new RunSession(runId,
	 * ctx, goal, cwd?)` call site keeps working unchanged.
	 */
	class RunSession extends RunSessionCore {
		constructor(runId: string, ctx: ExtensionContext, goal: string, cwd: string = process.cwd()) {
			const sessionDeps: RunSessionDeps = {
				runsDir: () => runsDir(CONFIG),
				telemetrySnapshot: () => recordQueue.snapshot(),
			};
			super(runId, ctx, goal, cwd, sessionDeps);
		}
	}

	/** Owns "the one active run" for this extension instance (run/context.ts, B4.4). */
	const runRegistry = new RunRegistry<RunSession>();

	/**
	 * Spawn Pi as a one-shot subagent (dispatch/child-process.ts). Binds the real
	 * telemetry recorder / live env / active-run session / injected spawn as
	 * defaults for dispatch/child-process.ts's optional seams, so dispatch/*
	 * never imports this file.
	 */
	function runSubagentProcess(
		opts: Omit<Parameters<typeof runSubagentProcessCore>[0], "env"> & { env?: () => NodeJS.ProcessEnv },
	): ReturnType<typeof runSubagentProcessCore> {
		return runSubagentProcessCore({
			...opts,
			recordEvent: opts.recordEvent ?? recordEvent,
			env: opts.env ?? liveEnv,
			session: opts.session ?? runRegistry.active()?.session ?? undefined,
			spawnChild: opts.spawnChild ?? deps.spawn,
		});
	}

	/** Classify the goal with the cheapest capability (pipeline/triage-step.ts). */
	function triageTask(
		runId: string,
		goal: string,
		cwd: string,
		ctx: ExtensionContext,
		run: RunContext<RunSession> | null,
		costSink: { usd: number },
		adapter: Adapter,
	): Promise<TriageResult | null> {
		return triageTaskCore(runId, goal, cwd, ctx, run, costSink, adapter, {
			runProcess: runSubagentProcess,
			captureDispatchCost,
		});
	}

	// -------------------------------------------------------------------------
	// Telemetry
	// -------------------------------------------------------------------------

	const telemetry = createTelemetry({
		runBatch: (records) => runModule("orchestrator.cli", ["batch", "-"], JSON.stringify(records)),
		maxBatch: TELEMETRY_MAX_BATCH,
		flushDelayMs: TELEMETRY_FLUSH_MS,
		onError: (message) => {
			console.warn(`[orchestrator] ${message}`);
			runRegistry.active()?.session.log(`telemetry: ${message}`);
		},
	});
	const recordQueue = telemetry.queue;
	const recordEvent = telemetry.recordEvent;
	const recordModelCall = telemetry.recordModelCall;
	const recordOutcome = telemetry.recordOutcome;

	const runFinalizer = createRunFinalizer({
		runRegistry,
		recordEvent,
		recordOutcome,
		recordQueue,
	});
	const completeRun = runFinalizer.completeRun;
	const failRun = runFinalizer.failRun;

	const captureDispatchCost = createDispatchCostCapture(recordModelCall);

	// -------------------------------------------------------------------------
	// Subagent dispatch
	// -------------------------------------------------------------------------

	/**
	 * Dispatch a batch of tasks in parallel (dispatch/parallel.ts). Binds the
	 * real telemetry recorder / runSubagentProcess / concurrency ceiling as
	 * defaults for dispatch/parallel.ts's required `deps`.
	 */
	function dispatchParallel(
		cwd: string,
		runId: string,
		tasks: DispatchTask[],
		adapter: Adapter,
		ctx: ExtensionContext,
		run: RunContext<RunSession> | null,
		depth: number = 0,
		dispatchDeps: Partial<Parameters<typeof dispatchParallelCore>[7]> = {},
	): ReturnType<typeof dispatchParallelCore> {
		return dispatchParallelCore(cwd, runId, tasks, adapter, ctx, run, depth, {
			recordEvent,
			runProcess: runSubagentProcess,
			maxConcurrentDispatches: MAX_CONCURRENT_DISPATCHES,
			...dispatchDeps,
		});
	}

	/**
	 * Parent-owned recon/lead sequencing (pipeline/hierarchy.ts). Binds config.ts's
	 * `MAX_LEADS`/`RECON_EVIDENCE_MAX_CHARS` as defaults for the core function's
	 * required `maxLeads`/`evidenceMaxChars`.
	 */
	function dispatchReconAndLeads(
		input: Omit<Parameters<typeof dispatchReconAndLeadsCore>[0], "maxLeads" | "evidenceMaxChars" | "repoRoot"> & {
			maxLeads?: number;
			evidenceMaxChars?: number;
			/** The run's cwd, resolved absolute; defaults to the process's own cwd here — this wrapper is
			 *  index.ts's impure edge, unlike the pure `pipeline/hierarchy.ts` core it defaults for. */
			repoRoot?: string;
		},
		effects: Parameters<typeof dispatchReconAndLeadsCore>[1],
	): ReturnType<typeof dispatchReconAndLeadsCore> {
		return dispatchReconAndLeadsCore(
			{
				...input,
				maxLeads: input.maxLeads ?? MAX_LEADS,
				evidenceMaxChars: input.evidenceMaxChars ?? RECON_EVIDENCE_MAX_CHARS,
				repoRoot: input.repoRoot ?? resolve(process.cwd()),
			},
			effects,
		);
	}

	// -------------------------------------------------------------------------
	// Commands: bound dependencies
	// -------------------------------------------------------------------------

	const checkModels = createCheckModels({
		runRegistry,
		createSession: (runId, ctx, goal) => new RunSession(runId, ctx, goal),
		runProcess: runSubagentProcess,
		maxConcurrentDispatches: MAX_CONCURRENT_DISPATCHES,
	});

	// -------------------------------------------------------------------------
	// Extension entry point
	// -------------------------------------------------------------------------

	function register(pi: ExtensionAPI): void {
		reapOrphanedPersonaDirs({ tmpRoot: tmpdir(), prefix: PERSONA_TMP_PREFIX, ttlMs: PERSONA_TMP_TTL_MS });
		installShutdownHooks(pi, {
			liveDispatchPids,
			activeSession: () => runRegistry.active()?.session ?? null,
			flush: () => recordQueue.flush(),
		});
		installSessionIngest(pi, STATE_ROOT, runModule);
		registerOrchestratorStatusTool(pi, runRegistry);

		registerOrchestrateCommand(pi, {
			runRegistry,
			resolveAdapter,
			createSession: (runId, ctx, goal) => new RunSession(runId, ctx, goal),
			triageTask,
			planRun,
			recordEvent,
			recordOutcome,
			captureDispatchCost,
			dispatchParallel,
			completeRun,
			failRun,
			maxLeads: MAX_LEADS,
			reconEvidenceMaxChars: RECON_EVIDENCE_MAX_CHARS,
			stateRoot: STATE_ROOT,
			profilesPath: PROFILES_PATH,
		});

		registerOrchestrateCancelCommand(pi, runRegistry);

		registerOrchestratorModelsCommand(pi, {
			resolveAdapter,
			availableModels,
			loadProfiles,
			writeProfilesFile,
			checkModels,
			profilesPath: PROFILES_PATH,
		});

		registerOrchestratorRoiCommand(pi, { cli: orchestratorPythonCli, skillRoot: expandedSkillRoot });

		// Message inbound while a run is live — queued in RunSession and folded
		// into the prompt of the next dispatched task. Cannot be injected into a
		// running Pi subprocess (humain-terminal --mode json --no-session has no
		// stdin channel), so delivery is at the next dispatch boundary.
		registerOmsgCommand(pi, runRegistry);
	}

	return Object.assign(register, {
		RunSession,
		runRegistry,
		runModule,
		runSubagentProcess,
		recordQueue,
		recordEvent,
		recordModelCall,
		recordOutcome,
		completeRun,
		failRun,
		dispatchParallel,
		dispatchReconAndLeads,
	});
}

/** Production's one instance: no injected spawn, so every seam falls through to its own real `spawn`. */
const defaultExtension = createOrchestratorExtension();

/** This module's one orchestrator extension instance, as `createOrchestratorExtension` builds it. */
export type OrchestratorExtension = typeof defaultExtension;

export default defaultExtension;
export const RunSession = defaultExtension.RunSession;
export const runRegistry = defaultExtension.runRegistry;
export const runModule = defaultExtension.runModule;
export const runSubagentProcess = defaultExtension.runSubagentProcess;
export const recordQueue = defaultExtension.recordQueue;
export const recordEvent = defaultExtension.recordEvent;
export const recordModelCall = defaultExtension.recordModelCall;
export const recordOutcome = defaultExtension.recordOutcome;
export const completeRun = defaultExtension.completeRun;
export const failRun = defaultExtension.failRun;
export const dispatchParallel = defaultExtension.dispatchParallel;
export const dispatchReconAndLeads = defaultExtension.dispatchReconAndLeads;

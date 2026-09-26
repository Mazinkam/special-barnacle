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
 */

import { homedir, tmpdir } from "node:os";

import { type ExtensionAPI, type ExtensionContext } from "@humain/terminal";

import {
	runSubagentProcess as runSubagentProcessCore,
	PERSONA_TMP_PREFIX,
	liveDispatchPids,
	guardChildStreamHandler,
} from "./dispatch/child-process.ts";
import { dispatchParallel as dispatchParallelCore, agentNameFor } from "./dispatch/parallel.ts";
import { telemetryHealthy, telemetryWarning } from "./record-queue.ts";
import { createOrchestratorCli } from "./adapters/orchestrator-cli.ts";
import { reapOrphanedPersonaDirs } from "./adapters/process-reaper.ts";
import { createTelemetry } from "./adapters/telemetry.ts";
import { availableModels } from "./adapters/model-registry.ts";
import { createRunFinalizer, createDispatchCostCapture } from "./run/finalize.ts";
import { createCheckModels } from "./commands/check-models.ts";
import {
	type Adapter,
	type FullResolution,
	policyIdFor,
	resolveAdapter as resolveAdapterAdapter,
} from "./adapters/adapter-resolver.ts";
import { createProfilesStore } from "./adapters/profiles-store.ts";
import {
	changedFilesSinceRunStart,
	diffDirtySnapshots,
	gitDirtySnapshot,
	gitHead,
} from "./adapters/git-changes.ts";
import { emptyOverrides, type ModelOverrides, parseArgs, usageText } from "./core/args.ts";
import { loadBridgeConfig, liveEnv, runsDir, shippedProfilesPath } from "./config.ts";
import { clampComplexity, type TriageResult } from "./core/triage.ts";
import {
	type DispatchResult,
	dispatchRecordsFor,
	leadSelfImplemented,
	methodEffortFor,
	runCompletionOutcomeFor,
} from "./core/records.ts";
import {
	architectPrompt,
	type DispatchTask,
	LEAD_DELEGATION_RULE,
	LEAD_STATUS_CONTRACT,
	leadPrompt,
	QA_SCOPE_RULES,
} from "./core/prompts.ts";
import { RunRegistry, type RunContext } from "./run/context.ts";
import { confirmStep } from "./run/ui-sink.ts";
import {
	describeRunArtifact,
	RunSession as RunSessionCore,
	type RunSessionDeps,
	type RunTiming,
} from "./run/session.ts";
import { triageTask as triageTaskCore } from "./pipeline/triage-step.ts";
import {
	collectBilledResults,
	dispatchReconAndLeads as dispatchReconAndLeadsCore,
	summarizeReconWorkers,
} from "./pipeline/hierarchy.ts";
import { qaVerificationOutcomeFor, type VerificationResult } from "./pipeline/verify-loop.ts";
import { registerOrchestratorStatusTool } from "./tools/status.ts";
import {
	installSessionIngest,
	recordHookFailure,
	redactPaths,
	registerSessionIngestHooks,
} from "./hooks/ingest.ts";
import { installShutdownHooks } from "./hooks/shutdown.ts";
import { registerOrchestrateCancelCommand } from "./commands/cancel.ts";
import { registerOmsgCommand } from "./commands/omsg.ts";
import { registerOrchestratorRoiCommand } from "./commands/roi.ts";
import { registerOrchestratorModelsCommand } from "./commands/orchestrator-models.ts";
import { registerOrchestrateCommand } from "./commands/orchestrate.ts";
import type { OrchestratorStatus, WorktreeInfo } from "./run/board.ts";
import { formatOrchestratorStatus } from "./run/board.ts";

// -----------------------------------------------------------------------------
// Re-exports for existing importers/tests; removed in B5.
//
// index.test.ts (and fixtures/run-subagent-under-node.ts) import these by
// name off `import * as orchestrator from "./index.ts"`. B5 splits
// index.test.ts across the modules that now own each implementation; until
// then, every name a test or external caller reaches through this module
// must keep resolving here.
// -----------------------------------------------------------------------------
export {
	guardChildStreamHandler,
	agentNameFor,
	telemetryHealthy,
	telemetryWarning,
	confirmStep,
	describeRunArtifact,
	recordHookFailure,
	redactPaths,
	registerSessionIngestHooks,
	qaVerificationOutcomeFor,
	collectBilledResults,
	summarizeReconWorkers,
	formatOrchestratorStatus,
	architectPrompt,
	changedFilesSinceRunStart,
	clampComplexity,
	diffDirtySnapshots,
	dispatchRecordsFor,
	gitDirtySnapshot,
	gitHead,
	LEAD_DELEGATION_RULE,
	LEAD_STATUS_CONTRACT,
	leadPrompt,
	leadSelfImplemented,
	methodEffortFor,
	parseArgs,
	policyIdFor,
	QA_SCOPE_RULES,
	runCompletionOutcomeFor,
};
export type { VerificationResult, OrchestratorStatus, RunTiming, WorktreeInfo, DispatchResult, DispatchTask };

// -----------------------------------------------------------------------------
// Configuration + the one Python CLI spawner
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

const orchestratorCli = createOrchestratorCli({
	python: PYTHON,
	skillRoot: expandedSkillRoot,
	stateRoot: CONFIG.expandedStateRoot,
	defaultTimeoutMs: PYTHON_TIMEOUT_MS,
	baseEnv: liveEnv,
	extraEnv: PYTHON_EXTRA_ENV,
});
const orchestratorPythonCli = orchestratorCli.cli;
const runModule = orchestratorCli.runModule;
const planRun = orchestratorCli.planRun;
export { runModule };

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

// -----------------------------------------------------------------------------
// Run session
// -----------------------------------------------------------------------------

/**
 * Binds run/session.ts's RunSessionDeps to this file's real runs directory
 * and telemetry queue snapshot, so every `new RunSession(runId, ctx, goal,
 * cwd?)` call site keeps working unchanged.
 */
export class RunSession extends RunSessionCore {
	constructor(runId: string, ctx: ExtensionContext, goal: string, cwd: string = process.cwd()) {
		const deps: RunSessionDeps = {
			runsDir: () => runsDir(CONFIG),
			telemetrySnapshot: () => recordQueue.snapshot(),
		};
		super(runId, ctx, goal, cwd, deps);
	}
}

/** Owns "the one active run" for this extension (run/context.ts, B4.4). */
export const runRegistry = new RunRegistry<RunSession>();

/**
 * Spawn Pi as a one-shot subagent (dispatch/child-process.ts). Binds the real
 * telemetry recorder / live env / active-run session as defaults for
 * dispatch/child-process.ts's optional seams, so dispatch/* never imports
 * this file.
 */
export function runSubagentProcess(
	opts: Omit<Parameters<typeof runSubagentProcessCore>[0], "env"> & { env?: () => NodeJS.ProcessEnv },
): ReturnType<typeof runSubagentProcessCore> {
	return runSubagentProcessCore({
		...opts,
		recordEvent: opts.recordEvent ?? recordEvent,
		env: opts.env ?? liveEnv,
		session: opts.session ?? runRegistry.active()?.session ?? undefined,
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

// -----------------------------------------------------------------------------
// Telemetry
// -----------------------------------------------------------------------------

const telemetry = createTelemetry({
	runBatch: (records) => runModule("orchestrator.cli", ["batch", "-"], JSON.stringify(records)),
	maxBatch: TELEMETRY_MAX_BATCH,
	flushDelayMs: TELEMETRY_FLUSH_MS,
	onError: (message) => {
		console.warn(`[orchestrator] ${message}`);
		runRegistry.active()?.session.log(`telemetry: ${message}`);
	},
});
export const recordQueue = telemetry.queue;
export const recordEvent = telemetry.recordEvent;
export const recordModelCall = telemetry.recordModelCall;
export const recordOutcome = telemetry.recordOutcome;

const runFinalizer = createRunFinalizer({
	runRegistry,
	recordEvent,
	recordOutcome,
	recordQueue,
});
export const completeRun = runFinalizer.completeRun;
export const failRun = runFinalizer.failRun;

const captureDispatchCost = createDispatchCostCapture(recordModelCall);

// -----------------------------------------------------------------------------
// Subagent dispatch
// -----------------------------------------------------------------------------

/**
 * Dispatch a batch of tasks in parallel (dispatch/parallel.ts). Binds the
 * real telemetry recorder / runSubagentProcess / concurrency ceiling as
 * defaults for dispatch/parallel.ts's required `deps`.
 */
export function dispatchParallel(
	cwd: string,
	runId: string,
	tasks: DispatchTask[],
	adapter: Adapter,
	ctx: ExtensionContext,
	run: RunContext<RunSession> | null,
	depth: number = 0,
	deps: Partial<Parameters<typeof dispatchParallelCore>[7]> = {},
): ReturnType<typeof dispatchParallelCore> {
	return dispatchParallelCore(cwd, runId, tasks, adapter, ctx, run, depth, {
		recordEvent,
		runProcess: runSubagentProcess,
		maxConcurrentDispatches: MAX_CONCURRENT_DISPATCHES,
		...deps,
	});
}

/**
 * Parent-owned recon/lead sequencing (pipeline/hierarchy.ts). Binds config.ts's
 * `MAX_LEADS`/`RECON_EVIDENCE_MAX_CHARS` as defaults for the core function's
 * required `maxLeads`/`evidenceMaxChars`.
 */
export function dispatchReconAndLeads(
	input: Omit<Parameters<typeof dispatchReconAndLeadsCore>[0], "maxLeads" | "evidenceMaxChars"> & {
		maxLeads?: number;
		evidenceMaxChars?: number;
	},
	effects: Parameters<typeof dispatchReconAndLeadsCore>[1],
): ReturnType<typeof dispatchReconAndLeadsCore> {
	return dispatchReconAndLeadsCore(
		{
			...input,
			maxLeads: input.maxLeads ?? MAX_LEADS,
			evidenceMaxChars: input.evidenceMaxChars ?? RECON_EVIDENCE_MAX_CHARS,
		},
		effects,
	);
}

// -----------------------------------------------------------------------------
// Commands: bound dependencies
// -----------------------------------------------------------------------------

const checkModels = createCheckModels({
	runRegistry,
	createSession: (runId, ctx, goal) => new RunSession(runId, ctx, goal),
	runProcess: runSubagentProcess,
	maxConcurrentDispatches: MAX_CONCURRENT_DISPATCHES,
});

const USAGE = usageText(PROFILES_PATH);

// -----------------------------------------------------------------------------
// Extension entry point
// -----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
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

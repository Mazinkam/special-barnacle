/**
 * Hierarchical Agent Orchestrator — HUMAIN Terminal extension (full bridge)
 *
 * Bridges the `hierarchical-agent-orchestrator` Python skill into HT's subagent
 * runtime. The skill (Python) does routing math, policy enforcement, history
 * tracking, and verification. This extension is the dispatch layer that turns
 * abstract `plan_run(...)` output into concrete HT subagent calls with the
 * right models, runs verification, handles escalation, captures each subagent's
 * usage stats, and writes records back to `metrics.jsonl`.
 *
 * The dispatch flow (matches the skill's docs/INTEGRATION.md "Minimal loop"):
 *
 *   1. construct engine (Python CLI)         -> implicit via spawn
 *   2. plan_run(...)                         -> /orchestrate command
 *   3. read topology + compute package       -> plan response
 *   4. resolve abstract capability/effort   -> resolveAdapter() (flags > adapter file > dynamic_adapter.py)
 *   5. spawn subagent via HT subagent tool   -> dispatchHierarchical
 *   6. record every model call              -> captureDispatchCost
 *   7. run deterministic verification       -> runVerification
 *   8. QA gate verdict (the only verdict)   -> runVerification + recordOutcome
 *   9. escalate only the failing subproblem -> escalateIfNeeded
 *  10. complete_run / fail_run              -> completeRun / failRun + recordOutcome
 *
 * Compare the original sketch (kept at orchestrator.ts.sketch if present):
 * this rewrite adds hierarchical fan-out, verification + escalation, executed
 * route emission, and a `route_action: executed` record per dispatch so the
 * skill's history has (recommended, executed, observed) triples to learn from.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionContext } from "@humain/terminal";

import {
	type AvailableModel,
	type ProfilesFile,
	type ResolvedAdapter,
	shortName,
} from "./models.ts";
import { summarizeStderr } from "./dispatch/stderr-sink.ts";
import {
	runSubagentProcess as runSubagentProcessCore,
	NO_PERSONA,
	PERSONA_TMP_PREFIX,
	liveDispatchPids,
	guardChildStreamHandler,
	appendTrimmedEventLog,
	type DispatchSession,
} from "./dispatch/child-process.ts";
export { guardChildStreamHandler, appendTrimmedEventLog };
import {
	dispatchParallel as dispatchParallelCore,
	mapWithConcurrency,
	agentNameFor,
} from "./dispatch/parallel.ts";
export { agentNameFor };
import { fmtElapsed } from "./run-ui.ts";
import { telemetryHealthy, telemetryWarning, type FlushReport, type QueueStats } from "./record-queue.ts";
export { telemetryHealthy, telemetryWarning };
import { createOrchestratorCli } from "./adapters/orchestrator-cli.ts";
import { reapOrphanedPersonaDirs } from "./adapters/process-reaper.ts";
import { createTelemetry } from "./adapters/telemetry.ts";
import { createRunFinalizer, createDispatchCostCapture } from "./run/finalize.ts";
import {
	type Adapter,
	FALLBACK_ADAPTER,
	type FullResolution,
	policyIdFor,
	resolveAdapter as resolveAdapterAdapter,
} from "./adapters/adapter-resolver.ts";
import {
	loadProfiles as loadProfilesAdapter,
	writeProfilesFile as writeProfilesFileAdapter,
} from "./adapters/profiles-store.ts";
import {
	changedFilesSinceRunStart,
	diffDirtySnapshots,
	gitDirtySnapshot,
	gitHead,
} from "./adapters/git-changes.ts";

// Pure logic split out of this file per docs/architecture-review.md B4.1.
// `core/*` never imports this module and never reads `process.env`; every
// value it needs (run tags, max-lead ceilings, ...) is a parameter.
import { emptyOverrides, type ModelOverrides, parseArgs, usageText } from "./core/args.ts";
import { loadBridgeConfig, liveEnv } from "./config.ts";
import { clampComplexity, type TriageResult } from "./core/triage.ts";
import {
	type CaptureOpts,
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
	type PlanResponse,
	QA_SCOPE_RULES,
} from "./core/prompts.ts";

// RunContext/RunRegistry replace the ACTIVE_RUN / CURRENT_RUN_TAGS /
// CURRENT_ALIAS_TABLE globals (B4.4; run/context.ts never imports this module).
import { RunRegistry, type RunContext } from "./run/context.ts";
import { confirmStep, safeUi } from "./run/ui-sink.ts";
export { confirmStep };
import {
	describeRunArtifact,
	RunSession as RunSessionCore,
	type RunSessionDeps,
	type RunTiming,
} from "./run/session.ts";
export { describeRunArtifact };
import { triageTask as triageTaskCore } from "./pipeline/triage-step.ts";
import {
	collectBilledResults,
	dispatchReconAndLeads as dispatchReconAndLeadsCore,
	summarizeReconWorkers,
} from "./pipeline/hierarchy.ts";
import {
	qaVerificationOutcomeFor,
	type VerificationResult,
} from "./pipeline/verify-loop.ts";
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
export { recordHookFailure, redactPaths, registerSessionIngestHooks };
export { qaVerificationOutcomeFor };
export type { VerificationResult };
export { collectBilledResults, summarizeReconWorkers };
import type { OrchestratorStatus, WorktreeInfo } from "./run/board.ts";
import { formatOrchestratorStatus } from "./run/board.ts";
export type { OrchestratorStatus, RunTiming, WorktreeInfo };
export { formatOrchestratorStatus };

// Re-export the symbols index.test.ts imports from this module by name
// (`import * as orchestrator from "./index.ts"`); moving the implementation
// must not move where a consumer imports it from.
export {
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
export type { DispatchResult, DispatchTask };

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/**
 * Every `process.env` read and `~` expansion this extension makes, computed
 * once at module load (B4.2). Everything below destructures its fields under
 * the same names the pre-B4.2 module-level consts used, so the rest of this
 * file — and every existing test — is unchanged.
 */
const CONFIG = loadBridgeConfig(liveEnv(), homedir());
const {
	skillRoot: SKILL_ROOT,
	stateRoot: STATE_ROOT,
	python: PYTHON,
	expandedSkillRoot,
	expandedStateRoot,
	profilesPath: PROFILES_PATH,
	legacyAdapterPath: LEGACY_ADAPTER_PATH,
	pythonTimeoutMs: PYTHON_TIMEOUT_MS,
	maxConcurrentDispatches: MAX_CONCURRENT_DISPATCHES,
	maxLeads: MAX_LEADS,
	dispatchTimeoutMs: DISPATCH_TIMEOUT_MS,
	telemetryFlushMs: TELEMETRY_FLUSH_MS,
	telemetryMaxBatch: TELEMETRY_MAX_BATCH,
	reconEvidenceMaxChars: RECON_EVIDENCE_MAX_CHARS,
	pythonExtraEnv: PYTHON_EXTRA_ENV,
} = CONFIG;

/**
 * Model configuration lives in one file: `orchestrator-profiles.json`
 * (named profiles of alias -> capability/tier bindings; see models.ts). The
 * older `orchestrator-adapter.json` is migrated into profile "default" on first
 * load and then ignored.
 */
// redactPaths moved to hooks/ingest.ts (B4.6; its only caller, recordHookFailure,
// moved with it); imported below.

/**
 * The profiles shipped with the skill (`bridge/orchestrator-profiles.json`).
 * Resolved through the real path of this module because install.sh symlinks
 * the extension directory into ~/.humain-terminal/agent/extensions/.
 */
function shippedProfilesPath(): string {
	try {
		return join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "..", "orchestrator-profiles.json");
	} catch {
		return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "orchestrator-profiles.json");
	}
}

/** Where per-run logs land: `<STATE_ROOT>/runs/<runId>/`. */
function runsDir(): string {
	return join(expandedStateRoot, "runs");
}

// ARCHIVE_MANIFEST/describeRunArtifact moved to run/session.ts (pure; B4.6); imported below.

// Non-interactive runs (`--mode json -p`, CI, smoke tests) get a no-op UI whose
// `confirm()` always resolves false. Runs therefore auto-approve by default;
// `--interactive` explicitly opts in to the confirmation gates.

/**
 * The one Python spawner for this extension (C1 in the architecture review;
 * moved into adapters/orchestrator-cli.ts in B4.6): `loadDynamicAdapter`,
 * `runModule`, `planRun`, the RecordQueue runner, the session-ingest runner,
 * and the `/orchestrator-roi` handler all go through `orchestratorCli.cli()`
 * (never their own `spawn()` call). One env builder means every caller
 * consistently gets `CODING_AGENT_ORCHESTRATOR_HOME`, unlike the old
 * per-call-site `spawn()`s this replaces.
 */
const orchestratorCli = createOrchestratorCli({
	python: PYTHON,
	skillRoot: expandedSkillRoot,
	stateRoot: expandedStateRoot,
	defaultTimeoutMs: PYTHON_TIMEOUT_MS,
	baseEnv: liveEnv,
	extraEnv: PYTHON_EXTRA_ENV,
});
const orchestratorPythonCli = orchestratorCli.cli;
const runModule = orchestratorCli.runModule;
const planRun = orchestratorCli.planRun;
export { runModule };

// `dispatchTimeoutFor()` + LEAD_DISPATCH_TIMEOUT_MS lived here. Dropped in
// favour of main's progress-aware lead timeouts (`cb9f51e`): a flat per-
// capability ceiling is exactly what that change replaced, and
// ORCHESTRATING_CAPABILITIES now drives `opts.leadTimeouts` in
// runSubagentProcess instead.

// liveDispatchPids / guardChildStreamHandler / appendTrimmedEventLog moved to
// dispatch/child-process.ts (B4.5 step 5), the module that now owns spawning
// and stream handling for a dispatch; imported above and re-exported below
// for existing import sites.

// installDispatchReaper() moved to adapters/process-reaper.ts (B4.3); called
// below (activation) with the real liveDispatchPids set and runRegistry.active()/
// recordQueue as injected deps instead of module globals it reached into itself.

// PERSONA_TMP_PREFIX moved to dispatch/child-process.ts (B4.5 step 5), the
// only place that resolves a persona's prompt-file temp dir; imported above.
/**
 * Age after which an unclaimed persona temp dir is considered orphaned. Leads may
 * run up to the absolute ceiling (6h by default), but each prompt file is read
 * once when its child starts, so the TTL only needs to cover spawn.
 */
const PERSONA_TMP_TTL_MS = Math.max(2 * 60 * 60 * 1000, DISPATCH_TIMEOUT_MS * 6);
// reapOrphanedPersonaDirs() moved to adapters/process-reaper.ts (B4.3); called
// below (activation) with tmpdir()/PERSONA_TMP_PREFIX/PERSONA_TMP_TTL_MS as
// explicit parameters instead of module globals.

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the results. Replaces a bare `Promise.all` fan-out that spawned one
 * child process per task with no cap.
 */
// mapWithConcurrency moved to dispatch/parallel.ts (B4.5 step 5), alongside
// dispatchParallel (its only other caller besides the model-check probe
// below); imported above.

// confirmStep moved to run/ui-sink.ts (pure; B4.6), alongside safeUi; imported above.

// FALLBACK_ADAPTER, policyIdFor, loadDynamicAdapter, resolveAdapter (+ Adapter/
// FullResolution types) moved to adapters/adapter-resolver.ts (B4.3);
// FALLBACK_ADAPTER is now derived from bridge/orchestrator-profiles.json
// instead of hand-copied (see that module's doc comment). The wrappers below
// keep every call site unchanged while wiring the real Python CLI / profiles
// path / model registry in place of the adapter's injected parameters.

// Cohort tags (RunTags, core/records.ts, B4.1) and the alias table now live on
// each run's RunContext (run/context.ts, B4.4) instead of the module-level
// CURRENT_RUN_TAGS / CURRENT_ALIAS_TABLE globals this comment used to sit
// above. Every dispatch-path function below takes a `run: RunContext<RunSession> | null`
// parameter instead of reading them.

// ModelOverrides + emptyOverrides moved to core/args.ts (pure; B4.1); imported below.

// loadDynamicAdapter's local index.ts wrapper (`loadDynamicAdapterAdapter(orchestratorPythonCli())`)
// was dead code — `resolveAdapter` below calls adapters/adapter-resolver.ts's
// `loadDynamicAdapter` itself via `deps.dynamicCli` — and nothing else called
// the wrapper; deleted (B4.6).

// -----------------------------------------------------------------------------
// Profiles file I/O
// -----------------------------------------------------------------------------

type LoadedProfiles = ReturnType<typeof loadProfiles>;

function writeProfilesFile(file: ProfilesFile): void {
	writeProfilesFileAdapter(PROFILES_PATH, file);
}

/**
 * Load profiles. When the file does not exist but the legacy adapter file
 * does, migrate it into profile "default" once and write the new file, so the
 * user's existing bindings keep working under the new scheme.
 */
function loadProfiles() {
	return loadProfilesAdapter({
		profilesPath: PROFILES_PATH,
		legacyAdapterPath: LEGACY_ADAPTER_PATH,
		shippedProfilesPath,
	});
}

function availableModels(ctx: ExtensionContext): AvailableModel[] {
	try {
		return ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
	} catch {
		return [];
	}
}

/**
 * Build the capability -> model table for a run. Precedence, highest first:
 * flags > profile capabilities > profile tiers > dynamic resolver > fallback.
 * Problems in the profiles file are surfaced as warnings; an unresolvable spec
 * at a user layer is a warning the /orchestrate handler treats as fatal.
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
// LLM triage: cheapest-model pre-classification of task settings.
//
// When the user runs /orchestrate with no --task-class / --complexity / --risk,
// we dispatch a subagent at the cheapest available model to classify the goal
// before the real plan_run. This is Rule 3 ("cheapest sufficient") applied to
// the orchestrator's own front-end: spend ~300 tokens of human-m3-research-preview
// to save the user from filling in boilerplate.
//
// Returns null on any failure; the caller falls back to defaults.
// -----------------------------------------------------------------------------

// Triage vocabulary, prompt, heuristic classifier and JSON-verdict parsing
// moved to core/triage.ts (pure; B4.1). Re-exported below for existing
// import sites (index.test.ts imports `TriageResult`/`clampComplexity` from
// this module).

// -----------------------------------------------------------------------------
// Direct subagent subprocess
// -----------------------------------------------------------------------------
//
// The orchestrator previously invoked workers via `createSubagentTool(cwd)` from
// the subagent tool exported by @humain/terminal. That tool is wired for LLM-driven tool calls: it
// expects a fully-populated ExtensionContext with an active EventBus and a
// parent tool-call context. From inside an extension `registerCommand`
// handler, the context is partial — `tool.execute` returns a `details` object
// whose `results` array is empty in production, which silently produces the
// "leads: 0/0 succeeded, $0 cost" outcome the user observed.
//
// Spawning the Pi binary directly — the same binary, the same --mode json
// protocol, the same event stream that `executeSingleSubagent` parses —
// bypasses the context-shape mismatch. We already verified that
// `humain-terminal --mode json -p --no-session <task>` returns real
// assistant message_end events with model, input/output tokens, and cost.
// That path is the one we replicate here.

// The `ChildSpawner` seam this branch added here is deliberately NOT duplicated:
// main declares a byte-identical alias further down (`cc9836d`), which is the
// shape `f2ddaa6` adopted precisely so this merge would converge. Two aliases
// would be a duplicate-identifier error; the one below serves both call sites.
// `reportedCost` moved into dispatch/child-events.ts (B4.5 step 3), the one
// place it's called from now.

// SubagentProcessResult moved to dispatch/child-process.ts (B4.5 step 5);
// imported below for the few places in this file that still name it.

// orchCliInvocation moved to dispatch/child-process.ts (B4.5 step 5), its
// only caller.

// -----------------------------------------------------------------------------
// Run session: live progress board + per-run log files
// -----------------------------------------------------------------------------
//
// RunSession, DispatchProgress, WorktreeInfo/detectWorktree, OrchestratorStatus
// and formatOrchestratorStatus moved to run/session.ts + run/board.ts (B4.6):
// the mutable per-run bookkeeping and the pure status-bar/widget-line view are
// now their own modules, neither of which imports this one. The subclass below
// is the one place that supplies the two things RunSession used to read from
// module state directly — the runs directory and the telemetry queue's
// counters at start — as injected `RunSessionDeps`, so every existing
// `new RunSession(runId, ctx, goal, cwd?)` call site (including
// index.test.ts's) keeps working unchanged.
export class RunSession extends RunSessionCore {
	constructor(runId: string, ctx: ExtensionContext, goal: string, cwd: string = process.cwd()) {
		const deps: RunSessionDeps = {
			runsDir,
			telemetrySnapshot: () => recordQueue.snapshot(),
		};
		super(runId, ctx, goal, cwd, deps);
	}
}


// NO_PERSONA moved to dispatch/child-process.ts (B4.5 step 5); imported above.

/**
 * Owns "the one active run" for this extension: only one /orchestrate (or the
 * model-check probe) may be live at a time. The one piece of module state this
 * file keeps for run-scoped data (B4.4) — everywhere else in the dispatch path
 * (dispatchParallel, runVerification, triageTask, dispatchHierarchical, the
 * telemetry onError, ...) receives the RunContext it needs as an explicit
 * parameter instead of reading this registry. Only wiring code with no context
 * of its own to thread through — the orchestrator_status tool, the
 * signal/shutdown hooks, /orchestrate-cancel, /omsg — calls `runRegistry.active()`
 * directly. Exported so tests can drive claim()/release()/setForTest() directly
 * instead of the old activeRunForTest()/setActiveRunForTest() free functions.
 */
export const runRegistry = new RunRegistry<RunSession>();

// formatOrchestratorStatus moved to run/board.ts (pure; B4.6); imported above.

// registerOrchestratorStatusTool moved to tools/status.ts (B4.6); imported below.

// ChildSpawner / StderrTarget / reserveFallbackName / openStderrTarget moved
// to dispatch/child-process.ts (B4.5 step 5), runSubagentProcess's only
// caller of any of them.

/**
 * Spawn Pi as a one-shot subagent (dispatch/child-process.ts, B4.5 step 5).
 * Re-exported under its original name/signature so every existing test and
 * production call site (`orchestrator.runSubagentProcess`, `dispatchParallel`,
 * `triageTask`, the model-check probe, ...) is unchanged. This wrapper is the
 * one place that supplies the real `recordEvent` (index.ts's telemetry
 * singleton) and `env` (`config.ts`'s `liveEnv`) as defaults for
 * dispatch/child-process.ts's optional `opts.recordEvent`/`opts.env` seams,
 * so dispatch/* itself never has to import index.ts.
 *
 * `session` also falls back to `runRegistry.active()?.session` when the
 * caller omits it (matching the pre-B4.4 `opts.session ?? ACTIVE_RUN`
 * behaviour): every in-tree production caller now threads its own
 * `RunContext.session` explicitly, but this exported wrapper is also a
 * public extension API — an external caller (or a test) that dispatches
 * without a session should still land on whatever run is active, not lose
 * its progress board/diagnostics/cancellation silently.
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


/**
 * Classify the goal with the cheapest capability (pipeline/triage-step.ts,
 * B4.6). Re-exported under its original name so every existing call site
 * and test (`orchestrator.triageTask` is not itself part of the public
 * surface, but the /orchestrate handler below is) is unchanged. This
 * wrapper is the one place that supplies the real `runSubagentProcess`/
 * `captureDispatchCost` as `TriageDeps`, so pipeline/* never has to import
 * index.ts.
 */
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

// slugGoal was dead code (nothing called it) — deleted (B4.6).

// -----------------------------------------------------------------------------
// Python CLI bridge
// -----------------------------------------------------------------------------

// CliResult, runModule, PlanOptions and planRun moved to
// adapters/orchestrator-cli.ts (B4.6); imported above as `orchestratorCli`'s
// `runModule`/`planRun` (re-bound to this file's config).

// -----------------------------------------------------------------------------
// Plan + route types
// -----------------------------------------------------------------------------

// PlanResponse moved to core/prompts.ts (pure type; B4.1); imported below.

// -----------------------------------------------------------------------------
// Telemetry: batched event/metric/outcome records
// -----------------------------------------------------------------------------

/**
 * One queue for the whole extension. Records are stamped with a stable id at
 * enqueue time and sent to `orchestrator.cli batch -` in bounded batches; see
 * record-queue.ts for the coalescing/retry contract. Every failure is logged to
 * the console and to the active run's log; terminal flushes also return it.
 * Other runtimes keep using the single-record `event`/`metric`/`outcome` commands.
 */
const telemetry = createTelemetry({
	runBatch: (records) => runModule("orchestrator.cli", ["batch", "-"], JSON.stringify(records)),
	maxBatch: TELEMETRY_MAX_BATCH,
	flushDelayMs: TELEMETRY_FLUSH_MS,
	onError: (message) => {
		console.warn(`[orchestrator] ${message}`);
		// No RunContext to thread through here: `telemetry` is a module-level
		// singleton created once at load, long before any run exists, and its
		// onError can fire during any run or between runs. That is exactly the
		// "no context naturally available" case the architecture review carves
		// out for `runRegistry.active()` (B4.4) — same behaviour as the old
		// `ACTIVE_RUN?.log(...)`: log into whichever run is current right now, if any.
		runRegistry.active()?.session.log(`telemetry: ${message}`);
	},
});
export const recordQueue = telemetry.queue;
export const recordEvent = telemetry.recordEvent;
export const recordModelCall = telemetry.recordModelCall;
/** Terminal run outcomes go through completeRun/failRun, which also drain. */
export const recordOutcome = telemetry.recordOutcome;

// qaVerificationOutcomeFor moved to pipeline/verify-loop.ts (pure; B4.6); imported below.

// runCompletionOutcomeFor moved to core/records.ts (pure; B4.6); imported below.

// RunTiming moved to run/session.ts (pure type; B4.6); imported above.

// completeRun/failRun/reportSince moved to run/finalize.ts (B4.6): they read
// the active run through `runRegistry` and drain `recordQueue`, both of
// which are wired here instead of being read as module globals inside that
// file (`run/*` must not import index.ts).
const runFinalizer = createRunFinalizer({
	runRegistry,
	recordEvent,
	recordOutcome,
	recordQueue,
});
export const completeRun = runFinalizer.completeRun;
export const failRun = runFinalizer.failRun;

/**
 * Summary lines when telemetry did not fully land; empty when all is well. Lost records
 * and durable-but-unrefreshed records are different problems and are worded differently.
 */
// telemetryWarning/telemetryHealthy moved to record-queue.ts (pure; B4.6); imported below.
// warnTelemetry moved into commands/orchestrate.ts (B4.6), its only caller.

// -----------------------------------------------------------------------------
// Subagent dispatch
// -----------------------------------------------------------------------------

/**
 * Dispatch a batch of tasks in parallel (dispatch/parallel.ts, B4.5 step 5).
 * Re-exported under its original name/signature so every existing call site
 * and test (`orchestrator.dispatchParallel`) is unchanged. This wrapper is
 * the one place that supplies the real `recordEvent`/`runSubagentProcess`/
 * `MAX_CONCURRENT_DISPATCHES` as defaults for dispatch/parallel.ts's
 * required `deps`, so dispatch/* itself never has to import index.ts.
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

// agentNameFor moved to dispatch/parallel.ts (B4.5 step 5), alongside
// CAPABILITY_AGENT_ALIASES and dispatchParallel, its only caller; imported
// above and re-exported below for existing import sites (tests call
// `orchestrator.agentNameFor` directly).

// formatTaskPrompt moved to core/prompts.ts (pure; B4.1); imported below.


// gitDirtySnapshot, diffDirtySnapshots, gitHead, changedFilesSinceRunStart,
// parseFilesChanged, looksLikeFilePath and their fingerprint constants moved to
// adapters/git-changes.ts (B4.3; pure git-diff I/O, no module globals). Imported
// above and re-exported below for existing import sites.

// -----------------------------------------------------------------------------
// Model routing for the executed path
// -----------------------------------------------------------------------------

/**
 * Pick the model for a dispatch. Honors the recommended capability by default.
 * On retry (escalation) of a review capability, applies method.json Rule 1
 * (`rules.review_after_fix`): the re-review must run at or above the risk's
 * `tier_min`, and never on a prohibited tier. Each further retry bumps one
 * more tier so a persistent failure walks up to premium.
 *
 * Tier detection works on the model-id substring (see classifyTier). If a
 * model id doesn't match any known token, we leave it unchanged — the
 * adapter's pick already satisfies the floor because the dynamic adapter
 * routes reviews to mid-or-higher by default.
 */
// pickModel + cheapestAtTier moved to core/routing.ts (pure; B4.1).


// -----------------------------------------------------------------------------
// Cost capture + executed-route emission
// -----------------------------------------------------------------------------

// CaptureOpts, dispatchRecordsFor, methodEffortFor, runTagFields, leadSelfImplemented
// moved to core/records.ts (pure; B4.1). dispatchRecordsFor now takes the run's
// tags as an explicit parameter instead of reading a global itself; the caller
// below passes `run?.tags` (B4.4: RunContext, not CURRENT_RUN_TAGS), so
// behaviour is unchanged.

// captureDispatchCost moved to run/finalize.ts (B4.6) as `createDispatchCostCapture`,
// bound here to the real `recordModelCall`.
const captureDispatchCost = createDispatchCostCapture(recordModelCall);

// sumUsage moved to dispatch/parallel.ts (B4.5 step 5), its only caller.

// VerificationResult, qaVerificationOutcomeFor, runVerification and
// parseFailedChecks moved to pipeline/verify-loop.ts (B4.6); imported below.


// planEscalation now lives in escalation.ts as a pure, independently tested
// module (see BUG 2 fix note there): it keeps the original lead task/prompt
// intact on retry instead of substituting the failed lead's report, retries
// every lead the failure is or might be attributable to (not just lead 0),
// and stops at the caller's own `maxRetries` instead of a hard-coded 2.

// -----------------------------------------------------------------------------
// Hierarchical dispatch
// -----------------------------------------------------------------------------

// dispatchHierarchical, dispatchReconAndLeads, collectBilledResults and
// summarizeReconWorkers moved to pipeline/hierarchy.ts (B4.6); imported below.
// dispatchHierarchical dropped the `escalationResults: []` field it used to
// return for the verify/retry loop below to push into after the fact (a
// mutable sink smuggled through a return value) — the loop now owns and
// returns its own `escalationResults` array instead.

/**
 * Parent-owned recon/lead sequencing (pipeline/hierarchy.ts, B4.6). Re-exported
 * under its original name/signature so every existing call site and test
 * (`orchestrator.dispatchReconAndLeads`) is unchanged: this wrapper is the one
 * place that supplies config.ts's `MAX_LEADS`/`RECON_EVIDENCE_MAX_CHARS` as
 * defaults for the core function's required `maxLeads`/`evidenceMaxChars`, so
 * pipeline/* itself never has to read them from a module singleton.
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
// Argument parsing
// -----------------------------------------------------------------------------

// OrchestrateArgs, parseArgs, newOrchestrateArgs, consumeFlag moved to
// core/args.ts (pure; B4.1); imported below.

// goalExpectsInteraction moved into commands/orchestrate.ts (B4.6), its only caller.

/**
 * Live check: one cheap probe per distinct configured model, through the exact
 * spawn path /orchestrate uses (same --provider/--model split, same env). Proves
 * auth + routing and that the model that answered is the one the table names —
 * an unauthenticated provider or wrong-region alias fails here for cents
 * instead of mid-run for dollars. Judged on "the model answered as itself", not
 * on reply text: personas rewrite replies into report formats.
 */
async function checkModels(ctx: ExtensionContext, resolved: ResolvedAdapter): Promise<boolean> {
	const alreadyActive = runRegistry.active();
	if (alreadyActive) {
		ctx.ui.notify(`An orchestration is already running (${alreadyActive.session.runId}); try again when it finishes.`, "warning");
		return false;
	}
	const byModel = new Map<string, string[]>();
	for (const [cap, b] of Object.entries(resolved.adapter)) {
		byModel.set(b.model, [...(byModel.get(b.model) ?? []), cap]);
	}
	const session = new RunSession(`model-check-${Date.now()}`, ctx, "model check");
	// No await ran between the guard above and here, so nothing else could have
	// claimed the registry in between; claim() cannot fail. Kept as a real check
	// (not a `!` assertion) for symmetry with the /orchestrate handler's own
	// claim, and so this stays correct if that ever stops being true.
	const claimed = runRegistry.claim(session);
	if (!claimed) {
		ctx.ui.notify(`An orchestration is already running (${runRegistry.active()!.session.runId}); try again when it finishes.`, "warning");
		session.close();
		await session.sealDiagnostics();
		session.finish();
		return false;
	}
	session.setPhase(`probing ${byModel.size} distinct model(s)`);
	try {
		const probes = await mapWithConcurrency([...byModel.entries()], MAX_CONCURRENT_DISPATCHES, async ([model, caps]) => {
			const r = await runSubagentProcess({
				cwd: process.cwd(),
				agentName: NO_PERSONA,
				task: "Connectivity check. Reply with the single word OK.",
				model,
				tools: ["read"],
				ctx,
				taskId: `probe-${shortName(model)}`,
				label: shortName(model),
				session,
			});
			const replied = (r.finalText || r.stdout).trim();
			const expectedId = model.slice(model.indexOf("/") + 1);
			const servedBy = r.model;
			const idMatches =
				!servedBy || servedBy === expectedId || expectedId.endsWith(servedBy) || servedBy.endsWith(expectedId) || shortName(servedBy) === shortName(model);
			const ok = r.exitCode === 0 && replied.length > 0;
			return { model, caps, ok, idMatches, servedBy, replied, r };
		});

		const lines = probes.map((p) => {
			const mark = p.ok && p.idMatches ? "✓" : p.ok ? "⚠" : "✗";
			const detail = p.ok
				? p.idMatches
					? `${fmtElapsed(p.r.durationMs)}, $${p.r.costUsd.toFixed(4)}, served by ${p.servedBy ?? "(unreported)"}`
					: `answered, but served by ${p.servedBy} (expected ${p.model.slice(p.model.indexOf("/") + 1)})`
				: `exit ${p.r.exitCode}: ${summarizeStderr(p.r.stderr, 160) || "(no output)"}`;
			return [`${mark} ${p.model}`, `    ${detail}`, `    used by: ${p.caps.join(", ")}`].join("\n");
		});
		const failed = probes.filter((p) => !p.ok).length;
		const total = probes.reduce((s, p) => s + p.r.costUsd, 0);
		const summary = [
			`Live model check: ${probes.length - failed}/${probes.length} model(s) answered · $${total.toFixed(4)}`,
			...lines,
			...(failed > 0 ? ["", `Fix the failing binding(s) with /orchestrator-models set <capability|tier> <alias>, or pass --frontier/--premium/--mid/--cheap/--model; /orchestrate would abort on these.`] : []),
			`log: ${session.file("run.log")}`,
		];
		session.log(summary.join("\n"));
		ctx.ui.notify(summary.join("\n"), failed > 0 ? "error" : "info");
		return failed === 0;
	} finally {
		try {
			session.close();
			await session.sealDiagnostics(); // bounded drain; no terminal outcome means no seal
		} finally {
			runRegistry.release(claimed);
			session.finish();
		}
	}
}

const USAGE = usageText(PROFILES_PATH);

// MODELS_USAGE moved into commands/orchestrator-models.ts's buildModelsUsage() (B4.6).

// -----------------------------------------------------------------------------
// Extension entry point
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Automatic session-usage ingestion (hooks)
// -----------------------------------------------------------------------------

// redactPaths, recordHookFailure, registerSessionIngestHooks and
// installSessionIngest moved to hooks/ingest.ts (B4.6); imported below.

// installTelemetryDrain moved to hooks/shutdown.ts (B4.6), alongside the
// signal-driven dispatch reaper; imported below as installShutdownHooks.

// postRunMessage moved into commands/orchestrate.ts (B4.6), its only caller.

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


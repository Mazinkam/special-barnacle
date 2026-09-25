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

import { RunDiagnostics, appendDiagnosticPath, type DiagnosticWriter } from "./run-diagnostics.ts";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// TypeBox 1.x: `Type` is a namespace (`Type.Object`, `Type.Array`, ...);
// the validation function moved to a separate `typebox/value` module.
import { Type } from "typebox";

import {
	type ExtensionAPI,
	type ExtensionContext,
	type SubagentSingleResult,
} from "@humain/terminal";

import {
	ALL_CAPABILITIES,
	type AvailableModel,
	buildAliasTable,
	DEFAULT_PROVIDER_PREFERENCE,
	formatAdapterTable,
	isThinkingLevel,
	isTier,
	listShortcuts,
	METHOD,
	PROFILE_NAME_RE,
	type ProfileSpec,
	type ProfilesFile,
	rereviewFloor,
	resolveAlias,
	type ResolvedAdapter,
	shortName,
	THINKING_LEVELS,
	type Tier,
	TIER_CAPABILITIES,
	tierIndex,
	tierOf,
	tierOfModel,
	TIERS,
	type LeadSize,
	userLayerWarnings,
} from "./models.ts";
import { parseLeadAssignments, planLeadWaves, type LeadAssignment } from "./lead-plan.ts";
import { classifyRunOutcome, externalChangeFiles, parseLeadStatus } from "./run-outcome.ts";
import { SpendCapTracker } from "./spend-cap.ts";
import { NestedCostTracker } from "./nested-cost.ts";
import { escalateLeadCapability, isLeadCapability, isLeadSize, leadSizeOf, sizeLead, type LeadSizeDecision } from "./lead-sizing.ts";
import { planEscalation, type EscalationLeadInput } from "./escalation.ts";
import { ingestArgs, SessionIngestScheduler } from "./ingest.ts";
import { summarizeStderr } from "./dispatch/stderr-sink.ts";
import { RunCancellation } from "./cancellation.ts";
import { type ChildEventDelta } from "./dispatch/child-events.ts";
import {
	runSubagentProcess as runSubagentProcessCore,
	NO_PERSONA,
	PERSONA_TMP_PREFIX,
	liveDispatchPids,
	guardChildStreamHandler,
	appendTrimmedEventLog,
} from "./dispatch/child-process.ts";
export { guardChildStreamHandler, appendTrimmedEventLog };
import {
	dispatchParallel as dispatchParallelCore,
	mapWithConcurrency,
	agentNameFor,
} from "./dispatch/parallel.ts";
export { agentNameFor };
import { applyObservation, applyWarnings, createProgressView, fmtElapsed, formatNestedWorkerRows, formatProgressLine, formatWarningLine, spinnerFrame } from "./run-ui.ts";
import type { DispatchProgressView } from "./run-ui.ts";
import type { ProgressObservation, TimeoutCheck } from "./dispatch-progress.ts";
import { type FlushReport, type QueueStats } from "./record-queue.ts";
// Rule-2 recon planning/evidence helpers (pure; see recon.ts). `dispatchHierarchical()`
// dispatches these as ordinary parent-owned tasks through the existing
// `dispatchParallel()` path. `DispatchTask` below is declared independently;
// `ReconTaskPlan` is structurally assignable to it, which the annotated
// `const reconTasks: DispatchTask[] = planReconTasks(...)` checks at compile
// time, so a planned recon task still needs no conversion step.
import { formatReconEvidence, planReconTasks } from "./recon.ts";
import { createPythonCli } from "./adapters/python-cli.ts";
import { installDispatchReaper, reapOrphanedPersonaDirs } from "./adapters/process-reaper.ts";
import { createTelemetry } from "./adapters/telemetry.ts";
import {
	type Adapter,
	FALLBACK_ADAPTER,
	type FullResolution,
	loadDynamicAdapter as loadDynamicAdapterAdapter,
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
	looksLikeFilePath,
} from "./adapters/git-changes.ts";
import contract from "./contract.json";

// Pure logic split out of this file per docs/architecture-review.md B4.1.
// `core/*` never imports this module and never reads `process.env`; every
// value it needs (run tags, max-lead ceilings, ...) is a parameter.
import { emptyOverrides, type ModelOverrides, parseArgs, usageText } from "./core/args.ts";
import { loadBridgeConfig, liveEnv } from "./config.ts";
import { clampComplexity, parseTriageResponse, TRIAGE_PROMPT, type TriageResult } from "./core/triage.ts";
import { pickModel } from "./core/routing.ts";
import {
	type CaptureOpts,
	type DispatchResult,
	dispatchRecordsFor,
	leadSelfImplemented,
	methodEffortFor,
} from "./core/records.ts";
import {
	architectPrompt,
	complexityNeedsArchitect,
	type DispatchTask,
	effectiveLeadCount,
	LEAD_DELEGATION_RULE,
	LEAD_STATUS_CONTRACT,
	leadPrompt,
	type PlanResponse,
	QA_SCOPE_RULES,
} from "./core/prompts.ts";
import { verificationVerdictFor } from "./core/report.ts";

// RunContext/RunRegistry replace the ACTIVE_RUN / CURRENT_RUN_TAGS /
// CURRENT_ALIAS_TABLE globals (B4.4; run/context.ts never imports this module).
import { RunRegistry, type RunContext } from "./run/context.ts";
import { safeUi } from "./run/ui-sink.ts";

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
// Match absolute paths under common user homes so the bounded Status Contract
// `error` field never leaks filesystem locations. Mirrors the redaction the
// Python CLI applies when writing `ingest_status.json`. Deliberately not the same
// regex as the Python side (`orchestrator/contract.json`'s `redaction_regex._todo`
// explains why); this side reads its own key from the shared contract.
const PATH_RE = new RegExp(contract.redaction_regex.ts, "g");
export function redactPaths(text: string): string {
	return text.replace(PATH_RE, "<path>");
}

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

/** Manifest `python3 -m orchestrator.cli archive-runs --execute` leaves next to a run's `<name>.gz` files. */
const ARCHIVE_MANIFEST = "archive.manifest.json";

/**
 * Where a run diagnostic can be read *now*. The opt-in `archive-runs --execute` command replaces
 * the diagnostics of old completed runs with `<name>.gz` + a manifest (`run.log` itself is never
 * archived), so a path remembered from the progress board or an old notification may no longer
 * exist as-is. Returns the path unchanged while it is readable; otherwise a lookup/restore hint
 * instead of a silently broken link.
 */
export function describeRunArtifact(path: string): string {
	if (existsSync(path)) return path;
	const runDir = dirname(path);
	const name = basename(path);
	const archived = join(runDir, `${name}.gz`);
	let listed = false;
	try {
		const manifest = JSON.parse(readFileSync(join(runDir, ARCHIVE_MANIFEST), "utf-8"));
		listed = manifest?.format_version === 1 && typeof manifest?.files?.[name] === "object";
	} catch {
		/* no readable manifest: the file was never archived by us */
	}
	if (listed && existsSync(archived)) {
		return `${path} (archived as ${archived} — read with \`gunzip -c\`, or restore the run with \`python3 -m orchestrator.cli restore-run ${basename(runDir)}\`)`;
	}
	return `${path} (missing)`;
}

// Non-interactive runs (`--mode json -p`, CI, smoke tests) get a no-op UI whose
// `confirm()` always resolves false. Runs therefore auto-approve by default;
// `--interactive` explicitly opts in to the confirmation gates.

/**
 * The one Python spawner for this extension (C1 in the architecture review):
 * `loadDynamicAdapter`, `runModule`, `planRun`, the RecordQueue runner, the
 * session-ingest runner, and the `/orchestrator-roi` handler all build one of
 * these (never their own `spawn()` call) and go through `.run()`. One env
 * builder means every caller now consistently gets
 * `CODING_AGENT_ORCHESTRATOR_HOME`, unlike the old per-call-site `spawn()`s
 * this replaces.
 *
 * Built fresh per call rather than once at module load: `spawn` here is a
 * bare reference to the `node:child_process` import, re-read at the moment
 * this function runs. A module-level singleton would instead capture
 * whatever `spawn` resolved to at import time, permanently missing any
 * later `spyOn(childProcess, "spawn")` (index.test.ts installs several).
 * `pythonOverride` is `runModule`'s test-only `python` option.
 */
function orchestratorPythonCli(pythonOverride?: string) {
	return createPythonCli({
		python: pythonOverride ?? PYTHON,
		skillRoot: expandedSkillRoot,
		stateRoot: expandedStateRoot,
		spawn,
		defaultTimeoutMs: PYTHON_TIMEOUT_MS,
		baseEnv: liveEnv(),
		extraEnv: PYTHON_EXTRA_ENV,
	});
}

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

export async function confirmStep(
	ctx: ExtensionContext,
	title: string,
	message: string,
	requireConfirmation = false,
): Promise<boolean> {
	if (!requireConfirmation) {
		ctx.ui.notify(`${title} — auto-confirmed (default mode)`, "info");
		return true;
	}
	if (!ctx.hasUI) {
		// An interactive request cannot be answered in a headless session.
		ctx.ui.notify(`${title}: no UI to confirm — remove --interactive to run automatically`, "error");
		return false;
	}
	return ctx.ui.confirm(title, message);
}

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

async function loadDynamicAdapter(): Promise<{ adapter: Adapter; warning?: string }> {
	return loadDynamicAdapterAdapter(orchestratorPythonCli());
}

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

interface DispatchProgress {
	taskId: string;
	label: string;
	model: string;
	startedAt: number;
	endedAt?: number;
	turns: number;
	toolCalls: number;
	lastActivity: string;
	/** Last few activity strings, newest at the end; rendered as a dim sub-line. */
	activityTail: string[];
	costUsd: number;
	/** Running spend of this dispatch's own subagent calls. */
	nestedCostUsd: number;
	status: "running" | "done" | "failed" | "cancelled";
	/** Nesting depth (0 = top-level dispatch, 1 = child of a lead, …). */
	depth: number;
	progress: DispatchProgressView;
	lastLoggedProgressDetail?: string;
	lastLoggedProgressAt?: number;
	/** Most recent tool name this dispatch invoked. `lastActivity` gets overwritten by
	 *  assistant turn summaries ("turn N done (...)"), so it can't answer "what tool is
	 *  it running now" — this field is set only from tool events and never cleared by them. */
	lastTool?: string;
}

const MAX_ACTIVITY_TAIL = 4;

// fmtElapsed merged into run-ui.ts (identical implementation; B4.1); imported above.

function shortArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const pick =
		(typeof a.command === "string" && a.command) ||
		(typeof a.path === "string" && a.path) ||
		(typeof a.pattern === "string" && a.pattern) ||
		(typeof a.agent === "string" && `agent=${a.agent}`) ||
		(Array.isArray(a.tasks) && `${a.tasks.length} tasks`) ||
		(typeof a.task === "string" && a.task) ||
		"";
	const s = String(pick).replace(/\s+/g, " ").trim();
	return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}

/**
 * Detect the git worktree the orchestrator is running in. Cheap: two short
 * `git` invocations cached at session start. Returns null when `cwd` is not
 * inside a git worktree so callers can fall back gracefully.
 */
export interface WorktreeInfo {
	root: string;
	branch: string;
	shortBranch: string;
	name: string;
}

function detectWorktree(cwd: string): WorktreeInfo | null {
	try {
		const rootR = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8", timeout: 5000,
		});
		if (rootR.status !== 0 || !rootR.stdout.trim()) return null;
		const root = rootR.stdout.trim();
		const branchR = spawnSync("git", ["-C", cwd, "branch", "--show-current"], {
			encoding: "utf-8", timeout: 5000,
		});
		const branch = branchR.status === 0 ? branchR.stdout.trim() : "";
		return {
			root,
			branch,
			shortBranch: branch || "(detached)",
			name: basename(root),
		};
	} catch {
		return null;
	}
}

/** Hard cap on buffered user messages so a chatty operator can't blow context. */
const MAX_QUEUED_MESSAGES = 10;
/** Soft per-message cap in characters; longer messages are truncated in the
 *  prompt but preserved in full in run.log. */
const MAX_MESSAGE_CHARS = 1500;

/**
 * One /orchestrate invocation. Owns the widget/status lines the user sees while
 * children run, and the on-disk log under `<STATE_ROOT>/runs/<runId>/`:
 *
 *   run.log                     human-readable timeline (phases, dispatches, verdicts)
 *   <taskId>.prompt.md          exact task prompt sent to the child
 *   <taskId>.events.jsonl       the child's raw --mode json stream
 *   <taskId>.stderr.log         the child's stderr
 *
 * Before this, the only trace of a run was the aggregate metrics row, so a
 * 20-minute silent dispatch could not be inspected while it ran or after.
 */
/** Point-in-time snapshot of a live `/orchestrate` run, returned by `RunSession.statusSnapshot()`
 *  and the `orchestrator_status` tool. Deliberately UI-agnostic (no ANSI, no widget lines) so it
 *  can be consumed by the LLM (as tool `details`) or a human (via `formatOrchestratorStatus`). */
export interface OrchestratorStatus {
	runId: string;
	phase: string;
	elapsedMs: number;
	totalCostUsd: number;
	dispatches: Array<{
		label: string;
		model: string;
		status: "running" | "done" | "failed" | "cancelled";
		elapsedMs: number;
		turns: number;
		lastTool?: string;
		costUsd: number;
	}>;
	recentLog: string[];
}

// safeUi moved to run/ui-sink.ts (pure, no globals; B4.4); imported above.

export class RunSession {
	readonly runId: string;
	readonly ctx: ExtensionContext;
	readonly goal: string;
	readonly dir: string;
	/** Git worktree the run is operating in (null when cwd isn't git-tracked). */
	readonly worktree: WorktreeInfo | null;
	private readonly dispatches = new Map<string, DispatchProgress>();
	private phase = "starting";
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly startedAt = Date.now();
	// The ISO stamp for the ledger is derived from the same wall-clock read as `startedAt`, and
	// elapsed time uses a monotonic origin: `Date.now()` can step (NTP, sleep/wake) mid-run, so
	// the duration written to outcomes must never be derived from two wall-clock reads.
	private readonly startedAtIso = new Date(this.startedAt).toISOString();
	private readonly startedMono = performance.now();
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	readonly cancellation = new RunCancellation();
	/** Reason the run was cancelled, set by `cancel()`. Distinguishes a user-initiated
	 *  cancel (post a summary message to chat) from a session shutdown (do not). */
	private _cancelReason: "user" | "shutdown" | "signal" | undefined;
	get cancelReason(): "user" | "shutdown" | "signal" | undefined {
		return this._cancelReason;
	}
	/** The detached background promise started by the `/orchestrate` handler after its
	 *  synchronous prelude returns. Set once, right before the handler returns; awaited
	 *  by `session_shutdown` and by tests that need the run to have fully settled. */
	runPromise?: Promise<void>;
	/** Per-dispatch spend cap (method.json rules.dispatch_spend_cap). Replaceable in tests. */
	spendCaps = new SpendCapTracker();
	/** User messages queued while a run is live; drained at the next dispatch boundary. */
	private queuedMessages: Array<{ text: string; queuedAt: number }> = [];
	/** History of message batches we've folded into prompts, so the user can see delivery. */
	private deliveryLog: Array<{ count: number; to: string; ts: number }> = [];
	readonly diagnostics: RunDiagnostics;
	private terminalAcknowledged = false;
	private resolveFinished!: () => void;
	/** Resolves after the command's producers, terminal telemetry and cleanup have settled. */
	readonly finished = new Promise<void>(resolve => { this.resolveFinished = resolve; });

	finish(): void { this.resolveFinished(); }
	/**
	 * Telemetry counters when this run started. The terminal summary reports every record
	 * failure since then — including timer flushes that failed mid-run — not just the final drain.
	 */
	readonly telemetryBaseline: QueueStats = recordQueue.snapshot();

	constructor(runId: string, ctx: ExtensionContext, goal: string, cwd: string = process.cwd()) {
		this.runId = runId;
		this.ctx = ctx;
		this.goal = goal;
		this.dir = join(runsDir(), runId);
		this.diagnostics = new RunDiagnostics(this.dir, runId);
		this.worktree = detectWorktree(cwd);
		try {
			mkdirSync(this.dir, { recursive: true });
		} catch (err) {
			console.warn(`[orchestrator] could not create run dir ${this.dir}: ${(err as Error).message}`);
		}
		this.log(`run ${runId} started`);
		this.log(`goal: ${goal}`);
		if (this.worktree) {
			this.log(`worktree: ${this.worktree.root} [${this.worktree.shortBranch}]`);
		}
		// Elapsed counters must tick even when a child is silent — a frozen board
		// is indistinguishable from a hung run, which is the complaint that led here.
		this.tickTimer = setInterval(() => safeUi(() => this.render()), 1000);
	}

	/**
	 * Append a user message to be delivered to the next dispatched task. Returns
	 * the new queue depth. We drain on dispatch — never mid-flight — because
	 * the subprocess protocol (humain-terminal --mode json --no-session) has no
	 * stdin injection channel.
	 */
	enqueueMessage(text: string): number {
		const trimmed = text.trim();
		if (!trimmed) return this.queuedMessages.length;
		const capped = trimmed.length > MAX_MESSAGE_CHARS
			? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}…`
			: trimmed;
		if (this.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
			this.queuedMessages.shift();
		}
		this.queuedMessages.push({ text: capped, queuedAt: Date.now() });
		this.log(`user message queued (depth=${this.queuedMessages.length}): ${capped.slice(0, 200)}`);
		this.render();
		return this.queuedMessages.length;
	}

	/**
	 * Atomically return queued messages and clear the queue, recording the
	 * delivery in the run's delivery log. Returns [] when nothing queued.
	 */
	drainMessages(recipient: string): string[] {
		if (this.queuedMessages.length === 0) return [];
		const msgs = this.queuedMessages.map((m) => m.text);
		this.deliveryLog.push({
			count: msgs.length,
			to: recipient,
			ts: Date.now(),
		});
		// Keep the delivery log bounded.
		if (this.deliveryLog.length > 20) this.deliveryLog.splice(0, this.deliveryLog.length - 20);
		this.queuedMessages.length = 0;
		this.log(`delivered ${msgs.length} user message(s) to ${recipient}`);
		this.render();
		return msgs;
	}

	/** Number of currently queued (undelivered) messages. */
	queuedDepth(): number {
		return this.queuedMessages.length;
	}

	file(name: string): string {
		return join(this.dir, name);
	}

	writeDiagnostic(name: string, text: string): boolean {
		return this.diagnostics.write(name, text);
	}

	acknowledgeTerminal(ok: boolean): void {
		this.terminalAcknowledged = ok;
	}

	async sealDiagnostics(terminal = Promise.resolve(this.terminalAcknowledged)): Promise<boolean> {
		const sealed = await this.diagnostics.seal(terminal);
		if (!sealed) safeUi(() => this.ctx.ui.notify(
			`Diagnostics remain UNSEALED and archive-ineligible: producer drain/terminal acknowledgement did not complete or sealing failed. Raw diagnostics retained: ${this.dir}`,
			"warning",
		));
		return sealed;
	}

	/**
	 * Time fields recorded at the run's terminal boundary (complete/fail/cancel/crash).
	 * `elapsed_ms` is monotonic and clamped at zero; consumers treat a run without these
	 * fields as "duration unknown", never as zero.
	 */
	terminalTiming(): RunTiming {
		return {
			started_at: this.startedAtIso,
			finished_at: new Date().toISOString(),
			elapsed_ms: Math.max(0, Math.round(performance.now() - this.startedMono)),
			elapsed_source: "monotonic",
		};
	}

	cancel(reason: "user" | "shutdown" | "signal" = "user"): void {
		if (this.cancellation.isCancelled) return;
		this._cancelReason = reason;
		this.phase = "cancelling";
		this.log(`cancellation requested (${reason})`);
		this.cancellation.cancel();
		this.render();
	}

	log(line: string): void {
		const stamped = `${new Date().toISOString()} ${line}`;
		try {
			this.diagnostics.write("run.log", `${stamped}\n`, true);
		} catch {
			/* log dir unavailable; the UI still gets the line */
		}
	}

	setPhase(phase: string, notify = true): void {
		this.phase = phase;
		this.log(`phase: ${phase}`);
		if (notify) safeUi(() => this.ctx.ui.notify(`[${fmtElapsed(Date.now() - this.startedAt)}] ${phase}`, "info"));
		safeUi(() => this.render());
	}

	startDispatch(taskId: string, label: string, model: string, depth: number = 0): void {
		const now = Date.now();
		this.dispatches.set(taskId, {
			taskId,
			label,
			model,
			startedAt: now,
			turns: 0,
			toolCalls: 0,
			lastActivity: "starting",
			activityTail: ["starting"],
			costUsd: 0,
			nestedCostUsd: 0,
			status: "running",
			depth,
			progress: createProgressView(now),
		});
		this.log(`dispatch ${taskId} → ${label} on ${model} (depth=${depth})`);
		this.render();
	}

	recordProgress(taskId: string, observation: ProgressObservation, check: TimeoutCheck, now = Date.now()): void {
		const dispatch = this.dispatches.get(taskId);
		if (!dispatch) return;
		applyObservation(dispatch.progress, observation, now);
		applyWarnings(dispatch.progress, check.warnings, now, (warning) => this.log(`  ${taskId} ${warning}`));
		const detail = observation.detail.replace(/\s+/g, " ").trim();
		if (
			observation.kind === "progress" &&
			detail !== "tool execution completed" &&
			dispatch.lastLoggedProgressDetail !== detail &&
			(detail.startsWith("nested worker progress") || dispatch.lastLoggedProgressAt === undefined || now - dispatch.lastLoggedProgressAt >= 60_000)
		) {
			dispatch.lastLoggedProgressDetail = detail;
			dispatch.lastLoggedProgressAt = now;
			this.log(`  ${taskId} progress: ${detail}`);
		}
		this.scheduleRender();
	}

	/** Feed a parsed `--mode json` event from a child, plus the delta
	 * `dispatch/child-events.ts`'s accumulator already computed for it (B4.5
	 * step 3: this is UI/board bookkeeping only now — turns/cost come from the
	 * delta, not from re-deriving them off `event` a second time). */
	onChildEvent(taskId: string, event: any, delta: ChildEventDelta): void {
		const d = this.dispatches.get(taskId);
		if (!d) return;
		// Nested worker counts/turns are derived by render() from the single
		// de-duplicated progress view, never from raw event snapshots.
		let changed: string | null = null;
		switch (event?.type) {
			case "tool_execution_start": {
				d.toolCalls += 1;
				d.lastTool = event.toolName;
				const detail = shortArgs(event.toolName, event.args);
				changed = `${event.toolName}${detail ? ` ${detail}` : ""}`;
				this.log(`  ${taskId} tool#${d.toolCalls} ${changed}`);
				break;
			}
			case "tool_execution_end":
				if (event.isError) {
					changed = `${event.toolName} ✗`;
					this.log(`  ${taskId} tool ${event.toolName} returned error`);
				}
				break;
			case "message_start":
				if (event.message?.role === "assistant") changed = "thinking";
				break;
			case "message_end":
				if (delta.turn) {
					d.turns += 1;
					d.costUsd += delta.turn.costDelta;
					changed = `turn ${d.turns} done (${d.toolCalls} tools)`;
				}
				break;
			default:
				return;
		}
		if (changed) {
			d.lastActivity = changed;
			d.activityTail.push(changed);
			if (d.activityTail.length > MAX_ACTIVITY_TAIL) {
				d.activityTail.splice(0, d.activityTail.length - MAX_ACTIVITY_TAIL);
			}
		}
		this.scheduleRender();
	}

	endDispatch(taskId: string, exitCode: number, costUsd: number, note?: string): void {
		const d = this.dispatches.get(taskId);
		if (!d) return;
		d.endedAt = Date.now();
		d.status = this.cancellation.isCancelled ? "cancelled" : exitCode === 0 ? "done" : "failed";
		d.costUsd = costUsd || d.costUsd;
		d.lastActivity = note ?? (d.status === "cancelled" ? "cancelled by user" : exitCode === 0 ? "finished" : `exit ${exitCode}`);
		this.log(
			`dispatch ${taskId} ${d.status} in ${fmtElapsed(d.endedAt - d.startedAt)} — ${d.turns} turns, ${d.toolCalls} tool calls, $${d.costUsd.toFixed(4)}${d.nestedCostUsd > 0 ? ` + $${d.nestedCostUsd.toFixed(4)} in subagents` : ""}${note ? ` — ${note}` : ""}`,
		);
		this.render();
	}

	setNestedCost(taskId: string, costUsd: number): void {
		const d = this.dispatches.get(taskId);
		if (!d) return;
		d.nestedCostUsd = costUsd;
		this.scheduleRender();
	}

	totalCost(): number {
		let c = 0;
		for (const d of this.dispatches.values()) c += d.costUsd + d.nestedCostUsd;
		return c;
	}

	private scheduleRender(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.render();
		}, 250);
	}

	render(): void {
		if (this.closed) return;
		const now = Date.now();
		const running = [...this.dispatches.values()].filter((d) => d.status === "running");
		const done = [...this.dispatches.values()].filter((d) => d.status !== "running");
		const failed = done.filter((d) => d.status === "failed").length;
		const cancelled = done.filter((d) => d.status === "cancelled").length;
		const elapsed = fmtElapsed(now - this.startedAt);
		const totalCost = this.totalCost();
		const worktree = this.worktree;

		// Compact status line for the bar: phase + headline numbers. The phase is
		// most important when terminal (cancelled, failed) — keeping it visible
		// here means the user can see the verdict in the status bar even after
		// the widget has been closed.
		const wtShort = worktree ? ` · ${worktree.shortBranch} @ ${worktree.name}` : "";
		safeUi(() =>
			this.ctx.ui.setStatus(
				"orchestrator",
				`orch ${this.phase} · ${elapsed} · ${running.length} running · ${failed} failed${wtShort} · $${totalCost.toFixed(3)}`,
			),
		);

		const lines: string[] = [];
		// Title bar: run id, phase, elapsed, total cost, worktree.
		const titleWt = worktree
			? `  ${worktree.shortBranch} @ ${worktree.root}`
			: "";
		lines.push(
			`▶ /orchestrate  ${this.runId}  ·  ${this.phase}  ·  ${elapsed}  ·  $${totalCost.toFixed(4)}${titleWt}`,
		);
		// Goal line: keep first 80 + last 40 chars so the user can recognize long goals.
		const goal = this.goal.replace(/\s+/g, " ").trim();
		if (goal.length <= 120) {
			lines.push(`  Goal: ${goal}`);
		} else {
			lines.push(`  Goal: ${goal.slice(0, 80)} … ${goal.slice(-40)}`);
		}
		// Rollup line only when at least one task has finished.
		if (done.length > 0) {
			lines.push(
				`  ${running.length} running  ${done.length} done  ${failed} failed  ${cancelled} cancelled`,
			);
		}

		// Running section.
		if (running.length > 0) {
			lines.push("");
			lines.push(`  ▸ running (${running.length})`);
			for (const d of running) {
				lines.push(this.formatRunningRow(d, now));
				this.appendActivityTail(lines, d);
				const indent = "  ".repeat(2 + d.depth);
				const progressLine = formatProgressLine(d.progress, now, indent);
				if (progressLine) lines.push(progressLine);
				const warningLine = formatWarningLine(d.progress, now, indent);
				if (warningLine) lines.push(warningLine);
				lines.push(...formatNestedWorkerRows(d.progress, now, d.depth));
			}
		}

		// Completed section — tail of most recent 6.
		if (done.length > 0) {
			lines.push("");
			lines.push(`  ▸ completed (${done.length})`);
			const tail = done.slice(-6);
			for (const d of tail) lines.push(this.formatDoneRow(d, now));
			if (done.length > 6) {
				lines.push(`    … ${done.length - 6} earlier in run.log`);
			}
		}

		// Message queue indicator — only when there is something queued.
		if (this.queuedMessages.length > 0) {
			lines.push("");
			lines.push(
				`  ↳ ${this.queuedMessages.length} message${this.queuedMessages.length === 1 ? "" : "s"} queued for next dispatch — /omsg <text>`,
			);
		} else {
			// Most recent delivery within the last 5 minutes — confirms the agent saw it.
			const lastDelivery = this.deliveryLog[this.deliveryLog.length - 1];
			if (lastDelivery && now - lastDelivery.ts < 5 * 60 * 1000) {
				const ago = fmtElapsed(now - lastDelivery.ts);
				lines.push(
					`  ✓ ${lastDelivery.count} message${lastDelivery.count === 1 ? "" : "s"} delivered to ${lastDelivery.to} — ${ago} ago`,
				);
			}
		}

		lines.push("");
		lines.push(`  ↯ updated ${new Date(now).toISOString().slice(11, 19)} UTC · log: ${this.file("run.log")}`);
		safeUi(() => this.ctx.ui.setWidget("orchestrator", lines));
	}

	private formatRunningRow(d: DispatchProgress, now: number): string {
		const indent = "  ".repeat(1 + d.depth);
		const spin = spinnerFrame(now);
		const model = shortName(d.model).padEnd(20);
		const elapsed = fmtElapsed(now - d.startedAt).padStart(7);
		const turns = `t${d.turns}`.padStart(4);
		const tools = `⚙${d.toolCalls}`.padStart(5);
		const cost = `$${(d.costUsd + d.nestedCostUsd).toFixed(4)}`.padStart(9);
		const idleMs = now - d.progress.lastProgressAt;
		const idle = idleMs > 60_000 ? `  idle ${fmtElapsed(idleMs)}` : "";
		return `${indent}${spin} ${d.label.padEnd(20)}  ${model}  ${elapsed}  ${turns} ${tools}  ${cost}${idle}`;
	}

	private appendActivityTail(lines: string[], d: DispatchProgress): void {
		const indent = "  ".repeat(2 + d.depth);
		const tail = d.activityTail.slice(0, -1);
		if (tail.length > 0) lines.push(`${indent}↳ ${tail.join(" · ")}`.slice(0, 120));
		const nestedWorkers = d.progress.nested.size;
		const nestedTurns = [...d.progress.nested.values()].reduce((total, worker) => total + worker.turns, 0);
		if (nestedWorkers > 0) {
			lines.push(`${indent}${nestedWorkers} worker${nestedWorkers === 1 ? "" : "s"} (${nestedTurns} turns)`);
		}
	}

	private formatDoneRow(d: DispatchProgress, now: number): string {
		const indent = "  ".repeat(1 + d.depth);
		const mark = d.status === "done" ? "✓" : d.status === "cancelled" ? "⏹" : "✗";
		const model = shortName(d.model).padEnd(20);
		const elapsed = fmtElapsed((d.endedAt ?? now) - d.startedAt).padStart(7);
		const turns = `t${d.turns}`.padStart(4);
		const tools = `⚙${d.toolCalls}`.padStart(5);
		const cost = `$${(d.costUsd + d.nestedCostUsd).toFixed(4)}`.padStart(9);
		// Surface the captured note for failed and cancelled dispatches so the
		// user can see "exit 1", "cancelled by user", or the stderr summary at a
		// glance. For normal completions the ✓ mark already conveys status.
		const note =
			d.status !== "done" && d.lastActivity ? `  ${d.lastActivity}` : "";
		return `${indent}${mark} ${d.label.padEnd(20)}  ${model}  ${elapsed}  ${turns} ${tools}  ${cost}${note}`;
	}

	close(): void {
		if (this.closed) return;
		if (this.tickTimer) clearInterval(this.tickTimer);
		if (this.renderTimer) clearTimeout(this.renderTimer);
		// Cleared unconditionally, including on cancel: a stale widget/status left behind
		// after cancellation used to be the only visible trace that a run had ended, but it
		// also blocked the footer from ever going quiet. `run.log` and the terminal notify
		// carry the same information without pinning it to the screen forever.
		safeUi(() => this.ctx.ui.setWidget("orchestrator", undefined));
		safeUi(() => this.ctx.ui.setStatus("orchestrator", undefined));
		this.closed = true;
		this.log(`run ${this.runId} closed after ${fmtElapsed(Date.now() - this.startedAt)}`);
	}

	cancelledDispatches(): string[] {
		return [...this.dispatches.values()].filter((d) => d.status === "cancelled").map((d) => d.label);
	}

	/** Point-in-time status snapshot for the `orchestrator_status` tool and any other
	 *  out-of-band caller that needs to see run progress without owning the UI widget. */
	statusSnapshot(logLines = 20): OrchestratorStatus {
		const now = Date.now();
		const dispatches = [...this.dispatches.values()].map((d) => ({
			label: d.label,
			model: d.model,
			status: d.status,
			elapsedMs: (d.endedAt ?? now) - d.startedAt,
			turns: d.turns,
			lastTool: d.lastTool,
			costUsd: d.costUsd,
		}));
		const clampedLines = Number.isFinite(logLines) ? Math.max(1, Math.min(200, Math.trunc(logLines))) : 20;
		let recentLog: string[] = [];
		try {
			const text = readFileSync(this.file("run.log"), "utf8");
			const lines = text.split("\n").filter((l) => l.length > 0);
			recentLog = lines.slice(-clampedLines);
		} catch {
			/* log not written yet, or unreadable; report no lines rather than throw */
			recentLog = [];
		}
		return {
			runId: this.runId,
			phase: this.phase,
			elapsedMs: now - this.startedAt,
			totalCostUsd: this.totalCost(),
			dispatches,
			recentLog,
		};
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

/** Render an `OrchestratorStatus` snapshot as plain text for chat/tool output. */
export function formatOrchestratorStatus(s: OrchestratorStatus): string {
	const lines: string[] = [
		`Orchestration ${s.runId} — phase: ${s.phase} · elapsed ${fmtElapsed(s.elapsedMs)} · total cost $${s.totalCostUsd.toFixed(4)}`,
	];
	if (s.dispatches.length > 0) {
		lines.push("", "Dispatches:");
		for (const d of s.dispatches) {
			lines.push(
				`  - ${d.label} (${d.model}) [${d.status}] ${fmtElapsed(d.elapsedMs)} · turns ${d.turns}` +
					`${d.lastTool ? ` · last tool ${d.lastTool}` : ""} · $${d.costUsd.toFixed(4)}`,
			);
		}
	} else {
		lines.push("", "Dispatches: none yet");
	}
	if (s.recentLog.length > 0) {
		lines.push("", "Recent log:");
		for (const line of s.recentLog) lines.push(`  ${line}`);
	}
	return lines.join("\n");
}

export function registerOrchestratorStatusTool(pi: ExtensionAPI): void {
	const parameters = Type.Object({
		logLines: Type.Optional(Type.Number({ description: "Number of trailing run.log lines to include (clamped to 1..200; default 20)." })),
	});
	pi.registerTool({
		name: "orchestrator_status",
		label: "Orchestrator Status",
		description:
			"Read-only status of the current /orchestrate run, if any: phase, elapsed time, total cost, " +
			"per-dispatch progress (model, status, turns, last tool call, cost), and recent run.log lines. " +
			"Does not affect the run.",
		promptSnippet: "orchestrator_status: check progress of a live /orchestrate run without blocking on it",
		parameters,
		async execute(_toolCallId, params) {
			const active = runRegistry.active();
			if (!active) {
				return { content: [{ type: "text", text: "No orchestrator run is active." }], details: undefined };
			}
			const snapshot = active.session.statusSnapshot(params.logLines ?? 20);
			return {
				content: [{ type: "text", text: formatOrchestratorStatus(snapshot) }],
				details: snapshot,
			};
		},
	});
}

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
 */
export function runSubagentProcess(opts: Parameters<typeof runSubagentProcessCore>[0]): ReturnType<typeof runSubagentProcessCore> {
	return runSubagentProcessCore({
		...opts,
		recordEvent: opts.recordEvent ?? recordEvent,
		env: opts.env ?? liveEnv,
	});
}


/**
 * Classify the goal with the cheapest capability.
 *
 * `costSink` accumulates what triage spent. Triage is logged as run overhead under
 * the same run identifier even when classification fails.
 */
async function triageTask(
	runId: string,
	goal: string,
	cwd: string,
	ctx: ExtensionContext,
	/** The claiming run's context, threaded explicitly (B4.4) so triage's dispatch
	 *  and billing land on the right run instead of an implicit "active run" read. */
	run: RunContext<RunSession> | null,
	costSink: { usd: number },
	adapter: Adapter,
): Promise<TriageResult | null> {
	const cheapest =
		adapter["implementation_fast"] ??
		adapter["worker"] ??
		adapter["scout"] ??
		Object.values(adapter)[0];
	if (!cheapest || !cheapest.model) {
		console.warn("[orchestrator] triage skipped: adapter has no dispatchable model");
		return null;
	}

	const prompt = TRIAGE_PROMPT + "\n" + goal + "\n\nJSON:\n";
	try {
		const r = await runSubagentProcess({
			cwd,
			agentName: "orch-implementation-fast",
			task: prompt,
			model: cheapest.model,
			ctx,
			taskId: "triage",
			label: "triage",
			session: run?.session,
		});
		costSink.usd += r?.costUsd ?? 0;
		// Bill the dispatch before parsing: malformed/empty classifier output still used tokens.
		await captureDispatchCost(
			{ runId, planId: "triage", taskClass: "triage", complexity: 5, risk: "medium",
				recommended: { capability: "implementation_fast", effort: "low", verification_depth: "none" }, mode: "triage" },
			{ taskId: "triage", capability: "triage", model: r.model ?? cheapest.model,
				exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, usage: r.usage,
				durationMs: r.durationMs, costUsd: r.costUsd, costReported: r.costReported, stopReason: r.stopReason, filesChanged: [] },
			run,
		);
		if (r.exitCode !== 0) {
			console.warn(`[orchestrator] triage exited ${r.exitCode}: ${summarizeStderr(r.stderr || r.rawStdout, 400) || "(no output)"}`);
			return null;
		}
		// The child's final assistant message is the JSON verdict.
		const text = r.finalText || r.stdout;
		if (!text.trim()) {
			console.warn("[orchestrator] triage produced no assistant text");
			return null;
		}
		return parseTriageResponse(text);
	} catch (err) {
		console.warn(`[orchestrator] triage failed: ${(err as Error).message}`);
		return null;
	}
}

function slugGoal(goal: string): string {
	return goal
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "untitled";
}

// -----------------------------------------------------------------------------
// Python CLI bridge
// -----------------------------------------------------------------------------

interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run a Python module through `orchestratorPythonCli()`. `python`, when
 * given, builds a one-off spawner with a different interpreter but every
 * other setting unchanged; tests use this to exercise a missing interpreter.
 * The `/orchestrator-roi` handler runs a script (not a module) the same way,
 * directly against `orchestratorPythonCli().run()`, instead of through this
 * module-shaped wrapper.
 *
 * Always resolves exactly once — on close, spawn error, or timeout — because
 * `python-cli.ts`'s `run()` does. A spawn failure or timeout is reported as exit
 * code -1 with the error in `stderr`, which the record queue treats as
 * ambiguous and replays.
 */
export function runModule(module: string, args: string[] = [], stdin?: string, options: { python?: string } = {}): Promise<CliResult> {
	return orchestratorPythonCli(options.python)
		.run(module, args, { stdin })
		.then((r) => ({
			stdout: r.stdout,
			stderr: r.stderr,
			exitCode: r.code ?? -1,
		}));
}

// -----------------------------------------------------------------------------
// Plan + route types
// -----------------------------------------------------------------------------

// PlanResponse moved to core/prompts.ts (pure type; B4.1); imported below.

interface PlanOptions {
	goal: string;
	taskClass: string;
	complexity: number;
	risk: string;
	qualityFloor?: number;
	costAggressiveness?: number;
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

/** Queue an event row. Synchronous: progress never waits on a Python process. */
export function recordEvent(event: string, payload: Record<string, unknown>): void {
	telemetry.recordEvent(event, payload);
}

/** Queue a metric row (model_call / route_executed). */
export function recordModelCall(metric: Record<string, unknown>): void {
	telemetry.recordModelCall(metric);
}

/** Queue an outcome row. Terminal run outcomes go through completeRun/failRun, which also drain. */
export function recordOutcome(outcome: Record<string, unknown>): void {
	telemetry.recordOutcome(outcome);
}

export function qaVerificationOutcomeFor(runId: string, passed: boolean, quality: number, note: string): Record<string, unknown> {
	return {
		run_id: runId,
		task_id: `${runId}-qa`,
		outcome: passed ? "verified" : "fail",
		verification_scope: "run",
		quality,
		note,
	};
}

export function runCompletionOutcomeFor(runId: string, summary: Record<string, unknown>): Record<string, unknown> {
	return {
		run_id: runId,
		task_id: "run-complete",
		// A blocked run stopped at a precondition: neither a verified success nor
		// a quality failure of the route, so it must not train routing either way.
		outcome: summary.blocked === true ? "blocked" : summary.verification_passed === false ? "fail" : "verified",
		verification_scope: "run",
		quality: summary.success_rate ?? 0,
		note: JSON.stringify(summary),
	};
}

/** Terminal-boundary time fields written to the run outcome row. */
export interface RunTiming {
	started_at: string;
	finished_at: string;
	elapsed_ms: number;
	elapsed_source: "monotonic";
}

/**
 * Record the run's terminal outcome and drain everything queued for it. Resolves
 * only once Python has acknowledged the writes (or definitively failed them), so
 * the terminal status is never delayed behind the coalescing window and the
 * caller can surface any write failure.
 *
 * With `since` (the queue counters when the run started) the report covers every
 * record failure since then: a timer flush that failed mid-run must not vanish from
 * the summary just because the final drain went through.
 */
export async function completeRun(runId: string, summary: Record<string, unknown>, timing?: RunTiming, since?: QueueStats): Promise<FlushReport> {
	// No RunContext parameter here either (see the telemetry onError comment
	// above): every call site already holds its own `session`/`RunContext`
	// directly and could pass it, but completeRun/failRun are also meant to be
	// callable with just a runId. `runRegistry.active()` plus the runId check
	// preserves the exact old `ACTIVE_RUN?.runId === runId ? ACTIVE_RUN : null`
	// guard: a stale/older run's terminal call must never acknowledge a newer run.
	const active = runRegistry.active();
	const session = active?.session.runId === runId ? active.session : null;
	recordEvent("run_completed", { run_id: runId, ...timing });
	recordOutcome({ ...runCompletionOutcomeFor(runId, summary), ...timing });
	const report = reportSince(await recordQueue.flush(), since);
	session?.acknowledgeTerminal(report.ok);
	return report;
}

export async function failRun(runId: string, error: string, timing?: RunTiming, since?: QueueStats): Promise<FlushReport> {
	const active = runRegistry.active();
	const session = active?.session.runId === runId ? active.session : null;
	recordEvent("run_failed", { run_id: runId, error, ...timing });
	recordOutcome({
		run_id: runId,
		task_id: "run-failed",
		outcome: "fail",
		verification_scope: "run",
		quality: 0,
		note: error,
		...timing,
	});
	const report = reportSince(await recordQueue.flush(), since);
	session?.acknowledgeTerminal(report.ok);
	return report;
}

/** Widen a final-drain report to everything the queue did since `since` (cumulative for the run). */
function reportSince(drain: FlushReport, since?: QueueStats): FlushReport {
	if (!since) return drain;
	const now = recordQueue.stats;
	const failed = Math.max(drain.failed, now.failed - since.failed);
	const derivedStale = Math.max(drain.derivedStale, now.derivedStale - since.derivedStale);
	const report: FlushReport = {
		ok: failed === 0,
		batches: drain.batches,
		acknowledged: Math.max(drain.acknowledged, now.acknowledged - since.acknowledged),
		failed,
		derivedStale,
	};
	// Prefer the final drain's own messages; fall back to the queue's last message for
	// failures that happened in an earlier timer flush.
	if (failed > 0) report.error = drain.error ?? recordQueue.lastFailure ?? undefined;
	if (derivedStale > 0) report.staleReason = drain.staleReason ?? recordQueue.lastStaleReason ?? undefined;
	return report;
}

/**
 * Summary lines when telemetry did not fully land; empty when all is well. Lost records
 * and durable-but-unrefreshed records are different problems and are worded differently.
 */
export function telemetryWarning(report: FlushReport): string[] {
	const lines: string[] = [];
	if (!report.ok || report.failed > 0) {
		lines.push(`telemetry: ${report.failed} record(s) could not be written to the ledger — ${report.error ?? "see run.log"}`);
	}
	if (report.derivedStale > 0) {
		lines.push(
			`telemetry: ${report.derivedStale} record(s) are durable but the ledger/dashboard refresh failed; derived views are stale until the next successful write — ${report.staleReason ?? "see run.log"}`,
		);
	}
	return lines;
}

/** True when every record landed and the derived views were refreshed. */
export function telemetryHealthy(report: FlushReport): boolean {
	return report.ok && report.failed === 0 && report.derivedStale === 0;
}

/** Surface a failed terminal drain to the operator; silent on success. */
function warnTelemetry(ctx: ExtensionContext, report: FlushReport): void {
	for (const line of telemetryWarning(report)) safeUi(() => ctx.ui.notify(line, "warning"));
}

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

async function captureDispatchCost(
	opts: CaptureOpts,
	result: DispatchResult,
	/** The dispatching run's context, for its tag set; null outside a run. */
	run: RunContext<RunSession> | null,
): Promise<void> {
	for (const record of dispatchRecordsFor(opts, result, run?.tags ?? {})) {
		recordModelCall(record);
	}
}

// sumUsage moved to dispatch/parallel.ts (B4.5 step 5), its only caller.

// Verification + escalation
// -----------------------------------------------------------------------------

interface VerificationResult {
	passed: boolean;
	summary: string;
	failedChecks: string[];
	/** True when no QA agent ran at all (nothing changed) — `passed` is vacuous. */
	skipped?: boolean;
	/** The QA dispatch, so the caller can bill it into the run total. */
	dispatch?: DispatchResult;
}

/**
 * Run the QA agent against the union of files changed by workers. Returns a
 * pass/fail verdict that downstream escalation logic can act on. Parses a
 * tolerant output shape: ANY "FAIL" token in the QA output flips the verdict.
 */
async function runVerification(
	cwd: string,
	runId: string,
	planId: string,
	filesChanged: string[],
	adapter: Adapter,
	ctx: ExtensionContext,
	/** The run this QA pass belongs to; threaded through to dispatchParallel and
	 *  captureDispatchCost instead of an implicit "active run" read (B4.4). */
	run: RunContext<RunSession> | null,
	captureOpts: CaptureOpts,
): Promise<VerificationResult> {
	if (filesChanged.length === 0) {
		return {
			passed: true,
			skipped: true,
			summary: "No files changed — verification skipped.",
			failedChecks: [],
		};
	}

	const qaTask = [
		`Run the project verification suite for these changed files:`,
		"",
		...filesChanged.map((f) => `- \`${f}\``),
		"",
		"Run typecheck, unit tests, integration tests, lint as applicable.",
		...QA_SCOPE_RULES,
		"Respond with the standard QA output format.",
	].join("\n");

	const [qaResult] = await dispatchParallel(
		cwd,
		runId,
		[{ capability: "qa_agent", task: qaTask, taskId: `${runId}-qa` }],
		adapter,
		ctx,
		run,
	);

	if (!qaResult) {
		return {
			passed: false,
			summary: "QA dispatch produced no result.",
			failedChecks: ["qa-dispatch"],
		};
	}

	// The QA agent is a billable dispatch like any other. Recording only its
	// outcome left its spend out of both metrics.jsonl and the run total.
	await captureDispatchCost({ ...captureOpts, planId }, qaResult, run);

	const out = qaResult.stdout;
	const failedChecks = parseFailedChecks(out);
	const passed = qaResult.exitCode === 0 && failedChecks.length === 0;

	recordOutcome(qaVerificationOutcomeFor(runId, passed, passed ? 0.95 : 0.0, out.slice(0, 2000)));

	return {
		passed,
		summary: out.slice(0, 500),
		failedChecks,
		dispatch: qaResult,
	};
}

function parseFailedChecks(text: string): string[] {
	const fails: string[] = [];
	// Markdown table rows that contain "FAIL" or "✗" — tolerant.
	const rowRe = /\|\s*([^|]+?)\s*\|\s*[^|]*?(FAIL|✗|failed|error)[^|]*?\|/gi;
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(text)) !== null) {
		fails.push(m[1].trim());
	}
	// Bullet points labelled FAIL: `- foo: FAIL`.
	const bulletRe = /^[-*]\s+(.+?):\s*(FAIL|failed|✗)/gim;
	while ((m = bulletRe.exec(text)) !== null) {
		fails.push(m[1].trim());
	}
	return Array.from(new Set(fails));
}

// planEscalation now lives in escalation.ts as a pure, independently tested
// module (see BUG 2 fix note there): it keeps the original lead task/prompt
// intact on retry instead of substituting the failed lead's report, retries
// every lead the failure is or might be attributable to (not just lead 0),
// and stops at the caller's own `maxRetries` instead of a hard-coded 2.

// -----------------------------------------------------------------------------
// Hierarchical dispatch
// -----------------------------------------------------------------------------

/**
 * Dispatch work according to the topology the planner returned. Two paths:
 *
 * - depth <= 2: dispatch a single orchestrator-lead agent at the recommended
 *   capability. The lead handles its own workers via the subagent tool. This
 *   is the common case for complexity < 7.
 *
 * - depth >= 3: dispatch `leads` orchestrator-lead agents in parallel; each
 *   lead fans out its own workers. Used for complexity 7+ where the
 *   architect has multiple independent sub-domains to attack.
 *
 * Returns the flat list of leaf (worker) dispatches for bookkeeping. Lead
 * dispatches themselves get recorded as their own model_call + route_executed.
 */
async function dispatchHierarchical(
	cwd: string,
	runId: string,
	planId: string,
	goal: string,
	plan: PlanResponse,
	adapter: Adapter,
	ctx: ExtensionContext,
	/** The run this dispatch belongs to; threaded through to dispatchParallel,
	 *  captureDispatchCost and dispatchReconAndLeads's effects instead of an
	 *  implicit "active run" read (B4.4). */
	run: RunContext<RunSession> | null,
	leadCapability = "lead",
): Promise<{
	leadResults: DispatchResult[];
	workerResults: DispatchResult[];
	/** Leads not started because a dependency failed or was blocked. */
	skippedLeads: number;
	/** The architect dispatch, when the topology called for one. Billed by the caller. */
	architectResult?: DispatchResult;
	/** Mutable sink the caller appends escalation dispatches to, so they get billed. */
	escalationResults: DispatchResult[];
	/** Original DispatchTask objects dispatched for each lead, paired with leadResults by taskId — needed to build faithful retry prompts (BUG 2). */
	leadTasks: DispatchTask[];
}> {
	const { depth } = plan.topology;

	// Always: dispatch the architect first if it's a high-complexity / new-domain
	// task. The architect's output feeds into subsequent dispatch prompts.
	// For depth=1, skip — the lead IS the architect.
	let architectResult: DispatchResult | undefined;
	const needsArchitect = depth >= 2 && complexityNeedsArchitect(plan.complexity);
	if (needsArchitect) {
		run?.session.setPhase(
			`architect planning on ${shortName(adapter.architect?.model ?? "?")} (complexity ${plan.complexity} ≥ 5)`,
		);
		[architectResult] = await dispatchParallel(
			cwd,
			runId,
			[
				{
					capability: "architect",
					task: architectPrompt(goal, plan, MAX_LEADS),
					taskId: `${runId}-architect`,
				},
			],
			adapter,
			ctx,
			run,
		);
		await captureDispatchCost(
			{ runId, planId, taskClass: plan.task_class, complexity: plan.complexity,
			  risk: plan.risk, recommended: plan.route.recommended, mode: plan.route.mode },
			architectResult,
			run,
		);
		// The leads proceed without a plan rather than aborting the run, but the
		// operator must be told the decomposition step was lost — it silently
		// changes what the leads are working from.
		if (!architectResult || architectResult.exitCode !== 0) {
			ctx.ui.notify(
				`Architect dispatch failed (exit ${architectResult?.exitCode ?? "n/a"}): ${
					summarizeStderr(architectResult?.stderr ?? "no result", 300) || "(no output)"
				}\nLeads will run without an architect plan.`,
				"warning",
			);
		} else if (architectResult) {
			run?.session.setPhase(
				`architect done in ${fmtElapsed(architectResult.durationMs)} ($${architectResult.costUsd.toFixed(4)}) — ${architectResult.stdout.split("\n").filter((l) => /^\s*\d+[.)]/.test(l)).length} tasks planned`,
			);
		}
	}

	const captureOpts: CaptureOpts = {
		runId, planId, taskClass: plan.task_class, complexity: plan.complexity,
		risk: plan.risk, recommended: plan.route.recommended, mode: plan.route.mode,
	};
	const results = await dispatchReconAndLeads({ runId, goal, plan, adapter, architectResult, leadCapability }, {
		dispatch: (tasks) => dispatchParallel(cwd, runId, tasks, adapter, ctx, run),
		capture: (result) => captureDispatchCost(captureOpts, result, run),
		setPhase: (phase) => run?.session.setPhase(phase),
		throwIfCancelled: () => run?.session.cancellation.throwIfCancelled(),
	});
	return { ...results, architectResult, escalationResults: [] };
}

/** Parent-owned recon/lead sequencing; effects are supplied by the bridge. */
export async function dispatchReconAndLeads(
	input: {
		runId: string;
		goal: string;
		plan: PlanResponse;
		adapter: Adapter;
		architectResult?: DispatchResult;
		evidenceMaxChars?: number;
		/** Sized lead capability (lead_small | lead | lead_large); defaults to "lead". */
		leadCapability?: string;
	},
	effects: {
		dispatch: (tasks: DispatchTask[]) => Promise<DispatchResult[]>;
		capture: (result: DispatchResult) => Promise<void>;
		setPhase: (phase: string) => void;
		throwIfCancelled: () => void;
	},
): Promise<{ leadResults: DispatchResult[]; workerResults: DispatchResult[]; skippedLeads: number; leadTasks: DispatchTask[] }> {
	const { runId, goal, plan, adapter, architectResult, evidenceMaxChars = RECON_EVIDENCE_MAX_CHARS, leadCapability = "lead" } = input;
	const requestedLeadCount = effectiveLeadCount(plan, MAX_LEADS);

	// Rule 2: parent-owned, read-only recon dispatched directly by the bridge
	// (not left to a lead's discretion) so it is an observable, billed dispatch
	// with its own progress row, log files, and cost — not an optimistic claim
	// that "workers fan out inside each lead".
	const reconTasks: DispatchTask[] = planReconTasks({
		method: METHOD.rules.pre_implementation_recon,
		complexity: plan.complexity,
		taskClass: plan.task_class,
		goal,
		runId,
	});
	// Cancellation boundaries. A cancelled run must (1) dispatch nothing new,
	// but (2) never lose the accounting for children that already finished.
	// So the check runs BEFORE each dispatch batch and AFTER the whole capture
	// loop for a completed batch — never between captures, or a cancellation
	// that lands mid-billing would leave some finished workers unbilled.
	effects.throwIfCancelled();
	let workerResults: DispatchResult[] = [];
	if (reconTasks.length === 0) {
		// Name the actual reason; "below threshold OR exempt" made the operator
		// guess, and read as false for an exempt class at high complexity.
		const rule = METHOD.rules.pre_implementation_recon;
		const reason = plan.complexity < rule.min_complexity
			? `complexity ${plan.complexity} is below the Rule-2 threshold ${rule.min_complexity}`
			: `task class "${plan.task_class}" is exempt (skip_for_task_classes)`;
		effects.setPhase(`no parent-owned recon required: ${reason}`);
	} else {
		effects.setPhase(`recon: 0/${reconTasks.length} starting`);
		workerResults = await effects.dispatch(reconTasks);
		for (const result of workerResults) await effects.capture(result);
		// Every finished recon worker is now billed exactly once; if the run was
		// cancelled while recon ran (or while billing it), stop here — before any
		// lead is announced or started.
		effects.throwIfCancelled();
		const completedRecon = workerResults.filter((r) => r.exitCode === 0).length;
		effects.setPhase(`recon: ${completedRecon}/${reconTasks.length} completed; dispatching lead(s)`);
	}
	// Every completed/failed recon result is folded into one bounded evidence
	// packet; failed workers are represented as unavailable, never silently
	// dropped. If ALL recon calls failed, say so explicitly rather than
	// letting the per-worker diagnostics read as ordinary partial coverage.
	const reconEvidenceBody = formatReconEvidence(workerResults, evidenceMaxChars);
	const reconAllFailed = reconTasks.length > 0 && workerResults.every((r) => r.exitCode !== 0);
	const reconEvidence = reconAllFailed
		? `DEGRADED: all ${workerResults.length} parent-owned recon worker(s) failed; no verified recon evidence is available for this run. Raw diagnostics follow for context only:\n\n${reconEvidenceBody}`
		: reconEvidenceBody;

	// Several leads need the architect's Lead assignments (scope + depends on).
	// Without them, run ONE lead with the whole goal rather than N clones.
	const architectText = architectResult && architectResult.exitCode === 0 ? architectResult.stdout : "";
	const assignments = requestedLeadCount > 1 ? parseLeadAssignments(architectText, requestedLeadCount) : null;
	const leadCount = assignments ? requestedLeadCount : 1;
	if (requestedLeadCount > 1 && !assignments) {
		effects.setPhase(`topology asked for ${requestedLeadCount} leads but the architect gave no valid Lead assignments; running a single lead`);
	}
	const waves = assignments ? planLeadWaves(assignments) : [[0]];
	const leadTaskFor = (i: number): DispatchTask => ({
		capability: leadCapability,
		task: leadPrompt(goal, plan, architectResult, reconEvidence, i, leadCount, adapter, assignments?.[i]),
		taskId: `${runId}-lead-${i}`,
	});

	const completedReconCount = workerResults.filter((r) => r.exitCode === 0).length;
	const reconPhaseNote =
		reconTasks.length > 0
			? `${completedReconCount}/${reconTasks.length} completed recon packet(s)`
			: "no parent-owned recon packets (not required for this task)";
	effects.throwIfCancelled();
	effects.setPhase(
		`${leadCount} lead(s) in ${waves.length} wave(s) executing on ${shortName(adapter[leadCapability]?.model ?? "?")} with ${reconPhaseNote}; nested subagent calls inside a lead are not authoritative worker accounting`,
	);
	const leadResults: DispatchResult[] = [];
	// The exact DispatchTask objects dispatched for each lead, in the same
	// order/identity as leadResults (paired by taskId). BUG 2: escalation
	// retries were built from the failed lead's REPORT because the original
	// prompt was never kept anywhere past this function; callers now use this
	// to recover the lead's original goal/scope/model-routing prompt on retry.
	const leadTasks: DispatchTask[] = [];
	const stopped = new Set<number>();
	for (const [w, wave] of waves.entries()) {
		// A lead whose dependency failed or reported STATUS: blocked is not started.
		const runnable = wave.filter((i) => !(assignments?.[i]?.dependsOn ?? []).some((d) => stopped.has(d)));
		for (const i of wave) if (!runnable.includes(i)) stopped.add(i);
		const skipped = wave.filter((i) => !runnable.includes(i));
		if (skipped.length > 0) {
			effects.setPhase(`wave ${w + 1}: not starting lead(s) ${skipped.map((i) => i + 1).join(", ")} — a lead they depend on failed or was blocked`);
		}
		if (runnable.length === 0) continue;
		if (waves.length > 1) effects.setPhase(`wave ${w + 1}/${waves.length}: lead(s) ${runnable.map((i) => i + 1).join(", ")}`);
		const tasks = runnable.map(leadTaskFor);
		const results = await effects.dispatch(tasks);
		for (const r of results) await effects.capture(r);
		// Same contract as recon: bill every finished lead, then honour cancellation.
		effects.throwIfCancelled();
		for (const [k, r] of results.entries()) {
			if (r.exitCode !== 0 || parseLeadStatus(r.stdout) === "blocked") stopped.add(runnable[k]);
		}
		leadResults.push(...results);
		leadTasks.push(...tasks);
	}

	// Recon is parent-owned and returned for billing/reporting. Any further
	// fan-out a lead performs via HT's own subagent tool happens inside that
	// lead's own context window; the bridge has no visibility into it and does
	// not count it as part of this run's authoritative worker accounting.
	// Leads never started because a lead they depend on failed or was blocked.
	const skippedLeads = [...stopped].filter((i) => !leadResults.some((r) => r.taskId === `${runId}-lead-${i}`)).length;
	return { leadResults, workerResults, skippedLeads, leadTasks };
}

/**
 * Every dispatch this run paid for, in lifecycle order. Parent-owned recon
 * workers are billed dispatches like any other; omitting them under-reported
 * total spend, which is the number the cost policy is judged on. Each result
 * appears exactly once — recon is captured to the ledger during
 * `dispatchReconAndLeads()`, and this list is only the final-summary view.
 */
export function collectBilledResults(input: {
	architectResult?: DispatchResult;
	workerResults: DispatchResult[];
	leadResults: DispatchResult[];
	verificationResults: DispatchResult[];
	escalationResults: DispatchResult[];
}): DispatchResult[] {
	return [
		...(input.architectResult ? [input.architectResult] : []),
		...input.workerResults,
		...input.leadResults,
		...input.verificationResults,
		...input.escalationResults,
	];
}

/**
 * Operator-facing summary line for parent-owned recon. Failed workers are
 * named with a summarized (never raw) stderr so the final notification stays
 * bounded and readable.
 */
export function summarizeReconWorkers(workerResults: DispatchResult[]): string {
	if (workerResults.length === 0) return "recon workers: none (not required for this task)";
	const completed = workerResults.filter((r) => r.exitCode === 0).length;
	const cost = workerResults.reduce((s, r) => s + r.costUsd, 0);
	const failures = workerResults
		.filter((r) => r.exitCode !== 0)
		.map((r) => `${r.taskId} exit ${r.exitCode}: ${summarizeStderr(r.stderr, 120) || "(no output)"}`);
	return [
		`recon workers: ${completed}/${workerResults.length} completed · $${cost.toFixed(4)}`,
		...failures.map((f) => `  failed ${f}`),
	].join("\n");
}

// complexityNeedsArchitect, architectPrompt, QA_SCOPE_RULES, effectiveLeadCount,
// leadAssignmentInstructions, modelTableForLead, leadPrompt, LEAD_DELEGATION_RULE,
// LEAD_STATUS_CONTRACT moved to core/prompts.ts (pure; B4.1); imported below.
// architectPrompt/effectiveLeadCount now take maxLeads as an explicit parameter
// (default 8, matching the old MAX_LEADS default) instead of reading the
// MAX_LEADS module constant; call sites below pass MAX_LEADS explicitly.

// -----------------------------------------------------------------------------
// Argument parsing
// -----------------------------------------------------------------------------

// OrchestrateArgs, parseArgs, newOrchestrateArgs, consumeFlag moved to
// core/args.ts (pure; B4.1); imported below.

/** Goals that ask the agents to come back with questions cannot be honored headlessly. */
function goalExpectsInteraction(goal: string): boolean {
	return /\b(ask|raise)\b.*\bquestions?\b|\bclarif(y|ication)|\bcheck (back )?with me\b|\bconfirm with me\b/i.test(goal);
}

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

const MODELS_USAGE = [
	"Usage:",
	"  /orchestrator-models                       resolved table for the active profile",
	"  /orchestrator-models show [PROFILE]        resolved table for a profile",
	"  /orchestrator-models list                  aliases you can use + full catalog",
	"  /orchestrator-models validate [PROFILE] [--live]   offline check; --live probes every model",
	"  /orchestrator-models check                 = validate --live",
	"  /orchestrator-models set <capability|tier> <ALIAS> [--profile P]",
	"  /orchestrator-models effort <capability> <level|none> [--profile P]",
	"  /orchestrator-models use <PROFILE>         switch active profile",
	"  /orchestrator-models new <PROFILE> [--from P]",
	"  /orchestrator-models pick [PROFILE]        interactive: tiers first, then capability overrides",
	`file: ${PROFILES_PATH}`,
].join("\n");

// -----------------------------------------------------------------------------
// Extension entry point
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Automatic session-usage ingestion (hooks)
// -----------------------------------------------------------------------------

/**
 * Ingest this session's usage into the ledger after every settled turn and on
 * shutdown. Runs `orchestrator.cli ingest <sessionFile> --granularity session`,
 * whose rows are deltas against what is already recorded, so it is safe to run
 * as often as we like and alongside the launchd sweep (install.sh).
 */
export function recordHookFailure(stateRoot: string, detail: string): void {
	const root = stateRoot.replace(/^~/, homedir());
	const statusPath = join(root, contract.ingest_status_file);
	const temporaryPath = `${statusPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		let previous: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(statusPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				previous = parsed as Record<string, unknown>;
			}
		} catch {
			// A missing or malformed prior status must not prevent reporting failure.
		}
		const safeDetail = redactPaths(String(detail))
			.replace(/[\u0000-\u001f\u007f]+/g, " ")
			.trim()
			.slice(0, 240);
		const emptyExitDetail = /exit \d+:\s*(.*)$/.exec(safeDetail);
		const previousError = typeof previous.error === "string"
			? redactPaths(previous.error)
					.replace(/[\u0000-\u001f\u007f]+/g, " ")
					.trim()
					.slice(0, 240)
			: "";
		const error = emptyExitDetail && !emptyExitDetail[1].trim()
			? previousError || safeDetail || "session ingest failed"
			: safeDetail || previousError || "session ingest failed";
		const failureCount = previous.failure_count;
		const status = {
			...previous,
			version: 1,
			last_attempt_at: new Date().toISOString(),
			last_success_at: previous.last_success_at ?? null,
			status: "error",
			files_scanned: typeof previous.files_scanned === "number" ? previous.files_scanned : 1,
			emitted: typeof previous.emitted === "number" ? previous.emitted : 0,
			failure_count: typeof failureCount === "number" && Number.isFinite(failureCount) ? failureCount + 1 : 1,
			error,
			sweep_interval_seconds:
				typeof previous.sweep_interval_seconds === "number" ? previous.sweep_interval_seconds : 900,
		};
		mkdirSync(root, { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, statusPath);
	} catch {
		// Status reporting is best-effort and must never interrupt a terminal session.
	} finally {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Ignore temporary-file cleanup failures.
		}
	}
}

/** Register the settled fast path and an awaited, bounded shutdown flush. */
export function registerSessionIngestHooks(
	host: Pick<ExtensionAPI, "on">,
	scheduler: Pick<SessionIngestScheduler, "schedule" | "flush">,
	onError: (message: string) => void = () => {},
): void {
	host.on("agent_settled", async (_event, ctx) => {
		scheduler.schedule(ctx.sessionManager.getSessionFile());
	});
	host.on("session_shutdown", async (_event, ctx) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const done = await Promise.race([
				scheduler.flush(ctx.sessionManager.getSessionFile()).then(() => true),
				new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
			]);
			if (!done) onError("shutdown ingestion timed out; retry the session import to refresh durable usage");
		} finally { if (timer !== undefined) clearTimeout(timer); }
	});
}

function installSessionIngest(pi: ExtensionAPI): void {
	const stateRoot = STATE_ROOT.replace(/^~/, homedir());
	const logPath = join(stateRoot, "ingest-hook.log");
	const logError = (message: string) => {
		try {
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
		} catch {
			// Telemetry must never break the session.
		}
	};
	const onError = (message: string) => {
		logError(message);
		recordHookFailure(stateRoot, message);
	};
	const scheduler = new SessionIngestScheduler({
		onError,
		run: async (sessionFile) => {
			const res = await runModule("orchestrator.cli", ingestArgs(sessionFile));
			if (res.exitCode === 0) return { ok: true };
			return { ok: false, detail: `exit ${res.exitCode}: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}` };
		},
	});
	registerSessionIngestHooks(pi, scheduler, onError);
}

/**
 * Drain batched telemetry when the session ends, so records still inside the
 * coalescing window (a run that was cancelled by quitting, a plan that was just
 * confirmed) are durable before HT exits. Idempotent: flushing an empty queue is a no-op.
 */
function installTelemetryDrain(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async () => {
		// Wiring code with no context of its own to thread through (B4.4): this
		// hook fires whenever the session ends, regardless of which run (if any)
		// is live, so `runRegistry.active()` is the natural read here.
		const session = runRegistry.active()?.session ?? null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		session?.cancel("shutdown");
		try {
			const drained = await Promise.race([
				(async () => { await (session?.runPromise ?? session?.finished); await recordQueue.flush(); return true; })(),
				new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
			]);
			if (!drained) {
				// Do not pretend the terminal cost is complete or archive-safe on expiry.
				session?.close();
				if (session) void session.sealDiagnostics(Promise.resolve(false));
				console.warn("[orchestrator] shutdown drain timed out; late telemetry is unacknowledged, diagnostics remain UNSEALED");
			}
		} finally { if (timer !== undefined) clearTimeout(timer); }
	});
}

/**
 * Post a run's terminal outcome to the chat as a custom message, so the user sees it
 * even though `/orchestrate` returned long before the run settled. `sendMessage` can
 * throw after the session has moved on (e.g. a later shutdown); that failure is not
 * this run's problem to surface, so it is swallowed and logged instead.
 */
function postRunMessage(
	pi: ExtensionAPI,
	runId: string,
	outcome: "completed" | "failed" | "cancelled",
	content: string,
	costUsd: number,
): void {
	try {
		pi.sendMessage(
			{ customType: "orchestrator-run", content, display: true, details: { runId, outcome, costUsd } },
			{ triggerTurn: false },
		);
	} catch (err) {
		console.warn(`[orchestrator] could not post run ${runId} summary to chat: ${(err as Error)?.message ?? err}`);
	}
}

export default function (pi: ExtensionAPI) {
	reapOrphanedPersonaDirs({ tmpRoot: tmpdir(), prefix: PERSONA_TMP_PREFIX, ttlMs: PERSONA_TMP_TTL_MS });
	installDispatchReaper({
		liveDispatchPids,
		onSignal: () => {
			runRegistry.active()?.session.cancel("signal");
		},
		// Best effort only. A signal handler cannot await, so this merely *starts* a drain of
		// records still inside the coalescing window; whether the Python child gets to run
		// before HT exits depends on HT's own shutdown sequencing. Anything it does not
		// reach is lost with the process. The guaranteed drains are the awaited ones: the
		// run's terminal path (complete/fail/cancel/crash) and the `session_shutdown` hook.
		flush: () => {
			void recordQueue.flush();
		},
	});
	installTelemetryDrain(pi);
	installSessionIngest(pi);
	registerOrchestratorStatusTool(pi);

	pi.registerCommand("orchestrate", {
		description:
			"Plan and dispatch a hierarchical agent run. " +
			"Args: <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical] " +
			"[--profile NAME] [--lead-size small|standard|large] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--frontier ALIAS] [--model <capability>=ALIAS] [--effort LEVEL] " +
			"[--quality-floor F] [--cost-aggressiveness C] [--max-retries R] [--interactive]\n\n" +
			"With no triage flags, an LLM triage call (cheapest configured model) " +
			"auto-fills task_class, complexity, and risk from the goal text. " +
			"Models: flags > profile (orchestrator-profiles.json) > cost-tier resolver. See /orchestrator-models.",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (!parsed.goal) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			if (parsed.unknownFlags.length > 0) {
				ctx.ui.notify(`Unknown flag(s): ${parsed.unknownFlags.join(", ")}\n${USAGE}`, "error");
				return;
			}
			const alreadyActive = runRegistry.active();
			if (alreadyActive) {
				ctx.ui.notify(
					`An orchestration is already running (${alreadyActive.session.runId}). Wait for it to finish; its log is ${alreadyActive.session.file("run.log")}.`,
					"warning",
				);
				return;
			}

			// -----------------------------------------------------------------
			// Step 0: resolve models. Done before anything is spent so a typo in
			// --premium or the override file stops the run here, not after a
			// 10-minute architect pass on the wrong model.
			// -----------------------------------------------------------------
			const resolved = await resolveAdapter(ctx, parsed.models);
			const adapter = resolved.adapter;
			const hasUserOverride = Object.values(resolved.sources).some((s) => s !== "dynamic" && s !== "fallback");
			const overrideErrors = userLayerWarnings(resolved);
			if (overrideErrors.length > 0 || resolved.profiles.problems.length > 0) {
				ctx.ui.notify(
					`Model configuration is invalid — nothing was dispatched:\n${[...resolved.profiles.problems, ...overrideErrors].map((w) => `- ${w}`).join("\n")}\n\nFix with /orchestrator-models set <capability|tier> <alias>, or /orchestrator-models list to see aliases.`,
					"error",
				);
				return;
			}
			for (const w of resolved.warnings) ctx.ui.notify(w, "warning");
			for (const n of resolved.profiles.notes) ctx.ui.notify(n, "info");

			if (goalExpectsInteraction(parsed.goal)) {
				ctx.ui.notify(
					"Heads-up: dispatched agents run non-interactively and cannot ask you questions mid-run. " +
						"They are instructed to make the conservative choice and list open questions in their final report, which is shown when the run completes.",
					"warning",
				);
			}

			const runId = `ht-orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const session = new RunSession(runId, ctx, parsed.goal);
			// Re-check: the first guard above ran before the `await resolveAdapter` a few lines up,
			// so a second /orchestrate invocation could have raced through that same window and
			// already claimed the registry by the time we get here. Losing this race must not let two
			// sessions both believe they own it, so `claim()` re-checks and sets atomically, right
			// before the write, instead of trusting the guard above's now-stale result.
			const claimed = runRegistry.claim(
				session,
				{ profile: resolved.profileName, policy_id: policyIdFor(resolved.profileName, adapter) },
				resolved.table,
			);
			if (!claimed) {
				ctx.ui.notify(
					`An orchestration is already running (${runRegistry.active()!.session.runId}). Wait for it to finish; its log is ${runRegistry.active()!.session.file("run.log")}.`,
					"warning",
				);
				session.close();
				await session.sealDiagnostics();
				session.finish();
				return;
			}
			session.log(`policy: ${claimed.tags.policy_id}`);
			session.log(`models (profile "${resolved.profileName}"):\n${formatAdapterTable(resolved).map((l) => `  ${l}`).join("\n")}`);
			for (const n of resolved.notes) session.log(`note: ${n}`);

			// Everything from here on (triage, plan, dispatch, verification, completion)
			// runs detached from the command handler: /orchestrate returns as soon as this
			// promise is started, so the session stays responsive (queueing /omsg, checking
			// orchestrator_status, issuing /orchestrate-cancel) while children run. The
			// try/catch/finally below is the run's single cleanup point regardless of how
			// it ends — success, failure, cancellation, or shutdown.
			const runPromise = (async () => {
			const cwd = process.cwd();
			try {
				// -----------------------------------------------------------------
				// LLM triage: auto-fill missing task_class / complexity / risk via
				// the cheapest available model. Skip when the user supplied all
				// three explicitly; skip silently on any failure and use defaults.
				// -----------------------------------------------------------------
				const missingTriage =
					parsed.taskClass === "implementation" && parsed.complexity === 5 && parsed.risk === "medium";
				let effectiveTaskClass = parsed.taskClass;
				let effectiveComplexity = parsed.complexity;
				let effectiveRisk = parsed.risk;
				let triageResult: TriageResult | null = null;
				const triageCost = { usd: 0 };

				if (missingTriage) {
					session.setPhase(`triage on ${shortName(adapter.implementation_fast?.model ?? "?")}`);
					triageResult = await triageTask(runId, parsed.goal, cwd, ctx, claimed, triageCost, adapter);
					session.cancellation.throwIfCancelled();
					if (triageResult) {
						effectiveTaskClass = triageResult.task_class;
						effectiveComplexity = triageResult.complexity;
						effectiveRisk = triageResult.risk;
						const proceed = await Promise.race([session.cancellation.wait(), confirmStep(
							ctx,
							"Triage filled in missing values",
							`task_class: ${effectiveTaskClass}\n` +
								`complexity:  ${effectiveComplexity}\n` +
								`risk:        ${effectiveRisk}\n\n` +
								`Reasoning: ${triageResult.reasoning}\n\n` +
								`OK to plan with these values? (Cancel to abort)`,
							parsed.interactive,
						)]);
						if (!proceed) {
							const reason = parsed.interactive && !ctx.hasUI
								? "interactive confirmation unavailable after triage"
								: "cancelled by user after triage";
							session.log(reason);
							warnTelemetry(ctx, await failRun(runId, reason, session.terminalTiming(), session.telemetryBaseline));
							ctx.ui.notify("Cancelled.", "info");
							return;
						}
					} else {
						ctx.ui.notify(
							"Triage unavailable; using defaults task_class=implementation complexity=5 risk=medium. " +
								`Details: ${session.file("triage.stderr.log")}`,
							"warning",
						);
					}
				}

				// Step 1: Plan.
				session.setPhase("planning topology + route", false);
				let plan: PlanResponse;
				try {
					// Plan from the EFFECTIVE values. Passing `parsed.*` here threw away
					// the triage verdict the operator had just confirmed, so every
					// auto-triaged run planned as implementation/5/medium regardless.
					plan = await planRun(runId, {
						goal: parsed.goal,
						taskClass: effectiveTaskClass,
						complexity: effectiveComplexity,
						risk: effectiveRisk,
						qualityFloor: parsed.qualityFloor,
						costAggressiveness: parsed.costAggressiveness,
					});
					session.cancellation.throwIfCancelled();
				} catch (err) {
					if (session.cancellation.isCancelled) throw err;
					session.log(`plan failed: ${(err as Error).message}`);
					warnTelemetry(ctx, await failRun(runId, `plan failed: ${(err as Error).message}`, session.terminalTiming(), session.telemetryBaseline));
					ctx.ui.notify(`Plan failed: ${(err as Error).message}`, "error");
					return;
				}

				// Lead sizing (method.json rules.lead_sizing): triage's complexity and
				// risk pick lead_small / lead / lead_large; the profile binds each to
				// a model through its tier. --lead-size overrides.
				const leadDecision: LeadSizeDecision = sizeLead({
					complexity: effectiveComplexity,
					risk: effectiveRisk,
					override: parsed.leadSize,
					source: parsed.leadSize ? "flag" : triageResult ? "triage" : missingTriage ? "heuristic" : "flag",
				});
				const leadModel = adapter[leadDecision.capability]?.model ?? adapter.lead?.model ?? "unknown";
				claimed.tags.lead_size = leadDecision.size;
				recordEvent("lead_sized", {
					run_id: runId,
					complexity: effectiveComplexity,
					risk: effectiveRisk,
					band_size: leadDecision.bandSize,
					risk_floor_size: leadDecision.riskFloorSize,
					size: leadDecision.size,
					capability: leadDecision.capability,
					model: leadModel,
					source: leadDecision.source,
				});
				session.log(`lead size: ${leadDecision.size} → ${leadDecision.capability} on ${leadModel} (source: ${leadDecision.source})`);

				const needsArchitect = plan.topology.depth >= 2 && complexityNeedsArchitect(plan.complexity);
				const leadCount = Number.isFinite(plan.topology.leads)
					? Math.min(MAX_LEADS, Math.max(1, Math.trunc(plan.topology.leads)))
					: 1;
				const pipeline = [
					...(needsArchitect ? [`architect (${shortName(adapter.architect?.model ?? "?")})`] : []),
					`${leadCount} lead${leadCount > 1 ? "s" : ""} (${leadDecision.size}: ${shortName(leadModel)}) → workers (${shortName(adapter.worker?.model ?? "?")})`,
					`qa (${shortName(adapter.qa_agent?.model ?? "?")})`,
				].join(" → ");

				const planSummary = [
					`Plan ${plan.plan_id.slice(0, 12)} — "${parsed.goal.slice(0, 60)}${parsed.goal.length > 60 ? "…" : ""}"`,
					`triage:   ${effectiveTaskClass} / complexity ${effectiveComplexity} / risk ${effectiveRisk}`,
					`lead:     ${leadDecision.size} → ${shortName(leadModel)} (${leadDecision.source}; band ${leadDecision.bandSize}, risk floor ${leadDecision.riskFloorSize})`,
					`topology: ${plan.topology.shape} depth=${plan.topology.depth} leads=${plan.topology.leads} workers=${plan.topology.workers}`,
					`route:    ${plan.route.selected.capability} @ ${plan.route.selected.effort} (${plan.route.mode}); quality floor ${plan.effective_quality_floor}`,
					`pipeline: ${pipeline}`,
					`models (profile "${resolved.profileName}"${hasUserOverride ? "" : " is empty — cost-tier defaults; set with /orchestrator-models set"}):`,
					...formatAdapterTable(resolved).map((l) => `  ${l}`),
					`log:      ${session.file("run.log")}`,
				];
				ctx.ui.notify(planSummary.join("\n"), "info");
				session.log(planSummary.join("\n"));

				const proceed = await Promise.race([session.cancellation.wait(), confirmStep(
					ctx,
					"Dispatch this plan?",
					`${pipeline}\n\nOrchestrating stages use an inactivity limit plus an absolute ceiling (leaf dispatches use a fixed timeout); live progress shows above the editor.`,
					parsed.interactive,
				)]);
				session.cancellation.throwIfCancelled();
				if (!proceed) {
					const reason = parsed.interactive && !ctx.hasUI
						? "interactive confirmation unavailable before dispatch"
						: "cancelled by user at plan confirmation";
					session.log(reason);
					warnTelemetry(ctx, await failRun(runId, reason, session.terminalTiming(), session.telemetryBaseline));
					ctx.ui.notify("Cancelled.", "info");
					return;
				}

				// Step 2: Dispatch.
				const captureOpts: CaptureOpts = {
					runId,
					planId: plan.plan_id,
					taskClass: effectiveTaskClass,
					complexity: effectiveComplexity,
					risk: effectiveRisk,
					recommended: {
						capability: plan.route.recommended.capability,
						effort: plan.route.recommended.effort,
						verification_depth: plan.route.recommended.verification_depth,
					},
					mode: plan.route.mode,
				};

				recordEvent("dispatch_plan_confirmed", {
					run_id: runId,
					plan_id: plan.plan_id,
					models: Object.fromEntries(Object.entries(adapter).map(([k, v]) => [k, v.model])),
					model_sources: resolved.sources,
					profile: resolved.profileName,
					log_dir: session.dir,
				});

				const dirtyBefore = gitDirtySnapshot(cwd);
				const headBefore = gitHead(cwd);
				// `workerResults` carries the parent-owned recon dispatches; they must stay
				// destructured here or the run stops billing them (plan Task 3).
				const { leadResults, workerResults, architectResult, escalationResults, skippedLeads, leadTasks } = await dispatchHierarchical(
					cwd,
					runId,
					plan.plan_id,
					parsed.goal,
					plan,
					adapter,
					ctx,
					claimed,
					leadDecision.capability,
				);
				session.cancellation.throwIfCancelled();

				for (const r of leadResults) {
					if (r.exitCode !== 0) {
						ctx.ui.notify(
							`Lead ${r.taskId.replace(`${runId}-`, "")} failed (exit ${r.exitCode}): ${summarizeStderr(r.stderr, 300) || "(no output)"}\nSee ${session.file(`${r.taskId}.stderr.log`)}`,
							"warning",
						);
					}
				}

				// Step 3: Verification + escalation. We run QA against whatever files
				// were touched so far. If QA fails, escalate per policy Rule 1. The loop
				// is bounded by maxRetries.
				// `filesChanged` is scraped from dispatch prose, so a report that merely
				// MENTIONS README.md counted it as changed and sent QA after a phantom.
				// In a Git workspace, include both commits made since the run began and
				// dirty files whose content differs from the pre-run snapshot. Pre-existing
				// untracked scratch files a report merely names are not sent to QA. Every
				// round diffs against the same pre-run snapshot so the list is the
				// cumulative set QA must cover. `roundResults` are the dispatches that
				// just ran (used for the phantom log); `priorResults` widen the prose
				// fallback when git is unavailable so lead files aren't dropped on retry.
				let snapshotWarned = false;
				const changedSince = (
					label: string,
					roundResults: DispatchResult[],
					priorResults: DispatchResult[] = [],
				): string[] => {
					const roundClaimed = new Set(roundResults.flatMap((r) => r.filesChanged));
					const claimed = new Set([...priorResults.flatMap((r) => r.filesChanged), ...roundClaimed]);
					const dirtyAfter = gitDirtySnapshot(cwd);
					if ((!dirtyBefore || !dirtyAfter) && !snapshotWarned) {
						snapshotWarned = true;
						session.log(
							`git snapshot unavailable (${!dirtyBefore ? "before" : "after"} ${label}); falling back to file paths scraped from dispatch prose`,
						);
					}
					const { changed, phantom, historyUnavailable } = changedFilesSinceRunStart(cwd, headBefore, dirtyBefore, claimed, dirtyAfter);
					if (historyUnavailable) session.log(`${label}: git history unavailable; using claimed file paths`);
					const roundPhantom = phantom.filter((f) => roundClaimed.has(f));
					if (roundPhantom.length > 0) {
						session.log(
							`${label} named ${roundPhantom.length} file(s) not modified during this run; ignored: ${roundPhantom.join(", ")}`,
						);
					}
					return changed;
				};
				let allFiles = changedSince("lead phase", leadResults);

				// Run outcome from the leads' own STATUS lines. All leads blocked =>
				// BLOCKED: no QA, no PASS. Files git shows as changed while every
				// lead reports "Files Changed: None" belong to someone else (a
				// concurrent session) and are excluded from this run's QA scope.
				const leadStatuses = leadResults.map((r) => parseLeadStatus(r.stdout));
				const runOutcome = classifyRunOutcome({
					leadStatuses,
					succeededLeads: leadResults.filter((r) => r.exitCode === 0).length,
					leads: leadResults.length,
				});
				// Only when EVERY lead exited 0 and says it changed nothing: a lead that
				// failed, timed out or hit the spend cap may have edited files it never
				// got to report, and those must still be verified.
				const externalFiles = runOutcome === "blocked" ? [...allFiles] : externalChangeFiles(allFiles, leadResults);
				if (externalFiles.length > 0) {
					session.log(
						`${externalFiles.length} file(s) changed during the run but no lead reported changing them (likely a concurrent session); excluded from QA: ${externalFiles.join(", ")}`,
					);
					recordEvent("external_changes_detected", { run_id: runId, files: externalFiles, lead_statuses: leadStatuses });
					allFiles = allFiles.filter((f) => !externalFiles.includes(f));
				}
				if (runOutcome === "blocked") {
					session.log(`all ${leadResults.length} lead(s) reported STATUS: blocked; skipping QA`);
					recordEvent("run_blocked", { run_id: runId, leads: leadResults.length });
				}

				let retries = 0;
				let lastVerification: VerificationResult | null = null;
				const verificationResults: DispatchResult[] = [];
				while (runOutcome !== "blocked" && retries <= parsed.maxRetries) {
					if (allFiles.length > 0) {
						session.setPhase(
							retries === 0
								? `QA on ${allFiles.length} changed file(s) via ${shortName(adapter.qa_agent?.model ?? "?")}`
								: `QA retry ${retries + 1}/${parsed.maxRetries + 1} on ${allFiles.length} changed file(s)`,
						);
					}
					lastVerification = await runVerification(
						cwd,
						runId,
						plan.plan_id,
						allFiles,
						adapter,
						ctx,
						claimed,
						captureOpts,
					);
					session.cancellation.throwIfCancelled();
					if (lastVerification.dispatch) verificationResults.push(lastVerification.dispatch);
					if (lastVerification.passed) break;

					session.log(`verification failed: ${lastVerification.failedChecks.join(", ") || "(unparsed)"}`);
					// Pair each lead's ORIGINAL dispatch task (goal/scope/model-routing
					// prompt) with its own outcome so planEscalation can retry with the
					// real prompt instead of the failed report (BUG 2), and can decide
					// per-lead whether a retry is warranted instead of only ever
					// retrying lead 0.
					const leadsForEscalation: EscalationLeadInput[] = leadResults.map((r) => {
						const task = leadTasks.find((t) => t.taskId === r.taskId) ?? { capability: r.capability, task: r.stdout, taskId: r.taskId };
						return { task, result: { exitCode: r.exitCode, stdout: r.stdout, filesChanged: r.filesChanged } };
					});
					const escalationTasks = planEscalation(
						lastVerification.failedChecks,
						leadsForEscalation,
						plan.complexity,
						plan.risk,
						retries,
						parsed.maxRetries,
					);
					if (escalationTasks.length === 0) break;

					// Re-run escalations with bumped models (handled by pickModel when
					// retryCount > 0 via adapter override). One or many retry tasks (one
					// per retried lead) run sequentially here; each still gets its own
					// adapter override for its own capability.
					const roundStart = escalationResults.length;
					for (const t of escalationTasks) {
						const binding = adapter[t.capability] ?? adapter.worker;
						const escalatedModel = pickModel(
							t.capability,
							adapter,
							t.retryCount ?? 0,
							plan.risk,
						);
						session.setPhase(
							`escalation retry ${retries + 1}: ${t.capability} on ${shortName(escalatedModel)} — failed checks: ${lastVerification.failedChecks.slice(0, 3).join(", ")}`,
						);
						const escalatedSize = leadSizeOf(t.capability);
						if (escalatedSize) {
							claimed.tags.lead_size = escalatedSize;
							recordEvent("lead_sized", {
								run_id: runId,
								complexity: effectiveComplexity,
								risk: effectiveRisk,
								band_size: leadDecision.bandSize,
								risk_floor_size: leadDecision.riskFloorSize,
								size: escalatedSize,
								capability: t.capability,
								model: escalatedModel,
								source: "escalation",
								retry: t.retryCount ?? 1,
							});
						}
						const [retryResult] = await dispatchParallel(
							cwd,
							runId,
							[t],
							{
								...adapter,
								[t.capability]: { ...binding, model: escalatedModel },
							},
							ctx,
							claimed,
						);
						// Capture settled usage before cancellation unwinds this round, just
						// as the architect, lead and QA paths do.
						// dispatchParallel returns [] for an empty task list; billing an
						// absent result wrote an all-"unknown" model_call for a dispatch
						// that never happened.
						if (retryResult) {
							await captureDispatchCost(captureOpts, retryResult, claimed);
							escalationResults.push(retryResult);
						}
						session.cancellation.throwIfCancelled();
					}
					retries++;
					// The retry may have touched different files than the first lead
					// pass (or reverted some). Re-QA against the tree as it stands now
					// rather than the list computed before the loop, so escalation edits
					// are verified and a stale list can't fail the run forever. This also
					// runs after the final retry: finalize reports `allFiles`, and the
					// post-escalation tree is the state worth reporting.
					const thisRound = escalationResults.slice(roundStart);
					allFiles = changedSince(`escalation retry ${retries}`, thisRound, [
						...leadResults,
						...escalationResults.slice(0, roundStart),
					]).filter((f) => !externalFiles.includes(f));
					if (allFiles.length === 0) {
						// Nothing left to verify, but QA already failed this run. Re-running
						// against an empty list would return `skipped: true` and record the
						// run as passed; keep the failed verdict instead.
						session.log(
							`escalation retry ${retries} left no files differing from the pre-run tree; keeping the failed verification verdict`,
						);
						break;
					}
				}

				// Step 4: Finalize.
				// Total cost must cover EVERY dispatch this run paid for — architect,
				// parent-owned recon workers, and escalations included. Summing leads
				// alone under-reported spend, which is the one number the
				// cost-optimisation policy is judged on.
				const billedResults = collectBilledResults({
					architectResult,
					workerResults,
					leadResults,
					verificationResults,
					escalationResults,
				});
				// Leads' own subagent calls are billed too: they were the bulk of real spend
				// (ht-orch-1790256789245-1a3fms: $13.22 nested vs $1.56 reported).
				const nestedCost = billedResults.reduce((s, r) => s + (r.nestedCostUsd ?? 0), 0);
				const totalCost =
					triageCost.usd + billedResults.reduce((s, r) => s + r.costUsd, 0) + nestedCost;
				const succeededLeads = leadResults.filter((r) => r.exitCode === 0).length;
				// A run that dispatched nothing, or whose every lead failed, has not
				// verified anything — reporting the empty verification suite as PASS is
				// how phantom runs looked green.
				const dispatchOk = leadResults.length > 0 && succeededLeads > 0;
				const verificationSkipped = lastVerification?.skipped ?? false;
				const passedVerification = dispatchOk && (lastVerification?.passed ?? false);

				session.cancellation.throwIfCancelled();
				const telemetry = await completeRun(runId, {
					success_rate: succeededLeads / Math.max(1, leadResults.length),
					verification_passed: passedVerification,
					blocked: runOutcome === "blocked",
					lead_statuses: leadStatuses,
					external_changes: externalFiles.length,
					total_cost_usd: totalCost,
					files_changed: allFiles,
					retries,
					models: Object.fromEntries(Object.entries(adapter).map(([k, v]) => [k, v.model])),
					log_dir: session.dir,
				}, session.terminalTiming(), session.telemetryBaseline);

				// The lead's final report is the only place its reasoning, open
				// questions, and non-file results (audits, package lists, verdicts)
				// live. Always write it to disk; show it inline when there are no file
				// edits to speak for the run, or when the lead raised open items.
				const leadReports = leadResults
					.filter((r) => r.stdout.trim() || r.outcome === "timed_out" || r.outcome === "cancelled")
					.map((r) => {
						const interrupted = r.outcome === "timed_out" || r.outcome === "cancelled";
						const reason = r.outcome === "cancelled"
							? "cancelled"
							: r.timeoutReason ?? "unknown";
						const marker = interrupted ? `> UNVERIFIED PARTIAL WORK — ${reason}\n\n` : "";
						const report = r.stdout.trim() || r.interruption?.partialText || "(no assistant text captured)";
						return `${marker}### ${r.taskId.replace(`${runId}-`, "")}\n\n${report}`;
					});
				if (leadReports.length > 0) {
					try {
						session.writeDiagnostic("lead-report.md", leadReports.join("\n\n---\n\n"));
					} catch {
						/* best-effort */
					}
				}
				const firstReport = leadResults.find((r) => r.exitCode === 0)?.stdout.trim() ?? "";
				const openItems = /##\s*Open items\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(firstReport)?.[1]?.trim();
				const showFullReport = allFiles.length === 0 && firstReport;
				const reportLines = showFullReport
					? firstReport.split("\n").slice(0, 40)
					: openItems && !/^(none|n\/a|-\s*none)/i.test(openItems)
						? openItems.split("\n").slice(0, 15)
						: [];
				const reportTruncated = showFullReport && firstReport.split("\n").length > 40;

				const verdict = verificationVerdictFor({
					blocked: runOutcome === "blocked",
					dispatchOk,
					verificationSkipped,
					filesChangedCount: allFiles.length,
					passedVerification,
				});

				const summary = [
					`Orchestration ${runOutcome === "blocked" ? "BLOCKED" : dispatchOk ? "complete" : "FAILED"} in ${fmtElapsed(Date.now() - Number(runId.split("-")[2]))}.`,
					`run_id: ${runId}`,
					`leads: ${succeededLeads}/${leadResults.length} ${runOutcome === "blocked" ? "blocked" : "succeeded"}${skippedLeads > 0 ? ` (+${skippedLeads} not started: dependency failed or blocked)` : ""} · retries: ${retries} · files: ${allFiles.length} changed${externalFiles.length > 0 ? ` (+${externalFiles.length} changed by someone else, not verified)` : ""}`,
					summarizeReconWorkers(workerResults),
					`verification: ${verdict}`,
					`total cost: $${totalCost.toFixed(4)} (${billedResults.length + (triageCost.usd > 0 ? 1 : 0)} dispatches${nestedCost > 0 ? `; $${nestedCost.toFixed(4)} of it in lead subagents` : ""})`,
					...(dispatchOk
						? []
						: [
								`first failure: ${(() => {
									// The run FAILED because no lead succeeded, so name a lead first;
									// recon/architect failures are reported on their own lines.
									const failed = leadResults.find((r) => r.exitCode !== 0) ?? billedResults.find((r) => r.exitCode !== 0);
									if (!failed) return "(no dispatch attempted)";
									return `${failed.taskId.replace(`${runId}-`, "")} exit ${failed.exitCode}: ${summarizeStderr(failed.stderr, 300) || "(no output)"}`;
								})()}`,
							]),
					...(reportLines.length > 0
						? ["", showFullReport ? "lead report:" : "open items from lead:", ...reportLines, ...(reportTruncated ? [`… full report: ${describeRunArtifact(session.file("lead-report.md"))}`] : [])]
						: leadReports.length > 0
							? [`lead report: ${describeRunArtifact(session.file("lead-report.md"))}`]
							: []),
					`run log: ${describeRunArtifact(session.file("run.log"))}`,
					`ledger: ${STATE_ROOT}/metrics.jsonl`,
					...telemetryWarning(telemetry),
				];
				session.log(summary.join("\n"));
				const summaryText = summary.join("\n");
				// Whether the run is reported as a success in the notify and in chat must agree:
				// a run whose verification failed is not "completed" just because dispatch succeeded.
				const succeeded = (passedVerification || (dispatchOk && verificationSkipped)) && telemetryHealthy(telemetry);
				safeUi(() => ctx.ui.notify(summaryText, succeeded ? "info" : "warning"));
				postRunMessage(pi, runId, succeeded ? "completed" : "failed", summaryText, totalCost);
			} catch (err) {
				if (session.cancellation.isCancelled) {
					const stopped = session.cancelledDispatches();
					session.log(`run cancelled by user; stopped dispatches: ${stopped.join(", ") || "none active"}`);
					const cancelReason = session.cancelReason;
					const cancelNote =
						cancelReason === "shutdown"
							? "cancelled (session shutdown)"
							: cancelReason === "signal"
								? "cancelled (signal)"
								: "cancelled by user (/orchestrate-cancel)";
					warnTelemetry(ctx, await failRun(runId, cancelNote, session.terminalTiming(), session.telemetryBaseline));
					const cancelText = `Orchestration cancelled. ${stopped.length ? `Stopped: ${stopped.join(", ")}. ` : "No child dispatch was active. "}See ${session.file("run.log")}`;
					safeUi(() => ctx.ui.notify(cancelText, "info"));
					// Only a user-initiated cancel (/orchestrate-cancel) has a live session to post
					// into; a shutdown or signal cancel means the session itself is going away.
					if (cancelReason === "user") {
						postRunMessage(pi, runId, "cancelled", cancelText, session.totalCost());
					}
				} else {
					// Any uncaught throw used to leave the run half-recorded (no outcome
					// row) and the UI stuck on the last notify. Record + surface it.
					const message = (err as Error).stack ?? String(err);
					session.log(`run crashed: ${message}`);
					warnTelemetry(ctx, await failRun(runId, `crashed: ${(err as Error).message}`, session.terminalTiming(), session.telemetryBaseline));
					const crashText = `Orchestration crashed: ${(err as Error).message}\nSee ${session.file("run.log")}`;
					safeUi(() => ctx.ui.notify(crashText, "error"));
					postRunMessage(pi, runId, "failed", crashText, session.totalCost());
				}
			} finally {
				try {
					safeUi(() => session.close());
					await session.sealDiagnostics();
				} finally {
					// A newer race winner may already have replaced the registry's active
					// context with its own (see the re-check guard above); release() only
					// clears the registry when `claimed` — by identity — is still the
					// current owner, so a stale run's finally never clobbers a newer one.
					runRegistry.release(claimed);
					session.finish();
				}
			}
			})();
			session.runPromise = runPromise;
			runPromise.catch((err) => {
				console.error(`[orchestrator] run ${runId} background task rejected unexpectedly: ${(err as Error)?.stack ?? err}`);
			});
		},
	});

	pi.registerCommand("orchestrate-cancel", {
		description: "Cancel the currently running /orchestrate run, if any.",
		handler: async (_args, ctx) => {
			const active = runRegistry.active();
			if (!active) {
				ctx.ui.notify("no active run", "info");
				return;
			}
			const runId = active.session.runId;
			active.session.cancel("user");
			ctx.ui.notify(`Cancelling orchestration ${runId}…`, "info");
		},
	});

	pi.registerCommand("orchestrator-models", {
		description:
			"Manage which models /orchestrate uses. Subcommands: show|list|validate [--live]|check|set|effort|use|new|pick. " +
			"Aliases like fable-5-1, opus-5-5, sonnet-5, gpt-6-sol, gpt-6-luna, astra resolve against your configured models.",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : "show";
			const rest = tokens[0] && !tokens[0].startsWith("--") ? tokens.slice(1) : tokens;
			const VALUE_FLAGS = new Set(["--profile", "--from", "--effort", "--cheap", "--mid", "--premium", "--frontier", "--model"]);
			const positional = rest.filter((t, i) => !t.startsWith("--") && !VALUE_FLAGS.has(rest[i - 1] ?? ""));
			// Flags (--profile, --live, ...) come from the same parser as /orchestrate;
			// bare words land in `goal`, which we ignore here in favour of `positional`.
			const parsed = parseArgs(`x ${rest.join(" ")}`);

			const showResolved = async (profile?: string) => {
				const resolved = await resolveAdapter(ctx, { ...emptyOverrides(), profile });
				const p = resolved.profiles;
				const lines = [
					`Profile "${resolved.profileName}"${resolved.profileName === p.file.active_profile ? " (active)" : ""}${p.file.profiles[resolved.profileName]?.description ? ` — ${p.file.profiles[resolved.profileName].description}` : ""}`,
					"precedence: --flags > profile capabilities > profile tiers > cost-tier resolver > fallback",
					...formatAdapterTable(resolved).map((l) => `  ${l}`),
					...(resolved.notes.length > 0 ? ["", ...resolved.notes.map((n) => `  note: ${n}`)] : []),
					...(resolved.warnings.length > 0 ? ["", "warnings:", ...resolved.warnings.map((w) => `  - ${w}`)] : []),
					...(p.notes.length > 0 ? ["", ...p.notes.map((n) => `  ${n}`)] : []),
					"",
					`profiles: ${Object.keys(p.file.profiles).map((n) => (n === p.file.active_profile ? `*${n}` : n)).join(", ")}  file: ${PROFILES_PATH}${p.present ? "" : " (not created yet)"}`,
					"commands: /orchestrator-models list | set <cap|tier> <alias> | use <profile> | pick | validate --live",
				];
				ctx.ui.notify(lines.join("\n"), resolved.warnings.length > 0 ? "warning" : "info");
				return resolved;
			};

			switch (sub) {
				case "show": {
					await showResolved(positional[0] ?? parsed.models.profile);
					return;
				}
				case "list": {
					const models = availableModels(ctx);
					const table = buildAliasTable(models);
					const profiles = loadProfiles();
					const preference = profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE;
					const shortcuts = listShortcuts(table, preference);
					const byProvider = new Map<string, string[]>();
					for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m.id]);
					const width = Math.min(20, Math.max(...shortcuts.map((s) => s.alias.length), 5));
					ctx.ui.notify(
						[
							`Aliases (provider preference: ${preference.join(" > ")}; write provider/alias to force one):`,
							...shortcuts.map((s) => `  ${s.alias.padEnd(width)} → ${s.model}${s.alsoOn.length ? `  (also on ${s.alsoOn.join(", ")})` : ""}`),
							"",
							`Full catalog (${models.length} models configured):`,
							...[...byProvider.entries()].flatMap(([prov, ids]) => [`  ${prov} (${ids.length}):`, ...ids.sort().map((id) => `    ${id}`)]),
						].join("\n"),
						"info",
					);
					return;
				}
				case "validate":
				case "check": {
					const resolved = await showResolved(positional[0] ?? parsed.models.profile);
					const problems = [...resolved.profiles.problems, ...userLayerWarnings(resolved)];
					if (problems.length > 0) {
						ctx.ui.notify(`Offline validation: FAIL (${problems.length} problem(s)) — /orchestrate would refuse to dispatch.`, "error");
						return;
					}
					ctx.ui.notify("Offline validation: OK — every binding resolves to a configured model.", "info");
					if (sub === "check" || parsed.check) await checkModels(ctx, resolved);
					return;
				}
				case "use": {
					const name = positional[0];
					const profiles = loadProfiles();
					if (!name || !profiles.file.profiles[name]) {
						ctx.ui.notify(`Unknown profile "${name ?? ""}". Have: ${Object.keys(profiles.file.profiles).join(", ")}`, "error");
						return;
					}
					profiles.file.active_profile = name;
					writeProfilesFile(profiles.file);
					ctx.ui.notify(`Active profile → "${name}"`, "info");
					await showResolved(name);
					return;
				}
				case "new": {
					const name = positional[0];
					if (!name || !PROFILE_NAME_RE.test(name)) {
						ctx.ui.notify(`Profile name must match ${PROFILE_NAME_RE}`, "error");
						return;
					}
					const profiles = loadProfiles();
					if (profiles.file.profiles[name]) {
						ctx.ui.notify(`Profile "${name}" already exists.`, "error");
						return;
					}
					const fromIdx = rest.indexOf("--from");
					const from = fromIdx !== -1 ? rest[fromIdx + 1] : undefined;
					const base: ProfileSpec = from ? structuredClone(profiles.file.profiles[from] ?? {}) : {};
					if (from && !profiles.file.profiles[from]) {
						ctx.ui.notify(`--from profile "${from}" does not exist.`, "error");
						return;
					}
					profiles.file.profiles[name] = { ...base, description: from ? `copied from ${from}` : undefined };
					writeProfilesFile(profiles.file);
					ctx.ui.notify(`Created profile "${name}"${from ? ` from "${from}"` : ""}. Activate with: /orchestrator-models use ${name}`, "info");
					return;
				}
				case "set": {
					const [target, spec] = positional;
					if (!target || !spec) {
						ctx.ui.notify(`Usage: /orchestrator-models set <capability|cheap|mid|premium|frontier> <alias|provider/model> [--profile P]\n${MODELS_USAGE}`, "error");
						return;
					}
					if (!isTier(target) && !ALL_CAPABILITIES.includes(target)) {
						ctx.ui.notify(`"${target}" is not a tier (cheap|mid|premium|frontier) or capability (${ALL_CAPABILITIES.join(", ")})`, "error");
						return;
					}
					const profiles = loadProfiles();
					const name = parsed.models.profile ?? profiles.file.active_profile;
					const profile = (profiles.file.profiles[name] ??= {});
					const table = buildAliasTable(availableModels(ctx));
					const res = resolveAlias(spec, table, profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE);
					if (!res.model) {
						ctx.ui.notify(`${res.error}\nNothing written. /orchestrator-models list shows valid aliases.`, "error");
						return;
					}
					if (isTier(target)) (profile.tiers ??= {})[target] = spec;
					else (profile.capabilities ??= {})[target] = spec;
					writeProfilesFile(profiles.file);
					ctx.ui.notify(`${name}.${target} = ${spec} → ${res.model}${res.note ? `\nnote: ${res.note}` : ""}`, "info");
					await showResolved(name);
					return;
				}
				case "effort": {
					const [cap, level] = positional;
					if (!cap || !level || !ALL_CAPABILITIES.includes(cap) || (level !== "none" && !isThinkingLevel(level))) {
						ctx.ui.notify(`Usage: /orchestrator-models effort <capability> <${THINKING_LEVELS.join("|")}|none> [--profile P]`, "error");
						return;
					}
					const profiles = loadProfiles();
					const name = parsed.models.profile ?? profiles.file.active_profile;
					const profile = (profiles.file.profiles[name] ??= {});
					if (level === "none") delete profile.effort?.[cap];
					else (profile.effort ??= {})[cap] = level;
					writeProfilesFile(profiles.file);
					ctx.ui.notify(`${name}.effort.${cap} = ${level}`, "info");
					return;
				}
				case "pick": {
					if (!ctx.hasUI) {
						ctx.ui.notify("pick needs an interactive session; use `set` instead.", "error");
						return;
					}
					const profiles = loadProfiles();
					const name = positional[0] ?? profiles.file.active_profile;
					if (positional[0] && !PROFILE_NAME_RE.test(positional[0])) {
						ctx.ui.notify(`Profile name must match ${PROFILE_NAME_RE}`, "error");
						return;
					}
					const profile = (profiles.file.profiles[name] ??= {});
					const table = buildAliasTable(availableModels(ctx));
					const preference = profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE;
					const shortcuts = listShortcuts(table, preference);
					// Options: short aliases first (what people think in), then every raw provider/id.
					const options = [
						...shortcuts.map((s) => `${s.alias}  →  ${s.model}`),
						...[...new Set(table.models.map((m) => `${m.provider}/${m.id}`))].sort(),
					];
					const KEEP = "(keep current)";
					const CLEAR = "(clear — fall through to next layer)";
					const pickOne = async (title: string, current: string | undefined) => {
						const choice = await ctx.ui.select(`${title}${current ? `  [current: ${current}]` : ""}`, [KEEP, CLEAR, ...options]);
						if (choice === undefined || choice === KEEP) return "keep" as const;
						if (choice === CLEAR) return "clear" as const;
						return choice.includes("  →  ") ? choice.split("  →  ")[0].trim() : choice;
					};
					// Tiers first — three picks cover every capability.
					for (const tier of TIERS) {
						const r = await pickOne(`${tier} tier (${TIER_CAPABILITIES[tier].join(", ")})`, profile.tiers?.[tier]);
						if (r === "clear") delete profile.tiers?.[tier];
						else if (r !== "keep") (profile.tiers ??= {})[tier] = r;
					}
					// Then optional per-capability overrides until Done.
					const DONE = "(done)";
					while (true) {
						const cap = await ctx.ui.select(
							"Override a single capability? (tiers already cover all of them)",
							[DONE, ...ALL_CAPABILITIES.map((c) => `${c}${profile.capabilities?.[c] ? `  = ${profile.capabilities[c]}` : ""}`)],
						);
						if (cap === undefined || cap === DONE) break;
						const capName = cap.split("  =")[0].trim();
						const r = await pickOne(`model for ${capName}`, profile.capabilities?.[capName]);
						if (r === "clear") delete profile.capabilities?.[capName];
						else if (r !== "keep") (profile.capabilities ??= {})[capName] = r;
					}
					writeProfilesFile(profiles.file);
					ctx.ui.notify(`Saved profile "${name}".`, "info");
					const resolved = await showResolved(name);
					const problems = [...resolved.profiles.problems, ...userLayerWarnings(resolved)];
					if (problems.length > 0) ctx.ui.notify(`Validation: FAIL (${problems.length}) — see warnings above.`, "error");
					else if (await ctx.ui.confirm("Validation OK", "Run a live probe on each configured model now? (a few cents)")) await checkModels(ctx, resolved);
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}".\n${MODELS_USAGE}`, "error");
			}
		},
	});

	pi.registerCommand("orchestrator-roi", {
		description: "Print the skill vs flat-baseline ROI report.",
		handler: async (_args, ctx) => {
			const result = await orchestratorPythonCli().run(join(expandedSkillRoot, "scripts/skill_vs_baseline.py"), [], {
				cwd: expandedSkillRoot,
			});
			if (result.code !== 0) {
				ctx.ui.notify(`ROI report failed: ${result.error ?? result.stderr}`, "error");
				return;
			}
			ctx.ui.notify(result.stdout.split("\n").slice(0, 20).join("\n"), "info");
		},
	});

	// Message inbound while a run is live — queued in RunSession and folded
	// into the prompt of the next dispatched task. Cannot be injected into a
	// running Pi subprocess (humain-terminal --mode json --no-session has no
	// stdin channel), so delivery is at the next dispatch boundary.
	pi.registerCommand("omsg", {
		description:
			"Send a message to the running orchestration (queued, delivered to the next dispatched task). " +
			"Usage: /omsg <text> — the lead will see and respond to it. Use '\\n' for newlines if needed.",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /omsg <message>  (queues one message for the next dispatch)", "warning");
				return;
			}
			const active = runRegistry.active();
			if (!active) {
				ctx.ui.notify(
					"No orchestration is running. Start one with /orchestrate <goal> first — " +
						"messages are only delivered to a live run.",
					"warning",
				);
				return;
			}
			// Literal "\n" in the input becomes a real newline so multi-line
			// instructions paste cleanly from shell history.
			const normalized = text.replace(/\\n/g, "\n");
			const depth = active.session.enqueueMessage(normalized);
			const preview = normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
			ctx.ui.notify(
				`Queued for next dispatch (depth=${depth}): “${preview}”`,
				"info",
			);
		},
	});
}


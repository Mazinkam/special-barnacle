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

import { RunDiagnostics, type DiagnosticWriter } from "./run-diagnostics.ts";
import { runLiveQaStage, type RunLiveQaStageResult } from "./live-qa-stage.ts";
import { registerOrchestrateCommand, type OrchestrateDeps } from "./commands/orchestrate.ts";
import { registerOrchestratorModelsCommand } from "./commands/orchestrator-models.ts";
import { describeRunArtifact, RunRegistry, type RunContext, type RunSessionLike, type RunTiming } from "./run/context.ts";
export { describeRunArtifact };
import { resolveCandidates, usableModels, type Candidate } from "./adapters/model-router.ts";
import { buildCatalog, parseModelFacts } from "./adapters/model-catalog.ts";
import { dispatchWithFailover } from "./dispatch/failover.ts";
import { failoverConfig } from "./dispatch/failover-policy.ts";
import { resolveStateRoot, liveEnv } from "./config.ts";
import {
	guardChildStreamHandler,
	liveDispatchPids,
	NO_PERSONA,
	PERSONA_TMP_PREFIX,
	runSubagentProcess as runChildProcess,
	type SubagentProcessResult,
} from "./dispatch/child-process.ts";
import { ModelHealth } from "./run/model-health.ts";
import type { ModelHealth as ModelHealthType } from "./run/model-health.ts";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
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
import { hostname, homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
// TypeBox 1.x: `Type` is a namespace (`Type.Object`, `Type.Array`, ...);
// the validation function moved to a separate `typebox/value` module.
import { Type } from "typebox";

import {
	discoverAgents,
	type ExtensionAPI,
	type ExtensionContext,
	renderTaskWithContext,
	type SubagentSingleResult,
	type SubagentUsageStats,
} from "@humain/terminal";

import {
	ALL_CAPABILITIES,
	type AliasTable,
	type AvailableModel,
	type Binding,
	type BindingSource,
	buildAliasTable,
	DEFAULT_PROVIDER_PREFERENCE,
	emptyProfilesFile,
	isThinkingLevel,
	type Layer,
	mergeLayers,
	METHOD,
	parseProfilesFile,
	type ProfilesFile,
	rereviewFloor,
	type ResolvedAdapter,
	shortName,
	THINKING_LEVELS,
	type Tier,
	TIER_CAPABILITIES,
	tierIndex,
	tierOf,
	tierOfModel,
	tiersToBindings,
	type LeadSize,
} from "./models.ts";
import { bedrockFallbackFor } from "./provider-fallback.ts";
import { parseLeadAssignments, planLeadWaves, type LeadAssignment } from "./lead-plan.ts";
import { classifyRunOutcome, externalChangeFiles, parseLeadFilesChanged, parseLeadStatus } from "./run-outcome.ts";
import { SpendCapTracker, capFor, type SpendCapVerdict } from "./spend-cap.ts";
import { NestedCostTracker, type NestedCallDetail } from "./nested-cost.ts";
import { escalateLeadCapability, isLeadCapability, isLeadSize, leadSizeOf, sizeLead, type LeadSizeDecision } from "./lead-sizing.ts";
import { planEscalation, type EscalationLeadInput } from "./escalation.ts";
import { ingestArgs, SessionIngestScheduler } from "./ingest.ts";
import {
	BoundedCapture,
	capChildStderrFile,
	classifyDispatchOutcome,
	MAX_CHILD_STDERR_DISK_BYTES,
	readStderrFileBounded,
	summarizeStderr,
	trimEventForLog,
} from "./dispatch/stderr-sink.ts";
import { dispatchHealth, recordProviderErrors } from "./dispatch/provider-health.ts";
import {
	DispatchProgressTracker,
	ORCHESTRATING_CAPABILITIES,
	buildInterruptionReport,
	renderInterruptionReport,
	summarizeInterruption,
	resolveDispatchTimeoutPolicy,
	applyLeadTimeoutOverride,
	type DispatchTimeoutPolicy,
	type InterruptionReport,
} from "./dispatch-progress.ts";
import { RunCancellation } from "./cancellation.ts";
import { applyObservation, applyWarnings, createProgressView, formatNestedWorkerRows, formatProgressLine, formatWarningLine } from "./run-ui.ts";
import type { DispatchProgressView } from "./run-ui.ts";
import type { ProgressObservation, TimeoutCheck } from "./dispatch-progress.ts";
import { type FlushReport, type QueueStats, RecordQueue } from "./record-queue.ts";
import contract from "./contract.ts";
// Rule-2 recon planning/evidence helpers (pure; see recon.ts). `dispatchHierarchical()`
// dispatches these as ordinary parent-owned tasks through the existing
// `dispatchParallel()` path. `DispatchTask` below is declared independently;
// `ReconTaskPlan` is structurally assignable to it, which the annotated
// `const reconTasks: DispatchTask[] = planReconTasks(...)` checks at compile
// time, so a planned recon task still needs no conversion step.
import { formatReconEvidence, planReconTasks } from "./recon.ts";
import { DispatchTelemetryTracker, type DispatchTelemetryFields } from "./dispatch-telemetry.ts";
import { loadEfficiencyControls, type EfficiencyControls } from "./efficiency-flags.ts";
import { diffDirtySnapshots, gitDirtySnapshot, parseFilesChanged } from "./adapters/git-changes.ts";
import { assignCanary, canaryTelemetryFields, parseModelCanaries, type CanaryAssignment } from "./model-canary.ts";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const SKILL_ROOT =
	process.env.HUMAIN_ORCHESTRATOR_SKILL_ROOT ??
	"~/.local/share/agent-skills/hierarchical-agent-orchestrator";
// One resolver for both runtimes (config.ts / orchestrator/core/env.py): canonical
// CODING_AGENT_ORCHESTRATOR_HOME, then aliases, then the contract default.
const STATE_ROOT = resolveStateRoot(process.env);
const PYTHON = process.env.HUMAIN_ORCHESTRATOR_PYTHON ?? "python3";
/**
 * Model configuration lives in one file: `orchestrator-profiles.json`
 * (named profiles of alias -> capability/tier bindings; see models.ts). The
 * older `orchestrator-adapter.json` is migrated into profile "default" on first
 * load and then ignored.
 */
// Match absolute paths under common user homes so the bounded Status Contract
// `error` field never leaks filesystem locations. Mirrors the redaction the
// Python CLI applies when writing `ingest_status.json`.
const PATH_RE = /(\/Users\/[^\s|]+|\/home\/[^\s|]+|~\/[^\s|]+)/g;
function redactPaths(text: string): string {
	return text.replace(PATH_RE, "<path>");
}
const PROFILES_PATH =
	process.env.HUMAIN_ORCHESTRATOR_PROFILES_FILE ??
	join(homedir(), ".humain-terminal", "agent", "orchestrator-profiles.json");
const LEGACY_ADAPTER_PATH =
	process.env.HUMAIN_ORCHESTRATOR_ADAPTER_FILE ??
	join(homedir(), ".humain-terminal", "agent", "orchestrator-adapter.json");
const MODEL_FACTS_PATH = process.env.HUMAIN_ORCHESTRATOR_MODEL_FACTS_FILE ?? join(dirname(PROFILES_PATH), "model-facts.json");

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
	return join(STATE_ROOT.replace(/^~/, homedir()), "runs");
}

// Non-interactive runs (`--mode json -p`, CI, smoke tests) get a no-op UI whose
// `confirm()` always resolves false. Runs therefore auto-approve by default;
// `--interactive` explicitly opts in to the confirmation gates.

function positiveIntEnv(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/** Hard ceiling on concurrent child processes, independent of what a plan asks for. */
const MAX_CONCURRENT_DISPATCHES = positiveIntEnv("HUMAIN_ORCHESTRATOR_MAX_CONCURRENCY", 4);
/** Hard ceiling on lead fan-out, so a malformed topology can't spawn unbounded leads. */
const MAX_LEADS = positiveIntEnv("HUMAIN_ORCHESTRATOR_MAX_LEADS", 8);
/** Per-dispatch wall clock for a LEAF dispatch that does its own work directly. */
const DISPATCH_TIMEOUT_MS = positiveIntEnv("HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS", 20 * 60 * 1000);

/**
 * Telemetry batching. Records written within this window share one Python `batch`
 * process; a Python start-up costs ~250 ms, so a shorter window buys nothing. The
 * batch size stays well under Python's 500-record validation limit. Terminal writes
 * (run complete/fail/cancel/crash, session shutdown) flush immediately regardless.
 */
const TELEMETRY_FLUSH_MS = positiveIntEnv("HUMAIN_ORCHESTRATOR_TELEMETRY_FLUSH_MS", 500);
const TELEMETRY_MAX_BATCH = positiveIntEnv("HUMAIN_ORCHESTRATOR_TELEMETRY_BATCH", 100);


/**
 * Bounds the aggregate parent-owned recon evidence packet handed to every
 * lead prompt (see `formatReconEvidence` in recon.ts). Derived from
 * method.json's `evidence_packet_max_tokens` — a token budget the policy
 * already declares — via a conservative ~4 chars/token estimate, rather than
 * inventing a new, undeclared character cap.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;
const RECON_EVIDENCE_MAX_CHARS = positiveIntEnv(
	"HUMAIN_ORCHESTRATOR_RECON_EVIDENCE_MAX_CHARS",
	METHOD.rules.pre_implementation_recon.evidence_packet_max_tokens * CHARS_PER_TOKEN_ESTIMATE,
);

// `dispatchTimeoutFor()` + LEAD_DISPATCH_TIMEOUT_MS lived here. Dropped in
// favour of main's progress-aware lead timeouts (`cb9f51e`): a flat per-
// capability ceiling is exactly what that change replaced, and
// ORCHESTRATING_CAPABILITIES now drives `opts.leadTimeouts` in
// runSubagentProcess instead.

export { guardChildStreamHandler };

let dispatchReaperInstalled = false;

/** Kill every in-flight dispatch subtree when this process goes down. */
function installDispatchReaper(): void {
	if (dispatchReaperInstalled) return;
	dispatchReaperInstalled = true;
	const reap = () => {
		for (const pid of liveDispatchPids) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		liveDispatchPids.clear();
	};
	process.once("exit", reap);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		// `once` + re-raise keeps HT's own handlers intact: we only add cleanup,
		// we don't change whether the parent exits.
		process.once(signal, () => {
			ACTIVE_RUN?.cancel("signal");
			// Best effort only. A signal handler cannot await, so this merely *starts* a drain of
			// records still inside the coalescing window; whether the Python child gets to run
			// before HT exits depends on HT's own shutdown sequencing. Anything it does not
			// reach is lost with the process. The guaranteed drains are the awaited ones: the
			// run's terminal path (complete/fail/cancel/crash) and the `session_shutdown` hook.
			void recordQueue.flush();
			reap();
		});
	}
}

/**
 * Age after which an unclaimed persona temp dir is considered orphaned. Leads may
 * run up to the absolute ceiling (6h by default), but each prompt file is read
 * once when its child starts, so the TTL only needs to cover spawn.
 */
const PERSONA_TMP_TTL_MS = Math.max(2 * 60 * 60 * 1000, DISPATCH_TIMEOUT_MS * 6);

/**
 * Best-effort reap of persona prompt dirs left behind when a parent orchestrator
 * was killed mid-dispatch (SIGKILL skips every cleanup path we control). Runs
 * once at activation; age-gated so concurrently running dispatches are safe.
 */
function reapOrphanedPersonaDirs(): void {
	try {
		const root = tmpdir();
		const cutoff = Date.now() - PERSONA_TMP_TTL_MS;
		let reaped = 0;
		for (const entry of readdirSync(root)) {
			if (!entry.startsWith(PERSONA_TMP_PREFIX)) continue;
			const full = join(root, entry);
			try {
				if (statSync(full).mtimeMs > cutoff) continue;
				rmSync(full, { recursive: true, force: true });
				reaped++;
			} catch {
				/* another process may own or have already removed it */
			}
		}
		if (reaped > 0) {
			console.warn(`[orchestrator] reaped ${reaped} orphaned persona temp dir(s) in ${root}`);
		}
	} catch {
		/* temp dir unreadable — nothing to reap */
	}
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the results. Replaces a bare `Promise.all` fan-out that spawned one
 * child process per task with no cap.
 */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

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

/**
 * Last-resort bindings, used only when neither a profile nor the dynamic
 * resolver yields a model for a capability. Mirrors the shipped `premium`
 * profile (bridge/orchestrator-profiles.json).
 */
const FALLBACK_ADAPTER: Record<string, { model: string; effort?: string }> = {
	scout:                { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	worker:               { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	implementation_fast:  { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	analysis_mid:         { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	technical_lead:       { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	lead_small:           { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	implementation_strong:{ model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	qa_agent:             { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	technical_review:     { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	integration_review:   { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	migration_review:     { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	performance_review:   { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	api_contract_review:  { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	lead:                 { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	architect:            { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	analysis_strong:      { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	security_review:      { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	lead_large:           { model: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
};


type Adapter = Record<string, Binding>;

/**
 * Cohort tags stamped on every model_call / route_executed row of the active
 * run so routing history can be grouped by profile, resolved adapter, and
 * lead size. One orchestration runs at a time (ACTIVE_RUN); reset per run.
 */
interface RunTags {
	profile?: string;
	policy_id?: string;
	lead_size?: LeadSize;
}
let CURRENT_RUN_TAGS: RunTags = {};
/** Alias table of the active run, for codex -> Bedrock quota fallback. */
let CURRENT_ALIAS_TABLE: AliasTable | null = null;
/** `resolved.sources` of the active run's adapter, for model-canary `explicitOverride` detection
 *  (a capability whose binding source is `"flag"` was pinned by the operator, so a canary must
 *  never override it). Reset per run, like `CURRENT_ALIAS_TABLE`. */
let CURRENT_MODEL_SOURCES: Record<string, BindingSource> = {};

/** `<profile>-<sha256(canonical adapter)[:8]>`: stable for identical bindings. */
export function policyIdFor(profileName: string, adapter: Record<string, Binding>): string {
	const canon = Object.keys(adapter)
		.sort()
		.map((c) => `${c}=${adapter[c]?.model ?? ""}@${adapter[c]?.effort ?? ""}`)
		.join(";");
	return `${profileName}-${createHash("sha256").update(canon).digest("hex").slice(0, 8)}`;
}

/** Per-run overrides parsed from /orchestrate flags. */
interface ModelOverrides {
	tiers: Partial<Record<Tier, string>>;
	capabilities: Record<string, Binding>;
	/** Run-wide `--effort`; wins over every per-capability effort. */
	effort?: string;
	/** `--profile <name>`; defaults to the file's active_profile. */
	profile?: string;
}

function emptyOverrides(): ModelOverrides {
	return { tiers: {}, capabilities: {} };
}

async function loadDynamicAdapter(): Promise<{ adapter: Adapter; warning?: string }> {
	try {
		const expandedSkillRoot = SKILL_ROOT.replace(/^~/, homedir());
		const child = spawn(
			PYTHON,
			["-m", "orchestrator.cli", "resolve-adapter", "--explain"],
			{
				env: {
					...process.env,
					PYTHONPATH: expandedSkillRoot,
					CODING_AGENT_RUNTIME: "humain-terminal",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (b) => (stdout += b.toString()));
		child.stderr.on("data", (b) => (stderr += b.toString()));
		const exitCode = await new Promise<number>((resolve) =>
			child.on("close", (code) => resolve(code ?? -1)),
		);
		if (exitCode !== 0) {
			return { adapter: {}, warning: `resolve-adapter failed (exit ${exitCode}): ${stderr.trim().slice(0, 300)}` };
		}
		const resolved = JSON.parse(stdout.trim()) as Record<string, any>;
		const out: Adapter = {};
		for (const [cap, info] of Object.entries(resolved)) {
			if (!info || typeof info !== "object" || cap.startsWith("_")) continue;
			if (!info.provider || !info.model) continue;
			out[cap] = { model: `${info.provider}/${info.model}` };
		}
		return { adapter: out, warning: Object.keys(out).length === 0 ? "resolve-adapter returned no bindings" : undefined };
	} catch (err) {
		return { adapter: {}, warning: `resolve-adapter error: ${(err as Error).message}` };
	}
}

// -----------------------------------------------------------------------------
// Profiles file I/O
// -----------------------------------------------------------------------------

interface LoadedProfiles {
	file: ProfilesFile;
	/** true when the file exists on disk (vs. synthesized defaults). */
	present: boolean;
	problems: string[];
	notes: string[];
}

function writeProfilesFile(file: ProfilesFile): void {
	// Atomic: a crash mid-write must not leave a truncated config behind.
	mkdirSync(dirname(PROFILES_PATH), { recursive: true });
	const tmp = `${PROFILES_PATH}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, PROFILES_PATH);
}

/**
 * Load profiles. When the file does not exist but the legacy adapter file
 * does, migrate it into profile "default" once and write the new file, so the
 * user's existing bindings keep working under the new scheme.
 */
function loadProfiles(): LoadedProfiles {
	const notes: string[] = [];
	if (existsSync(PROFILES_PATH)) {
		try {
			const { file, problems } = parseProfilesFile(JSON.parse(readFileSync(PROFILES_PATH, "utf-8")));
			if (existsSync(LEGACY_ADAPTER_PATH)) {
				notes.push(`${LEGACY_ADAPTER_PATH} is ignored now that ${PROFILES_PATH} exists; delete it to silence this note.`);
			}
			return { file, present: true, problems, notes };
		} catch (err) {
			return {
				file: emptyProfilesFile(),
				present: true,
				problems: [`${PROFILES_PATH} could not be parsed: ${(err as Error).message}`],
				notes,
			};
		}
	}
	// No profiles file: run on the dynamic resolver + fallback bindings and say
	// how to get the shipped profiles. Loading never writes: install.sh copies
	// bridge/orchestrator-profiles.json (active "premium"), backing up any file
	// it replaces. The legacy adapter is no longer migrated into a "default"
	// profile; that profile was retired.
	notes.push(`${PROFILES_PATH} not found; using dynamic/fallback bindings. Run install.sh to install the shipped profiles (${shippedProfilesPath()}).`);
	if (existsSync(LEGACY_ADAPTER_PATH)) {
		notes.push(`${LEGACY_ADAPTER_PATH} is ignored; the shipped profiles replace it.`);
	}
	return { file: emptyProfilesFile(), present: false, problems: [], notes };
}

function availableModels(ctx: ExtensionContext): AvailableModel[] {
	try {
		return ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning }));
	} catch {
		return [];
	}
}

interface FullResolution extends ResolvedAdapter {
	profileName: string;
	profiles: LoadedProfiles;
	table: AliasTable;
	preference: string[];
	candidates?: Record<string, Candidate[]>;
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
	const profiles = loadProfiles();
	const table = buildAliasTable(availableModels(ctx));
	const preference = profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE;
	const profileName = overrides.profile ?? profiles.file.active_profile;
	const profile = profiles.file.profiles[profileName];
	const warnings: string[] = [...profiles.problems];
	if (!profile) {
		warnings.push(
			`(profile:${profileName}) profile "${profileName}" is not defined in ${PROFILES_PATH} (have: ${Object.keys(profiles.file.profiles).join(", ") || "none"})`,
		);
	}
	const dynamic = await loadDynamicAdapter();
	if (dynamic.warning) warnings.push(dynamic.warning);

	const layers: Layer[] = [
		{ source: "flag", bindings: { ...tiersToBindings(overrides.tiers), ...overrides.capabilities } },
		{
			source: `profile:${profileName}`,
			bindings: Object.fromEntries(Object.entries(profile?.capabilities ?? {}).map(([c, m]) => [c, { model: m }])),
		},
		{ source: `profile:${profileName}`, bindings: tiersToBindings(profile?.tiers) },
		{ source: "dynamic", bindings: dynamic.adapter },
		{ source: "fallback", bindings: FALLBACK_ADAPTER },
	];
	const merged = mergeLayers(layers, table, preference, profile?.effort ?? {}, overrides.effort);
	let modelFacts: Record<string, import("./adapters/model-catalog.ts").ModelFacts> = {};
	if (existsSync(MODEL_FACTS_PATH)) {
		try {
			const parsed = parseModelFacts(JSON.parse(readFileSync(MODEL_FACTS_PATH, "utf-8")));
			modelFacts = parsed.facts;
			warnings.push(...parsed.problems);
		} catch (error) {
			warnings.push(`model facts file could not be read: ${(error as Error).message}`);
		}
	}
	const catalog = buildCatalog(table.models, modelFacts);
	const tierPrimaries: Partial<Record<Tier, string>> = {};
	for (const [capability, binding] of Object.entries(merged.adapter)) {
		const tier = tierOf(capability);
		if (tier && !tierPrimaries[tier]) tierPrimaries[tier] = binding.model;
	}
	const candidates = Object.fromEntries(ALL_CAPABILITIES.flatMap((capability) => {
		const primary = merged.adapter[capability]?.model;
		return primary ? [[capability, resolveCandidates({ capability, primary, backups: profile?.backups, tierPrimaries, adapter: merged.adapter, table, preference, catalog })]] : [];
	}));
	// Fallback/dynamic specs are canonical already but may name models the user
	// has not configured; those show up as non-user warnings and are informational.
	return {
		...merged,
		warnings: [...warnings, ...merged.warnings],
		profileName,
		profiles,
		table,
		preference,
		candidates,
	};
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

const VALID_TASK_CLASSES = [
	"implementation",
	"investigation",
	"bug_fix",
	"refactor",
	"test",
	"documentation",
	"design",
	"qa_verification",
];

const VALID_RISKS = ["low", "medium", "high", "critical"];

interface TriageResult {
	task_class: string;
	complexity: number;
	risk: string;
	reasoning: string;
}

const TRIAGE_PROMPT = [
	"You are a task classifier for an autonomous coding orchestrator.",
	"Given the user\'s task goal below, classify it.",
	"Return ONLY a single valid JSON object (no markdown, no commentary, no extra text).",
	"",
	"JSON schema (all fields required):",
	'- "task_class": one of ' + JSON.stringify(VALID_TASK_CLASSES),
	'- "complexity": integer 1-10 (1=typo/one-liner, 10=multi-system architectural change spanning many files)',
	'- "risk": one of ' + JSON.stringify(VALID_RISKS) +
	  " (low=isolated change with no security/perf/data impact; " +
	  "critical=auth, payments, PII, or production data-loss potential)",
	'- "reasoning": one short sentence (<=120 chars) explaining the classification',
	"",
	"Task goal:",
].join("\n");

function heuristicTriage(goal: string): TriageResult {
	// Cheap fallback when LLM triage is unavailable. Keyword-based with
	// conservative defaults. Intentionally under-confident.
	const text = goal.toLowerCase();
	let task_class = "implementation";
	if (/\b(fix|bug|broken|regress|issue|defect|error|failing)\b/.test(text)) task_class = "bug_fix";
	else if (/\b(refactor|reorgani[sz]e|restructure|clean up|tidy|modernize|rename|extract|split)\b/.test(text)) task_class = "refactor";
	else if (/\b(test|spec|coverage|jest|vitest|unit test|integration test)\b/.test(text)) task_class = "test";
	else if (/\b(investigate|why|investigate|root cause|debug|diagnose|triage|assess)\b/.test(text)) task_class = "investigation";
	else if (/\b(design|architect|propose|plan|spec|adr|whitepaper|rfc)\b/.test(text)) task_class = "design";
	else if (/\b(document|docs|readme|comment|jsdoc|tsdoc|changelog|wiki)\b/.test(text)) task_class = "documentation";
	else if (/\b(qa|verify|validate|check|audit|review|test plan)\b/.test(text)) task_class = "qa_verification";

	let complexity = 5;
	if (goal.length < 50) complexity = 3;
	else if (goal.length > 200) complexity = 7;
	if (/\b(refactor|architect|across|multiple|system|migration|rewrite|overhaul)\b/.test(text)) complexity = Math.max(complexity, 6);
	if (/\b(typo|one[- ]liner|small|tiny|minor|simple|quick|trivial|rename variable|update deps|bump version)\b/.test(text)) complexity = Math.min(complexity, 3);

	let risk: string = "medium";
	if (/\b(security|auth|permission|password|token|secret|ssl|tls|encrypt|cve|authn|authz|oauth|saml|sso)\b/.test(text)) risk = "high";
	if (/\b(payment|billing|money|financial|transaction|banking|credit|stripe|paypal|pci|ledger|invoice|payout|charge)\b/.test(text)) risk = "high";
	if (/\b(pii|personal data|gdpr|hipaa|private|redact|anonymize|pii|phi|ferpa|coppa)\b/.test(text)) risk = "high";
	if (/\b(critical|urgent|production|prod|live|customer-facing|p0|p1|sev[01]|outage|downtime|data loss|corruption)\b/.test(text)) risk = "critical";
	if (/\b(test|spec|doc|comment|readme|refactor|rename|cleanup|format|lint|type|typo|styling)\b/.test(text) && risk === "medium") risk = "low";

	return {
		task_class,
		complexity,
		risk,
		reasoning: `Heuristic: matched ${task_class} keywords; complexity by length/risk by keyword.`,
	};
}

/**
 * Normalise any complexity input (triage JSON or the manual `--complexity`
 * flag) to the integer 1-10 scale method.json's Rule-2 bands are defined on.
 * Out-of-band values (6.5, 12) otherwise match no `workers_by_complexity`
 * band, silently plan zero recon workers, and make the no-recon phase line
 * report a false reason.
 */
export function clampComplexity(raw: unknown, fallback = 5): number {
	// Only numbers and non-empty numeric strings are complexity values; null,
	// "", booleans and arrays mean "absent" and must take the fallback rather
	// than coerce to 0 and collapse to the minimum (which would skip recon).
	if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : fallback;
}

function clampTriage(raw: Partial<TriageResult>): TriageResult | null {
	if (!raw || typeof raw !== "object") return null;
	const task_class = VALID_TASK_CLASSES.includes(raw.task_class ?? "")
		? raw.task_class!
		: "implementation";
	const complexity = clampComplexity(raw.complexity);
	const risk = VALID_RISKS.includes(raw.risk ?? "") ? raw.risk! : "medium";
	const reasoning = typeof raw.reasoning === "string" && raw.reasoning.length > 0
		? raw.reasoning.slice(0, 200)
		: "(no reasoning returned)";
	return { task_class, complexity, risk, reasoning };
}

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
function reportedCost(total: unknown): number | undefined {
	return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}



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

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

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

/** Braille-pattern spinner frames, ticked by the run's existing 1s interval. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function spinnerFrame(now: number): string {
	return SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length];
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

/**
 * Swallow throws from `ctx.ui` access. `ctx.ui` can become unavailable after the session
 * that owns it has moved on (shutdown, a later session start racing the tail of this run's
 * cleanup) — that failure is not this run's problem: the run has already been logged and
 * recorded, so a UI notify/setWidget/setStatus call failing here must never crash the
 * terminal or cleanup path.
 */
function safeUi(fn: () => void): void {
	try {
		fn();
	} catch {
		/* ctx.ui is unavailable; the run's outcome is already recorded */
	}
}

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

	/** Feed a parsed `--mode json` event from a child. */
	onChildEvent(taskId: string, event: any): void {
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
				if (event.message?.role === "assistant") {
					d.turns += 1;
					d.costUsd += reportedCost(event.message?.usage?.cost?.total) ?? 0;
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



/** The run currently owning the UI. Only one /orchestrate may be live per session. */
let ACTIVE_RUN: RunSession | null = null;

/** Reads `ACTIVE_RUN` through a function boundary so TS control-flow narrowing (which assumes
 *  a module-level `let` can't change between two reads in the same function) doesn't hide a
 *  second, later check as unreachable — it deliberately can: another `/orchestrate` invocation
 *  may reassign `ACTIVE_RUN` during the `await` between the two checks. */
function getActiveRun(): RunSession | null {
	return ACTIVE_RUN;
}

/** Test seam: the module has no other way to observe the run-scoped singleton. */
export function activeRunForTest(): RunSession | null {
	return ACTIVE_RUN;
}

/** Test seam: lets a test simulate ACTIVE_RUN having been reassigned to a newer run out from
 *  under a stale one, to exercise the finally-block guard that must not clobber it. Not used
 *  by production code, which only ever assigns `ACTIVE_RUN` via the guarded paths above. */
export function setActiveRunForTest(run: RunSession | null): void {
	ACTIVE_RUN = run;
}

/**
 * `/orchestrate`'s `RunRegistry` (A1 unification): `registerOrchestrateCommand`
 * (commands/orchestrate.ts) claims/releases this registry instead of assigning `ACTIVE_RUN`
 * directly, but every OTHER ACTIVE_RUN-reading seam in this file (`dispatchParallel`'s message
 * draining, `checkModels`'s mutual-exclusion guard, the signal handler, `/orchestrate-cancel`,
 * `/omsg`, the `orchestrator_status` tool) still reads the legacy module-scope singletons
 * (`ACTIVE_RUN`/`CURRENT_RUN_TAGS`/`CURRENT_ALIAS_TABLE`) directly, unchanged. This subclass
 * keeps both in sync: claiming/releasing through the registry also assigns/clears those
 * singletons, exactly as the pre-unification inline handler did inline, so every legacy seam
 * keeps working without having to be threaded onto `RunContext` itself in this pass. Every
 * session this registry ever claims is, in practice, one of THIS file's own `RunSession`
 * instances (via `deps.createSession` below) — the `as RunSession` cast reflects that invariant,
 * not a runtime guess. */
class SyncedRunRegistry extends RunRegistry<RunSessionLike> {
	override claim(
		session: RunSessionLike,
		tags: RunTags = {},
		aliasTable: AliasTable | null = null,
		modelSources: Record<string, BindingSource> | null = null,
		routing?: { candidates: Record<string, Candidate[]>; modelHealth: ModelHealthType },
	): RunContext<RunSessionLike> | null {
		const claimed = super.claim(session, tags, aliasTable, modelSources, routing);
		if (claimed) {
			ACTIVE_RUN = session as RunSession;
			CURRENT_RUN_TAGS = tags;
			CURRENT_ALIAS_TABLE = aliasTable;
			CURRENT_MODEL_SOURCES = modelSources ?? {};
		}
		return claimed;
	}
	override release(context: RunContext<RunSessionLike>): void {
		super.release(context);
		if (ACTIVE_RUN === context.session) {
			ACTIVE_RUN = null;
			CURRENT_RUN_TAGS = {};
			CURRENT_ALIAS_TABLE = null;
			CURRENT_MODEL_SOURCES = {};
		}
	}
}

/** The one `RunRegistry` instance `/orchestrate` (commands/orchestrate.ts, via
 *  `registerOrchestrateCommand`) claims for the run it is managing. */
const runRegistry = new SyncedRunRegistry();

/** Test seam: exposes the module's one production `RunRegistry` instance so a test can exercise
 *  the mutual-exclusion guarantee `/orchestrate` and `checkModels` (`/orchestrator-models check`)
 *  share — claiming it directly (standing in for "the other side is holding it") and then invoking
 *  the other side's real handler/function, without having to run either one's full pipeline just
 *  to reach its own claim boundary. Not used by production code. */
export function runRegistryForTest(): RunRegistry<RunSessionLike> {
	return runRegistry;
}

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
			if (!ACTIVE_RUN) {
				return { content: [{ type: "text", text: "No orchestrator run is active." }], details: undefined };
			}
			const snapshot = ACTIVE_RUN.statusSnapshot(params.logLines ?? 20);
			return {
				content: [{ type: "text", text: formatOrchestratorStatus(snapshot) }],
				details: snapshot,
			};
		},
	});
}

/**
 * Spawn a one-shot subagent and parse its JSON event stream. The lifecycle
 * (timeouts, post-end grace, spend caps, stderr capture) lives in
 * dispatch/child-process.ts; this wrapper only supplies the live run session,
 * telemetry sink and process env when the caller omits them.
 */
export function runSubagentProcess(
	opts: Omit<Parameters<typeof runChildProcess>[0], "env" | "session" | "recordEvent"> & {
		session?: RunSession;
		env?: () => NodeJS.ProcessEnv;
		recordEvent?: (event: string, payload: Record<string, unknown>) => void;
	},
): Promise<SubagentProcessResult> {
	return runChildProcess({
		...opts,
		session: opts.session ?? ACTIVE_RUN ?? undefined,
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
	run: RunContext<RunSessionLike> | null,
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
		const session = run?.session as RunSession | undefined;
		const capability = adapter.implementation_fast ? "implementation_fast" : adapter.worker ? "worker" : "scout";
		const declared = run?.candidates?.[capability];
		const twin = run?.aliasTable ? bedrockFallbackFor(cheapest.model, run.aliasTable) : null;
		const routeCandidates = declared ? usableModels(declared, cheapest.model) : [cheapest.model, ...(twin ? [twin] : [])];
		const failover = await dispatchWithFailover({ taskId: "triage", capability, prompt }, routeCandidates, {
			runAttempt: (model, task, attempt, spendCapOffsetUsd) => runSubagentProcess({
				cwd, agentName: "orch-implementation-fast", task, model, ctx,
				taskId: attempt === 1 ? "triage" : `triage-fallback-${attempt - 1}`,
				label: attempt === 1 ? "triage" : `triage↻${attempt - 1}`, capability,
				session, spendCapOffsetUsd,
			}),
			readEvents: (result) => result.rawStdout.split(/\r?\n/),
			snapshot: () => gitDirtySnapshot(cwd),
			changedSince: (snapshot) => diffDirtySnapshots(snapshot as Map<string, string> | null, gitDirtySnapshot(cwd), []).changed,
			sleep: async (ms) => {
				if (!session) return;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => { remove(); resolve(); }, ms);
					const remove = session.cancellation.onCancel(() => { clearTimeout(timer); remove(); resolve(); });
				});
			},
			health: run?.modelHealth ?? new ModelHealth(),
			isCancelled: () => session?.cancellation.isCancelled ?? false,
			recordEvent: (event, payload) => recordEvent(event, { run_id: runId, ...payload }),
			log: (line) => session?.log(line), config: failoverConfig(), redact: redactPaths,
			effortDropped: (model) => Boolean(cheapest.effort && !declared?.find((candidate) => candidate.model === model)?.effortControl),
		});
		const r = failover.result;
		// Every provider attempt is billed independently, including a superseded
		// classifier call; malformed final output still leaves honest cost rows.
		for (let index = 0; index < failover.attempts.length; index++) {
			const attempt = failover.attempts[index];
			costSink.usd += attempt.result.costUsd;
			await captureDispatchCost(
				{ runId, planId: "triage", taskClass: "triage", complexity: 5, risk: "medium",
					recommended: { capability: "implementation_fast", effort: "low", verification_depth: "none" }, mode: "triage" },
				{ taskId: index === 0 ? "triage" : `triage-fallback-${index}`, capability: "triage", model: attempt.result.model ?? attempt.model,
					exitCode: attempt.result.exitCode, stdout: attempt.result.stdout, stderr: attempt.result.stderr, usage: attempt.result.usage,
					durationMs: attempt.result.durationMs, costUsd: attempt.result.costUsd, costReported: attempt.result.costReported,
					stopReason: attempt.result.stopReason, filesChanged: [] },
			);
		}
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
		// Strip markdown fences if the model wrapped anyway.
		const jsonText = text
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/```\s*$/i, "")
			.trim();
		const firstBrace = jsonText.indexOf("{");
		const lastBrace = jsonText.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
		const parsed = JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
		const clamped = clampTriage(parsed);
		if (!clamped) return null;

		return clamped;
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

function runCli(args: string[], stdin?: string): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn(PYTHON, ["-m", "orchestrator.cli", ...args], {
			env: {
				...process.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (b) => (stdout += b.toString()));
		child.stderr.on("data", (b) => (stderr += b.toString()));
		child.on("close", (code) =>
			resolve({ stdout, stderr, exitCode: code ?? -1 }),
		);
		if (stdin) child.stdin.write(stdin);
		child.stdin.end();
	});
}

/**
 * Run a Python module under the orchestrator's SKILL_ROOT. We set
 * CODING_AGENT_RUNTIME so the dispatched metrics land under
 * `agent_runtime: "humain-terminal"`, PYTHONPATH so the `orchestrator`
 * package is importable, and CODING_AGENT_ORCHESTRATOR_HOME points at the
 * same state root as the HT hook. `stdin`, when given, is written and closed before the
 * child runs (the `batch -` command reads its payload from stdin).
 *
 * Always resolves exactly once: on `close`, or on a spawn `error` (ENOENT, EACCES,
 * EAGAIN) in case the runtime never follows it with `close`. A spawn failure is
 * reported as a negative exit code with the error in `stderr`, which the record
 * queue treats as ambiguous and replays. `python` is injectable for tests only.
 */
export function runModule(module: string, args: string[] = [], stdin?: string, options: { python?: string } = {}): Promise<CliResult> {
	return new Promise((resolve) => {
		const expandedSkillRoot = SKILL_ROOT.replace(/^~/, homedir());
		const expandedStateRoot = STATE_ROOT.replace(/^~/, homedir());
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (exitCode: number) => {
			if (settled) return;
			settled = true;
			resolve({ stdout, stderr, exitCode });
		};
		const child = spawn(options.python ?? PYTHON, ["-m", module, ...args], {
			env: {
				...process.env,
				CODING_AGENT_RUNTIME: "humain-terminal",
				CODING_AGENT_REPOSITORY: process.env.CODING_AGENT_REPOSITORY ?? process.cwd(),
				PYTHONPATH: expandedSkillRoot,
				CODING_AGENT_ORCHESTRATOR_HOME: expandedStateRoot,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", (b) => (stdout += b.toString()));
		child.stderr.on("data", (b) => (stderr += b.toString()));
		child.on("error", (err) => {
			stderr += `\n[orchestrator] spawn error: ${err.message}`;
			settle(-1);
		});
		child.on("close", (code) => settle(code ?? -1));
		// A child that exits before reading its payload closes the pipe under us; that is
		// reported through the exit code, not as an uncaught EPIPE.
		child.stdin.on("error", () => {});
		if (stdin !== undefined) child.stdin.end(stdin);
	});
}

// -----------------------------------------------------------------------------
// Plan + route types
// -----------------------------------------------------------------------------

interface PlanResponse {
	plan_id: string;
	run_id: string;
	task_class: string;
	complexity: number;
	risk: string;
	topology: {
		depth: number;
		leads: number;
		workers: number;
		shape: string;
	};
	route: {
		selected: {
			capability: string;
			effort: string;
			verification_depth: string;
		};
		recommended: {
			capability: string;
			effort: string;
			verification_depth: string;
		};
		mode: string;
		history_sufficient: boolean;
		explanation: Record<string, unknown>;
	};
	effective_quality_floor: number;
	cost_aggressiveness: number;
}

interface PlanOptions {
	goal: string;
	taskClass: string;
	complexity: number;
	risk: string;
	qualityFloor?: number;
	costAggressiveness?: number;
}

async function planRun(runId: string, opts: PlanOptions): Promise<PlanResponse> {
	// `--coupling`/`--parallelizable` are omitted: the Python CLI's `plan` subparser already
	// defaults both to 0.5 (`orchestrator/cli/routing_cmds.py`).
	const args = ["plan", runId, opts.taskClass, String(opts.complexity), opts.risk];
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
export const recordQueue = new RecordQueue({
	run: (records) => runModule("orchestrator.cli", ["batch", "-"], JSON.stringify(records)),
	maxBatch: TELEMETRY_MAX_BATCH,
	flushDelayMs: TELEMETRY_FLUSH_MS,
	onError: (message) => {
		console.warn(`[orchestrator] ${message}`);
		ACTIVE_RUN?.log(`telemetry: ${message}`);
	},
});

/** Queue an event row. Synchronous: progress never waits on a Python process. */
export function recordEvent(event: string, payload: Record<string, unknown>): void {
	recordQueue.enqueue("event", { ...payload, event });
}

/** Queue a metric row (model_call / route_executed). */
export function recordModelCall(metric: Record<string, unknown>): void {
	recordQueue.enqueue("metric", metric);
}

/** Queue an outcome row. Terminal run outcomes go through completeRun/failRun, which also drain. */
export function recordOutcome(outcome: Record<string, unknown>): void {
	recordQueue.enqueue("outcome", outcome);
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

/** Terminal-boundary time fields written to the run outcome row: see `run/context.ts`. */
export type { RunTiming };

/**
 * Durable evidence that THIS process owns a run, cheap enough to capture with no syscalls
 * beyond what Node already tracks. `process_started_at_ms` is derived from `process.uptime()`,
 * not `/proc` (portable across macOS/Linux without a native call): it is stable for the life of
 * this process and changes whenever a pid is reused by a different process, which is exactly
 * the ambiguity a liveness check on the Python side needs to rule out (same host + same pid but
 * a DIFFERENT process must never be read as "still running").
 */
function processIdentity(): { pid: number; hostname: string; process_started_at_ms: number } {
	return { pid: process.pid, hostname: hostname(), process_started_at_ms: Math.round(Date.now() - process.uptime() * 1000) };
}

/**
 * Record that a run has started, with durable ownership evidence (pid/hostname/process-start
 * identity + a session identity, when available) so a later Python-side reconciliation can tell
 * "this run's owning process is confirmed gone" from "we simply have no evidence either way" —
 * see `orchestrator/run_evidence.py`'s restart classifier (which reads only `pid`/`hostname`; it
 * never reads `session_id`). No heartbeat/timer is added: this is a single fact recorded once, at
 * the run's start boundary, alongside the process that will also write its own terminal event
 * when it exits normally.
 *
 * `sessionId`, when the runtime supplies one, is the session's own file path — an ABSOLUTE path on
 * the host machine, which can embed the OS username / home-directory layout into a durable,
 * shared telemetry log for no functional benefit (liveness never reads it; see above). Only the
 * basename is recorded, matching the identity a human or a later reconciliation actually needs to
 * find the right session without leaking the rest of the path.
 */
export function recordRunStarted(runId: string, sessionId: string | null): void {
	recordEvent("run_started", { run_id: runId, started_at: new Date().toISOString(), session_id: sessionId ? basename(sessionId) : null, ...processIdentity() });
}

/** Runs whose terminal event (`run_completed`/`run_failed`/`run_cancelled`) has already been
 *  recorded. Exactly one terminal event may ever be written per run_id — a second terminal path
 *  firing for the same run (for example a signal cancelling a run whose own catch block is
 *  already writing `run_failed`) must be a no-op here, not a second row. */
const runsWithTerminalEvent = new Set<string>();

function claimTerminalEvent(runId: string, kind: string): boolean {
	if (runsWithTerminalEvent.has(runId)) {
		console.warn(`[orchestrator] run ${runId} already has a terminal event; skipping duplicate ${kind}`);
		return false;
	}
	runsWithTerminalEvent.add(runId);
	return true;
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
	const session = ACTIVE_RUN?.runId === runId ? ACTIVE_RUN : null;
	if (claimTerminalEvent(runId, "run_completed")) {
		recordEvent("run_completed", { run_id: runId, ...timing });
		recordOutcome({ ...runCompletionOutcomeFor(runId, summary), ...timing });
	}
	const report = reportSince(await recordQueue.flush(), since);
	session?.acknowledgeTerminal(report.ok);
	return report;
}

export async function failRun(runId: string, error: string, timing?: RunTiming, since?: QueueStats): Promise<FlushReport> {
	const session = ACTIVE_RUN?.runId === runId ? ACTIVE_RUN : null;
	if (claimTerminalEvent(runId, "run_failed")) {
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
	}
	const report = reportSince(await recordQueue.flush(), since);
	session?.acknowledgeTerminal(report.ok);
	return report;
}

/**
 * Reasons stamped on `run_cancelled`. `signal` covers OS-level interrupts (Ctrl+C sends
 * `SIGINT`, same as `SIGTERM`/`SIGHUP`); HUMAIN Terminal exposes no extension hook for the
 * Esc key by itself distinct from Ctrl+C at this layer, so an Esc-driven cancel of a
 * background orchestration surfaces here as `signal` too. `session_shutdown` is the
 * best-effort drain on process exit; `orchestrate_cancel` is the explicit `/orchestrate-cancel`
 * command.
 */
export function cancelReasonLabel(reason: "user" | "shutdown" | "signal" | undefined): string {
	switch (reason) {
		case "shutdown":
			return "session_shutdown";
		case "signal":
			return "signal";
		case "user":
			return "orchestrate_cancel";
		default:
			return "unknown";
	}
}

/**
 * Record a run's terminal outcome as CANCELLED (never as failed): distinct from `failRun` so a
 * dead-process reconciliation and a dashboard status count can tell a deliberate stop from a
 * crash. Same timing/draining contract as `completeRun`/`failRun`.
 */
export async function cancelRun(runId: string, reason: string, timing?: RunTiming, since?: QueueStats): Promise<FlushReport> {
	const session = ACTIVE_RUN?.runId === runId ? ACTIVE_RUN : null;
	if (claimTerminalEvent(runId, "run_cancelled")) {
		recordEvent("run_cancelled", { run_id: runId, reason, ...timing });
		recordOutcome({
			run_id: runId,
			task_id: "run-cancelled",
			outcome: "cancelled",
			verification_scope: "run",
			quality: 0,
			note: reason,
			...timing,
		});
	}
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
 * One task for `dispatchParallel()`. Declared standalone rather than derived
 * from `recon.ts`'s `ReconTaskPlan`: the bridge's dispatch contract is the
 * general case and must not depend on the pure Rule-2 recon module, which is
 * only one of its callers. `ReconTaskPlan` is structurally assignable here
 * (its `tools` is required, this one's is optional), and the annotation on
 * `reconTasks` in `dispatchHierarchical()` fails the typecheck if that ever
 * stops being true.
 */
export interface DispatchTask {
	taskId: string;
	capability: string;
	task: string;
	/**
	 * Explicit tool allow-list, overriding whatever the bound persona permits.
	 * Recon always specifies this; other dispatches omit it and inherit their
	 * persona's own tools.
	 */
	tools?: string[];
	retryOf?: string;
	retryCount?: number;
	/** Optional operator-supplied phase label for telemetry (e.g. "implementation", "review");
	 *  never read by dispatch logic itself. */
	phase?: string;
}

export interface DispatchResult {
	taskId: string;
	capability: string;
	model: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	usage: SubagentSingleResult["usage"];
	durationMs: number;
	costUsd: number;
	/** Spend of the dispatch's own `subagent` calls (a lead's implementers/reviewers); not in `costUsd`. */
	nestedCostUsd?: number;
	/** Per-task detail behind `nestedCostUsd`, when any nested subagent calls were observed. */
	nestedCalls?: NestedCallDetail[];
	costReported: boolean;
	stopReason?: string;
	outcome?: SubagentProcessResult["outcome"];
	timeoutReason?: "inactivity" | "absolute";
	interruption?: InterruptionReport;
	filesChanged: string[];
	/** HT thinking level the dispatch ran at (from the binding), when one was set. */
	effort?: string;
	/** Observational-only (Phase 2) per-dispatch telemetry; see dispatch-telemetry.ts. */
	telemetry?: DispatchTelemetryFields;
	/** Model canary assignment/telemetry for this dispatch (baseline under the shipped config);
	 *  see model-canary.ts. Observational only — never changes which model is dispatched. */
	canary?: Record<string, unknown>;
	/** `loadEfficiencyControls().enabled` at dispatch time — which efficiency switches were on. */
	experimentFlags?: string[];
	/** Legacy phase evidence, if supplied, for conservative QA scope. */
	scopedPhaseReports?: Array<{ phase: string; exitCode: number; stdout: string }>;
}

export async function dispatchParallel(
	cwd: string,
	runId: string,
	tasks: DispatchTask[],
	adapter: Adapter,
	ctx: ExtensionContext,
	depth: number = 0,
	deps: {
		recordEvent: typeof recordEvent;
		runProcess: typeof runSubagentProcess;
		/** Routed through `deps` so tests can observe nested per-task rows without a real queue. */
		recordModelCall?: typeof recordModelCall;
		/** Alias table for the codex -> Bedrock quota fallback; defaults to the active run's. */
		aliasTable?: AliasTable | null;
		/** Per-capability binding source of the active run's adapter (`"flag"` = explicit operator
		 *  override), for model-canary `explicitOverride` detection; defaults to the active run's
		 *  resolved sources. Test seam. */
		modelSources?: Record<string, BindingSource>;
		/** Efficiency-controls snapshot for the `experiment_flags` telemetry field; test seam. */
		efficiencyControls?: ReturnType<typeof loadEfficiencyControls>;
	} = { recordEvent, runProcess: runSubagentProcess, recordModelCall },
): Promise<DispatchResult[]> {
	if (tasks.length === 0) return [];

	// Drain queued user messages ONCE at the start of this batch. Every task in
	// the batch sees the same messages; the next dispatchParallel call picks up
	// anything that arrived during or after this one. Draining mid-batch would
	// split messages across two prompts in non-obvious ways.
	const session = ACTIVE_RUN;
	const runContext = runRegistry.active();
	const modelHealth = runContext?.modelHealth ?? new ModelHealth();
	const recipient = tasks.length === 1
		? `${tasks[0].capability}:${tasks[0].taskId.replace(`${runId}-`, "")}`
		: `${tasks.length} ${tasks[0].capability} tasks`;
	const userMessages = session ? session.drainMessages(recipient) : [];

	// Phase 2 telemetry (observational only — see model-canary.ts / efficiency-flags.ts):
	// resolved once per batch, not per task, since they are run-wide config, not per-dispatch state.
	const modelSources = deps.modelSources ?? CURRENT_MODEL_SOURCES;
	const canaryConfig = parseModelCanaries((METHOD as unknown as { rules: Record<string, unknown> }).rules.model_canaries).config;
	const efficiencyControls = deps.efficiencyControls ?? loadEfficiencyControls();
	const canaryAliasTable = deps.aliasTable === undefined ? CURRENT_ALIAS_TABLE : deps.aliasTable;

	const taskInputs = tasks.map((t) => {
		// Adapter lookups can return undefined if the dynamic adapter
		// didn't surface every capability (rare but seen during plan-time
		// routing handoffs). Fall back to any binding we can find, then to
		// explicit "unknown" so the dispatch never dereferences undefined.
		const binding =
			adapter[t.capability] ??
			adapter.worker ??
			adapter.scout ??
			Object.values(adapter).find((v) => v && typeof v === "object") ??
			{ model: "unknown" };
		// Observational only: computed for telemetry, never used to decide which model is
		// dispatched (`model:` below always stays `binding.model`). With the shipped
		// (disabled) `model_canaries` config this always assigns cohort "baseline" with
		// `requestedModel === baselineModel`.
		const canaryAssignment = assignCanary({
			runId,
			capability: t.capability,
			baselineModel: binding.model ?? "unknown",
			explicitOverride: modelSources[t.capability] === "flag",
			config: canaryConfig,
			aliasTable: canaryAliasTable,
		});
		return {
			agent: agentNameFor(t.capability),
			task: formatTaskPrompt(t, runId, userMessages),
			model: binding.model ?? "unknown",
			effort: binding.effort,
			tools: t.tools,
			cwd,
			_capability: t.capability,
			_taskId: t.taskId,
			_retryOf: t.retryOf,
			_retryCount: t.retryCount,
			_phase: t.phase,
			_canaryAssignment: canaryAssignment,
		};
	});

	// Direct Pi subprocess fan-out — replaces `createSubagentTool(cwd).execute()`.
	// See the comment on `runSubagentProcess` above for why we don't use the
	// human-facing subagent tool from inside an extension handler. Each
	// worker task becomes its own `humain-terminal --mode json --no-session`
	// subprocess that writes JSON events to stdout; runSubagentProcess
	// parses the assistant `message_end` for model + usage + cost.
	const settled = await mapWithConcurrency(taskInputs, MAX_CONCURRENT_DISPATCHES, async (input) => {
		// `a || b ?? c` is a SyntaxError — mixing || and ?? needs explicit parens.
		// Left unparenthesised this failed to load the whole extension.
		const shortId =
			(input._taskId ?? "").replace(`${runId}-`, "") || input._capability || "task";
		// Queued, not awaited: the child starts now and the record lands in the next
		// batch. Routed through `deps` so tests can observe it; the default binding
		// is the same `recordEvent`, so the queuing behaviour is unchanged.
		deps.recordEvent("dispatch_started", {
			run_id: runId,
			task_id: input._taskId,
			capability: input._capability,
			agent: input.agent,
			model: input.model,
			retry_of: input._retryOf,
		});
		try {
			const runCandidates = runContext?.candidates?.[input._capability];
			const aliasTable = deps.aliasTable === undefined ? CURRENT_ALIAS_TABLE : deps.aliasTable;
			const bedrockTwin = aliasTable ? bedrockFallbackFor(input.model, aliasTable) : null;
			const routeCandidates = runCandidates ? usableModels(runCandidates, input.model) : [input.model, ...(bedrockTwin ? [bedrockTwin] : [])];
			let latestChangedFiles: string[] = [];
			const failover = await dispatchWithFailover({ taskId: input._taskId ?? `unknown-${runId}`, capability: input._capability ?? "unknown", prompt: input.task }, routeCandidates, {
				runAttempt: async (model, prompt, attempt, spentBeforeUsd) => {
					const taskId = attempt === 1 || !input._taskId ? input._taskId : `${input._taskId}-fallback-${attempt - 1}`;
					const result = await deps.runProcess({
						cwd: input.cwd, agentName: input.agent, task: prompt, model, effort: input.effort,
						taskId, label: attempt === 1 ? shortId : `${shortId}↻${attempt - 1}`,
						capability: input._capability, depth, tools: input.tools, ctx, session: session ?? undefined,
						spendCapOffsetUsd: spentBeforeUsd,
					});
					latestChangedFiles = result.personaCanMutate ? parseFilesChanged(result.stdout) : [];
					return result;
				},
				readEvents: (result) => result.rawStdout.split(/\r?\n/),
				snapshot: () => gitDirtySnapshot(cwd),
				changedSince: (snapshot) => diffDirtySnapshots(snapshot as Map<string, string> | null, gitDirtySnapshot(cwd), latestChangedFiles).changed,
				sleep: async (ms) => {
					if (!session) return;
					await new Promise<void>((resolve) => {
						const timer = setTimeout(() => { remove(); resolve(); }, ms);
						const remove = session.cancellation.onCancel(() => { clearTimeout(timer); remove(); resolve(); });
					});
				},
				health: modelHealth,
				isCancelled: () => session?.cancellation.isCancelled ?? false,
				recordEvent: (event, payload) => deps.recordEvent(event, { run_id: runId, ...payload }),
				log: (line) => session?.log(line),
				config: failoverConfig(),
				redact: redactPaths,
				effortDropped: (model) => Boolean(input.effort && !runCandidates?.find((candidate) => candidate.model === model)?.effortControl),
			});
			const attempts = failover.attempts.map((attempt) => attempt.result);
			const finalAttempt = attempts.at(-1)!;
			for (let index = 0; index < attempts.length - 1; index++) {
				const attempt = attempts[index];
				const model = failover.attempts[index].model;
				const rows = nestedModelCallRowsFor({ runId, parentTaskId: input._taskId ?? `unknown-${runId}`, dispatchDepth: depth, dispatchAttempt: index }, attempt.nestedCalls ?? []);
				for (const row of rows) (deps.recordModelCall ?? recordModelCall)(row);
				// provider_error per failed (non-final) attempt, scoped to THAT attempt's
				// own model/result — the final attempt's provider_error is recorded below
				// alongside its own dispatch_finished.
				recordProviderErrors(deps.recordEvent, { runId, taskId: input._taskId, dispatchAttempt: index }, { ...attempt, model });
				deps.recordEvent("dispatch_finished", { ...dispatchHealth({ ...attempt, model }), run_id: runId, task_id: input._taskId, capability: input._capability,
					model, exit_code: attempt.exitCode, duration_ms: attempt.durationMs,
					cost_usd: attempt.costUsd, nested_cost_usd: attempt.nestedCostUsd, nested_rows_emitted: rows.length,
					dispatch_attempt: index, turns: attempt.usage.turns, stop_reason: attempt.stopReason,
					log_dir: session?.dir, superseded_by_fallback: true });
			}
			let r = {
				...finalAttempt, model: failover.finalModel,
				usage: attempts.reduce((sum, attempt) => sumUsage(sum, attempt.usage), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } as SubagentUsageStats),
				costUsd: attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
				nestedCostUsd: attempts.reduce((sum, attempt) => sum + (attempt.nestedCostUsd ?? 0), 0),
				nestedCalls: attempts.flatMap((attempt) => attempt.nestedCalls ?? []),
				durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
				costReported: attempts.every((attempt) => attempt.costReported),
			};
			// The final attempt keeps its own nested rows; earlier attempts were
			// emitted above with distinct dispatch_attempt ids.
			const dispatchAttempt = attempts.length - 1;
			const ownNestedCalls = finalAttempt.nestedCalls;
			const ownNestedCostUsd = finalAttempt.nestedCostUsd;
			const nestedRows = nestedModelCallRowsFor({
				runId, parentTaskId: input._taskId ?? `unknown-${runId}`, dispatchDepth: depth, dispatchAttempt,
			}, ownNestedCalls ?? []);
			for (const row of nestedRows) (deps.recordModelCall ?? recordModelCall)(row);
			recordProviderErrors(deps.recordEvent, { runId, taskId: input._taskId, dispatchAttempt }, r);
			deps.recordEvent("dispatch_finished", {
				...dispatchHealth({ ...r, model: r.model ?? input.model }),
				run_id: runId,
				task_id: input._taskId,
				capability: input._capability,
				model: r.model ?? input.model,
				exit_code: r.exitCode,
				// This attempt's OWN duration/cost/turns only (never the fallback-merged sum) —
				// see the `dispatchAttempt`/`nested_cost_usd` comments above: the returned
				// `DispatchResult` (below) carries the cumulative totals across all attempts;
				// dispatch_finished rows must stay per-attempt so Python-side aggregation
				// (orchestrator/presentation/dashboard_data.py's provider-health rollup, which
				// sums `cost_usd` over dispatch_finished rows) never double-counts a task that
				// failed over more than once.
				duration_ms: finalAttempt.durationMs,
				cost_usd: finalAttempt.costUsd,
				// This attempt's OWN nested cost only (see the `dispatchAttempt` comment above) — never
				// the fallback-merged sum, so `economics.nested_residual_rows` reconciling per
				// `(run_id, task_id, dispatch_attempt)` never double-books attempt 0's spend.
				nested_cost_usd: ownNestedCostUsd,
				// So Python-side aggregation never double-books an aggregate residual for a dispatch
				// that already has detail rows (orchestrator/economics.py; see the audit doc's
				// "Nested cost semantics" section).
				nested_rows_emitted: nestedRows.length,
				dispatch_attempt: dispatchAttempt,
				turns: finalAttempt.usage.turns,
				stop_reason: r.stopReason,
				log_dir: ACTIVE_RUN?.dir,
			});
			return {
				taskId: input._taskId ?? `unknown-${runId}`,
				capability: input._capability ?? "unknown",
				model: r.model ?? input.model,
				exitCode: r.exitCode,
				stdout: r.stdout,
				// On a non-zero exit HT often fails before emitting any event (bad
				// argv, provider auth), so stderr is the only diagnostic. When even
				// that is empty, fall back to the raw event stream so the failure is
				// explainable in metrics.jsonl instead of a silent zero.
				stderr:
					r.exitCode === 0 ? r.stderr : summarizeStderr(r.stderr || r.rawStdout, 2_000) || "(no output)",
				usage: r.usage,
				durationMs: r.durationMs,
				costUsd: r.costUsd,
				...((r.nestedCostUsd ?? 0) > 0 ? { nestedCostUsd: r.nestedCostUsd } : {}),
				costReported: r.costReported,
				stopReason: r.stopReason,
				outcome: r.outcome,
				timeoutReason: r.timeoutReason,
				interruption: r.interruption,
				// parseFilesChanged scrapes the child's prose, so a read-only reviewer
				// or QA agent would "report" every path it merely mentioned.
				filesChanged: r.personaCanMutate ? parseFilesChanged(r.stdout) : [],
				...(input.effort ? { effort: input.effort } : {}),
				...(r.telemetry
					? { telemetry: input._phase ? { ...r.telemetry, dispatch_phase: input._phase } : r.telemetry }
					: {}),
				...(input._canaryAssignment
					? {
						canary: canaryTelemetryFields(
							input._canaryAssignment,
							r.model ?? input.model,
							`${input._taskId ?? "unknown"}${(input._retryCount ?? 0) > 0 ? `#retry${input._retryCount}` : ""}`,
						),
					}
					: {}),
				experimentFlags: efficiencyControls.enabled,
			};
		} catch (err) {
			return {
				taskId: input._taskId ?? `unknown-${runId}`,
				capability: input._capability ?? "unknown",
				model: input.model ?? "unknown",
				exitCode: -1,
				stdout: "",
				stderr: (err as Error).message,
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
					cost: 0, contextTokens: 0, turns: 0,
				},
				durationMs: 0,
				costUsd: 0,
				costReported: false,
				filesChanged: [],
			};
		}
	});

	return settled;
}

// Capabilities whose persona file is not simply `orch-<capability>`. Without
// these, the derived name missed the installed persona and the child silently
// ran with the DEFAULT system prompt and the default (unrestricted) tool set —
// e.g. capability "lead" looked for "orch-lead" while the shipped persona is
// "orchestrator-lead", so the lead lost its subagent fan-out instructions.
// Review capabilities intentionally collapse onto the reviewer personas so the
// read-only tool allow-list in their frontmatter keeps applying.
const CAPABILITY_AGENT_ALIASES: Record<string, string> = {
	// Every lead size (lead_small / lead / lead_large) runs the same
	// orchestrator-lead persona: no write/edit tools, delegation rule, STATUS line.
	...Object.fromEntries(Object.values(METHOD.rules.lead_sizing.sizes).map((cap) => [cap, "orchestrator-lead"])),
	analysis_mid: "orch-technical-lead",
	analysis_strong: "orch-architect",
	integration_review: "orch-technical-review",
	migration_review: "orch-technical-review",
	performance_review: "orch-technical-review",
	api_contract_review: "orch-technical-review",
};

export function agentNameFor(capability: string): string {
	return CAPABILITY_AGENT_ALIASES[capability] ?? `orch-${capability.replace(/_/g, "-")}`;
}

function formatTaskPrompt(
	t: DispatchTask,
	runId: string,
	userMessages: string[] = [],
): string {
	const retryNote = t.retryOf
		? `\n\n[Retry context: this is retry #${(t.retryCount ?? 0) + 1} of a previous failed attempt on task_id=${t.retryOf}. The previous attempt's review/QA feedback is captured in the orchestrator ledger; if you need that context, ask the lead before starting. Per method.json rules.review_after_fix: re-review at or above the original reviewer's tier, never the cheap tier.]`
		: "";
	const userNote = userMessages.length > 0
		? `\n\n[User messages while this run was in progress — ${userMessages.length === 1 ? "1 message" : `${userMessages.length} messages`}, addressed to you]:\n${userMessages.map((m, i) => `  ${i + 1}. ${m}`).join("\n")}\n\nTreat these as high-priority steering from the operator. Adjust your plan and execution accordingly. If a message asks you to stop, finish the current sub-step and report back; do not start new work.`
		: "";
	return [
		`[orchestrator:run_id=${runId}]`,
		`[capability=${t.capability}]`,
		`[task_id=${t.taskId}]`,
		"",
		t.task,
		retryNote,
		userNote,
		"",
		"---",
		"Output format (required):",
		"## Completed",
		"What was done.",
		"## Files Changed",
		"- `path/to/file` — what changed",
		"## Verification",
		"Checks run + result.",
		"## Notes / Escalation",
		"Anything the lead should know — reply to any user messages here.",
	].join("\n");
}

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
function pickModel(
	capability: string,
	adapter: Adapter,
	retryCount: number,
	risk = "medium",
): string {
	// Defensive: adapter lookups can yield undefined if the dynamic
	// resolver returned a partial map. Fall back to any binding we can
	// find before dereferencing .model — otherwise the escalation logic
	// itself becomes the crash site.
	const binding =
		adapter[capability] ??
		adapter.worker ??
		adapter.implementation_fast ??
		Object.values(adapter).find((v) => v && typeof v === "object");
	const base = binding?.model ?? "unknown";
	if (retryCount === 0) return base;

	const isReview = capability === "technical_review" || capability === "security_review";
	if (!isReview) return base;

	// Tier from the resolved adapter (highest tier any capability binds this
	// model to), falling back to name classification for unbound models.
	const current = tierOfModel(base, adapter);
	if (current === "unknown") return base;

	// Floor from the method: max(risk tier_min, one tier above current), then
	// one more tier per additional retry. Prohibited tiers are never allowed.
	const floor = rereviewFloor(risk);
	const prohibited = METHOD.rules.review_after_fix.prohibit_tiers;
	let targetIdx = Math.max(tierIndex(floor.tier_min), tierIndex(current) + 1) + (retryCount - 1);
	targetIdx = Math.min(targetIdx, METHOD.tiers.length - 1);
	while (targetIdx < METHOD.tiers.length - 1 && prohibited.includes(METHOD.tiers[targetIdx] as Tier)) targetIdx++;
	const target = METHOD.tiers[targetIdx] as Tier;
	if (target === current) return base;

	// Walk upward from the target so a missing tier still escalates.
	for (let i = targetIdx; i < METHOD.tiers.length; i++) {
		const m = cheapestAtTier(adapter, METHOD.tiers[i] as Tier, capability);
		if (m) return m;
	}
	return base;
}

function cheapestAtTier(adapter: Adapter, tier: string, preferredCapability: string): string | null {
	// Look through the adapter for any capability at the requested tier. The
	// dynamic adapter's resolve code picks models uniformly by cost tier, so
	// for the "mid" tier we want a mid-tier capability. We prefer the
	// specific capability (e.g. technical_review for technical_review), fall
	// back to peer review/implementation capabilities, then to architect/
	// security_review which the dynamic adapter tends to map to the premium
	// tier. Without the fallback, "mid -> premium" escalation has nothing to
	// escalate to because every review-capability sits at the same tier.
	// Within a tier, general-purpose capabilities come before specialised ones
	// (security_review is often overridden to a different vendor on purpose).
	const candidates = [
		preferredCapability,
		"implementation_strong",
		"technical_review",
		"analysis_mid",
		"analysis_strong",
		"architect",
		"lead",
		"security_review",
		"lead_large",
		"worker",
	];
	// Pick from capabilities that BELONG to the target tier (method.json), not
	// from any model that happens to be bound somewhere at that tier: a profile
	// override (e.g. oss binding `lead` to a mid model) must not turn that model
	// into the "premium" escalation target.
	for (const cap of [...candidates, ...TIER_CAPABILITIES[tier as Tier] ?? []]) {
		if (tierOf(cap) !== tier) continue;
		const binding = adapter[cap];
		if (binding?.model) return binding.model;
	}
	return null;
}

// -----------------------------------------------------------------------------
// Cost capture + executed-route emission
// -----------------------------------------------------------------------------

interface CaptureOpts {
	runId: string;
	planId: string;
	taskClass: string;
	complexity: number;
	risk: string;
	recommended: {
		capability: string;
		effort: string;
		verification_depth: string;
		estimated_verified_cost_usd?: number;
		estimated_quality_evidence?: number;
	};
	mode: string;
}

async function captureDispatchCost(
	opts: CaptureOpts,
	result: DispatchResult,
): Promise<void> {
	for (const record of dispatchRecordsFor(opts, result)) {
		recordModelCall(record);
	}
}

/**
 * Every metrics row one dispatch is accountable for, as pure data so the whole
 * set can be asserted without spawning the Python CLI. Exactly two rows — and
 * deliberately not a third.
 *
 * There is no `task_verified` / `task_failed` row here. `records.py` classifies
 * those events as ATTESTED, its strongest evidence class, meaning "a runtime
 * states that this task cleared its quality gates". A process exit code cannot
 * support that claim, and deriving one from it is the exact conflation this
 * branch exists to remove — it is how `Verified tasks` read 174 when 22 tasks
 * had a real verdict. Three reasons, all reproducible:
 *
 * 1. Redundancy. The dispatch-level signal is already reported twice, honestly:
 *    `result: 'pass' | 'fail'` on the `model_call` row and `executed_passes` on
 *    the `route_executed` row. `records.py` reads `result` as DISPATCH strength,
 *    which is exactly what an exit code is worth.
 * 2. Ordering. `runVerification` bills its QA dispatch through here BEFORE the
 *    gate verdict exists (`qaResult.exitCode === 0 && failedChecks.length === 0`
 *    is computed afterwards). A QA agent that exits 0 while reporting failed
 *    checks therefore emitted an attested `task_verified` while `recordOutcome`
 *    wrote `outcome: 'fail'` for the SAME `task_id`.
 * 3. Attribution. Five of the six call sites dispatch coordination, not
 *    deliverable tasks: `${runId}-architect`, `${runId}-lead-${i}`,
 *    `triage-<slug>`, the escalation retry, and the QA pass itself. Attesting
 *    verification of a synthetic coordination id asserts nothing about work.
 *
 * Per-task attestation is not derivable in this bridge, so the gap is left
 * honest rather than filled with a fabrication (`records.UNINSTRUMENTED_FIELDS`
 * exists so the dashboard can report exactly that): one QA pass returns ONE
 * verdict over the union of changed files; `changedSince` flattens that union to
 * a `string[]` whose task provenance does not survive the git-snapshot
 * intersection; `failedChecks` names checks (`typecheck`), not tasks; and the
 * real deliverable tasks are the leads' own workers, which this bridge never
 * observes (`dispatchHierarchical` returns `workerResults: []`). The one genuine
 * gate verdict that does exist is written by `runVerification` through
 * `recordOutcome`, after `failedChecks` is known.
 */
export function dispatchRecordsFor(
	opts: CaptureOpts,
	result: DispatchResult,
): Record<string, unknown>[] {
	// Defensive defaults: every field on `result` may be sparse when HT
	// returns a partial / cancelled dispatch. Normalize once at the top so
	// the metric payloads below are always well-formed and the split() on
	// the model id can't throw.
	const model = result?.model ?? "unknown";
	const usage = result?.usage ?? {};
	const provider = model.includes("/") ? model.split("/")[0] : "unknown";
	const taskId = result?.taskId ?? `unknown-${opts.runId}`;

	// 1. The model_call record HT actually produced. `cost_source: "reported"`
	//    means the harness reported cost directly; if cost is missing, the
	//    pricing table resolves it to `estimated`.
	const hasReportedCost = result?.costReported === true;
	return [{
		event: "model_call",
		run_id: opts.runId,
		task_id: taskId,
		task_class: opts.taskClass,
		complexity: opts.complexity,
		risk: opts.risk,
		role: result?.capability ?? "unknown",
		capability_class: result?.capability ?? "unknown",
		agent_runtime: "humain-terminal",
		provider,
		model,
		// `effort` stays in the method's vocabulary (comparable with
		// recommended_effort); the raw HT thinking level is kept separately.
		effort: methodEffortFor(result?.effort),
		...(result?.effort ? { thinking_level: result.effort } : {}),
		verification_depth: "targeted",
		// HT input excludes cache reads; the telemetry/pricing contract includes them.
		input_tokens: (usage.input ?? 0) + (usage.cacheRead ?? 0),
		cached_input_tokens: usage.cacheRead ?? 0,
		cache_write_tokens: usage.cacheWrite ?? 0,
		output_tokens: usage.output ?? 0,
		...(hasReportedCost ? { cost_usd: result.costUsd, cost_source: "reported" } : {}),
		duration_ms: result?.durationMs ?? 0,
		result: result?.exitCode === 0 ? "pass" : "fail",
		stop_reason: result?.stopReason,
		files_changed: result?.filesChanged ?? [],
		plan_id: opts.planId,
		...runTagFields(),
		...(isLeadCapability(result?.capability ?? "") && leadSelfImplemented(result) ? { lead_self_implemented: true } : {}),
		// Phase 2 telemetry (observational only — see dispatch-telemetry.ts / model-canary.ts /
		// efficiency-flags.ts). Added fields; every existing field above is unchanged.
		...(result?.telemetry ?? {}),
		...(result?.canary ?? {}),
		...(result?.experimentFlags ? { experiment_flags: result.experimentFlags } : {}),
	}, {
		// 2. The executed-route record. This is the closing half of the
		//    (recommended, executed, observed) triple: the plan-time
		//    `adaptive_route_decision` event already has `recommended_*`; this
		//    event records what was actually dispatched and what it cost.
		event: "route_executed",
		run_id: opts.runId,
		task_id: taskId,
		plan_id: opts.planId,
		task_class: opts.taskClass,
		complexity: opts.complexity,
		risk: opts.risk,
		capability_class: result?.capability ?? "unknown",
		executed_model: model,
		executed_effort: methodEffortFor(result?.effort),
		...(result?.effort ? { executed_thinking_level: result.effort } : {}),
		executed_verification_depth: "targeted",
		...(hasReportedCost ? { executed_cost_usd: result.costUsd } : {}),
		executed_input_tokens: (usage.input ?? 0) + (usage.cacheRead ?? 0),
		executed_output_tokens: usage.output ?? 0,
		executed_passes: result?.exitCode === 0,
		recommended_capability: opts.recommended.capability,
		recommended_effort: opts.recommended.effort,
		recommended_verification_depth: opts.recommended.verification_depth,
		recommended_estimated_verified_cost_usd:
			opts.recommended.estimated_verified_cost_usd,
		recommended_estimated_quality_evidence:
			opts.recommended.estimated_quality_evidence,
		adaptive_mode: opts.mode,
		...runTagFields(),
	}];
}

/**
 * Best-effort capability/role for a nested subagent call, derived only from the agent name the
 * runtime reports (never guessed from context). Covers both the plain `orch-<capability>`
 * convention and the aliases `CAPABILITY_AGENT_ALIASES` installs under a different persona name.
 * An agent name that matches neither is reported as the explicit role `"unknown"` — per the Phase 1
 * plan, unknown attribution must stay unknown rather than be guessed.
 */
const AGENT_NAME_TO_ROLE: Record<string, string> = Object.fromEntries(
	// Several capabilities alias onto ONE persona (all lead sizes -> "orchestrator-lead"; four
	// review capabilities -> "orch-technical-review"). The agent name alone cannot disambiguate
	// which one actually ran, so this necessarily picks one (the last entry in
	// `CAPABILITY_AGENT_ALIASES`) as a representative label. This is a cosmetic ambiguity only:
	// `orchestrator/economics.py`'s coordination/verification buckets key off role SUFFIXES
	// (`*_lead`, `*_review`) and treat every alias in a collision the same way.
	Object.entries(CAPABILITY_AGENT_ALIASES).map(([capability, agent]) => [agent, capability]),
);

export function roleForAgentName(agentName: string | null | undefined): string {
	if (!agentName) return "unknown";
	if (AGENT_NAME_TO_ROLE[agentName]) return AGENT_NAME_TO_ROLE[agentName];
	const m = /^orch-(.+)$/.exec(agentName);
	if (!m || !m[1]) return "unknown";
	return m[1].replace(/-/g, "_");
}

/**
 * One `model_call` row per nested subagent task observed on a dispatch, tagged `nested: true` so
 * it is never mistaken for the dispatch's own (already-emitted) row. Cost is included only when
 * the runtime reported one (`cost_source: "reported"`); an unknown cost omits `cost_usd`
 * entirely so `meter()` (orchestrator/record_batch.py) can estimate it from tokens — or leave it
 * explicitly unmetered — exactly as it does for a dispatch's own row. `record_id` is a pure
 * function of stable identity (run, parent dispatch, DISPATCH attempt, nested key). The queue
 * retries unacknowledged payloads with the same ID; there is no opt-in historical nested-row
 * re-emission path for rejected rows yet. Open item: align the opt-in copy-only
 * scripts/backfill_nested_costs.py with this bounded ID scheme (it currently builds legacy
 * unbounded IDs) before using it to recover old rejected rows. Python's `unique_records`
 * deduplicates acknowledged retries.
 *
 * `opts.dispatchAttempt` (default 0) is the codex -> Bedrock quota-fallback attempt index (0 =
 * original, 1 = the retry) — see the `dispatchAttempt` comment in `dispatchParallel`. It is folded
 * into `record_id` (and stamped as `dispatch_attempt` on the row) because the two attempts are
 * separate child processes with independently-numbered tool-call ids: without this, a coincidental
 * `(toolCallId, taskId, attempt)` collision across the two attempts would dedup away a paid nested
 * call from one of them (Phase 1 review finding T2).
 */
function nestedRecordId(runId: string, parentTaskId: string, dispatchAttempt: number, key: string): string {
	const legacy = `nested:${runId}:${parentTaskId}:${dispatchAttempt}:${key}`;
	const limit = contract.batch.max_record_id_length;
	if (legacy.length <= limit) return legacy;
	// Hash the entire legacy identity (not only the nested key) so even a long parent
	// or two keys with identical leading characters retain distinct stable identities.
	const digest = createHash("sha256").update(legacy).digest("hex").slice(0, 40);
	return `${legacy.slice(0, limit - 1 - digest.length)}:${digest}`;
}

export function nestedModelCallRowsFor(
	opts: {
		runId: string;
		parentTaskId: string;
		dispatchDepth?: number;
		dispatchAttempt?: number;
		taskClass?: string;
		complexity?: string;
		risk?: string;
		planId?: string;
	},
	calls: NestedCallDetail[],
): Record<string, unknown>[] {
	const dispatchAttempt = opts.dispatchAttempt ?? 0;
	return calls.map((c) => {
		const role = roleForAgentName(c.agent);
		const model = c.model ?? "unknown";
		const provider = model.includes("/") ? model.split("/")[0] : "unknown";
		const depth = c.depth ?? (opts.dispatchDepth ?? 0) + 1;
		return {
			event: "model_call",
			run_id: opts.runId,
			task_id: `${opts.parentTaskId}:${c.taskId}`,
			parent_task_id: opts.parentTaskId,
			task_class: opts.taskClass,
			complexity: opts.complexity,
			risk: opts.risk,
			role,
			capability_class: role,
			agent_runtime: "humain-terminal",
			provider,
			model,
			input_tokens: (c.usage.input ?? 0) + (c.usage.cacheRead ?? 0),
			cached_input_tokens: c.usage.cacheRead ?? 0,
			cache_write_tokens: c.usage.cacheWrite ?? 0,
			output_tokens: c.usage.output ?? 0,
			...(c.costReported ? { cost_usd: c.usage.cost, cost_source: "reported" } : {}),
			result: c.exitCode === 0 ? "pass" : "fail",
			...(c.stopReason ? { stop_reason: c.stopReason } : {}),
			nested: true,
			nesting_depth: depth,
			nested_call_id: c.key,
			...(c.attempt !== undefined ? { attempt: c.attempt } : {}),
			// The dispatch-fallback attempt this row belongs to (0 = original, 1 = the Bedrock
			// quota retry) — distinct from `attempt` above, which is the NESTED subagent's own
			// retry number. Always stamped (never omitted, even at the default 0) so
			// `economics.py` can key reconciliation on `(run_id, parent_task_id, dispatch_attempt)`
			// without treating "absent" and "0" as different things.
			dispatch_attempt: dispatchAttempt,
			plan_id: opts.planId,
			...runTagFields(),
			record_id: nestedRecordId(opts.runId, opts.parentTaskId, dispatchAttempt, c.key),
		};
	});
}

/** HT thinking level -> method.json effort vocabulary (minimal|low|standard|high|maximum). */
export function methodEffortFor(thinking: string | undefined): string {
	switch (thinking) {
		case "off": case "minimal": return "minimal";
		case "low": return "low";
		case "high": return "high";
		case "xhigh": case "max": return "maximum";
		default: return "standard"; // unset or "medium"
	}
}

function sumUsage(a: SubagentUsageStats, b: SubagentUsageStats): SubagentUsageStats {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		contextTokens: Math.max(a.contextTokens, b.contextTokens),
		turns: a.turns + b.turns,
	};
}

function runTagFields(): Record<string, string> {
	const out: Record<string, string> = {};
	if (CURRENT_RUN_TAGS.profile) out.profile = CURRENT_RUN_TAGS.profile;
	if (CURRENT_RUN_TAGS.policy_id) out.policy_id = CURRENT_RUN_TAGS.policy_id;
	if (CURRENT_RUN_TAGS.lead_size) out.lead_size = CURRENT_RUN_TAGS.lead_size;
	return out;
}

/**
 * A lead that reports changed files but never mentions dispatching an
 * implementer did the implementation itself — the costliest pattern in the
 * 2026-09-24 data. Flagged for the dashboard, not blocked here.
 */
export function leadSelfImplemented(result: Pick<DispatchResult, "filesChanged" | "stdout"> | undefined): boolean {
	return (result?.filesChanged?.length ?? 0) > 0 && !/orch-implementation-(strong|fast)|orch-worker/.test(result?.stdout ?? "");
}

// -----------------------------------------------------------------------------
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

/** Preserve conservative QA scope for legacy phase evidence, when supplied. */
export function qaScopeEvidenceFor(
	leadResults: Array<Pick<DispatchResult, "exitCode" | "stdout" | "filesChanged" | "scopedPhaseReports">>,
): Array<{ exitCode: number; stdout: string }> {
	return leadResults.map((r) => {
		const phases = r.scopedPhaseReports;
		if (!phases) return { exitCode: r.exitCode, stdout: r.stdout };

		const allPhasesCleanExit = phases.every((p) => p.exitCode === 0);
		const firstFailedExit = phases.find((p) => p.exitCode !== 0)?.exitCode;
		const exitCode = allPhasesCleanExit ? r.exitCode : (firstFailedExit ?? 1);

		const parsedPhases = phases.map((p) => parseLeadFilesChanged(p.stdout));
		const union = new Set<string>(r.filesChanged);
		let anyList = false;
		for (const parsed of parsedPhases) {
			if (parsed.kind === "list") {
				anyList = true;
				for (const f of parsed.files) union.add(f);
			}
		}

		if (allPhasesCleanExit && union.size === 0 && parsedPhases.every((p) => p.kind === "none")) {
			return { exitCode, stdout: "## Files Changed\nNone" };
		}
		if (union.size > 0 || anyList) {
			return { exitCode, stdout: `## Files Changed\n${[...union].map((f) => `- \`${f}\``).join("\n")}` };
		}
		// No phase proved "none" and no phase (nor the union) proved "list" — at least one
		// phase's report has no `## Files Changed` section at all. Emit none here either;
		// `parseLeadFilesChanged` reads that as `"unknown"`, keeping QA scope conservative.
		return { exitCode, stdout: "" };
	});
}

/**
 * The files THIS RUN's own leads/implementers claimed changing -- Phase 2's existing
 * file-ownership/changed-file reporting (`filesChanged`, populated from lead/implementer prose
 * via `parseFilesChanged`, and already unioned across a scoped lead's full phase chain by
 * `finalizeScopedLeadResult`) -- independent of `allFiles`/`changedFilesSinceRunStart`'s much
 * broader git-dirty-detection set (which also includes any OTHER path git shows as changed,
 * claimed or not, plus history/dirty-snapshot fallbacks).
 *
 * This is the ONLY file set the live-QA stage's tested-revision checkpoint (`runLiveQaStage`'s
 * `changedFiles`, live-qa.ts's `buildCheckpointIndex`) is ever built from: a dirty file nobody in
 * this run claimed touching -- a concurrent process's scratch file, a stray `.env` dropped by
 * something else entirely -- must never be swept into a Forge checkpoint commit just because git
 * happens to see it as dirty at the moment the stage runs. `buildCheckpointIndex` already builds
 * the checkpoint EXCLUSIVELY from whatever `changedFiles` it is given (never from `git status`/
 * `git add -A`); this function is what decides which files that guarantee actually protects. When
 * this returns an EMPTY array against a dirty working tree, `prepareTestedRevision` itself refuses
 * to checkpoint an "ambiguous/empty candidate set" (fails closed to `unavailable`) — this function
 * never needs to special-case that itself.
 *
 * Deliberately does not filter by exit code, by whether the path still exists, or by whether git
 * itself still shows it as dirty -- a claimed path that turns out phantom/reverted is harmless to
 * include (`buildCheckpointIndex` checkpoints it at its current, unchanged content, or force-
 * removes it if it is gone; either is a no-op against a base HEAD that already agrees), and
 * excluding it here would just reintroduce a second, subtly different notion of "changed" that
 * would need to be kept in sync with `allFiles`/the generic QA gate's own scope, which this
 * function is not meant to affect at all.
 */
export function candidateOwnedFilesForLiveQa(results: Array<Pick<DispatchResult, "filesChanged">>): string[] {
	return [...new Set(results.flatMap((r) => r.filesChanged))];
}


// -----------------------------------------------------------------------------
// Argument parsing
// -----------------------------------------------------------------------------

interface OrchestrateArgs {
	goal: string;
	taskClass: string;
	complexity: number;
	risk: string;
	qualityFloor?: number;
	costAggressiveness?: number;
	fanOut: boolean;
	maxRetries: number;
	/** Opt in to confirmation dialogs after triage and before dispatch. */
	interactive: boolean;
	/** /orchestrator-models only: dispatch a one-turn probe on every distinct model. */
	check: boolean;
	/** Per-tier / per-capability model overrides from --cheap/--mid/--premium/--frontier/--model. */
	models: ModelOverrides;
	/** `--lead-size small|standard|large`: overrides triage sizing and the risk floor. */
	leadSize?: LeadSize;
	/**
	 * Final resolved live-QA request: true when `--live-qa` was given, or implied by
	 * `--live-qa-scope` — unless `--no-live-qa` was also given, which always wins regardless of
	 * flag order. Never heuristically inferred from the goal text.
	 */
	liveQa: boolean;
	/** Internal: `--no-live-qa` was given. Folded into `liveQa` at the end of `parseArgs`. */
	liveQaOff: boolean;
	/** `--live-qa-adapter <id>`, when given. */
	liveQaAdapterId?: string;
	/** `--live-qa-scope <scope>`; may be a double-quoted, multi-word value. */
	liveQaScope?: string;
	/** Flags we did not recognize — reported instead of silently swallowed. */
	unknownFlags: string[];
}

/**
 * Flags are honored only in the leading or trailing flag block (`/orchestrate [flags] <goal> [flags]`).
 * A `--flag` between goal words is prose: it stays in the goal and has no effect. Scanning the whole
 * string used to let "Keep --interactive confirmations blocking" switch interactive mode on and cut
 * the words out of the spec the agents received.
 */
export function parseArgs(args: string): OrchestrateArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	// Pass 1 on a scratch result: find which tokens are flag spans and which are goal words.
	const spans: Array<{ start: number; end: number; flag: boolean }> = [];
	const scratch = newOrchestrateArgs();
	for (let i = 0; i < tokens.length; ) {
		const end = consumeFlag(tokens, i, scratch);
		spans.push({ start: i, end: end ?? i + 1, flag: end !== undefined });
		i = end ?? i + 1;
	}
	const firstWord = spans.findIndex((s) => !s.flag);
	let lastWord = -1;
	for (let k = spans.length - 1; k >= 0; k--) {
		if (!spans[k].flag) {
			lastWord = k;
			break;
		}
	}
	// Pass 2 on the real result: apply only boundary flags; everything else is goal text.
	const out = newOrchestrateArgs();
	const goalTokens: string[] = [];
	spans.forEach((span, index) => {
		const boundary = firstWord === -1 || index < firstWord || index > lastWord;
		if (span.flag && boundary) consumeFlag(tokens, span.start, out);
		else goalTokens.push(...tokens.slice(span.start, span.end));
	});
	out.goal = goalTokens.join(" ");
	// `--no-live-qa` always wins, regardless of flag order or how many times `--live-qa`/
	// `--live-qa-scope` appeared.
	if (out.liveQaOff) out.liveQa = false;
	return out;
}

function newOrchestrateArgs(): OrchestrateArgs {
	return {
		goal: "",
		taskClass: "implementation",
		complexity: 5,
		risk: "medium",
		fanOut: false,
		maxRetries: 2,
		interactive: false,
		check: false,
		models: emptyOverrides(),
		liveQa: false,
		liveQaOff: false,
		unknownFlags: [],
	};
}

/**
 * Apply the flag at `tokens[start]` to `out` and return the index after it (and its value),
 * or undefined when the token is not a flag.
 */
function consumeFlag(tokens: string[], start: number, out: OrchestrateArgs): number | undefined {
	let i = start;
	{
		const t = tokens[i];
		const next = tokens[i + 1];
		switch (t) {
			case "--task-class": if (next) { out.taskClass = next; i++; } break;
			case "--complexity": if (next) { out.complexity = clampComplexity(next); i++; } break;
			case "--risk": if (next) { out.risk = next; i++; } break;
			case "--quality-floor": if (next) { out.qualityFloor = Number(next); i++; } break;
			case "--cost-aggressiveness": if (next) { out.costAggressiveness = Number(next); i++; } break;
			case "--fan-out": out.fanOut = true; break;
			case "--max-retries": if (next) { const n = Number(next); out.maxRetries = Number.isFinite(n) && n >= 0 ? n : 2; i++; } break;
			case "--interactive": out.interactive = true; break;
			// Kept as a no-op for existing scripts: auto-approval is now the default.
			case "--yes": case "-y": break;
			case "--check": case "--live": out.check = true; break;
			case "--profile": if (next) { out.models.profile = next; i++; } break;
			case "--lead-size": {
				if (next && isLeadSize(next)) out.leadSize = next;
				else out.unknownFlags.push(next ? `--lead-size ${next} (expected small|standard|large)` : "--lead-size (missing value)");
				if (next) i++;
				break;
			}
			case "--live-qa": out.liveQa = true; break;
			case "--no-live-qa": out.liveQaOff = true; break;
			case "--live-qa-adapter": if (next) { out.liveQaAdapterId = next; i++; } break;
			case "--live-qa-scope": {
				if (next === undefined) {
					out.unknownFlags.push("--live-qa-scope (missing value)");
					break;
				}
				if (next.startsWith('"')) {
					// A double-quoted value may span multiple whitespace-split tokens ("a b c"). Scan
					// forward for the token that ends with the closing quote; the opening token alone
					// closing itself (length > 1, e.g. `"solo"`) is handled by starting the scan at `next`.
					let j = i + 1;
					let closed = tokens[j].length > 1 && tokens[j].endsWith('"');
					while (!closed && j < tokens.length - 1) {
						j++;
						closed = tokens[j].endsWith('"');
					}
					if (!closed) {
						out.unknownFlags.push(`--live-qa-scope ${tokens.slice(i + 1).join(" ")} (unterminated quoted value)`);
						i = tokens.length - 1;
						break;
					}
					const raw = tokens.slice(i + 1, j + 1).join(" ");
					out.liveQaScope = raw.slice(1, -1);
					out.liveQa = true;
					i = j;
					break;
				}
				out.liveQaScope = next;
				out.liveQa = true;
				i++;
				break;
			}
			case "--effort": {
				if (next) {
					if (isThinkingLevel(next)) out.models.effort = next;
					else out.unknownFlags.push(`--effort ${next} (expected one of ${THINKING_LEVELS.join("|")})`);
					i++;
				}
				break;
			}
			case "--cheap": if (next) { out.models.tiers.cheap = next; i++; } break;
			case "--mid": if (next) { out.models.tiers.mid = next; i++; } break;
			case "--premium": if (next) { out.models.tiers.premium = next; i++; } break;
			case "--frontier": if (next) { out.models.tiers.frontier = next; i++; } break;
			case "--model": {
				// --model <capability>=<alias|provider/model>
				if (next) {
					const eq = next.indexOf("=");
					if (eq > 0) {
						const cap = next.slice(0, eq);
						if (ALL_CAPABILITIES.includes(cap)) out.models.capabilities[cap] = { model: next.slice(eq + 1) };
						else out.unknownFlags.push(`--model ${next} (unknown capability; valid: ${ALL_CAPABILITIES.join(", ")})`);
					} else {
						out.unknownFlags.push(`--model ${next} (expected <capability>=<provider/model>)`);
					}
					i++;
				}
				break;
			}
			default:
				if (!t.startsWith("--")) return undefined;
				out.unknownFlags.push(t);
				break;
		}
	}
	return i + 1;
}

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
 *
 * Claims/releases through `runRegistry` — the SAME registry `/orchestrate`
 * (commands/orchestrate.ts, via `registerOrchestrateCommand`) claims — rather than reading/
 * writing `ACTIVE_RUN` directly (A1 review fix): before this, a probe here and a `/orchestrate`
 * claim could race across the `await` in either path (one overwriting `ACTIVE_RUN` while the
 * other still believed it owned it), and this function's `finally` cleared `ACTIVE_RUN`
 * unconditionally, clobbering a newer run that had since claimed it. `runRegistry.claim()`
 * atomically checks-and-sets against the one shared registry, and `release()` only clears state
 * it still, by identity, owns (see `RunRegistry.release`'s doc) — exactly the guarantee
 * `/orchestrate`'s own claim/release already had. Exported for direct test coverage of that
 * mutual exclusion (index.test.ts), since exercising it through the real `/orchestrator-models
 * check` command would require standing up a whole live-probe fixture just to reach this guard.
 */
export async function checkModels(ctx: ExtensionContext, resolved: ResolvedAdapter): Promise<boolean> {
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
	// Re-check, same reasoning as /orchestrate's own claim (commands/orchestrate.ts): the guard
	// above ran before `new RunSession` (no `await` in between today, but `claim()` re-checks
	// regardless so this stays correct if that ever changes) — losing this race must not let two
	// runs both believe they own the registry.
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

const USAGE =
	"Usage: /orchestrate <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical]\n" +
	"       [--profile NAME] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--frontier ALIAS] [--model <capability>=ALIAS] [--effort LEVEL]\n" +
	"       [--quality-floor F] [--cost-aggressiveness C] [--max-retries R] [--interactive]\n" +
	"       [--live-qa] [--live-qa-adapter ID] [--live-qa-scope \"SCOPE\"] [--no-live-qa]\n" +
	"ALIAS is a short name (fable-5-1, opus-5-5, sonnet-5, gpt-6-sol, gpt-6-luna, astra) or provider/model. Profiles: " + PROFILES_PATH + "  (see /orchestrator-models)";

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
	const statusPath = join(root, "ingest_status.json");
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
		const session = ACTIVE_RUN;
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

export default function (pi: ExtensionAPI) {
	reapOrphanedPersonaDirs();
	installDispatchReaper();
	installTelemetryDrain(pi);
	installSessionIngest(pi);
	registerOrchestratorStatusTool(pi);

	const orchestrateDeps: OrchestrateDeps = {
		runRegistry,
		resolveAdapter,
		createSession: (runId, ctx, goal) => new RunSession(runId, ctx, goal),
		// `run` (the claimed `RunContext`) is accepted for interface parity with the modular
		// pipeline's other callers but not read here: `triageTask` takes no run-scoped state at
		// all (see its own signature below), same as it did when the inline handler called it
		// directly with no `run` argument.
		triageTask: (runId, goal, cwd, ctx, run, costSink, adapter) => triageTask(runId, goal, cwd, ctx, run, costSink, adapter),
		planRun,
		recordEvent,
		recordOutcome,
		// `captureDispatchCost`/`dispatchParallel` read the run they need off the legacy
		// `ACTIVE_RUN` singleton themselves (message draining, spend-cap bookkeeping, ...);
		// `SyncedRunRegistry` above keeps that singleton in sync with whatever this registry
		// claims, so `_run` is accepted (interface parity) but not threaded through here.
		captureDispatchCost: (opts, result, _run) => captureDispatchCost(opts, result),
		dispatchParallel: (cwd, runId, tasks, adapter, ctx, _run) => dispatchParallel(cwd, runId, tasks, adapter, ctx),
		completeRun,
		failRun,
		cancelRun: (runId, reason, timing, since) => cancelRun(runId, reason, timing, since),
		cancelReasonLabel,
		maxLeads: MAX_LEADS,
		reconEvidenceMaxChars: RECON_EVIDENCE_MAX_CHARS,
		stateRoot: STATE_ROOT,
		profilesPath: PROFILES_PATH,
		env: process.env,
		recordModelCall,
		recordRunStarted,
	};
	registerOrchestrateCommand(pi, orchestrateDeps);

	pi.registerCommand("orchestrate-cancel", {
		description: "Cancel the currently running /orchestrate run, if any.",
		handler: async (_args, ctx) => {
			if (!ACTIVE_RUN) {
				ctx.ui.notify("no active run", "info");
				return;
			}
			const runId = ACTIVE_RUN.runId;
			ACTIVE_RUN.cancel("user");
			ctx.ui.notify(`Cancelling orchestration ${runId}…`, "info");
		},
	});

	// /orchestrator-models lives in commands/orchestrator-models.ts (B4.6). A leftover inline copy
	// here once shadowed it, so later subcommands (e.g. `workflow`) never reached a live session;
	// index.test.ts now pins this registration.
	registerOrchestratorModelsCommand(pi, {
		resolveAdapter,
		availableModels,
		loadProfiles,
		writeProfilesFile,
		checkModels,
		profilesPath: PROFILES_PATH,
		env: process.env,
	});

	pi.registerCommand("orchestrator-roi", {
		description: "Print the skill vs flat-baseline ROI report.",
		handler: async (_args, ctx) => {
			const expandedSkillRoot = SKILL_ROOT.replace(/^~/, homedir());
			const child = spawn(
				PYTHON,
				["scripts/skill_vs_baseline.py"],
				{
					env: {
						...process.env,
						PYTHONPATH: expandedSkillRoot,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (b) => (stdout += b.toString()));
			child.stderr.on("data", (b) => (stderr += b.toString()));
			child.on("close", (code) => {
				if (code !== 0) {
					ctx.ui.notify(`ROI report failed: ${stderr}`, "error");
					return;
				}
				ctx.ui.notify(stdout.split("\n").slice(0, 20).join("\n"), "info");
			});
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
			if (!ACTIVE_RUN) {
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
			const depth = ACTIVE_RUN.enqueueMessage(normalized);
			const preview = normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
			ctx.ui.notify(
				`Queued for next dispatch (depth=${depth}): “${preview}”`,
				"info",
			);
		},
	});
}

/** Test seam: planEscalation now lives in escalation.ts; re-exported here under the pre-existing test-only name for index.test.ts callers. */
export const planEscalationForTest = planEscalation;
/** Test seam: pickModel is internal; exported under a test-only name. */
export const pickModelForTest = pickModel;

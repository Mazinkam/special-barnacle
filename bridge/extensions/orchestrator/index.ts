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
import { homedir, tmpdir } from "node:os";
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
	buildAliasTable,
	DEFAULT_PROVIDER_PREFERENCE,
	emptyProfilesFile,
	formatAdapterTable,
	isThinkingLevel,
	isTier,
	type Layer,
	listShortcuts,
	mergeLayers,
	METHOD,
	parseProfilesFile,
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
	tiersToBindings,
	type LeadSize,
	userLayerWarnings,
} from "./models.ts";
import { bedrockFallbackFor, isQuotaError } from "./provider-fallback.ts";
import { parseLeadAssignments, planLeadWaves, type LeadAssignment } from "./lead-plan.ts";
import { classifyRunOutcome, externalChangeFiles, parseLeadStatus } from "./run-outcome.ts";
import { SpendCapTracker, capFor, type SpendCapVerdict } from "./spend-cap.ts";
import { NestedCostTracker } from "./nested-cost.ts";
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
} from "./dispatch-outcome.ts";
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
// Rule-2 recon planning/evidence helpers (pure; see recon.ts). `dispatchHierarchical()`
// dispatches these as ordinary parent-owned tasks through the existing
// `dispatchParallel()` path. `DispatchTask` below is declared independently;
// `ReconTaskPlan` is structurally assignable to it, which the annotated
// `const reconTasks: DispatchTask[] = planReconTasks(...)` checks at compile
// time, so a planned recon task still needs no conversion step.
import { formatReconEvidence, planReconTasks } from "./recon.ts";
import { createPythonCli } from "./python-cli.ts";
import contract from "./contract.json";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const SKILL_ROOT =
	process.env.HUMAIN_ORCHESTRATOR_SKILL_ROOT ??
	"~/.local/share/agent-skills/hierarchical-agent-orchestrator";
const STATE_ROOT =
	process.env[contract.state_root.env_vars.ts] ??
	contract.state_root.default;
const PYTHON = process.env.HUMAIN_ORCHESTRATOR_PYTHON ?? "python3";
const expandedSkillRoot = SKILL_ROOT.replace(/^~/, homedir());
const expandedStateRoot = STATE_ROOT.replace(/^~/, homedir());
/**
 * Extra env every Python spawn gets on top of `python-cli.ts`'s builder
 * (PYTHONPATH + CODING_AGENT_ORCHESTRATOR_HOME): CODING_AGENT_RUNTIME so
 * dispatched metrics land under `agent_runtime: "humain-terminal"`, and
 * CODING_AGENT_REPOSITORY so the skill can attribute a run to the repo it
 * touched. Read once at module load — see rule 4 in the architecture review
 * (no `process.env` reads outside a config module).
 */
const PYTHON_EXTRA_ENV = {
	CODING_AGENT_RUNTIME: "humain-terminal",
	CODING_AGENT_REPOSITORY: process.env.CODING_AGENT_REPOSITORY ?? process.cwd(),
};
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
function redactPaths(text: string): string {
	return text.replace(PATH_RE, "<path>");
}
const PROFILES_PATH =
	process.env.HUMAIN_ORCHESTRATOR_PROFILES_FILE ??
	join(homedir(), ".humain-terminal", "agent", "orchestrator-profiles.json");
const LEGACY_ADAPTER_PATH =
	process.env.HUMAIN_ORCHESTRATOR_ADAPTER_FILE ??
	join(homedir(), ".humain-terminal", "agent", "orchestrator-adapter.json");

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

function positiveIntEnv(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/** Wall clock for a single Python spawn (see python-cli.ts); a hung Python must not hang a run's terminal path. */
const PYTHON_TIMEOUT_MS = positiveIntEnv("HUMAIN_ORCHESTRATOR_PYTHON_TIMEOUT_MS", 60_000);

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
		baseEnv: process.env,
		extraEnv: PYTHON_EXTRA_ENV,
	});
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

/**
 * PIDs of dispatched children that are still running. Children are spawned
 * `detached` (own process group) so a timeout can kill their whole subtree; the
 * flip side is that they would outlive a killed parent, so the parent reaps them
 * on the way out.
 */
const liveDispatchPids = new Set<number>();

/**
 * Kill a dispatched child AND everything it spawned.
 *
 * `kill(-pid)` targets the child's process group, which exists because we spawn
 * detached. Killing the bare pid instead leaves a dispatched lead's own
 * subagents running as orphans - unreadable, unbilled, and still burning provider
 * quota. Falls back to the direct pid when the group is already gone.
 */
function killProcessTree(proc: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
	if (typeof proc.pid === "number") {
		try {
			process.kill(-proc.pid, "SIGKILL");
			return;
		} catch {
			/* no such group: already reaped, or never became a group leader */
		}
	}
	try {
		proc.kill("SIGKILL");
	} catch {
		/* already gone */
	}
}

/** Ensure failures in a child stream listener cannot escape into the TUI. */
export function guardChildStreamHandler(
	handlerName: string,
	handler: () => void,
	onFailure: {
		appendStderr: (text: string) => void;
		kill: () => void;
		finish: (exitCode: number) => void;
	},
): void {
	try {
		handler();
	} catch (error) {
		let message = "unknown error";
		try {
			message = error instanceof Error ? error.message : String(error);
		} catch {
			/* a malformed thrown value must not escape the stream listener */
		}
		try {
			onFailure.appendStderr(`\n[orchestrator] ${handlerName} handler failed: ${message}`);
		} catch {
			/* avoid a diagnostic failure escaping the stream listener */
		}
		try {
			onFailure.kill();
		} catch {
			/* killing a child that already exited is harmless */
		}
		try {
			onFailure.finish(1);
		} catch {
			/* the stream listener must never throw */
		}
	}
}

/** Write a JSONL event while omitting recursively repeated worker histories. */
export function appendTrimmedEventLog(eventsLog: string | undefined, event: unknown): void {
	if (!eventsLog) return;
	try {
		appendDiagnosticPath(eventsLog, `${JSON.stringify(trimEventForLog(event))}\n`);
	} catch {
		/* per-dispatch diagnostics must not disrupt the child stream */
	}
}

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

const PERSONA_TMP_PREFIX = "orch-agent-";
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
		const result = await orchestratorPythonCli().run("orchestrator.cli", ["resolve-adapter", "--explain"]);
		if (result.code !== 0) {
			return {
				adapter: {},
				warning: `resolve-adapter failed (exit ${result.code ?? "n/a"}): ${(result.error ?? result.stderr).trim().slice(0, 300)}`,
			};
		}
		const resolved = JSON.parse(result.stdout.trim()) as Record<string, any>;
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
		return ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
	} catch {
		return [];
	}
}

interface FullResolution extends ResolvedAdapter {
	profileName: string;
	profiles: LoadedProfiles;
	table: AliasTable;
	preference: string[];
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
	// Fallback/dynamic specs are canonical already but may name models the user
	// has not configured; those show up as non-user warnings and are informational.
	return {
		...merged,
		warnings: [...warnings, ...merged.warnings],
		profileName,
		profiles,
		table,
		preference,
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

interface SubagentProcessResult {
	exitCode: number;
	/** Every assistant text block, in order, joined by blank lines. */
	stdout: string;
	/** The LAST assistant text block — the child's final answer. */
	finalText: string;
	/** Bounded head-and-tail capture of the raw JSON event stream for diagnostics. */
	rawStdout: string;
	/** False when the resolved persona had no write/edit tool, so it cannot have changed files. */
	personaCanMutate: boolean;
	stderr: string;
	model?: string;
	usage: SubagentUsageStats;
	costUsd: number;
	/** Spend of `subagent` calls the child made itself (not bridge dispatches); excluded from `costUsd`. */
	nestedCostUsd?: number;
	/** True only when every received usage block explicitly reported a valid cost (including $0). */
	costReported: boolean;
	durationMs: number;
	stopReason?: string;
	/** Process disposition after considering terminal JSON events. */
	outcome: "completed" | "completed_after_process_error" | "failed" | "timed_out" | "cancelled";
	timeoutReason?: "inactivity" | "absolute";
	interruption?: InterruptionReport;
	/** Raw child exit code before terminal-result recovery. */
	processExitCode: number;
	/** Teardown error retained alongside a valid settled result. */
	postCompletionError?: string;
}

/**
 * Pick the right binary + args to invoke Pi in --mode json. Mirrors the
 * getCliInvocation() helper in the coding-agent subagent tool, inlined here because
 * that helper is module-private.
 */
function orchCliInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}
	// HT ships as a compiled bun binary, so argv[1] is a /$bunfs/root/ virtual
	// path and we fall through to here. `basename` must come from the static
	// node:path import — an earlier revision referenced a bare `path.basename`
	// with no `path` binding in scope, which threw ReferenceError on every
	// dispatch and produced the "0 succeeded / $0.0000" phantom runs.
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: extraArgs };
	}
	return { command: "humain-terminal", args: extraArgs };
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


/** Sentinel agent name: spawn with HT's default system prompt, no persona file. */
const NO_PERSONA = "__no_persona__";

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
 * Narrow, single-signature shape for the child launcher seam. `spawn` itself
 * is a heavily overloaded function (stdio-shape-dependent return types,
 * options-optional variants, ...); assigning that whole overload set to an
 * optional property makes both the default (`spawn`) and a test's injected
 * function fight the overload resolver. Only the
 * `(command, args, options) => ChildProcess` overload is ever used at the one
 * call site below, so the seam is typed to exactly that call shape — the real
 * `spawn` satisfies it structurally, and tests can supply a plain function
 * without fighting the overload set.
 */
type ChildSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

interface StderrTarget {
	readonly path: string;
	readonly fd: number;
	/**
	 * The diagnostic name every `diagnosticWriter.write/append` call for this
	 * dispatch must target. Equal to the dispatch's own `<taskId>.stderr.log`
	 * name in the normal case (where `path` above IS that same diagnostics
	 * file). In the taskId-collision fallback case, `path` is instead a
	 * private temp file, and this is a distinct, reserved name (`<name>.fallback`,
	 * or `.fallback-2`, `.fallback-3`, ... if already taken) so writes for this
	 * dispatch can never land on — and so can never clobber — the earlier
	 * dispatch's own `<taskId>.stderr.log`.
	 */
	readonly persistName: string;
	/** Close the caller's copy of the fd. Idempotent. */
	closeFd(): void;
	/** Release the write lease/temp file. Idempotent; closes the fd first if not already closed. */
	release(): void;
}

/**
 * Fallback diagnostic names already claimed for a given `RunDiagnostics`
 * instance, keyed by owner so concurrent taskId collisions within one session
 * pick distinct escape-hatch names instead of racing each other onto the same
 * `.fallback` file. Reservation happens synchronously (no `await` between
 * checking and claiming), so within-process races cannot occur even though
 * dispatches run concurrently.
 */
const reservedFallbackNames = new WeakMap<RunDiagnostics, Set<string>>();

function reserveFallbackName(diagnostics: RunDiagnostics, stderrName: string): string {
	let reserved = reservedFallbackNames.get(diagnostics);
	if (!reserved) {
		reserved = new Set();
		reservedFallbackNames.set(diagnostics, reserved);
	}
	let candidate = `${stderrName}.fallback`;
	let attempt = 2;
	while (reserved.has(candidate) || existsSync(join(diagnostics.dir, candidate))) {
		candidate = `${stderrName}.fallback-${attempt}`;
		attempt += 1;
	}
	reserved.add(candidate);
	return candidate;
}

/**
 * Open the destination for a child's stderr as a real file descriptor,
 * never a pipe. Node prints the offending source line first on an uncaught
 * exception, then the error's name/message/stack; HT's minified bundle has
 * source lines up to ~650 KB, and Node's async pipe read can silently drop
 * everything past its ~64 KiB buffer once the child exits — exactly where
 * that name/message/stack lives. A real fd has no such loss: the child
 * writes straight to a file, and the bytes are visible to any other reader
 * (including this process, after `close`) as soon as the write syscall
 * returns.
 *
 * With a session, the destination is the run's own `<taskId>.stderr.log`,
 * opened under `RunDiagnostics`' fresh-directory/inode/lease guarantees
 * (see run-diagnostics.ts) so it participates in the same drain-then-seal
 * lifecycle as every other diagnostic file. Without a session (e.g. triage,
 * or a caller that never started a run), it is a private mode-0600 temp file
 * that the caller must remove via `release()`.
 */
function openStderrTarget(session: RunSession | undefined, stderrName: string): StderrTarget {
	if (session) {
		try {
			const backing = session.diagnostics.openChildStderrFile(stderrName);
			return { path: backing.path, fd: backing.fd, persistName: stderrName, closeFd: backing.closeFd, release: backing.release };
		} catch (err) {
			// A reused taskId within one session (unexpected, but not worth failing
			// the whole dispatch over) or diagnostics already closing/sealed. Fall
			// back to a private temp file rather than losing the fd-vs-pipe fix —
			// but that fallback is otherwise invisible, so log it. `persistName`
			// below is a reserved name distinct from `stderrName`: every later
			// `diagnosticWriter.write/append` call for THIS dispatch must route
			// through it, never through `stderrName` itself, or it would reopen
			// and clobber the earlier dispatch's already-registered file.
			const message = `stderr for ${stderrName} fell back to a private temp file: ${(err as Error).message}`;
			console.warn(`[orchestrator] ${message}`);
			try { session.log(message); } catch { /* best-effort */ }
			const dir = mkdtempSync(join(tmpdir(), "orch-subagent-stderr-"));
			const path = join(dir, stderrName);
			const persistName = reserveFallbackName(session.diagnostics, stderrName);
			let fd: number;
			try {
				fd = openSync(path, "wx", 0o600);
			} catch (openErr) {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
				throw openErr;
			}
			let fdOpen = true;
			const closeFd = () => {
				if (!fdOpen) return;
				fdOpen = false;
				try { closeSync(fd); } catch { /* already closed */ }
			};
			return {
				path,
				fd,
				persistName,
				closeFd,
				release: () => {
					closeFd();
					// finish()/the 'close' handler already persist this dispatch's real
					// and orchestrator-authored content under `persistName` as it goes
					// (see runSubagentProcess); nothing further needs copying here.
					// Just remove the private temp file/dir.
					try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
				},
			};
		}
	}
	// No session at all (e.g. triage): private mode-0600 temp file, removed via
	// release(). `persistName` is unused here — nothing ever writes through a
	// `diagnosticWriter`, since there is no session to own one.
	const dir = mkdtempSync(join(tmpdir(), "orch-subagent-stderr-"));
	const path = join(dir, stderrName);
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (err) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
		throw err;
	}
	let fdOpen = true;
	const closeFd = () => {
		if (!fdOpen) return;
		fdOpen = false;
		try { closeSync(fd); } catch { /* already closed */ }
	};
	return {
		path,
		fd,
		persistName: stderrName,
		closeFd,
		release: () => {
			closeFd();
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
		},
	};
}

/**
 * Spawn Pi as a one-shot subagent and parse its JSON event stream for the
 * assistant `message_end`, which carries `model`, `usage`, and `cost.total`.
 * This is the same on-the-wire protocol the human-facing subagent tool uses
 * internally — we just launch it from a context (extension handler) where the
 * human-facing wrapper doesn't have what it needs.
 */
export async function runSubagentProcess(opts: {
	cwd: string;
	agentName: string;
	task: string;
	model: string;
	effort?: string;
	tools?: string[];
	ctx: ExtensionContext;
	/** Stable id used for the progress board and log file names. */
	taskId?: string;
	/** Short human label for the progress board (defaults to agentName). */
	label?: string;
	/** Selects the wall clock: orchestrating capabilities wait on their own children. */
	capability?: string;
	/** Nesting depth for the widget (0 = top-level, 1 = child of a lead, etc.). */
	depth?: number;
	/** Test seam for deterministic progress/absolute timeout coverage. */
	leadTimeouts?: { inactivityMs: number; maxMs: number };
	/** Optional owning session; production callers use the active run. */
	session?: RunSession;
	/**
	 * Test seam only: replaces the real child launcher. Defaults to node's
	 * `spawn`; production callers never set this. Lets tests exercise the real
	 * stream/event/close handling below against a deterministic local fixture
	 * instead of the actual `humain-terminal --mode json` binary.
	 */
	/*
	 * This branch previously added a second positional parameter
	 * (`spawnProcess: ChildSpawner = spawn`) for the same purpose. Converged on
	 * `spawnChild` instead of shipping two seams for one job: it is the one
	 * main's suite already exercises, and keeping it inside the options object
	 * means the next seam does not grow the signature again.
	 */
	spawnChild?: ChildSpawner;
}): Promise<SubagentProcessResult> {
	const emptyUsage: SubagentUsageStats = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		cost: 0, contextTokens: 0, turns: 0,
	};
	const session = opts.session ?? ACTIVE_RUN;
	session?.cancellation.throwIfCancelled();
	const taskId = opts.taskId ?? `${opts.agentName}-${Date.now()}`;
	const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]+/g, "_");
	const eventsName = `${safeTaskId}.events.jsonl`;
	const stderrName = `${safeTaskId}.stderr.log`;
	if (session) {
		try {
			session.writeDiagnostic(`${safeTaskId}.prompt.md`, opts.task);
		} catch {
			/* best-effort */
		}
		session.startDispatch(taskId, opts.label ?? opts.agentName, opts.model, opts.depth ?? 0);
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	// model is "provider/modelId"; split so the CLI resolver can pick the
	// right provider binding (mirrors executeSingleSubagent).
	const slashIndex = opts.model.indexOf("/");
	if (slashIndex !== -1) {
		args.push("--provider", opts.model.slice(0, slashIndex));
		args.push("--model", opts.model.slice(slashIndex + 1));
	} else {
		args.push("--model", opts.model);
	}

	if (opts.effort) args.push("--thinking", opts.effort);

	// Resolve the orchestrator agent persona the same way the subagent tool
	// does: read the agent markdown from the runtime's agents/ directories and
	// pass its body via --append-system-prompt. There is NO `--agent` CLI flag;
	// passing one makes HT exit 1 with "Unknown option: --agent" before it ever
	// contacts a provider, which is what silently zeroed out every dispatch.
	let persona: { tools?: string[] } | undefined;
	let promptDir: string | undefined;
	if (opts.agentName === NO_PERSONA) {
		/* probes run on the default system prompt on purpose */
	} else try {
		const discovered = discoverAgents(opts.cwd, "both");
		const agent = discovered.agents.find((a) => a.name === opts.agentName);
		if (agent) {
			persona = { tools: agent.tools };
			if (agent.systemPrompt.trim()) {
				promptDir = mkdtempSync(join(tmpdir(), PERSONA_TMP_PREFIX));
				const promptPath = join(promptDir, `${opts.agentName}.md`);
				writeFileSync(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
				args.push("--append-system-prompt", promptPath);
			}
		} else {
			console.warn(`[orchestrator] agent persona not found: ${opts.agentName} (using default persona)`);
		}
	} catch (err) {
		console.warn(`[orchestrator] agent persona load failed: ${(err as Error).message}`);
	}

	const tools = opts.tools && opts.tools.length > 0 ? opts.tools : persona?.tools;
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	// An allow-list without write/edit means the child physically could not have
	// touched a file, so anything its prose mentions is a false positive. With no
	// allow-list at all the child gets the default tool set, which can mutate.
	const personaCanMutate = !tools || tools.some((t) => t === "write" || t === "edit");

	// Avoid feedback loops: an extension handler inside an interactive
	// session must not recursively load extensions or the user's skill
	// commands. Subagent tool does the same.
	args.push("--no-extensions", "--no-skills", "--no-prompt-templates");

	args.push(renderTaskWithContext(opts.task, undefined));

	const startedAt = Date.now();
	return new Promise<SubagentProcessResult>((resolve) => {
		const invocation = orchCliInvocation(args);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HUMAIN_TERMINAL_RUNTIME: "orchestrator-dispatch",
			CODING_AGENT_RUNTIME: "humain-terminal",
			CODING_AGENT_REPOSITORY: opts.cwd,
			// Supacode/HT injected a few env vars that a nested Pi run would
			// pick up and try to attach to the parent's supacode session —
			// that fails fast with an auth error. Clear them.
			SUPACODE_SESSION: undefined,
			SUPACODE_TAB_ID: undefined,
		};
		let buffer = "";
		// Raw child events can recursively include full worker histories. Retain
		// only diagnostics, never the unbounded stream.
		const stdoutCapture = new BoundedCapture();
		// Node can truncate a chatty child's async pipe at 64 KiB, so retain both
		// the runtime header and the diagnostic tail without unbounded memory use.
		const stderrCapture = new BoundedCapture();
		let model: string | undefined;
		const usage: SubagentUsageStats = { ...emptyUsage };
		const nestedCost = new NestedCostTracker();
		/** Own turns plus the child's own subagent calls: what the dispatch has cost so far. */
		const spentSoFar = () => usage.cost + nestedCost.total();
		let costReported = false;
		let stopReason: string | undefined;
		let sawAgentSettled = false;
		let sawAgentEnd = false;
		let timedOut = false;
		let cancelledByListener = false;
		let timeoutReason: "inactivity" | "absolute" | undefined;
		let interruption: InterruptionReport | undefined;
		let spawnFailed = false;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let removeCancellationListener: (() => void) | undefined;
		let progressTracker: DispatchProgressTracker | undefined;
		let isLead = false;
		let dispatchStartedAt = startedAt;
		let toolCalls = 0;
		let assistantTurns = 0;
		let interruptionNote: string | undefined;
		let armTimer: () => void = () => {};
		let handleExpiry: (reason: "inactivity" | "absolute") => void = () => {};
		let handleSpendCap: (verdict: Exclude<SpendCapVerdict, "ok">) => void = () => {};
		// `--mode json` writes newline-delimited events, NOT plain prose. Callers
		// need the assistant's text, so accumulate it here; handing them the raw
		// event stream made triage's JSON.parse fail every single time.
		const assistantTexts: string[] = [];

		const cleanupPrompt = () => {
			if (!promptDir) return;
			try {
				rmSync(promptDir, { recursive: true, force: true });
			} catch {
				/* best-effort temp cleanup */
			}
			promptDir = undefined;
		};

		const recordInterruption = (reason: InterruptionReport["reason"]): string => {
			if (interruptionNote) return interruptionNote;
			const now = Date.now();
			// The tracker is created only after a successful spawn; a cancellation
			// racing a synchronous spawn failure still needs an honest note.
			if (!progressTracker) {
				progressTracker = new DispatchProgressTracker(resolveDispatchTimeoutPolicy(opts.capability, process.env), dispatchStartedAt);
			}
			interruption = buildInterruptionReport({
				taskId,
				reason,
				startedAt: dispatchStartedAt,
				now,
				turns: assistantTurns,
				toolCalls,
				partialText: assistantTexts[assistantTexts.length - 1] ?? "",
				tracker: progressTracker,
			});
			interruptionNote = renderInterruptionReport(interruption);
			stderrCapture.append(`\n${interruptionNote}`);
			return interruptionNote;
		};
		let diagnosticWriter: DiagnosticWriter | undefined;
		let stderrPrefix = "";
		let stderrTarget: StderrTarget | undefined;
		// Decided exactly once, at the moment finish() first runs, from the size the
		// child itself had written to the backing file *before* any orchestrator note
		// is written into it. The close handler reuses this same decision instead of
		// re-stat'ing after finish() has already written into the file: re-stat'ing
		// there mistook the orchestrator's own just-written notes for real child bytes
		// and appended the same notes a second time (BLOCKING 1).
		let settledFileBytes: number | undefined;
		// Set only when finish() itself writes its own notes into the *real*
		// backing file (fileBytes === 0 at settle, non-fallback target): the
		// file size immediately after that write. The 'close' handler diffs
		// against this, not a fresh unconditional re-stat, to tell "the
		// orchestrator's own notes" apart from "real child bytes that arrived
		// between settle and close" (the latter must be preserved, not
		// truncated away).
		let noteWriteBytes: number | undefined;
		const currentStderrFileBytes = (): number => {
			if (!stderrTarget) return 0;
			try { return statSync(stderrTarget.path).size; } catch { return 0; }
		};
		const finish = (processExitCode: number) => {
			if (settled) return;
			const cancelled = cancelledByListener || session?.cancellation.isCancelled === true;
			cancelledByListener = cancelled;
			if (cancelled) session?.log(recordInterruption("cancelled"));
			settled = true;
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			removeCancellationListener?.();
			if (typeof proc?.pid === "number") liveDispatchPids.delete(proc.pid);
			cleanupPrompt();
			// Real child stderr now lands on a file, not a pipe (see openStderrTarget);
			// nothing streams it into stderrCapture in real time, so read whatever the
			// child has written so far — settlement can race the child's own exit on a
			// timeout/cancel, and the file may still be mid-write at this exact instant.
			// The 'close' handler below re-reads the final, complete content.
			const fileBytes = currentStderrFileBytes();
			if (settledFileBytes === undefined) settledFileBytes = fileBytes;
			const fileText = fileBytes > 0 ? readStderrFileBounded(stderrTarget!.path) : "";
			const rawStderr = stderrCapture.text() + (fileText ? `\n${fileText}` : "");
			const stderrSummary = summarizeStderr(rawStderr);
			const finalText = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "";
			// Only recover a process error after the JSON protocol proved the child
			// completed normally; failures before settlement still fail the dispatch.
			const outcome = classifyDispatchOutcome({
				exitCode: processExitCode,
				sawAgentSettled,
				sawAgentEnd,
				hasFinalText: Boolean(finalText),
				lastStopReason: stopReason,
				timedOut,
				cancelled,
				spawnFailed,
				stderrSummary,
			});
			stderrPrefix = outcome.status === "completed_after_process_error"
				? `[orchestrator] child produced a terminal result (agent_settled, stopReason=stop) then exited ${processExitCode}; result kept.\n`
				: "";
			// The prefix belongs at the START of both the returned stderr and the
			// persisted stderr.log — it is a warning about how to read what follows,
			// not a trailing note (pre-change behavior; a later refactor accidentally
			// dropped it from the returned `stderr`, keeping it only in the file write).
			// When real child bytes are on disk, the persisted log is written as
			// prefix + child content + our own notes (BLOCKING 2, review round 2) —
			// mirror that ordering here too, so the returned value and the log agree
			// on what comes first. `stderrSummary`/classification above already ran
			// against `rawStderr` in its original (notes, then file) order; reordering
			// only the string handed back to the caller does not change either.
			const stderr = stderrPrefix
				? fileBytes > 0
					? `${stderrPrefix}${fileText}${stderrCapture.text() ? `\n${stderrCapture.text()}` : ""}`
					: `${stderrPrefix}${rawStderr}`
				: rawStderr;
			if (diagnosticWriter) {
				// If the child already has real bytes on disk (a real fd-backed stderr
				// file), leave that file alone here: it may still be open for writing by
				// a not-yet-exited child, and overwriting it now would race that write.
				// The 'close' handler caps and appends our notes once the child has
				// fully exited. Only the legacy (no real file content) path needs the
				// full write here, matching pre-fd behavior for test doubles that
				// bypass stdio entirely and stream stderr straight into stderrCapture.
				if (fileBytes === 0) {
					diagnosticWriter.write(stderrTarget!.persistName, stderrPrefix + stderrCapture.text());
					// Only meaningful (and only safe to compare against later) when
					// `persistName` IS the real backing file at `stderrTarget.path`
					// (the non-fallback case): record how large that write left it, so
					// the 'close' handler can tell its own notes apart from any real
					// child bytes that land afterward, before the process actually exits.
					if (stderrTarget!.persistName === stderrName) noteWriteBytes = currentStderrFileBytes();
				}
			}
			session?.endDispatch(taskId, outcome.effectiveExitCode, usage.cost, interruptionNote ? summarizeInterruption(interruption!) : outcome.note);
			resolve({
				exitCode: outcome.effectiveExitCode,
				stdout: assistantTexts.join("\n\n"),
				finalText,
				rawStdout: stdoutCapture.text(),
				personaCanMutate,
				stderr,
				model,
				usage,
				costUsd: usage.cost,
				nestedCostUsd: nestedCost.total(),
				costReported,
				durationMs: Date.now() - startedAt,
				stopReason,
				outcome: outcome.status,
				processExitCode,
				timeoutReason,
				interruption,
				postCompletionError: outcome.status === "completed_after_process_error" ? outcome.note : undefined,
			});
		};

		const absorbAssistantMessage = (msg: any) => {
			if (msg.model) model = msg.responseModel ?? msg.model;
			if (msg.usage) {
				usage.turns += 1;
				usage.input += msg.usage.input || 0;
				usage.output += msg.usage.output || 0;
				usage.cacheRead += msg.usage.cacheRead || 0;
				usage.cacheWrite += msg.usage.cacheWrite || 0;
				const cost = reportedCost(msg.usage.cost?.total);
				costReported = (usage.turns === 1 || costReported) && cost !== undefined;
				usage.cost += cost ?? 0;
				usage.contextTokens = msg.usage.totalTokens || usage.contextTokens;
			}
			if (msg.stopReason) stopReason = msg.stopReason;
			// A provider error arrives as a turn with stopReason "error" and an
			// errorMessage, not on stderr (the child still exits 0 in json mode).
			// Keep it in the stderr capture so the failure is explainable and the
			// codex -> Bedrock quota fallback can see it.
			if ((msg.stopReason === "error" || msg.stopReason === "aborted") && typeof msg.errorMessage === "string" && msg.errorMessage) {
				stderrCapture.append(`\n[provider ${msg.stopReason}] ${msg.errorMessage}`);
			}
			if (Array.isArray(msg.content)) {
				const text = msg.content
					.filter((b: any) => b?.type === "text" && typeof b.text === "string")
					.map((b: any) => b.text)
					.join("\n")
					.trim();
				if (text) assistantTexts.push(text);
			} else if (typeof msg.content === "string" && msg.content.trim()) {
				assistantTexts.push(msg.content.trim());
			}
			// Spend cap is checked AFTER the message text is kept, so an enforced
			// stop never discards the turn that crossed the cap. A final turn
			// (stopReason "stop") is only warned about: killing it would throw away
			// a finished report to save nothing.
			if (msg.usage) {
				const verdict = session?.spendCaps.observe(taskId, opts.capability ?? "unknown", spentSoFar()) ?? "ok";
				if (verdict !== "ok") handleSpendCap(verdict === "stop" && msg.stopReason === "stop" ? "warn" : verdict);
			}
		};

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				// Unparseable protocol lines are dropped: they cannot safely be JSONL.
				return;
			}
			diagnosticWriter?.append(eventsName, `${JSON.stringify(trimEventForLog(event))}\n`);
			// A timeout/cancellation settles the result before stdio closes. Preserve
			// trailing diagnostics under the producer lease, but never revive progress
			// or mutate the already-returned usage/result after that boundary.
			if (settled) return;
			const now = Date.now();
			const observation = cancelledByListener ? undefined : progressTracker?.observe(event, now);
			session?.onChildEvent(taskId, event);
			if (event.type === "agent_settled") sawAgentSettled = true;
			if (event.type === "agent_end") sawAgentEnd = true;
			if (typeof event.stopReason === "string") stopReason = event.stopReason;
			// `message_end` is the authoritative per-turn record. `turn_end` and
			// `agent_end` repeat the same assistant messages, so ignoring them
			// keeps usage from being double-counted.
			if (event.type === "message_end" && event.message?.role === "assistant") {
				assistantTurns += 1;
				absorbAssistantMessage(event.message);
			}
			if (nestedCost.observe(event)) {
				session?.setNestedCost(taskId, nestedCost.total());
				const verdict = session?.spendCaps.observe(taskId, opts.capability ?? "unknown", spentSoFar()) ?? "ok";
				if (verdict !== "ok") handleSpendCap(verdict);
			}
			if (progressTracker && observation) {
				if (event.type === "tool_execution_start") toolCalls += 1;
				const check = progressTracker.check(now);
				session?.recordProgress(taskId, observation, {
					...check,
					warnings: isLead ? check.warnings : [],
				}, now);
				if (isLead) {
					for (const warning of check.warnings) stderrCapture.append(`\n${warning.text}`);
					if (check.expired) handleExpiry(check.expired);
					else if (observation.kind === "progress") {
						if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
						timeoutTimer = undefined;
						armTimer();
					}
				}
			}
		};

		// spawn() itself throws synchronously on argument-validation errors (as
		// opposed to ENOENT, which arrives as an async 'error' event). Without this
		// guard the throw escapes before any listener exists, so finish() never
		// runs and the persona prompt temp dir leaks.
		// Optional so `finish()` can run from the synchronous-spawn-throw path,
		// where no child was ever created.
		let proc: ChildProcess | undefined;
		const spawnChild: ChildSpawner = opts.spawnChild ?? spawn;
		try {
			diagnosticWriter = session?.diagnostics.writer();
			stderrTarget = openStderrTarget(session ?? undefined, stderrName);
			proc = spawnChild(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", stderrTarget.fd],
				env,
				// Make the child a process-group leader so a timeout can kill the
				// whole tree. A dispatched lead spawns its own subagents, and
				// SIGKILL on the direct pid alone leaves those grandchildren
				// orphaned, still running, and still billing with nothing reading
				// their output. We never unref(), so we still await this child.
				detached: true,
			});
			// The child has (or, on POSIX, will momentarily) inherit its own copy of
			// the fd via the underlying fork/exec; ours is no longer needed. Closing
			// it here does not affect the child's ability to keep writing to the file.
			stderrTarget.closeFd();
		} catch (err) {
			spawnFailed = true;
			stderrCapture.append(`\n[orchestrator] spawn threw: ${(err as Error).message}`);
			// A throw from finish() itself (e.g. a diagnostic write failure) must not
			// leak the fd/lease/temp dir; release/close unconditionally.
			try {
				finish(1);
			} finally {
				stderrTarget?.release();
				diagnosticWriter?.close();
			}
			return;
		}


		if (typeof proc.pid === "number") liveDispatchPids.add(proc.pid);
		dispatchStartedAt = Date.now();
		// Policy is resolved per dispatch (env read now, not at module load) so
		// operators and tests can change limits without reloading the extension.
		// `leadTimeouts` is a test seam that only applies to orchestrating capabilities.
		const timeoutOverride = ORCHESTRATING_CAPABILITIES.has(opts.capability ?? "") ? opts.leadTimeouts : undefined;
		const policy: DispatchTimeoutPolicy = applyLeadTimeoutOverride(
			resolveDispatchTimeoutPolicy(opts.capability, process.env),
			timeoutOverride,
		);
		isLead = policy.mode === "lead";
		progressTracker = new DispatchProgressTracker(policy, dispatchStartedAt);
		for (const note of policy.notes) {
			stderrCapture.append(`\n[orchestrator] timeout configuration: ${note}`);
			session?.log(`dispatch ${taskId} timeout configuration: ${note}`);
		}

		handleExpiry = (reason) => {
			if (settled || cancelledByListener) return;
			timedOut = true;
			timeoutReason = reason;
			const explanation = progressTracker?.describeExpiry(reason, opts.capability, Date.now()) ?? reason;
			stderrCapture.append(`\n[orchestrator] ${reason} timeout: ${explanation}`);
			const report = recordInterruption(reason === "inactivity" ? "inactivity_timeout" : "absolute_timeout");
			session?.log(report);
			if (proc) killProcessTree(proc);
			finish(124);
		};

		handleSpendCap = (verdict) => {
			if (settled || cancelledByListener) return;
			const capability = opts.capability ?? "unknown";
			const cap = capFor(capability);
			const message = `spend cap $${cap.toFixed(2)} for ${capability} exceeded by ${taskId} at $${spentSoFar().toFixed(4)}${nestedCost.total() > 0 ? ` ($${nestedCost.total().toFixed(4)} in its subagents)` : ""}`;
			session?.log(`${message} (${verdict === "stop" ? "stopping it" : "warn only"})`);
			recordEvent("spend_cap_exceeded", {
				run_id: session?.runId, task_id: taskId, capability, model: opts.model,
				cap_usd: cap, cost_usd: spentSoFar(), nested_cost_usd: nestedCost.total(), action: verdict,
			});
			session?.ctx.ui?.notify?.(`${message}${verdict === "stop" ? " — stopping it" : ""}`, "warning");
			if (verdict !== "stop") return;
			stopReason = "spend_cap";
			stderrCapture.append(`\n[orchestrator] ${message}; dispatch stopped (dispatch_spend_cap.mode=enforce)`);
			if (proc) killProcessTree(proc);
			finish(125);
		};

		removeCancellationListener = session?.cancellation.onCancel(() => {
			if (proc && !settled) {
				cancelledByListener = true;
				if (timeoutTimer !== undefined) {
					clearTimeout(timeoutTimer);
					timeoutTimer = undefined;
				}
				// Drain already-buffered usage before billing, but do not depend on
				// close: a detached descendant can hold inherited pipes open forever.
				// Keep this inside shutdown's 2s budget. finish() is idempotent and
				// clears the timer; only real close releases the diagnostic lease, so
				// an undrained producer still prevents sealing after we settle.
				timeoutTimer = setTimeout(() => finish(137), 1000);
				killProcessTree(proc);
			}
		});

		armTimer = () => {
			if (settled || cancelledByListener || !progressTracker) return;
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			const now = Date.now();
			const check = progressTracker.peek(now);
			if (check.expired) {
				handleExpiry(check.expired);
				return;
			}
			const delay = Math.max(50, Math.min(30_000, check.nextCheckMs));
			timeoutTimer = setTimeout(() => {
				timeoutTimer = undefined;
				if (settled || cancelledByListener || !progressTracker) return;
				const tickNow = Date.now();
				const tickCheck = progressTracker.check(tickNow);
				session?.recordProgress(taskId, { kind: "heartbeat", detail: "timer" }, tickCheck, tickNow);
				for (const warning of tickCheck.warnings) stderrCapture.append(`\n${warning.text}`);
				if (tickCheck.expired) handleExpiry(tickCheck.expired);
				else armTimer();
			}, delay);
		};
		// A cancellation that fired synchronously above is already stopping the
		// child; never arm another execution deadline. Do NOT return early here: handlers must
		// still attach to drain usage and catch a late child 'error' event.
		if (isLead) {
			armTimer();
		} else if (!settled && !cancelledByListener) {
			// Leaf dispatches retain their fixed wall-clock timeout
			// (HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS); no inactivity rule applies.
			const leafTimeoutMs = policy.absoluteMs;
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				timedOut = true;
				stderrCapture.append(
					`\n[orchestrator] dispatch timed out after ${Math.round(leafTimeoutMs / 60000)}min ` +
						`(capability=${opts.capability ?? "unknown"}); killing process group`,
				);
				if (proc) killProcessTree(proc);
				finish(124);
			}, leafTimeoutMs);
		}

		const streamFailure = {
			appendStderr: (text: string) => stderrCapture.append(text),
			kill: () => killProcessTree(proc),
			finish,
		};
		proc.stdout?.on("data", (data) => {
			guardChildStreamHandler("stdout", () => {
				const chunk = data.toString();
				stdoutCapture.append(chunk);
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			}, streamFailure);
		});

		proc.stderr?.on("data", (data) => {
			// Only ever fires for a test double that hands us a real stream (see
			// openStderrTarget's fallback for anything spawned for real: stdio[2] is
			// a raw fd there, so `proc.stderr` is null and this listener is inert).
			stderrCapture.append(data.toString());
		});

		proc.on("close", (code) => {
			try {
				guardChildStreamHandler("stdout", () => {
					if (buffer.trim()) processLine(buffer);
					finish(code ?? 0);
					// Early settlement on timeout/error is not pipe drain. Keep the lease
					// until close. Reuse the *settle-time* byte count decided inside
					// finish() above, not a fresh stat here: finish() may have just written
					// orchestrator notes into an until-then-empty file, and re-stat'ing
					// after that would mistake those notes for real child bytes and append
					// the same notes a second time (BLOCKING 1). capChildStderrFile and the
					// read-back below run inside this same guarded handler so a throw here
					// cannot escape as an uncaught exception on the 'close' event.
					const fileBytes = settledFileBytes ?? 0;
					const persistName = stderrTarget?.persistName ?? stderrName;
					// The taskId-collision fallback target (see openStderrTarget) writes its
					// own persisted content to persistName, a name distinct from
					// stderrTarget.path's physical file; re-stat'ing that path here is
					// always safe (finish() never writes through it), unlike the
					// non-fallback case where path IS the persisted file itself.
					const isFallback = persistName !== stderrName;
					if (diagnosticWriter) {
						if (fileBytes > 0 || (isFallback && currentStderrFileBytes() > 0)) {
							// Real child bytes exist on the backing file - either observed at
							// settle, or (fallback only) arrived since. Persist them with the
							// recovered-result prefix LEADING, not trailing (BLOCKING 2, review
							// round 2): read the (possibly on-disk-capped) content once and
							// write prefix+content, then append our own notes after it. Reserve
							// room for the prefix and the notes in the cap itself (WARNING,
							// review round 3) so the composed prefix+content+notes never
							// exceeds MAX_CHILD_STDERR_DISK_BYTES even though only `content` is
							// capped directly.
							const notes = stderrCapture.text();
							const notesSuffix = notes ? `\n${notes}` : "";
							const reserveBytes = Buffer.byteLength(stderrPrefix, "utf8") + Buffer.byteLength(notesSuffix, "utf8");
							const budget = Math.max(0, MAX_CHILD_STDERR_DISK_BYTES - reserveBytes);
							const capped = capChildStderrFile(stderrTarget!.path, budget);
							if (isFallback) {
								// The backing file is a private temp file distinct from
								// persistName's real file (see openStderrTarget's fallback):
								// its content must actually be copied over. `capped` already
								// read it through bounded, fixed-position reads when it's
								// over budget; when under budget, `size <= budget` by
								// definition of capChildStderrFile, so this read is bounded
								// by the same cap - never an unbounded whole-file load.
								const content = capped ?? readFileSync(stderrTarget!.path, "utf8");
								diagnosticWriter.write(persistName, `${stderrPrefix}${content}`);
								if (notes) diagnosticWriter.append(persistName, notesSuffix);
							} else if (capped !== undefined || stderrPrefix) {
								// Same physical file as persistName: only rewrite it when
								// something must actually change (a prefix to prepend, or
								// on-disk content that must shrink to fit the cap) - never an
								// unconditional read-then-truncate-then-write, which would
								// open a window where a concurrently-writing escaped
								// descendant's bytes land between the read and the truncate
								// and are lost (WARNING, review round 3).
								const content = capped ?? readFileSync(stderrTarget!.path, "utf8");
								diagnosticWriter.write(persistName, `${stderrPrefix}${content}`);
								if (notes) diagnosticWriter.append(persistName, notesSuffix);
							} else if (notes) {
								// Nothing to prepend and nothing to cap: the child's bytes are
								// already exactly where they belong: only the notes are new.
								diagnosticWriter.append(persistName, notesSuffix);
							}
						} else if (!isFallback && noteWriteBytes !== undefined && currentStderrFileBytes() > noteWriteBytes) {
							// finish() already wrote our notes into the real backing file
							// (settle saw 0 bytes there), and the child kept writing real
							// bytes for a moment before actually exiting. Those bytes landed
							// through the same O_APPEND fd as everything else in this
							// (non-fallback) file - persistName IS stderrTarget.path here - so
							// they are already exactly where they belong. Re-reading and
							// re-appending them (as review round 2 did, via an unbounded
							// Buffer.alloc(lateBytes) with no cap check) duplicated them in
							// the sealed log and could allocate without bound (BLOCKING,
							// review round 3). Only cap the file if it has now grown past the
							// limit; otherwise leave it untouched.
							const capped = capChildStderrFile(stderrTarget!.path, MAX_CHILD_STDERR_DISK_BYTES);
							if (capped !== undefined) diagnosticWriter.write(persistName, capped);
						} else {
							// Nothing real ever landed in the backing file (a test double that
							// bypasses stdio entirely): fall back to persisting stderrCapture's
							// text wholesale, matching the pre-fd behavior exactly, including
							// any trailing diagnostics that arrived after finish() resolved.
							// finish() already wrote this same content once (when fileBytes was
							// 0 at settle time); this re-write is an idempotent overwrite with
							// identical content, not a duplicate append.
							diagnosticWriter.write(persistName, stderrPrefix + stderrCapture.text());
						}
					}
				}, streamFailure);
			} finally {
				stderrTarget?.release();
				diagnosticWriter?.close();
			}
		});


		proc.on("error", (err) => {
			spawnFailed = true;
			stderrCapture.append(`\n[orchestrator] spawn error: ${err.message}`);
			finish(1);
		});
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
		});
		costSink.usd += r?.costUsd ?? 0;
		// Bill the dispatch before parsing: malformed/empty classifier output still used tokens.
		await captureDispatchCost(
			{ runId, planId: "triage", taskClass: "triage", complexity: 5, risk: "medium",
				recommended: { capability: "implementation_fast", effort: "low", verification_depth: "none" }, mode: "triage" },
			{ taskId: "triage", capability: "triage", model: r.model ?? cheapest.model,
				exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, usage: r.usage,
				durationMs: r.durationMs, costUsd: r.costUsd, costReported: r.costReported, stopReason: r.stopReason, filesChanged: [] },
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
	const session = ACTIVE_RUN?.runId === runId ? ACTIVE_RUN : null;
	recordEvent("run_completed", { run_id: runId, ...timing });
	recordOutcome({ ...runCompletionOutcomeFor(runId, summary), ...timing });
	const report = reportSince(await recordQueue.flush(), since);
	session?.acknowledgeTerminal(report.ok);
	return report;
}

export async function failRun(runId: string, error: string, timing?: RunTiming, since?: QueueStats): Promise<FlushReport> {
	const session = ACTIVE_RUN?.runId === runId ? ACTIVE_RUN : null;
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
	costReported: boolean;
	stopReason?: string;
	outcome?: SubagentProcessResult["outcome"];
	timeoutReason?: "inactivity" | "absolute";
	interruption?: InterruptionReport;
	filesChanged: string[];
	/** HT thinking level the dispatch ran at (from the binding), when one was set. */
	effort?: string;
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
		/** Alias table for the codex -> Bedrock quota fallback; defaults to the active run's. */
		aliasTable?: AliasTable | null;
	} = { recordEvent, runProcess: runSubagentProcess },
): Promise<DispatchResult[]> {
	if (tasks.length === 0) return [];

	// Drain queued user messages ONCE at the start of this batch. Every task in
	// the batch sees the same messages; the next dispatchParallel call picks up
	// anything that arrived during or after this one. Draining mid-batch would
	// split messages across two prompts in non-obvious ways.
	const session = ACTIVE_RUN;
	const recipient = tasks.length === 1
		? `${tasks[0].capability}:${tasks[0].taskId.replace(`${runId}-`, "")}`
		: `${tasks.length} ${tasks[0].capability} tasks`;
	const userMessages = session ? session.drainMessages(recipient) : [];

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
			const runOn = (model: string, taskId: string | undefined, label: string) => deps.runProcess({
				cwd: input.cwd,
				agentName: input.agent,
				task: input.task,
				model,
				effort: input.effort,
				taskId,
				label,
				capability: input._capability,
				depth,
				// Still no *hardcoded* tools override here — that is what previously
				// granted reviewers write access and stripped tools the personas need.
				// `input.tools` is per-task and set by exactly one producer,
				// `planReconTasks()`, which pins recon to read-only. Every other task
				// leaves it undefined, and runSubagentProcess then falls back to the
				// persona's own frontmatter allow-list, so persona policy still wins
				// everywhere it did before.
				tools: input.tools,
				ctx,
			});
			let r = await runOn(input.model, input._taskId, shortId);
			// Codex first, Bedrock fallback: a quota/rate-limit failure on an
			// openai-codex model is retried ONCE on the same model id under
			// amazon-bedrock. Both attempts are billed (usage summed).
			const table = deps.aliasTable === undefined ? CURRENT_ALIAS_TABLE : deps.aliasTable;
			// Only a genuine provider rejection qualifies: not a timeout, a user
			// cancel, or a spend-cap stop (those would re-run finished work), and
			// only when stderr (not the model's own prose) names the quota.
			const eligible = r.exitCode !== 0 && r.outcome !== "timed_out" && r.outcome !== "cancelled" &&
				r.stopReason !== "spend_cap" && !(session ?? ACTIVE_RUN)?.cancellation.isCancelled;
			const twin = eligible && table && isQuotaError(r.stderr) ? bedrockFallbackFor(input.model, table) : null;
			if (twin) {
				deps.recordEvent("dispatch_finished", {
					run_id: runId, task_id: input._taskId, capability: input._capability, model: r.model ?? input.model,
					exit_code: r.exitCode, duration_ms: r.durationMs, cost_usd: r.costUsd, turns: r.usage.turns,
					stop_reason: r.stopReason, log_dir: ACTIVE_RUN?.dir, superseded_by_fallback: true,
				});
				deps.recordEvent("route_degraded", {
					run_id: runId, task_id: input._taskId, capability: input._capability,
					from_model: input.model, to_model: twin, reason: "provider_quota",
					detail: summarizeStderr(r.stderr, 240),
				});
				ACTIVE_RUN?.log(`${input._taskId}: ${input.model} hit a provider quota; retrying once on ${twin}`);
				const first = r;
				const second = await runOn(twin, input._taskId ? `${input._taskId}-fallback` : undefined, `${shortId}↻`);
				r = {
					...second,
					usage: sumUsage(first.usage, second.usage),
					costUsd: first.costUsd + second.costUsd,
					nestedCostUsd: (first.nestedCostUsd ?? 0) + (second.nestedCostUsd ?? 0),
					costReported: first.costReported && second.costReported,
					durationMs: first.durationMs + second.durationMs,
				};
			}
			deps.recordEvent("dispatch_finished", {
				run_id: runId,
				task_id: input._taskId,
				capability: input._capability,
				model: r.model ?? input.model,
				exit_code: r.exitCode,
				duration_ms: r.durationMs,
				cost_usd: r.costUsd,
				nested_cost_usd: r.nestedCostUsd,
				turns: r.usage.turns,
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
	...METHOD.capability_personas,
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

/** Fingerprint recorded for a dirty path that no longer exists on disk. */
const DELETED_FINGERPRINT = "<deleted>";
/** Fingerprint for dirty entries that are not regular files (submodules, nested repos, symlinked dirs). */
const NON_FILE_FINGERPRINT = "<non-file>";
/** Fingerprint for paths `git hash-object --stdin-paths` cannot accept (embedded newline). */
const UNHASHABLE_FINGERPRINT = "<unhashable>";
/** Generous cap for `git status` / `hash-object` output on large, noisy trees. */
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Paths that differ from HEAD (modified, added, deleted, renamed, untracked),
 * repo-relative, mapped to a content fingerprint (git blob hash, or
 * `DELETED_FINGERPRINT`). Two snapshots taken around a run let callers tell a
 * file that was actually edited apart from one that was already dirty and
 * merely mentioned in a report. `null` when `cwd` is not inside a git work
 * tree, in which case callers fall back to the scraped list.
 */
export function gitDirtySnapshot(cwd: string): Map<string, string> | null {
	// `git status` reports paths relative to the repository root, not `cwd`, so
	// resolve the root once for the filesystem checks below.
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 10_000 });
	if (top.status !== 0) return null;
	const root = top.stdout.trim();
	if (!root) return null;
	const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
		cwd: root,
		encoding: "utf-8",
		timeout: 10_000,
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	if (status.status !== 0) return null;
	const paths: string[] = [];
	const entries = status.stdout.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		// "XY path"; renames emit destination and source as adjacent records.
		// Keep the source as a deleted baseline path: committing a rename that
		// was already staged before the run must not count as new work.
		paths.push(entry.slice(3));
		if (entry[0] === "R" || entry[1] === "R") {
			const source = entries[++i];
			if (source) paths.push(source);
		} else if (entry[0] === "C" || entry[1] === "C") i++;
	}
	const out = new Map<string, string>();
	const present: string[] = [];
	for (const p of paths) {
		let st: ReturnType<typeof lstatSync> | null = null;
		try {
			st = lstatSync(join(root, p));
		} catch {
			st = null;
		}
		if (!st) out.set(p, DELETED_FINGERPRINT);
		// `hash-object` refuses directories (submodules, nested repos) and would
		// abort the whole batch; fingerprint them by kind instead of content.
		else if (!st.isFile()) out.set(p, NON_FILE_FINGERPRINT);
		// `--stdin-paths` is newline-delimited and has no -z form.
		else if (p.includes("\n")) out.set(p, UNHASHABLE_FINGERPRINT);
		else present.push(p);
	}
	if (present.length > 0) {
		const hashed = spawnSync("git", ["hash-object", "--stdin-paths"], {
			cwd: root,
			encoding: "utf-8",
			input: `${present.join("\n")}\n`,
			timeout: 30_000,
			maxBuffer: GIT_OUTPUT_MAX_BUFFER,
		});
		if (hashed.status !== 0) return null;
		const hashes = hashed.stdout.trim().split("\n");
		if (hashes.length !== present.length) return null;
		present.forEach((p, idx) => out.set(p, hashes[idx]));
	}
	return out;
}

/**
 * Decide which files a lead phase actually changed. A path counts when it is
 * dirty after the run and either was clean before or has different content
 * now. `claimed` (paths scraped from lead prose) is only used when git
 * snapshots are unavailable, and to report phantoms — files the lead named
 * but did not touch. Note a pre-dirty file the lead reverts to HEAD drops out
 * of `after` and is therefore not reported as changed.
 */
export function diffDirtySnapshots(
	before: Map<string, string> | null,
	after: Map<string, string> | null,
	claimed: Iterable<string>,
): { changed: string[]; phantom: string[] } {
	const claimedSet = new Set(claimed);
	if (!before || !after) return { changed: [...claimedSet], phantom: [] };
	const changed: string[] = [];
	for (const [path, fingerprint] of after) {
		if (before.get(path) !== fingerprint) changed.push(path);
	}
	const changedSet = new Set(changed);
	const phantom = [...claimedSet].filter((f) => !changedSet.has(f));
	return { changed, phantom };
}

/** Starting HEAD for a run; an unborn/non-Git repository has no commit history to compare. */
export function gitHead(cwd: string): string | null {
	const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd, encoding: "utf-8", timeout: 10_000,
	});
	if (result.status === 0 && /^[0-9a-f]{40,64}$/.test(result.stdout.trim())) return result.stdout.trim();
	// An unborn branch has no HEAD yet, but its first commit must still count.
	const ref = spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd, encoding: "utf-8", timeout: 10_000 });
	if (ref.status !== 0 || !ref.stdout.trim()) return null;
	const exists = spawnSync("git", ["show-ref", "--verify", "--quiet", ref.stdout.trim()], { cwd, timeout: 10_000 });
	if (exists.status !== 1) return null;
	const empty = spawnSync("git", ["hash-object", "-t", "tree", "--stdin"], {
		cwd, encoding: "utf-8", input: "", timeout: 10_000,
	});
	return empty.status === 0 && /^[0-9a-f]{40,64}$/.test(empty.stdout.trim()) ? empty.stdout.trim() : null;
}

/** Current worktree content for a path that was already dirty when the run began. */
function currentFingerprint(root: string, path: string): string | null {
	let st: ReturnType<typeof lstatSync>;
	try { st = lstatSync(join(root, path)); } catch { return DELETED_FINGERPRINT; }
	if (!st.isFile()) return NON_FILE_FINGERPRINT;
	if (path.includes("\n")) return UNHASHABLE_FINGERPRINT;
	const hashed = spawnSync("git", ["hash-object", "--stdin-paths"], {
		cwd: root, encoding: "utf-8", input: `${path}\n`, timeout: 30_000, maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	return hashed.status === 0 && /^[0-9a-f]{40,64}$/.test(hashed.stdout.trim()) ? hashed.stdout.trim() : null;
}

/** Union changes committed during the run with edits that remain dirty at verification time. */
export function changedFilesSinceRunStart(
	cwd: string,
	startHead: string | null,
	beforeDirty: Map<string, string> | null,
	claimed: Iterable<string>,
	afterDirty = gitDirtySnapshot(cwd),
): { changed: string[]; phantom: string[]; historyUnavailable?: boolean } {
	const claimedSet = new Set(claimed);
	const dirty = diffDirtySnapshots(beforeDirty, afterDirty, claimedSet);
	const changed = new Set(dirty.changed);
	if (!startHead && beforeDirty && afterDirty) {
		return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
	}
	if (startHead) {
		const history = spawnSync("git", ["diff", "--name-only", "--no-renames", "-z", startHead, "HEAD"], {
			cwd, encoding: "utf-8", timeout: 30_000, maxBuffer: GIT_OUTPUT_MAX_BUFFER,
		});
		if (history.status !== 0) {
			// History was rewritten or Git failed: use the reported paths rather than
			// falsely treating an implementation run as report-only.
			return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
		}
		const paths = history.stdout.split("\0").filter(Boolean);
		if (beforeDirty && paths.some((path) => beforeDirty.has(path))) {
			const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 10_000 });
			if (top.status !== 0 || !top.stdout.trim()) {
				return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
			}
			for (const path of paths) {
				const original = beforeDirty.get(path);
				if (original !== undefined) {
					const current = currentFingerprint(top.stdout.trim(), path);
					if (current === null) {
						return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
					}
					if (original === current) continue;
				}
				changed.add(path);
			}
		} else {
			for (const path of paths) changed.add(path);
		}
	}
	return {
		changed: [...changed],
		phantom: [...claimedSet].filter((path) => !changed.has(path)),
	};
}

function parseFilesChanged(text: string): string[] {
	const files: string[] = [];
	const re = /`([^`]+\.[a-zA-Z0-9]+)`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const f = m[1];
		if (!files.includes(f) && looksLikeFilePath(f)) files.push(f);
	}
	return files;
}

function looksLikeFilePath(s: string): boolean {
	return (
		s.startsWith("/") ||
		s.startsWith("~") ||
		/^[a-zA-Z0-9_./\\-]+\.(ts|tsx|js|jsx|py|md|json|yaml|yml|toml|rs|go|java|kt|swift|css|scss|html|sh|sql)$/.test(
			s,
		)
	);
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

/** HT thinking level -> method.json effort vocabulary (minimal|low|standard|high|maximum). */
export function methodEffortFor(thinking: string | undefined): string {
	if (thinking === undefined) return "standard"; // unset defaults to standard
	return METHOD.effort_aliases[thinking] ?? "standard";
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
	await captureDispatchCost({ ...captureOpts, planId }, qaResult);

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
		ACTIVE_RUN?.setPhase(
			`architect planning on ${shortName(adapter.architect?.model ?? "?")} (complexity ${plan.complexity} ≥ 5)`,
		);
		[architectResult] = await dispatchParallel(
			cwd,
			runId,
			[
				{
					capability: "architect",
					task: architectPrompt(goal, plan),
					taskId: `${runId}-architect`,
				},
			],
			adapter,
			ctx,
		);
		await captureDispatchCost(
			{ runId, planId, taskClass: plan.task_class, complexity: plan.complexity,
			  risk: plan.risk, recommended: plan.route.recommended, mode: plan.route.mode },
			architectResult,
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
			ACTIVE_RUN?.setPhase(
				`architect done in ${fmtElapsed(architectResult.durationMs)} ($${architectResult.costUsd.toFixed(4)}) — ${architectResult.stdout.split("\n").filter((l) => /^\s*\d+[.)]/.test(l)).length} tasks planned`,
			);
		}
	}

	const captureOpts: CaptureOpts = {
		runId, planId, taskClass: plan.task_class, complexity: plan.complexity,
		risk: plan.risk, recommended: plan.route.recommended, mode: plan.route.mode,
	};
	const results = await dispatchReconAndLeads({ runId, goal, plan, adapter, architectResult, leadCapability }, {
		dispatch: (tasks) => dispatchParallel(cwd, runId, tasks, adapter, ctx),
		capture: (result) => captureDispatchCost(captureOpts, result),
		setPhase: (phase) => ACTIVE_RUN?.setPhase(phase),
		throwIfCancelled: () => ACTIVE_RUN?.cancellation.throwIfCancelled(),
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
	const requestedLeadCount = effectiveLeadCount(plan);

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

/** An architect is worth spawning at the same complexity where method.json Rule 2 mandates recon. */
function complexityNeedsArchitect(complexity: number): boolean {
	return complexity >= METHOD.rules.pre_implementation_recon.min_complexity;
}

export function architectPrompt(goal: string, plan: PlanResponse): string {
	return [
		`You are the architect for this orchestration. Produce a concrete task plan.`,
		"",
		`Goal: ${goal}`,
		`Task class: ${plan.task_class}`,
		`Complexity: ${plan.complexity}`,
		`Risk: ${plan.risk}`,
		`Topology: ${plan.topology.shape} (depth=${plan.topology.depth}, leads=${plan.topology.leads}, workers=${plan.topology.workers})`,
		`Recommended capability: ${plan.route.recommended.capability} @ ${plan.route.recommended.effort}`,
		`Quality floor: ${plan.effective_quality_floor}`,
		"",
		"Output:",
		"## Tasks",
		"One numbered task per line, each with: capability (technical_lead | implementation_strong | implementation_fast | qa_agent | technical_review | security_review), a one-line description, and acceptance criteria.",
		"",
		"## Dependencies",
		"Which tasks block which.",
		"",
		...leadAssignmentInstructions(plan),
		"## Done When",
		"Observable end-state.",
	].join("\n");
}

/** Clamp the planner's lead count the same way dispatchReconAndLeads does. */
/** Keeps QA on this run's files and stops it from debugging the environment. */
export const QA_SCOPE_RULES = [
	"Scope: verify ONLY the files listed above and the tests that cover them. Do not read or judge other files, even if they look modified.",
	"Environment: use the project's documented test commands. If they cannot run after 2 attempts (missing interpreter, dependency, or service), stop and report FAIL with check name `environment` and the exact error; do not try alternative interpreters or install anything.",
];

function effectiveLeadCount(plan: PlanResponse): number {
	const { leads } = plan.topology;
	return Number.isFinite(leads) ? Math.min(MAX_LEADS, Math.max(1, Math.trunc(leads))) : 1;
}

function leadAssignmentInstructions(plan: PlanResponse): string[] {
	const n = effectiveLeadCount(plan);
	if (n <= 1) return [];
	return [
		"## Lead assignments",
		`The topology has ${n} leads. Assign each lead a distinct, non-overlapping scope, one line per lead, exactly:`,
		"Lead 1: <scope> (depends on: none)",
		"Lead 2: <scope> (depends on: 1)",
		"A lead that needs another lead's output MUST list it under depends on; dependent leads run after the leads they depend on, never in parallel. If the work cannot be split into independent or clearly ordered scopes, give Lead 1 the whole goal and give the other leads `(depends on: 1)` scopes that only verify or extend it. Without this section the orchestrator runs a single lead.",
		"",
	];
}

/**
 * The model table the lead must forward to HT's `subagent` tool. The subagent
 * tool ignores the `model:` frontmatter in the orch-* persona files and runs
 * every child on the PARENT's model unless the call passes `model` explicitly —
 * so without this block every cheap worker silently ran on the lead's model.
 */
function modelTableForLead(adapter: Adapter): string[] {
	const row = (agent: string, cap: string) =>
		`- ${agent}: model "${adapter[cap]?.model ?? adapter.worker?.model ?? "unknown"}"`;
	return [
		"Model routing (REQUIRED): every `subagent` call MUST pass the `model` field below for the agent it dispatches. The subagent tool does not read the agent's frontmatter; omitting `model` runs the child on your own model and breaks the cost policy.",
		row("orch-scout", "scout"),
		row("orch-worker", "worker"),
		row("orch-implementation-fast", "implementation_fast"),
		row("orch-implementation-strong", "implementation_strong"),
		row("orch-technical-lead", "technical_lead"),
		row("orch-technical-review", "technical_review"),
		row("orch-security-review", "security_review"),
		// No orch-qa-agent row: final QA is the orchestrator's own dispatch, not the lead's.
		row("orch-architect", "architect"),
	];
}

export function leadPrompt(
	goal: string,
	plan: PlanResponse,
	architectResult: DispatchResult | undefined,
	reconEvidence: string,
	leadIndex: number,
	leadCount: number,
	adapter: Adapter,
	assignment?: LeadAssignment,
): string {
	// Only forward a plan the architect actually produced. A failed architect
	// dispatch used to be pasted in as an empty "Architect's plan:" section,
	// which reads to the lead as "the architect decided nothing is needed".
	const architectOutput =
		architectResult && architectResult.exitCode === 0 && architectResult.stdout.trim()
			? `\nArchitect's plan:\n\n${architectResult.stdout.slice(0, 3000)}\n`
			: "";
	const scopeNote =
		leadCount > 1 && assignment
			? [
				`You are lead ${leadIndex + 1} of ${leadCount}. Your scope (from the architect's Lead assignments): ${assignment.scope}`,
				assignment.dependsOn.length > 0
					? `Leads ${assignment.dependsOn.map((d) => d + 1).join(", ")} ran before you and completed; build on their work, do not redo it.`
					: "No other lead's work is a precondition for your scope.",
				"Do only your scope; other leads own the rest.",
			].join("\n")
			: leadCount > 1
				? `You are lead ${leadIndex + 1} of ${leadCount}. Focus on your assigned sub-domain; other leads handle parallel sub-domains.`
				: "You are the sole lead for this orchestration.";
	// The orchestrator already dispatched and billed the required Rule-2 recon
	// workers before this lead ever started (see dispatchHierarchical). State
	// that plainly, whether evidence exists or not, instead of letting the lead
	// assume no recon happened just because this section is silent.
	const reconSection = [
		"Recon evidence (already gathered by dedicated parent-owned recon workers the orchestrator dispatched and billed before you started; treat it as ground truth for this run):",
		"",
		reconEvidence || "(none: this task's complexity/task class does not require parent-owned recon)",
		"",
		"Do not repeat broad repository discovery already covered by the recon evidence above. You may still use your own tools to verify a specific, material uncertainty before acting.",
	].join("\n");
	return [
		`You are the orchestrator lead for the following goal. Drive it to completion.`,
		"",
		`Goal: ${goal}`,
		`Task class: ${plan.task_class} | Complexity: ${plan.complexity} | Risk: ${plan.risk}`,
		`Quality floor: ${plan.effective_quality_floor}`,
		`Recommended capability: ${plan.route.recommended.capability} @ ${plan.route.recommended.effort}`,
		`Topology: ${plan.topology.shape} (depth=${plan.topology.depth}, leads=${plan.topology.leads}, workers=${plan.topology.workers})`,
		"",
		scopeNote,
		architectOutput,
		"",
		reconSection,
		"",
		"You are running non-interactively: there is no human to answer questions mid-run. If the goal is ambiguous, make the conservative choice, do the unambiguous part, and list every open question under '## Open items' in your final report instead of stopping to ask.",
		"",
		LEAD_DELEGATION_RULE,
		"",
		"Use the subagent tool for implementation and review work. Nested subagent calls you make run inside your own context: the orchestrator bridge bills their reported cost to your dispatch and counts it toward your spend cap, but does not log them as dispatches the way it does the parent-owned recon above, so they are not authoritative worker accounting for this run — only your own final report is. For each nested dispatch:",
		"- Choose the right agent (orch-worker, orch-implementation-strong, orch-implementation-fast, orch-technical-review, orch-security-review).",
		"- Pass a narrowly-scoped task prompt.",
		"- Pass the `model` for that agent from the routing table below.",
		"- After implementation, run the targeted verification commands for each task yourself (read-only). Do not dispatch orch-qa-agent: the orchestrator runs independent QA on the union of changed files after you finish. If your verification or a review fails, escalate per method.json rules.review_after_fix (Rule 1).",
		"",
		...modelTableForLead(adapter),
		"",
		LEAD_STATUS_CONTRACT,
	].join("\n");
}

/** Leads cannot edit (persona tools exclude write/edit); this states it in the prompt too. */
export const LEAD_DELEGATION_RULE =
	"Delegation rule: you do not have write or edit tools. All source changes go to orch-implementation-strong or orch-implementation-fast through the subagent tool. Do not modify files through bash redirection, sed -i, heredocs, patch tools, or scripts. You may run read-only and verification commands.";

/** Machine-readable last line every lead report must end with (parsed by parseLeadStatus). */
export const LEAD_STATUS_CONTRACT =
	"End your final report with exactly one line `STATUS: completed`, `STATUS: partial`, or `STATUS: blocked` (blocked = you stopped before changing anything because a stop condition or precondition failed).";

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
 */
async function checkModels(ctx: ExtensionContext, resolved: ResolvedAdapter): Promise<boolean> {
	if (ACTIVE_RUN) {
		ctx.ui.notify(`An orchestration is already running (${ACTIVE_RUN.runId}); try again when it finishes.`, "warning");
		return false;
	}
	const byModel = new Map<string, string[]>();
	for (const [cap, b] of Object.entries(resolved.adapter)) {
		byModel.set(b.model, [...(byModel.get(b.model) ?? []), cap]);
	}
	const session = new RunSession(`model-check-${Date.now()}`, ctx, "model check");
	ACTIVE_RUN = session;
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
			ACTIVE_RUN = null;
			session.finish();
		}
	}
}

const USAGE =
	"Usage: /orchestrate <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical]\n" +
	"       [--profile NAME] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--frontier ALIAS] [--model <capability>=ALIAS] [--effort LEVEL]\n" +
	"       [--quality-floor F] [--cost-aggressiveness C] [--max-retries R] [--interactive]\n" +
	"ALIAS is a short name (fable-5-1, opus-5-5, sonnet-5, gpt-6-sol, gpt-6-luna, astra) or provider/model. Profiles: " + PROFILES_PATH + "  (see /orchestrator-models)";

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
	reapOrphanedPersonaDirs();
	installDispatchReaper();
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
			if (ACTIVE_RUN) {
				ctx.ui.notify(
					`An orchestration is already running (${ACTIVE_RUN.runId}). Wait for it to finish; its log is ${ACTIVE_RUN.file("run.log")}.`,
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
			// already claimed ACTIVE_RUN by the time we get here. Losing this race must not let two
			// sessions both believe they own ACTIVE_RUN, so re-check immediately before the write.
			if (getActiveRun()) {
				ctx.ui.notify(
					`An orchestration is already running (${ACTIVE_RUN!.runId}). Wait for it to finish; its log is ${ACTIVE_RUN!.file("run.log")}.`,
					"warning",
				);
				session.close();
				await session.sealDiagnostics();
				session.finish();
				return;
			}
			ACTIVE_RUN = session;
			CURRENT_RUN_TAGS = { profile: resolved.profileName, policy_id: policyIdFor(resolved.profileName, adapter) };
			CURRENT_ALIAS_TABLE = resolved.table;
			session.log(`policy: ${CURRENT_RUN_TAGS.policy_id}`);
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
					triageResult = await triageTask(runId, parsed.goal, cwd, ctx, triageCost, adapter);
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
				CURRENT_RUN_TAGS.lead_size = leadDecision.size;
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
							CURRENT_RUN_TAGS.lead_size = escalatedSize;
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
						);
						// Capture settled usage before cancellation unwinds this round, just
						// as the architect, lead and QA paths do.
						// dispatchParallel returns [] for an empty task list; billing an
						// absent result wrote an all-"unknown" model_call for a dispatch
						// that never happened.
						if (retryResult) {
							await captureDispatchCost(captureOpts, retryResult);
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

				const verdict = runOutcome === "blocked"
					? "NOT RUN (blocked: every lead stopped at a stop condition or precondition)"
					: !dispatchOk
					? "NOT RUN (no lead succeeded)"
					: verificationSkipped
						? allFiles.length === 0
							? "N/A (no files changed — report-only goal)"
							: "SKIPPED (no files changed)"
						: passedVerification
							? "PASS"
							: "FAIL";

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
					// A newer race winner may already have replaced ACTIVE_RUN with its own session
					// (see the re-check guard above); only clear the run-scoped singletons when they
					// still belong to this run, so a stale run's finally never nulls out a newer one.
					if (ACTIVE_RUN === session) {
						ACTIVE_RUN = null;
						CURRENT_RUN_TAGS = {};
						CURRENT_ALIAS_TABLE = null;
					}
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
			if (!ACTIVE_RUN) {
				ctx.ui.notify("no active run", "info");
				return;
			}
			const runId = ACTIVE_RUN.runId;
			ACTIVE_RUN.cancel("user");
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

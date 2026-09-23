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

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
// TypeBox 1.x: `Type` is a namespace (`Type.Object`, `Type.Array`, ...);
// the validation function moved to a separate `typebox/value` module.
import { Type } from "typebox";

import {
	discoverAgents,
	BorderedLoader,
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
	migrateAdapterToProfile,
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
	TIERS,
	tiersToBindings,
	userLayerWarnings,
} from "./models.ts";
import { ingestArgs, SessionIngestScheduler } from "./ingest.ts";
import { BoundedCapture, classifyDispatchOutcome, summarizeStderr, trimEventForLog } from "./dispatch-outcome.ts";
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
import { connectCancellationLoader, applyObservation, applyWarnings, createProgressView, formatNestedWorkerRows, formatProgressLine, formatWarningLine } from "./run-ui.ts";
import type { DispatchProgressView } from "./run-ui.ts";
import type { ProgressObservation, TimeoutCheck } from "./dispatch-progress.ts";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const SKILL_ROOT =
	process.env.HUMAIN_ORCHESTRATOR_SKILL_ROOT ??
	"~/.local/share/agent-skills/hierarchical-agent-orchestrator";
const STATE_ROOT =
	process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT ??
	"~/.local/state/coding-agent-orchestrator";
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
		appendFileSync(eventsLog, `${JSON.stringify(trimEventForLog(event))}\n`);
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
			ACTIVE_RUN?.cancel();
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
 * Capability -> concrete model + optional effort override. This IS the runtime
 * binding that turns the orchestrator's abstract capability requests into HT
 * subagent model picks. Mirrors the measured-savings pattern in
 * `policy_overlay.json.history.measured_performance`:
 *
 *   - implementation_strong -> sonnet-5 (kept 100% pass rate)
 *   - technical_review      -> sonnet-4-5 (saved $67.38 vs sonnet-flat)
 *   - security_review       -> opus-4-5 (policy Rule 1: high/critical -> opus)
 *   - implementation_fast   -> haiku-4-5 (cheapest sufficient)
 *
 * Override via `~/.humain-terminal/agent/orchestrator-adapter.json` to swap in
 * your own model picks without editing this file.
 */
const FALLBACK_ADAPTER: Record<string, { model: string; effort?: string }> = {
	architect:            { model: "amazon-bedrock/anthropic.claude-opus-4-5" },
	technical_lead:       { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	implementation_strong:{ model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	implementation_fast:  { model: "amazon-bedrock/anthropic.claude-haiku-4-5" },
	worker:               { model: "amazon-bedrock/anthropic.claude-haiku-4-5" },
	scout:                { model: "amazon-bedrock/anthropic.claude-haiku-4-5" },
	analysis_mid:         { model: "amazon-bedrock/anthropic.claude-sonnet-4-5" },
	analysis_strong:      { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	technical_review:     { model: "amazon-bedrock/anthropic.claude-sonnet-4-5" },
	integration_review:   { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	security_review:      { model: "amazon-bedrock/anthropic.claude-opus-4-5" },
	migration_review:     { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	performance_review:   { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	api_contract_review:  { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	qa_agent:             { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	lead:                 { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
};

const RULE_REVIEW_AFTER_FIX_MIN_TIER = "sonnet";

type Adapter = Record<string, Binding>;

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
	if (existsSync(LEGACY_ADAPTER_PATH)) {
		try {
			const { spec, notes: migrationNotes } = migrateAdapterToProfile(JSON.parse(readFileSync(LEGACY_ADAPTER_PATH, "utf-8")));
			const file: ProfilesFile = { version: 1, active_profile: "default", profiles: { default: spec } };
			writeProfilesFile(file);
			notes.push(`migrated ${LEGACY_ADAPTER_PATH} → ${PROFILES_PATH} (profile "default")${migrationNotes.length ? `: ${migrationNotes.join("; ")}` : ""}`);
			return { file, present: true, problems: [], notes };
		} catch (err) {
			return {
				file: emptyProfilesFile(),
				present: false,
				problems: [`${LEGACY_ADAPTER_PATH} could not be migrated: ${(err as Error).message}`],
				notes,
			};
		}
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

function clampTriage(raw: Partial<TriageResult>): TriageResult | null {
	if (!raw || typeof raw !== "object") return null;
	const task_class = VALID_TASK_CLASSES.includes(raw.task_class ?? "")
		? raw.task_class!
		: "implementation";
	const complexity = Number.isFinite(raw.complexity)
		? Math.max(1, Math.min(10, Math.round(Number(raw.complexity))))
		: 5;
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
	status: "running" | "done" | "failed" | "cancelled";
	/** Nesting depth (0 = top-level dispatch, 1 = child of a lead, …). */
	depth: number;
	progress: DispatchProgressView;
	lastLoggedProgressDetail?: string;
	lastLoggedProgressAt?: number;
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
	// Wall-clock stamp for the ledger and a monotonic origin for elapsed time. `Date.now()`
	// can step (NTP, sleep/wake) mid-run, so the duration written to outcomes must never be
	// derived from two wall-clock reads.
	private readonly startedAtIso = new Date().toISOString();
	private readonly startedMono = performance.now();
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	readonly cancellation = new RunCancellation();
	/** User messages queued while a run is live; drained at the next dispatch boundary. */
	private queuedMessages: Array<{ text: string; queuedAt: number }> = [];
	/** History of message batches we've folded into prompts, so the user can see delivery. */
	private deliveryLog: Array<{ count: number; to: string; ts: number }> = [];

	constructor(runId: string, ctx: ExtensionContext, goal: string, cwd: string = process.cwd()) {
		this.runId = runId;
		this.ctx = ctx;
		this.goal = goal;
		this.dir = join(runsDir(), runId);
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
		this.tickTimer = setInterval(() => this.render(), 1000);
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

	cancel(): void {
		if (this.cancellation.isCancelled) return;
		this.phase = "cancelling";
		this.log("cancellation requested (interrupt)");
		this.cancellation.cancel();
		this.render();
	}

	log(line: string): void {
		const stamped = `${new Date().toISOString()} ${line}`;
		try {
			appendFileSync(this.file("run.log"), `${stamped}\n`);
		} catch {
			/* log dir unavailable; the UI still gets the line */
		}
	}

	setPhase(phase: string, notify = true): void {
		this.phase = phase;
		this.log(`phase: ${phase}`);
		if (notify) this.ctx.ui.notify(`[${fmtElapsed(Date.now() - this.startedAt)}] ${phase}`, "info");
		this.render();
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
					d.costUsd += event.message?.usage?.cost?.total || 0;
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
			`dispatch ${taskId} ${d.status} in ${fmtElapsed(d.endedAt - d.startedAt)} — ${d.turns} turns, ${d.toolCalls} tool calls, $${d.costUsd.toFixed(4)}${note ? ` — ${note}` : ""}`,
		);
		this.render();
	}

	totalCost(): number {
		let c = 0;
		for (const d of this.dispatches.values()) c += d.costUsd;
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
		this.ctx.ui.setStatus(
			"orchestrator",
			`orch ${this.phase} · ${elapsed} · ${running.length} running · ${failed} failed${wtShort} · $${totalCost.toFixed(3)}`,
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
		this.ctx.ui.setWidget("orchestrator", lines);
	}

	private formatRunningRow(d: DispatchProgress, now: number): string {
		const indent = "  ".repeat(1 + d.depth);
		const spin = spinnerFrame(now);
		const model = shortName(d.model).padEnd(20);
		const elapsed = fmtElapsed(now - d.startedAt).padStart(7);
		const turns = `t${d.turns}`.padStart(4);
		const tools = `⚙${d.toolCalls}`.padStart(5);
		const cost = `$${d.costUsd.toFixed(4)}`.padStart(9);
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
		const cost = `$${d.costUsd.toFixed(4)}`.padStart(9);
		// Surface the captured note for failed and cancelled dispatches so the
		// user can see "exit 1", "cancelled by user", or the stderr summary at a
		// glance. For normal completions the ✓ mark already conveys status.
		const note =
			d.status !== "done" && d.lastActivity ? `  ${d.lastActivity}` : "";
		return `${indent}${mark} ${d.label.padEnd(20)}  ${model}  ${elapsed}  ${turns} ${tools}  ${cost}${note}`;
	}

	close(preserveCancelled = false): void {
		if (this.closed) return;
		if (this.tickTimer) clearInterval(this.tickTimer);
		if (this.renderTimer) clearTimeout(this.renderTimer);
		if (preserveCancelled) {
			this.phase = "cancelled";
			this.render();
		} else {
			this.ctx.ui.setWidget("orchestrator", undefined);
			this.ctx.ui.setStatus("orchestrator", undefined);
		}
		this.closed = true;
		this.log(`run ${this.runId} closed after ${fmtElapsed(Date.now() - this.startedAt)}`);
	}

	cancelledDispatches(): string[] {
		return [...this.dispatches.values()].filter((d) => d.status === "cancelled").map((d) => d.label);
	}
}


/** Sentinel agent name: spawn with HT's default system prompt, no persona file. */
const NO_PERSONA = "__no_persona__";

/** The run currently owning the UI. Only one /orchestrate may be live per session. */
let ACTIVE_RUN: RunSession | null = null;

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
	const eventsLog = session ? session.file(`${safeTaskId}.events.jsonl`) : undefined;
	const stderrLog = session ? session.file(`${safeTaskId}.stderr.log`) : undefined;
	if (session) {
		try {
			writeFileSync(session.file(`${safeTaskId}.prompt.md`), opts.task);
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
			const stderr = stderrCapture.text();
			const stderrSummary = summarizeStderr(stderr);
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
			if (stderrLog) {
				try {
					const logText = outcome.status === "completed_after_process_error"
						? `[orchestrator] child produced a terminal result (agent_settled, stopReason=stop) then exited ${processExitCode}; result kept.\n${stderr}`
						: stderr;
					writeFileSync(stderrLog, logText);
				} catch {
					/* best-effort */
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
				usage.cost += msg.usage.cost?.total || 0;
				usage.contextTokens = msg.usage.totalTokens || usage.contextTokens;
			}
			if (msg.stopReason) stopReason = msg.stopReason;
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
		};

		const processLine = (line: string) => {
			if (settled) return;
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				// Unparseable protocol lines are dropped: they cannot safely be JSONL.
				return;
			}
			appendTrimmedEventLog(eventsLog, event);
			const now = Date.now();
			const observation = progressTracker?.observe(event, now);
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
			proc = spawnChild(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env,
				// Make the child a process-group leader so a timeout can kill the
				// whole tree. A dispatched lead spawns its own subagents, and
				// SIGKILL on the direct pid alone leaves those grandchildren
				// orphaned, still running, and still billing with nothing reading
				// their output. We never unref(), so we still await this child.
				detached: true,
			});
		} catch (err) {
			spawnFailed = true;
			stderrCapture.append(`\n[orchestrator] spawn threw: ${(err as Error).message}`);
			finish(1);
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
			if (settled) return;
			timedOut = true;
			timeoutReason = reason;
			const explanation = progressTracker?.describeExpiry(reason, opts.capability, Date.now()) ?? reason;
			stderrCapture.append(`\n[orchestrator] ${reason} timeout: ${explanation}`);
			const report = recordInterruption(reason === "inactivity" ? "inactivity_timeout" : "absolute_timeout");
			session?.log(report);
			if (proc) killProcessTree(proc);
			finish(124);
		};

		removeCancellationListener = session?.cancellation.onCancel(() => {
			if (proc && !settled) {
				cancelledByListener = true;
				recordInterruption("cancelled");
				killProcessTree(proc);
				finish(137);
			}
		});

		armTimer = () => {
			if (settled || !progressTracker) return;
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
				if (settled || !progressTracker) return;
				const tickNow = Date.now();
				const tickCheck = progressTracker.check(tickNow);
				session?.recordProgress(taskId, { kind: "heartbeat", detail: "timer" }, tickCheck, tickNow);
				for (const warning of tickCheck.warnings) stderrCapture.append(`\n${warning.text}`);
				if (tickCheck.expired) handleExpiry(tickCheck.expired);
				else armTimer();
			}, delay);
		};
		// A cancellation that fired synchronously above has already settled the
		// dispatch; never arm a timer after settle. Do NOT return early here: the
		// stream/error handlers below must still attach so a late 'error' emit on
		// the child cannot become an uncaught exception.
		if (isLead) {
			armTimer();
		} else if (!settled) {
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
			stderrCapture.append(data.toString());
		});

		proc.on("close", (code) => {
			guardChildStreamHandler("stdout", () => {
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			}, streamFailure);
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
 * `costSink` accumulates what triage spent. Triage is logged under its own
 * synthetic run id (it happens before the real run exists), so without this the
 * command's reported total silently excluded it.
 */
async function triageTask(
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
		if (!r || r.exitCode !== 0) {
			if (r) {
				// Surface WHY, instead of the bare "Triage unavailable" the command
				// used to print. A non-zero exit here is almost always an argv or
				// provider-auth problem, and stderr names it.
				console.warn(
					`[orchestrator] triage exited ${r.exitCode}: ${summarizeStderr(r.stderr || r.rawStdout, 400) || "(no output)"}`,
				);
				await captureDispatchCost(
					{
						runId: `triage-${Date.now()}`,
						planId: "triage",
						taskClass: "triage",
						complexity: 5,
						risk: "medium",
						recommended: {
							capability: "implementation_fast",
							effort: "low",
							verification_depth: "none",
						},
						mode: "triage",
					},
					{
						taskId: `triage-${slugGoal(goal)}`,
						capability: "implementation_fast",
						model: r.model ?? cheapest.model,
						exitCode: r.exitCode,
						stdout: r.stdout,
						stderr: r.stderr,
						usage: r.usage,
						durationMs: r.durationMs,
						costUsd: r.costUsd,
						stopReason: r.stopReason,
						filesChanged: [],
					},
				);
			}
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

		// Cost-attribution: triage is an interactive_session call, but logged
		// under task_class="triage" so it\'s auditable separately from the
		// run itself. The orchestrator\'s ledger picks it up the same way as
		// any other dispatch through captureDispatchCost.
		await captureDispatchCost(
			{
				runId: `triage-${Date.now()}`,
				planId: "triage",
				taskClass: "triage",
				complexity: clamped.complexity,
				risk: clamped.risk,
				recommended: {
					capability: "implementation_fast",
					effort: "low",
					verification_depth: "none",
				},
				mode: "triage",
			},
			{
				taskId: `triage-${slugGoal(goal)}`,
				capability: "implementation_fast",
				model: r.model ?? cheapest.model,
				exitCode: r.exitCode,
				stdout: text,
				stderr: r.stderr,
				usage: r.usage,
				durationMs: r.durationMs,
				costUsd: r.costUsd,
				stopReason: r.stopReason,
				filesChanged: [],
			},
		);
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
 * package is importable, and CODING_AGENT_ORCHESTRATOR_HOME so Python
 * ingestion and the TypeScript hook reporting layer write to the same state
 * root even when HUMAIN_ORCHESTRATOR_STATE_ROOT is customized.
 */
export function runModule(module: string, args: string[] = []): Promise<CliResult> {
	return new Promise((resolve) => {
		const expandedSkillRoot = SKILL_ROOT.replace(/^~/, homedir());
		const expandedStateRoot = STATE_ROOT.replace(/^~/, homedir());
		const child = spawn(PYTHON, ["-m", module, ...args], {
			env: {
				...process.env,
				CODING_AGENT_RUNTIME: "humain-terminal",
				CODING_AGENT_REPOSITORY: process.env.CODING_AGENT_REPOSITORY ?? process.cwd(),
				PYTHONPATH: expandedSkillRoot,
				CODING_AGENT_ORCHESTRATOR_HOME: expandedStateRoot,
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

async function recordEvent(event: string, payload: Record<string, unknown>): Promise<void> {
	const res = await runModule("orchestrator.cli", ["event", event, JSON.stringify(payload)]);
	if (res.exitCode !== 0) {
		console.warn(`[orchestrator] event write failed: ${res.stderr}`);
	}
}

async function recordModelCall(metric: Record<string, unknown>): Promise<void> {
	const res = await runModule("orchestrator.cli", ["metric", JSON.stringify(metric)]);
	if (res.exitCode !== 0) {
		console.warn(`[orchestrator] metric write failed: ${res.stderr}`);
	}
}

async function recordOutcome(outcome: Record<string, unknown>): Promise<void> {
	const res = await runModule("orchestrator.cli", ["outcome", JSON.stringify(outcome)]);
	if (res.exitCode !== 0) {
		console.warn(`[orchestrator] outcome write failed: ${res.stderr}`);
	}
}

/** Terminal-boundary time fields written to the run outcome row. */
export interface RunTiming {
	started_at: string;
	finished_at: string;
	elapsed_ms: number;
	elapsed_source: "monotonic";
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
		outcome: summary.verification_passed === false ? "fail" : "verified",
		verification_scope: "run",
		quality: summary.success_rate ?? 0,
		note: JSON.stringify(summary),
	};
}

async function completeRun(runId: string, summary: Record<string, unknown>, timing?: RunTiming): Promise<void> {
	await recordOutcome({ ...runCompletionOutcomeFor(runId, summary), ...timing });
}

async function failRun(runId: string, error: string, timing?: RunTiming): Promise<void> {
	await recordOutcome({
		run_id: runId,
		task_id: "run-failed",
		outcome: "fail",
		verification_scope: "run",
		quality: 0,
		note: error,
		...timing,
	});
}

// -----------------------------------------------------------------------------
// Subagent dispatch
// -----------------------------------------------------------------------------

interface DispatchTask {
	capability: string;
	task: string;
	taskId: string;
	retryOf?: string;
	retryCount?: number;
}

interface DispatchResult {
	taskId: string;
	capability: string;
	model: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	usage: SubagentSingleResult["usage"];
	durationMs: number;
	costUsd: number;
	stopReason?: string;
	outcome?: SubagentProcessResult["outcome"];
	timeoutReason?: "inactivity" | "absolute";
	interruption?: InterruptionReport;
	filesChanged: string[];
}

async function dispatchParallel(
	cwd: string,
	runId: string,
	tasks: DispatchTask[],
	adapter: Adapter,
	ctx: ExtensionContext,
	depth: number = 0,
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
		await recordEvent("dispatch_started", {
			run_id: runId,
			task_id: input._taskId,
			capability: input._capability,
			agent: input.agent,
			model: input.model,
			retry_of: input._retryOf,
		});
		try {
			const r = await runSubagentProcess({
				cwd: input.cwd,
				agentName: input.agent,
				task: input.task,
				model: input.model,
				effort: input.effort,
				taskId: input._taskId,
				label: shortId,
				capability: input._capability,
				depth,
				// Deliberately no `tools` override: each orch-* persona declares its
				// own allow-list in frontmatter, and those lists encode policy
				// (reviewers and scouts are read-only). Hardcoding a set here both
				// granted reviewers write access and dropped tools the personas need.
				ctx,
			});
			await recordEvent("dispatch_finished", {
				run_id: runId,
				task_id: input._taskId,
				capability: input._capability,
				model: r.model ?? input.model,
				exit_code: r.exitCode,
				duration_ms: r.durationMs,
				cost_usd: r.costUsd,
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
				stopReason: r.stopReason,
				outcome: r.outcome,
				timeoutReason: r.timeoutReason,
				interruption: r.interruption,
				// parseFilesChanged scrapes the child's prose, so a read-only reviewer
				// or QA agent would "report" every path it merely mentioned.
				filesChanged: r.personaCanMutate ? parseFilesChanged(r.stdout) : [],
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
	lead: "orchestrator-lead",
	analysis_mid: "orch-technical-lead",
	analysis_strong: "orch-architect",
	integration_review: "orch-technical-review",
	migration_review: "orch-technical-review",
	performance_review: "orch-technical-review",
	api_contract_review: "orch-technical-review",
};

function agentNameFor(capability: string): string {
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

	const modelName = base.includes("/") ? base.split("/")[1] : base;
	const current = classifyTier(modelName);
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

function classifyTier(modelName: string): "cheap" | "mid" | "premium" | "unknown" {
	const n = modelName.toLowerCase();
	// Order matters — check premium before mid because "opus" and "kimi-k3" are
	// unambiguous; "pro" / "ultra" can appear in mid-tier families too, so
	// those checks are conservative.
	if (/\bopus\b|\bkimi-k3\b|\bultra\b/.test(n)) return "premium";
	if (/\bsonnet\b|\bglm\b|\bmistral\b|\bcommand\b|\bjamba\b|\bflash\b/.test(n)) return "mid";
	if (/\bhaiku\b|\bluna\b|\bmini\b|\bnano\b|\blite\b/.test(n)) return "cheap";
	return "unknown";
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
	const candidates = [
		preferredCapability,
		"implementation_strong",
		"technical_review",
		"security_review",
		"analysis_mid",
		"analysis_strong",
		"architect",
		"worker",
	];
	for (const cap of candidates) {
		const binding = adapter[cap];
		if (!binding || !binding.model) continue;
		const name = binding.model.includes("/") ? binding.model.split("/")[1] : binding.model;
		if (classifyTier(name) === tier) return binding.model;
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
		await recordModelCall(record);
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
	const hasReportedCost = (result?.costUsd ?? 0) > 0;
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
		effort: "standard",
		verification_depth: "targeted",
		input_tokens: usage.input ?? 0,
		cached_input_tokens: usage.cacheRead ?? 0,
		cache_write_tokens: usage.cacheWrite ?? 0,
		output_tokens: usage.output ?? 0,
		cost_usd: result?.costUsd ?? 0,
		cost_source: hasReportedCost ? "reported" : "estimated-from-reported-tokens",
		duration_ms: result?.durationMs ?? 0,
		result: result?.exitCode === 0 ? "pass" : "fail",
		stop_reason: result?.stopReason,
		files_changed: result?.filesChanged ?? [],
		plan_id: opts.planId,
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
		executed_effort: "standard",
		executed_verification_depth: "targeted",
		executed_cost_usd: result?.costUsd ?? 0,
		executed_input_tokens: usage.input ?? 0,
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
	}];

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

	await recordOutcome(qaVerificationOutcomeFor(runId, passed, passed ? 0.95 : 0.0, out.slice(0, 2000)));

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

/**
 * Decide how to escalate a failed verification. Returns a list of new
 * DispatchTask entries to add to the next pass, or empty if we're done.
 *
 * The model for each retry is chosen by pickModel, which applies method.json
 * Rule 1 (`rules.review_after_fix`) for the run's risk.
 */
function planEscalation(
	failedChecks: string[],
	originalTasks: DispatchTask[],
	complexity: number,
	risk: string,
	retryCount: number,
): DispatchTask[] {
	if (retryCount >= 2) return []; // stop-loss
	if (failedChecks.length === 0) return [];

	const isHighRisk = risk === "high" || risk === "critical";

	// For verification failures, we re-dispatch the original tasks with bumped
	// reviewer tier (handled by pickModel when retryCount > 0). For now we add
	// a single retry task that re-runs verification with more careful scope.
	const target = originalTasks[0];
	if (!target) return [];

	return [
		{
			...target,
			taskId: `${target.taskId}-retry-${retryCount + 1}`,
			retryOf: target.taskId,
			retryCount: retryCount + 1,
			task: [
				target.task,
				"",
				`[Escalation: retry #${retryCount + 1}]`,
				`Previous attempt failed verification with:`,
				...failedChecks.map((c) => `- ${c}`),
				isHighRisk
					? "Risk is high/critical: re-review MUST use opus tier."
					: "Re-review must use sonnet tier minimum.",
			].join("\n"),
		},
	];
}

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
): Promise<{
	leadResults: DispatchResult[];
	workerResults: DispatchResult[];
	/** The architect dispatch, when the topology called for one. Billed by the caller. */
	architectResult?: DispatchResult;
	/** Mutable sink the caller appends escalation dispatches to, so they get billed. */
	escalationResults: DispatchResult[];
}> {
	const { depth, leads, workers, shape } = plan.topology;
	const recCap = plan.route.recommended.capability;
	const recEffort = plan.route.recommended.effort;

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

	// `Math.max(1, leads)` returns NaN when the plan omits `topology.leads` or
	// sends a non-number, and `Array.from({ length: NaN })` is empty — that is
	// how a run reported "leads: 0/0 succeeded" with nothing dispatched. Coerce
	// first, then floor at 1.
	const leadCount = Number.isFinite(leads)
		? Math.min(MAX_LEADS, Math.max(1, Math.trunc(leads)))
		: 1;
	const leadTasks: DispatchTask[] = Array.from({ length: leadCount }, (_, i) => ({
		capability: "lead",
		task: leadPrompt(goal, plan, architectResult, i, leadCount, adapter),
		taskId: `${runId}-lead-${i}`,
	}));

	ACTIVE_RUN?.setPhase(
		`${leadCount} lead(s) executing on ${shortName(adapter.lead?.model ?? "?")} — workers fan out inside each lead`,
	);
	const leadResults = await dispatchParallel(cwd, runId, leadTasks, adapter, ctx);
	for (const r of leadResults) {
		await captureDispatchCost(
			{ runId, planId, taskClass: plan.task_class, complexity: plan.complexity,
			  risk: plan.risk, recommended: plan.route.recommended, mode: plan.route.mode },
			r,
		);
	}

	// Lead agents own their own worker fan-out via HT's subagent tool. We
	// don't see worker results here; they'll land in HT's own session log +
	// subsequently in our cost capture via the architectResult's reports.
	// For depth <= 2, the "lead" dispatch IS the orchestrator-lead and it
	// does its own fan-out inside its own context window.
	return { leadResults, workerResults: [], architectResult, escalationResults: [] };
}

/** An architect is worth spawning at the same complexity where method.json Rule 2 mandates recon. */
function complexityNeedsArchitect(complexity: number): boolean {
	return complexity >= METHOD.rules.pre_implementation_recon.min_complexity;
}

function architectPrompt(goal: string, plan: PlanResponse): string {
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
		"## Done When",
		"Observable end-state.",
	].join("\n");
}

/**
 * The model table the lead must forward to HT's `subagent` tool. The subagent
 * tool ignores the `model:` frontmatter in the orch-* persona files and runs
 * every child on the PARENT's model unless the call passes `model` explicitly —
 * so without this block every "haiku worker" silently ran on the lead's sonnet.
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
		row("orch-qa-agent", "qa_agent"),
		row("orch-architect", "architect"),
	];
}

function leadPrompt(
	goal: string,
	plan: PlanResponse,
	architectResult: DispatchResult | undefined,
	leadIndex: number,
	leadCount: number,
	adapter: Adapter,
): string {
	// Only forward a plan the architect actually produced. A failed architect
	// dispatch used to be pasted in as an empty "Architect's plan:" section,
	// which reads to the lead as "the architect decided nothing is needed".
	const architectOutput =
		architectResult && architectResult.exitCode === 0 && architectResult.stdout.trim()
			? `\nArchitect's plan:\n\n${architectResult.stdout.slice(0, 3000)}\n`
			: "";
	const scopeNote =
		leadCount > 1
			? `You are lead ${leadIndex + 1} of ${leadCount}. Focus on your assigned sub-domain; other leads handle parallel sub-domains.`
			: "You are the sole lead for this orchestration.";
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
		"You are running non-interactively: there is no human to answer questions mid-run. If the goal is ambiguous, make the conservative choice, do the unambiguous part, and list every open question under '## Open items' in your final report instead of stopping to ask.",
		"",
		"Use the subagent tool to dispatch workers. For each dispatch:",
		"- Choose the right agent (orch-worker, orch-implementation-strong, orch-implementation-fast, orch-technical-review, orch-security-review, orch-qa-agent).",
		"- Pass a narrowly-scoped task prompt.",
		"- Pass the `model` for that agent from the routing table below.",
		"- After all workers finish, run QA via orch-qa-agent. If verification fails, escalate per method.json rules.review_after_fix (Rule 1).",
		"",
		...modelTableForLead(adapter),
	].join("\n");
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
	/** Per-tier / per-capability model overrides from --cheap/--mid/--premium/--model. */
	models: ModelOverrides;
	/** Flags we did not recognize — reported instead of silently swallowed. */
	unknownFlags: string[];
}

export function parseArgs(args: string): OrchestrateArgs {
	const tokens = args.trim().split(/\s+/);
	const out: OrchestrateArgs = {
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
	const goalTokens: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const next = tokens[i + 1];
		switch (t) {
			case "--task-class": if (next) { out.taskClass = next; i++; } break;
			case "--complexity": if (next) { out.complexity = Number(next) || 5; i++; } break;
			case "--risk": if (next) { out.risk = next; i++; } break;
			case "--quality-floor": if (next) { out.qualityFloor = Number(next); i++; } break;
			case "--cost-aggressiveness": if (next) { out.costAggressiveness = Number(next); i++; } break;
			case "--fan-out": out.fanOut = true; break;
			case "--max-retries": if (next) { out.maxRetries = Number(next) || 2; i++; } break;
			case "--interactive": out.interactive = true; break;
			// Kept as a no-op for existing scripts: auto-approval is now the default.
			case "--yes": case "-y": break;
			case "--check": case "--live": out.check = true; break;
			case "--profile": if (next) { out.models.profile = next; i++; } break;
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
				if (t.startsWith("--")) out.unknownFlags.push(t);
				else goalTokens.push(t);
				break;
		}
	}
	out.goal = goalTokens.join(" ");
	return out;
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
			...(failed > 0 ? ["", `Fix the failing binding(s) with /orchestrator-models set <capability|tier> <alias>, or pass --premium/--mid/--cheap/--model; /orchestrate would abort on these.`] : []),
			`log: ${session.file("run.log")}`,
		];
		session.log(summary.join("\n"));
		ctx.ui.notify(summary.join("\n"), failed > 0 ? "error" : "info");
		return failed === 0;
	} finally {
		session.close();
		ACTIVE_RUN = null;
	}
}

const USAGE =
	"Usage: /orchestrate <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical]\n" +
	"       [--profile NAME] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--model <capability>=ALIAS] [--effort LEVEL]\n" +
	"       [--quality-floor F] [--cost-aggressiveness C] [--max-retries R] [--interactive]\n" +
	"ALIAS is a short name (fable-5-1, sonnet, haiku, astra, terra) or provider/model. Profiles: " + PROFILES_PATH + "  (see /orchestrator-models)";

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

/** Register only the settled fast path and awaited shutdown flush. */
export function registerSessionIngestHooks(
	host: Pick<ExtensionAPI, "on">,
	scheduler: Pick<SessionIngestScheduler, "schedule" | "flush">,
): void {
	host.on("agent_settled", async (_event, ctx) => {
		scheduler.schedule(ctx.sessionManager.getSessionFile());
	});
	host.on("session_shutdown", async (_event, ctx) => {
		await scheduler.flush(ctx.sessionManager.getSessionFile());
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
	const scheduler = new SessionIngestScheduler({
		onError: (message) => {
			logError(message);
			recordHookFailure(stateRoot, message);
		},
		run: async (sessionFile) => {
			const res = await runModule("orchestrator.cli", ingestArgs(sessionFile));
			if (res.exitCode === 0) return { ok: true };
			return { ok: false, detail: `exit ${res.exitCode}: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}` };
		},
	});
	registerSessionIngestHooks(pi, scheduler);
}

export default function (pi: ExtensionAPI) {
	reapOrphanedPersonaDirs();
	installDispatchReaper();
	installSessionIngest(pi);

	pi.registerCommand("orchestrate", {
		description:
			"Plan and dispatch a hierarchical agent run. " +
			"Args: <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical] " +
			"[--profile NAME] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--model <capability>=ALIAS] [--effort LEVEL] " +
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
			ACTIVE_RUN = session;
			session.log(`models (profile "${resolved.profileName}"):\n${formatAdapterTable(resolved).map((l) => `  ${l}`).join("\n")}`);
			for (const n of resolved.notes) session.log(`note: ${n}`);
			const cwd = process.cwd();
			let closeTui: (() => void) | undefined;
			let tuiCompletion: Promise<void> | undefined;
			if (ctx.mode === "tui") {
				tuiCompletion = ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Orchestrating — press Esc to cancel");
					closeTui = connectCancellationLoader(loader, () => session.cancel(), () => done());
					return loader;
				});
			}

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
					triageResult = await triageTask(parsed.goal, cwd, ctx, triageCost, adapter);
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
							await failRun(runId, reason, session.terminalTiming());
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
					await failRun(runId, `plan failed: ${(err as Error).message}`, session.terminalTiming());
					ctx.ui.notify(`Plan failed: ${(err as Error).message}`, "error");
					return;
				}

				const needsArchitect = plan.topology.depth >= 2 && complexityNeedsArchitect(plan.complexity);
				const leadCount = Number.isFinite(plan.topology.leads)
					? Math.min(MAX_LEADS, Math.max(1, Math.trunc(plan.topology.leads)))
					: 1;
				const pipeline = [
					...(needsArchitect ? [`architect (${shortName(adapter.architect?.model ?? "?")})`] : []),
					`${leadCount} lead${leadCount > 1 ? "s" : ""} (${shortName(adapter.lead?.model ?? "?")}) → workers (${shortName(adapter.worker?.model ?? "?")})`,
					`qa (${shortName(adapter.qa_agent?.model ?? "?")})`,
				].join(" → ");

				const planSummary = [
					`Plan ${plan.plan_id.slice(0, 12)} — "${parsed.goal.slice(0, 60)}${parsed.goal.length > 60 ? "…" : ""}"`,
					`triage:   ${effectiveTaskClass} / complexity ${effectiveComplexity} / risk ${effectiveRisk}`,
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
					await failRun(runId, reason, session.terminalTiming());
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

				await recordEvent("dispatch_plan_confirmed", {
					run_id: runId,
					plan_id: plan.plan_id,
					models: Object.fromEntries(Object.entries(adapter).map(([k, v]) => [k, v.model])),
					model_sources: resolved.sources,
					profile: resolved.profileName,
					log_dir: session.dir,
				});

				const dirtyBefore = gitDirtySnapshot(cwd);
				const headBefore = gitHead(cwd);
				const { leadResults, architectResult, escalationResults } = await dispatchHierarchical(
					cwd,
					runId,
					plan.plan_id,
					parsed.goal,
					plan,
					adapter,
					ctx,
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

				let retries = 0;
				let lastVerification: VerificationResult | null = null;
				const verificationResults: DispatchResult[] = [];
				while (retries <= parsed.maxRetries) {
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
					const escalationTasks = planEscalation(
						lastVerification.failedChecks,
						leadResults.map((r) => ({
							capability: r.capability,
							task: r.stdout,
							taskId: r.taskId,
						})),
						plan.complexity,
						plan.risk,
						retries,
					);
					if (escalationTasks.length === 0) break;

					// Re-run escalations with bumped models (handled by pickModel when
					// retryCount > 0 via adapter override).
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
						session.cancellation.throwIfCancelled();
						// dispatchParallel returns [] for an empty task list; billing an
						// absent result wrote an all-"unknown" model_call for a dispatch
						// that never happened.
						if (retryResult) {
							await captureDispatchCost(captureOpts, retryResult);
							escalationResults.push(retryResult);
						}
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
					]);
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
				// Total cost must cover EVERY dispatch this run paid for — architect and
				// escalations included. Summing leads alone under-reported spend, which
				// is the one number the cost-optimisation policy is judged on.
				const billedResults = [
					...(architectResult ? [architectResult] : []),
					...leadResults,
					...verificationResults,
					...escalationResults,
				];
				const totalCost =
					triageCost.usd + billedResults.reduce((s, r) => s + r.costUsd, 0);
				const succeededLeads = leadResults.filter((r) => r.exitCode === 0).length;
				// A run that dispatched nothing, or whose every lead failed, has not
				// verified anything — reporting the empty verification suite as PASS is
				// how phantom runs looked green.
				const dispatchOk = leadResults.length > 0 && succeededLeads > 0;
				const verificationSkipped = lastVerification?.skipped ?? false;
				const passedVerification = dispatchOk && (lastVerification?.passed ?? false);

				session.cancellation.throwIfCancelled();
				await completeRun(runId, {
					success_rate: succeededLeads / Math.max(1, leadResults.length),
					verification_passed: passedVerification,
					total_cost_usd: totalCost,
					files_changed: allFiles,
					retries,
					models: Object.fromEntries(Object.entries(adapter).map(([k, v]) => [k, v.model])),
					log_dir: session.dir,
				}, session.terminalTiming());

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
						writeFileSync(session.file("lead-report.md"), leadReports.join("\n\n---\n\n"));
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

				const verdict = !dispatchOk
					? "NOT RUN (no lead succeeded)"
					: verificationSkipped
						? allFiles.length === 0
							? "N/A (no files changed — report-only goal)"
							: "SKIPPED (no files changed)"
						: passedVerification
							? "PASS"
							: "FAIL";

				const summary = [
					`Orchestration ${dispatchOk ? "complete" : "FAILED"} in ${fmtElapsed(Date.now() - Number(runId.split("-")[2]))}.`,
					`run_id: ${runId}`,
					`leads: ${succeededLeads}/${leadResults.length} succeeded · retries: ${retries} · files: ${allFiles.length} changed`,
					`verification: ${verdict}`,
					`total cost: $${totalCost.toFixed(4)} (${billedResults.length + (triageCost.usd > 0 ? 1 : 0)} dispatches)`,
					...(dispatchOk
						? []
						: [
								`first failure: ${
									(billedResults.find((r) => r.exitCode !== 0)?.stderr ?? "(no dispatch attempted)")
										.trim()
										.slice(0, 300) || "(no output)"
								}`,
							]),
					...(reportLines.length > 0
						? ["", showFullReport ? "lead report:" : "open items from lead:", ...reportLines, ...(reportTruncated ? [`… full report: ${session.file("lead-report.md")}`] : [])]
						: leadReports.length > 0
							? [`lead report: ${session.file("lead-report.md")}`]
							: []),
					`run log: ${session.file("run.log")}`,
					`ledger: ${STATE_ROOT}/metrics.jsonl`,
				];
				session.log(summary.join("\n"));
				ctx.ui.notify(summary.join("\n"), passedVerification || (dispatchOk && verificationSkipped) ? "info" : "warning");
			} catch (err) {
				if (session.cancellation.isCancelled) {
					const stopped = session.cancelledDispatches();
					session.log(`run cancelled by user; stopped dispatches: ${stopped.join(", ") || "none active"}`);
					await failRun(runId, "cancelled by user (Esc or Ctrl+C)", session.terminalTiming());
					ctx.ui.notify(
						`Orchestration cancelled. ${stopped.length ? `Stopped: ${stopped.join(", ")}. ` : "No child dispatch was active. "}Progress is retained above the editor; run log: ${session.file("run.log")}`,
						"info",
					);
				} else {
					// Any uncaught throw used to leave the run half-recorded (no outcome
					// row) and the UI stuck on the last notify. Record + surface it.
					const message = (err as Error).stack ?? String(err);
					session.log(`run crashed: ${message}`);
					await failRun(runId, `crashed: ${(err as Error).message}`, session.terminalTiming());
					ctx.ui.notify(
						`Orchestration crashed: ${(err as Error).message}\nSee ${session.file("run.log")}`,
						"error",
					);
				}
			} finally {
				session.close(session.cancellation.isCancelled);
				ACTIVE_RUN = null;
				closeTui?.();
				if (tuiCompletion) await tuiCompletion.catch(() => {});
			}
		},
	});

	pi.registerCommand("orchestrator-models", {
		description:
			"Manage which models /orchestrate uses. Subcommands: show|list|validate [--live]|check|set|effort|use|new|pick. " +
			"Aliases like fable-5-1, sonnet, haiku, astra, terra resolve against your configured models.",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : "show";
			const rest = tokens[0] && !tokens[0].startsWith("--") ? tokens.slice(1) : tokens;
			const VALUE_FLAGS = new Set(["--profile", "--from", "--effort", "--cheap", "--mid", "--premium", "--model"]);
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
						ctx.ui.notify(`Usage: /orchestrator-models set <capability|cheap|mid|premium> <alias|provider/model> [--profile P]\n${MODELS_USAGE}`, "error");
						return;
					}
					if (!isTier(target) && !ALL_CAPABILITIES.includes(target)) {
						ctx.ui.notify(`"${target}" is not a tier (cheap|mid|premium) or capability (${ALL_CAPABILITIES.join(", ")})`, "error");
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

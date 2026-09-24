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
 *   8. build QualityEvidence + verify_task   -> verifyTask
 *   9. escalate only the failing subproblem -> escalateIfNeeded
 *  10. complete_run / fail_run              -> completeRun / failRun + recordOutcome
 *
 * Compare the original sketch (kept at orchestrator.ts.sketch if present):
 * this rewrite adds hierarchical fan-out, verification + escalation, executed
 * route emission, and a `route_action: executed` record per dispatch so the
 * skill's history has (recommended, executed, observed) triples to learn from.
 */

import { type ChildProcess, spawn, type SpawnOptions, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
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
import { BoundedCapture, classifyDispatchOutcome, summarizeStderr } from "./dispatch-outcome.ts";
import { RunCancellation } from "./cancellation.ts";
import { connectCancellationLoader } from "./run-ui.ts";
// Rule-2 recon planning/evidence helpers (pure; see recon.ts). `dispatchHierarchical()`
// dispatches these as ordinary parent-owned tasks through the existing
// `dispatchParallel()` path; `DispatchTask` is kept structurally compatible
// with `ReconTaskPlan` so a planned recon task needs no conversion step.
import { formatReconEvidence, planReconTasks, type ReconTaskPlan } from "./recon.ts";

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
 * Capabilities that fan out their own subagents instead of doing the work
 * themselves. Their wall clock must exceed the sum of the children they wait on,
 * so they get a separate, larger budget: a lead that dispatches three reviewers
 * was being killed at the leaf timeout while its children were still running.
 */
const ORCHESTRATING_CAPABILITIES = new Set(["lead", "architect", "technical_lead"]);
const LEAD_DISPATCH_TIMEOUT_MS = positiveIntEnv(
	"HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS",
	Math.max(90 * 60 * 1000, DISPATCH_TIMEOUT_MS * 4),
);

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

function dispatchTimeoutFor(capability: string | undefined): number {
	return capability && ORCHESTRATING_CAPABILITIES.has(capability)
		? LEAD_DISPATCH_TIMEOUT_MS
		: DISPATCH_TIMEOUT_MS;
}

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
 * Age after which an unclaimed persona temp dir is considered orphaned. Must stay
 * comfortably above DISPATCH_TIMEOUT_MS so a live dispatch is never reaped.
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

/**
 * Injectable process-creation seam for `runSubagentProcess`. Only the
 * `(command, args, options) => ChildProcess` overload is ever used at the one
 * call site, so the seam is typed to exactly that call shape — the real
 * `spawn` satisfies it structurally, and tests can supply a plain function
 * without fighting `spawn`'s overload set (which otherwise infers `args` as
 * `readonly string[] | SpawnOptions`).
 */
type ChildSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

interface SubagentProcessResult {
	exitCode: number;
	/** Every assistant text block, in order, joined by blank lines. */
	stdout: string;
	/** The LAST assistant text block — the child's final answer. */
	finalText: string;
	/** Raw newline-delimited JSON event stream, kept for diagnostics only. */
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
	outcome: "completed" | "completed_after_process_error" | "failed" | "timed_out";
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
	costUsd: number;
	status: "running" | "done" | "failed" | "cancelled";
}

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
	private readonly dispatches = new Map<string, DispatchProgress>();
	private phase = "starting";
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly startedAt = Date.now();
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	readonly cancellation = new RunCancellation();

	constructor(runId: string, ctx: ExtensionContext, goal: string) {
		this.runId = runId;
		this.ctx = ctx;
		this.goal = goal;
		this.dir = join(runsDir(), runId);
		try {
			mkdirSync(this.dir, { recursive: true });
		} catch (err) {
			console.warn(`[orchestrator] could not create run dir ${this.dir}: ${(err as Error).message}`);
		}
		this.log(`run ${runId} started`);
		this.log(`goal: ${goal}`);
		// Elapsed counters must tick even when a child is silent — a frozen board
		// is indistinguishable from a hung run, which is the complaint that led here.
		this.tickTimer = setInterval(() => this.render(), 1000);
	}

	file(name: string): string {
		return join(this.dir, name);
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

	startDispatch(taskId: string, label: string, model: string): void {
		this.dispatches.set(taskId, {
			taskId,
			label,
			model,
			startedAt: Date.now(),
			turns: 0,
			toolCalls: 0,
			lastActivity: "starting",
			costUsd: 0,
			status: "running",
		});
		this.log(`dispatch ${taskId} → ${label} on ${model}`);
		this.render();
	}

	/** Feed a parsed `--mode json` event from a child. */
	onChildEvent(taskId: string, event: any): void {
		const d = this.dispatches.get(taskId);
		if (!d) return;
		switch (event?.type) {
			case "tool_execution_start": {
				d.toolCalls += 1;
				const detail = shortArgs(event.toolName, event.args);
				d.lastActivity = `${event.toolName}${detail ? ` ${detail}` : ""}`;
				this.log(`  ${taskId} tool#${d.toolCalls} ${d.lastActivity}`);
				break;
			}
			case "tool_execution_end":
				if (event.isError) {
					d.lastActivity = `${event.toolName} ✗`;
					this.log(`  ${taskId} tool ${event.toolName} returned error`);
				}
				break;
			case "message_start":
				if (event.message?.role === "assistant") d.lastActivity = "thinking";
				break;
			case "message_end":
				if (event.message?.role === "assistant") {
					d.turns += 1;
					d.costUsd += event.message?.usage?.cost?.total || 0;
					d.lastActivity = `turn ${d.turns} done`;
				}
				break;
			default:
				return;
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
		const running = [...this.dispatches.values()].filter((d) => d.status === "running");
		const done = [...this.dispatches.values()].filter((d) => d.status !== "running");
		const cancelled = done.filter((d) => d.status === "cancelled").length;
		const elapsed = fmtElapsed(Date.now() - this.startedAt);
		this.ctx.ui.setStatus(
			"orchestrator",
			`orch ${elapsed} · ${this.phase} · ${running.length} running · ${cancelled} cancelled · $${this.totalCost().toFixed(3)}`,
		);
		const goal = this.goal.replace(/\s+/g, " ").trim();
		const lines: string[] = [
			`▶ /orchestrate ${elapsed} — ${this.phase} — $${this.totalCost().toFixed(4)} — log: ${this.file("run.log")}`,
			`Goal: ${goal.length > 120 ? `${goal.slice(0, 117)}…` : goal}`,
		];
		for (const d of running) {
			lines.push(
				`  ● ${d.label.padEnd(22)} ${shortName(d.model).padEnd(28)} ${fmtElapsed(Date.now() - d.startedAt).padStart(6)}  t${d.turns} tools${d.toolCalls}  ${d.lastActivity}`,
			);
		}
		for (const d of done.slice(-6)) {
			const mark = d.status === "done" ? "✓" : d.status === "cancelled" ? "⏹" : "✗";
			lines.push(
				`  ${mark} ${d.label.padEnd(22)} ${shortName(d.model).padEnd(28)} ${fmtElapsed((d.endedAt ?? Date.now()) - d.startedAt).padStart(6)}  t${d.turns} tools${d.toolCalls}  $${d.costUsd.toFixed(4)} ${d.lastActivity}`,
			);
		}
		if (done.length > 6) lines.push(`  … ${done.length - 6} earlier dispatch(es) in run.log`);
		this.ctx.ui.setWidget("orchestrator", lines);
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
}, spawnProcess: ChildSpawner = spawn): Promise<SubagentProcessResult> {
	const emptyUsage: SubagentUsageStats = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		cost: 0, contextTokens: 0, turns: 0,
	};
	const session = ACTIVE_RUN;
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
		session.startDispatch(taskId, opts.label ?? opts.agentName, opts.model);
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
		let rawStdout = "";
		// Node can truncate a chatty child's async pipe at 64 KiB, so retain both
		// the runtime header and the diagnostic tail without unbounded memory use.
		const stderrCapture = new BoundedCapture();
		let model: string | undefined;
		const usage: SubagentUsageStats = { ...emptyUsage };
		let stopReason: string | undefined;
		let sawAgentSettled = false;
		let sawAgentEnd = false;
		let timedOut = false;
		let spawnFailed = false;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let removeCancellationListener: (() => void) | undefined;
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

		const finish = (processExitCode: number) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
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
			session?.endDispatch(taskId, outcome.effectiveExitCode, usage.cost, outcome.note);
			resolve({
				exitCode: outcome.effectiveExitCode,
				stdout: assistantTexts.join("\n\n"),
				finalText,
				rawStdout,
				personaCanMutate,
				stderr,
				model,
				usage,
				costUsd: usage.cost,
				durationMs: Date.now() - startedAt,
				stopReason,
				outcome: outcome.status,
				processExitCode,
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
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				return;
			}
			session?.onChildEvent(taskId, event);
			if (event.type === "agent_settled") sawAgentSettled = true;
			if (event.type === "agent_end") sawAgentEnd = true;
			if (typeof event.stopReason === "string") stopReason = event.stopReason;
			// `message_end` is the authoritative per-turn record. `turn_end` and
			// `agent_end` repeat the same assistant messages, so ignoring them
			// keeps usage from being double-counted.
			if (event.type === "message_end" && event.message?.role === "assistant") {
				absorbAssistantMessage(event.message);
			}
		};

		// spawn() itself throws synchronously on argument-validation errors (as
		// opposed to ENOENT, which arrives as an async 'error' event). Without this
		// guard the throw escapes before any listener exists, so finish() never
		// runs and the persona prompt temp dir leaks.
		// Optional so `finish()` can run from the synchronous-spawn-throw path,
		// where no child was ever created.
		let proc: ChildProcess | undefined;
		try {
			proc = spawnProcess(invocation.command, invocation.args, {
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
		removeCancellationListener = session?.cancellation.onCancel(() => {
			if (proc && !settled) killProcessTree(proc);
		});

		// A stalled child would otherwise block its whole batch forever, freezing
		// the run instead of failing just that task. Leads that fan out their own
		// subagents get a larger budget than leaf workers.
		const timeoutMs = dispatchTimeoutFor(opts.capability);
		timeoutTimer = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			stderrCapture.append(
				`\n[orchestrator] dispatch timed out after ${Math.round(timeoutMs / 60000)}min ` +
					`(capability=${opts.capability ?? "unknown"}); killing process group`,
			);
			if (proc) killProcessTree(proc);
			finish(124);
		}, timeoutMs);

		proc.stdout?.on("data", (data) => {
			const chunk = data.toString();
			rawStdout += chunk;
			if (eventsLog) {
				try {
					appendFileSync(eventsLog, chunk);
				} catch {
					/* best-effort */
				}
			}
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr?.on("data", (data) => {
			stderrCapture.append(data.toString());
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
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
 * `agent_runtime: "humain-terminal"` and PYTHONPATH so the `orchestrator`
 * package is importable.
 */
function runModule(module: string, args: string[] = []): Promise<CliResult> {
	return new Promise((resolve) => {
		const expandedSkillRoot = SKILL_ROOT.replace(/^~/, homedir());
		const child = spawn(PYTHON, ["-m", module, ...args], {
			env: {
				...process.env,
				CODING_AGENT_RUNTIME: "humain-terminal",
				CODING_AGENT_REPOSITORY: process.env.CODING_AGENT_REPOSITORY ?? process.cwd(),
				PYTHONPATH: expandedSkillRoot,
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

async function completeRun(runId: string, summary: Record<string, unknown>): Promise<void> {
	await recordOutcome({
		run_id: runId,
		task_id: "run-complete",
		outcome: "verified",
		quality: summary.success_rate ?? 0,
		note: JSON.stringify(summary),
	});
}

async function failRun(runId: string, error: string): Promise<void> {
	await recordOutcome({
		run_id: runId,
		task_id: "run-failed",
		outcome: "fail",
		quality: 0,
		note: error,
	});
}

// -----------------------------------------------------------------------------
// Subagent dispatch
// -----------------------------------------------------------------------------

// Recon always specifies tools; other dispatches inherit their persona's tools.
export interface DispatchTask extends Omit<ReconTaskPlan, "tools"> {
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
	stopReason?: string;
	filesChanged: string[];
}

export async function dispatchParallel(
	cwd: string,
	runId: string,
	tasks: DispatchTask[],
	adapter: Adapter,
	ctx: ExtensionContext,
	deps = { recordEvent, runProcess: runSubagentProcess },
): Promise<DispatchResult[]> {
	if (tasks.length === 0) return [];

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
			task: formatTaskPrompt(t, runId),
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
		await deps.recordEvent("dispatch_started", {
			run_id: runId,
			task_id: input._taskId,
			capability: input._capability,
			agent: input.agent,
			model: input.model,
			retry_of: input._retryOf,
		});
		try {
			const r = await deps.runProcess({
				cwd: input.cwd,
				agentName: input.agent,
				task: input.task,
				model: input.model,
				effort: input.effort,
				taskId: input._taskId,
				label: shortId,
				capability: input._capability,
				// Recon overrides a potentially write-capable model persona. Other
				// tasks retain their persona's allow-list rather than a global default.
				tools: input.tools,
				ctx,
			});
			await deps.recordEvent("dispatch_finished", {
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

function formatTaskPrompt(t: DispatchTask, runId: string): string {
	const retryNote = t.retryOf
		? `\n\n[Retry context: this is retry #${(t.retryCount ?? 0) + 1} of a previous failed attempt on task_id=${t.retryOf}. The previous attempt's review/QA feedback is captured in the orchestrator ledger; if you need that context, ask the lead before starting. Per method.json rules.review_after_fix: re-review at or above the original reviewer's tier, never the cheap tier.]`
		: "";
	return [
		`[orchestrator:run_id=${runId}]`,
		`[capability=${t.capability}]`,
		`[task_id=${t.taskId}]`,
		"",
		t.task,
		retryNote,
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
		"Anything the lead should know.",
	].join("\n");
}

/**
 * Paths that differ from HEAD (modified, added, deleted, renamed, untracked),
 * repo-relative. `null` when `cwd` is not inside a git work tree, in which case
 * callers fall back to the scraped list.
 */
function gitDirtyFiles(cwd: string): Set<string> | null {
	const res = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
		cwd,
		encoding: "utf-8",
		timeout: 10_000,
	});
	if (res.status !== 0) return null;
	const out = new Set<string>();
	for (const line of res.stdout.split("\n")) {
		if (line.length < 4) continue;
		// "XY path" or "XY old -> new" for renames; take the destination.
		const p = line.slice(3);
		const arrow = p.indexOf(" -> ");
		out.add(arrow === -1 ? p : p.slice(arrow + 4));
	}
	return out;
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
	// Defensive defaults: every field on `result` may be sparse when HT
	// returns a partial / cancelled dispatch. Normalize once at the top so
	// the metric payload below is always well-formed and the split() on
	// the model id can't throw.
	const model = result?.model ?? "unknown";
	const usage = result?.usage ?? {};
	const provider = model.includes("/") ? model.split("/")[0] : "unknown";

	// 1. The model_call record HT actually produced. `cost_source: "reported"`
	//    means the harness reported cost directly; if cost is missing, the
	//    pricing table resolves it to `estimated`.
	const hasReportedCost = (result?.costUsd ?? 0) > 0;
	await recordModelCall({
		event: "model_call",
		run_id: opts.runId,
		task_id: result?.taskId ?? `unknown-${opts.runId}`,
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
	});

	// 2. The executed-route record. This is the closing half of the
	//    (recommended, executed, observed) triple: the plan-time
	//    `adaptive_route_decision` event already has `recommended_*`; this
	//    event records what was actually dispatched and what it cost.
	await recordModelCall({
		event: "route_executed",
		run_id: opts.runId,
		task_id: result?.taskId ?? `unknown-${opts.runId}`,
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
	});
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

	await recordOutcome({
		run_id: runId,
		task_id: `${runId}-qa`,
		outcome: passed ? "verified" : "fail",
		quality: passed ? 0.95 : 0.0,
		note: out.slice(0, 2000),
	});

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
	const results = await dispatchReconAndLeads({ runId, goal, plan, adapter, architectResult }, {
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
	},
	effects: {
		dispatch: (tasks: DispatchTask[]) => Promise<DispatchResult[]>;
		capture: (result: DispatchResult) => Promise<void>;
		setPhase: (phase: string) => void;
		throwIfCancelled: () => void;
	},
): Promise<{ leadResults: DispatchResult[]; workerResults: DispatchResult[] }> {
	const { runId, goal, plan, adapter, architectResult, evidenceMaxChars = RECON_EVIDENCE_MAX_CHARS } = input;
	const { leads } = plan.topology;
	// `Math.max(1, leads)` returns NaN when the plan omits `topology.leads` or
	// sends a non-number, and `Array.from({ length: NaN })` is empty — that is
	// how a run reported "leads: 0/0 succeeded" with nothing dispatched. Coerce
	// first, then floor at 1.
	const leadCount = Number.isFinite(leads)
		? Math.min(MAX_LEADS, Math.max(1, Math.trunc(leads)))
		: 1;

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

	const leadTasks: DispatchTask[] = Array.from({ length: leadCount }, (_, i) => ({
		capability: "lead",
		task: leadPrompt(goal, plan, architectResult, reconEvidence, i, leadCount, adapter),
		taskId: `${runId}-lead-${i}`,
	}));

	const completedReconCount = workerResults.filter((r) => r.exitCode === 0).length;
	const reconPhaseNote =
		reconTasks.length > 0
			? `${completedReconCount}/${reconTasks.length} completed recon packet(s)`
			: "no parent-owned recon packets (not required for this task)";
	effects.throwIfCancelled();
	effects.setPhase(
		`${leadCount} lead(s) executing on ${shortName(adapter.lead?.model ?? "?")} with ${reconPhaseNote}; nested subagent calls inside a lead are not authoritative worker accounting`,
	);
	const leadResults = await effects.dispatch(leadTasks);
	for (const r of leadResults) await effects.capture(r);
	// Same contract as recon: bill every finished lead, then honour cancellation.
	effects.throwIfCancelled();

	// Recon is parent-owned and returned for billing/reporting. Any further
	// fan-out a lead performs via HT's own subagent tool happens inside that
	// lead's own context window; the bridge has no visibility into it and does
	// not count it as part of this run's authoritative worker accounting.
	return { leadResults, workerResults };
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

export function leadPrompt(
	goal: string,
	plan: PlanResponse,
	architectResult: DispatchResult | undefined,
	reconEvidence: string,
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
		"You may use the subagent tool for implementation, review, and QA work. Nested subagent calls you make run inside your own context: the orchestrator bridge does not see, log, or bill them the way it does the parent-owned recon above, so they are not authoritative worker accounting for this run — only your own final report is. For each nested dispatch:",
		"- Choose the right agent (orch-worker, orch-implementation-strong, orch-implementation-fast, orch-technical-review, orch-security-review, orch-qa-agent).",
		"- Pass a narrowly-scoped task prompt.",
		"- Pass the `model` for that agent from the routing table below.",
		"- After implementation is done, run QA via orch-qa-agent. If verification fails, escalate per method.json rules.review_after_fix (Rule 1).",
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
			case "--complexity": if (next) { out.complexity = clampComplexity(next); i++; } break;
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
function installSessionIngest(pi: ExtensionAPI): void {
	const logPath = join(STATE_ROOT.replace(/^~/, homedir()), "ingest-hook.log");
	const logError = (message: string) => {
		try {
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
		} catch {
			// Telemetry must never break the session.
		}
	};
	const scheduler = new SessionIngestScheduler({
		onError: logError,
		run: async (sessionFile) => {
			const res = await runModule("orchestrator.cli", ingestArgs(sessionFile));
			if (res.exitCode === 0) return { ok: true };
			return { ok: false, detail: `exit ${res.exitCode}: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}` };
		},
	});
	pi.on("agent_settled", async (_event, ctx) => {
		scheduler.schedule(ctx.sessionManager.getSessionFile());
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await scheduler.flush(ctx.sessionManager.getSessionFile());
	});
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
							await failRun(runId, reason);
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
					await failRun(runId, `plan failed: ${(err as Error).message}`);
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
					`${pipeline}\n\nEach stage runs headless (up to ${Math.round(DISPATCH_TIMEOUT_MS / 60000)} min per dispatch); live progress shows above the editor.`,
					parsed.interactive,
				)]);
				session.cancellation.throwIfCancelled();
				if (!proceed) {
					const reason = parsed.interactive && !ctx.hasUI
						? "interactive confirmation unavailable before dispatch"
						: "cancelled by user at plan confirmation";
					session.log(reason);
					await failRun(runId, reason);
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

				const dirtyBefore = gitDirtyFiles(cwd);
				const { leadResults, workerResults, architectResult, escalationResults } = await dispatchHierarchical(
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
				// were touched in the lead phase. If QA fails, escalate per policy
				// Rule 1. The loop is bounded by maxRetries.
				// `filesChanged` is scraped from the lead's prose, so a report that merely
				// MENTIONS README.md counted it as changed and sent QA after a phantom.
				// When the workspace is a git repo, trust the working tree instead: a file
				// is "changed" if it is dirty now and was either clean before the run or
				// is also named by the lead.
				const claimed = new Set(leadResults.flatMap((r) => r.filesChanged));
				const dirtyAfter = gitDirtyFiles(cwd);
				const allFiles =
					dirtyBefore && dirtyAfter
						? [...dirtyAfter].filter((f) => !dirtyBefore.has(f) || claimed.has(f))
						: [...claimed];
				if (dirtyBefore && dirtyAfter) {
					const phantom = [...claimed].filter((f) => !dirtyAfter.has(f));
					if (phantom.length > 0) session.log(`lead named ${phantom.length} file(s) that are not modified in git; ignored: ${phantom.join(", ")}`);
				}

				let retries = 0;
				let lastVerification: VerificationResult | null = null;
				const verificationResults: DispatchResult[] = [];
				while (retries <= parsed.maxRetries) {
					if (allFiles.length > 0) {
						session.setPhase(
							retries === 0
								? `QA on ${allFiles.length} changed file(s) via ${shortName(adapter.qa_agent?.model ?? "?")}`
								: `QA retry ${retries + 1}/${parsed.maxRetries + 1}`,
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
				});

				// The lead's final report is the only place its reasoning, open
				// questions, and non-file results (audits, package lists, verdicts)
				// live. Always write it to disk; show it inline when there are no file
				// edits to speak for the run, or when the lead raised open items.
				const leadReports = leadResults
					.filter((r) => r.stdout.trim())
					.map((r) => `### ${r.taskId.replace(`${runId}-`, "")}\n\n${r.stdout.trim()}`);
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
					summarizeReconWorkers(workerResults),
					`verification: ${verdict}`,
					`total cost: $${totalCost.toFixed(4)} (${billedResults.length + (triageCost.usd > 0 ? 1 : 0)} dispatches)`,
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
					await failRun(runId, "cancelled by user (Esc or Ctrl+C)");
					ctx.ui.notify(
						`Orchestration cancelled. ${stopped.length ? `Stopped: ${stopped.join(", ")}. ` : "No child dispatch was active. "}Progress is retained above the editor; run log: ${session.file("run.log")}`,
						"info",
					);
				} else {
					// Any uncaught throw used to leave the run half-recorded (no outcome
					// row) and the UI stuck on the last notify. Record + surface it.
					const message = (err as Error).stack ?? String(err);
					session.log(`run crashed: ${message}`);
					await failRun(runId, `crashed: ${(err as Error).message}`);
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
}

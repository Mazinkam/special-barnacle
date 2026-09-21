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
 *   4. resolve abstract capability/effort   -> loadAdapter() (dynamic, scripts/dynamic_adapter.py)
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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// TypeBox 1.x: `Type` is a namespace (`Type.Object`, `Type.Array`, ...);
// the validation function moved to a separate `typebox/value` module.
import { Type } from "typebox";
import { Check } from "typebox/value";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@humain/terminal";
import {
	createSubagentTool,
	type SubagentDetails,
	type SubagentSingleResult,
} from "@core/tools/subagent.ts";

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
	technical_review:     { model: "amazon-bedrock/anthropic.claude-sonnet-4-5", effort: "standard" },
	integration_review:   { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	security_review:      { model: "amazon-bedrock/anthropic.claude-opus-4-5" },
	migration_review:     { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	performance_review:   { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	api_contract_review:  { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	qa_agent:             { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
	lead:                 { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
};

const RULE_REVIEW_AFTER_FIX_MIN_TIER = "sonnet";

type Adapter = Record<string, { model: string; effort?: string }>;

async function loadAdapter(): Promise<Adapter> {
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
			console.warn(`[orchestrator] resolve-adapter failed (exit ${exitCode}): ${stderr}`);
			return FALLBACK_ADAPTER;
		}
		// The CLI emits a single JSON object on stdout (pretty-printed across
		// many lines). Parse the whole thing, not just the last line.
		const resolved = JSON.parse(stdout.trim()) as Record<string, any>;
		const out: Adapter = {};
		for (const [cap, info] of Object.entries(resolved)) {
			if (!info || typeof info !== "object" || cap.startsWith("_")) continue;
			if (!info.provider || !info.model) continue;
			out[cap] = { model: `${info.provider}/${info.model}` };
		}
		return Object.keys(out).length > 0 ? out : FALLBACK_ADAPTER;
	} catch (err) {
		console.warn(`[orchestrator] resolve-adapter error: ${(err as Error).message}`);
		return FALLBACK_ADAPTER;
	}
}

let ADAPTER: Promise<Adapter> | null = null;
function adapter(): Promise<Adapter> {
	if (!ADAPTER) ADAPTER = loadAdapter();
	return ADAPTER;
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

async function triageTask(
	goal: string,
	cwd: string,
	ctx: ExtensionContext,
): Promise<TriageResult | null> {
	const adapter = await adapter_();
	const cheapest =
		adapter["implementation_fast"] ??
		adapter["worker"] ??
		adapter["scout"] ??
		Object.values(adapter)[0];
	if (!cheapest || !cheapest.model) {
		console.warn("[orchestrator] triage skipped: adapter has no dispatchable model");
		return null;
	}

	const tool = createSubagentTool(cwd);
	// `Type.Assign` is a TS-only type helper in TypeBox 1.x (not a runtime
	// function), and the original wrapper was passing only one argument
	// (which Assign never accepted, even in older typebox). Drop it and
	// use the inner Type.Object literal directly.
	const params = Type.Object({
		tasks: Type.Array(
			Type.Object({
				agent: Type.String(),
				task: Type.String(),
				model: Type.Optional(Type.String()),
				cwd: Type.Optional(Type.String()),
			}),
		),
	});

	const prompt = TRIAGE_PROMPT + "\n" + goal + "\n\nJSON:\n";
	try {
		const details = (await tool.execute(
			`orchestrator-triage-${Date.now()}`,
			Check(params, {
				tasks: [
					{
						agent: "orch-implementation-fast",
						task: prompt,
						model: cheapest.model,
						cwd,
					},
				],
			}),
			undefined,
			undefined,
			ctx,
		)) as SubagentDetails;
		const r = details.results[0];
		if (!r || r.exitCode !== 0) return null;
		const text = extractAssistantText(r);
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
				model: r?.model ?? cheapest?.model ?? "unknown",
				exitCode: r.exitCode,
				stdout: text,
				stderr: r.stderr,
				usage: r.usage,
				durationMs: 0,
				costUsd: r.usage.cost,
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

// Accessor used by triageTask — same singleton as `adapter()`.
async function adapter_(): Promise<Adapter> {
	return adapter();
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
	filesChanged: string[];
}

async function dispatchParallel(
	cwd: string,
	runId: string,
	tasks: DispatchTask[],
	adapter: Adapter,
	ctx: ExtensionContext,
): Promise<DispatchResult[]> {
	if (tasks.length === 0) return [];

	const tool = createSubagentTool(cwd);

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
			task: formatTaskPrompt(t),
			model: binding.model ?? "unknown",
			cwd,
			_effort: binding.effort,
			_capability: t.capability,
			_taskId: t.taskId,
			_retryOf: t.retryOf,
			_retryCount: t.retryCount,
		};
	});

	// `Type.Assign` is a TS-only type helper in TypeBox 1.x — see the note
	// in triageTask(). The inner Type.Object is the actual runtime schema.
	const params = Type.Object({
		tasks: Type.Array(
			Type.Object({
				agent: Type.String(),
				task: Type.String(),
				model: Type.Optional(Type.String()),
				cwd: Type.Optional(Type.String()),
			}),
		),
	});

	const details = (await tool.execute(
		`orchestrator-${runId}-${Date.now()}`,
		Check(params, { tasks: taskInputs }),
		undefined,
		undefined,
		ctx,
	)) as SubagentDetails;

	// HT may return a details object without a `results` array in some
	// interruption / cancellation paths (e.g. subagent depth exceeded,
	// parent aborted before any child started). Normalize to an empty
	// list so the orchestrator's bookkeeping still lands in metrics.jsonl
	// and the run doesn't crash on `.results.map(...)`.
	const results = Array.isArray(details?.results) ? details.results : [];

	// Each `r` may also be sparse/nullish (HT has historically returned
	// holes in cancellation paths), and the result array may have a
	// different length than `taskInputs` if the harness reconciles mid-
	// dispatch. Defend at every field access so the run always lands in
	// metrics.jsonl instead of crashing the orchestrator.
	return results.map((r, i, arr) => {
		const input = taskInputs[i] ?? taskInputs[arr.length - 1] ?? taskInputs[0];
		const rSafe = r ?? {};
		const usage = rSafe.usage ?? {};
		const stdout = extractAssistantText(rSafe);
		return {
			taskId: input?._taskId ?? `unknown-${runId}-${i}`,
			capability: input?._capability ?? "unknown",
			model: rSafe.model ?? input?.model ?? "unknown",
			exitCode: rSafe.exitCode ?? -1,
			stdout,
			stderr: rSafe.stderr ?? "",
			usage,
			durationMs: 0,
			costUsd: usage.cost ?? 0,
			stopReason: rSafe.stopReason,
			filesChanged: parseFilesChanged(stdout),
		};
	});
}

function agentNameFor(capability: string): string {
	return `orch-${capability.replace(/_/g, "-")}`;
}

function formatTaskPrompt(t: DispatchTask): string {
	const retryNote = t.retryOf
		? `\n\n[Retry context: this is retry #${(t.retryCount ?? 0) + 1} of a previous failed attempt on task_id=${t.retryOf}. The previous attempt's review/QA feedback is captured in the orchestrator ledger; if you need that context, ask the lead before starting. Per policy_overlay.json Rule 1: minimum sonnet tier for any re-review.]`
		: "";
	return [
		`[orchestrator:run_id=${t.taskId.split("-")[0]}]`,
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

function extractAssistantText(r: SubagentSingleResult | null | undefined): string {
	// HT may return a result with no `messages` array (cancellation,
	// mid-stream abort, harness-level error before the first delta).
	// Coerce to empty text so the orchestrator's bookkeeping doesn't
	// crash on `.messages.filter(...)`.
	const messages = Array.isArray(r?.messages) ? r.messages : [];
	return messages
		.filter((m) => m && m.role === "assistant")
		.map((m) => (typeof m.content === "string" ? m.content : ""))
		.join("\n");
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
 * On retry (escalation), bumps to the next tier per policy_overlay Rule 1:
 * haiku -> sonnet -> opus for re-reviews.
 *
 * Tier detection works on the model-id substring. Recognized tokens:
 *   cheap:    haiku, luna, mini, nano, flash, lite
 *   mid:      sonnet, glm, mistral, command, jamba
 *   premium:  opus, kimi-k3, ultra, pro
 * If a model id doesn't match any known token, we leave it unchanged — the
 * adapter's pick already satisfies policy Rule 1 ("at least the original
 * reviewer's tier") because the dynamic adapter routes reviews to sonnet-or-
 * higher by default.
 */
function pickModel(
	capability: string,
	adapter: Adapter,
	retryCount: number,
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
	const tier = classifyTier(modelName);
	if (tier === "premium") return base; // already top, no escalation needed

	// Map: cheap -> mid (retry 1+), mid -> premium (retry 2+).
	// We can't reliably know the exact "next" model, so we ask the adapter for
	// the capability that lives one tier above. We do this by inspecting the
	// adapter's full table: the cheapest mid-tier review model, or the cheapest
	// premium-tier review model, depending on how far we've escalated.
	if (tier === "cheap") {
		const mid = cheapestAtTier(adapter, "mid", capability);
		if (mid) return mid;
	}
	if (tier === "mid" || retryCount >= 2) {
		const prem = cheapestAtTier(adapter, "premium", capability);
		if (prem) return prem;
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
): Promise<VerificationResult> {
	if (filesChanged.length === 0) {
		return {
			passed: true,
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
 * Mirrors `policy_overlay.json` Rule 1:
 *   - Re-review at minimum sonnet; at opus for high/critical.
 *   - Re-implementation at the next-higher capability for high risk.
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
): Promise<{ leadResults: DispatchResult[]; workerResults: DispatchResult[] }> {
	const { depth, leads, workers, shape } = plan.topology;
	const recCap = plan.route.recommended.capability;
	const recEffort = plan.route.recommended.effort;

	// Always: dispatch the architect first if it's a high-complexity / new-domain
	// task. The architect's output feeds into subsequent dispatch prompts.
	// For depth=1, skip — the lead IS the architect.
	let architectResult: DispatchResult | undefined;
	const needsArchitect = depth >= 2 && complexityNeedsArchitect(plan.complexity);
	if (needsArchitect) {
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
	}

	const leadCount = Math.max(1, leads);
	const leadTasks: DispatchTask[] = Array.from({ length: leadCount }, (_, i) => ({
		capability: "lead",
		task: leadPrompt(goal, plan, architectResult, i, leadCount),
		taskId: `${runId}-lead-${i}`,
	}));

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
	return { leadResults, workerResults: [] };
}

function complexityNeedsArchitect(complexity: number): boolean {
	return complexity >= 5;
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

function leadPrompt(
	goal: string,
	plan: PlanResponse,
	architectResult: DispatchResult | undefined,
	leadIndex: number,
	leadCount: number,
): string {
	const architectOutput = architectResult
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
		"Use the subagent tool to dispatch workers. For each dispatch:",
		"- Choose the right capability (worker, implementation_strong, implementation_fast, technical_review, security_review, qa_agent).",
		"- Pass a narrowly-scoped task prompt.",
		"- The orchestrator's runtime adapter will pick the right model per capability.",
		"- After all workers finish, run QA via qa_agent. If verification fails, escalate per policy_overlay.json Rule 1.",
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
}

function parseArgs(args: string): OrchestrateArgs {
	const tokens = args.trim().split(/\s+/);
	const out: OrchestrateArgs = {
		goal: "",
		taskClass: "implementation",
		complexity: 5,
		risk: "medium",
		fanOut: false,
		maxRetries: 2,
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
			default:
				if (!t.startsWith("--")) goalTokens.push(t);
				break;
		}
	}
	out.goal = goalTokens.join(" ");
	return out;
}

// -----------------------------------------------------------------------------
// Extension entry point
// -----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("orchestrate", {
		description:
			"Plan and dispatch a hierarchical agent run. " +
			"Args: <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical] " +
			"[--quality-floor F] [--cost-aggressiveness C] [--fan-out] [--max-retries R]\n\n" +
			"With no flags, an LLM triage call (cheapest available model, ~300 tokens) " +
			"auto-fills task_class, complexity, and risk from the goal text. " +
			"Pass any flag explicitly to override the triage.",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (!parsed.goal) {
				ctx.ui.notify(
					"Usage: /orchestrate <goal> [--task-class T] [--complexity N] [--risk R] [--fan-out] [--max-retries R]",
					"warning",
				);
				return;
			}

			const adapter = await loadAdapter();

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

			if (missingTriage) {
				ctx.ui.notify("Triaging goal with cheapest model\u2026", "info");
				triageResult = await triageTask(parsed.goal, process.cwd(), ctx);
				if (triageResult) {
					effectiveTaskClass = triageResult.task_class;
					effectiveComplexity = triageResult.complexity;
					effectiveRisk = triageResult.risk;
					const proceed = await ctx.ui.confirm(
						"Triage filled in missing values",
						`task_class: ${effectiveTaskClass}\n` +
							`complexity:  ${effectiveComplexity}\n` +
							`risk:        ${effectiveRisk}\n\n` +
							`Reasoning: ${triageResult.reasoning}\n\n` +
							`OK to dispatch with these values? (Cancel to abort)`,
					);
					if (!proceed) {
						ctx.ui.notify("Cancelled.", "info");
						return;
					}
				} else {
					ctx.ui.notify(
						"Triage unavailable; using defaults task_class=implementation complexity=5 risk=medium.",
						"warning",
					);
				}
			}
			const runId = `ht-orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

			// Step 1: Plan.
			ctx.ui.notify(`Planning run ${runId}…`, "info");
			let plan: PlanResponse;
			try {
				plan = await planRun(runId, {
					goal: parsed.goal,
					taskClass: parsed.taskClass,
					complexity: parsed.complexity,
					risk: parsed.risk,
					qualityFloor: parsed.qualityFloor,
					costAggressiveness: parsed.costAggressiveness,
				});
			} catch (err) {
				ctx.ui.notify(`Plan failed: ${(err as Error).message}`, "error");
				return;
			}

			ctx.ui.notify(
				[
					`Plan ${plan.plan_id.slice(0, 12)} — "${parsed.goal.slice(0, 50)}"`,
					`topology: ${plan.topology.shape} depth=${plan.topology.depth} leads=${plan.topology.leads} workers=${plan.topology.workers}`,
					`route: ${plan.route.selected.capability} @ ${plan.route.selected.effort} (${plan.route.mode})`,
					`quality floor: ${plan.effective_quality_floor}`,
				].join("\n"),
				"info",
			);

			const proceed = await ctx.ui.confirm(
				"Dispatch this plan?",
				`Route: ${plan.route.selected.capability}/${plan.route.selected.effort}. ` +
					`Topology: ${plan.topology.shape} (${plan.topology.leads} leads, ${plan.topology.workers} workers per lead).`,
			);
			if (!proceed) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			// Step 2: Dispatch.
			const cwd = process.cwd();
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

			ctx.ui.notify("Dispatching…", "info");
			const { leadResults } = await dispatchHierarchical(
				cwd,
				runId,
				plan.plan_id,
				parsed.goal,
				plan,
				adapter,
				ctx,
			);

			// Step 3: Verification + escalation. We run QA against whatever files
			// were touched in the lead phase. If QA fails, escalate per policy
			// Rule 1. The loop is bounded by maxRetries.
			const allFiles = Array.from(
				new Set(leadResults.flatMap((r) => r.filesChanged)),
			);

			let retries = 0;
			let lastVerification: VerificationResult | null = null;
			while (retries <= parsed.maxRetries) {
				ctx.ui.notify(
					retries === 0
						? `Running verification on ${allFiles.length} file(s)…`
						: `Retrying verification (attempt ${retries + 1})…`,
					"info",
				);
				lastVerification = await runVerification(
					cwd,
					runId,
					plan.plan_id,
					allFiles,
					adapter,
					ctx,
				);
				if (lastVerification.passed) break;

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
					await captureDispatchCost(captureOpts, retryResult);
				}
				retries++;
			}

			// Step 4: Finalize.
			const totalCost = leadResults.reduce((s, r) => s + r.costUsd, 0);
			const succeededLeads = leadResults.filter((r) => r.exitCode === 0).length;
			const passedVerification = lastVerification?.passed ?? false;

			await completeRun(runId, {
				success_rate: succeededLeads / Math.max(1, leadResults.length),
				verification_passed: passedVerification,
				total_cost_usd: totalCost,
				files_changed: allFiles,
				retries,
			});

			ctx.ui.notify(
				[
					`Orchestration complete.`,
					`run_id: ${runId}`,
					`leads: ${succeededLeads}/${leadResults.length} succeeded`,
					`verification: ${passedVerification ? "PASS" : "FAIL"}`,
					`retries: ${retries}`,
					`total cost: $${totalCost.toFixed(4)}`,
					`files: ${allFiles.length} changed`,
					`ledger: ${STATE_ROOT}/metrics.jsonl`,
				].join("\n"),
				passedVerification ? "info" : "warning",
			);
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

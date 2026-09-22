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
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
// TypeBox 1.x: `Type` is a namespace (`Type.Object`, `Type.Array`, ...);
// the validation function moved to a separate `typebox/value` module.
import { Type } from "typebox";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@humain/terminal";
import {
	discoverAgents,
	renderTaskWithContext,
	type SubagentSingleResult,
	type SubagentUsageStats,
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

// Non-interactive runs (`--mode json -p`, CI, smoke tests) get a no-op UI whose
// `confirm()` always resolves false, so /orchestrate could never dispatch
// outside a TTY. Opt in explicitly — default stays "ask", because dispatch
// spends money and edits files.
const ASSUME_YES = /^(1|true|yes)$/i.test(process.env.HUMAIN_ORCHESTRATOR_ASSUME_YES ?? "");

function positiveIntEnv(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/** Hard ceiling on concurrent child processes, independent of what a plan asks for. */
const MAX_CONCURRENT_DISPATCHES = positiveIntEnv("HUMAIN_ORCHESTRATOR_MAX_CONCURRENCY", 4);
/** Hard ceiling on lead fan-out, so a malformed topology can't spawn unbounded leads. */
const MAX_LEADS = positiveIntEnv("HUMAIN_ORCHESTRATOR_MAX_LEADS", 8);
/** Per-dispatch wall clock. A hung child fails its own task instead of the run. */
const DISPATCH_TIMEOUT_MS = positiveIntEnv("HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS", 20 * 60 * 1000);

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

async function confirmStep(
	ctx: ExtensionContext,
	title: string,
	message: string,
): Promise<boolean> {
	if (ASSUME_YES) {
		ctx.ui.notify(`${title} — auto-confirmed (HUMAIN_ORCHESTRATOR_ASSUME_YES)`, "warning");
		return true;
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

// -----------------------------------------------------------------------------
// Direct subagent subprocess
// -----------------------------------------------------------------------------
//
// The orchestrator previously invoked workers via `createSubagentTool(cwd)` from
// @core/tools/subagent.ts. That tool is wired for LLM-driven tool calls: it
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
}

/**
 * Pick the right binary + args to invoke Pi in --mode json. Mirrors the
 * getCliInvocation() helper in @core/tools/subagent.ts, inlined here because
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

/**
 * Spawn Pi as a one-shot subagent and parse its JSON event stream for the
 * assistant `message_end`, which carries `model`, `usage`, and `cost.total`.
 * This is the same on-the-wire protocol the human-facing subagent tool uses
 * internally — we just launch it from a context (extension handler) where the
 * human-facing wrapper doesn't have what it needs.
 */
async function runSubagentProcess(opts: {
	cwd: string;
	agentName: string;
	task: string;
	model: string;
	effort?: string;
	tools?: string[];
	ctx: ExtensionContext;
}): Promise<SubagentProcessResult> {
	const emptyUsage: SubagentUsageStats = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		cost: 0, contextTokens: 0, turns: 0,
	};

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
	try {
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
		let stderr = "";
		let model: string | undefined;
		const usage: SubagentUsageStats = { ...emptyUsage };
		let stopReason: string | undefined;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
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

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			cleanupPrompt();
			resolve({
				exitCode,
				stdout: assistantTexts.join("\n\n"),
				finalText: assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "",
				rawStdout,
				personaCanMutate,
				stderr,
				model,
				usage,
				costUsd: usage.cost,
				durationMs: Date.now() - startedAt,
				stopReason,
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
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});
		} catch (err) {
			stderr += `\n[orchestrator] spawn threw: ${(err as Error).message}`;
			finish(1);
			return;
		}

		// A stalled child would otherwise block its whole Promise.all batch
		// forever, freezing the run instead of failing just that task.
		timeoutTimer = setTimeout(() => {
			if (settled) return;
			stderr += `\n[orchestrator] dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms; killing child`;
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			finish(124);
		}, DISPATCH_TIMEOUT_MS);

		proc.stdout?.on("data", (data) => {
			const chunk = data.toString();
			rawStdout += chunk;
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});

		proc.on("error", (err) => {
			stderr += `\n[orchestrator] spawn error: ${err.message}`;
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

	const prompt = TRIAGE_PROMPT + "\n" + goal + "\n\nJSON:\n";
	try {
		const r = await runSubagentProcess({
			cwd,
			agentName: "orch-implementation-fast",
			task: prompt,
			model: cheapest.model,
			ctx,
		});
		costSink.usd += r?.costUsd ?? 0;
		if (!r || r.exitCode !== 0) {
			if (r) {
				// Surface WHY, instead of the bare "Triage unavailable" the command
				// used to print. A non-zero exit here is almost always an argv or
				// provider-auth problem, and stderr names it.
				console.warn(
					`[orchestrator] triage exited ${r.exitCode}: ${(r.stderr || r.rawStdout).trim().slice(0, 400) || "(no output)"}`,
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
		try {
			const r = await runSubagentProcess({
				cwd: input.cwd,
				agentName: input.agent,
				task: input.task,
				model: input.model,
				effort: input.effort,
				// Deliberately no `tools` override: each orch-* persona declares its
				// own allow-list in frontmatter, and those lists encode policy
				// (reviewers and scouts are read-only). Hardcoding a set here both
				// granted reviewers write access and dropped tools the personas need.
				ctx,
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
					r.exitCode === 0 ? r.stderr : r.stderr || r.rawStdout.slice(0, 2000) || "(no output)",
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
					(architectResult?.stderr ?? "no result").trim().slice(0, 300) || "(no output)"
				}\nLeads will run without an architect plan.`,
				"warning",
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
	return { leadResults, workerResults: [], architectResult, escalationResults: [] };
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
	reapOrphanedPersonaDirs();

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
			const triageCost = { usd: 0 };

			if (missingTriage) {
				ctx.ui.notify("Triaging goal with cheapest model\u2026", "info");
				triageResult = await triageTask(parsed.goal, process.cwd(), ctx, triageCost);
				if (triageResult) {
					effectiveTaskClass = triageResult.task_class;
					effectiveComplexity = triageResult.complexity;
					effectiveRisk = triageResult.risk;
					const proceed = await confirmStep(
						ctx,
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

			const proceed = await confirmStep(
				ctx,
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
			const { leadResults, architectResult, escalationResults } = await dispatchHierarchical(
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
			const verificationResults: DispatchResult[] = [];
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
					captureOpts,
				);
				if (lastVerification.dispatch) verificationResults.push(lastVerification.dispatch);
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

			await completeRun(runId, {
				success_rate: succeededLeads / Math.max(1, leadResults.length),
				verification_passed: passedVerification,
				total_cost_usd: totalCost,
				files_changed: allFiles,
				retries,
			});

			// For chat/check-in-style goals, the worker produces prose but no file
			// edits, so the notification block above would otherwise reduce the
			// run to "$0.0055 cost, 0 files changed" with no signal that anything
			// actually happened. Surface the lead's reply (truncated) so the user
			// can see the work; for code tasks that did mutate files, the file
			// list + verification verdict are the signal that matters.
			const leadReply =
				allFiles.length === 0 && leadResults.length > 0
					? (leadResults[0].stdout ?? "").trim().split("\n").slice(0, 8).join("\n").trim()
					: "";

			ctx.ui.notify(
				[
					`Orchestration complete.`,
					`run_id: ${runId}`,
					`leads: ${succeededLeads}/${leadResults.length} succeeded`,
					`verification: ${
						!dispatchOk
							? "NOT RUN (no lead succeeded)"
							: verificationSkipped
								? allFiles.length === 0
									? "N/A (chat/check-in goal — no files to verify)"
									: "SKIPPED (no files changed)"
								: passedVerification
									? "PASS"
									: "FAIL"
					}`,
					`retries: ${retries}`,
					`total cost: $${totalCost.toFixed(4)}`,
					`files: ${allFiles.length} changed`,
					...(dispatchOk
						? []
						: [
								`first failure: ${
									(billedResults.find((r) => r.exitCode !== 0)?.stderr ?? "(no dispatch attempted)")
										.trim()
										.slice(0, 300) || "(no output)"
								}`,
							]),
					...(leadReply ? ["", "lead reply:", leadReply] : []),
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

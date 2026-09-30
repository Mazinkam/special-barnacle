/**
 * `/orchestrate` argument parsing: turn the raw command string into an
 * `OrchestrateArgs`, honouring flags only in the leading/trailing flag block
 * so a `--flag`-looking word inside the goal prose is left alone. Pure:
 * nothing here touches `process.env`; `usageText` takes the profiles path as
 * a parameter instead of reading `PROFILES_PATH` off a config module.
 */

import { clampComplexity } from "./triage.ts";
import {
	ALL_CAPABILITIES,
	type Binding,
	isThinkingLevel,
	type LeadSize,
	THINKING_LEVELS,
	type Tier,
	type WorkflowLevel,
} from "../models.ts";
import { isLeadSize } from "../lead-sizing.ts";

/** Per-run overrides parsed from /orchestrate flags. */
export interface ModelOverrides {
	tiers: Partial<Record<Tier, string>>;
	capabilities: Record<string, Binding>;
	/** Run-wide `--effort`; wins over every per-capability effort. */
	effort?: string;
	/** `--profile <name>`; defaults to the file's active_profile. */
	profile?: string;
}

export function emptyOverrides(): ModelOverrides {
	return { tiers: {}, capabilities: {} };
}

export interface OrchestrateArgs {
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
	workflowLevel?: WorkflowLevel;
	/**
	 * `--context <file>` (repeatable), raw as given on the command line — resolved against the
	 * run's cwd and read by `commands/orchestrate.ts` (docs/architecture-review.md C6). This module
	 * stays pure: it never touches `node:fs`, so a bad path is not an error here, only downstream.
	 */
	contextFiles: string[];
	/** `--with-last-reply`: attach the current session's last assistant message as context (C6). */
	withLastReply: boolean;
	/** `--force`: skip the C7 "goal refers to missing context" pre-triage check. */
	force: boolean;
	/**
	 * Final resolved live-QA request: true when `--live-qa` was given, or implied by
	 * `--live-qa-scope` -- unless `--no-live-qa` was also given, which always wins regardless of
	 * flag order. Never heuristically inferred from the goal text.
	 */
	liveQa: boolean;
	/** Internal: `--no-live-qa` was given. Folded into `liveQa` at the end of `parseArgs`. */
	liveQaOff: boolean;
	/** `--live-qa-adapter <id>`, when given. */
	liveQaAdapterId?: string;
	/** `--live-qa-scope <scope>`; may be a double-quoted, multi-word value. */
	liveQaScope?: string;
	/** `--live-qa-acceptance <abs path>`: acceptance manifest handed to a criteria-capable adapter. */
	liveQaAcceptance?: string;
	/** Flags we did not recognize -- reported instead of silently swallowed. */
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
	while (tokens[0] === "/orchestrate") tokens.shift();
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

const KNOWN_FLAGS = new Set([
	"--task-class", "--complexity", "--risk", "--quality-floor", "--cost-aggressiveness",
	"--fan-out", "--max-retries", "--interactive", "--context", "--with-last-reply",
	"--force", "--live-qa", "--no-live-qa", "--live-qa-adapter", "--live-qa-scope", "--live-qa-acceptance",
	"--yes", "-y", "--check", "--live", "--profile", "--lead-size", "--workflow", "--effort",
	"--cheap", "--mid", "--premium", "--frontier", "--model",
]);

/** Literal parser-known flags at the very start of a goal, not inside its prose or quotes. */
export function leadingUnappliedFlags(goal: string): string[] {
	const tokens = goal.trimStart().split(/\s+/).filter(Boolean);
	const flags: string[] = [];
	const scratch = newOrchestrateArgs();
	for (let i = 0; i < tokens.length && KNOWN_FLAGS.has(tokens[i]); ) {
		flags.push(tokens[i]);
		i = consumeFlag(tokens, i, scratch) ?? i + 1;
	}
	return flags;
}

/** Refuse a goal that opens with flags the parser did not apply, unless explicitly forced. */
export function unappliedGoalFlagError(goal: string, force: boolean): string | null {
	if (force) return null;
	const flags = leadingUnappliedFlags(goal);
	if (flags.length === 0) return null;
	return `Ignored leading goal flag(s): ${flags.join(", ")}. Move these flags to the start or end of the command, or use --force to run with the goal unchanged.`;
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
		contextFiles: [],
		withLastReply: false,
		force: false,
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
			case "--context": {
				if (next) { out.contextFiles.push(next); i++; }
				else out.unknownFlags.push("--context (missing value)");
				break;
			}
			case "--with-last-reply": out.withLastReply = true; break;
			case "--force": out.force = true; break;
			case "--live-qa": out.liveQa = true; break;
			case "--no-live-qa": out.liveQaOff = true; break;
			case "--live-qa-adapter": if (next) { out.liveQaAdapterId = next; i++; } break;
			case "--live-qa-acceptance": {
				if (next && next.startsWith("/")) { out.liveQaAcceptance = next; i++; }
				else if (!next || next.startsWith("-")) out.unknownFlags.push("--live-qa-acceptance (missing value)");
				else { out.unknownFlags.push(`--live-qa-acceptance ${next} (expected an absolute path)`); i++; }
				break;
			}
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
			case "--workflow": {
				if (next && ["direct", "checked", "led", "full"].includes(next)) out.workflowLevel = next as WorkflowLevel;
				else out.unknownFlags.push(`--workflow ${next ?? ""}`.trim());
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

/** `/orchestrate` usage text; `profilesPath` names the profiles file so the hint is actionable. */
export function usageText(profilesPath: string): string {
	return (
		"Usage: /orchestrate <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical]\n" +
		"       [--profile NAME] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--frontier ALIAS] [--model <capability>=ALIAS] [--effort LEVEL]\n" +
		"       [--quality-floor F] [--cost-aggressiveness C] [--max-retries R] [--interactive]\n" +
		"       [--context FILE ...] [--with-last-reply] [--force]\n" +
		"       [--live-qa | --no-live-qa] [--live-qa-adapter ID] [--live-qa-scope SCOPE]\n" +
		"       [--live-qa-acceptance /abs/path/to/manifest.json]\n" +
		"ALIAS is a short name (fable-5-1, opus-5-5, sonnet-5, gpt-6-sol, gpt-6-luna, astra) or provider/model. Profiles: " + profilesPath + "  (see /orchestrator-models)\n" +
		"--context FILE (repeatable) and --with-last-reply attach material the goal refers to; goals that look like they refer to outside context without either are stopped before triage unless --force is given."
	);
}

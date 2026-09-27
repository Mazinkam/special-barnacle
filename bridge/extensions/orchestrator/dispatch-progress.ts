import { METHOD } from "./models.ts";
import { extractCiRefs, isWaitCommand, type CiRef } from "./core/wait-stall.ts";
import { isCredentialName, redactCredentials, sanitizeControlChars } from "./core/text-safety.ts";

const DEFAULT_DISPATCH_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LEAD_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LEAD_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const LOOP_WINDOW_SIZE = 12;
const TOOL_CALL_RECORD_LIMIT = 256;
const NESTED_WORKER_LIMIT = 32;
const EVICTED_WORKER_ID_LIMIT = 256;
/**
 * Capabilities that wait on their own children and therefore get the lead
 * timeout policy. Every lead size from method.json `rules.lead_sizing`
 * (lead_small / lead / lead_large) is included, not just "lead".
 */
export const ORCHESTRATING_CAPABILITIES = new Set([
	"architect",
	"technical_lead",
	...Object.values(METHOD.rules.lead_sizing.sizes),
]);

type EnvLike = Record<string, string | undefined>;

type TimeoutEnvName =
	| "HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS"
	| "HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS"
	| "HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS"
	| "HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS";

export interface DispatchTimeoutPolicy {
	/** ms of no meaningful progress before expiry; Infinity for leaf (fixed-clock) dispatches */
	inactivityMs: number;
	/** absolute ceiling from spawn, ms; never resets */
	absoluteMs: number;
	/** "lead" = progress-aware, "leaf" = fixed clock */
	mode: "lead" | "leaf";
	/** human-readable configuration notes (fallbacks, legacy compat, clamps) */
	notes: string[];
}

function configuredTimeout(
	env: EnvLike,
	name: TimeoutEnvName,
	fallback: number,
	notes: string[],
): number {
	const raw = env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	const value = Math.trunc(parsed);
	if (!Number.isFinite(parsed) || parsed <= 0 || value <= 0) {
		notes.push(`${name}=${JSON.stringify(raw)} is invalid; using the default ${fallback}ms.`);
		return fallback;
	}
	return value;
}

/** Resolve dispatch budgets at dispatch time so callers can supply current environment values. */
export function resolveDispatchTimeoutPolicy(
	capability: string | undefined,
	env: EnvLike,
): DispatchTimeoutPolicy {
	const notes: string[] = [];
	if (!capability || !ORCHESTRATING_CAPABILITIES.has(capability)) {
		return {
			mode: "leaf",
			inactivityMs: Infinity,
			absoluteMs: configuredTimeout(env, "HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS", DEFAULT_DISPATCH_TIMEOUT_MS, notes),
			notes,
		};
	}

	const inactivityMs = configuredTimeout(
		env,
		"HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS",
		DEFAULT_LEAD_INACTIVITY_TIMEOUT_MS,
		notes,
	);
	let absoluteMs: number;
	if (env.HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS !== undefined) {
		absoluteMs = configuredTimeout(
			env,
			"HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS",
			DEFAULT_LEAD_MAX_TIMEOUT_MS,
			notes,
		);
	} else if (env.HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS !== undefined) {
		absoluteMs = configuredTimeout(
			env,
			"HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS",
			DEFAULT_LEAD_MAX_TIMEOUT_MS,
			notes,
		);
		notes.push("HUMAIN_ORCHESTRATOR_LEAD_TIMEOUT_MS is a legacy setting and is being used as the absolute ceiling.");
	} else {
		absoluteMs = DEFAULT_LEAD_MAX_TIMEOUT_MS;
	}

	let effectiveInactivityMs = inactivityMs;
	if (effectiveInactivityMs > absoluteMs) {
		notes.push(`Lead inactivity timeout ${effectiveInactivityMs}ms exceeds the absolute ceiling ${absoluteMs}ms; clamped to the ceiling.`);
		effectiveInactivityMs = absoluteMs;
	}
	return { mode: "lead", inactivityMs: effectiveInactivityMs, absoluteMs, notes };
}

export type ProgressKind = "progress" | "heartbeat" | "duplicate" | "loop" | "ignored";

export interface ProgressObservation {
	kind: ProgressKind;
	detail: string;
	/** set when this event is a nested worker snapshot */
	nested?: NestedWorkerSnapshot[];
}

export interface NestedWorkerSnapshot {
	taskId: string;
	agent: string;
	depth: number;
	turns: number;
	exitCode: number;
	costUsd: number;
	finished: boolean;
	latestText: string;
	changed: boolean;
}

export interface TimeoutWarning {
	kind: "inactivity" | "absolute";
	text: string;
}

export interface TimeoutCheck {
	expired: false | "inactivity" | "absolute";
	/** ms until the next possible expiry (min of both), >= 0 */
	nextCheckMs: number;
	inactiveMs: number;
	elapsedMs: number;
	/** newly-triggered warnings this check (rate-limited per contract §6); empty when none */
	warnings: TimeoutWarning[];
}

interface ToolCallRecord {
	toolCallId?: string;
	counted: boolean;
	completed: boolean;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
	}
	return value;
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(stableValue(value)) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function fingerprint(toolName: string, args: unknown): string {
	return `${toolName}:${stableJson(args)}`.slice(0, 2000);
}

/** A small deterministic hash is sufficient for novelty comparisons; no crypto/runtime dependency. */
function textHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assistantContent(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return typeof message.text === "string" ? message.text : "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const item = part as Record<string, unknown>;
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("");
}

/**
 * Recursively redacts every string leaf of `value` (bounded to 8 levels of
 * nesting — plenty for tool-args shapes, and enough to stop a maliciously
 * deep/cyclic-looking structure from doing unbounded work). Applied to tool
 * args BEFORE `stableJson`/`JSON.stringify` below: serializing first and
 * redacting the resulting string second would turn a value's `"` into `\"`,
 * which the quoted-value patterns in `redactCredentials` no longer
 * recognize as a quote — so `{command: 'echo password="two words secret"'}`
 * would serialize to `password=\"two words secret\"` and the unquoted-value
 * fallback would only eat up to the first space, leaking "words secret".
 * Redacting the raw string leaves first means the quotes `redactCredentials`
 * sees are still real, unescaped quotes.
 *
 * Fails closed in two further ways, so a value can never survive this walk
 * raw and unaccounted-for:
 * - an object KEY that is itself credential-shaped (`isCredentialName`, the
 *   same TOKEN/SECRET/PASSWORD/... name set `redactCredentials` uses) has its
 *   value replaced with `"[REDACTED]"` outright, regardless of the value's
 *   type (string, number, nested object, ...) — a credential must not
 *   survive just because it happens to be a number or an object;
 * - anything at or beyond the depth cap is replaced with `"[TRUNCATED]"`
 *   rather than returned as-is, and both arrays and objects are bounded to
 *   their first 50 entries, so a hostile deeply-nested/oversized structure
 *   can never be handed back unredacted or used to do unbounded work.
 */
const REDACT_DEEP_MAX_DEPTH = 8;
const REDACT_DEEP_MAX_ENTRIES = 50;

function redactDeep(value: unknown, depth = 0): unknown {
	if (depth > REDACT_DEEP_MAX_DEPTH) return "[TRUNCATED]";
	if (typeof value === "string") return redactCredentials(value);
	if (Array.isArray(value)) {
		return value.slice(0, REDACT_DEEP_MAX_ENTRIES).map((item) => redactDeep(item, depth + 1));
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(record)
				.slice(0, REDACT_DEEP_MAX_ENTRIES)
				.map(([key, val]) => [key, isCredentialName(key) ? "[REDACTED]" : redactDeep(val, depth + 1)]),
		);
	}
	return value;
}

function detailForTool(toolName: string, args: unknown): string {
	let rendered: string;
	if (typeof args === "string") rendered = redactCredentials(args);
	else if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) rendered = args.map((arg) => redactCredentials(arg)).join(" ");
	else if (args === undefined || args === null) rendered = "";
	// Redact string leaves BEFORE JSON-serializing (see `redactDeep`'s doc
	// comment) so a quoted credential inside a serialized object/array value
	// is redacted while its quotes are still real quotes, not `\"`.
	else rendered = stableJson(redactDeep(args));
	const raw = rendered ? `${toolName} ${rendered}` : toolName;
	// Redact again over the fully-assembled string (belt-and-suspenders: catches
	// anything redactDeep's string-leaf walk couldn't reach, e.g. credentials
	// spanning a key name and its value), then escape any control byte
	// (ESC/CR/LF) before this text is retained as `progressDetail` or surfaced
	// in a warning/expiry message (core/text-safety.ts).
	const detail = sanitizeControlChars(redactCredentials(raw));
	return detail.length > 200 ? `${detail.slice(0, 197)}…` : detail;
}

function formatDuration(ms: number): string {
	const durationMs = Math.max(0, ms);
	if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
	return `${Math.max(1, Math.round(durationMs / 60_000))}min`;
}

/** Cap on a stored/reported in-flight bash command, applied after redaction. */
const TOOL_IN_FLIGHT_COMMAND_LIMIT = 2000;

/** Cap on the command preview embedded in a warning/expiry message. */
const TOOL_IN_FLIGHT_PREVIEW_LIMIT = 120;

/**
 * Sanitize and cap a bash command before it is retained as "in flight":
 * `redactCredentials` (core/text-safety.ts) first, so a secret never sits in
 * memory/warnings/expiry text longer than necessary, then
 * `sanitizeControlChars` so an ESC/CR/LF byte in the raw command can never
 * forge terminal output or inject a fake Markdown heading into a rendered
 * warning, then the 2000-char cap.
 */
function sanitizeToolInFlightCommand(command: string): string {
	const safe = sanitizeControlChars(redactCredentials(command));
	return safe.length > TOOL_IN_FLIGHT_COMMAND_LIMIT
		? safe.slice(0, TOOL_IN_FLIGHT_COMMAND_LIMIT)
		: safe;
}

/** A short, already-sanitized preview for embedding in a warning/expiry message. */
function previewToolInFlightCommand(command: string): string {
	return command.length > TOOL_IN_FLIGHT_PREVIEW_LIMIT
		? `${command.slice(0, TOOL_IN_FLIGHT_PREVIEW_LIMIT - 1)}\u2026`
		: command;
}

export interface ToolInFlight {
	name: string;
	command: string;
	/** True when the raw (pre-redaction) command matched `isWaitCommand` — a poll/watch loop. */
	waitPattern?: boolean;
	/** CI pipeline/run references extracted from the raw (pre-redaction) command. */
	ciRefs?: CiRef[];
}

interface ToolInFlightRecord extends ToolInFlight {
	toolCallId?: string;
}

/** Map key for a bash tool call that started without a `toolCallId`. Only one
 *  such call can be tracked "in flight" at a time (see `bashInFlightById`'s
 *  doc comment); a fresh id-less bash start replaces whatever was there. */
const NO_TOOL_CALL_ID_KEY = "\u0000no-tool-call-id";

export class DispatchProgressTracker {
	private readonly policy: DispatchTimeoutPolicy;
	private readonly startedAt: number;
	private progressAt: number;
	private progressDetail = "dispatch started";
	private previousAssistantHash?: string;
	private readonly toolFingerprints: string[] = [];
	private readonly toolCallsById = new Map<string, ToolCallRecord>();
	private mostRecentToolCall?: ToolCallRecord;
	private repeatedToolCallCount = 0;
	/**
	 * Bash tool calls currently "in flight", keyed by `toolCallId` (or
	 * `NO_TOOL_CALL_ID_KEY` for a call that started without one) and kept in
	 * insertion order (a JS `Map`'s iteration order is its insertion order,
	 * and a `delete`-then-`set` on an existing key moves it to the end, exactly
	 * like `toolCallsById` above). `tool_execution_end` removes only the entry
	 * whose `toolCallId` matches; an end WITHOUT a `toolCallId` may only clear
	 * the id-less slot, and only when that end's own `toolName` is bash (or
	 * absent) — an id-less end for a different, non-bash tool must never
	 * clear an id-less bash call that is still genuinely running.
	 */
	private readonly bashInFlightById = new Map<string, ToolInFlightRecord>();
	private readonly workers = new Map<string, NestedWorkerSnapshot>();
	private readonly evictedWorkerIds = new Set<string>();
	private inactivityWarningFired = false;
	private absoluteWarningFired = false;

	constructor(policy: DispatchTimeoutPolicy, startedAt: number) {
		this.policy = policy;
		this.startedAt = startedAt;
		this.progressAt = startedAt;
	}

	get lastProgressAt(): number {
		return this.progressAt;
	}

	get lastProgressDetail(): string {
		return this.progressDetail;
	}

	get repeatedToolCalls(): number {
		return this.repeatedToolCallCount;
	}

	/**
	 * The most recently started bash tool call that has not yet ended (by
	 * `toolCallId`), sanitized and length-capped. `undefined` once that call's
	 * matching `tool_execution_end` has been observed, or when nothing bash-like
	 * is currently in flight. Observational only — never affects what counts as
	 * progress.
	 */
	toolInFlight(): ToolInFlight | undefined {
		const record = this.currentBashRecord();
		if (!record) return undefined;
		return { name: record.name, command: record.command, waitPattern: record.waitPattern, ciRefs: record.ciRefs };
	}

	/** The insertion-order-last (i.e. most recently started) still-active bash record, if any. */
	private currentBashRecord(): ToolInFlightRecord | undefined {
		let last: ToolInFlightRecord | undefined;
		for (const record of this.bashInFlightById.values()) last = record;
		return last;
	}

	observe(event: unknown, now: number): ProgressObservation {
		try {
			if (!event || typeof event !== "object" || Array.isArray(event)) return { kind: "ignored", detail: "malformed event" };
			const value = event as Record<string, unknown>;
			if (typeof value.type !== "string") return { kind: "ignored", detail: "event missing type" };

			switch (value.type) {
				case "tool_execution_start": {
					if (typeof value.toolName !== "string" || value.toolName.length === 0) {
						return { kind: "ignored", detail: "tool start missing toolName" };
					}
					const callFingerprint = fingerprint(value.toolName, value.args);
					const previousCount = this.toolFingerprints.filter((item) => item === callFingerprint).length;
					this.toolFingerprints.push(callFingerprint);
					if (this.toolFingerprints.length > LOOP_WINDOW_SIZE) this.toolFingerprints.shift();
					const counted = previousCount < 3;
					if (!counted) this.repeatedToolCallCount += 1;
					const record: ToolCallRecord = {
						toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
						counted,
						completed: false,
					};
					if (record.toolCallId !== undefined) {
						this.toolCallsById.delete(record.toolCallId);
						this.toolCallsById.set(record.toolCallId, record);
						if (this.toolCallsById.size > TOOL_CALL_RECORD_LIMIT) {
							const oldestToolCallId = this.toolCallsById.keys().next().value;
							if (oldestToolCallId !== undefined) this.toolCallsById.delete(oldestToolCallId);
						}
					}
					this.mostRecentToolCall = record;
					if (value.toolName.toLowerCase() === "bash") {
						const args = value.args;
						const command = args && typeof args === "object" && !Array.isArray(args)
							? (args as Record<string, unknown>).command
							: undefined;
						if (typeof command === "string" && command.length > 0) {
							// Wait-detection and CI-ref extraction run against the RAW command,
							// never the redacted/capped preview retained below — a secret
							// substring landing inside a `sleep`/`glab` argument must not be
							// able to change whether this looks like a wait loop, and a CI id
							// past the redacted preview's cap must still be found.
							const key = record.toolCallId ?? NO_TOOL_CALL_ID_KEY;
							this.bashInFlightById.delete(key);
							this.bashInFlightById.set(key, {
								toolCallId: record.toolCallId,
								name: value.toolName,
								command: sanitizeToolInFlightCommand(command),
								waitPattern: isWaitCommand(command),
								ciRefs: extractCiRefs(command),
							});
							if (this.bashInFlightById.size > TOOL_CALL_RECORD_LIMIT) {
								const oldestKey = this.bashInFlightById.keys().next().value;
								if (oldestKey !== undefined) this.bashInFlightById.delete(oldestKey);
							}
						}
					}
					const detail = detailForTool(value.toolName, value.args);
					return counted ? this.progress(detail, now) : { kind: "loop", detail };
				}
				case "tool_execution_end": {
					const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
					const endToolName = typeof value.toolName === "string" ? value.toolName : undefined;
					const record = toolCallId === undefined
						? this.mostRecentToolCall
						: this.toolCallsById.get(toolCallId);
					if (toolCallId !== undefined) this.toolCallsById.delete(toolCallId);
					else if (record?.toolCallId !== undefined) this.toolCallsById.delete(record.toolCallId);
					if (toolCallId !== undefined) {
						this.bashInFlightById.delete(toolCallId);
					} else if (endToolName === undefined || endToolName.toLowerCase() === "bash") {
						// An id-less end may only clear the id-less slot when it is itself
						// bash-shaped (or carries no toolName at all, in which case there is
						// no basis to say it is NOT the bash call); an id-less end for a
						// clearly different, non-bash tool must never clear a still-running
						// id-less bash call.
						this.bashInFlightById.delete(NO_TOOL_CALL_ID_KEY);
					}
					if (value.isError === true) return { kind: "heartbeat", detail: "tool execution failed" };
					if (!record || !record.counted || record.completed) {
						return { kind: "heartbeat", detail: "tool execution ended without counted work" };
					}
					record.completed = true;
					return this.progress("tool execution completed", now);
				}
				case "message_end": {
					const message = value.message;
					if (!message || typeof message !== "object" || Array.isArray(message)) {
						return { kind: "ignored", detail: "message_end missing message" };
					}
					const messageValue = message as Record<string, unknown>;
					if (messageValue.role !== "assistant") return { kind: "heartbeat", detail: "non-assistant message ended" };
					const text = assistantContent(messageValue);
					if (!text.trim()) return { kind: "heartbeat", detail: "empty assistant message" };
					const hash = textHash(text);
					if (hash === this.previousAssistantHash) return { kind: "duplicate", detail: "repeated assistant text" };
					this.previousAssistantHash = hash;
					const detail = text.trim();
					return this.progress(detail.length > 160 ? `${detail.slice(0, 157)}…` : detail, now);
				}
				case "tool_execution_update": {
					const partialResult = value.partialResult;
					if (!partialResult || typeof partialResult !== "object" || Array.isArray(partialResult)) {
						return { kind: "heartbeat", detail: "tool execution update" };
					}
					const details = (partialResult as Record<string, unknown>).details;
					if (!details || typeof details !== "object" || Array.isArray(details)) {
						return { kind: "heartbeat", detail: "tool execution update" };
					}
					const detailsValue = details as Record<string, unknown>;
					const results = Array.isArray(detailsValue.results) ? detailsValue.results : [];
					const snapshots: NestedWorkerSnapshot[] = [];
					let changedAny = false;
					for (const result of results) {
						if (!result || typeof result !== "object" || Array.isArray(result)) continue;
						const item = result as Record<string, unknown>;
						if (typeof item.taskId !== "string") continue;
						const usage = item.usage && typeof item.usage === "object" && !Array.isArray(item.usage)
							? item.usage as Record<string, unknown>
							: {};
						const previous = this.workers.get(item.taskId);
						const incomingTurns = finiteNumber(usage.turns, 0);
						const incomingText = typeof item.latestText === "string" ? item.latestText : "";
						const incomingExitCode = finiteNumber(item.exitCode, -1);
						const placeholder = Boolean(previous && (
							incomingTurns < previous.turns ||
							(!incomingText && Boolean(previous.latestText)) ||
							(previous.exitCode !== -1 && incomingExitCode === -1)
						));
						const wasEvicted = this.evictedWorkerIds.has(item.taskId);
						let snapshot: NestedWorkerSnapshot;
						let changed: boolean;
						if (previous && placeholder) {
						// Parallel result lists can contain stale/empty placeholders. Keep
							// the authoritative snapshot intact and do not call it progress.
							snapshot = { ...previous, changed: false };
							changed = false;
						} else if (!previous) {
							snapshot = {
								taskId: item.taskId,
								agent: typeof item.agent === "string" ? item.agent : "unknown",
								depth: finiteNumber(item.depth, 0),
								turns: incomingTurns,
								exitCode: incomingExitCode,
								costUsd: finiteNumber(usage.cost, 0),
								latestText: incomingText,
								finished: incomingExitCode !== -1,
								changed: false,
							};
							changed = !wasEvicted;
						} else {
							const terminalTransition = previous.exitCode === -1 && incomingExitCode !== -1;
							const incomingTextChanged = Boolean(incomingText) && textHash(incomingText) !== textHash(previous.latestText);
							const turnsIncreased = incomingTurns > previous.turns;
							const finished = previous.finished || incomingExitCode !== -1;
							const newlyFinished = finished && !previous.finished;
							snapshot = {
								...previous,
								agent: typeof item.agent === "string" ? item.agent : previous.agent,
								depth: finiteNumber(item.depth, previous.depth),
								turns: Math.max(previous.turns, incomingTurns),
								exitCode: terminalTransition || previous.exitCode === -1
									? incomingExitCode
									: incomingExitCode === -1 ? previous.exitCode : incomingExitCode,
								costUsd: finiteNumber(usage.cost, previous.costUsd),
								latestText: incomingTextChanged ? incomingText : previous.latestText,
								finished,
								changed: false,
							};
							changed = !wasEvicted && (turnsIncreased || terminalTransition || incomingTextChanged || newlyFinished);
						}
						snapshot.changed = changed;
						if (!previous && this.workers.size >= NESTED_WORKER_LIMIT) {
							const oldestTaskId = this.workers.keys().next().value;
							if (oldestTaskId !== undefined) {
								this.workers.delete(oldestTaskId);
								this.evictedWorkerIds.delete(oldestTaskId);
								this.evictedWorkerIds.add(oldestTaskId);
								if (this.evictedWorkerIds.size > EVICTED_WORKER_ID_LIMIT) {
									const oldestEvictedId = this.evictedWorkerIds.values().next().value;
									if (oldestEvictedId !== undefined) this.evictedWorkerIds.delete(oldestEvictedId);
								}
							}
						}
						this.evictedWorkerIds.delete(snapshot.taskId);
						this.workers.set(snapshot.taskId, snapshot);
						snapshots.push(snapshot);
						changedAny ||= changed;
					}
					const taskEvents = Array.isArray(detailsValue.taskEvents)
						? detailsValue.taskEvents
						: [];
					const completedTaskIds = new Set<string>();
					for (const taskEvent of taskEvents) {
						if (!taskEvent || typeof taskEvent !== "object" || Array.isArray(taskEvent)) continue;
						const item = taskEvent as Record<string, unknown>;
						if (typeof item.taskId !== "string" || !["complete", "completed", "done", "end"].includes(String(item.type))) continue;
						const worker = this.workers.get(item.taskId);
						if (!worker || worker.finished) continue;
						worker.finished = true;
						worker.changed = true;
						completedTaskIds.add(item.taskId);
						changedAny = true;
					}
					const changedTaskIds = new Set([
						...snapshots.filter((snapshot) => snapshot.changed).map(({ taskId }) => taskId),
						...completedTaskIds,
					]);
					const currentSnapshots = this.nestedWorkers().map((snapshot) => ({
						...snapshot,
						changed: changedTaskIds.has(snapshot.taskId),
					}));
					if (changedAny) {
						const changedTasks = [...changedTaskIds].join(", ");
						return { ...this.progress(`nested worker progress${changedTasks ? `: ${changedTasks}` : ""}`, now), nested: currentSnapshots };
					}
					return { kind: snapshots.length > 0 ? "duplicate" : "heartbeat", detail: "nested worker snapshot unchanged", nested: currentSnapshots };
				}
				case "message_start":
					return { kind: "heartbeat", detail: "message started" };
				case "agent_end":
				case "agent_settled":
				case "turn_end":
					return { kind: "heartbeat", detail: value.type };
				default:
					return { kind: "heartbeat", detail: `unknown event: ${value.type}` };
			}
		} catch {
			return { kind: "ignored", detail: "malformed event" };
		}
	}

	peek(now: number): Omit<TimeoutCheck, "warnings"> {
		const elapsedMs = Math.max(0, now - this.startedAt);
		const inactiveMs = Math.max(0, now - this.progressAt);
		const absoluteRemaining = Math.max(0, this.policy.absoluteMs - elapsedMs);
		const inactivityRemaining = this.policy.mode === "leaf"
			? Infinity
			: Math.max(0, this.policy.inactivityMs - inactiveMs);
		const expired: TimeoutCheck["expired"] = elapsedMs >= this.policy.absoluteMs
			? "absolute"
			: this.policy.mode === "lead" && inactiveMs >= this.policy.inactivityMs
				? "inactivity"
				: false;
		const nextInactivityWarning = this.policy.mode === "lead" && !this.inactivityWarningFired
			? Math.max(0, this.policy.inactivityMs * 0.75 - inactiveMs)
			: Infinity;
		const nextAbsoluteWarning = !this.absoluteWarningFired
			? Math.max(0, this.policy.absoluteMs * 0.9 - elapsedMs)
			: Infinity;
		return {
			expired,
			nextCheckMs: expired ? 0 : Math.max(0, Math.min(inactivityRemaining, absoluteRemaining, nextInactivityWarning, nextAbsoluteWarning)),
			inactiveMs,
			elapsedMs,
		};
	}

	check(now: number): TimeoutCheck {
		const elapsedMs = Math.max(0, now - this.startedAt);
		const inactiveMs = Math.max(0, now - this.progressAt);
		const absoluteRemaining = Math.max(0, this.policy.absoluteMs - elapsedMs);
		const inactivityRemaining = this.policy.mode === "leaf"
			? Infinity
			: Math.max(0, this.policy.inactivityMs - inactiveMs);
		const warnings: TimeoutWarning[] = [];
		if (this.policy.mode === "lead" && !this.inactivityWarningFired && inactiveMs >= this.policy.inactivityMs * 0.75) {
			this.inactivityWarningFired = true;
			const waitHint = this.waitStallHint();
			warnings.push({
				kind: "inactivity",
				text: `⚠ no meaningful progress for ${formatDuration(inactiveMs)} (limit ${formatDuration(this.policy.inactivityMs)}; ${formatDuration(inactivityRemaining)} remaining; raise HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS) — last: ${this.progressDetail}${waitHint ? ` — ${waitHint}` : ""}`,
			});
		}
		if (!this.absoluteWarningFired && elapsedMs >= this.policy.absoluteMs * 0.9) {
			this.absoluteWarningFired = true;
			const envName = this.policy.mode === "lead"
				? "HUMAIN_ORCHESTRATOR_LEAD_MAX_TIMEOUT_MS"
				: "HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS";
			warnings.push({
				kind: "absolute",
				text: `⚠ dispatch has run for ${formatDuration(elapsedMs)} (absolute limit ${formatDuration(this.policy.absoluteMs)}; ${formatDuration(absoluteRemaining)} remaining; raise ${envName})`,
			});
		}

		// After the flags above are updated, peek() yields exactly the post-fire
		// schedule; delegating keeps one owner of the expiry/nextCheck arithmetic.
		return { ...this.peek(now), warnings };
	}

	nestedWorkers(): NestedWorkerSnapshot[] {
		return [...this.workers.values()].map((snapshot) => ({ ...snapshot, changed: false }));
	}

	describeExpiry(reason: "inactivity" | "absolute", capability: string | undefined, now: number): string {
		const capabilityLabel = capability ?? "unknown";
		if (reason === "absolute") {
			return `dispatch exceeded absolute ceiling ${formatDuration(this.policy.absoluteMs)} (capability=${capabilityLabel})`;
		}
		const inactiveForMs = Math.max(0, now - this.progressAt);
		const waitHint = this.waitStallHint();
		const base = `dispatch timed out after ${formatDuration(this.policy.inactivityMs)} without meaningful progress (last progress: ${this.progressDetail} ${formatDuration(inactiveForMs)} ago; capability=${capabilityLabel})`;
		return waitHint ? `${base} — ${waitHint}` : base;
	}

	/**
	 * When a bash tool call is currently in flight and its command matches
	 * `isWaitCommand` (a poll/watch loop — e.g. the incident command
	 * `for i in $(seq 1 40); do glab ci get -p 219469; sleep 60; done`), returns a
	 * hint that the inactivity the watchdog is seeing is most likely the lead
	 * legitimately blocked on that wait command, not a stuck process. `undefined`
	 * for any other in-flight tool (or none), leaving the base warning/expiry
	 * text unchanged.
	 */
	private waitStallHint(): string | undefined {
		const inFlight = this.currentBashRecord();
		if (!inFlight || !inFlight.waitPattern) return undefined;
		const preview = previewToolInFlightCommand(inFlight.command);
		return `the lead appears to be blocked waiting (e.g. on CI) in a wait loop (\`${preview}\`); leads must not block on CI — list it under "## Pending external checks" in the final report instead; raising HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS is only a stopgap`;
	}

	private progress(detail: string, now: number): ProgressObservation {
		this.progressAt = now;
		this.progressDetail = detail;
		this.inactivityWarningFired = false;
		return { kind: "progress", detail };
	}
}

export interface LeadTimeoutConfig {
	inactivityMs: number;
	maxMs: number;
	notes: string[];
}

/**
 * Convenience view of the lead policy for callers that think in
 * `{ inactivityMs, maxMs }`. Delegates to `resolveDispatchTimeoutPolicy` so
 * there is exactly one source of truth for defaults, legacy compat, and clamping.
 */
export function resolveLeadTimeoutConfig(env: EnvLike): LeadTimeoutConfig {
	const policy = resolveDispatchTimeoutPolicy("lead", env);
	return { inactivityMs: policy.inactivityMs, maxMs: policy.absoluteMs, notes: policy.notes };
}

/**
 * Apply an explicit `{ inactivityMs, maxMs }` override (test seam / caller
 * override) on top of a resolved lead policy. Invalid values are ignored with a
 * note; the ceiling is never raised implicitly — inactivity is clamped down.
 */
export function applyLeadTimeoutOverride(
	policy: DispatchTimeoutPolicy,
	override: { inactivityMs?: unknown; maxMs?: unknown } | undefined,
): DispatchTimeoutPolicy {
	if (!override || policy.mode !== "lead") return policy;
	const notes = [...policy.notes];
	const pick = (name: "inactivityMs" | "maxMs", value: unknown, fallback: number): number => {
		if (value === undefined) return fallback;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.max(1, Math.trunc(value));
		notes.push(`leadTimeouts.${name}=${String(value)} is invalid; using ${fallback}ms.`);
		return fallback;
	};
	let inactivityMs = pick("inactivityMs", override.inactivityMs, policy.inactivityMs);
	const absoluteMs = pick("maxMs", override.maxMs, policy.absoluteMs);
	if (inactivityMs > absoluteMs) {
		notes.push(`Lead inactivity timeout ${inactivityMs}ms exceeds the absolute ceiling ${absoluteMs}ms; clamped to the ceiling.`);
		inactivityMs = absoluteMs;
	}
	return { mode: "lead", inactivityMs, absoluteMs, notes };
}

export interface InterruptionReport {
	taskId: string;
	reason: "inactivity_timeout" | "absolute_timeout" | "cancelled";
	elapsedMs: number;
	sinceLastProgressMs: number;
	turns: number;
	toolCalls: number;
	repeatedToolCalls: number;
	lastProgress: string | undefined;
	nestedWorkers: Array<{ id: string; turns: number; finished: boolean }>;
	partialText: string;
	verified: false;
}

export interface InterruptionReportInput {
	taskId: string;
	reason: InterruptionReport["reason"];
	startedAt: number;
	now: number;
	turns: number;
	toolCalls: number;
	partialText: string;
	tracker: DispatchProgressTracker;
}

/** Build a bounded, explicitly unverified record from the dispatch's tracker snapshot. */
export function buildInterruptionReport(input: InterruptionReportInput): InterruptionReport {
	const { tracker, now } = input;
	const lastProgress = tracker.lastProgressDetail === "dispatch started" ? undefined : tracker.lastProgressDetail;
	return {
		taskId: input.taskId,
		reason: input.reason,
		elapsedMs: Math.max(0, now - input.startedAt),
		sinceLastProgressMs: Math.max(0, now - tracker.lastProgressAt),
		turns: input.turns,
		toolCalls: input.toolCalls,
		repeatedToolCalls: tracker.repeatedToolCalls,
		lastProgress,
		nestedWorkers: tracker.nestedWorkers().map((worker) => ({
			id: worker.taskId,
			turns: worker.turns,
			finished: worker.finished,
		})),
		partialText: input.partialText.slice(-2000),
		verified: false,
	};
}

export function summarizeInterruption(report: InterruptionReport): string {
	const reason = report.reason === "inactivity_timeout"
		? "inactivity"
		: report.reason === "absolute_timeout" ? "absolute" : "cancelled";
	return `UNVERIFIED PARTIAL WORK — ${reason} (taskId: ${report.taskId})`;
}

/** Render an honest, explicitly unverified summary of work at interruption. */
export function renderInterruptionReport(report: InterruptionReport): string {
	const reason = report.reason === "inactivity_timeout"
		? "inactivity"
		: report.reason === "absolute_timeout" ? "absolute" : "cancelled";
	const partialText = report.partialText.slice(-2000);
	const workers = report.nestedWorkers.length === 0
		? "none observed"
		: report.nestedWorkers.map((worker) =>
			`${worker.id} (${worker.turns} turns, ${worker.finished ? "finished" : "running"})`,
		).join(", ");
	return [
		`UNVERIFIED PARTIAL WORK — ${reason}`,
		`taskId: ${report.taskId}`,
		`elapsedMs: ${report.elapsedMs}`,
		`sinceLastProgressMs: ${report.sinceLastProgressMs}`,
		`turns: ${report.turns}`,
		`toolCalls: ${report.toolCalls}`,
		`repeatedToolCalls: ${report.repeatedToolCalls}`,
		`lastProgress: ${report.lastProgress ?? "(none recorded)"}`,
		`nestedWorkers: ${workers}`,
		`verified: ${report.verified}`,
		`partialText: ${partialText}`,
	].join("\n");
}

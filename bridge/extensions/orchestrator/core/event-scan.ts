/**
 * One pass over a child's `--mode json` event stream (events.jsonl), giving the
 * facts failover needs: tool activity, the harness error, the last assistant text,
 * nested subagent workers and their onFailure settings. Pure: callers supply the lines.
 */
export interface NestedWorker { id: string; ok: boolean; summary: string }
export interface SubagentCall { toolCallId: string; tasks: Array<{ id?: string; hasRetry: boolean }> }
export interface EventScan {
	toolCalls: number;
	toolInFlight: boolean;
	lastErrorMessage?: string;
	lastAssistantText: string;
	finishedWorkers: NestedWorker[];
	unfinishedWorkers: string[];
	subagentCalls: SubagentCall[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => asText((b as { text?: unknown }).text))
		.join("\n");
}

// Retained text fields are bounded so a chatty or adversarial child process
// cannot grow an unbounded string in orchestrator memory or in the handoff it
// feeds downstream. Counts (toolCalls, finishedWorkers.length, etc.) are never
// capped -- only the text payloads are.
const LAST_ASSISTANT_TEXT_TAIL_LIMIT = 32000;
const LAST_ERROR_MESSAGE_HEAD_LIMIT = 2000;
const ID_LIMIT = 200;

function asId(v: unknown): string {
	if (typeof v === "string") return v.slice(0, ID_LIMIT);
	if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, ID_LIMIT);
	return "";
}

/** Same bound as asId, but for the optional `tasks[].id` field, which stays
 * undefined (rather than becoming "") when it is missing or not a string --
 * callers fall back to a synthesized `${toolCallId}#${i}` id when it is undefined. */
function asOptionalId(v: unknown): string | undefined {
	return typeof v === "string" ? v.slice(0, ID_LIMIT) : undefined;
}

function asText(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function lastAssistantTextOf(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown } | null;
		if (m?.role === "assistant") {
			const t = textOf(m.content).trim();
			if (t) return t;
		}
	}
	return "";
}

const firstLine = (s: string, max = 160) => (s.split("\n")[0] ?? "").slice(0, max);

export function scanEvents(lines: Iterable<string>): EventScan {
	const inFlight = new Set<string>();
	const pendingSubagent = new Map<string, string[]>();
	const subagentCalls: SubagentCall[] = [];
	const finishedWorkers: NestedWorker[] = [];
	let toolCalls = 0;
	let lastAssistantText = "";
	let lastErrorMessage: string | undefined;
	for (const line of lines) {
		if (!line || !line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e || typeof e !== "object") continue;
		if (e.type === "tool_execution_start") {
			const id = asId(e.toolCallId);
			inFlight.add(id);
			if (e.toolName === "subagent") {
				const args = e.args && typeof e.args === "object" ? e.args : {};
				const tasks: SubagentCall["tasks"] = Array.isArray(args.tasks)
					? args.tasks.map((t: any) => ({
						id: asOptionalId(t?.id),
						hasRetry: typeof t?.onFailure?.retryWith?.model === "string" && t.onFailure.retryWith.model.length > 0,
					}))
					: Array.isArray(args.chain)
						? args.chain.map(() => ({ id: undefined, hasRetry: false }))
						: [{ id: undefined, hasRetry: false }];
				subagentCalls.push({ toolCallId: id, tasks });
				pendingSubagent.set(id, tasks.map((t, i) => t.id ?? `${id}#${i}`));
			}
		} else if (e.type === "tool_execution_end") {
			const id = asId(e.toolCallId);
			inFlight.delete(id);
			toolCalls++;
			if (e.toolName === "subagent") {
				pendingSubagent.delete(id);
				const results = Array.isArray(e.result?.details?.results) ? e.result.details.results : [];
				for (const r of results) {
					finishedWorkers.push({
						id: asId(r?.taskId) || asId(r?.agent) || "?",
						ok: r?.exitCode === 0,
						summary: firstLine(lastAssistantTextOf(r?.messages)),
					});
				}
			}
		} else if (e.type === "message_end" && e.message?.role === "assistant") {
			const t = textOf(e.message.content).trim();
			// Tail-bounded: a later handoff summary that itself takes a tail slice
			// of lastAssistantText still gets the most recent content either way.
			if (t) lastAssistantText = t.slice(-LAST_ASSISTANT_TEXT_TAIL_LIMIT);
			if (e.message.stopReason === "error" && typeof e.message.errorMessage === "string") {
				lastErrorMessage = e.message.errorMessage.slice(0, LAST_ERROR_MESSAGE_HEAD_LIMIT);
			}
		}
	}
	return {
		toolCalls,
		toolInFlight: inFlight.size > 0,
		lastErrorMessage,
		lastAssistantText,
		finishedWorkers,
		unfinishedWorkers: [...pendingSubagent.values()].flat(),
		subagentCalls,
	};
}

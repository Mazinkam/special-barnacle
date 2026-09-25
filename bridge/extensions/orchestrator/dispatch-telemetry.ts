/**
 * Per-dispatch telemetry: pure counting logic over the child event stream a
 * dispatch already parses (`tool_execution_start` / assistant `message_end`
 * usage). Observational only — nothing here changes what gets dispatched or
 * how; it only counts what already happened so `dispatchRecordsFor` can put a
 * summary on the dispatch's `model_call` row.
 *
 * No I/O, no HT imports: keeps this unit-testable with plain data and lets
 * `index.ts` decide when/how to feed it real events.
 */

/** `\bsleep\s+\d` — a bash command that sleeps for a duration, i.e. is polling
 *  rather than doing work. Detected only to COUNT it; it is never rewritten or
 *  blocked. */
const SLEEP_COMMAND_PATTERN = /\bsleep\s+\d/;

/**
 * True when a tool call is an "observable poll": either a direct call to the
 * `orchestrator_status` tool, or a `bash` call whose command sleeps for a
 * literal duration. Both are legitimate ways to wait; this only counts them
 * so a later pass can see how much of a dispatch's own tool budget went to
 * waiting instead of working.
 */
export function isObservablePollCall(toolName: string, args: unknown): boolean {
	if (toolName === "orchestrator_status") return true;
	if (toolName !== "bash") return false;
	const command = commandOf(args);
	return typeof command === "string" && SLEEP_COMMAND_PATTERN.test(command);
}

function commandOf(args: unknown): unknown {
	if (!args || typeof args !== "object") return undefined;
	return (args as Record<string, unknown>).command;
}

/** Flat, JSON-serializable telemetry fields attached to a dispatch's `model_call` row. */
export interface DispatchTelemetryFields {
	turns: number;
	/** Max per-message `usage.totalTokens` seen; `null` (never `0`) when no usage was ever observed. */
	peak_context_tokens: number | null;
	/** Fixed label for how `peak_context_tokens` was derived — the provider's own reported total, per message, not a windowed or cumulative figure. */
	context_token_semantics: "provider_total_tokens_per_message";
	own_tool_calls: number;
	own_tool_mix: Record<string, number>;
	delegated_subagent_calls: number;
	observable_poll_calls: number;
	dispatch_phase?: string;
}

/**
 * Accumulates one dispatch's own tool-call mix and peak context tokens across
 * the child event stream. One instance per dispatch (mirrors `NestedCostTracker`
 * and `DispatchProgressTracker`, which are also per-dispatch, mutable, event-fed
 * trackers in `index.ts`).
 */
export class DispatchTelemetryTracker {
	private peakContextTokens: number | null = null;
	private readonly toolMix: Record<string, number> = {};
	private ownToolCalls = 0;
	private delegatedSubagentCalls = 0;
	private observablePollCalls = 0;

	/** Feed one `tool_execution_start` event's `toolName`/`args`. */
	observeToolCall(toolName: string, args: unknown): void {
		this.ownToolCalls += 1;
		this.toolMix[toolName] = (this.toolMix[toolName] ?? 0) + 1;
		if (toolName === "subagent") this.delegatedSubagentCalls += 1;
		if (isObservablePollCall(toolName, args)) this.observablePollCalls += 1;
	}

	/** Feed one assistant `message_end`'s `usage.totalTokens` (may be undefined/0/NaN). */
	observeContextTokens(totalTokens: unknown): void {
		if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
		if (this.peakContextTokens === null || totalTokens > this.peakContextTokens) {
			this.peakContextTokens = totalTokens;
		}
	}

	/** Snapshot as the flat fields `dispatchRecordsFor` attaches to the `model_call` row.
	 *  `turns` is supplied by the caller (it already tracks `usage.turns` itself; this class
	 *  does not duplicate that counter). `phase` is the task-supplied optional label. */
	fields(turns: number, phase?: string): DispatchTelemetryFields {
		return {
			turns,
			peak_context_tokens: this.peakContextTokens,
			context_token_semantics: "provider_total_tokens_per_message",
			own_tool_calls: this.ownToolCalls,
			own_tool_mix: { ...this.toolMix },
			delegated_subagent_calls: this.delegatedSubagentCalls,
			observable_poll_calls: this.observablePollCalls,
			...(phase ? { dispatch_phase: phase } : {}),
		};
	}
}

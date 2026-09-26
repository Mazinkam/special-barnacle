/**
 * The one accumulator for a dispatched child's `--mode json` event stream
 * (B4.5 step 3 — extracted from `runSubagentProcess` in index.ts).
 *
 * Before this module existed, `runSubagentProcess` and `RunSession.onChildEvent`
 * (the run's live status board) each summed cost and turns from the same
 * `message_end` events independently — `RunSession`'s tally purely for display,
 * `runSubagentProcess`'s tally as the authoritative result. They always agreed
 * (same events, same `reportedCost` formula, same "assistant `message_end`"
 * gate), so this was never an observable double-count of money billed or
 * displayed; it was two copies of the same arithmetic. `ChildEventAccumulator`
 * is now the only place that runs that arithmetic: callers absorb() each
 * event once and get back a delta describing what changed, instead of
 * re-deriving it from the raw event themselves.
 */

export interface ChildUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** What one absorbed event changed, for a consumer that needs to react to it. */
export interface ChildEventDelta {
	/** Set when this event is `agent_settled`. */
	settled?: true;
	/** Set when this event is `agent_end`. */
	ended?: true;
	/** The event's own top-level `stopReason` field, when present as a string. */
	topLevelStopReason?: string;
	/** Set exactly when this event completed an assistant turn (`message_end`, `message.role === "assistant"`). */
	turn?: ChildTurnDelta;
}

export interface ChildTurnDelta {
	/** `reportedCost(msg.usage.cost.total) ?? 0` for this turn: the amount just added to `usage.cost`. */
	costDelta: number;
	/** True when the turn carried a `usage` block at all (turns/tokens/cost were counted for it). */
	hadUsage: boolean;
	model?: string;
	stopReason?: string;
	/** Present only for a provider error/abort turn that also carried a non-empty `errorMessage`. */
	errorMessage?: string;
	errorKind?: "error" | "aborted";
	/** The turn's trimmed assistant text, if it had any. */
	text?: string;
}

/** One `--mode json` content block of an assistant message. Untyped over the wire; only `type`/`text` are read. */
interface ChildContentBlock {
	type?: string;
	text?: string;
}

/** One assistant `message_end` event's `message` field, as received over `--mode json`. */
interface ChildAssistantMessage {
	role?: string;
	model?: string;
	responseModel?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: unknown };
		totalTokens?: number;
	};
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

/** One raw `--mode json` protocol event. Untyped over the wire (see child-process.ts); only the fields every
 * absorb() call reads, plus the tool/message-lifecycle fields `RunSession.onChildEvent` (run/session.ts) reads
 * for the live status board, are declared here. */
export interface ChildStreamEvent {
	type?: string;
	stopReason?: string;
	message?: ChildAssistantMessage;
	/** `tool_execution_start`/`tool_execution_end` fields. */
	toolName?: string;
	args?: unknown;
	isError?: boolean;
}

function reportedCost(total: unknown): number | undefined {
	return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

/** Accumulates cost/usage/turns for one dispatch's child event stream. Pure: no I/O, no globals. */
export class ChildEventAccumulator {
	readonly usage: ChildUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	model: string | undefined;
	/** Latest of the event stream's own top-level `stopReason` and any turn's `msg.stopReason` (turn wins when both fire on the same event, matching the original single-pass order). */
	stopReason: string | undefined;
	/** True only when every turn that has arrived so far explicitly reported a valid cost (including $0). */
	costReported = false;
	sawAgentSettled = false;
	sawAgentEnd = false;

	/** Absorb one parsed `--mode json` event. Returns what changed. */
	absorb(event: ChildStreamEvent): ChildEventDelta {
		const delta: ChildEventDelta = {};
		if (event?.type === "agent_settled") {
			this.sawAgentSettled = true;
			delta.settled = true;
		}
		if (event?.type === "agent_end") {
			this.sawAgentEnd = true;
			delta.ended = true;
		}
		if (typeof event?.stopReason === "string") {
			this.stopReason = event.stopReason;
			delta.topLevelStopReason = event.stopReason;
		}
		// `message_end` is the authoritative per-turn record. `turn_end` and
		// `agent_end` repeat the same assistant messages, so ignoring them keeps
		// usage from being double-counted.
		if (event?.type === "message_end" && event.message?.role === "assistant") {
			delta.turn = this.absorbAssistantMessage(event.message);
		}
		return delta;
	}

	private absorbAssistantMessage(msg: ChildAssistantMessage): ChildTurnDelta {
		if (msg.model) this.model = msg.responseModel ?? msg.model;
		let costDelta = 0;
		const hadUsage = Boolean(msg.usage);
		if (msg.usage) {
			this.usage.turns += 1;
			this.usage.input += msg.usage.input || 0;
			this.usage.output += msg.usage.output || 0;
			this.usage.cacheRead += msg.usage.cacheRead || 0;
			this.usage.cacheWrite += msg.usage.cacheWrite || 0;
			const cost = reportedCost(msg.usage.cost?.total);
			this.costReported = (this.usage.turns === 1 || this.costReported) && cost !== undefined;
			costDelta = cost ?? 0;
			this.usage.cost += costDelta;
			this.usage.contextTokens = msg.usage.totalTokens || this.usage.contextTokens;
		}
		if (msg.stopReason) this.stopReason = msg.stopReason;
		let errorMessage: string | undefined;
		let errorKind: "error" | "aborted" | undefined;
		// A provider error arrives as a turn with stopReason "error" and an
		// errorMessage, not on stderr (the child still exits 0 in json mode).
		if ((msg.stopReason === "error" || msg.stopReason === "aborted") && typeof msg.errorMessage === "string" && msg.errorMessage) {
			errorMessage = msg.errorMessage;
			errorKind = msg.stopReason;
		}
		let text: string | undefined;
		if (Array.isArray(msg.content)) {
			const joined = (msg.content as ChildContentBlock[])
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text as string)
				.join("\n")
				.trim();
			if (joined) text = joined;
		} else if (typeof msg.content === "string" && msg.content.trim()) {
			text = msg.content.trim();
		}
		return { costDelta, hadUsage, model: this.model, stopReason: msg.stopReason, errorMessage, errorKind, text };
	}
}

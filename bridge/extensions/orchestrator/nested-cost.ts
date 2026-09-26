/**
 * Spend of `subagent` calls a dispatched child (a lead) makes itself. Those grandchildren
 * are not bridge dispatches, so their cost never reaches the child's own `message_end`
 * usage; it only appears in the child's `subagent` tool events as `details.results[].usage.cost`.
 * Updates carry cumulative snapshots, so the tracker keeps the latest cost per result and sums.
 * Pure: no I/O.
 */

/** One nested-result entry inside a `subagent` tool event's `details.results[]`. */
interface NestedSubagentResult {
	taskId?: unknown;
	usage?: { cost?: unknown };
}

/** One raw `--mode json` `subagent` tool event, as absorbed by `observe()`. Untyped over the
 * wire (see child-events.ts's `ChildStreamEvent`); only the fields read here are declared, and
 * `partialResult`/`result` are read defensively since the protocol carries other, unrelated
 * shapes (e.g. `result: { content: [...] }`) under the same field names. */
export interface NestedCostEvent {
	type?: string;
	toolName?: string;
	toolCallId?: unknown;
	partialResult?: unknown;
	result?: unknown;
}

function resultsOf(event: NestedCostEvent): NestedSubagentResult[] | undefined {
	const payload = event?.type === "tool_execution_update" ? event.partialResult : event?.type === "tool_execution_end" ? event.result : undefined;
	if (typeof payload !== "object" || payload === null) return undefined;
	const details = (payload as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return undefined;
	const results = (details as { results?: unknown }).results;
	return Array.isArray(results) ? (results as NestedSubagentResult[]) : undefined;
}

export class NestedCostTracker {
	private readonly latest = new Map<string, number>();

	/** Absorb one child event. Returns true when the nested total changed. */
	observe(event: NestedCostEvent): boolean {
		if (event?.toolName !== "subagent") return false;
		const results = resultsOf(event);
		if (!results) return false;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "?";
		let changed = false;
		results.forEach((result, index) => {
			const cost = result?.usage?.cost;
			if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return;
			const key = `${callId}:${typeof result.taskId === "string" ? result.taskId : index}`;
			if (this.latest.get(key) === cost) return;
			this.latest.set(key, cost);
			changed = true;
		});
		return changed;
	}

	total(): number {
		let sum = 0;
		for (const cost of this.latest.values()) sum += cost;
		return sum;
	}
}

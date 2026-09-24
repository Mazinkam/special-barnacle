/**
 * Spend of `subagent` calls a dispatched child (a lead) makes itself. Those grandchildren
 * are not bridge dispatches, so their cost never reaches the child's own `message_end`
 * usage; it only appears in the child's `subagent` tool events as `details.results[].usage.cost`.
 * Updates carry cumulative snapshots, so the tracker keeps the latest cost per result and sums.
 * Pure: no I/O.
 */

function resultsOf(event: any): unknown[] | undefined {
	const payload = event?.type === "tool_execution_update" ? event.partialResult : event?.type === "tool_execution_end" ? event.result : undefined;
	const results = payload?.details?.results;
	return Array.isArray(results) ? results : undefined;
}

export class NestedCostTracker {
	private readonly latest = new Map<string, number>();

	/** Absorb one child event. Returns true when the nested total changed. */
	observe(event: any): boolean {
		if (event?.toolName !== "subagent") return false;
		const results = resultsOf(event);
		if (!results) return false;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "?";
		let changed = false;
		results.forEach((result: any, index) => {
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

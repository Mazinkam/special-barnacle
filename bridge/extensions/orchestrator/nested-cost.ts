/**
 * Spend of `subagent` calls a dispatched child (a lead) makes itself. Those grandchildren
 * are not bridge dispatches, so their cost never reaches the child's own `message_end`
 * usage; it only appears in the child's `subagent` tool events as `details.results[].usage.cost`.
 * Updates carry cumulative snapshots, so the tracker keeps the latest cost per result and sums.
 * Pure: no I/O.
 *
 * Nested cost semantics (Phase 1 item 2 — see docs/superpowers/audits/2026-09-25-phase1-audit.md
 * "Nested cost semantics" section for the full write-up):
 *
 * - `SubagentSingleResult.usage.cost` (the coding-agent package's own subagent tool,
 *   `packages/coding-agent/src/core/tools/subagent.ts`) is accumulated the SAME way the bridge's
 *   own dispatch usage is: it sums `msg.usage.cost.total` off each `message_end` the child agent
 *   loop itself produced. That is **own-only at every depth** — it excludes whatever THAT child's
 *   own `subagent` tool calls cost, for exactly the same structural reason the bridge's own
 *   `dispatch_finished.cost_usd` excludes this tracker's total. There is no parent-inclusive
 *   rollup anywhere in the chain; each level only ever reports itself.
 * - This tracker sits at ONE vantage point: the direct child process a bridge dispatch spawned.
 *   It only sees `tool_execution_*` events that process itself emits on its own stdout, so it can
 *   see that child's own immediate `subagent` calls (its "task" results — call them depth D+1
 *   where D is the dispatch's own `opts.depth`). If one of those depth-D+1 children itself calls
 *   `subagent` again (depth D+2), that grandchild's cost is *inside* the depth-D+1 child's own
 *   process and is never forwarded into this dispatch's event stream — it is invisible from here.
 *   Each per-call row this tracker's data produces is tagged with the depth it was actually
 *   observed at (`result.depth` when the runtime reports it, else `dispatch depth + 1`) precisely
 *   so a consumer never assumes deeper coverage than what was observed.
 * - Because every level's cost is own-only, summing this tracker's per-task rows with the
 *   dispatch's own `cost_usd` double-counts nothing: they are cost at different, non-overlapping
 *   tree nodes. The one thing that must never happen is booking BOTH `dispatch_finished
 *   .nested_cost_usd` (the aggregate) and this tracker's per-task rows for the same dispatch —
 *   `index.ts` emits the per-task rows once, right before the dispatch's own `dispatch_finished`,
 *   and stamps `nested_rows_emitted` on that event so Python-side aggregation (`economics.py`)
 *   never re-derives a residual for a dispatch that already has detail rows.
 */

export interface NestedUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** `undefined` means "no valid cost was ever reported for this key" — never coerced to 0. */
	cost?: number;
	turns?: number;
}

export interface NestedCallDetail {
	/** Stable identity for this nested call: `${toolCallId}:${taskId-or-index}:${attempt}`. */
	key: string;
	toolCallId: string;
	taskId: string;
	agent?: string;
	model?: string;
	usage: NestedUsage;
	/** True only when at least one observation carried a valid non-negative numeric cost. */
	costReported: boolean;
	exitCode?: number;
	/** Absolute recursion depth as reported by the runtime, when available. */
	depth?: number;
	attempt?: number;
	parentTaskId?: string;
	stopReason?: string;
}

function resultsOf(event: any): unknown[] | undefined {
	const payload = event?.type === "tool_execution_update" ? event.partialResult : event?.type === "tool_execution_end" ? event.result : undefined;
	const results = payload?.details?.results;
	return Array.isArray(results) ? results : undefined;
}

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function keyOf(callId: string, result: any, index: number): string {
	const taskId = typeof result?.taskId === "string" && result.taskId ? result.taskId : String(index);
	// Attempt is folded into the identity so a retry (new attempt, same taskId) gets its own row
	// instead of silently overwriting the previous attempt's — distinct attempts must not collapse,
	// only re-delivery of the SAME attempt's own progress/result events must.
	const attempt = typeof result?.attempt === "number" && Number.isFinite(result.attempt) ? result.attempt : 0;
	return `${callId}:${taskId}:${attempt}`;
}

function detailOf(callId: string, result: any, index: number): NestedCallDetail {
	const rawCost = result?.usage?.cost;
	const costReported = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0;
	const taskId = typeof result?.taskId === "string" && result.taskId ? result.taskId : String(index);
	return {
		key: keyOf(callId, result, index),
		toolCallId: callId,
		taskId,
		agent: typeof result?.agent === "string" ? result.agent : undefined,
		model: typeof result?.model === "string" ? result.model : undefined,
		usage: {
			input: numberOr(result?.usage?.input),
			output: numberOr(result?.usage?.output),
			cacheRead: numberOr(result?.usage?.cacheRead),
			cacheWrite: numberOr(result?.usage?.cacheWrite),
			cost: costReported ? rawCost : undefined,
			turns: numberOr(result?.usage?.turns),
		},
		costReported,
		exitCode: typeof result?.exitCode === "number" ? result.exitCode : undefined,
		depth: typeof result?.depth === "number" ? result.depth : undefined,
		attempt: typeof result?.attempt === "number" ? result.attempt : undefined,
		parentTaskId: typeof result?.parentTaskId === "string" ? result.parentTaskId : undefined,
		stopReason: typeof result?.stopReason === "string" ? result.stopReason : undefined,
	};
}

export class NestedCostTracker {
	private readonly latest = new Map<string, NestedCallDetail>();

	/**
	 * Absorb one child event. Returns true when the nested TOTAL changed (i.e. some key's cost
	 * moved), matching the previous cost-only change signal spend-cap enforcement depends on.
	 * Non-cost fields (exitCode, stopReason, …) are still refreshed to their latest value even
	 * when this returns false, so the row eventually emitted reflects the final observation.
	 */
	observe(event: any): boolean {
		if (event?.toolName !== "subagent") return false;
		const results = resultsOf(event);
		if (!results) return false;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "?";
		let changed = false;
		results.forEach((result: any, index) => {
			const next = detailOf(callId, result, index);
			const prev = this.latest.get(next.key);
			// Only a REPORTED cost that actually moved counts as "changed" — matches the previous
			// behavior of silently skipping unreported/invalid costs entirely. An unreported cost is
			// still stored (so the eventual per-task row can carry its other fields), it just never
			// triggers spend-cap re-evaluation on its own.
			if (next.usage.cost !== undefined && next.usage.cost !== prev?.usage.cost) changed = true;
			// A later observation carrying no valid cost must never overwrite an earlier REPORTED
			// one (Phase 1 review finding T5): some runtimes deliver a final `tool_execution_end`
			// whose own `usage.cost` is missing/invalid even though an earlier `tool_execution_
			// update` for the SAME key already reported a real number — the last VALID cost wins,
			// never the last observation regardless of validity. Every other field (model,
			// exitCode, stopReason, …) still refreshes to `next`'s latest value unconditionally.
			const merged = next.usage.cost !== undefined ? next : {
				...next,
				usage: { ...next.usage, cost: prev?.usage.cost },
				costReported: next.costReported || (prev?.costReported ?? false),
			};
			this.latest.set(next.key, merged);
		});
		return changed;
	}

	total(): number {
		let sum = 0;
		for (const d of this.latest.values()) sum += d.usage.cost ?? 0;
		return sum;
	}

	/** One entry per distinct (toolCallId, taskId, attempt) key, latest observation only. */
	entries(): NestedCallDetail[] {
		return Array.from(this.latest.values());
	}
}

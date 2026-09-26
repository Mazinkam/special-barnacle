/**
 * Terminal run outcomes (B4.6): `completeRun`/`failRun` record a run's
 * finished/failed outcome and drain everything telemetry queued for it, and
 * `createDispatchCostCapture` bills a single dispatch's cost/route rows.
 * Moved out of index.ts as factory functions taking their dependencies as
 * parameters instead of reading module-level `recordQueue`/`runRegistry`
 * globals directly — `run/*` must not import index.ts.
 */
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { dispatchRecordsFor, runCompletionOutcomeFor } from "../core/records.ts";
import type { FlushReport, QueueStats, RecordQueue } from "../record-queue.ts";
import type { DispatchSession } from "../dispatch/child-process.ts";
import type { RunContext, RunRegistry } from "./context.ts";
import type { RunTiming } from "./session.ts";

/** The slice of `RunSession` `completeRun`/`failRun` need to acknowledge the terminal write. */
export interface FinalizableSession {
	readonly runId: string;
	acknowledgeTerminal(ok: boolean): void;
}

export interface RunFinalizerDeps<TSession extends FinalizableSession> {
	runRegistry: RunRegistry<TSession>;
	/** Queue an event row (synchronous; progress never waits on a Python process). */
	recordEvent(event: string, payload: Record<string, unknown>): void;
	/** Queue an outcome row. */
	recordOutcome(outcome: Record<string, unknown>): void;
	/** The telemetry queue itself, for `flush()` plus its counters/last-failure state. */
	recordQueue: RecordQueue;
}

export interface RunFinalizer {
	/**
	 * Record the run's terminal outcome and drain everything queued for it.
	 * Resolves only once Python has acknowledged the writes (or definitively
	 * failed them), so the terminal status is never delayed behind the
	 * coalescing window and the caller can surface any write failure.
	 *
	 * With `since` (the queue counters when the run started) the report covers
	 * every record failure since then: a timer flush that failed mid-run must
	 * not vanish from the summary just because the final drain went through.
	 */
	completeRun(runId: string, summary: Record<string, unknown>, timing?: RunTiming, since?: QueueStats): Promise<FlushReport>;
	failRun(runId: string, error: string, timing?: RunTiming, since?: QueueStats): Promise<FlushReport>;
}

/** Widen a final-drain report to everything the queue did since `since` (cumulative for the run). */
function reportSince(recordQueue: RecordQueue, drain: FlushReport, since?: QueueStats): FlushReport {
	if (!since) return drain;
	const now = recordQueue.stats;
	const failed = Math.max(drain.failed, now.failed - since.failed);
	const derivedStale = Math.max(drain.derivedStale, now.derivedStale - since.derivedStale);
	const report: FlushReport = {
		ok: failed === 0,
		batches: drain.batches,
		acknowledged: Math.max(drain.acknowledged, now.acknowledged - since.acknowledged),
		failed,
		derivedStale,
	};
	// Prefer the final drain's own messages; fall back to the queue's last message for
	// failures that happened in an earlier timer flush.
	if (failed > 0) report.error = drain.error ?? recordQueue.lastFailure ?? undefined;
	if (derivedStale > 0) report.staleReason = drain.staleReason ?? recordQueue.lastStaleReason ?? undefined;
	return report;
}

export function createRunFinalizer<TSession extends FinalizableSession>(
	deps: RunFinalizerDeps<TSession>,
): RunFinalizer {
	async function completeRun(
		runId: string,
		summary: Record<string, unknown>,
		timing?: RunTiming,
		since?: QueueStats,
	): Promise<FlushReport> {
		// No RunContext parameter here (or on failRun): every call site already
		// holds its own `session`/`RunContext` directly and could pass it, but
		// completeRun/failRun are also meant to be callable with just a runId.
		// `runRegistry.active()` plus the runId check preserves the exact old
		// `ACTIVE_RUN?.runId === runId ? ACTIVE_RUN : null` guard: a stale/older
		// run's terminal call must never acknowledge a newer run.
		const active = deps.runRegistry.active();
		const session = active?.session.runId === runId ? active.session : null;
		deps.recordEvent("run_completed", { run_id: runId, ...timing });
		deps.recordOutcome({ ...runCompletionOutcomeFor(runId, summary), ...timing });
		const report = reportSince(deps.recordQueue, await deps.recordQueue.flush(), since);
		session?.acknowledgeTerminal(report.ok);
		return report;
	}

	async function failRun(
		runId: string,
		error: string,
		timing?: RunTiming,
		since?: QueueStats,
	): Promise<FlushReport> {
		const active = deps.runRegistry.active();
		const session = active?.session.runId === runId ? active.session : null;
		deps.recordEvent("run_failed", { run_id: runId, error, ...timing });
		deps.recordOutcome({
			run_id: runId,
			task_id: "run-failed",
			outcome: "fail",
			verification_scope: "run",
			quality: 0,
			note: error,
			...timing,
		});
		const report = reportSince(deps.recordQueue, await deps.recordQueue.flush(), since);
		session?.acknowledgeTerminal(report.ok);
		return report;
	}

	return { completeRun, failRun };
}

/**
 * Bind `dispatchRecordsFor` (core/records.ts, pure) to the real telemetry
 * `recordModelCall`. `run` is typed structurally over `DispatchSession` (not
 * a concrete `RunSession`) so this can be handed to pipeline/* modules as a
 * `TriageDeps`/hierarchy dep without them needing to know `RunSession`'s full
 * shape.
 */
export function createDispatchCostCapture(
	recordModelCall: (metric: Record<string, unknown>) => void,
): (opts: CaptureOpts, result: DispatchResult, run: RunContext<DispatchSession> | null) => Promise<void> {
	return async function captureDispatchCost(opts, result, run) {
		for (const record of dispatchRecordsFor(opts, result, run?.tags ?? {})) {
			recordModelCall(record);
		}
	};
}

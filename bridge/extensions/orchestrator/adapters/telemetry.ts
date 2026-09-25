/**
 * Wraps `RecordQueue` (record-queue.ts) into the three enqueue helpers
 * index.ts calls throughout a run (B4.3). The queue's `run` batcher and its
 * `onError` callback are both taken as parameters: this module never spawns
 * Python itself and never reaches into the active run / UI to report a
 * failure — index.ts wires both to the real things (`runModule(...)` and
 * `ACTIVE_RUN?.log(...)`).
 */

import { type BatchRunner, type FlushReport, RecordQueue } from "../record-queue.ts";

export interface TelemetryOptions {
	/** Sends one batch of queued records to the durable ledger (Python's `batch -`). */
	runBatch: BatchRunner;
	maxBatch: number;
	flushDelayMs: number;
	/** Called for every batch failure/retry; index.ts logs it and surfaces it on the active run. */
	onError: (message: string) => void;
}

export interface Telemetry {
	queue: RecordQueue;
	/** Queue an event row. Synchronous: progress never waits on a Python process. */
	recordEvent: (event: string, payload: Record<string, unknown>) => void;
	/** Queue a metric row (model_call / route_executed). */
	recordModelCall: (metric: Record<string, unknown>) => void;
	/** Queue an outcome row. Terminal run outcomes go through completeRun/failRun, which also drain. */
	recordOutcome: (outcome: Record<string, unknown>) => void;
}

export function createTelemetry(opts: TelemetryOptions): Telemetry {
	const queue = new RecordQueue({
		run: opts.runBatch,
		maxBatch: opts.maxBatch,
		flushDelayMs: opts.flushDelayMs,
		onError: opts.onError,
	});
	return {
		queue,
		recordEvent: (event, payload) => {
			queue.enqueue("event", { ...payload, event });
		},
		recordModelCall: (metric) => {
			queue.enqueue("metric", metric);
		},
		recordOutcome: (outcome) => {
			queue.enqueue("outcome", outcome);
		},
	};
}

export type { FlushReport };

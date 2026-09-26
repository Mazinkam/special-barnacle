/**
 * Bounded, coalescing record queue in front of the Python `batch` command.
 *
 * The bridge used to start one Python process per event/metric/outcome (~250 ms
 * each, awaited inline), so a three-lead run paid for fourteen interpreter
 * start-ups and every `dispatch_started` write delayed the child it announced.
 * This queue turns those writes into a few `orchestrator.cli batch -` calls:
 *
 *   - `enqueue()` is synchronous: it stamps a stable `record_id`, appends to the
 *     pending list and opens a short coalescing window. Progress UI never waits
 *     on telemetry.
 *   - a flush happens when the window elapses, when `maxBatch` records are
 *     pending, or when the caller asks for it (run completion, cancellation,
 *     crash, session shutdown). Terminal writes are awaited, so a run's outcome
 *     row is durable before the run reports itself finished.
 *   - overlapping flushes are serialized on one drain loop; records that arrive
 *     while a batch is in flight go into the next batch.
 *
 * Failure semantics follow the CLI's documented exit codes (`orchestrator/cli.py`):
 *
 *   0  acknowledged (persisted or already-present duplicates)
 *   1  with a structured `status: "invalid"` body: nothing was written. A multi-record
 *      batch is re-sent one record at a time so only the offending record fails; it is
 *      reported, never dropped. Exit 1 *without* a JSON body is not a validation verdict
 *      (the interpreter died before the CLI ran: import error, OOM, SIGPIPE) and is
 *      treated as ambiguous below, so it is replayed as a whole and never split.
 *   2  append interrupted part-way, `retry: "same_ids"` — replay the same ids.
 *   3  records durable but ledger/dashboard refresh failed — replay the same ids
 *      (a no-op append that catches the ledger up). If the budget runs out here the
 *      records are still acknowledged: they count as `derivedStale`, never as failed.
 *   anything else / no JSON body / spawn error: ambiguous — replay the same ids.
 *
 * Replays always reuse the original `record_id`s; the Python writer deduplicates
 * by id, so an ambiguous exit can never produce a duplicate row. After
 * `maxAttempts` the records are kept in `failures`, `lastError` is set and
 * `onError` is called: every write failure is visible to the caller and the UI.
 *
 * Records are stamped with `ts` at enqueue time (the Python writer keeps a supplied
 * `ts`), so the coalescing window and any replay never shift when an event happened.
 *
 * The queue is pure (the runner is injected) so it can be tested without Python.
 */

import contract from "./contract.json";

export type Stream = "event" | "metric" | "outcome";

export const STREAMS: readonly Stream[] = Object.keys(contract.streams) as Stream[];

/** A record as sent to `batch`: the stream, its stable id, and the payload. */
export interface QueuedRecord {
	stream: Stream;
	record_id: string;
	[key: string]: unknown;
}

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Runs `orchestrator.cli batch -` with the records as a JSON array on stdin. */
export interface BatchRunner {
	(records: QueuedRecord[]): Promise<CliResult>;
}

/** The JSON body every durable-write CLI command prints (see cli.py `_failure`/`write_records`). */
interface BatchBody {
	ok?: boolean;
	status?: string;
	error?: string | null;
	persisted?: Partial<Record<Stream, number>>;
	duplicates?: Partial<Record<Stream, number>>;
	retry?: string | null;
}

export interface RecordQueueOptions {
	run: BatchRunner;
	/** Upper bound per `batch` call; must stay ≤ the Python `MAX_BATCH_RECORDS` (500). */
	maxBatch?: number;
	/** Coalescing window opened by the first enqueue after an idle period. */
	flushDelayMs?: number;
	/** Total attempts per batch for ambiguous / retryable failures (≥ 1). */
	maxAttempts?: number;
	/** Pause between attempts; injected so tests do not sleep. */
	delay?: (ms: number) => Promise<void>;
	/** Called with a one-line message for every failure; never throws. */
	onError?: (message: string) => void;
	/** Injected for tests. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Stable id generator; defaults to `<prefix>-<sequence>`. */
	newId?: () => string;
	/** Enqueue-time `ts` stamp; defaults to `new Date().toISOString()`. Injected for tests. */
	now?: () => string;
}

export interface FlushReport {
	/** False when at least one record could not be acknowledged by this flush. */
	ok: boolean;
	batches: number;
	acknowledged: number;
	failed: number;
	/**
	 * Acknowledged records whose ledger/dashboard refresh still failed after the retry
	 * budget. The rows are on disk; only the derived views lag until the next successful
	 * write refreshes them. Counted separately so it is never mistaken for lost records.
	 */
	derivedStale: number;
	/** Last failure message from this flush, when `ok` is false. */
	error?: string;
	/** Last refresh failure behind `derivedStale`, when it is non-zero. */
	staleReason?: string;
}

export interface QueueStats {
	enqueued: number;
	acknowledged: number;
	/** Acknowledged records the store already held (a replay after an ambiguous exit). */
	duplicates: number;
	/** Python processes started. */
	batches: number;
	/** Replays of a batch with the same ids. */
	retries: number;
	failed: number;
	/** Acknowledged records whose derived-view refresh never succeeded (see FlushReport). */
	derivedStale: number;
}

/** Python's `MAX_BATCH_RECORDS`; a larger batch is rejected before anything is written. */
export const PYTHON_MAX_BATCH_RECORDS = contract.batch.max_records;
const DEFAULT_MAX_BATCH = 100;
const DEFAULT_FLUSH_DELAY_MS = 500;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;
/** Failed records retained for inspection; beyond this only the count grows. */
const MAX_RETAINED_FAILURES = 500;

export const EXIT_OK = contract.batch.exit_codes.ok;
export const EXIT_INVALID = contract.batch.exit_codes.invalid;
/** Body status the CLI prints for exit `EXIT_INVALID` when nothing was written. */
export const STATUS_INVALID: string = contract.batch.statuses.invalid;
/** Body statuses that mean "rows durable, derived views not refreshed" (exit 3). */
const DURABLE_STATUSES = new Set([contract.batch.statuses.refresh_failed, contract.batch.statuses.checkpoint_failed]);

function emptyReport(): FlushReport {
	return { ok: true, batches: 0, acknowledged: 0, failed: 0, derivedStale: 0 };
}

export class RecordQueue {
	private readonly run: BatchRunner;
	private readonly maxBatch: number;
	private readonly flushDelayMs: number;
	private readonly maxAttempts: number;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly onError: (message: string) => void;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly newId: () => string;
	private readonly now: () => string;

	private readonly queued: QueuedRecord[] = [];
	private timer: unknown = null;
	private draining: Promise<void> | null = null;
	private readonly retained: QueuedRecord[] = [];
	private current: FlushReport | null = null;
	private _lastError: string | null = null;
	private _lastFailure: string | null = null;
	private _lastStaleReason: string | null = null;
	private readonly _stats: QueueStats = { enqueued: 0, acknowledged: 0, duplicates: 0, batches: 0, retries: 0, failed: 0, derivedStale: 0 };

	constructor(options: RecordQueueOptions) {
		this.run = options.run;
		this.maxBatch = Math.max(1, Math.min(PYTHON_MAX_BATCH_RECORDS, Math.trunc(options.maxBatch ?? DEFAULT_MAX_BATCH)));
		this.flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
		this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
		this.delay = options.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.onError = options.onError ?? (() => {});
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.newId = options.newId ?? defaultIdGenerator();
		this.now = options.now ?? (() => new Date().toISOString());
	}

	/**
	 * Queue one record and return its stable id. Synchronous: never waits on Python.
	 * A caller-supplied string `record_id` is kept so higher-level replays stay idempotent;
	 * a caller-supplied `ts` is kept, otherwise the record is stamped now.
	 */
	enqueue(stream: Stream, payload: Record<string, unknown>): string {
		const supplied = payload.record_id;
		const record_id = typeof supplied === "string" && supplied.trim() ? supplied : this.newId();
		const ts = typeof payload.ts === "string" && payload.ts.trim() ? payload.ts : this.now();
		const record: QueuedRecord = { ...payload, ts, stream, record_id };
		this.queued.push(record);
		this._stats.enqueued += 1;
		if (this.queued.length >= this.maxBatch) {
			void this.flush();
		} else if (this.timer === null) {
			this.timer = this.setTimer(() => {
				this.timer = null;
				void this.flush();
			}, this.flushDelayMs);
		}
		return record_id;
	}

	/**
	 * Send everything queued now and resolve once Python has acknowledged (or
	 * definitively rejected) every record, including records enqueued while the
	 * flush was running. Never rejects: failures are in the report, `lastError`,
	 * `failures` and `onError`.
	 */
	async flush(): Promise<FlushReport> {
		if (this.timer !== null) {
			this.clearTimer(this.timer);
			this.timer = null;
		}
		const report = emptyReport();
		do {
			if (!this.draining) {
				this.current = emptyReport();
				this.draining = this.drain().finally(() => {
					this.draining = null;
				});
			}
			const shared = this.current!;
			await this.draining;
			// Fold the drain we just waited on into this caller's report. Concurrent callers all
			// observe the same drain, so each sees the failures that happened while it waited.
			report.batches += shared.batches;
			report.acknowledged += shared.acknowledged;
			report.failed += shared.failed;
			report.derivedStale += shared.derivedStale;
			if (shared.staleReason) report.staleReason = shared.staleReason;
			if (!shared.ok) {
				report.ok = false;
				report.error = shared.error;
			}
		} while (this.queued.length > 0);
		return report;
	}

	/** Records waiting to be sent (not counting the batch currently in flight). */
	get pending(): number {
		return this.queued.length;
	}

	/** True while a `batch` process is running. */
	get busy(): boolean {
		return this.draining !== null;
	}

	get stats(): Readonly<QueueStats> {
		return this._stats;
	}

	/** A detached copy of the counters, so a caller can later measure what happened since. */
	snapshot(): QueueStats {
		return { ...this._stats };
	}

	/** Last failure or stale-view message, whichever happened most recently. */
	get lastError(): string | null {
		return this._lastError;
	}

	/** Last message for records that could not be written (exhausted retries or rejected). */
	get lastFailure(): string | null {
		return this._lastFailure;
	}

	/** Last message for records that are durable but whose derived-view refresh gave up. */
	get lastStaleReason(): string | null {
		return this._lastStaleReason;
	}

	/** Records that were definitively rejected or exhausted their retries (bounded copy). */
	get failures(): readonly QueuedRecord[] {
		return this.retained.slice();
	}

	private async drain(): Promise<void> {
		while (this.queued.length > 0) {
			const batch = this.queued.splice(0, this.maxBatch);
			try {
				await this.sendWithRetry(batch);
			} catch (err) {
				// `sendWithRetry` reports its own failures; this guards the loop against a bug in
				// the reporting path so a telemetry problem can never take the run down.
				this.fail(batch, `record queue internal error: ${errorMessage(err)}`);
			}
		}
	}

	/** Send one batch, replaying the same ids on retryable outcomes; report the final state. */
	private async sendWithRetry(batch: QueuedRecord[]): Promise<void> {
		let lastMessage = "";
		// Set once any attempt reports the rows durably appended (exit 3). From then on a
		// further failure can only mean the derived views are stale, never that rows are lost.
		let durable = false;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			if (attempt > 1) {
				this._stats.retries += 1;
				await this.delay(RETRY_BACKOFF_MS * (attempt - 1));
			}
			const result = await this.attempt(batch);
			if (this.current) this.current.batches += 1;
			this._stats.batches += 1;
			const body = parseBody(result.stdout);
			if (result.exitCode === EXIT_OK) {
				this.acknowledge(batch, body);
				return;
			}
			// Only a structured verdict from the CLI is a validation failure. A bare exit 1 with
			// no body means the interpreter never reached the CLI (import error, OOM, SIGPIPE):
			// transient, so it is replayed whole below instead of fanning out one spawn per record.
			if (result.exitCode === EXIT_INVALID && body?.status === STATUS_INVALID) {
				// Nothing was written. Isolate the bad record so the rest of the batch still lands.
				if (batch.length > 1) {
					for (const record of batch) await this.sendWithRetry([record]);
					return;
				}
				const reason = body.error ?? (result.stderr.trim() || `exit ${result.exitCode}`);
				this.fail(batch, `orchestrator batch rejected ${describe(batch)}: ${reason}`);
				return;
			}
			if (body?.status && DURABLE_STATUSES.has(body.status)) durable = true;
			lastMessage = describeFailure(result, body);
		}
		if (durable) {
			this.stale(batch, `orchestrator batch ${describe(batch)} is durable but the ledger/dashboard refresh failed after ${this.maxAttempts} attempt(s); derived views are stale until the next successful write: ${lastMessage}`);
			return;
		}
		this.fail(batch, `orchestrator batch failed after ${this.maxAttempts} attempt(s) for ${describe(batch)}: ${lastMessage}`);
	}

	private async attempt(batch: QueuedRecord[]): Promise<CliResult> {
		try {
			const result = await this.run(batch);
			if (!result || typeof result.exitCode !== "number") {
				return { stdout: "", stderr: "batch runner returned no exit code", exitCode: -1 };
			}
			return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode };
		} catch (err) {
			return { stdout: "", stderr: errorMessage(err), exitCode: -1 };
		}
	}

	private acknowledge(batch: QueuedRecord[], body: BatchBody | null): void {
		const duplicates = sumCounts(body?.duplicates);
		this._stats.acknowledged += batch.length;
		this._stats.duplicates += Math.min(batch.length, duplicates);
		if (this.current) this.current.acknowledged += batch.length;
	}

	/** Rows are on disk; only the ledger/dashboard refresh gave up. Acknowledged, but flagged. */
	private stale(batch: QueuedRecord[], message: string): void {
		this.acknowledge(batch, null);
		this._stats.derivedStale += batch.length;
		this._lastError = message;
		this._lastStaleReason = message;
		if (this.current) {
			this.current.derivedStale += batch.length;
			this.current.staleReason = message;
		}
		this.report(message);
	}

	private fail(batch: QueuedRecord[], message: string): void {
		this._stats.failed += batch.length;
		this._lastError = message;
		this._lastFailure = message;
		for (const record of batch) {
			if (this.retained.length < MAX_RETAINED_FAILURES) this.retained.push(record);
		}
		if (this.current) {
			this.current.failed += batch.length;
			this.current.ok = false;
			this.current.error = message;
		}
		this.report(message);
	}

	private report(message: string): void {
		try {
			this.onError(message);
		} catch {
			/* a failing error sink must not break the drain loop */
		}
	}
}

function defaultIdGenerator(): () => string {
	// Unique across bridge processes with overwhelming probability; well under the 200-char limit.
	const prefix = `ht-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	let sequence = 0;
	return () => `${prefix}-${(sequence++).toString(36)}`;
}

function parseBody(stdout: string): BatchBody | null {
	const text = stdout.trim();
	if (!text) return null;
	// The CLI prints one JSON object; tolerate a warning line before it.
	const start = text.lastIndexOf("\n{");
	const candidate = start >= 0 ? text.slice(start + 1) : text;
	try {
		const parsed = JSON.parse(candidate);
		return parsed && typeof parsed === "object" ? (parsed as BatchBody) : null;
	} catch {
		return null;
	}
}

function sumCounts(counts: Partial<Record<Stream, number>> | undefined): number {
	if (!counts) return 0;
	let total = 0;
	for (const stream of STREAMS) {
		const n = counts[stream];
		if (typeof n === "number" && Number.isFinite(n)) total += n;
	}
	return total;
}

function describe(batch: QueuedRecord[]): string {
	const parts = batch.slice(0, 3).map((r) => {
		const label = typeof r.event === "string" ? r.event : typeof r.task_id === "string" ? r.task_id : r.record_id;
		return `${r.stream}:${label}`;
	});
	return `${batch.length} record(s) [${parts.join(", ")}${batch.length > 3 ? ", …" : ""}]`;
}

function describeFailure(result: CliResult, body: BatchBody | null): string {
	if (body?.error) {
		const durable = body.status && DURABLE_STATUSES.has(body.status) ? " (records durable; ledger/dashboard refresh pending)" : "";
		return `exit ${result.exitCode} ${body.status ?? ""}${durable}: ${body.error}`;
	}
	const stderr = result.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
	return `exit ${result.exitCode}${stderr ? `: ${stderr}` : " with no acknowledgement"}`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Summary lines when telemetry did not fully land; empty when all is well. Lost records
 * and durable-but-unrefreshed records are different problems and are worded differently.
 */
export function telemetryWarning(report: FlushReport): string[] {
	const lines: string[] = [];
	if (!report.ok || report.failed > 0) {
		lines.push(`telemetry: ${report.failed} record(s) could not be written to the ledger — ${report.error ?? "see run.log"}`);
	}
	if (report.derivedStale > 0) {
		lines.push(
			`telemetry: ${report.derivedStale} record(s) are durable but the ledger/dashboard refresh failed; derived views are stale until the next successful write — ${report.staleReason ?? "see run.log"}`,
		);
	}
	return lines;
}

/** True when every record landed and the derived views were refreshed. */
export function telemetryHealthy(report: FlushReport): boolean {
	return report.ok && report.failed === 0 && report.derivedStale === 0;
}

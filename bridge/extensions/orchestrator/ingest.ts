/**
 * Automatic session-usage ingestion.
 *
 * HUMAIN Terminal writes every model call's token usage to the session JSONL.
 * The Python side (`orchestrator.cli ingest`) turns that into `model_call`
 * metrics, but it was only ever invoked by hand — so interactive sessions went
 * unlogged until someone remembered. This module runs that ingest from HT
 * lifecycle hooks so the ledger stays current without anyone asking:
 *
 *   - `agent_settled`   → ingest the current session file (debounced, one in flight)
 *   - `session_shutdown` → flush immediately, awaited, so quitting loses nothing
 *
 * Session granularity is used on purpose: those rows are deltas against what
 * `metrics.jsonl` already holds for (runtime, session, model), so per-turn
 * ingestion, the launchd sweep, and any manual backfill never double count.
 *
 * The scheduler is pure (the ingest command is injected) so it can be tested
 * without spawning Python.
 */

export interface IngestRunner {
	(sessionFile: string): Promise<{ ok: boolean; detail?: string }>;
}

export interface SchedulerOptions {
	run: IngestRunner;
	/** Coalesce bursts of settles into one ingest. */
	debounceMs?: number;
	/** Called with a one-line message for every failure; never throws. */
	onError?: (message: string) => void;
	/** Injected for tests. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export class SessionIngestScheduler {
	private readonly run: IngestRunner;
	private readonly debounceMs: number;
	private readonly onError: (message: string) => void;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private timer: unknown = null;
	private inFlight: Promise<void> | null = null;
	private pendingFile: string | null = null;
	private rerunAfter: string | null = null;

	constructor(options: SchedulerOptions) {
		this.run = options.run;
		this.debounceMs = options.debounceMs ?? 3_000;
		this.onError = options.onError ?? (() => {});
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	/** Schedule a debounced ingest of `sessionFile`. No-op for ephemeral sessions. */
	schedule(sessionFile: string | undefined | null): void {
		if (!sessionFile) return;
		this.pendingFile = sessionFile;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = this.setTimer(() => {
			this.timer = null;
			void this.start();
		}, this.debounceMs);
	}

	/**
	 * Ingest now and resolve when done. Cancels any pending debounce; if an
	 * ingest is already running, waits for it and then runs once more so calls
	 * that landed during the run are captured.
	 */
	async flush(sessionFile: string | undefined | null): Promise<void> {
		if (this.timer !== null) {
			this.clearTimer(this.timer);
			this.timer = null;
		}
		if (sessionFile) this.pendingFile = sessionFile;
		if (!this.pendingFile) return;
		await this.start();
		while (this.inFlight) await this.inFlight;
	}

	/** True while an ingest process is running. */
	get busy(): boolean {
		return this.inFlight !== null;
	}

	private start(): Promise<void> {
		const file = this.pendingFile;
		if (!file) return Promise.resolve();
		if (this.inFlight) {
			// Another ingest is running; remember to go again once it finishes so
			// nothing written meanwhile is missed.
			this.rerunAfter = file;
			return this.inFlight;
		}
		this.pendingFile = null;
		this.inFlight = this.run(file)
			.then((result) => {
				if (!result.ok) this.onError(`ingest ${file}: ${result.detail ?? "failed"}`);
			})
			.catch((err: unknown) => {
				this.onError(`ingest ${file}: ${err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				this.inFlight = null;
				if (this.rerunAfter) {
					this.pendingFile = this.rerunAfter;
					this.rerunAfter = null;
					void this.start();
				}
			});
		return this.inFlight;
	}
}

/** CLI arguments for one session-file ingest, shared by the hook and the launchd sweep docs. */
export function ingestArgs(sessionFile: string): string[] {
	return ["ingest", sessionFile, "--runtime", "humain-terminal", "--granularity", "session", "--quiet"];
}

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
	/** Called with a one-line message after the final failed attempt; never throws. */
	onError?: (message: string) => void;
	/** Wait before retrying; injectable for deterministic tests. */
	waitForRetry?: (ms: number) => Promise<void>;
	maxAttempts?: number;
	retryDelayMs?: number;
	/** Injected for tests. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

interface SessionIngestState {
	timer: unknown | null;
	pending: boolean;
	rerun: boolean;
	inFlight: Promise<void> | null;
}

export class SessionIngestScheduler {
	private readonly run: IngestRunner;
	private readonly debounceMs: number;
	private readonly onError: (message: string) => void;
	private readonly waitForRetry: (ms: number) => Promise<void>;
	private readonly maxAttempts: number;
	private readonly retryDelayMs: number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly sessions = new Map<string, SessionIngestState>();
	private lastFile: string | null = null;

	constructor(options: SchedulerOptions) {
		this.run = options.run;
		this.debounceMs = options.debounceMs ?? 3_000;
		this.onError = options.onError ?? (() => {});
		const maxAttempts = options.maxAttempts ?? 3;
		const retryDelayMs = options.retryDelayMs ?? 250;
		this.maxAttempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
		this.retryDelayMs = Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 250;
		this.waitForRetry = options.waitForRetry ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	/** Schedule a debounced ingest of `sessionFile`. No-op for ephemeral sessions. */
	schedule(sessionFile: string | undefined | null): void {
		if (!sessionFile) return;
		this.lastFile = sessionFile;
		const state = this.stateFor(sessionFile);
		state.pending = true;
		if (state.timer !== null) this.clearTimer(state.timer);
		state.timer = this.setTimer(() => {
			state.timer = null;
			void this.start(sessionFile, state);
		}, this.debounceMs);
	}

	/**
	 * Ingest now and resolve when done. Cancels this file's pending debounce; if an
	 * ingest is already running, its one queued rerun is also awaited.
	 */
	async flush(sessionFile: string | undefined | null): Promise<void> {
		const file = sessionFile || this.lastFile;
		if (!file) return;
		this.lastFile = file;
		const state = this.stateFor(file);
		if (state.timer !== null) {
			this.clearTimer(state.timer);
			state.timer = null;
		}
		// An explicit file is a fresh settled/shutdown signal. A null file only
		// drains work already queued for the most recently scheduled session.
		if (sessionFile) state.pending = true;
		if (state.pending) await this.start(file, state);
		while (state.inFlight) await state.inFlight;
	}

	/** True while any session file has an ingest process running. */
	get busy(): boolean {
		return [...this.sessions.values()].some((state) => state.inFlight !== null);
	}

	private stateFor(file: string): SessionIngestState {
		let state = this.sessions.get(file);
		if (!state) {
			state = { timer: null, pending: false, rerun: false, inFlight: null };
			this.sessions.set(file, state);
		}
		return state;
	}

	private start(file: string, state: SessionIngestState): Promise<void> {
		if (state.inFlight) {
			if (state.pending) state.rerun = true;
			state.pending = false;
			return state.inFlight;
		}
		if (!state.pending) return Promise.resolve();

		state.inFlight = (async () => {
			while (state.pending || state.rerun) {
				state.pending = false;
				state.rerun = false;
				await this.runWithRetries(file);
			}
		})().finally(() => {
			state.inFlight = null;
			// A schedule can land after the loop's final condition but before this
			// promise's finally handler. Start it without losing the queued marker.
			if (state.pending || state.rerun) void this.start(file, state);
		});
		return state.inFlight;
	}

	private async runWithRetries(file: string): Promise<void> {
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			let failure: string | null = null;
			try {
				const result = await this.run(file);
				if (result.ok) return;
				failure = result.detail ?? "failed";
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			if (attempt === this.maxAttempts) {
				try {
					this.onError(`ingest ${file}: ${failure ?? "failed"}`);
				} catch {
					// Reporting must never reject the scheduler or disrupt shutdown.
				}
				return;
			}
			await this.waitForRetry(this.retryDelayMs * 2 ** (attempt - 1));
		}
	}
}

/** CLI arguments for one session-file ingest, shared by the hook and the launchd sweep docs. */
export function ingestArgs(sessionFile: string): string[] {
	return ["ingest", sessionFile, "--runtime", "humain-terminal", "--granularity", "session", "--quiet"];
}

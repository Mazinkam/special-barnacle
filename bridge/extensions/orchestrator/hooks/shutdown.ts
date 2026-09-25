/**
 * Signal and `session_shutdown` handling (B4.6): the dispatch reaper (SIGINT/
 * SIGTERM — kill live children, best-effort telemetry flush) and the awaited
 * `session_shutdown` telemetry drain (cancel the live run, wait for its
 * background promise, flush the record queue, all within a bounded budget).
 *
 * hooks/* must not import index.ts. `activeSession`/`flush`/`liveDispatchPids`
 * are required fields on `deps`; index.ts's caller supplies its own real
 * `runRegistry.active()?.session`/`recordQueue.flush`/
 * `dispatch/child-process.ts`'s `liveDispatchPids`.
 */
import type { ExtensionAPI } from "@humain/terminal";

import { installDispatchReaper } from "../adapters/process-reaper.ts";

/** The structural slice of `RunSession` shutdown handling actually calls. */
export interface ShutdownSession {
	readonly runPromise?: Promise<void>;
	readonly finished: Promise<void>;
	cancel(reason: "user" | "shutdown" | "signal"): void;
	close(): void;
	sealDiagnostics(terminal?: Promise<boolean>): Promise<boolean>;
}

export interface ShutdownDeps {
	/** PIDs of dispatched children still running (`dispatch/child-process.ts`'s `liveDispatchPids`). */
	liveDispatchPids: Set<number>;
	/** The live run's session, if any (`runRegistry.active()?.session ?? null`). */
	activeSession(): ShutdownSession | null;
	/** Drains the telemetry queue (`recordQueue.flush()`). */
	flush(): Promise<unknown>;
}

/**
 * Drain batched telemetry when the session ends, so records still inside the
 * coalescing window (a run that was cancelled by quitting, a plan that was just
 * confirmed) are durable before HT exits. Idempotent: flushing an empty queue is a no-op.
 */
function installTelemetryDrain(pi: Pick<ExtensionAPI, "on">, deps: ShutdownDeps): void {
	pi.on("session_shutdown", async () => {
		// Wiring code with no context of its own to thread through (B4.4): this
		// hook fires whenever the session ends, regardless of which run (if any)
		// is live, so `deps.activeSession()` is the natural read here.
		const session = deps.activeSession();
		let timer: ReturnType<typeof setTimeout> | undefined;
		session?.cancel("shutdown");
		try {
			const drained = await Promise.race([
				(async () => { await (session?.runPromise ?? session?.finished); await deps.flush(); return true; })(),
				new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
			]);
			if (!drained) {
				// Do not pretend the terminal cost is complete or archive-safe on expiry.
				session?.close();
				if (session) void session.sealDiagnostics(Promise.resolve(false));
				console.warn("[orchestrator] shutdown drain timed out; late telemetry is unacknowledged, diagnostics remain UNSEALED");
			}
		} finally { if (timer !== undefined) clearTimeout(timer); }
	});
}

/**
 * Register both shutdown paths: the signal-driven reaper (kills live children,
 * starts a best-effort flush — a signal handler cannot await) and the awaited
 * `session_shutdown` telemetry drain (the guaranteed drain, alongside the run's
 * own terminal path).
 */
export function installShutdownHooks(pi: ExtensionAPI, deps: ShutdownDeps): void {
	installDispatchReaper({
		liveDispatchPids: deps.liveDispatchPids,
		onSignal: () => {
			deps.activeSession()?.cancel("signal");
		},
		// Best effort only. A signal handler cannot await, so this merely *starts* a drain of
		// records still inside the coalescing window; whether the Python child gets to run
		// before HT exits depends on HT's own shutdown sequencing. Anything it does not
		// reach is lost with the process. The guaranteed drains are the awaited ones: the
		// run's terminal path (complete/fail/cancel/crash) and the `session_shutdown` hook.
		flush: () => {
			void deps.flush();
		},
	});
	installTelemetryDrain(pi, deps);
}

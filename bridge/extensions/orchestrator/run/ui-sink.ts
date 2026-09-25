/**
 * Swallow throws from `ctx.ui` access (B4.4). `ctx.ui` can become unavailable
 * after the session that owns it has moved on (shutdown, a later session
 * start racing the tail of a run's cleanup) — that failure is not the run's
 * problem: the run has already been logged and recorded, so a UI
 * notify/setWidget/setStatus call failing here must never crash the terminal
 * or a cleanup path.
 *
 * Pure and dependency-free (no globals, no `process.env`), so it moved out of
 * `index.ts` on its own ahead of the `RunContext`/`RunRegistry` split.
 */
export function safeUi(fn: () => void): void {
	try {
		fn();
	} catch {
		/* ctx.ui is unavailable; the run's outcome is already recorded */
	}
}

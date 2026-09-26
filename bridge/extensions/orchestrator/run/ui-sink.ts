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
import type { ExtensionContext } from "@humain/terminal";

export function safeUi(fn: () => void): void {
	try {
		fn();
	} catch {
		/* ctx.ui is unavailable; the run's outcome is already recorded */
	}
}

/**
 * Ask for confirmation before a plan/dispatch/etc. step (B4.6). Pure given
 * `ctx`: non-interactive runs (`--mode json -p`, CI, smoke tests) auto-approve
 * by default; `requireConfirmation` (`--interactive`) opts in to the real gate,
 * which itself resolves `false` rather than throwing when `ctx.hasUI` is false
 * (an interactive request cannot be answered in a headless session).
 */
export async function confirmStep(
	ctx: ExtensionContext,
	title: string,
	message: string,
	requireConfirmation = false,
): Promise<boolean> {
	if (!requireConfirmation) {
		ctx.ui.notify(`${title} — auto-confirmed (default mode)`, "info");
		return true;
	}
	if (!ctx.hasUI) {
		// An interactive request cannot be answered in a headless session.
		ctx.ui.notify(`${title}: no UI to confirm — remove --interactive to run automatically`, "error");
		return false;
	}
	return ctx.ui.confirm(title, message);
}

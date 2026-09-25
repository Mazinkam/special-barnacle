/**
 * Per-run state threaded explicitly through the dispatch path (B4.4), replacing
 * three module-level globals `index.ts` used to carry the same information:
 *
 *   - `ACTIVE_RUN`          -> `RunContext.session` (via `RunRegistry`)
 *   - `CURRENT_RUN_TAGS`    -> `RunContext.tags`
 *   - `CURRENT_ALIAS_TABLE` -> `RunContext.aliasTable`
 *
 * `RunContext` is generic over its session type (`TSession`) so this module
 * never has to import the concrete `RunSession` class from `index.ts` — doing
 * so would create the exact import cycle the architecture review's ground
 * rules forbid (`run/*` must not import `index.ts`). `index.ts` instantiates
 * `RunRegistry<RunSession>` itself, at which point `RunContext<RunSession>`
 * is fully and concretely typed for every caller in that file; this module
 * only ever needs to store the session and compare it by identity, neither of
 * which requires knowing its shape.
 */

import type { AliasTable } from "../models.ts";
import type { RunTags } from "../core/records.ts";

/**
 * One `/orchestrate` run's state, passed explicitly to every function in the
 * dispatch path that used to reach into a module global for it.
 */
export interface RunContext<TSession> {
	/** The run's `RunSession` (owns the progress board, on-disk log, cancellation). */
	readonly session: TSession;
	/**
	 * Cohort tags stamped on every `model_call`/`route_executed` row of this run
	 * (profile, policy id, lead size). A mutable object by design — lead sizing
	 * and escalation update `tags.lead_size` in place over the run's lifetime,
	 * exactly as the old `CURRENT_RUN_TAGS` global did; callers holding this
	 * `RunContext` always see the latest value.
	 */
	readonly tags: RunTags;
	/** Alias table for the codex -> Bedrock quota fallback, or `null` when none applies. */
	readonly aliasTable: AliasTable | null;
}

/**
 * Owns "the one active run": only one `/orchestrate` (or the model-check probe)
 * may be live at a time. `index.ts` creates exactly one `RunRegistry` instance
 * at module load and holds it as its one allowed piece of module state; every
 * function in the dispatch path (dispatchParallel, runVerification, triageTask,
 * ...) receives the `RunContext` it needs as an explicit parameter instead of
 * reading this registry itself. Only wiring code with no context of its own to
 * thread through — the `orchestrator_status` tool, the signal/shutdown hooks,
 * `/orchestrate-cancel`, `/omsg` — calls `registry.active()` directly.
 */
export class RunRegistry<TSession> {
	private current: RunContext<TSession> | null = null;

	/**
	 * The active run's context, or `null` when none is live. Read through a
	 * method call rather than a field so two calls separated by an `await` each
	 * see the current value — nothing here caches a snapshot that could go
	 * stale while the caller is suspended.
	 */
	active(): RunContext<TSession> | null {
		return this.current;
	}

	/**
	 * Claim the registry for `session`, atomically checking and setting so a
	 * second caller racing across an `await` cannot also believe it won. Returns
	 * the new `RunContext` on success, or `null` when another run already holds
	 * the registry — the guard every `/orchestrate` invocation (and the
	 * model-check probe) must lose against cleanly.
	 */
	claim(session: TSession, tags: RunTags = {}, aliasTable: AliasTable | null = null): RunContext<TSession> | null {
		if (this.current) return null;
		this.current = { session, tags, aliasTable };
		return this.current;
	}

	/**
	 * Release the registry, but only if `context` — by identity, not just by
	 * session id — is still the current owner. A run's own cleanup must never
	 * clobber a newer run that has since claimed the registry out from under a
	 * stale one's `finally` block (see `index.ts`'s `/orchestrate` handler).
	 */
	release(context: RunContext<TSession>): void {
		if (this.current === context) this.current = null;
	}

	/**
	 * Test-only escape hatch: force the registry into an arbitrary state,
	 * bypassing `claim()`'s guard entirely. Used to simulate a race where a
	 * newer run has already replaced the active one out from under a stale
	 * run's cleanup — production code has no other way to reach that state; it
	 * only ever calls `claim()`/`release()`.
	 */
	setForTest(context: RunContext<TSession> | null): void {
		this.current = context;
	}
}

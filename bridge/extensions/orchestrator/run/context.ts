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

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { AliasTable, BindingSource } from "../models.ts";
import type { RunTags } from "../core/records.ts";
import type { RunCancellation } from "../cancellation.ts";
import type { QueueStats } from "../record-queue.ts";
import type { Candidate } from "../adapters/model-router.ts";
import type { ModelHealth } from "./model-health.ts";
/** Time fields recorded at the run's terminal boundary (complete/fail/cancel/crash). */
export interface RunTiming {
	started_at: string;
	finished_at: string;
	elapsed_ms: number;
	elapsed_source: "monotonic";
}

/** Manifest `python3 -m orchestrator.cli archive-runs --execute` leaves next to a run's `<name>.gz` files. */
const ARCHIVE_MANIFEST = "archive.manifest.json";

/**
 * Where a run diagnostic can be read *now*. The opt-in `archive-runs --execute` command replaces
 * the diagnostics of old completed runs with `<name>.gz` + a manifest (`run.log` itself is never
 * archived), so a path remembered from the progress board or an old notification may no longer
 * exist as-is. Returns the path unchanged while it is readable; otherwise a lookup/restore hint
 * instead of a silently broken link.
 */
export function describeRunArtifact(path: string): string {
	if (existsSync(path)) return path;
	const runDir = dirname(path);
	const name = basename(path);
	const archived = join(runDir, `${name}.gz`);
	let listed = false;
	try {
		const manifest = JSON.parse(readFileSync(join(runDir, ARCHIVE_MANIFEST), "utf-8"));
		listed = manifest?.format_version === 1 && typeof manifest?.files?.[name] === "object";
	} catch {
		/* no readable manifest: the file was never archived by us */
	}
	if (listed && existsSync(archived)) {
		return `${path} (archived as ${archived} — read with \`gunzip -c\`, or restore the run with \`python3 -m orchestrator.cli restore-run ${basename(runDir)}\`)`;
	}
	return `${path} (missing)`;
}

export type PendingCheckRow = { provider: "gitlab" | "github"; id: string; outcome: "pending" | "success" | "failure" | "unverified"; mr?: string };

/**
 * The `RunSession` surface `pipeline/*` and `commands/orchestrate.ts` actually call, as a
 * structural interface rather than the concrete `run/session.ts` `RunSession` class
 * (docs: A1 unification notes). TypeScript's class-to-class assignability requires private
 * members to originate from the SAME declaration, which the modular `RunSession` and any
 * caller's own session class (e.g. `index.ts`'s own, pre-B4.4 implementation) never share —
 * even when their public surfaces are identical. A purely-public structural interface has no
 * such restriction: ANY class exposing this exact public shape (including one with its own,
 * unrelated private fields) satisfies `RunSessionLike` and can be threaded through
 * `RunContext<RunSessionLike>`/`RunRegistry<RunSessionLike>` without either side importing the
 * other's concrete class. Every `pipeline/*`/`commands/orchestrate.ts` seam that used to read
 * `RunContext<RunSession>` (`run/session.ts`'s class) is typed against this interface instead;
 * `run/session.ts`'s own `RunSession` continues to satisfy it structurally, so every existing
 * caller/test that already uses the concrete class is unaffected.
 */
export interface RunSessionLike {
	readonly runId: string;
	readonly dir: string;
	readonly cancellation: RunCancellation;
	readonly cancelReason: "user" | "shutdown" | "signal" | undefined;
	runPromise?: Promise<void>;
	readonly telemetryBaseline: QueueStats;
	file(name: string): string;
	writeDiagnostic(name: string, text: string): boolean;
	log(line: string): void;
	setPhase(phase: string, notify?: boolean): void;
	setPendingChecks?(rows: PendingCheckRow[]): void;
	terminalTiming(): RunTiming;
	cancelledDispatches(): string[];
	totalCost(): number;
	close(): void;
	sealDiagnostics(terminal?: Promise<boolean>): Promise<boolean>;
	finish(): void;
}

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
	/**
	 * Per-capability binding source of this run's resolved adapter (`FullResolution.sources`),
	 * mirroring the old `CURRENT_MODEL_SOURCES` global (A1 unification notes) — `null`/omitted when
	 * the claimer has no adapter-resolution sources to report (e.g. the model-check probe, which
	 * claims with no `modelSources` argument at all). Optional so existing `RunContext` literals
	 * built by tests before this field existed keep typechecking.
	 */
	readonly modelSources?: Record<string, BindingSource> | null;
	/** Resolved, qualification-checked model alternatives shared by dispatches in this run. */
	readonly candidates?: Record<string, Candidate[]>;
	/** Provider failures mark models unhealthy for later dispatches in this run only. */
	readonly modelHealth?: ModelHealth;
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
	claim(
		session: TSession,
		tags: RunTags = {},
		aliasTable: AliasTable | null = null,
		modelSources: Record<string, BindingSource> | null = null,
		routing?: { candidates: Record<string, Candidate[]>; modelHealth: ModelHealth },
	): RunContext<TSession> | null {
		if (this.current) return null;
		this.current = { session, tags, aliasTable, modelSources, ...routing };
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
}

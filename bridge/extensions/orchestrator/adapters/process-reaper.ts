/**
 * Child-process and temp-dir cleanup for dispatched subagents (B4.3).
 *
 * Dispatched children are spawned `detached` (their own process group) so a
 * timeout can kill their whole subtree; the flip side is that they would
 * outlive a killed parent orchestrator, so the parent reaps them on the way
 * out. This module owns that bookkeeping: how to kill one child (and its
 * subtree), how to kill every live dispatch on shutdown, and how to sweep
 * persona prompt temp dirs an earlier, SIGKILLed parent left behind. Every
 * dependency (the live-pid set, the kill function, the clock, the
 * filesystem, the tmp root) is a parameter; index.ts wires the real ones.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Matches `process.kill`'s signature; injectable so tests can assert the call. */
export type KillFn = (pid: number, signal?: NodeJS.Signals | number) => boolean;

/**
 * Kill a dispatched child AND everything it spawned.
 *
 * `kill(-pid)` targets the child's process group, which exists because we spawn
 * detached. Killing the bare pid instead leaves a dispatched lead's own
 * subagents running as orphans - unreadable, unbilled, and still burning provider
 * quota. Falls back to the direct pid when the group is already gone.
 */
export function killProcessTree(
	proc: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
	kill: KillFn = (pid, signal) => process.kill(pid, signal),
): void {
	if (typeof proc.pid === "number") {
		try {
			kill(-proc.pid, "SIGKILL");
			return;
		} catch {
			/* no such group: already reaped, or never became a group leader */
		}
	}
	try {
		proc.kill("SIGKILL");
	} catch {
		/* already gone */
	}
}

export interface DispatchReaperDeps {
	/** PIDs of dispatched children that are still running. */
	liveDispatchPids: Set<number>;
	/** Called once per fatal signal, before the reap; typically cancels the active run. */
	onSignal: (signal: NodeJS.Signals) => void;
	/**
	 * Best-effort drain of anything still queued. A signal handler cannot
	 * await, so this merely *starts* a drain; whatever isn't reached before
	 * the process exits is lost with it.
	 */
	flush: () => void;
	kill?: KillFn;
	proc?: Pick<NodeJS.Process, "once">;
}

let dispatchReaperInstalled = false;

/**
 * Kill every in-flight dispatch subtree when this process goes down.
 * Installs its hooks at most once per process, regardless of how many times
 * (or with which deps) it's called — matching the historical behaviour of
 * the module-level guard this replaces.
 */
export function installDispatchReaper(deps: DispatchReaperDeps): void {
	if (dispatchReaperInstalled) return;
	dispatchReaperInstalled = true;
	const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
	const proc = deps.proc ?? process;
	const reap = () => {
		for (const pid of deps.liveDispatchPids) {
			try {
				kill(-pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		deps.liveDispatchPids.clear();
	};
	proc.once("exit", reap);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		// `once` + re-raise keeps HT's own handlers intact: we only add cleanup,
		// we don't change whether the parent exits.
		proc.once(signal, () => {
			deps.onSignal(signal);
			deps.flush();
			reap();
		});
	}
}

export interface PersonaReapOptions {
	/** Directory persona temp dirs are created in (`os.tmpdir()` in production). */
	tmpRoot: string;
	/** Filename prefix used to identify persona prompt dirs among tmpRoot's other entries. */
	prefix: string;
	/** Entries older than this are considered orphaned. */
	ttlMs: number;
	now?: () => number;
	warn?: (message: string) => void;
	fs?: {
		readdirSync: typeof readdirSync;
		statSync: typeof statSync;
		rmSync: typeof rmSync;
	};
}

/**
 * Best-effort reap of persona prompt dirs left behind when a parent orchestrator
 * was killed mid-dispatch (SIGKILL skips every cleanup path we control). Meant
 * to run once at activation; age-gated so concurrently running dispatches are
 * safe.
 */
export function reapOrphanedPersonaDirs(opts: PersonaReapOptions): void {
	const now = opts.now ?? Date.now;
	const warn = opts.warn ?? ((message: string) => console.warn(message));
	const fsImpl = opts.fs ?? { readdirSync, statSync, rmSync };
	try {
		const cutoff = now() - opts.ttlMs;
		let reaped = 0;
		for (const entry of fsImpl.readdirSync(opts.tmpRoot)) {
			if (!entry.startsWith(opts.prefix)) continue;
			const full = join(opts.tmpRoot, entry);
			try {
				if (fsImpl.statSync(full).mtimeMs > cutoff) continue;
				fsImpl.rmSync(full, { recursive: true, force: true });
				reaped++;
			} catch {
				/* another process may own or have already removed it */
			}
		}
		if (reaped > 0) {
			warn(`[orchestrator] reaped ${reaped} orphaned persona temp dir(s) in ${opts.tmpRoot}`);
		}
	} catch {
		/* temp dir unreadable — nothing to reap */
	}
}

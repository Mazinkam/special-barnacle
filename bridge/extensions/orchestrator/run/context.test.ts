import { describe, expect, test } from "bun:test";
import { RunRegistry } from "./context.ts";

/** A minimal fake "session" — RunRegistry never calls anything on it, only
 *  stores it and compares by identity, so a plain tagged object is enough. */
function fakeSession(id: string) {
	return { id };
}

describe("RunRegistry", () => {
	test("starts with no active run", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		expect(registry.active()).toBeNull();
	});

	test("claim() succeeds when nothing is active, and the returned context carries the session/tags/aliasTable given", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const session = fakeSession("a");
		const table = { models: [] } as never;
		const claimed = registry.claim(session, { profile: "default" }, table);
		expect(claimed).not.toBeNull();
		expect(claimed!.session).toBe(session);
		expect(claimed!.tags).toEqual({ profile: "default" });
		expect(claimed!.aliasTable).toBe(table);
		expect(registry.active()).toBe(claimed);
	});

	test("claim() defaults tags to {} and aliasTable to null when omitted", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const claimed = registry.claim(fakeSession("a"));
		expect(claimed!.tags).toEqual({});
		expect(claimed!.aliasTable).toBeNull();
	});

	test("tags is the same mutable object handed back by claim() — later mutation is visible through the context", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const claimed = registry.claim(fakeSession("a"))!;
		claimed.tags.lead_size = "large";
		expect(registry.active()!.tags.lead_size).toBe("large");
	});

	test("claim() fails while a run is already active — the guard every second /orchestrate invocation must lose against", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const first = registry.claim(fakeSession("a"));
		expect(first).not.toBeNull();
		const second = registry.claim(fakeSession("b"));
		expect(second).toBeNull();
		// The loser must not have clobbered the winner.
		expect(registry.active()).toBe(first);
		expect(registry.active()!.session).toEqual(fakeSession("a"));
	});

	test("release() clears the registry when the context released is still the current owner", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const claimed = registry.claim(fakeSession("a"))!;
		registry.release(claimed);
		expect(registry.active()).toBeNull();
	});

	test("release() is a no-op when the context is not the current owner (stale-run check)", () => {
		// Reproduces the scenario a stale run's own `finally` must survive: run A
		// claims the registry, cleanly releases, then run B claims it. A's own
		// `release(contextA)` — called again, e.g. from a stale/duplicate cleanup
		// path — must not undo that: it is not releasing the context that is
		// actually still active.
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const contextA = registry.claim(fakeSession("a"))!;
		registry.release(contextA);
		const contextB = registry.claim(fakeSession("b"));
		expect(contextB).not.toBeNull();
		expect(registry.active()).toBe(contextB);

		registry.release(contextA);

		expect(registry.active()).toBe(contextB);
	});

	test("after a stale release() no-ops, the real owner can still release cleanly", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const contextA = registry.claim(fakeSession("a"))!;
		registry.release(contextA);
		const contextB = registry.claim(fakeSession("b"))!;
		registry.release(contextA); // no-op: A no longer owns the registry
		registry.release(contextB); // the real owner releases cleanly
		expect(registry.active()).toBeNull();
	});

	test("claim() after a clean release() admits a new run", () => {
		const registry = new RunRegistry<ReturnType<typeof fakeSession>>();
		const first = registry.claim(fakeSession("a"))!;
		registry.release(first);
		const second = registry.claim(fakeSession("b"));
		expect(second).not.toBeNull();
		expect(registry.active()!.session).toEqual(fakeSession("b"));
	});
});

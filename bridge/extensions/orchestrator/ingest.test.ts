import { describe, expect, test } from "bun:test";
import { SessionIngestScheduler, ingestArgs } from "./ingest.ts";

/** Manual timer so debounce is deterministic. */
function fakeTimers() {
	const pending: { fn: () => void; ms: number }[] = [];
	return {
		pending,
		setTimer: (fn: () => void, ms: number) => {
			const h = { fn, ms };
			pending.push(h);
			return h;
		},
		clearTimer: (h: unknown) => {
			const i = pending.indexOf(h as { fn: () => void; ms: number });
			if (i >= 0) pending.splice(i, 1);
		},
		fire: () => {
			const all = pending.splice(0);
			for (const h of all) h.fn();
		},
	};
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe("SessionIngestScheduler", () => {
	test("debounces a burst of settles into one ingest", async () => {
		const timers = fakeTimers();
		const calls: string[] = [];
		const s = new SessionIngestScheduler({
			run: async (f) => {
				calls.push(f);
				return { ok: true };
			},
			...timers,
		});
		s.schedule("/s/a.jsonl");
		s.schedule("/s/a.jsonl");
		s.schedule("/s/a.jsonl");
		expect(timers.pending.length).toBe(1);
		timers.fire();
		await s.flush(null);
		expect(calls).toEqual(["/s/a.jsonl"]);
	});

	test("ignores ephemeral sessions (no file)", async () => {
		const timers = fakeTimers();
		let ran = 0;
		const s = new SessionIngestScheduler({ run: async () => (ran++, { ok: true }), ...timers });
		s.schedule(undefined);
		s.schedule(null);
		await s.flush(undefined);
		expect(timers.pending.length).toBe(0);
		expect(ran).toBe(0);
	});

	test("flush cancels the debounce and runs immediately", async () => {
		const timers = fakeTimers();
		const calls: string[] = [];
		const s = new SessionIngestScheduler({
			run: async (f) => (calls.push(f), { ok: true }),
			...timers,
		});
		s.schedule("/s/a.jsonl");
		await s.flush("/s/a.jsonl");
		expect(timers.pending.length).toBe(0);
		expect(calls).toEqual(["/s/a.jsonl"]);
	});

	test("a settle during an in-flight ingest triggers exactly one rerun", async () => {
		const timers = fakeTimers();
		const calls: string[] = [];
		const first = deferred<{ ok: boolean }>();
		let n = 0;
		const s = new SessionIngestScheduler({
			run: (f) => {
				calls.push(f);
				n++;
				return n === 1 ? first.promise : Promise.resolve({ ok: true });
			},
			...timers,
		});
		s.schedule("/s/a.jsonl");
		timers.fire();
		expect(s.busy).toBe(true);
		// New calls land while the first ingest is running.
		s.schedule("/s/a.jsonl");
		timers.fire();
		s.schedule("/s/a.jsonl");
		timers.fire();
		expect(calls.length).toBe(1);
		first.resolve({ ok: true });
		await s.flush(null);
		expect(calls).toEqual(["/s/a.jsonl", "/s/a.jsonl"]);
		expect(s.busy).toBe(false);
	});

	test("failures are reported, never thrown", async () => {
		const timers = fakeTimers();
		const errors: string[] = [];
		const s = new SessionIngestScheduler({
			run: async () => {
				throw new Error("python exploded");
			},
			onError: (m) => errors.push(m),
			...timers,
		});
		await s.flush("/s/a.jsonl");
		expect(errors).toEqual(["ingest /s/a.jsonl: python exploded"]);

		const s2 = new SessionIngestScheduler({
			run: async () => ({ ok: false, detail: "exit 2" }),
			onError: (m) => errors.push(m),
			...timers,
		});
		await s2.flush("/s/b.jsonl");
		expect(errors[1]).toBe("ingest /s/b.jsonl: exit 2");
	});
});

describe("ingestArgs", () => {
	test("uses session granularity so hook, sweep and backfill never double count", () => {
		expect(ingestArgs("/s/a.jsonl")).toEqual([
			"ingest",
			"/s/a.jsonl",
			"--runtime",
			"humain-terminal",
			"--granularity",
			"session",
			"--quiet",
		]);
	});
});

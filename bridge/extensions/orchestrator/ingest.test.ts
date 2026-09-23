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

	test("keeps independent ingest streams for distinct session files", async () => {
		const timers = fakeTimers();
		const calls: string[] = [];
		const s = new SessionIngestScheduler({
			run: async (file) => (calls.push(file), { ok: true }),
			...timers,
		});
		s.schedule("/s/a.jsonl");
		s.schedule("/s/b.jsonl");
		expect(timers.pending).toHaveLength(2);
		timers.fire();
		await s.flush(null);
		expect(calls.sort()).toEqual(["/s/a.jsonl", "/s/b.jsonl"]);
	});

	test("retries transient failures with exponential waits and reports no final error", async () => {
		const timers = fakeTimers();
		let attempts = 0;
		const errors: string[] = [];
		const waits: number[] = [];
		const s = new SessionIngestScheduler({
			run: async () => (++attempts < 3 ? { ok: false } : { ok: true }),
			onError: (message) => errors.push(message),
			waitForRetry: async (ms) => {
				waits.push(ms);
			},
			maxAttempts: 3,
			retryDelayMs: 250,
			...timers,
		});

		await s.flush("/s/a.jsonl");
		expect(attempts).toBe(3);
		expect(waits).toEqual([250, 500]);
		expect(errors).toEqual([]);
	});

	test("reports exactly one error after the final retry, whether failures throw or return false", async () => {
		const timers = fakeTimers();
		const attempts: number[] = [];
		const errors: string[] = [];
		const waits: number[] = [];
		const s = new SessionIngestScheduler({
			run: async () => {
				attempts.push(attempts.length + 1);
				if (attempts.length === 1) throw new Error("temporary exception");
				return { ok: false, detail: "exit 2" };
			},
			onError: (message) => errors.push(message),
			waitForRetry: async (ms) => {
				waits.push(ms);
			},
			maxAttempts: 3,
			...timers,
		});

		await s.flush("/s/a.jsonl");
		expect(attempts).toHaveLength(3);
		expect(waits).toEqual([250, 500]);
		expect(errors).toEqual(["ingest /s/a.jsonl: exit 2"]);
	});

	test("flush waits for the queued rerun after the in-flight ingest", async () => {
		const timers = fakeTimers();
		const first = deferred<{ ok: boolean }>();
		const second = deferred<{ ok: boolean }>();
		let attempts = 0;
		let flushDone = false;
		const s = new SessionIngestScheduler({
			run: () => (++attempts === 1 ? first.promise : second.promise),
			...timers,
		});
		s.schedule("/s/a.jsonl");
		timers.fire();
		s.schedule("/s/a.jsonl");
		const flushing = s.flush("/s/a.jsonl").then(() => { flushDone = true; });
		first.resolve({ ok: true });
		await Promise.resolve();
		await Promise.resolve();
		expect(attempts).toBe(2);
		expect(flushDone).toBe(false);
		second.resolve({ ok: true });
		await flushing;
		expect(flushDone).toBe(true);
	});

	test("failures are reported, never thrown", async () => {
		const timers = fakeTimers();
		const errors: string[] = [];
		const s = new SessionIngestScheduler({
			run: async () => {
				throw new Error("python exploded");
			},
			onError: (m) => errors.push(m),
			maxAttempts: 1,
			...timers,
		});
		await s.flush("/s/a.jsonl");
		expect(errors).toEqual(["ingest /s/a.jsonl: python exploded"]);

		const s2 = new SessionIngestScheduler({
			run: async () => ({ ok: false, detail: "exit 2" }),
			onError: (m) => errors.push(m),
			maxAttempts: 1,
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

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type BatchRunner, type CliResult, type QueuedRecord, RecordQueue } from "./record-queue.ts";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** Manual timer so the coalescing window is deterministic. */
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
			for (const h of pending.splice(0)) h.fn();
		},
	};
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function okBody(records: QueuedRecord[]): CliResult {
	const persisted = { event: 0, metric: 0, outcome: 0 };
	for (const r of records) persisted[r.stream] += 1;
	return {
		exitCode: 0,
		stderr: "",
		stdout: JSON.stringify({
			ok: true,
			status: "ok",
			persisted,
			duplicates: { event: 0, metric: 0, outcome: 0 },
			ledger_updated: true,
			dashboard_updated: true,
			error: null,
			retry: null,
		}),
	};
}

/** In-memory stand-in for the Python `batch` command: records every spawn, acknowledges everything. */
function fakeStore() {
	const batches: QueuedRecord[][] = [];
	const run: BatchRunner = async (records) => {
		batches.push(records.map((r) => ({ ...r })));
		return okBody(records);
	};
	return { batches, run };
}

// -----------------------------------------------------------------------------
// Real Python helpers (temp state root; never the live ~/.local/state root)
// -----------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PYTHON = process.env.HUMAIN_ORCHESTRATOR_PYTHON ?? "python3";
const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempStateRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "orch-record-queue-"));
	tempRoots.push(root);
	return root;
}

function pythonBatchRunner(stateRoot: string, spawns: { count: number }): BatchRunner {
	return (records) =>
		new Promise<CliResult>((resolve) => {
			spawns.count += 1;
			const child = spawn(PYTHON, ["-B", "-m", "orchestrator.cli", "batch", "-"], {
				env: {
					...process.env,
					PYTHONPATH: REPO_ROOT,
					PYTHONDONTWRITEBYTECODE: "1",
					CODING_AGENT_ORCHESTRATOR_HOME: stateRoot,
					CODING_AGENT_RUNTIME: "humain-terminal",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (b) => (stdout += b.toString()));
			child.stderr.on("data", (b) => (stderr += b.toString()));
			child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
			child.stdin.end(JSON.stringify(records));
		});
}

function readIds(stateRoot: string, file: string): string[] {
	const path = join(stateRoot, file);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).record_id as string);
}

// -----------------------------------------------------------------------------
// Unit behaviour (injected runner, no Python)
// -----------------------------------------------------------------------------

describe("RecordQueue coalescing", () => {
	test("two records enqueued in one boundary reach the store in one spawn, in order, with stable ids", async () => {
		const store = fakeStore();
		const timers = fakeTimers();
		const q = new RecordQueue({ run: store.run, ...timers });

		const id1 = q.enqueue("event", { event: "dispatch_started", run_id: "r1", task_id: "t1" });
		const id2 = q.enqueue("metric", { event: "model_call", run_id: "r1", task_id: "t1", cost_usd: 0.1 });
		expect(typeof id1).toBe("string");
		expect(id1).not.toBe(id2);
		expect(id1.length).toBeLessThanOrEqual(200);
		// Nothing is spawned synchronously: the coalescing window is open.
		expect(store.batches.length).toBe(0);
		expect(timers.pending.length).toBe(1);

		timers.fire();
		await q.flush();

		expect(store.batches.length).toBe(1);
		expect(store.batches[0].map((r) => r.record_id)).toEqual([id1, id2]);
		expect(store.batches[0][0]).toMatchObject({ stream: "event", event: "dispatch_started", run_id: "r1" });
		expect(store.batches[0][1]).toMatchObject({ stream: "metric", event: "model_call", cost_usd: 0.1 });
		expect(q.stats).toMatchObject({ enqueued: 2, acknowledged: 2, batches: 1, failed: 0 });
	});

	test("a caller-supplied record_id is kept, so replays from higher layers stay idempotent", async () => {
		const store = fakeStore();
		const q = new RecordQueue({ run: store.run, ...fakeTimers() });
		expect(q.enqueue("outcome", { record_id: "fixed-1", run_id: "r1", task_id: "run-complete", outcome: "verified" })).toBe("fixed-1");
		await q.flush();
		expect(store.batches[0][0].record_id).toBe("fixed-1");
	});

	test("the batch is bounded: reaching maxBatch flushes immediately and never exceeds the Python limit", async () => {
		const store = fakeStore();
		const timers = fakeTimers();
		const q = new RecordQueue({ run: store.run, maxBatch: 3, ...timers });
		for (let i = 0; i < 7; i++) q.enqueue("event", { event: "e", run_id: "r1", task_id: `t${i}` });
		await q.flush();
		expect(store.batches.map((b) => b.length)).toEqual([3, 3, 1]);
		expect(new Set(store.batches.flat().map((r) => r.record_id)).size).toBe(7);
	});

	test("flush drains everything immediately without waiting for the timer", async () => {
		const store = fakeStore();
		const timers = fakeTimers();
		const q = new RecordQueue({ run: store.run, ...timers });
		q.enqueue("outcome", { run_id: "r1", task_id: "run-complete", outcome: "verified" });
		expect(timers.pending.length).toBe(1);
		const report = await q.flush();
		expect(timers.pending.length).toBe(0);
		expect(store.batches.length).toBe(1);
		expect(report).toMatchObject({ ok: true, acknowledged: 1, failed: 0 });
		// Nothing left, so a second flush is a no-op rather than an empty (invalid) batch.
		await q.flush();
		expect(store.batches.length).toBe(1);
	});

	test("overlapping flushes are serialized and records enqueued mid-flush are still drained", async () => {
		const timers = fakeTimers();
		const gate = deferred<void>();
		const batches: QueuedRecord[][] = [];
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				batches.push(records);
				calls += 1;
				if (calls === 1) await gate.promise;
				return okBody(records);
			},
			...timers,
		});
		q.enqueue("event", { event: "a", run_id: "r1" });
		const first = q.flush();
		// While the first batch is in flight, more records arrive and a second flush is requested.
		q.enqueue("event", { event: "b", run_id: "r1" });
		const second = q.flush();
		expect(batches.length).toBe(1);
		gate.resolve();
		await Promise.all([first, second]);
		expect(batches.map((b) => b.map((r) => r.event))).toEqual([["a"], ["b"]]);
		expect(q.pending).toBe(0);
	});

	test("enqueue never blocks the caller while a slow batch is in flight (progress stays responsive)", async () => {
		const timers = fakeTimers();
		const gate = deferred<void>();
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				calls += 1;
				if (calls === 1) await gate.promise;
				return okBody(records);
			},
			...timers,
		});
		q.enqueue("event", { event: "dispatch_started", run_id: "r1", task_id: "t0" });
		const flushing = q.flush();
		const started = performance.now();
		for (let i = 1; i <= 50; i++) q.enqueue("event", { event: "tool", run_id: "r1", task_id: `t${i}` });
		expect(performance.now() - started).toBeLessThan(50);
		expect(q.pending).toBe(50);
		gate.resolve();
		await flushing;
		await q.flush();
		expect(q.stats.acknowledged).toBe(51);
	});
});

describe("RecordQueue failure handling", () => {
	test("a malformed batch is rejected with the Python error visible, nothing retried blindly, other records still written", async () => {
		const timers = fakeTimers();
		const errors: string[] = [];
		const sent: QueuedRecord[][] = [];
		const q = new RecordQueue({
			run: async (records) => {
				sent.push(records);
				const badIndex = records.findIndex((r) => r.run_id === 7);
				if (badIndex >= 0) {
					return {
						exitCode: 1,
						stderr: "",
						stdout: JSON.stringify({
							ok: false,
							status: "invalid",
							error: `record at index ${badIndex} has run_id 7; identifier fields must be strings or null`,
							persisted: { event: 0, metric: 0, outcome: 0 },
							duplicates: { event: 0, metric: 0, outcome: 0 },
							retry: null,
						}),
					};
				}
				return okBody(records);
			},
			onError: (m) => errors.push(m),
			...timers,
		});
		const good = q.enqueue("event", { event: "ok", run_id: "r1" });
		const bad = q.enqueue("event", { event: "broken", run_id: 7 as unknown as string });
		const report = await q.flush();

		expect(report.ok).toBe(false);
		expect(report.failed).toBe(1);
		expect(report.error).toContain("run_id 7");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.join("\n")).toContain("run_id 7");
		expect(q.lastError).toContain("run_id 7");
		expect(q.failures.map((r) => r.record_id)).toEqual([bad]);
		// The all-or-nothing rejection of the pair fell back to per-record writes: the good one landed once.
		const acked = sent.filter((b) => !b.some((r) => r.run_id === 7)).flat();
		expect(acked.map((r) => r.record_id)).toEqual([good]);
		expect(q.stats).toMatchObject({ acknowledged: 1, failed: 1 });
	});

	test("an ambiguous exit (no acknowledgement) is replayed with the same record ids, then acknowledged", async () => {
		const timers = fakeTimers();
		const sent: QueuedRecord[][] = [];
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				sent.push(records);
				calls += 1;
				// First attempt: process died before printing its result (killed, OOM, pipe closed).
				if (calls === 1) return { exitCode: -1, stdout: "", stderr: "" };
				return okBody(records);
			},
			delay: async () => {},
			...timers,
		});
		const a = q.enqueue("event", { event: "a", run_id: "r1" });
		const b = q.enqueue("metric", { event: "model_call", run_id: "r1" });
		const report = await q.flush();
		expect(sent.length).toBe(2);
		expect(sent[1].map((r) => r.record_id)).toEqual([a, b]);
		expect(sent[1]).toEqual(sent[0]);
		expect(report).toMatchObject({ ok: true, acknowledged: 2, failed: 0 });
		expect(q.stats.retries).toBe(1);
	});

	test("exit 2 (append interrupted) and exit 3 (durable but refresh failed) both replay the same ids", async () => {
		const timers = fakeTimers();
		const sent: QueuedRecord[][] = [];
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				sent.push(records);
				calls += 1;
				const empty = { event: 0, metric: 0, outcome: 0 };
				if (calls === 1) {
					return {
						exitCode: 2,
						stderr: "",
						stdout: JSON.stringify({ ok: false, status: "append_failed", error: "EIO", persisted: { ...empty, event: 1 }, duplicates: empty, retry: "same_ids" }),
					};
				}
				if (calls === 2) {
					return {
						exitCode: 3,
						stderr: "",
						stdout: JSON.stringify({ ok: false, status: "refresh_failed", error: "dashboard render failed", persisted: { ...empty, metric: 1 }, duplicates: { ...empty, event: 1 }, retry: "same_ids" }),
					};
				}
				return okBody(records);
			},
			delay: async () => {},
			...timers,
		});
		q.enqueue("event", { event: "a", run_id: "r1" });
		q.enqueue("metric", { event: "model_call", run_id: "r1" });
		const report = await q.flush();
		expect(sent.length).toBe(3);
		for (const batch of sent) expect(batch.map((r) => r.record_id)).toEqual(sent[0].map((r) => r.record_id));
		expect(report.ok).toBe(true);
		expect(q.stats.retries).toBe(2);
	});

	test("after the retry budget is exhausted the records are reported as failed, never silently dropped", async () => {
		const timers = fakeTimers();
		const errors: string[] = [];
		let calls = 0;
		const q = new RecordQueue({
			run: async () => {
				calls += 1;
				return { exitCode: -1, stdout: "", stderr: "python3: not found" };
			},
			maxAttempts: 3,
			delay: async () => {},
			onError: (m) => errors.push(m),
			...timers,
		});
		const id = q.enqueue("outcome", { run_id: "r1", task_id: "run-complete", outcome: "verified" });
		const report = await q.flush();
		expect(calls).toBe(3);
		expect(report.ok).toBe(false);
		expect(report.failed).toBe(1);
		expect(report.error).toContain("python3: not found");
		expect(q.failures.map((r) => r.record_id)).toEqual([id]);
		expect(errors.at(-1)).toContain("run-complete");
		expect(q.pending).toBe(0);
	});

	test("a runner that throws is handled like an ambiguous exit and never rejects flush()", async () => {
		const timers = fakeTimers();
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				calls += 1;
				if (calls === 1) throw new Error("spawn EAGAIN");
				return okBody(records);
			},
			delay: async () => {},
			...timers,
		});
		q.enqueue("event", { event: "a", run_id: "r1" });
		await expect(q.flush()).resolves.toMatchObject({ ok: true, acknowledged: 1 });
	});

	test("exit 3 on every attempt leaves the records acknowledged as durable with the derived views reported stale, not as failed", async () => {
		const timers = fakeTimers();
		const errors: string[] = [];
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				calls += 1;
				const empty = { event: 0, metric: 0, outcome: 0 };
				return {
					exitCode: 3,
					stderr: "",
					stdout: JSON.stringify({
						ok: false,
						status: "refresh_failed",
						error: "dashboard refresh failed: disk full",
						persisted: calls === 1 ? { ...empty, outcome: records.length } : empty,
						duplicates: calls === 1 ? empty : { ...empty, outcome: records.length },
						retry: "same_ids",
					}),
				};
			},
			maxAttempts: 3,
			delay: async () => {},
			onError: (m) => errors.push(m),
			...timers,
		});
		const id = q.enqueue("outcome", { run_id: "r1", task_id: "run-complete", outcome: "verified" });
		const report = await q.flush();
		expect(calls).toBe(3);
		// The record is on disk: it is acknowledged, and nothing about it is "lost".
		expect(report.ok).toBe(true);
		expect(report.failed).toBe(0);
		expect(report.acknowledged).toBe(1);
		expect(report.derivedStale).toBe(1);
		expect(q.failures).toEqual([]);
		expect(q.stats).toMatchObject({ acknowledged: 1, failed: 0, derivedStale: 1, retries: 2 });
		// The operator still hears about it, worded as a stale ledger/dashboard, never as a lost record.
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("durable");
		expect(errors[0]).toContain("disk full");
		expect(errors[0]).not.toMatch(/could not be written|lost/);
		expect(q.lastError).toContain("durable");
		expect(q.lastStaleReason).toContain("disk full");
		expect(q.lastFailure).toBeNull();
		expect(report.error).toBeUndefined();
		expect(report.staleReason).toContain("disk full");
		expect(q.failures.map((r) => r.record_id)).not.toContain(id);
	});

	test("once an attempt reported the records durable, later ambiguous exits still end as stale derived views, not lost records", async () => {
		const timers = fakeTimers();
		let calls = 0;
		const q = new RecordQueue({
			run: async () => {
				calls += 1;
				const empty = { event: 0, metric: 0, outcome: 0 };
				if (calls === 1) {
					return { exitCode: 3, stderr: "", stdout: JSON.stringify({ ok: false, status: "checkpoint_failed", error: "sqlite locked", persisted: { ...empty, event: 2 }, duplicates: empty, retry: "same_ids" }) };
				}
				return { exitCode: -1, stdout: "", stderr: "killed" };
			},
			maxAttempts: 3,
			delay: async () => {},
			...timers,
		});
		q.enqueue("event", { event: "a", run_id: "r1" });
		q.enqueue("event", { event: "b", run_id: "r1" });
		const report = await q.flush();
		expect(calls).toBe(3);
		expect(report).toMatchObject({ ok: true, acknowledged: 2, failed: 0, derivedStale: 2 });
		expect(q.failures).toEqual([]);
	});

	test("exit 1 without a structured JSON body is ambiguous: replayed with the same ids, never split per record", async () => {
		const timers = fakeTimers();
		const sent: QueuedRecord[][] = [];
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				sent.push(records);
				calls += 1;
				// The interpreter died before the CLI could print its body (import error, OOM, SIGPIPE): exit 1, no JSON.
				if (calls === 1) return { exitCode: 1, stdout: "", stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'orchestrator'" };
				return okBody(records);
			},
			delay: async () => {},
			...timers,
		});
		const ids = [
			q.enqueue("event", { event: "a", run_id: "r1" }),
			q.enqueue("event", { event: "b", run_id: "r1" }),
			q.enqueue("metric", { event: "model_call", run_id: "r1" }),
		];
		const report = await q.flush();
		// One replay of the whole batch, not one spawn per record on top of the failed batch.
		expect(sent.length).toBe(2);
		expect(sent[1].map((r) => r.record_id)).toEqual(ids);
		expect(report).toMatchObject({ ok: true, acknowledged: 3, failed: 0 });
		expect(q.stats.retries).toBe(1);
	});

	test("exit 1 without a JSON body that never recovers is reported as failed with the stderr tail, after the retry budget only", async () => {
		const timers = fakeTimers();
		let calls = 0;
		const q = new RecordQueue({
			run: async () => {
				calls += 1;
				return { exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'orchestrator'" };
			},
			maxAttempts: 2,
			delay: async () => {},
			...timers,
		});
		for (let i = 0; i < 4; i++) q.enqueue("event", { event: `e${i}`, run_id: "r1" });
		const report = await q.flush();
		expect(calls).toBe(2);
		expect(report).toMatchObject({ ok: false, failed: 4, acknowledged: 0 });
		expect(report.error).toContain("ModuleNotFoundError");
	});

	test("exit 0 with duplicates counts the records as acknowledged (the store already had them)", async () => {
		const timers = fakeTimers();
		const q = new RecordQueue({
			run: async (records) => ({
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({ ok: true, status: "ok", persisted: { event: 0, metric: 0, outcome: 0 }, duplicates: { event: records.length, metric: 0, outcome: 0 }, retry: null }),
			}),
			...timers,
		});
		q.enqueue("event", { event: "a", run_id: "r1" });
		const report = await q.flush();
		expect(report).toMatchObject({ ok: true, acknowledged: 1, failed: 0 });
		expect(q.stats.duplicates).toBe(1);
	});
});

describe("RecordQueue record timestamps", () => {
	test("a record is stamped with its enqueue time, so the coalescing delay and retries do not shift `ts`", async () => {
		const store = fakeStore();
		const stamps = ["2026-09-23T10:00:00.000Z", "2026-09-23T10:00:00.250Z"];
		let i = 0;
		const q = new RecordQueue({ run: store.run, now: () => stamps[i++], ...fakeTimers() });
		q.enqueue("event", { event: "a", run_id: "r1" });
		q.enqueue("event", { event: "b", run_id: "r1", ts: "2026-01-01T00:00:00.000Z" });
		await q.flush();
		expect(store.batches[0][0].ts).toBe(stamps[0]);
		// A caller-supplied ts is kept.
		expect(store.batches[0][1].ts).toBe("2026-01-01T00:00:00.000Z");
	});

	test("the default stamp is an ISO-8601 UTC instant taken at enqueue", async () => {
		const store = fakeStore();
		const q = new RecordQueue({ run: store.run, ...fakeTimers() });
		const before = Date.now();
		q.enqueue("event", { event: "a", run_id: "r1" });
		const after = Date.now();
		await q.flush();
		const ts = store.batches[0][0].ts as string;
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Date.parse(ts)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(ts)).toBeLessThanOrEqual(after);
	});
});

describe("RecordQueue snapshots", () => {
	test("snapshot() is an independent copy of the counters, so a run can measure what happened since it started", async () => {
		const store = fakeStore();
		const q = new RecordQueue({ run: store.run, ...fakeTimers() });
		q.enqueue("event", { event: "before", run_id: "r0" });
		await q.flush();
		const baseline = q.snapshot();
		q.enqueue("event", { event: "after", run_id: "r1" });
		await q.flush();
		expect(baseline.acknowledged).toBe(1);
		expect(q.stats.acknowledged).toBe(2);
		expect(q.stats.acknowledged - baseline.acknowledged).toBe(1);
	});
});

describe("RecordQueue spawn count (instrumented) versus the one-process-per-record baseline", () => {
	test("a three-dispatch run boundary needs two spawns instead of fourteen", async () => {
		const store = fakeStore();
		const timers = fakeTimers();
		const q = new RecordQueue({ run: store.run, ...timers });
		let baselineSpawns = 0; // the pre-queue bridge spawned one Python process per record
		const record = (stream: "event" | "metric" | "outcome", payload: Record<string, unknown>) => {
			baselineSpawns += 1;
			q.enqueue(stream, payload);
		};

		// dispatch_started for three parallel leads (previously three awaited spawns before any child ran)
		for (let i = 0; i < 3; i++) record("event", { event: "dispatch_started", run_id: "r1", task_id: `lead-${i}` });
		timers.fire(); // coalescing window elapses while the leads run
		await q.flush();

		// each lead finishes: dispatch_finished + model_call + route_executed; then QA outcome and run outcome
		for (let i = 0; i < 3; i++) {
			record("event", { event: "dispatch_finished", run_id: "r1", task_id: `lead-${i}` });
			record("metric", { event: "model_call", run_id: "r1", task_id: `lead-${i}` });
			record("metric", { event: "route_executed", run_id: "r1", task_id: `lead-${i}` });
		}
		record("outcome", { run_id: "r1", task_id: "r1-qa", outcome: "verified" });
		record("outcome", { run_id: "r1", task_id: "run-complete", outcome: "verified" });
		await q.flush(); // terminal flush at run completion

		expect(baselineSpawns).toBe(14);
		expect(store.batches.length).toBe(2);
		expect(store.batches.flat().length).toBe(14);
		expect(q.stats.batches).toBe(2);
	});
});

// -----------------------------------------------------------------------------
// Integration with the real Python `batch` command (temp state root)
// -----------------------------------------------------------------------------

describe("RecordQueue against the real Python batch CLI", () => {
	test("an ambiguous exit is replayed with the same ids and the store holds each record exactly once", async () => {
		const stateRoot = tempStateRoot();
		const spawns = { count: 0 };
		const real = pythonBatchRunner(stateRoot, spawns);
		let calls = 0;
		const q = new RecordQueue({
			run: async (records) => {
				calls += 1;
				const result = await real(records);
				// The write completed, but the acknowledgement was lost (the bridge sees a crash/kill).
				if (calls === 1) return { exitCode: -1, stdout: "", stderr: "" };
				return result;
			},
			delay: async () => {},
			...fakeTimers(),
		});
		const e = q.enqueue("event", { event: "dispatch_started", run_id: "r-replay", task_id: "t1" });
		const m = q.enqueue("metric", { event: "model_call", run_id: "r-replay", task_id: "t1", model: "p/m", cost_usd: 0.01, input_tokens: 1, output_tokens: 1 });
		const o = q.enqueue("outcome", { run_id: "r-replay", task_id: "t1", outcome: "verified", quality: 1 });
		const report = await q.flush();

		expect(spawns.count).toBe(2);
		expect(report).toMatchObject({ ok: true, acknowledged: 3, failed: 0 });
		expect(q.stats.retries).toBe(1);
		expect(q.stats.duplicates).toBe(3);
		expect(readIds(stateRoot, "events.jsonl")).toEqual([e]);
		expect(readIds(stateRoot, "metrics.jsonl")).toEqual([m]);
		expect(readIds(stateRoot, "outcomes.jsonl")).toEqual([o]);
	}, 30_000);

	test("a malformed record is rejected by Python with its error surfaced; the valid records in the same batch are still persisted once", async () => {
		const stateRoot = tempStateRoot();
		const spawns = { count: 0 };
		const errors: string[] = [];
		const q = new RecordQueue({ run: pythonBatchRunner(stateRoot, spawns), delay: async () => {}, onError: (m) => errors.push(m), ...fakeTimers() });
		const good = q.enqueue("event", { event: "dispatch_started", run_id: "r-bad", task_id: "t1" });
		const bad = q.enqueue("event", { event: "dispatch_finished", run_id: 7 as unknown as string, task_id: "t1" });
		const report = await q.flush();

		expect(report.ok).toBe(false);
		expect(report.failed).toBe(1);
		expect(report.error).toContain("run_id 7");
		expect(q.failures.map((r) => r.record_id)).toEqual([bad]);
		expect(errors.join("\n")).toContain("run_id 7");
		expect(readIds(stateRoot, "events.jsonl")).toEqual([good]);
	}, 30_000);

	test("the enqueue-time ts is honoured by the Python writer instead of being replaced by the write time", async () => {
		const stateRoot = tempStateRoot();
		const spawns = { count: 0 };
		const q = new RecordQueue({ run: pythonBatchRunner(stateRoot, spawns), now: () => "2026-09-23T10:00:00.000Z", ...fakeTimers() });
		const id = q.enqueue("event", { event: "dispatch_started", run_id: "r-ts", task_id: "t1" });
		const report = await q.flush();
		expect(report.ok).toBe(true);
		const rows = readFileSync(join(stateRoot, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		expect(rows.find((r) => r.record_id === id)?.ts).toBe("2026-09-23T10:00:00.000Z");
	}, 30_000);

	test("an interpreter that cannot import the package (exit 1, no JSON body) is replayed as a whole batch, not per record", async () => {
		const stateRoot = tempStateRoot();
		const spawns = { count: 0 };
		const real = pythonBatchRunner(stateRoot, spawns);
		const sizes: number[] = [];
		let calls = 0;
		let noImportResult: CliResult | undefined;
		const q = new RecordQueue({
			run: async (records) => {
				sizes.push(records.length);
				calls += 1;
				if (calls === 1) {
					// Exclude the checkout (via cwd), PYTHONPATH, and installed site packages so this
					// interpreter reliably fails before the CLI can print a JSON body.
					const isolatedRoot = mkdtempSync(join(tmpdir(), "orch-empty-pythonpath-"));
					tempRoots.push(isolatedRoot);
					return new Promise<CliResult>((resolve) => {
						spawns.count += 1;
						const child = spawn(PYTHON, ["-B", "-S", "-m", "orchestrator.cli", "batch", "-"], {
							cwd: isolatedRoot,
							env: { ...process.env, PYTHONPATH: isolatedRoot, PYTHONDONTWRITEBYTECODE: "1", CODING_AGENT_ORCHESTRATOR_HOME: stateRoot },
							stdio: ["pipe", "pipe", "pipe"],
						});
						let stdout = "";
						let stderr = "";
						child.stdout.on("data", (b) => (stdout += b.toString()));
						child.stderr.on("data", (b) => (stderr += b.toString()));
						child.on("close", (code) => {
							noImportResult = { stdout, stderr, exitCode: code ?? -1 };
							resolve(noImportResult);
						});
						child.stdin.on("error", () => {});
						child.stdin.end(JSON.stringify(records));
					});
				}
				return real(records);
			},
			delay: async () => {},
			...fakeTimers(),
		});
		const ids = [
			q.enqueue("event", { event: "dispatch_started", run_id: "r-noimport", task_id: "t1" }),
			q.enqueue("event", { event: "dispatch_finished", run_id: "r-noimport", task_id: "t1" }),
			q.enqueue("outcome", { run_id: "r-noimport", task_id: "t1", outcome: "verified", quality: 1 }),
		];
		const report = await q.flush();
		expect(noImportResult).toMatchObject({ exitCode: 1, stdout: "" });
		expect(noImportResult?.stderr).toContain("ModuleNotFoundError: No module named 'orchestrator'");
		expect(sizes).toEqual([3, 3]);
		expect(spawns.count).toBe(2);
		expect(report).toMatchObject({ ok: true, acknowledged: 3, failed: 0 });
		expect(readIds(stateRoot, "events.jsonl")).toEqual(ids.slice(0, 2));
		expect(readIds(stateRoot, "outcomes.jsonl")).toEqual([ids[2]]);
	}, 30_000);
});

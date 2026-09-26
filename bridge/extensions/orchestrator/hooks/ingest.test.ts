import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import contract from "../contract.json";
import { SessionIngestScheduler } from "../ingest.ts";
import { recordHookFailure, redactPaths, registerSessionIngestHooks } from "./ingest.ts";

describe("session ingest hook wiring", () => {
	test("both lifecycle hooks use the current session file and the supplied scheduler", async () => {
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		const scheduled: string[] = [];
		const flushed: string[] = [];
		const scheduler = {
			schedule: (file: string | undefined) => { if (file) scheduled.push(file); },
			flush: async (file: string | undefined) => { if (file) flushed.push(file); },
		};
		registerSessionIngestHooks({
			on: (event: string, handler: (...args: any[]) => unknown) => { handlers[event] = handler; },
		} as never, scheduler as never);

		const ctxFor = (file: string) => ({ sessionManager: { getSessionFile: () => file } });
		await handlers.agent_settled({}, ctxFor("/sessions/current-settled.jsonl"));
		await handlers.session_shutdown({}, ctxFor("/sessions/current-shutdown.jsonl"));
		expect(scheduled).toEqual(["/sessions/current-settled.jsonl"]);
		expect(flushed).toEqual(["/sessions/current-shutdown.jsonl"]);
	});

	test("shared shutdown hook bounds a stalled ingest and reports failure without abandoning its drain", async () => {
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const errors: string[] = [];
		const realTimer = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) =>
			realTimer(fn, ms === 2000 ? 5 : ms)) as typeof setTimeout);
		try {
			registerSessionIngestHooks({
				on: (event: string, handler: (...args: any[]) => unknown) => { handlers[event] = handler; },
			} as never, { schedule: () => {}, flush: () => pending }, (message) => errors.push(message));
			const result = await Promise.race([
				Promise.resolve(handlers.session_shutdown({}, { sessionManager: { getSessionFile: () => "/session.jsonl" } })).then(() => true),
				new Promise<boolean>((resolve) => realTimer(() => resolve(false), 100)),
			]);
			expect(result).toBe(true);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("shutdown ingestion timed out");
		} finally {
			release();
			timer.mockRestore();
		}
	});

	test("same-session append during an in-flight run is consumed by the queued rerun", async () => {
		const root = mkdtempSync(join(tmpdir(), "orch-queued-ingest-test-"));
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(sessionFile, "initial\n");
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		let markSecondFinished!: () => void;
		const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const secondFinished = new Promise<void>((resolve) => { markSecondFinished = resolve; });
		const snapshots: string[] = [];
		const scheduler = new SessionIngestScheduler({
			debounceMs: 0,
			run: async (file) => {
				snapshots.push(readFileSync(file, "utf8"));
				if (snapshots.length === 1) {
					markFirstStarted();
					await firstGate;
				} else {
					markSecondFinished();
				}
				return { ok: true };
			},
		});
		const handlers: Record<string, (...args: any[]) => unknown> = {};
		registerSessionIngestHooks({
			on: (event: string, handler: (...args: any[]) => unknown) => { handlers[event] = handler; },
		} as never, scheduler);
		const context = { sessionManager: { getSessionFile: () => sessionFile } };
		try {
			await handlers.agent_settled({}, context);
			await firstStarted;
			writeFileSync(sessionFile, "initial\nappended-during-ingest\n");
			await handlers.agent_settled({}, context);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(snapshots).toHaveLength(1);
			releaseFirst();
			await secondFinished;
			await scheduler.flush(null);
			expect(snapshots).toHaveLength(2);
			expect(snapshots[0]).toBe("initial\n");
			expect(snapshots[1]).toContain("appended-during-ingest");
		} finally {
			releaseFirst();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("empty CLI failure detail falls back to the previous status error", () => {
		const root = mkdtempSync(join(tmpdir(), "orch-hook-empty-error-test-"));
		try {
			writeFileSync(join(root, "ingest_status.json"), JSON.stringify({
				version: 1,
				last_success_at: "2025-12-31T23:00:00Z",
				status: "partial",
				error: "previous useful failure detail",
			}));
			recordHookFailure(root, "ingest /session.jsonl: exit 2:   ");

			const status = JSON.parse(readFileSync(join(root, "ingest_status.json"), "utf8"));
			expect(status.error).toBe("previous useful failure detail");
			expect(status.last_success_at).toBe("2025-12-31T23:00:00Z");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("final hook failure atomically records bounded status and preserves last success", () => {
		const root = mkdtempSync(join(tmpdir(), "orch-hook-failure-test-"));
		try {
			writeFileSync(join(root, "ingest_status.json"), JSON.stringify({
				version: 1,
				last_attempt_at: "2026-01-01T00:00:00Z",
				last_success_at: "2025-12-31T23:00:00Z",
				status: "ok",
				files_scanned: 1,
				emitted: 2,
				failure_count: 0,
				error: null,
				sweep_interval_seconds: 900,
			}));
			recordHookFailure(root, `failed\n${"x".repeat(2000)}`);

			const status = JSON.parse(readFileSync(join(root, "ingest_status.json"), "utf8"));
			expect(status.status).toBe("error");
			expect(status.last_success_at).toBe("2025-12-31T23:00:00Z");
			expect(status.failure_count).toBe(1);
			expect(status.error.length).toBeLessThanOrEqual(240);
			expect(status.error).not.toContain("\n");
			expect(readdirSync(root).sort()).toEqual(["ingest_status.json"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("recordHookFailure redacts absolute paths and bounds error to 240 chars", () => {
		const root = mkdtempSync(join(tmpdir(), "orch-hook-redact-test-"));
		try {
			recordHookFailure(root, "ingest failed at /Users/alice/.local/state/foo/bar.jsonl: " + "x".repeat(2000));
			const status = JSON.parse(readFileSync(join(root, "ingest_status.json"), "utf8"));
			expect(status.status).toBe("error");
			expect(status.error.length).toBeLessThanOrEqual(240);
			expect(status.error).not.toContain("/Users/alice");
			expect(status.error).toContain("<path>");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("recordHookFailure's written status has exactly the fields contract.json's ingest_status.fields declares (B4.7)", () => {
		// Python's make_ingest_status (orchestrator/ingest/service.py) and this TS hook build the
		// same ingest_status.json shape from the same contract; this proves the TS side's output
		// keys are exactly that shared field list (see tests/test_contract.py for the Python side).
		const root = mkdtempSync(join(tmpdir(), "orch-hook-fields-test-"));
		try {
			recordHookFailure(root, "boom");
			const status = JSON.parse(readFileSync(join(root, "ingest_status.json"), "utf8"));
			expect(Object.keys(status).sort()).toEqual([...contract.ingest_status.fields].sort());
			expect(status.status).toBe(contract.ingest_status.status_values.error);
			expect(status.sweep_interval_seconds).toBe(contract.ingest_status.default_sweep_interval_seconds);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("redactPaths matches contract.json's ts redaction_regex on a sample", () => {
		// The B1 review asked for a consumer-level parity check, not just the JSON: this
		// exercises the actual exported function, not a re-typed copy of the pattern.
		const contractRe = new RegExp(contract.redaction_regex.ts, "g");
		const sample = "failed: /Users/alice/proj/file.ts and /home/bob/other.py and ~/relative/thing";
		expect(redactPaths(sample)).toBe(sample.replace(contractRe, "<path>"));
		expect(redactPaths(sample)).toBe("failed: <path> and <path> and <path>");
	});
});

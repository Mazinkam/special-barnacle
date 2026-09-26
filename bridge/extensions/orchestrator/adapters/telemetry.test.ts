import { describe, expect, mock, test } from "bun:test";

import { createTelemetry } from "./telemetry.ts";

function ok(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
}

describe("createTelemetry", () => {
	test("recordEvent stamps the event name into the payload and enqueues an event row", async () => {
		const runBatch = mock((_records: Array<Record<string, unknown>>) => ok());
		const telemetry = createTelemetry({ runBatch, maxBatch: 10, flushDelayMs: 10, onError: () => {} });
		telemetry.recordEvent("dispatch_started", { run_id: "r1" });
		expect(telemetry.queue.pending).toBe(1);
		await telemetry.queue.flush();
		expect(runBatch).toHaveBeenCalledTimes(1);
		const records: Array<Record<string, unknown>> = runBatch.mock.calls[0]?.[0] ?? [];
		expect(records[0]).toMatchObject({ stream: "event", run_id: "r1", event: "dispatch_started" });
	});

	test("recordModelCall and recordOutcome enqueue metric/outcome rows unchanged", async () => {
		const runBatch = mock((_records: Array<Record<string, unknown>>) => ok());
		const telemetry = createTelemetry({ runBatch, maxBatch: 10, flushDelayMs: 10, onError: () => {} });
		telemetry.recordModelCall({ model: "p/m", cost_usd: 0.01 });
		telemetry.recordOutcome({ run_id: "r1", outcome: "verified" });
		await telemetry.queue.flush();
		const records: Array<Record<string, unknown>> = runBatch.mock.calls[0]?.[0] ?? [];
		expect(records.find((r) => r.stream === "metric")).toMatchObject({ model: "p/m", cost_usd: 0.01 });
		expect(records.find((r) => r.stream === "outcome")).toMatchObject({ run_id: "r1", outcome: "verified" });
	});

	test("onError is the caller's own callback, not a UI global the adapter reaches into", async () => {
		const errors: string[] = [];
		const runBatch = mock((_records: Array<Record<string, unknown>>) =>
			Promise.resolve({ stdout: "", stderr: "boom", exitCode: 1 }),
		);
		const telemetry = createTelemetry({
			runBatch,
			maxBatch: 10,
			flushDelayMs: 10,
			onError: (message) => errors.push(message),
		});
		telemetry.recordEvent("dispatch_started", { run_id: "r1" });
		await telemetry.queue.flush();
		expect(errors.length).toBeGreaterThan(0);
	});
});

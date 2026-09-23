import { describe, expect, test } from "bun:test";
import { RunCancellation } from "./cancellation.ts";

describe("run cancellation", () => {
	test("notifies active work once and rejects later work after cancellation", () => {
		const cancellation = new RunCancellation();
		let stopped = 0;
		cancellation.onCancel(() => stopped++);

		cancellation.cancel();
		cancellation.cancel();

		expect(stopped).toBe(1);
		expect(() => cancellation.throwIfCancelled()).toThrow("Orchestration cancelled");
	});

	test("releases a pending confirmation when the run is cancelled", async () => {
		const cancellation = new RunCancellation();
		const pendingConfirmation = new Promise<boolean>(() => {});
		const result = Promise.race([cancellation.wait(), pendingConfirmation]);

		cancellation.cancel();

		await expect(result).rejects.toThrow("Orchestration cancelled");
	});

	test("stops work registered after cancellation immediately", () => {
		const cancellation = new RunCancellation();
		cancellation.cancel();
		let stopped = 0;

		cancellation.onCancel(() => stopped++);

		expect(stopped).toBe(1);
	});
});

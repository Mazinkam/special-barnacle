import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { confirmStep, safeUi } from "./ui-sink.ts";

describe("safeUi", () => {
	test("runs the function and returns normally when it does not throw", () => {
		let ran = false;
		safeUi(() => { ran = true; });
		expect(ran).toBe(true);
	});

	test("swallows a throw instead of propagating it", () => {
		expect(() => safeUi(() => { throw new Error("ctx.ui unavailable"); })).not.toThrow();
	});
});

describe("confirmation gates", () => {
	// Kept this branch's parameterised version over main's single-case variant:
	// it covers interactive=true as well, asserts the return value, and asserts
	// the ctx.confirm delegation. The expected detail string is main's wording,
	// which the merged confirmation call now uses (progress-aware timeouts made
	// "up to N min per dispatch" wrong).
	test.each([false, true])("dispatch call passes separate confirmation arguments (interactive=%s)", async (interactive) => {
		// Execute the actual call expression after the plan summary, not a copy of it.
		// This isolates argument construction without planning or dispatching agents. The plan
		// summary and its confirmation gate live in pipeline/run-orchestration.ts (B4.6).
		const source = readFileSync(new URL("../pipeline/run-orchestration.ts", import.meta.url), "utf8");
		const afterSummary = source.slice(source.indexOf("session.log(planSummary.join"));
		const call = afterSummary.match(/confirmStep\([\s\S]*?\n\s*\)/)?.[0];
		if (!call) throw new Error("Dispatch confirmation call not found after plan summary");
		const invoke = new Function("ctx", "pipeline", "parsed", "DISPATCH_TIMEOUT_MS", "confirmStep", `return ${call};`);
		const confirm = mock(() => Promise.resolve(false));
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };
		const confirmStepSpy = mock(confirmStep);

		const result = await invoke(ctx, "lead → workers → qa", { interactive }, 120000, confirmStepSpy);

		const details =
			"lead → workers → qa\n\nOrchestrating stages use an inactivity limit plus an absolute ceiling (leaf dispatches use a fixed timeout); live progress shows above the editor.";
		expect(confirmStepSpy).toHaveBeenCalledWith(
			ctx,
			"Dispatch this plan?",
			details,
			interactive,
		);
		expect(result).toBe(!interactive);
		if (interactive) {
			expect(confirm).toHaveBeenCalledWith("Dispatch this plan?", details);
		} else {
			expect(confirm).not.toHaveBeenCalled();
		}
	});

	test("auto-confirms when interactive confirmation is not requested", async () => {
		const confirm = mock(() => false);
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(confirmStep(ctx as never, "Dispatch?", "details", false)).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	test("opens the confirmation dialog in interactive mode", async () => {
		const confirm = mock(() => Promise.resolve(false));
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(confirmStep(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(confirm).toHaveBeenCalledWith("Dispatch?", "details");
	});

	test("aborts an interactive confirmation request without a UI", async () => {
		const notify = mock();
		const ctx = { hasUI: false, ui: { confirm: mock(), notify } };

		await expect(confirmStep(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"Dispatch?: no UI to confirm — remove --interactive to run automatically",
			"error",
		);
	});
});

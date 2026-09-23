import { describe, expect, mock, test } from "bun:test";

mock.module("@humain/terminal", () => ({
	discoverAgents: () => [],
	renderTaskWithContext: (task: string) => task,
}));

const orchestrator = await import("./index.ts");

describe("/orchestrate argument parsing", () => {
	test("runs without confirmation unless interactive mode is explicitly requested", () => {
		expect(orchestrator.parseArgs).toBeFunction();
		const parsed = orchestrator.parseArgs!("repair the login race");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(false);
	});

	test("enables confirmation gates when --interactive is supplied", () => {
		expect(orchestrator.parseArgs).toBeFunction();
		const parsed = orchestrator.parseArgs!("repair the login race --interactive");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(true);
		expect(parsed.unknownFlags).toEqual([]);
	});
});

describe("confirmation gates", () => {
	test("auto-confirms when interactive confirmation is not requested", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const confirm = mock(() => false);
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", false)).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	test("opens the confirmation dialog in interactive mode", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const confirm = mock(() => Promise.resolve(false));
		const ctx = { hasUI: true, ui: { confirm, notify: mock() } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(confirm).toHaveBeenCalledWith("Dispatch?", "details");
	});

	test("aborts an interactive confirmation request without a UI", async () => {
		expect(orchestrator.confirmStep).toBeFunction();
		const notify = mock();
		const ctx = { hasUI: false, ui: { confirm: mock(), notify } };

		await expect(orchestrator.confirmStep!(ctx as never, "Dispatch?", "details", true)).resolves.toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"Dispatch?: no UI to confirm — remove --interactive to run automatically",
			"error",
		);
	});
});

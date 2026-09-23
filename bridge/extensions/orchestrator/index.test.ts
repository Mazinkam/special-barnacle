import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("@humain/terminal", () => ({
	BorderedLoader: class {
		onAbort?: () => void;
		constructor(..._args: unknown[]) {}
	},
	discoverAgents: () => [],
	renderTaskWithContext: (task: string) => task,
}));

const testStateRoot = mkdtempSync(join(tmpdir(), "orch-run-session-test-"));
process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT = testStateRoot;
const orchestrator = await import("./index.ts");
afterAll(() => {
	rmSync(testStateRoot, { recursive: true, force: true });
});

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

describe("RunSession cancellation presentation", () => {
	test("keeps the cancelled goal and stopped dispatch visible after cleanup", () => {
		const widgets: unknown[] = [];
		const statuses: unknown[] = [];
		const ctx = {
			ui: {
				setWidget: (_id: string, value: unknown) => widgets.push(value),
				setStatus: (_id: string, value: unknown) => statuses.push(value),
				notify: mock(),
			},
		};
		const session = new orchestrator.RunSession!("cancel-ui-test", ctx as never, "update the payments page");
		session.startDispatch("lead-1", "lead", "provider/model");
		session.cancel();
		session.endDispatch("lead-1", 137, 0);
		session.close(true);

		const finalWidget = widgets.at(-1) as string[];
		expect(finalWidget).toContain("Goal: update the payments page");
		expect(finalWidget.some((line) => line.includes("lead") && line.includes("cancelled by user"))).toBe(true);
		expect(statuses.at(-1)).toContain("cancelled");
	});
});

describe("confirmation gates", () => {
	test("passes the dispatch title and details as separate confirmation arguments", async () => {
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const planSummary = source.indexOf("const planSummary = [");
		const callStart = source.indexOf("confirmStep(", planSummary);
		const callEnd = source.indexOf("\n\t\t\t\t)", callStart) + "\n\t\t\t\t)".length;
		expect(planSummary).toBeGreaterThanOrEqual(0);
		expect(callStart).toBeGreaterThan(planSummary);
		expect(callEnd).toBeGreaterThan(callStart);

		const runCall = new Function(
			"confirmStep",
			"ctx",
			"pipeline",
			"parsed",
			"DISPATCH_TIMEOUT_MS",
			`return ${source.slice(callStart, callEnd)};`,
		) as (
			confirmStep: (...args: unknown[]) => Promise<boolean>,
			ctx: object,
			pipeline: string,
			parsed: { interactive: boolean },
			DISPATCH_TIMEOUT_MS: number,
		) => Promise<boolean>;
		const confirmStep = mock(async (..._args: unknown[]) => true);

		await expect(
			runCall(confirmStep, {}, "lead → workers → qa", { interactive: false }, 300_000),
		).resolves.toBe(true);
		expect(confirmStep).toHaveBeenCalledWith(
			{},
			"Dispatch this plan?",
			"lead → workers → qa\n\nEach stage runs headless (up to 5 min per dispatch); live progress shows above the editor.",
			false,
		);
	});

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

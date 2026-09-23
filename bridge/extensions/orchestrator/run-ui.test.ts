import { describe, expect, mock, test } from "bun:test";
import {
	applyObservation,
	applyWarnings,
	connectCancellationLoader,
	createProgressView,
	formatNestedWorkerRows,
	formatProgressLine,
	formatWarningLine,
} from "./run-ui.ts";
import type { NestedWorkerSnapshot } from "./dispatch-progress.ts";

describe("orchestration progress UI", () => {
	test("progress updates its timestamp and clears only an inactivity warning", () => {
		const view = createProgressView(100);
		applyWarnings(view, [{ kind: "inactivity", text: "⚠ no meaningful progress (raise HUMAIN_ORCHESTRATOR_LEAD_INACTIVITY_TIMEOUT_MS)" }], 200, () => {});
		expect(view.warning?.kind).toBe("inactivity");
		applyObservation(view, { kind: "progress", detail: "bash bun test" }, 300);

		expect(view.lastProgressAt).toBe(300);
		expect(view.lastProgressDetail).toBe("bash bun test");
		expect(view.warning).toBeUndefined();

		applyWarnings(view, [{ kind: "absolute", text: "absolute ceiling warning" }], 350, () => {});
		expect(view.warning?.kind).toBe("absolute");
		applyObservation(view, { kind: "progress", detail: "new work" }, 400);
		expect(view.warning?.kind).toBe("absolute");
	});

	test("uses structured warning kinds rather than inspecting warning text", () => {
		const view = createProgressView(0);
		const inactivityWarning = "warning mentioning an absolute path";
		applyWarnings(view, [{ kind: "inactivity", text: inactivityWarning }], 1_000, () => {});
		expect(view.warning?.kind).toBe("inactivity");
		applyObservation(view, { kind: "progress", detail: "new work" }, 2_000);
		expect(view.warning).toBeUndefined();

		applyWarnings(view, [{ kind: "absolute", text: "no recognizable prefix" }], 3_000, () => {});
		applyObservation(view, { kind: "progress", detail: "more work" }, 4_000);
		expect(view.warning?.kind).toBe("absolute");
	});

	test("sanitizes warning text before passing it to the log callback", () => {
		const logged: string[] = [];
		applyWarnings(createProgressView(0), [{ kind: "inactivity", text: "warning\nwith\twhitespace" }], 1_000, (line) => logged.push(line));
		expect(logged).toEqual(["warning with whitespace"]);
	});

	test("heartbeat and ignored observations leave progress state unchanged", () => {
		const view = createProgressView(100);
		const before = { ...view };
		applyObservation(view, { kind: "heartbeat", detail: "alive" }, 200);
		applyObservation(view, { kind: "ignored", detail: "malformed" }, 300);

		expect(view.lastProgressAt).toBe(before.lastProgressAt);
		expect(view.lastProgressDetail).toBe(before.lastProgressDetail);
		expect(view.loopSuspects).toBe(before.loopSuspects);
		expect(view.duplicateSnapshots).toBe(before.duplicateSnapshots);
		applyObservation(view, { kind: "loop", detail: "repeated call" }, 400);
		applyObservation(view, { kind: "duplicate", detail: "same snapshot" }, 500);
		expect(view.loopSuspects).toBe(1);
		expect(view.duplicateSnapshots).toBe(1);
		expect(view.nested.size).toBe(0);
	});

	test("upserts nested rows by task id and ignores unchanged snapshots", () => {
		const view = createProgressView(0);
		const snapshot = (taskId: string, turns: number, changed: boolean, exitCode = -1): NestedWorkerSnapshot => ({
			taskId, agent: `agent-${taskId}`, depth: 1, turns, exitCode,
			finished: exitCode !== -1,
			costUsd: 0.0123, latestText: `latest ${turns}`, changed,
		});
		const observe = (item: NestedWorkerSnapshot, now: number) => applyObservation(view, {
			kind: item.changed ? "progress" : "duplicate", detail: "nested snapshot", nested: [item],
		}, now);

		observe(snapshot("task-a", 1, true), 10);
		observe(snapshot("task-b", 1, true), 20);
		const originalChangedAt = view.nested.get("task-a")?.lastChangedAt;
		observe(snapshot("task-a", 2, false), 30);
		observe(snapshot("task-c", 1, false), 40);
		expect(view.nested.size).toBe(2);
		expect(view.nested.get("task-a")?.lastChangedAt).toBe(originalChangedAt);
		expect(view.nested.get("task-a")?.turns).toBe(1);
		expect(view.nested.has("task-c")).toBe(false);

		observe(snapshot("task-a", 3, true, 0), 50);
		expect(view.nested.size).toBe(2);
		expect(view.nested.get("task-a")?.turns).toBe(3);
		expect(view.nested.get("task-a")?.exitCode).toBe(0);
	});

	test("renders a task-event-finished worker as complete without an exit code", () => {
		const view = createProgressView(0);
		applyObservation(view, {
			kind: "progress",
			detail: "nested worker completed",
			nested: [{
				taskId: "completed-by-event", agent: "worker", depth: 1, turns: 1,
				exitCode: -1, finished: true, costUsd: 0, latestText: "done", changed: true,
			}],
		}, 100);
		expect(formatNestedWorkerRows(view, 100, 0)[0]).toContain("✓");
	});

	test("bounds nested rows to the 32 most recently first-seen workers", () => {
		const view = createProgressView(0);
		for (let index = 0; index < 33; index++) {
			applyObservation(view, {
				kind: "progress",
				detail: "worker seen",
				nested: [{
					taskId: `task-${index}`, agent: "worker", depth: 1, turns: 1,
					exitCode: -1, finished: false, costUsd: 0, latestText: "", changed: true,
				}],
			}, index);
		}
		expect(view.nested.size).toBe(32);
		expect(view.nested.has("task-0")).toBe(false);
		expect(view.nested.has("task-32")).toBe(true);
	});

	test("logs identical warnings at most once within five minutes", () => {
		const view = createProgressView(0);
		const logged: string[] = [];
		const warning = { kind: "inactivity" as const, text: "⚠ no meaningful progress for 23min" };
		applyWarnings(view, [warning], 1_000, (line) => logged.push(line));
		applyWarnings(view, [warning], 1_000 + 4 * 60_000, (line) => logged.push(line));
		expect(logged).toEqual([warning.text]);
		applyWarnings(view, [warning], 1_000 + 5 * 60_000, (line) => logged.push(line));
		expect(logged).toEqual([warning.text, warning.text]);
	});

	test("formats bounded progress, nested completion, and warning rows", () => {
		const now = 3 * 60_000 + 12_000;
		const view = createProgressView(0);
		applyObservation(view, {
			kind: "progress",
			detail: `bash ${"x".repeat(300)}`,
			nested: [{
				taskId: "nested-1", agent: "worker", depth: 1, turns: 2, exitCode: 0,
				finished: true,
				costUsd: 0.021, latestText: "all tests passed", changed: true,
			}],
		}, now - 10_000);
		applyWarnings(view, [{ kind: "absolute", text: "⚠ absolute ceiling approaching" }], now - 5_000, () => {});
		applyObservation(view, { kind: "loop", detail: "repeated call" }, now);
		applyObservation(view, { kind: "duplicate", detail: "same snapshot" }, now);

		const progressLine = formatProgressLine(view, now, "  ");
		const nestedLines = formatNestedWorkerRows(view, now, 0);
		const warningLine = formatWarningLine(view, now, "  ");
		expect(progressLine).toContain("10s ago");
		expect(progressLine).toContain("1 loop-suspect calls");
		expect(progressLine).toContain("1 duplicate snapshots");
		expect(nestedLines).toHaveLength(1);
		expect(nestedLines[0]).toContain("✓");
		expect(warningLine).toContain("⚠");
		for (const line of [progressLine, ...nestedLines, warningLine]) {
			if (line !== undefined) expect(line.length).toBeLessThanOrEqual(120);
		}
	});
});

describe("orchestration cancellation UI", () => {
	test("Esc requests cancellation and closes the loader exactly once", () => {
		const loader: { onAbort?: () => void } = {};
		const cancel = mock();
		const done = mock();
		const close = connectCancellationLoader(loader, cancel, done);

		loader.onAbort?.();

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledTimes(1);
		close();
		expect(done).toHaveBeenCalledTimes(1);
	});
});

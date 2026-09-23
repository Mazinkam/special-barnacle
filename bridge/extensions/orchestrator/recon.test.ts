import { describe, expect, test } from "bun:test";
import { formatReconEvidence, planReconTasks, type ReconPolicy } from "./recon.ts";

const methodWithRule2: ReconPolicy = {
	min_complexity: 5,
	workers_by_complexity: [
		{ min: 5, max: 6, workers: 3 },
		{ min: 7, max: 8, workers: 4 },
		{ min: 9, max: 10, workers: 5 },
	],
	worker_capability: "implementation_fast",
	skip_for_task_classes: ["investigation", "qa_verification"],
};

describe("planReconTasks", () => {
	test("plans three independent read-only recon tasks at complexity 5", () => {
		const tasks = planReconTasks({
			method: methodWithRule2,
			complexity: 5,
			taskClass: "implementation",
			goal: "repair flow",
			runId: "run",
		});
		expect(tasks).toHaveLength(3);
		expect(tasks.map((task) => task.capability)).toEqual([
			"implementation_fast",
			"implementation_fast",
			"implementation_fast",
		]);
		expect(tasks.map((task) => task.task)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Do not edit, commit, push"),
				expect.stringContaining("affected files"),
				expect.stringContaining("existing tests"),
			]),
		);
	});

	test.each([
		[5, 3],
		[6, 3],
		[7, 4],
		[8, 4],
		[9, 5],
		[10, 5],
	])("derives %i recon workers from Rule 2", (complexity, expected) => {
		expect(
			planReconTasks({ method: methodWithRule2, complexity, taskClass: "implementation", goal: "x", runId: "run" }),
		).toHaveLength(expected);
	});

	test.each(["investigation", "qa_verification"])("skips Rule-2 recon for %s", (taskClass) => {
		expect(
			planReconTasks({ method: methodWithRule2, complexity: 8, taskClass, goal: "x", runId: "run" }),
		).toEqual([]);
	});

	test("skips recon below the minimum complexity", () => {
		expect(
			planReconTasks({ method: methodWithRule2, complexity: 4, taskClass: "implementation", goal: "x", runId: "run" }),
		).toEqual([]);
	});

	test("assigns stable, ordered task ids scoped to the run", () => {
		const tasks = planReconTasks({
			method: methodWithRule2,
			complexity: 5,
			taskClass: "implementation",
			goal: "x",
			runId: "run-42",
		});
		expect(tasks.map((task) => task.taskId)).toEqual(["run-42-recon-0", "run-42-recon-1", "run-42-recon-2"]);
	});
});

describe("formatReconEvidence", () => {
	test("includes completed worker evidence and failed worker diagnostics", () => {
		const evidence = formatReconEvidence(
			[
				{ taskId: "run-recon-0", exitCode: 0, stdout: "affected: src/a.ts", stderr: "" },
				{ taskId: "run-recon-1", exitCode: 1, stdout: "", stderr: "Error: unavailable" },
			],
			500,
		);
		expect(evidence).toContain("run-recon-0");
		expect(evidence).toContain("affected: src/a.ts");
		expect(evidence).toContain("run-recon-1 unavailable");
		expect(evidence).toContain("Error: unavailable");
	});

	test("bounds each recon evidence packet and aggregate output", () => {
		const evidence = formatReconEvidence(
			[{ taskId: "run-recon-0", exitCode: 0, stdout: "x".repeat(5_000), stderr: "" }],
			120,
		);
		expect(evidence.length).toBeLessThanOrEqual(120);
		expect(evidence).toContain("truncated");
	});

	test("returns empty string for no recon results", () => {
		expect(formatReconEvidence([], 500)).toBe("");
	});
});

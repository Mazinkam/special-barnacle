import { describe, expect, test } from "bun:test";
import { parseLeadAssignments, planLeadWaves } from "./lead-plan.ts";

const plan = (body: string) => `## Tasks\n1. x\n\n## Lead assignments\n${body}\n\n## Dependencies\nnone`;

describe("parseLeadAssignments", () => {
	test("parses scopes and dependencies", () => {
		const a = parseLeadAssignments(plan(
			"Lead 1: Phase 0 — land in-flight work (depends on: none)\n" +
			"Lead 2: Phase A tasks A1-A3 (depends on: 1)\n" +
			"Lead 3: Phase A tasks A4-A7 (depends on: 2)",
		), 3);
		expect(a).toEqual([
			{ index: 0, scope: "Phase 0 — land in-flight work", dependsOn: [] },
			{ index: 1, scope: "Phase A tasks A1-A3", dependsOn: [0] },
			{ index: 2, scope: "Phase A tasks A4-A7", dependsOn: [1] },
		]);
	});
	test("accepts list markers, bold and multiple deps", () => {
		const a = parseLeadAssignments(plan("- **Lead 1:** backend (depends on: none)\n- **Lead 2:** frontend\n- Lead 3: e2e (depends on: 1, 2)"), 3);
		expect(a?.map((x) => x.dependsOn)).toEqual([[], [], [0, 1]]);
		expect(a?.[1].scope).toBe("frontend");
	});
	test("missing section, wrong count, self/forward-cycle or unknown dep -> null", () => {
		expect(parseLeadAssignments("## Tasks\n1. x", 2)).toBeNull();
		expect(parseLeadAssignments(plan("Lead 1: a"), 2)).toBeNull();
		expect(parseLeadAssignments(plan("Lead 1: a (depends on: 2)\nLead 2: b (depends on: 1)"), 2)).toBeNull();
		expect(parseLeadAssignments(plan("Lead 1: a (depends on: 1)\nLead 2: b"), 2)).toBeNull();
		expect(parseLeadAssignments(plan("Lead 1: a\nLead 2: b (depends on: 7)"), 2)).toBeNull();
	});
});

describe("planLeadWaves", () => {
	test("independent leads run in one wave; chains run sequentially", () => {
		expect(planLeadWaves([{ index: 0, scope: "a", dependsOn: [] }, { index: 1, scope: "b", dependsOn: [] }])).toEqual([[0, 1]]);
		expect(planLeadWaves([
			{ index: 0, scope: "a", dependsOn: [] },
			{ index: 1, scope: "b", dependsOn: [0] },
			{ index: 2, scope: "c", dependsOn: [1] },
		])).toEqual([[0], [1], [2]]);
		expect(planLeadWaves([
			{ index: 0, scope: "a", dependsOn: [] },
			{ index: 1, scope: "b", dependsOn: [] },
			{ index: 2, scope: "c", dependsOn: [0, 1] },
		])).toEqual([[0, 1], [2]]);
	});
});

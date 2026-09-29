import { describe, expect, test } from "bun:test";
import { applyWorkflowOverride, routeWorkflow } from "./workflow-router.ts";
import type { WorkflowSignals } from "./workflow-signals.ts";
import { METHOD } from "../models.ts";

const policy = METHOD.rules.workflow_policy!;
const check = { name: "test", argv: ["bun", "run", "test"], cwd: ".", source: "package.json" };
const base: WorkflowSignals = { candidates: ["src/a.ts"], packages: ["."], riskPathHits: [], interfaceHits: [], testsNearby: true, checks: [check], ambiguous: false, triageRisk: "low", taskClass: "implementation" };
const route = (o: Partial<WorkflowSignals>) => routeWorkflow({ ...base, ...o }, policy);

describe("routeWorkflow", () => {
	test("one localized low-risk file with tests and checks ⇒ direct", () => expect(route({}).level).toBe("direct"));
	test("no discovered checks ⇒ never direct", () => expect(route({ checks: [] }).level).toBe("checked"));
	test("no adjacent tests ⇒ checked", () => expect(route({ testsNearby: false }).level).toBe("checked"));
	test("medium risk ⇒ checked", () => expect(route({ triageRisk: "medium" }).level).toBe("checked"));
	test("2–3 files ⇒ checked", () => expect(route({ candidates: ["a", "b", "c"] }).level).toBe("checked"));
	test("4+ files ⇒ led", () => expect(route({ candidates: ["a", "b", "c", "d"] }).level).toBe("led"));
	test("3+ packages ⇒ led", () => expect(route({ packages: [".", "p1", "p2"] }).level).toBe("led"));
	test("ambiguous ⇒ led", () => expect(route({ candidates: [], ambiguous: true }).level).toBe("led"));
	test("risk path ⇒ full with full floor", () => {
		const d = route({ riskPathHits: ["src/auth/a.ts ⇐ **/auth/**"] });
		expect([d.level, d.floor]).toEqual(["full", "full"]);
	});
	test("explicit high risk ⇒ full", () => expect(route({ triageRisk: "high" }).level).toBe("full"));
	test("interface change across packages ⇒ full", () => expect(route({ interfaceHits: ["x"], packages: [".", "pkg/b"] }).level).toBe("full"));
	test("local interface change ⇒ checked", () => expect(route({ interfaceHits: ["x"] }).level).toBe("checked"));
});

describe("applyWorkflowOverride", () => {
	test("override above floor accepted", () => {
		const d = applyWorkflowOverride(route({}), "led");
		expect(d.level).toBe("led");
		expect(d.override?.accepted).toBe(true);
	});
	test("override below floor rejected with reason", () => {
		const d = applyWorkflowOverride(route({ riskPathHits: ["x ⇐ **/auth/**"] }), "direct");
		expect(d.level).toBe("full");
		expect(d.override).toEqual({ requested: "direct", accepted: false, reason: "below hard floor full" });
	});
	test("no discovered checks: --workflow direct rejected (floor checked)", () => {
		const d = applyWorkflowOverride(route({ checks: [] }), "direct");
		expect(d.level).toBe("checked");
		expect(d.floor).toBe("checked");
		expect(d.override).toEqual({ requested: "direct", accepted: false, reason: "below hard floor checked" });
	});
	test("no checks and ambiguous: --workflow direct rejected", () => {
		const d = applyWorkflowOverride(route({ checks: [], candidates: [], ambiguous: true }), "direct");
		expect(d.level).toBe("led");
		expect(d.override?.accepted).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import { resolveWorkflowMode } from "./workflow-mode.ts";
import { METHOD } from "./models.ts";

const policy = METHOD.rules.workflow_policy!;

describe("resolveWorkflowMode", () => {
	test("method default is off", () => {
		expect(resolveWorkflowMode(policy, {})).toEqual({ mode: "off", source: "method", problems: [] });
	});
	test("env overrides", () => {
		expect(resolveWorkflowMode(policy, { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "observe" }).mode).toBe("observe");
	});
	test("invalid env keeps method value and reports", () => {
		const r = resolveWorkflowMode(policy, { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "yes" });
		expect(r.mode).toBe("off");
		expect(r.problems[0]).toContain("HUMAIN_ORCHESTRATOR_WORKFLOW_MODE");
	});
	test("absent policy is off", () => {
		expect(resolveWorkflowMode(undefined, { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "enforce" })).toEqual({ mode: "off", source: "absent", problems: ["workflow_policy missing from method.json; workflow levels disabled"] });
	});
});

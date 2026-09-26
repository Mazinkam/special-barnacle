import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { escalateLeadCapability, isLeadCapability, isLeadSize, sizeLead } from "./lead-sizing.ts";
import type { LeadSize } from "./models.ts";
import { parseArgs } from "./core/args.ts";
import { dispatchReconAndLeads } from "./pipeline/hierarchy.ts";
import { planEscalation } from "./escalation.ts";
import { policyIdFor } from "./adapters/adapter-resolver.ts";
import { leadSelfImplemented } from "./core/records.ts";
import type { DispatchResult } from "./core/records.ts";
import { LEAD_DELEGATION_RULE, LEAD_STATUS_CONTRACT, leadPrompt } from "./core/prompts.ts";
import type { DispatchTask, PlanResponse } from "./core/prompts.ts";

describe("sizeLead", () => {
	const cases: Array<[number, string, LeadSize]> = [
		[1, "low", "small"], [3, "low", "small"], [4, "low", "standard"], [6, "low", "standard"],
		[7, "low", "large"], [10, "low", "large"], [2, "medium", "standard"], [2, "high", "large"],
		[2, "critical", "large"], [5, "high", "large"], [2, "weird", "standard"],
	];
	for (const [c, r, size] of cases) {
		test(`complexity ${c} risk ${r} -> ${size}`, () => {
			expect(sizeLead({ complexity: c, risk: r, source: "triage" }).size).toBe(size);
		});
	}

	test("maps size to capability", () => {
		expect(sizeLead({ complexity: 2, risk: "low", source: "triage" }).capability).toBe("lead_small");
		expect(sizeLead({ complexity: 5, risk: "low", source: "triage" }).capability).toBe("lead");
		expect(sizeLead({ complexity: 9, risk: "low", source: "triage" }).capability).toBe("lead_large");
	});

	test("out-of-range and NaN complexity are clamped, never throw", () => {
		expect(sizeLead({ complexity: 99, risk: "low", source: "triage" }).size).toBe("large");
		expect(sizeLead({ complexity: -3, risk: "low", source: "triage" }).size).toBe("small");
		expect(sizeLead({ complexity: Number.NaN, risk: "low", source: "triage" }).size).toBe("standard");
		expect(sizeLead({ complexity: 3.4, risk: "low", source: "triage" }).size).toBe("small");
		expect(sizeLead({ complexity: 3.6, risk: "low", source: "triage" }).size).toBe("standard");
	});

	test("override wins over band and risk floor and keeps both for the record", () => {
		const d = sizeLead({ complexity: 9, risk: "critical", override: "small", source: "flag" });
		expect(d).toEqual({ size: "small", capability: "lead_small", bandSize: "large", riskFloorSize: "large", source: "flag" });
	});
});

describe("escalateLeadCapability", () => {
	test("walks up one size and stops at large", () => {
		expect(escalateLeadCapability("lead_small")).toBe("lead");
		expect(escalateLeadCapability("lead")).toBe("lead_large");
		expect(escalateLeadCapability("lead_large")).toBeNull();
		expect(escalateLeadCapability("technical_review")).toBeNull();
	});

	test("predicates", () => {
		expect(isLeadCapability("lead_small")).toBe(true);
		expect(isLeadCapability("lead")).toBe(true);
		expect(isLeadCapability("architect")).toBe(false);
		expect(isLeadSize("standard")).toBe(true);
		expect(isLeadSize("huge")).toBe(false);
	});
});

const leadSizingPlanFixture: PlanResponse = {
	plan_id: "plan-1",
	run_id: "run-1",
	task_class: "implementation",
	complexity: 6,
	risk: "medium",
	topology: { depth: 2, leads: 1, workers: 3, shape: "lead-workers" },
	route: {
		selected: { capability: "lead", effort: "standard", verification_depth: "targeted" },
		recommended: { capability: "lead", effort: "standard", verification_depth: "targeted" },
		mode: "adaptive",
		history_sufficient: true,
		explanation: {},
	},
	effective_quality_floor: 0.8,
	cost_aggressiveness: 0.5,
};
const leadSizingAdapterFixture: Parameters<typeof leadPrompt>[6] = {
	lead: { model: "amazon-bedrock/anthropic.claude-sonnet-5" },
};
const leadSizingRepoRootFixture = "/repo";

describe("lead sizing wiring (Phase A)", () => {
	const lowPlan = { ...leadSizingPlanFixture, complexity: 2, risk: "low", topology: { depth: 2, leads: 1, workers: 0, shape: "lead-workers" } };
	const fakeResult = (t: DispatchTask) => ({
		taskId: t.taskId, capability: t.capability, model: "m", exitCode: 0, stdout: "STATUS: completed", stderr: "",
		usage: {} as never, durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
	} as DispatchResult);

	test("--lead-size parses and rejects junk", () => {
		expect(parseArgs("do x --lead-size small").leadSize).toBe("small");
		expect(parseArgs("do x --lead-size small").goal).toBe("do x");
		const bad = parseArgs("do x --lead-size huge");
		expect(bad.leadSize).toBeUndefined();
		expect(bad.unknownFlags.join()).toContain("--lead-size huge");
		expect(parseArgs("do x --lead-size").unknownFlags.join()).toContain("missing value");
	});

	test("flags named inside the goal prose stay goal text and do not take effect", () => {
		// Regression: ht-orch-1790256789245-1a3fms. "Keep --interactive confirmations blocking" in the
		// goal switched interactive mode on (12 min idle at the plan dialog) and was cut out of the spec.
		const p = parseArgs("Fix X. Keep --interactive confirmations blocking and --risk handling intact. --risk high");
		expect(p.interactive).toBe(false);
		expect(p.risk).toBe("high");
		expect(p.goal).toBe("Fix X. Keep --interactive confirmations blocking and --risk handling intact.");
		expect(p.unknownFlags).toEqual([]);
		// Unknown --words inside prose are text, not errors.
		expect(parseArgs("explain what --frobnicate does").unknownFlags).toEqual([]);
	});

	test("leading and trailing flags still parse", () => {
		const p = parseArgs("--risk low --interactive do the thing --complexity 3 --lead-size small");
		expect(p).toMatchObject({ risk: "low", interactive: true, complexity: 3, leadSize: "small", goal: "do the thing" });
		expect(parseArgs("do x --bogus").unknownFlags).toEqual(["--bogus"]);
	});

	test("--max-retries 0 is honoured, not coerced to the default", () => {
		expect(parseArgs("do x --max-retries 0").maxRetries).toBe(0);
		expect(parseArgs("do x --max-retries 4").maxRetries).toBe(4);
		expect(parseArgs("do x --max-retries -1").maxRetries).toBe(2);
		expect(parseArgs("do x --max-retries nope").maxRetries).toBe(2);
		expect(parseArgs("do x").maxRetries).toBe(2);
	});

	test("dispatchReconAndLeads dispatches the sized lead capability", async () => {
		const dispatched: string[] = [];
		await dispatchReconAndLeads(
			{ runId: "r1", goal: "g", plan: lowPlan, adapter: { lead_small: { model: "p/sonnet-5" } }, leadCapability: "lead_small",
				evidenceMaxChars: 4000, maxLeads: 4, repoRoot: "/repo" },
			{
				dispatch: async (tasks) => { dispatched.push(...tasks.map((t) => t.capability)); return tasks.map(fakeResult); },
				capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
			},
		);
		expect(dispatched).toEqual(["lead_small"]);
	});

	test("failed verification escalates the lead one size per retry, capped at large", () => {
		const t = (capability: string) => [
			{ task: { capability, task: "t", taskId: "r-lead-0" }, result: { exitCode: 0, stdout: "report", filesChanged: [] } },
		];
		expect(planEscalation(["tests failed"], t("lead_small"), 2, "low", 0, 2)[0].capability).toBe("lead");
		expect(planEscalation(["tests failed"], t("lead_small"), 2, "low", 1, 2)[0].capability).toBe("lead_large");
		expect(planEscalation(["tests failed"], t("lead_large"), 9, "low", 0, 2)[0].capability).toBe("lead_large");
		expect(planEscalation(["tests failed"], t("technical_review"), 5, "low", 0, 2)[0].capability).toBe("technical_review");
		expect(planEscalation(["x"], t("lead"), 5, "high", 0, 2)[0].task).toContain("at least the premium tier");
	});

	test("policyIdFor is stable for identical bindings and changes with them", () => {
		const a = { lead: { model: "x/opus-5-5" }, scout: { model: "x/luna", effort: "low" } };
		expect(policyIdFor("premium", a)).toBe(policyIdFor("premium", { scout: a.scout, lead: a.lead }));
		expect(policyIdFor("premium", a)).toMatch(/^premium-[0-9a-f]{8}$/);
		expect(policyIdFor("premium", { ...a, lead: { model: "x/fable-5-1" } })).not.toBe(policyIdFor("premium", a));
	});

	test("leadSelfImplemented flags a lead that changed files without dispatching implementers", () => {
		expect(leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "I edited a.ts" })).toBe(true);
		expect(leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "dispatched orch-implementation-strong" })).toBe(false);
		expect(leadSelfImplemented({ filesChanged: [], stdout: "" })).toBe(false);
	});

	test("lead prompt states the delegation rule and the STATUS contract", () => {
		const p = leadPrompt("goal", leadSizingPlanFixture, undefined, "", 0, 1, leadSizingAdapterFixture, leadSizingRepoRootFixture);
		expect(p).toContain(LEAD_DELEGATION_RULE);
		expect(p).toContain(LEAD_STATUS_CONTRACT);
	});

	test("lead persona cannot write or edit", () => {
		const persona = readFileSync(new URL("../../agents/orchestrator-lead.md", import.meta.url), "utf8");
		const tools = /^tools:\s*(.+)$/m.exec(persona)?.[1].split(",").map((t) => t.trim()) ?? [];
		expect(tools).toContain("subagent");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("edit");
	});
});

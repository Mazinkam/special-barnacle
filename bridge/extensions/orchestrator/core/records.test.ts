import { describe, expect, test } from "bun:test";
import { dispatchRecordsFor, leadSelfImplemented, methodEffortFor, runTagFields, type DispatchResult } from "./records.ts";

function result(overrides: Partial<DispatchResult> = {}): DispatchResult {
	return {
		taskId: "run-1-lead-0",
		capability: "lead",
		model: "amazon-bedrock/global.anthropic.claude-opus-5-5",
		exitCode: 0,
		stdout: "",
		stderr: "",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		durationMs: 1000,
		costUsd: 0.5,
		costReported: true,
		filesChanged: [],
		...overrides,
	};
}

const opts = {
	runId: "run-1",
	planId: "plan-1",
	taskClass: "implementation",
	complexity: 5,
	risk: "medium",
	recommended: { capability: "lead", effort: "standard", verification_depth: "targeted" },
	mode: "adaptive",
};

describe("core/records.ts dispatchRecordsFor", () => {
	test("emits exactly a model_call and a route_executed row", () => {
		const records = dispatchRecordsFor(opts, result());
		expect(records).toHaveLength(2);
		expect(records[0].event).toBe("model_call");
		expect(records[1].event).toBe("route_executed");
	});

	test("stamps the run tags passed in explicitly, not any ambient global", () => {
		const records = dispatchRecordsFor(opts, result(), { profile: "default", policy_id: "default-abc123" });
		expect(records[0].profile).toBe("default");
		expect(records[0].policy_id).toBe("default-abc123");
	});

	test("omitting run tags stamps none — no implicit global read", () => {
		const records = dispatchRecordsFor(opts, result());
		expect(records[0].profile).toBeUndefined();
		expect(records[0].policy_id).toBeUndefined();
	});

	test("flags lead_self_implemented only for a lead capability that changed files itself", () => {
		const records = dispatchRecordsFor(opts, result({ filesChanged: ["a.ts"], stdout: "edited a.ts myself" }));
		expect(records[0].lead_self_implemented).toBe(true);
	});
});

describe("core/records.ts runTagFields", () => {
	test("only includes tags that are set", () => {
		expect(runTagFields({})).toEqual({});
		expect(runTagFields({ profile: "p" })).toEqual({ profile: "p" });
	});
});

describe("core/records.ts methodEffortFor", () => {
	test("defaults unset thinking level to standard", () => {
		expect(methodEffortFor(undefined)).toBe("standard");
	});
});

describe("core/records.ts leadSelfImplemented", () => {
	test("true only when files changed and no implementer dispatch is mentioned", () => {
		expect(leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "I edited a.ts" })).toBe(true);
		expect(leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "dispatched orch-implementation-strong" })).toBe(false);
		expect(leadSelfImplemented({ filesChanged: [], stdout: "" })).toBe(false);
	});
});

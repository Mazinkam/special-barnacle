import { describe, expect, test } from "bun:test";
import { clampComplexity, clampTriage, heuristicTriage, parseTriageResponse, VALID_RISKS, VALID_TASK_CLASSES } from "./triage.ts";

describe("core/triage.ts clampComplexity", () => {
	test("clamps out-of-band numbers onto the 1-10 scale", () => {
		expect(clampComplexity(12)).toBe(10);
		expect(clampComplexity(-3)).toBe(1);
		expect(clampComplexity(6.5)).toBe(7);
	});

	test("absent/empty/non-numeric values fall back", () => {
		expect(clampComplexity(undefined)).toBe(5);
		expect(clampComplexity(null)).toBe(5);
		expect(clampComplexity("")).toBe(5);
		expect(clampComplexity(true)).toBe(5);
		expect(clampComplexity("nope", 3)).toBe(3);
	});
});

describe("core/triage.ts clampTriage", () => {
	test("rejects an invalid task_class/risk by substituting defaults", () => {
		const clamped = clampTriage({ task_class: "not-a-class", complexity: 5, risk: "not-a-risk" });
		expect(clamped?.task_class).toBe("implementation");
		expect(clamped?.risk).toBe("medium");
	});

	test("keeps a valid verdict as-is (complexity clamped)", () => {
		const clamped = clampTriage({ task_class: "bug_fix", complexity: 20, risk: "high", reasoning: "x" });
		expect(clamped).toEqual({ task_class: "bug_fix", complexity: 10, risk: "high", reasoning: "x" });
	});

	test("null/non-object input is rejected", () => {
		expect(clampTriage(null as never)).toBeNull();
	});
});

describe("core/triage.ts parseTriageResponse", () => {
	test("extracts JSON wrapped in markdown fences", () => {
		const text = '```json\n{"task_class":"bug_fix","complexity":4,"risk":"low","reasoning":"ok"}\n```';
		expect(parseTriageResponse(text)).toEqual({ task_class: "bug_fix", complexity: 4, risk: "low", reasoning: "ok" });
	});

	test("returns null when no JSON object is present", () => {
		expect(parseTriageResponse("no json here")).toBeNull();
	});
});

describe("core/triage.ts heuristicTriage", () => {
	test("classifies a bug-fix goal", () => {
		const result = heuristicTriage("fix the broken login race");
		expect(result.task_class).toBe("bug_fix");
		expect(VALID_TASK_CLASSES).toContain(result.task_class);
		expect(VALID_RISKS).toContain(result.risk);
	});

	test("flags payment-related goals as high risk", () => {
		expect(heuristicTriage("update the billing invoice flow").risk).toBe("high");
	});
});

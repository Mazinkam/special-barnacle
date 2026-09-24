import { describe, expect, test } from "bun:test";
import { escalateLeadCapability, isLeadCapability, isLeadSize, sizeLead } from "./lead-sizing.ts";

describe("sizeLead", () => {
	const cases: Array<[number, string, string]> = [
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

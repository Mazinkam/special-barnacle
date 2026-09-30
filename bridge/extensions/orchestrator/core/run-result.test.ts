import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCompletedRunResult, buildTerminalRunResult, enforceRunResultBounds, outcomeFromCauses, RUN_RESULT_LIMITS, type RunResultV1 } from "./run-result.ts";
import { minimalReport } from "./report-fixtures.ts";

const base: RunResultV1 = {
	schema: "orchestration-result", version: 1, runId: "ht-orch-1",
	outcome: "complete", causes: [], codeVerification: "pass",
	liveQa: { verdict: "pass", sessionId: "run-20260930-095418-ba63", reasons: [] },
	externalChecks: [], openItems: [], diagnostics: [],
	cost: { usd: 0.5, complete: true }, runLog: "/state/runs/ht-orch-1/run.log",
};

describe("outcomeFromCauses", () => {
	test("precedence cancelled > failed > blocked > partial > complete", () => {
		expect(outcomeFromCauses([])).toBe("complete");
		expect(outcomeFromCauses(["lead_partial"])).toBe("partial");
		expect(outcomeFromCauses(["lead_partial", "external_check"])).toBe("blocked");
		expect(outcomeFromCauses(["external_check", "dispatch_failed"])).toBe("failed");
		expect(outcomeFromCauses(["crashed"])).toBe("failed");
		expect(outcomeFromCauses(["plan_failed"])).toBe("failed");
		expect(outcomeFromCauses(["aborted"])).toBe("failed");
		expect(outcomeFromCauses(["dispatch_failed", "cancelled_user"])).toBe("cancelled");
	});
});

describe("enforceRunResultBounds", () => {
	test("in-bounds result is returned unchanged", () => {
		expect(enforceRunResultBounds(base)).toEqual(base);
	});
	test("over-limit result is replaced by a minimal result that names the violation", () => {
		const big = { ...base, openItems: Array.from({ length: RUN_RESULT_LIMITS.openItems + 1 }, (_, i) => `item ${i}`) };
		const bounded = enforceRunResultBounds(big);
		expect(bounded.openItems).toEqual([]);
		expect(bounded.diagnostics).toEqual(["result exceeded bounds: openItems 51 > 50"]);
		expect(bounded.codeVerification).toBe("pass");
		expect(bounded.liveQa.verdict).toBe("unavailable");
		expect(bounded.acceptance).toEqual({ overall: "blocked", criteria: [] });
	});
	test("string over 2048 chars is a violation", () => {
		const bounded = enforceRunResultBounds({ ...base, diagnostics: ["x".repeat(2049)] });
		expect(bounded.diagnostics[0]).toContain("string longer than 2048");
	});
});

describe("enforceRunResultBounds object keys", () => {
	test("an over-long key in an acceptance expected/observed map is a violation", () => {
		const longKey = "k".repeat(2049);
		for (const field of ["expected", "observed"] as const) {
			const bounded = enforceRunResultBounds({
				...base,
				acceptance: { overall: "pass", criteria: [{ id: "c1", result: "pass", artifacts: [], [field]: { [longKey]: 1 } }] },
			});
			expect(bounded.diagnostics[0]).toContain("string longer than 2048");
			expect(bounded.acceptance).toEqual({ overall: "blocked", criteria: [] });
		}
	});
	test("a key of exactly 2048 chars is in bounds", () => {
		const ok = { ...base, acceptance: { overall: "pass" as const, criteria: [{ id: "c1", result: "pass" as const, artifacts: [], expected: { ["k".repeat(2048)]: 1 } }] } };
		expect(enforceRunResultBounds(ok)).toEqual(ok);
	});
});

describe("enforceRunResultBounds causes", () => {
	test("oversized duplicate causes yield a replacement that is itself in bounds", () => {
		const bad = { ...base, outcome: "failed" as const, causes: Array.from({ length: 8000 }, () => "crashed" as const) };
		expect(Buffer.byteLength(JSON.stringify(bad))).toBeGreaterThan(RUN_RESULT_LIMITS.payloadBytes);
		const bounded = enforceRunResultBounds(bad);
		expect(bounded.causes).toEqual(["crashed"]);
		expect(bounded.outcome).toBe("failed");
		expect(enforceRunResultBounds(bounded)).toEqual(bounded);
	});
	test("unknown causes are dropped from the replacement", () => {
		const bounded = enforceRunResultBounds({ ...base, causes: ["bogus" as never, "lead_partial"] });
		expect(bounded.causes).toEqual(["lead_partial"]);
		expect(bounded.outcome).toBe("partial");
		expect(enforceRunResultBounds(bounded)).toEqual(bounded);
	});
});

// Minimal structural validator: only the keywords the schema uses.
type Schema = Record<string, any>;
function validate(schema: Schema, value: unknown, root: Schema, path = "$"): string[] {
	if (schema.$ref) {
		const target = (schema.$ref as string).replace("#/", "").split("/").reduce((n: any, k) => n[k], root);
		return validate(target, value, root, path);
	}
	const errs: string[] = [];
	if ("const" in schema && value !== schema.const) errs.push(`${path}: const`);
	if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: enum`);
	if (schema.oneOf) {
		const n = schema.oneOf.filter((s: Schema) => validate(s, value, root, path).length === 0).length;
		if (n !== 1) errs.push(`${path}: oneOf matched ${n}`);
	}
	if (schema.type) {
		const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
		if (actual !== schema.type) return [...errs, `${path}: type ${actual} != ${schema.type}`];
	}
	if (typeof value === "string" && schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: maxLength`);
	if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: minimum`);
	if (Array.isArray(value)) {
		if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: maxItems`);
		if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errs.push(`${path}: uniqueItems`);
		if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${path}[${i}]`)));
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${path}: missing ${r}`);
		for (const [k, v] of Object.entries(obj)) {
			if (schema.propertyNames?.maxLength !== undefined && k.length > schema.propertyNames.maxLength) errs.push(`${path}: propertyNames maxLength ${k.slice(0, 10)}`);
			if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, root, `${path}.${k}`));
			else if (schema.additionalProperties === false) errs.push(`${path}: extra property ${k}`);
			else if (typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
		}
	}
	return errs;
}

describe("schema validation of fixtures", () => {
	const dir = join(import.meta.dir, "..", "contracts");
	const schema = JSON.parse(readFileSync(join(dir, "orchestration-result.v1.schema.json"), "utf8")) as Schema;
	const names = ["complete", "partial-external", "blocked-external", "cancelled", "crashed", "plan-failed"];
	for (const name of names) {
		test(`${name}.json validates against the schema`, () => {
			const fixture = JSON.parse(readFileSync(join(dir, "fixtures", `${name}.json`), "utf8"));
			expect(validate(schema, fixture, schema)).toEqual([]);
		});
	}
	test("a fixture with an extra property fails", () => {
		const fixture = JSON.parse(readFileSync(join(dir, "fixtures", "complete.json"), "utf8"));
		expect(validate(schema, { ...fixture, extra: 1 }, schema)).toContain("$: extra property extra");
	});
});

describe("schema propertyNames", () => {
	const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "contracts", "orchestration-result.v1.schema.json"), "utf8")) as Schema;
	test("scalarMap rejects a key longer than 2048 and accepts 2048", () => {
		const map = { $ref: "#/$defs/scalarMap" };
		expect(validate(map, { ["k".repeat(2049)]: 1 }, schema).length).toBe(1);
		expect(validate(map, { ["k".repeat(2048)]: 1 }, schema)).toEqual([]);
	});
});

describe("fixtures", () => {
	const dir = join(import.meta.dir, "..", "contracts", "fixtures");
	for (const name of ["complete", "partial-external", "blocked-external", "cancelled", "crashed", "plan-failed"]) {
		test(`${name}.json is in bounds and self-consistent`, () => {
			const fixture = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as RunResultV1;
			expect(enforceRunResultBounds(fixture)).toEqual(fixture);
			expect(fixture.outcome).toBe(outcomeFromCauses(fixture.causes));
		});
	}
});

describe("buildTerminalRunResult diagnostic truncation", () => {
	const input = { runId: "r", causes: ["crashed" as const], costUsd: 0, costComplete: true, runLog: "/l" };
	test("a 5000-char diagnostic is explicitly marked and within 2048 chars, unchanged by bounds", () => {
		const result = buildTerminalRunResult({ ...input, diagnostic: "d".repeat(5000) });
		const d = result.diagnostics[0]!;
		const marker = `…[truncated ${5000 - (2048 - `…[truncated ${5000} chars]`.length)} chars]`;
		expect(d.length).toBeLessThanOrEqual(2048);
		expect(d.endsWith(marker)).toBe(true);
		expect(d.startsWith("d".repeat(100))).toBe(true);
		expect(result.diagnostics[0]).not.toContain("result exceeded bounds");
		expect(enforceRunResultBounds(result)).toEqual(result);
	});
	test("a diagnostic of exactly 2048 chars is untouched", () => {
		expect(buildTerminalRunResult({ ...input, diagnostic: "d".repeat(2048) }).diagnostics[0]).toBe("d".repeat(2048));
	});
});

describe("run result builders", () => {
	test("#144 shape: partial lead + unparsed external check => blocked with both causes", () => {
		const result = buildCompletedRunResult(minimalReport({
			leadStatuses: ["partial"],
			externalChecks: [{ provider: "github", id: "unknown", outcome: "unverified", reason: "unparsed_checks" }],
		}));
		expect(result.causes).toEqual(["lead_partial", "external_check"]);
		expect(result.outcome).toBe("blocked");
		expect(result.externalChecks[0]?.reason).toBe("unparsed_checks");
	});

	test("openItems come from report.openItems when defined, not from reportLines", () => {
		const result = buildCompletedRunResult(minimalReport({ reportLines: ["- Files Changed bullet"], showFullReport: true, openItems: ["real item"] }));
		expect(result.openItems).toEqual(["real item"]);
	});
	test("openItems fall back to reportLines bullets when report.openItems is undefined", () => {
		const result = buildCompletedRunResult(minimalReport({ reportLines: ["- a", "prose", "* b"] }));
		expect(result.openItems).toEqual(["a", "b"]);
	});
	test("51 report.openItems reach the bounds check unchanged and are rejected explicitly", () => {
		const result = buildCompletedRunResult(minimalReport({ openItems: Array.from({ length: 51 }, (_, i) => `i${i}`) }));
		expect(result.diagnostics).toEqual(["result exceeded bounds: openItems 51 > 50"]);
	});

	test("code verification is the pre-live-QA verdict; live Qa reported separately", () => {
		const result = buildCompletedRunResult(minimalReport({
			passedVerification: true,
			liveQa: {
				stage: { verdict: "fail", required: true, reasons: ["confirmed finding"], costRows: [],
					outcomeRow: { session_id: "run-x", tested_revision: "8a3817feef" }, stage: null, cancelled: false },
				notRunReason: null,
				hasUnknownCost: true,
			},
		}));
		expect(result.codeVerification).toBe("pass");
		expect(result.liveQa).toEqual({ verdict: "fail", sessionId: "run-x", testedCommit: "8a3817feef", reasons: ["confirmed finding"] });
		expect(result.cost.complete).toBe(false);
	});

	test("codeVerification: all leads blocked (QA skipped) is not_run, never fail", () => {
		const result = buildCompletedRunResult(minimalReport({ blocked: true, passedVerification: false, leadStatuses: ["blocked"] }));
		expect(result.codeVerification).toBe("not_run");
	});
	test("codeVerification: QA dispatch timeout is not_run", () => {
		const result = buildCompletedRunResult(minimalReport({ verificationTimedOut: true, passedVerification: false }));
		expect(result.codeVerification).toBe("not_run");
	});
	test("codeVerification: QA provider stall is not_run", () => {
		const result = buildCompletedRunResult(minimalReport({ verificationProviderStall: true, passedVerification: false }));
		expect(result.codeVerification).toBe("not_run");
	});
	test("codeVerification: verificationSkipped stays skipped", () => {
		const result = buildCompletedRunResult(minimalReport({ verificationSkipped: true, passedVerification: false }));
		expect(result.codeVerification).toBe("skipped");
	});
	test("codeVerification: a real QA failure is fail", () => {
		const result = buildCompletedRunResult(minimalReport({ passedVerification: false, failedChecks: ["tests"] }));
		expect(result.codeVerification).toBe("fail");
	});

	test("terminal result for plan failure", () => {
		const result = buildTerminalRunResult({ runId: "r", causes: ["plan_failed"], diagnostic: "TypeError",
			costUsd: 0.0005, costComplete: true, runLog: "/l/run.log" });
		expect(result).toMatchObject({ outcome: "failed", codeVerification: "not_run", liveQa: { verdict: "not_requested" },
			diagnostics: ["TypeError"] });
	});
});

import { describe, expect, test } from "bun:test";
import { emptyOverrides, parseArgs, usageText } from "./args.ts";

describe("core/args.ts parseArgs", () => {
	test("parses a bare goal with defaults", () => {
		const parsed = parseArgs("repair the login race");
		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.taskClass).toBe("implementation");
		expect(parsed.complexity).toBe(5);
		expect(parsed.risk).toBe("medium");
		expect(parsed.interactive).toBe(false);
		expect(parsed.unknownFlags).toEqual([]);
	});

	test("honours leading flags and clamps --complexity onto 1-10", () => {
		const parsed = parseArgs("--complexity 12 --risk high fix the thing");
		expect(parsed.complexity).toBe(10);
		expect(parsed.risk).toBe("high");
		expect(parsed.goal).toBe("fix the thing");
	});

	test("a flag-looking word inside the goal prose is left as goal text", () => {
		const parsed = parseArgs("keep --interactive confirmations blocking");
		expect(parsed.interactive).toBe(false);
		expect(parsed.goal).toBe("keep --interactive confirmations blocking");
	});

	test("unrecognized leading flags are reported, not silently dropped", () => {
		const parsed = parseArgs("--bogus-flag do the thing");
		expect(parsed.unknownFlags).toEqual(["--bogus-flag"]);
		expect(parsed.goal).toBe("do the thing");
	});

	test("--lead-size rejects an invalid value", () => {
		const parsed = parseArgs("--lead-size huge do the thing");
		expect(parsed.leadSize).toBeUndefined();
		expect(parsed.unknownFlags[0]).toContain("--lead-size huge");
	});
});

describe("core/args.ts usageText", () => {
	test("names the given profiles path", () => {
		expect(usageText("/tmp/profiles.json")).toContain("/tmp/profiles.json");
		expect(usageText("/tmp/profiles.json")).toContain("Usage: /orchestrate");
	});
});

describe("core/args.ts emptyOverrides", () => {
	test("returns a fresh, empty overrides object each call", () => {
		const a = emptyOverrides();
		const b = emptyOverrides();
		expect(a).toEqual({ tiers: {}, capabilities: {} });
		a.tiers.cheap = "x";
		expect(b.tiers.cheap).toBeUndefined();
	});
});

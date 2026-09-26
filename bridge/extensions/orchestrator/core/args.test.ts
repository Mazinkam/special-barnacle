import { describe, expect, test } from "bun:test";
import { planReconTasks } from "../recon.ts";
import { METHOD } from "../models.ts";
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

	test("--context is repeatable and collects every file in order", () => {
		const parsed = parseArgs("--context a.md --context b.md fix the thing");
		expect(parsed.contextFiles).toEqual(["a.md", "b.md"]);
		expect(parsed.goal).toBe("fix the thing");
	});

	test("--context combines with other flags without interfering", () => {
		const parsed = parseArgs("--context notes.md --complexity 7 --risk high do the thing");
		expect(parsed.contextFiles).toEqual(["notes.md"]);
		expect(parsed.complexity).toBe(7);
		expect(parsed.risk).toBe("high");
		expect(parsed.goal).toBe("do the thing");
	});

	test("--context with no value is reported as an unknown flag, not silently dropped", () => {
		const parsed = parseArgs("--context");
		expect(parsed.unknownFlags).toContain("--context (missing value)");
		expect(parsed.contextFiles).toEqual([]);
	});

	test("--with-last-reply and --force are boolean flags, off by default", () => {
		const bare = parseArgs("do the thing");
		expect(bare.withLastReply).toBe(false);
		expect(bare.force).toBe(false);
		const flagged = parseArgs("--with-last-reply --force do the thing");
		expect(flagged.withLastReply).toBe(true);
		expect(flagged.force).toBe(true);
		expect(flagged.goal).toBe("do the thing");
	});
});

describe("core/args.ts usageText", () => {
	test("names the given profiles path", () => {
		expect(usageText("/tmp/profiles.json")).toContain("/tmp/profiles.json");
		expect(usageText("/tmp/profiles.json")).toContain("Usage: /orchestrate");
	});

	test("documents --context, --with-last-reply and --force", () => {
		const usage = usageText("/tmp/profiles.json");
		expect(usage).toContain("--context");
		expect(usage).toContain("--with-last-reply");
		expect(usage).toContain("--force");
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

describe("/orchestrate argument parsing (parseArgs)", () => {
	test("runs without confirmation unless interactive mode is explicitly requested", () => {
		const parsed = parseArgs("repair the login race");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(false);
	});

	test("enables confirmation gates when --interactive is supplied", () => {
		const parsed = parseArgs("repair the login race --interactive");

		expect(parsed.goal).toBe("repair the login race");
		expect(parsed.interactive).toBe(true);
		expect(parsed.unknownFlags).toEqual([]);
	});

	test("normalises --complexity onto the integer 1-10 scale Rule-2 bands use", () => {
		expect(parseArgs("repair flow --complexity 6.5").complexity).toBe(7);
		expect(parseArgs("repair flow --complexity 12").complexity).toBe(10);
		expect(parseArgs("repair flow --complexity 0").complexity).toBe(1);
		expect(parseArgs("repair flow --complexity abc").complexity).toBe(5);
		// Previously 6.5 matched no workers_by_complexity band and planned zero recon.
		const tasks = planReconTasks({ method: METHOD.rules.pre_implementation_recon, complexity: parseArgs("repair flow --complexity 6.5").complexity,
			taskClass: "implementation", goal: "repair flow", runId: "run" });
		expect(tasks.length).toBe(4);
	});
});

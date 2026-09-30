import { describe, expect, test } from "bun:test";
import { collectWorkflowSignals } from "./workflow-signals.ts";
import { METHOD } from "../models.ts";

const policy = METHOD.rules.workflow_policy!;
const files = ["package.json", "bun.lock", "src/util/format.ts", "src/util/format.test.ts", "src/auth/login.ts", "src/api/index.ts", "pkg/b/package.json", "pkg/b/x.ts", "README.md"];
const reader = { exists: (p: string) => files.includes(p) || files.some((f) => f.startsWith(`${p}/`)), read: (p: string) => (p === "package.json" ? '{"scripts":{"test":"bun test"}}' : files.includes(p) ? "" : null) };
const collect = (goal: string, triageRisk = "low") => collectWorkflowSignals({ goal, files, reader, triageRisk, taskClass: "implementation", policy });

describe("collectWorkflowSignals", () => {
	test("single localized file with adjacent test", () => {
		const s = collect("Fix rounding in src/util/format.ts");
		expect(s.candidates).toEqual(["src/util/format.ts"]);
		expect(s.testsNearby).toBe(true);
		expect(s.riskPathHits).toEqual([]);
		expect(s.checks.map((c) => c.name)).toEqual(["test"]);
		expect(s.ambiguous).toBe(false);
	});
	test("unique basename resolves", () => {
		expect(collect("tweak format.ts output").candidates).toEqual(["src/util/format.ts"]);
	});
	test("risk path detected regardless of stated risk", () => {
		expect(collect("rename a variable in src/auth/login.ts").riskPathHits[0]).toContain("src/auth/login.ts");
	});
	test("interface file and packages", () => {
		const s = collect("change src/api/index.ts and pkg/b/x.ts");
		expect(s.interfaceHits.length).toBe(1);
		expect(s.packages.sort()).toEqual([".", "pkg/b"]);
	});
	test("vague goal is ambiguous", () => {
		expect(collect("make it faster").ambiguous).toBe(true);
	});
});

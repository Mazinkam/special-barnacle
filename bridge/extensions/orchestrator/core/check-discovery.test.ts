import { describe, expect, test } from "bun:test";
import { discoverChecks, type RepoReader } from "./check-discovery.ts";

function reader(files: Record<string, string>): RepoReader {
	return { exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)), read: (p) => files[p] ?? null };
}

describe("discoverChecks", () => {
	test("bun package scripts in typecheck, lint, test order", () => {
		const checks = discoverChecks(reader({ "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "x", build: "y", typecheck: "tsc" } }), "bun.lock": "" }));
		expect(checks.map((c) => c.argv)).toEqual([["bun", "run", "typecheck"], ["bun", "run", "lint"], ["bun", "run", "test"]]);
	});
	test("python repo with tests dir", () => {
		expect(discoverChecks(reader({ "pyproject.toml": "[project]", "tests/test_a.py": "" })).map((c) => c.argv)).toEqual([["python3", "-m", "pytest", "-q"]]);
	});
	test("nothing discoverable yields empty list", () => {
		expect(discoverChecks(reader({ "README.md": "" }))).toEqual([]);
	});
	test("malformed package.json is ignored, not thrown", () => {
		expect(discoverChecks(reader({ "package.json": "{" }))).toEqual([]);
	});
	test("sub-package cwd is preserved", () => {
		const c = discoverChecks(reader({ "pkg/a/package.json": JSON.stringify({ scripts: { test: "t" } }) }), ["pkg/a"]);
		expect(c).toEqual([{ name: "pkg/a:test", argv: ["npm", "run", "test"], cwd: "pkg/a", source: "pkg/a/package.json" }]);
	});
});

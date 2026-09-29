import { describe, expect, test } from "bun:test";
import { METHOD } from "../models.ts";
import { globToRegExp, matchesAny } from "./path-glob.ts";

describe("path-glob", () => {
	test.each([
		["**/auth/**", "src/auth/login.ts", true],
		["**/auth/**", "auth/x.ts", true],
		["**/auth/**", "src/author.ts", false],
		["**/*secret*", "config/app-secrets.json", true],
		[".github/workflows/**", ".github/workflows/ci.yml", true],
		["**/package.json", "package.json", true],
		["**/*.d.ts", "types/x.d.ts", true],
		["**/openapi*.{json,yaml}", "api/openapi.v1.yaml", true],
		["*.md", "docs/a.md", false],
	])("%s vs %s", (glob, path, expected) => {
		expect(globToRegExp(glob).test(path)).toBe(expected);
	});
	test("matchesAny returns the matching globs", () => {
		expect(matchesAny("src/auth/a.ts", ["**/auth/**", "**/*.py"])).toEqual(["**/auth/**"]);
	});
	test("translates wildcards inside brace alternatives", () => {
		const alternatives = globToRegExp("{*,auth}.ts");
		expect(alternatives.test("x.ts")).toBe(true);
		expect(alternatives.test("auth.ts")).toBe(true);
		expect(alternatives.test("a/x.ts")).toBe(false);
		expect(globToRegExp("{auth?,other}.ts").test("authX.ts")).toBe(true);
	});
	test("treats an unmatched opening brace literally", () => {
		expect(globToRegExp("a{b").test("a{b")).toBe(true);
	});
	test("escapes regex metacharacters literally", () => {
		expect(globToRegExp("a+b(c).ts").test("a+b(c).ts")).toBe(true);
	});

	test("wildcards match newline paths (safety floor)", () => {
		const cases: Array<[string, string]> = [
			["**/auth/**", "src\n/auth/login.ts"],
			["**/auth/**", "src/auth/lo\ngin.ts"],
			[".github/workflows/**", ".github/workflows/ci\n.yml"],
			["**/*.d.ts", "a\nb/x.d.ts"],
		];
		for (const [g, p] of cases) {
			expect(globToRegExp(g).test(p)).toBe(true);
			expect(matchesAny(p, [g])).toEqual([g]);
		}
		expect(globToRegExp("*.md").test("a\n/b.md")).toBe(false);
		expect(matchesAny("a\n/b.md", ["*.md"])).toEqual([]);
		expect(matchesAny("a\nb.md", ["*.md"])).toEqual(["*.md"]);
		expect(matchesAny("a\nb", ["a?b"])).toEqual(["a?b"]);
		expect(matchesAny("a/b", ["a?b"])).toEqual([]);
	});

	test("matchesAny is bounded-time on pathological globs", () => {
		let t = performance.now();
		expect(matchesAny("a".repeat(40), ["*a".repeat(20) + "b"])).toEqual([]);
		expect(performance.now() - t).toBeLessThan(500);
		t = performance.now();
		expect(matchesAny("a".repeat(4000), ["**a**a**a**a**b"])).toEqual([]);
		expect(matchesAny("a".repeat(4000) + "b", ["**a**a**a**a**b"])).toEqual(["**a**a**a**a**b"]);
		expect(performance.now() - t).toBeLessThan(500);
	});

	test("throws when brace expansion exceeds the cap", () => {
		const glob = "{a,b}".repeat(20);
		expect(() => matchesAny("x", [glob])).toThrow();
	});

	test("matchesAny agrees with globToRegExp", () => {
		const wp = METHOD.rules.workflow_policy!;
		const globs = [
			"**/auth/**", "**/*secret*", ".github/workflows/**", "**/package.json", "**/*.d.ts",
			"**/openapi*.{json,yaml}", "*.md", "{*,auth}.ts", "{auth?,other}.ts", "a{b", "a+b(c).ts",
			"a/**/b", "**", "**/", "*", "?", "a**b", "{a,b/**}/c", "{**/x,y}",
			...wp.risk_path_globs, ...wp.interface_globs,
		];
		const paths = [
			"src/auth/login.ts", "src/author.ts", "package.json", "a/b/package.json",
			".github/workflows/ci.yml", "db/migrations/001.sql", "config/app-secrets.json",
			"types/x.d.ts", "api/openapi.v1.yaml", "README.md", "docs/a.md", "a.md", "auth.ts", "authX.ts",
			"a{b", "a+b(c).ts", "a/b", "a/x/y/b", "ab", "a/", "", "/", "src\n/auth/login.ts",
			".github/workflows/ci\n.yml", "x/c", "b/c", "y", "q/x",
		];
		for (const g of globs) {
			for (const p of paths) {
				expect([g, p, matchesAny(p, [g]).length === 1]).toEqual([g, p, globToRegExp(g).test(p)]);
			}
		}
	});
});

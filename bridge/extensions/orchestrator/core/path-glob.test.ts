import { describe, expect, test } from "bun:test";
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
});

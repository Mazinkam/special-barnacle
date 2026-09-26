import { describe, expect, test } from "bun:test";

import { parseFailedChecks } from "./verify-loop.ts";

describe("parseFailedChecks", () => {
	test("does not flag a passing row with a zero count", () => {
		expect(parseFailedChecks("| lint | 0 errors |")).toEqual([]);
	});

	test("does not flag a passing row with multiple zero counts", () => {
		expect(parseFailedChecks("| lint | 0 errors, 0 warnings |")).toEqual([]);
	});

	test("flags a row with a non-zero error count", () => {
		expect(parseFailedChecks("| lint | 2 errors |")).toEqual(["lint"]);
	});

	test("flags a row with a FAIL status cell", () => {
		expect(parseFailedChecks("| tests | FAIL |")).toEqual(["tests"]);
	});

	test("does not flag a row with a PASS status cell", () => {
		expect(parseFailedChecks("| tests | PASS |")).toEqual([]);
	});

	test("flags a row with a FAILED status cell", () => {
		expect(parseFailedChecks("| tests | FAILED |")).toEqual(["tests"]);
	});

	test("flags a row with an ERROR status cell", () => {
		expect(parseFailedChecks("| build | ERROR |")).toEqual(["build"]);
	});

	test("flags a row with a ✗ status cell", () => {
		expect(parseFailedChecks("| build | ✗ |")).toEqual(["build"]);
	});

	test("flags a row with a ✗ status cell (word-boundary insensitive to case)", () => {
		expect(parseFailedChecks("| build | fail |")).toEqual(["build"]);
	});

	test("flags a bullet point labelled FAIL", () => {
		expect(parseFailedChecks("- foo: FAIL")).toEqual(["foo"]);
	});

	test("flags a bullet point labelled failed", () => {
		expect(parseFailedChecks("- foo: failed")).toEqual(["foo"]);
	});

	test("flags a bullet point labelled with ✗", () => {
		expect(parseFailedChecks("- foo: ✗")).toEqual(["foo"]);
	});

	test("flags 1 failed count", () => {
		expect(parseFailedChecks("| tests | 1 failed |")).toEqual(["tests"]);
	});

	test("does not flag 0 failed count", () => {
		expect(parseFailedChecks("| tests | 0 failed |")).toEqual([]);
	});

	test("flags a FAIL status cell in the third column of a 3+-column row", () => {
		expect(parseFailedChecks("| unit | pytest | FAIL |")).toEqual(["unit"]);
	});

	test("does not flag a zero-error status cell in the third column of a 3+-column row", () => {
		expect(parseFailedChecks("| lint | ruff | 0 errors |")).toEqual([]);
	});

	test("does not flag a header row", () => {
		expect(parseFailedChecks("| Check | Command | Result |")).toEqual([]);
	});

	test("does not flag a header row followed by a separator row and skips the separator too", () => {
		const table = ["| Check | Command | Result |", "| --- | --- | --- |", "| unit | pytest | FAIL |"].join("\n");
		expect(parseFailedChecks(table)).toEqual(["unit"]);
	});
});

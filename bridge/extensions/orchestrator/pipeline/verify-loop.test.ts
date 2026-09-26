import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@humain/terminal";

import { parseFailedChecks, runVerification, type VerifyDeps } from "./verify-loop.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import type { RunContext } from "../run/context.ts";
import type { RunSession } from "../run/session.ts";

function fakeCaptureOpts(): CaptureOpts {
	return {
		runId: "run-1",
		planId: "plan-1",
		taskClass: "crud",
		complexity: 4,
		risk: "low",
		recommended: { capability: "implementation_fast", effort: "low", verification_depth: "targeted" },
		mode: "adaptive",
	} as unknown as CaptureOpts;
}

function fakeQaResult(stdout: string, exitCode = 0): DispatchResult {
	return {
		taskId: "run-1-qa",
		capability: "qa_agent",
		model: "provider/model",
		exitCode,
		stdout,
		stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		durationMs: 10,
		costUsd: 0.01,
		costReported: true,
		filesChanged: [],
	} as unknown as DispatchResult;
}

function fakeVerifyDeps(qaStdout: string, exitCode = 0): VerifyDeps {
	return {
		dispatch: async () => [fakeQaResult(qaStdout, exitCode)],
		captureDispatchCost: async () => {},
		recordOutcome: () => {},
	};
}

const fakeCtx = {} as ExtensionContext;
const fakeRun: RunContext<RunSession> | null = null;

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

	test("does not flag a FAIL-looking word inside a Notes column when the header names a Status column", () => {
		const table = ["| Check | Status | Notes |", "| --- | --- | --- |", "| tests | PASS | Notes: no FAIL found |"].join("\n");
		expect(parseFailedChecks(table)).toEqual([]);
	});

	test("does not flag a passing summary cell with a zero failed count and no header", () => {
		expect(parseFailedChecks("| tests | 12 passed, 0 failed |")).toEqual([]);
	});

	test("flags a FAIL in a Result column when the header names it", () => {
		const table = ["| Check | Command | Result |", "| --- | --- | --- |", "| unit | pytest | FAIL |"].join("\n");
		expect(parseFailedChecks(table)).toEqual(["unit"]);
	});

	test("flags a FAIL in a headerless table (fail-safe: checks every non-label cell)", () => {
		expect(parseFailedChecks("| unit | pytest | FAIL |")).toEqual(["unit"]);
	});

	test("does not flag a FAIL-looking word in a Description column when the header names no status/count column", () => {
		const table = ["| Check | Description |", "| --- | --- |", "| tests | if this fails, investigate FAIL cases |"].join("\n");
		expect(parseFailedChecks(table)).toEqual([]);
	});

	test("falls back to checking every non-label, non-notes cell when the header names no recognized column", () => {
		const table = ["| Check | Summary |", "| --- | --- |", "| unit | FAIL |"].join("\n");
		expect(parseFailedChecks(table)).toEqual(["unit"]);
	});
});

describe("runVerification", () => {
	test("an explicit '## Verdict' FAIL heading fails verification even though the QA dispatch exited 0", async () => {
		const qaOut = ["## Checks", "- `typecheck`: PASS", "", "## Verdict", "FAIL."].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0));
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("a 'Verdict: FAIL' line fails verification even though the QA dispatch exited 0", async () => {
		const qaOut = "Verdict: FAIL";
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0));
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("a 'STATUS: fail' line fails verification even though the QA dispatch exited 0", async () => {
		const qaOut = "STATUS: fail";
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0));
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("an explicit '## Verdict' PASS heading does not flag, and does not falsely fail", async () => {
		const qaOut = ["## Checks", "- `typecheck`: PASS", "", "## Verdict", "PASS."].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0));
		expect(result.passed).toBe(true);
		expect(result.failedChecks).not.toContain("verdict");
	});
});

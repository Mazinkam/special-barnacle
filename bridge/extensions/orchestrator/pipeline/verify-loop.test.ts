import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@humain/terminal";

import type { DispatchTask } from "../core/prompts.ts";
import { parseFailedChecks, runVerification, type VerifyDeps, hasExplicitFailVerdict, qaVerificationOutcomeFor } from "./verify-loop.ts";
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

/** Captures the exact `task` string handed to `dispatch`, for asserting the QA prompt's content
 *  (docs/architecture-review.md C4: the repo root + verification commands). */
function capturingVerifyDeps(qaStdout: string, exitCode = 0): VerifyDeps & { lastTasks: DispatchTask[] } {
	const lastTasks: DispatchTask[] = [];
	return {
		lastTasks,
		dispatch: async (tasks) => {
			lastTasks.push(...tasks);
			return [fakeQaResult(qaStdout, exitCode)];
		},
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

describe("hasExplicitFailVerdict fenced code block / blockquote handling", () => {
	test("ignores a FAIL verdict inside a fenced code block (``` fence)", () => {
		const text = ["## Verdict", "PASS.", "", "Example of a failing report for reference:", "```", "Verdict: FAIL", "```"].join("\n");
		expect(hasExplicitFailVerdict(text)).toBe(false);
	});

	test("ignores a FAIL verdict inside a fenced code block (~~~ fence)", () => {
		const text = ["## Verdict", "PASS.", "", "~~~", "Verdict: FAIL", "~~~"].join("\n");
		expect(hasExplicitFailVerdict(text)).toBe(false);
	});

	test("ignores a 'Verdict: FAIL' line quoted in a blockquote", () => {
		const text = ["## Verdict", "PASS.", "", "> Verdict: FAIL"].join("\n");
		expect(hasExplicitFailVerdict(text)).toBe(false);
	});

	test("still detects a real '## Verdict' FAIL heading outside fences/blockquotes", () => {
		const text = ["## Verdict", "FAIL."].join("\n");
		expect(hasExplicitFailVerdict(text)).toBe(true);
	});

	test("an unterminated ``` fence does not swallow a real verdict that follows it", () => {
		const text = ["```", "some unterminated code", "## Verdict", "FAIL"].join("\n");
		expect(hasExplicitFailVerdict(text)).toBe(true);
	});

	test("a ~~~ fence does not close a ``` fence (mismatched markers); a real verdict after it is detected", () => {
		const text = ["```", "Verdict: FAIL (example)", "~~~", "## Verdict", "FAIL"].join("\n");
		expect(hasExplicitFailVerdict(text)).toBe(true);
	});

	test("a properly closed ``` fence containing FAIL is stripped; a later PASS verdict is detected as passing", () => {
		const text = ["```", "Verdict: FAIL (example)", "```", "## Verdict", "PASS"].join("\n");
		expect(hasExplicitFailVerdict(text)).toBe(false);
	});
});

describe("parseFailedChecks fenced code block / blockquote handling", () => {
	test("ignores a FAIL status cell inside a fenced code block", () => {
		const text = ["```", "| tests | FAIL |", "```"].join("\n");
		expect(parseFailedChecks(text)).toEqual([]);
	});

	test("ignores a FAIL bullet quoted in a blockquote", () => {
		expect(parseFailedChecks("> - foo: FAIL")).toEqual([]);
	});
});

describe("runVerification", () => {
	test("grounds the QA prompt in the absolute repo root and its verification commands (docs/architecture-review.md C4)", async () => {
		const deps = capturingVerifyDeps("## Verdict\nPASS", 0);
		await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), deps, "/abs/repo/root");
		expect(deps.lastTasks).toHaveLength(1);
		expect(deps.lastTasks[0]!.task).toContain("The repo root is /abs/repo/root (your cwd). Never search outside it; never run `find /`.");
		expect(deps.lastTasks[0]!.task).toContain("Verification commands:");
	});

	test("an explicit '## Verdict' FAIL heading fails verification even though the QA dispatch exited 0", async () => {
		const qaOut = ["## Checks", "- `typecheck`: PASS", "", "## Verdict", "FAIL."].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("a 'Verdict: FAIL' line fails verification even though the QA dispatch exited 0", async () => {
		const qaOut = "Verdict: FAIL";
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("a 'STATUS: fail' line fails verification even though the QA dispatch exited 0", async () => {
		const qaOut = "STATUS: fail";
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("an explicit '## Verdict' PASS heading does not flag, and does not falsely fail", async () => {
		const qaOut = ["## Checks", "- `typecheck`: PASS", "", "## Verdict", "PASS."].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(true);
		expect(result.failedChecks).not.toContain("verdict");
	});

	test("a real PASS verdict is not overridden by a FAIL verdict quoted inside a fenced code block in the same output", async () => {
		const qaOut = [
			"## Checks",
			"- `typecheck`: PASS",
			"",
			"## Verdict",
			"PASS.",
			"",
			"Example of a failing report for reference:",
			"```",
			"Verdict: FAIL",
			"```",
		].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(true);
		expect(result.failedChecks).not.toContain("verdict");
	});

	test("a real PASS verdict is not overridden by a FAIL verdict quoted inside a blockquote in the same output", async () => {
		const qaOut = ["## Checks", "- `typecheck`: PASS", "", "## Verdict", "PASS.", "", "> Verdict: FAIL"].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(true);
		expect(result.failedChecks).not.toContain("verdict");
	});

	test("an unterminated ``` fence does not hide a real FAIL verdict that follows it", async () => {
		const qaOut = ["```", "some unterminated code", "## Verdict", "FAIL"].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("a ``` fence mismatched-closed by ~~~ does not hide a real FAIL verdict that follows it", async () => {
		const qaOut = ["```", "Verdict: FAIL (example)", "~~~", "## Verdict", "FAIL"].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(false);
		expect(result.failedChecks).toContain("verdict");
	});

	test("a properly closed fence containing FAIL followed by a real PASS verdict passes", async () => {
		const qaOut = ["```", "Verdict: FAIL (example)", "```", "## Verdict", "PASS"].join("\n");
		const result = await runVerification("run-1", "plan-1", ["src/a.ts"], fakeCtx, fakeRun, fakeCaptureOpts(), fakeVerifyDeps(qaOut, 0), "/repo");
		expect(result.passed).toBe(true);
		expect(result.failedChecks).not.toContain("verdict");
	});
});

describe("verification outcome records (qaVerificationOutcomeFor)", () => {
	test("QA gate outcomes are marked run-scoped, not task attestations", () => {
		expect(qaVerificationOutcomeFor("run-1", true, 0.95, "ok")).toMatchObject({
			run_id: "run-1",
			task_id: "run-1-qa",
			outcome: "verified",
			verification_scope: "run",
		});
	});
});

import { describe, expect, test } from "bun:test";
import { buildRunSummary, verificationVerdictFor, type RunReport } from "./report.ts";
import type { FlushReport } from "../record-queue.ts";

const base = { blocked: false, dispatchOk: true, verificationSkipped: false, filesChangedCount: 3, passedVerification: true };

describe("core/report.ts verificationVerdictFor", () => {
	test("blocked wins over every other state", () => {
		expect(verificationVerdictFor({ ...base, blocked: true, dispatchOk: false })).toContain("NOT RUN (blocked");
	});

	test("no lead succeeded, not blocked", () => {
		expect(verificationVerdictFor({ ...base, dispatchOk: false })).toBe("NOT RUN (no lead succeeded)");
	});

	test("skipped with no files changed reads as N/A, not SKIPPED", () => {
		expect(verificationVerdictFor({ ...base, verificationSkipped: true, filesChangedCount: 0 })).toContain("N/A");
	});

	test("skipped with files changed reads as SKIPPED", () => {
		expect(verificationVerdictFor({ ...base, verificationSkipped: true, filesChangedCount: 2 })).toBe("SKIPPED (no files changed)");
	});

	test("verification ran: PASS/FAIL follow the actual verdict, not dispatch success", () => {
		expect(verificationVerdictFor({ ...base, passedVerification: true })).toBe("PASS");
		expect(verificationVerdictFor({ ...base, passedVerification: false })).toBe("FAIL (unparsed)");
	});

	test("verification failed with named checks: the summary names them instead of reading as unparsed", () => {
		expect(verificationVerdictFor({ ...base, passedVerification: false, failedChecks: ["typecheck", "lint"] })).toBe("FAIL (typecheck, lint)");
	});

	test("verification failed with no recognized check: reads as unparsed, not a bare FAIL", () => {
		expect(verificationVerdictFor({ ...base, passedVerification: false, failedChecks: [] })).toBe("FAIL (unparsed)");
	});

	test("the QA dispatch timing out reads as TIMED OUT, distinct from a completed FAIL", () => {
		expect(verificationVerdictFor({ ...base, passedVerification: false, verificationTimedOut: true })).toBe("TIMED OUT (QA dispatch did not complete)");
	});

	test("a timeout still wins over named failed checks (QA never finished judging them)", () => {
		expect(verificationVerdictFor({ ...base, passedVerification: false, verificationTimedOut: true, failedChecks: ["typecheck"] })).toBe("TIMED OUT (QA dispatch did not complete)");
	});

	test("regression: QA dispatched and failed unparsed must never read as 'NOT RUN (no lead succeeded)' (docs/architecture-review.md C5)", () => {
		// The exact contradiction this fix removes: the old summary said
		// `verification: NOT RUN (no lead succeeded)` while QA had actually been
		// dispatched and the log had `verification failed: (unparsed)`. With
		// `dispatchOk: true` (a lead succeeded, QA ran), the verdict must reflect
		// the real QA failure, not the no-lead-succeeded state.
		const verdict = verificationVerdictFor({ ...base, dispatchOk: true, passedVerification: false, failedChecks: [] });
		expect(verdict).not.toContain("NOT RUN");
		expect(verdict).toBe("FAIL (unparsed)");
	});
});

const healthyTelemetry: FlushReport = { ok: true, batches: 1, acknowledged: 3, failed: 0, derivedStale: 0 };

/** Everything a terminal, non-cancelled, non-crashed run has to report, before
 *  each test tweaks the one or two fields it's about. Field values are chosen
 *  so `fmtElapsed`/`toFixed(4)` formatting is unambiguous by inspection. */
function baseReport(): RunReport {
	return {
		runId: "ht-orch-1700000000000-abcdef",
		elapsedMs: 65_000, // fmtElapsed: 65s -> "1m05s"
		blocked: false,
		dispatchOk: true,
		succeededLeads: 2,
		totalLeads: 2,
		skippedLeads: 0,
		retries: 0,
		filesChangedCount: 3,
		externalFilesCount: 0,
		reconWorkersLine: "recon: 0 workers dispatched",
		verificationSkipped: false,
		passedVerification: true,
		verificationTimedOut: false,
		failedChecks: [],
		totalCostUsd: 1.2345,
		dispatchCount: 3,
		nestedCostUsd: 0,
		firstFailureLine: "",
		reportLines: [],
		showFullReport: false,
		reportTruncated: false,
		hasLeadReports: false,
		leadReportPath: "",
		runLogPath: "/tmp/run.log",
		stateRoot: "/tmp/state",
		telemetryReport: healthyTelemetry,
	};
}

describe("core/report.ts buildRunSummary", () => {
	test("complete: passed verification, reported as succeeded", () => {
		const { text, succeeded } = buildRunSummary(baseReport());
		expect(text).toBe(
			[
				"Orchestration complete in 1m05s.",
				"run_id: ht-orch-1700000000000-abcdef",
				"leads: 2/2 succeeded · retries: 0 · files: 3 changed",
				"recon: 0 workers dispatched",
				"verification: PASS",
				"total cost: $1.2345 (3 dispatches)",
				"run log: /tmp/run.log",
				"ledger: /tmp/state/metrics.jsonl",
			].join("\n"),
		);
		expect(succeeded).toBe(true);
	});

	test("FAILED: no lead succeeded, shows first-failure line, reported as not succeeded", () => {
		const report: RunReport = {
			...baseReport(),
			dispatchOk: false,
			succeededLeads: 0,
			totalLeads: 2,
			passedVerification: false,
			firstFailureLine: "ht-orch-1700000000000-abcdef-lead-0 exit 1: boom",
		};
		const { text, succeeded } = buildRunSummary(report);
		expect(text).toBe(
			[
				"Orchestration FAILED in 1m05s.",
				"run_id: ht-orch-1700000000000-abcdef",
				"leads: 0/2 succeeded · retries: 0 · files: 3 changed",
				"recon: 0 workers dispatched",
				"verification: NOT RUN (no lead succeeded)",
				"total cost: $1.2345 (3 dispatches)",
				"first failure: ht-orch-1700000000000-abcdef-lead-0 exit 1: boom",
				"run log: /tmp/run.log",
				"ledger: /tmp/state/metrics.jsonl",
			].join("\n"),
		);
		expect(succeeded).toBe(false);
	});

	test("BLOCKED: every lead stopped at a stop condition, leads line reads 'blocked'", () => {
		const report: RunReport = {
			...baseReport(),
			blocked: true,
			dispatchOk: true, // blocked leads can still exit 0
			verificationSkipped: false,
			passedVerification: false,
		};
		const { text, succeeded } = buildRunSummary(report);
		expect(text).toBe(
			[
				"Orchestration BLOCKED in 1m05s.",
				"run_id: ht-orch-1700000000000-abcdef",
				"leads: 2/2 blocked · retries: 0 · files: 3 changed",
				"recon: 0 workers dispatched",
				"verification: NOT RUN (blocked: every lead stopped at a stop condition or precondition)",
				"total cost: $1.2345 (3 dispatches)",
				"run log: /tmp/run.log",
				"ledger: /tmp/state/metrics.jsonl",
			].join("\n"),
		);
		expect(succeeded).toBe(false);
	});

	test("skipped leads: annotates the leads line with the not-started count", () => {
		const { text } = buildRunSummary({ ...baseReport(), skippedLeads: 1 });
		expect(text).toContain("leads: 2/2 succeeded (+1 not started: dependency failed or blocked) · retries: 0 · files: 3 changed");
	});

	test("external files: annotates the leads line, excluded-from-QA count", () => {
		const { text } = buildRunSummary({ ...baseReport(), externalFilesCount: 2 });
		expect(text).toContain("files: 3 changed (+2 changed by someone else, not verified)");
	});

	test("nested cost: appended to the total cost line", () => {
		const { text } = buildRunSummary({ ...baseReport(), nestedCostUsd: 0.5 });
		expect(text).toContain("total cost: $1.2345 (3 dispatches; $0.5000 of it in lead subagents)");
	});

	test("full report: shown inline (no files changed) with a 'lead report:' header, no truncation notice", () => {
		const report: RunReport = {
			...baseReport(),
			filesChangedCount: 0,
			verificationSkipped: true,
			showFullReport: true,
			reportLines: ["### lead-0", "", "did the thing."],
			reportTruncated: false,
			hasLeadReports: true,
			leadReportPath: "run.log dir/lead-report.md",
		};
		const { text } = buildRunSummary(report);
		expect(text).toBe(
			[
				"Orchestration complete in 1m05s.",
				"run_id: ht-orch-1700000000000-abcdef",
				"leads: 2/2 succeeded · retries: 0 · files: 0 changed",
				"recon: 0 workers dispatched",
				"verification: N/A (no files changed — report-only goal)",
				"total cost: $1.2345 (3 dispatches)",
				"",
				"lead report:",
				"### lead-0",
				"",
				"did the thing.",
				"run log: /tmp/run.log",
				"ledger: /tmp/state/metrics.jsonl",
			].join("\n"),
		);
	});

	test("open items: shown inline (files changed) with an 'open items from lead:' header", () => {
		const report: RunReport = {
			...baseReport(),
			showFullReport: false,
			reportLines: ["- follow up on X", "- consider Y"],
			hasLeadReports: true,
			leadReportPath: "run.log dir/lead-report.md",
		};
		const { text } = buildRunSummary(report);
		expect(text).toContain(["", "open items from lead:", "- follow up on X", "- consider Y", "run log: /tmp/run.log"].join("\n"));
	});

	test("truncated report: full report shown inline, plus a pointer to the on-disk file", () => {
		const report: RunReport = {
			...baseReport(),
			filesChangedCount: 0,
			showFullReport: true,
			reportLines: ["line 1", "line 2"],
			reportTruncated: true,
			hasLeadReports: true,
			leadReportPath: "run.log dir/lead-report.md",
		};
		const { text } = buildRunSummary(report);
		expect(text).toContain(
			["", "lead report:", "line 1", "line 2", "… full report: run.log dir/lead-report.md", "run log: /tmp/run.log"].join("\n"),
		);
	});

	test("truncated report but the lead-report.md write failed (hasLeadReports false): no dangling pointer to a file that doesn't exist", () => {
		const report: RunReport = {
			...baseReport(),
			filesChangedCount: 0,
			showFullReport: true,
			reportLines: ["line 1", "line 2"],
			reportTruncated: true,
			hasLeadReports: false,
			leadReportPath: "run.log dir/lead-report.md",
		};
		const { text } = buildRunSummary(report);
		expect(text).not.toContain("full report:");
		expect(text).not.toContain("lead-report.md");
		expect(text).toContain(["", "lead report:", "line 1", "line 2", "run log: /tmp/run.log"].join("\n"));
	});

	test("hasLeadReports without reportLines: a single 'lead report:' pointer line, no header/body", () => {
		const report: RunReport = {
			...baseReport(),
			reportLines: [],
			hasLeadReports: true,
			leadReportPath: "run.log dir/lead-report.md",
		};
		const { text } = buildRunSummary(report);
		expect(text).toContain(["total cost: $1.2345 (3 dispatches)", "lead report: run.log dir/lead-report.md", "run log: /tmp/run.log"].join("\n"));
		expect(text).not.toContain("open items from lead:");
		expect(text).not.toContain("lead report:\n");
	});

	test("telemetry warning: appended after the ledger line, flips succeeded to false even on a clean run", () => {
		const failedTelemetry: FlushReport = { ok: false, batches: 1, acknowledged: 2, failed: 1, error: "ledger write failed", derivedStale: 0 };
		const { text, succeeded } = buildRunSummary({ ...baseReport(), telemetryReport: failedTelemetry });
		expect(text).toBe(
			[
				"Orchestration complete in 1m05s.",
				"run_id: ht-orch-1700000000000-abcdef",
				"leads: 2/2 succeeded · retries: 0 · files: 3 changed",
				"recon: 0 workers dispatched",
				"verification: PASS",
				"total cost: $1.2345 (3 dispatches)",
				"run log: /tmp/run.log",
				"ledger: /tmp/state/metrics.jsonl",
				"telemetry: 1 record(s) could not be written to the ledger — ledger write failed",
			].join("\n"),
		);
		expect(succeeded).toBe(false);
	});

	test("QA dispatch timed out: verification line reads TIMED OUT, distinct from a completed FAIL, and the run is not reported as succeeded", () => {
		const report = { ...baseReport(), passedVerification: false, verificationTimedOut: true, failedChecks: [] };
		const { text, succeeded } = buildRunSummary(report);
		expect(text).toContain("verification: TIMED OUT (QA dispatch did not complete)");
		expect(succeeded).toBe(false);
	});

	test("QA failed with named checks: the summary names them instead of reading as unparsed", () => {
		const report = { ...baseReport(), passedVerification: false, failedChecks: ["typecheck", "lint"] };
		const { text, succeeded } = buildRunSummary(report);
		expect(text).toContain("verification: FAIL (typecheck, lint)");
		expect(succeeded).toBe(false);
	});

	test("regression: a run where a lead succeeded and QA was dispatched but failed unparsed never reads as NOT RUN (no lead succeeded) (docs/architecture-review.md C5)", () => {
		// The exact bug this closes: the FAILED summary said
		// `verification: NOT RUN (no lead succeeded)` while QA had been dispatched
		// and the log had `verification failed: (unparsed)`. A lead succeeding
		// (dispatchOk: true) plus a failed, unparsed QA verdict must read as a
		// real FAIL, never as "no lead succeeded".
		const report = { ...baseReport(), dispatchOk: true, passedVerification: false, failedChecks: [] };
		const { text } = buildRunSummary(report);
		expect(text).toContain("verification: FAIL (unparsed)");
		expect(text).not.toContain("NOT RUN (no lead succeeded)");
	});
});

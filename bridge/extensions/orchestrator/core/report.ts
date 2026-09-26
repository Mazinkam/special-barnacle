/**
 * Pure builder for the run summary's verification line. Extracted so C5's
 * "the summary contradicts itself" fix (verdict derived from actual
 * verification state, not inferred) is independently unit-testable.
 *
 * `buildRunSummary` (B4.6) goes further: given a `RunReport` — everything
 * `pipeline/run-orchestration.ts` collected by the time a run reaches its
 * terminal (non-cancelled, non-crashed) state — it reproduces the exact
 * multi-line summary text `commands/orchestrate.ts` used to build inline and
 * decides whether the run counts as a success. The cancellation/crash
 * summaries are NOT built here: they are short, session-specific notices
 * (`session.cancelledDispatches()`, `session.cancelReason`, ...) tied to the
 * exact moment a throw unwound the pipeline, not to a completed run's data,
 * and moving their construction here would risk reordering when they're
 * built relative to `failRun`/`session.close()` — they stay in
 * `commands/orchestrate.ts`'s catch block (B4.6 architecture-review note).
 */
import { telemetryHealthy, telemetryWarning, type FlushReport } from "../record-queue.ts";
import { fmtElapsed } from "../run-ui.ts";

export interface VerificationVerdictInput {
	/** True when every dispatched lead stopped at a stop condition or precondition. */
	blocked: boolean;
	/** True when at least one lead succeeded (dispatch produced usable work). */
	dispatchOk: boolean;
	/** True when QA was skipped (e.g. no files changed). */
	verificationSkipped: boolean;
	/** Number of files changed across all leads/workers. */
	filesChangedCount: number;
	/** QA's pass/fail verdict, meaningful only when verification actually ran. */
	passedVerification: boolean;
}

export function verificationVerdictFor(input: VerificationVerdictInput): string {
	if (input.blocked) return "NOT RUN (blocked: every lead stopped at a stop condition or precondition)";
	if (!input.dispatchOk) return "NOT RUN (no lead succeeded)";
	if (input.verificationSkipped) {
		return input.filesChangedCount === 0
			? "N/A (no files changed — report-only goal)"
			: "SKIPPED (no files changed)";
	}
	return input.passedVerification ? "PASS" : "FAIL";
}

/**
 * Everything the run summary needs, collected by `pipeline/run-orchestration.ts`
 * over the course of a (non-cancelled, non-crashed) run. Field-for-field the
 * same locals `commands/orchestrate.ts` used to close over when it built the
 * summary array inline.
 */
export interface RunReport {
	runId: string;
	/** `session.terminalTiming().elapsed_ms` — the session's recorded start to its finalize-time close, not derived from the run id. */
	elapsedMs: number;
	/** True when every lead reported `STATUS: blocked` — no QA, no PASS. */
	blocked: boolean;
	/** True when at least one lead succeeded. */
	dispatchOk: boolean;
	succeededLeads: number;
	totalLeads: number;
	/** Leads never started because a dependency failed or was blocked. */
	skippedLeads: number;
	retries: number;
	/** Files verified this run (after excluding files changed by someone else). */
	filesChangedCount: number;
	/** Files changed during the run that no lead reported changing (excluded from QA). */
	externalFilesCount: number;
	/** `summarizeReconWorkers(workerResults)` (pipeline/hierarchy.ts, pure); pre-rendered
	 *  so core/report.ts doesn't have to depend on pipeline/*. */
	reconWorkersLine: string;
	verificationSkipped: boolean;
	passedVerification: boolean;
	totalCostUsd: number;
	/** Number of billed dispatches (architect/workers/leads/verification/escalation + triage, when triage spent anything). */
	dispatchCount: number;
	nestedCostUsd: number;
	/** `"<taskId> exit <code>: <stderr summary>"`, or `"(no dispatch attempted)"`; only shown when `!dispatchOk`. */
	firstFailureLine: string;
	/** Excerpt lines from the first successful lead's report (full report, or just its Open items). */
	reportLines: string[];
	/** True when `reportLines` is the full report (no files changed) rather than just Open items. */
	showFullReport: boolean;
	/** True when the full report shown was truncated to 40 lines. */
	reportTruncated: boolean;
	/** True when any lead report was written to disk (`lead-report.md`), even if not shown inline. */
	hasLeadReports: boolean;
	/** `describeRunArtifact(session.file("lead-report.md"))`; only read when `reportTruncated || hasLeadReports`. */
	leadReportPath: string;
	/** `describeRunArtifact(session.file("run.log"))`. */
	runLogPath: string;
	/** `<STATE_ROOT>`, for the ledger line. */
	stateRoot: string;
	/** `completeRun`'s drain report, for `telemetryWarning`/`telemetryHealthy`. */
	telemetryReport: FlushReport;
}

/**
 * Build the run summary text and its success/failure verdict from a
 * `RunReport`. Pure: every input is a field on `report`; the only
 * non-determinism (elapsed time, telemetry state) is already baked into it
 * by the time this runs.
 */
export function buildRunSummary(report: RunReport): { text: string; succeeded: boolean } {
	const verdict = verificationVerdictFor({
		blocked: report.blocked,
		dispatchOk: report.dispatchOk,
		verificationSkipped: report.verificationSkipped,
		filesChangedCount: report.filesChangedCount,
		passedVerification: report.passedVerification,
	});
	const summary = [
		`Orchestration ${report.blocked ? "BLOCKED" : report.dispatchOk ? "complete" : "FAILED"} in ${fmtElapsed(report.elapsedMs)}.`,
		`run_id: ${report.runId}`,
		`leads: ${report.succeededLeads}/${report.totalLeads} ${report.blocked ? "blocked" : "succeeded"}${report.skippedLeads > 0 ? ` (+${report.skippedLeads} not started: dependency failed or blocked)` : ""} · retries: ${report.retries} · files: ${report.filesChangedCount} changed${report.externalFilesCount > 0 ? ` (+${report.externalFilesCount} changed by someone else, not verified)` : ""}`,
		report.reconWorkersLine,
		`verification: ${verdict}`,
		`total cost: $${report.totalCostUsd.toFixed(4)} (${report.dispatchCount} dispatches${report.nestedCostUsd > 0 ? `; $${report.nestedCostUsd.toFixed(4)} of it in lead subagents` : ""})`,
		...(report.dispatchOk ? [] : [`first failure: ${report.firstFailureLine}`]),
		...(report.reportLines.length > 0
			? ["", report.showFullReport ? "lead report:" : "open items from lead:", ...report.reportLines, ...(report.reportTruncated && report.hasLeadReports ? [`… full report: ${report.leadReportPath}`] : [])]
			: report.hasLeadReports
				? [`lead report: ${report.leadReportPath}`]
				: []),
		`run log: ${report.runLogPath}`,
		`ledger: ${report.stateRoot}/metrics.jsonl`,
		...telemetryWarning(report.telemetryReport),
	];
	const text = summary.join("\n");
	// Whether the run is reported as a success in the notify and in chat must agree:
	// a run whose verification failed is not "completed" just because dispatch succeeded.
	const succeeded = (report.passedVerification || (report.dispatchOk && report.verificationSkipped)) && telemetryHealthy(report.telemetryReport);
	return { text, succeeded };
}

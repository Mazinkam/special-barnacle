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
import { composeVerificationVerdict, liveQaSummaryLines, type RunLiveQaStageResult } from "../live-qa-stage.ts";
import { fmtElapsed } from "../run-ui.ts";

export interface VerificationVerdictInput {
	/** True when every dispatched lead stopped at a stop condition or precondition. */
	blocked: boolean;
	/** True whenever QA actually got dispatched (i.e. the pre-loop `dispatchOk` gate that decides
	 *  whether QA runs at all held true) — NOT necessarily the run's own final dispatch verdict. A
	 *  lead that succeeded initially but whose escalation retry later failed must not turn an
	 *  otherwise-real QA verdict into "NOT RUN (no lead succeeded)"; see `RunReport.verificationDispatchOk`. */
	dispatchOk: boolean;
	/** True when QA was skipped (e.g. no files changed). */
	verificationSkipped: boolean;
	/** Number of files changed across all leads/workers. */
	filesChangedCount: number;
	/** QA's pass/fail verdict, meaningful only when verification actually ran. */
	passedVerification: boolean;
	/** True when the QA dispatch itself timed out (inactivity or absolute ceiling) rather than
	 *  completing and reporting failing checks. Distinct from a plain FAIL: a timeout means QA
	 *  never finished judging the changed files at all. */
	verificationTimedOut?: boolean;
	/** QA failed at the provider before a check verdict, without timing out. */
	verificationProviderStall?: boolean;
	/** Named checks QA's own report identified as failing (`parseFailedChecks`), when verification
	 *  ran and did not pass. Empty when QA failed (non-zero exit, or an explicit FAIL verdict with
	 *  no named check) without the parser recognizing any specific check — the old
	 *  `verification failed: (unparsed)` case, which must be visible in the summary too, not just
	 *  the run log (docs/architecture-review.md C5). */
	failedChecks?: string[];
}

export function verificationVerdictFor(input: VerificationVerdictInput): string {
	if (input.blocked) return "NOT RUN (blocked: every lead stopped at a stop condition or precondition)";
	if (!input.dispatchOk) return "NOT RUN (no lead succeeded)";
	if (input.verificationSkipped) {
		return input.filesChangedCount === 0
			? "N/A (no files changed — report-only goal)"
			: "SKIPPED (no files changed)";
	}
	if (input.verificationTimedOut) return "QA TIMED OUT (QA dispatch did not complete)";
	if (input.verificationProviderStall) return "QA PROVIDER STALL (QA dispatch did not complete)";
	if (input.passedVerification) return "PASS";
	const checks = input.failedChecks ?? [];
	return checks.length > 0 ? `FAIL (${checks.join(", ")})` : "FAIL (unparsed)";
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
	/** True whenever QA actually got dispatched — fed to `verificationVerdictFor` instead of
	 *  `dispatchOk` above, which is the run's own final success/failure verdict (used for the
	 *  "complete"/"FAILED" label and `firstFailureLine`) and can read false even when QA ran and
	 *  produced a real, reportable verdict (`pipeline/run-orchestration.ts`'s `dispatchOk || finalDispatchOk`). */
	verificationDispatchOk: boolean;
	succeededLeads: number;
	totalLeads: number;
	/** Leads never started because a dependency failed or was blocked. */
	skippedLeads: number;
	retries: number;
	/** taskIds (stripped of the `<runId>-` prefix) of leads re-dispatched once after a transient
	 *  provider error (docs/architecture-review.md C3); empty on every run with no resume, so
	 *  existing summary output is byte-identical when this feature never fires. */
	resumedLeadIds: string[];
	/** One line per lead that took more than one attempt or still failed on its final attempt
	 *  (`pipeline/lead-attempts.ts`'s `formatLeadAttemptLines`), e.g. `lead-0: failed (inactivity) →
	 *  retry-1 succeeded`. Empty when every lead succeeded on its first (only) attempt. */
	leadAttemptLines: string[];
	/** Files verified this run (after excluding files changed by someone else). */
	filesChangedCount: number;
	/** Files changed during the run that no lead reported changing (excluded from QA). */
	externalFilesCount: number;
	/** `summarizeReconWorkers(workerResults)` (pipeline/hierarchy.ts, pure); pre-rendered
	 *  so core/report.ts doesn't have to depend on pipeline/*. */
	reconWorkersLine: string;
	verificationSkipped: boolean;
	passedVerification: boolean;
	/** True when the QA dispatch itself timed out rather than completing (see `VerificationVerdictInput`). */
	verificationTimedOut: boolean;
	/** True when QA's provider failed before a verdict, without a dispatch timeout. */
	verificationProviderStall?: boolean;
	/** Named checks QA's report identified as failing; empty when it failed without the parser
	 *  recognizing any specific check (`FAIL (unparsed)`). */
	failedChecks: string[];
	/** Parent-owned external CI results; unverified/failure never implies PASS. */
	externalChecks?: Array<{ provider: "gitlab" | "github"; id: string; outcome: "pending" | "success" | "failure" | "unverified" }>;
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
	/**
	 * Phase 3 opt-in Forge live-QA stage (T1): present only when `--live-qa`/`--live-qa-scope` was
	 * given, so its verdict/summary stay byte-identical to a run that never requested it.
	 */
	liveQa?: {
		stage: RunLiveQaStageResult | null;
		notRunReason: string | null;
		hasUnknownCost: boolean;
	};
	/**
	 * A6/N2: `core/live-tree.ts`'s `outOfTreeChangesSummaryLine` output for this run, pre-rendered
	 * so this module never has to depend on `pipeline/*`. `null` when the run tree has changes,
	 * or when no lead claimed changes or showed a foreign cd/cwd. Ordinary runs retain their
	 * byte-identical summary output.
	 */
	outOfTreeChangesLine: string | null;
}

/**
 * Build the run summary text and its success/failure verdict from a
 * `RunReport`. Pure: every input is a field on `report`; the only
 * non-determinism (elapsed time, telemetry state) is already baked into it
 * by the time this runs.
 */
export function buildRunSummary(report: RunReport): { text: string; succeeded: boolean } {
	let verdict = verificationVerdictFor({
		blocked: report.blocked,
		dispatchOk: report.verificationDispatchOk,
		verificationSkipped: report.verificationSkipped,
		filesChangedCount: report.filesChangedCount,
		passedVerification: report.passedVerification,
		verificationTimedOut: report.verificationTimedOut,
		verificationProviderStall: report.verificationProviderStall,
		failedChecks: report.failedChecks,
	});
	let passedVerification = report.passedVerification;
	// Phase 3 opt-in Forge live-QA stage (T1): never escalated/retried on, only ever reported —
	// see `composeVerificationVerdict`'s own doc comment for the exact composition rules. Absent
	// (`report.liveQa` undefined) on every run that never requested it, in which case `verdict`/
	// `passedVerification` above are used completely unchanged.
	if (report.liveQa) {
		const stage = report.liveQa.stage;
		const composed = composeVerificationVerdict(verdict, passedVerification, {
			verdict: stage ? (stage.verdict === "not_requested" ? null : stage.verdict) : null,
			required: stage?.required ?? false,
			reasons: stage?.reasons ?? [],
			sessionId: (stage?.outcomeRow?.session_id as string | null | undefined) ?? null,
		});
		verdict = composed.verdict;
		passedVerification = composed.passedVerification;
	}
	// External CI is an independent gate, never a rewrite of QA's own verdict.
	const externalChecks = report.externalChecks ?? [];
	const summary = [
		`Orchestration ${report.blocked || externalChecks.some((check) => check.outcome !== "success") ? "BLOCKED" : report.dispatchOk ? "complete" : "FAILED"} in ${fmtElapsed(report.elapsedMs)}.`,
		`run_id: ${report.runId}`,
		`leads: ${report.succeededLeads}/${report.totalLeads} ${report.blocked ? "blocked" : "succeeded"}${report.skippedLeads > 0 ? ` (+${report.skippedLeads} not started: dependency failed or blocked)` : ""} · retries: ${report.retries} · files: ${report.filesChangedCount} changed${report.externalFilesCount > 0 ? ` (+${report.externalFilesCount} changed by someone else, not verified)` : ""}`,
		report.reconWorkersLine,
		...(report.outOfTreeChangesLine ? [report.outOfTreeChangesLine] : []),
		...(report.resumedLeadIds.length > 0 ? [`resumes: ${report.resumedLeadIds.length} (${report.resumedLeadIds.join(", ")})`] : []),
		...report.leadAttemptLines,
		`verification: ${verdict}`,
		...externalChecks.map((check) => `external check: ${check.provider} ${check.id} ${check.outcome}`),
		`total cost: $${report.totalCostUsd.toFixed(4)} (${report.dispatchCount} dispatches${report.nestedCostUsd > 0 ? `; $${report.nestedCostUsd.toFixed(4)} of it in lead subagents` : ""})`,
		...(report.dispatchOk ? [] : [`first failure: ${report.firstFailureLine}`]),
		...(report.liveQa ? liveQaSummaryLines(report.liveQa.stage, report.liveQa.notRunReason, report.liveQa.hasUnknownCost) : []),
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
	const succeeded = (passedVerification || (report.dispatchOk && report.verificationSkipped)) && externalChecks.every((check) => check.outcome === "success") && telemetryHealthy(report.telemetryReport);
	return { text, succeeded };
}

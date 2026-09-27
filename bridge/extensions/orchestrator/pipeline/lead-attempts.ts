/**
 * Pure "what actually happened to each lead" view. `leadResults` holds only
 * the FINAL attempt used to classify a lead's status (hierarchy.ts's own
 * doc comment) — a lead retried once for a transient provider error
 * (`resumedAttemptResults`) or escalated after a failed verification
 * (`escalationResults`, taskId `<lead>-retry-N`) can have succeeded on a
 * later attempt while `leadResults` alone still looks like a failure. This
 * module reconstructs the full ordered attempt chain per lead, purely from
 * those three already-collected arrays, so `run-orchestration.ts` can report
 * a lead's FINAL attempt (not its first) as the thing that decided the run's
 * outcome.
 *
 * `DispatchResult` does not carry a `retryOf` field (escalation.ts's
 * `EscalationTask.retryOf` only exists on the DispatchTask fed into
 * `dispatchParallel`, not on what comes back) — retries are matched back to
 * their lead by stripping the `-retry-\d+` suffix `planEscalation` appends,
 * which is always exactly one level deep (every retry is built from the
 * lead's ORIGINAL taskId, never from a previous retry's).
 */
import type { DispatchResult } from "../core/records.ts";

export type LeadAttemptLabel = "original" | "resume" | "in-wave retry" | `retry-${number}`;

export interface LeadAttempt {
	label: LeadAttemptLabel;
	result: DispatchResult;
}

export interface LeadAttempts {
	/** The lead's original (un-suffixed) taskId, e.g. `${runId}-lead-0`. */
	leadTaskId: string;
	/** In the order they actually ran: original, then resume (if any), then retry-1, retry-2, ... */
	attempts: LeadAttempt[];
	/** The attempt that speaks for the lead: normally the last attempt, but a lead that already
	 *  succeeded and was only re-dispatched because an escalation retry hedged across every lead is
	 *  judged by its last SUCCEEDED attempt instead, even if a later escalation retry failed — see
	 *  `finalAttemptFor`. */
	final: DispatchResult;
	/** Whether the lead counts as succeeded overall — see `finalAttemptFor`; not simply `final.exitCode === 0`. */
	succeeded: boolean;
}

const RETRY_SUFFIX = /-retry-(\d+)$/;

/** Strip a `-retry-N` suffix, if present, back to the lead's original taskId. */
export function leadTaskIdFor(taskId: string): string {
	return taskId.replace(RETRY_SUFFIX, "");
}

function retryNumberFor(taskId: string): number | null {
	const m = RETRY_SUFFIX.exec(taskId);
	return m ? Number(m[1]) : null;
}

const ESCALATION_RETRY_LABEL = /^retry-\d+$/;

/**
 * Decide which attempt speaks for a lead and whether the lead counts as succeeded overall.
 *
 * The obvious rule — "the last attempt decides" — misclassifies a lead that already succeeded
 * and was only re-dispatched because `planEscalation` retried EVERY lead (it couldn't tell which
 * lead(s) actually caused a failed QA check, so it hedges by retrying all of them). That
 * escalation retry failing does not undo the lead's earlier success; the lead's success still
 * stands, and its LAST SUCCEEDED attempt (not its failed retry) is what should be reported.
 *
 * So: a lead counts as succeeded if its last attempt succeeded, OR if some earlier attempt
 * succeeded and every attempt after it is an escalation retry (`retry-N`) — never a resume or
 * in-wave retry, both of which exist specifically because the attempt before them genuinely
 * failed and needs a completely fresh attempt to speak for the lead.
 */
function finalAttemptFor(attempts: LeadAttempt[]): { final: DispatchResult; succeeded: boolean } {
	const last = attempts[attempts.length - 1]!;
	if (last.result.exitCode === 0) return { final: last.result, succeeded: true };
	for (let i = attempts.length - 2; i >= 0; i--) {
		const laterAreAllEscalationRetries = attempts.slice(i + 1).every((a) => ESCALATION_RETRY_LABEL.test(a.label));
		if (!laterAreAllEscalationRetries) break; // a non-retry attempt after i means i's success was superseded for real
		if (attempts[i]!.result.exitCode === 0) return { final: attempts[i]!.result, succeeded: true };
	}
	return { final: last.result, succeeded: false };
}

/**
 * Build the ordered attempt chain for every lead in `leadResults` (in lead
 * order), folding in `resumedAttemptResults` (C3's transient-error resume;
 * same taskId as the lead) and `escalationResults` (verification-failure
 * retries; taskId `<lead>-retry-N`).
 */
export function collectLeadAttempts(
	leadResults: DispatchResult[],
	resumedAttemptResults: DispatchResult[],
	escalationResults: DispatchResult[],
	/** taskIds recovered via A3's in-wave retry (not C3's transient-error resume); shares
	 *  `resumedAttemptResults` for billing, but is labeled "in-wave retry" instead of "resume" here. */
	retriedLeadTaskIds: readonly string[] = [],
): LeadAttempts[] {
	const resumedByTaskId = new Map<string, DispatchResult>();
	for (const r of resumedAttemptResults) resumedByTaskId.set(r.taskId, r);
	const retriedSet = new Set(retriedLeadTaskIds);

	const retriesByLead = new Map<string, DispatchResult[]>();
	for (const r of escalationResults) {
		const n = retryNumberFor(r.taskId);
		if (n === null) continue; // not a retry-shaped taskId; nothing to attribute it to
		const leadTaskId = leadTaskIdFor(r.taskId);
		const list = retriesByLead.get(leadTaskId) ?? [];
		list.push(r);
		retriesByLead.set(leadTaskId, list);
	}
	for (const list of retriesByLead.values()) {
		list.sort((a, b) => (retryNumberFor(a.taskId) ?? 0) - (retryNumberFor(b.taskId) ?? 0));
	}

	return leadResults.map((r) => {
		const leadTaskId = r.taskId; // leadResults' own taskId is never retry-suffixed
		const resumedFrom = resumedByTaskId.get(leadTaskId);
		const attempts: LeadAttempt[] = resumedFrom
			? [{ label: "original", result: resumedFrom }, { label: retriedSet.has(leadTaskId) ? "in-wave retry" : "resume", result: r }]
			: [{ label: "original", result: r }];
		for (const retryResult of retriesByLead.get(leadTaskId) ?? []) {
			const n = retryNumberFor(retryResult.taskId) ?? attempts.length;
			attempts.push({ label: `retry-${n}`, result: retryResult });
		}
		const { final, succeeded } = finalAttemptFor(attempts);
		return { leadTaskId, attempts, final, succeeded };
	});
}

/** `"inactivity"`, `"absolute"`, `"cancelled"`, or `"exit N"` — never called on a succeeded attempt. */
export function attemptFailureReason(result: DispatchResult): string {
	if (result.outcome === "cancelled") return "cancelled";
	if (result.outcome === "timed_out") return result.timeoutReason ?? "timed out";
	return `exit ${result.exitCode}`;
}

/**
 * One line per lead that either took more than one attempt or still failed
 * on its final attempt, e.g. `lead-0: failed (inactivity) → retry-1
 * succeeded`. Leads that succeeded on their first (only) attempt produce no
 * line. `runId` strips the `<runId>-` prefix, matching every other run-id
 * strip in the summary (e.g. `resumedLeadIds`).
 */
export function formatLeadAttemptLines(runId: string, leads: LeadAttempts[]): string[] {
	const lines: string[] = [];
	for (const lead of leads) {
		if (lead.attempts.length <= 1 && lead.succeeded) continue;
		const segments = lead.attempts.map((attempt, i) => {
			const status = attempt.result.exitCode === 0 ? "succeeded" : `failed (${attemptFailureReason(attempt.result)})`;
			return i === 0 ? status : `${attempt.label} ${status}`;
		});
		lines.push(`${lead.leadTaskId.replace(`${runId}-`, "")}: ${segments.join(" → ")}`);
	}
	return lines;
}

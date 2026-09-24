/**
 * Pure escalation planning for a failed verification (method.json
 * `rules.review_after_fix`). Fixes BUG 2 (2026-10 retry regression): retries
 * were built from `{ task: r.stdout }` — the FAILED LEAD'S REPORT — so the
 * retry lead received its own postmortem instead of the goal, scope and
 * model-routing table it was originally given. A retry must always carry the
 * original prompt forward verbatim; the failed report is at most a bounded,
 * clearly delimited feedback section appended after it.
 */
import { METHOD } from "./models.ts";
import { escalateLeadCapability, isLeadCapability } from "./lead-sizing.ts";

/** The minimum a caller needs to know about a lead's ORIGINAL dispatch. */
export interface EscalationTaskInput {
	taskId: string;
	capability: string;
	task: string;
	tools?: string[];
}

/** A lead's original task plus the outcome of its most recent attempt. */
export interface EscalationLeadInput {
	/** Unmodified — this is what gets carried forward into the retry prompt. */
	task: EscalationTaskInput;
	/** Only used to (a) decide whether this lead is retried and (b) build the bounded feedback section; never used as the retry prompt itself. */
	result: { exitCode: number; stdout: string; filesChanged: string[] };
}

export interface EscalationTask extends EscalationTaskInput {
	retryOf: string;
	retryCount: number;
}

/** Last N characters of a failed lead's report kept in the retry's feedback section. */
export const FEEDBACK_TAIL_CHARS = 4000;

/**
 * Decide which leads get retried on a verification failure.
 *
 * Verification runs once over the UNION of files changed by every lead, so a
 * failure does not, by itself, say which lead caused it. The policy:
 *
 *  1. Any lead whose OWN dispatch did not succeed (`exitCode !== 0`) is
 *     retried — it may not have finished its work at all.
 *  2. Any lead whose reported `filesChanged` overlaps a failed-check string
 *     (substring match) is retried — that overlap is the only evidence in
 *     the verification output that ties a failure to a specific lead's
 *     files, i.e. "determinable".
 *  3. If neither rule selects anyone — every lead exited 0 and no failed
 *     check names a file any lead touched — overlap is NOT determinable
 *     from the verification output alone. Retry ALL leads rather than guess
 *     which one is responsible; under-retrying here silently ships a failed
 *     verification.
 */
export function leadsToRetry(leads: EscalationLeadInput[], failedChecks: string[]): EscalationLeadInput[] {
	const failedDispatch = leads.filter((l) => l.result.exitCode !== 0);
	const overlap = leads.filter(
		(l) => l.result.filesChanged.length > 0 && l.result.filesChanged.some((f) => failedChecks.some((c) => c.includes(f))),
	);
	const targetIds = new Set([...failedDispatch, ...overlap].map((l) => l.task.taskId));
	if (targetIds.size === 0) return leads; // not determinable -> retry all
	return leads.filter((l) => targetIds.has(l.task.taskId));
}

/**
 * Build one retry DispatchTask per lead selected by `leadsToRetry`, or []
 * when escalation is done (bounded by `maxRetries`, which must match the
 * caller's own retry loop so the two can never disagree about when to stop).
 *
 * The model for each retry is chosen by the caller's `pickModel`, which
 * applies method.json Rule 1 (`rules.review_after_fix`) for the run's risk.
 */
export function planEscalation(
	failedChecks: string[],
	leads: EscalationLeadInput[],
	complexity: number,
	risk: string,
	retryCount: number,
	maxRetries: number,
): EscalationTask[] {
	if (retryCount >= maxRetries) return []; // stop-loss, consistent with the caller's while-loop bound
	if (failedChecks.length === 0) return [];
	if (leads.length === 0) return [];

	const isHighRisk = risk === "high" || risk === "critical";
	const targets = leadsToRetry(leads, failedChecks);

	// A lead that failed verification is retried one size up per retry
	// (lead_small -> lead -> lead_large), capped at the largest size. Retry N
	// climbs N sizes from the lead's ORIGINAL capability.
	return targets.map(({ task, result }) => {
		let capability = task.capability;
		if (METHOD.rules.lead_sizing.escalate_on_verification_failure && isLeadCapability(capability)) {
			for (let i = 0; i <= retryCount; i++) capability = escalateLeadCapability(capability) ?? capability;
		}
		const feedback = result.stdout.slice(-FEEDBACK_TAIL_CHARS);
		return {
			...task,
			capability,
			taskId: `${task.taskId}-retry-${retryCount + 1}`,
			retryOf: task.taskId,
			retryCount: retryCount + 1,
			task: [
				task.task,
				"",
				`[Escalation: retry #${retryCount + 1}]`,
				"",
				`--- BEGIN failed verification feedback (previous attempt's report, last ${FEEDBACK_TAIL_CHARS} chars) ---`,
				feedback,
				"--- END failed verification feedback ---",
				"",
				`Previous attempt failed verification with:`,
				...failedChecks.map((c) => `- ${c}`),
				isHighRisk
					? "Risk is high/critical: re-review MUST use at least the premium tier."
					: "Re-review must use at least the mid tier.",
			].join("\n"),
		};
	});
}

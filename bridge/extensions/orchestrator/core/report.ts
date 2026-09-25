/**
 * Pure builder for the run summary's verification line. Extracted so C5's
 * "the summary contradicts itself" fix (verdict derived from actual
 * verification state, not inferred) is independently unit-testable.
 *
 * Most of the run summary in `index.ts` is built from closures over dozens of
 * mutable, run-scoped locals (elapsed time via `fmtElapsed`, lead reports,
 * cost totals, ...) and is not practically extractable without threading all
 * of that through as parameters; it is left in place. This is the one
 * self-contained piece: given the run's terminal state, what verification
 * verdict string does the summary show.
 */

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

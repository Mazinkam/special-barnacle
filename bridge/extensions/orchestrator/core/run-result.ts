export const RUN_RESULT_SCHEMA = "orchestration-result";
export const RUN_RESULT_VERSION = 1;
export const RUN_RESULT_LIMITS = { payloadBytes: 65536, stringChars: 2048, openItems: 50, criteria: 20, artifacts: 50 } as const;

export type RunCause =
	| "lead_partial"
	| "lead_blocked"
	| "external_check"
	| "dispatch_failed"
	| "plan_failed"
	| "crashed"
	| "cancelled_user"
	| "cancelled_shutdown"
	| "aborted";
export const RUN_CAUSES: readonly RunCause[] = ["lead_partial", "lead_blocked", "external_check", "dispatch_failed", "plan_failed", "crashed", "cancelled_user", "cancelled_shutdown", "aborted"];
export type RunOutcome = "complete" | "partial" | "blocked" | "failed" | "cancelled";
export interface CriterionResult {
	id: string;
	result: "pass" | "fail" | "blocked";
	expected?: Record<string, string | number | boolean>;
	observed?: Record<string, string | number | boolean>;
	artifacts: string[];
	note?: string;
}
export interface AcceptanceResult {
	overall: "pass" | "fail" | "blocked";
	criteria: CriterionResult[];
}
export interface RunResultV1 {
	schema: typeof RUN_RESULT_SCHEMA;
	version: 1;
	runId: string;
	outcome: RunOutcome;
	causes: RunCause[];
	codeVerification: "pass" | "fail" | "skipped" | "not_run";
	liveQa: {
		verdict: "pass" | "fail" | "unavailable" | "not_requested";
		sessionId?: string;
		testedCommit?: string;
		reasons: string[];
	};
	acceptance?: AcceptanceResult;
	externalChecks: Array<{ provider: string; id: string; outcome: string; reason?: string }>;
	openItems: string[];
	diagnostics: string[];
	cost: { usd: number; complete: boolean };
	runLog: string;
}

const FAILED: RunCause[] = ["dispatch_failed", "plan_failed", "crashed", "aborted"];
const BLOCKED: RunCause[] = ["lead_blocked", "external_check"];

export function outcomeFromCauses(causes: RunCause[]): RunOutcome {
	if (causes.some((c) => c === "cancelled_user" || c === "cancelled_shutdown")) return "cancelled";
	if (causes.some((c) => FAILED.includes(c))) return "failed";
	if (causes.some((c) => BLOCKED.includes(c))) return "blocked";
	if (causes.includes("lead_partial")) return "partial";
	return "complete";
}

function sanitizeCauses(causes: readonly unknown[]): RunCause[] {
	const out: RunCause[] = [];
	for (const c of causes) {
		if (RUN_CAUSES.includes(c as RunCause) && !out.includes(c as RunCause)) out.push(c as RunCause);
	}
	return out.slice(0, RUN_CAUSES.length);
}

function violation(result: RunResultV1): string | null {
	const L = RUN_RESULT_LIMITS;
	if (result.causes.length > RUN_CAUSES.length) return `causes ${result.causes.length} > ${RUN_CAUSES.length}`;
	if (new Set(result.causes).size !== result.causes.length) return "causes contain duplicates";
	if (result.causes.some((c) => !RUN_CAUSES.includes(c))) return "causes contain unknown values";
	if (result.openItems.length > L.openItems) return `openItems ${result.openItems.length} > ${L.openItems}`;
	const criteria = result.acceptance?.criteria ?? [];
	if (criteria.length > L.criteria) return `criteria ${criteria.length} > ${L.criteria}`;
	const artifacts = criteria.reduce((n, c) => n + c.artifacts.length, 0);
	if (artifacts > L.artifacts) return `artifacts ${artifacts} > ${L.artifacts}`;
	const strings: string[] = [];
	JSON.stringify(result, (k, v) => {
		strings.push(k); // object keys count toward the per-string limit too
		if (typeof v === "string") strings.push(v);
		return v;
	});
	if (strings.some((s) => s.length > L.stringChars)) return `string longer than ${L.stringChars}`;
	if (Buffer.byteLength(JSON.stringify(result)) > L.payloadBytes) return `payload > ${L.payloadBytes} bytes`;
	return null;
}

/** Over-limit results are replaced, not truncated: a partial truncation could drop the one
 *  failing criterion and read as a pass. The replacement can never pass the loop's gate. */
export function enforceRunResultBounds(result: RunResultV1): RunResultV1 {
	const problem = violation(result);
	if (!problem) return result;
	const causes = sanitizeCauses(result.causes);
	return {
		schema: RUN_RESULT_SCHEMA,
		version: 1,
		runId: result.runId.slice(0, 200),
		outcome: outcomeFromCauses(causes),
		causes,
		codeVerification: result.codeVerification,
		liveQa: { verdict: "unavailable", reasons: [] },
		acceptance: { overall: "blocked", criteria: [] },
		externalChecks: [],
		openItems: [],
		diagnostics: [`result exceeded bounds: ${problem}`],
		cost: result.cost,
		runLog: result.runLog.slice(0, 1024),
	};
}

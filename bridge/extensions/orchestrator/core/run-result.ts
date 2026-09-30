import type { RunReport } from "./report.ts";

export const RUN_RESULT_SCHEMA = "orchestration-result";
export const RUN_RESULT_VERSION = 1;
/** `stringChars` counts UTF-16 code units (JS `string.length`), not bytes or code points; the
 *  byte budget is `payloadBytes` (UTF-8 of the serialized result). */
export const RUN_RESULT_LIMITS = {
	payloadBytes: 65536, stringChars: 2048, openItems: 50, criteria: 20, artifacts: 50,
	reasons: 20, diagnostics: 20, externalChecks: 20,
} as const;

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

/** Explicit, marked truncation (never silent): result is <= max chars and ends with a
 *  `…[truncated N chars]` marker. Lengths are JS string lengths (UTF-16 code units). */
export function truncateMarked(text: string, max: number): string {
	if (text.length <= max) return text;
	let dropped = text.length - max;
	for (;;) {
		const marker = `…[truncated ${dropped} chars]`;
		const next = text.length - (max - marker.length);
		if (next === dropped) return text.slice(0, max - marker.length) + marker;
		dropped = next;
	}
}

/** Per-field clip sizes applied BEFORE `enforceRunResultBounds`, so ordinary oversized evidence is
 *  shortened with an explicit marker instead of the whole result being replaced. */
export const RUN_RESULT_CLIPS = { openItem: 500, text: 500, observed: 200, agentNote: 300, criterionNote: 500 } as const;

function capList(items: string[], max: number, what: string): string[] {
	if (items.length <= max) return items;
	return [...items.slice(0, max - 1), `…[${items.length - (max - 1)} more ${what}]`];
}

/** Explicitly clips normal-sized evidence to fit the bounds. Never touches causes, outcome,
 *  verdicts, or criterion ids/results/expected (the parts a gate decides on). */
function clipForBounds(result: RunResultV1): RunResultV1 {
	const C = RUN_RESULT_CLIPS;
	const L = RUN_RESULT_LIMITS;
	const text = (t: string) => truncateMarked(t, C.text);
	return {
		...result,
		liveQa: { ...result.liveQa, reasons: capList(result.liveQa.reasons.map(text), L.reasons, "reasons") },
		...(result.acceptance ? {
			acceptance: {
				overall: result.acceptance.overall,
				criteria: result.acceptance.criteria.map((c) => ({
					...c,
					...(c.observed ? { observed: Object.fromEntries(Object.entries(c.observed).map(([k, v]) => [k, typeof v === "string" ? truncateMarked(v, C.observed) : v])) } : {}),
					...(c.note !== undefined ? { note: truncateMarked(c.note, C.criterionNote) } : {}),
				})),
			},
		} : {}),
		externalChecks: result.externalChecks.map((c) => ({
			provider: text(c.provider), id: text(c.id), outcome: text(c.outcome), ...(c.reason !== undefined ? { reason: text(c.reason) } : {}),
		})),
		openItems: capList(result.openItems.map((i) => truncateMarked(i, C.openItem)), L.openItems, "open items"),
		diagnostics: capList(result.diagnostics.map(text), L.diagnostics, "diagnostics"),
	};
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

/** Mirrors `verificationVerdictFor`'s precedence: "fail" only for a QA run that really failed;
 *  QA that never ran or never finished (all leads blocked, no dispatch, timeout, provider stall)
 *  is "not_run". */
function codeVerificationFor(report: RunReport): RunResultV1["codeVerification"] {
	if (report.blocked || !report.verificationDispatchOk) return "not_run";
	if (report.verificationSkipped) return "skipped";
	if (report.verificationTimedOut || report.verificationProviderStall) return "not_run";
	return report.passedVerification ? "pass" : "fail";
}

/** The single cause derivation for a completed run: feeds both `RunResultV1.causes`/`outcome` and
 *  the human summary banner (`buildRunSummary`), so the two can never disagree. */
export function deriveCauses(report: RunReport): RunCause[] {
	const statuses = report.leadStatuses ?? [];
	const external = report.externalChecks ?? [];
	const causes: RunCause[] = [];
	if (statuses.includes("partial")) causes.push("lead_partial");
	if (report.blocked || statuses.includes("blocked")) causes.push("lead_blocked");
	if (external.some((c) => c.outcome !== "success")) causes.push("external_check");
	if (!report.dispatchOk || statuses.includes("failed")) causes.push("dispatch_failed");
	return causes;
}

export function buildCompletedRunResult(report: RunReport): RunResultV1 {
	const external = report.externalChecks ?? [];
	const causes = deriveCauses(report);
	const stage = report.liveQa?.stage ?? null;
	const row = stage?.outcomeRow ?? null;
	return enforceRunResultBounds(clipForBounds({
		schema: RUN_RESULT_SCHEMA,
		version: 1,
		runId: report.runId,
		outcome: outcomeFromCauses(causes),
		causes,
		codeVerification: codeVerificationFor(report),
		liveQa: {
			verdict: stage?.verdict ?? "not_requested",
			...(typeof row?.session_id === "string" ? { sessionId: row.session_id } : {}),
			...(typeof row?.tested_revision === "string" ? { testedCommit: row.tested_revision } : {}),
			reasons: stage?.reasons ?? (report.liveQa?.notRunReason ? [report.liveQa.notRunReason] : []),
		},
		...(report.acceptance ? { acceptance: report.acceptance } : {}),
		externalChecks: external.map((c) => ({ provider: c.provider, id: c.id, outcome: c.outcome, ...(c.reason ? { reason: c.reason } : {}) })),
		// report.openItems is the untruncated list; reportLines is display-capped and may hold the whole report.
		openItems: report.openItems
			?? report.reportLines.filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, "")),
		diagnostics: report.dispatchOk ? [] : [report.firstFailureLine],
		cost: { usd: report.totalCostUsd, complete: !(report.liveQa?.hasUnknownCost ?? false) },
		runLog: report.runLogPath,
	}));
}

export function buildTerminalRunResult(input: {
	runId: string;
	causes: RunCause[];
	diagnostic: string;
	costUsd: number;
	costComplete: boolean;
	runLog: string;
}): RunResultV1 {
	return enforceRunResultBounds({
		schema: RUN_RESULT_SCHEMA,
		version: 1,
		runId: input.runId,
		outcome: outcomeFromCauses(input.causes),
		causes: input.causes,
		codeVerification: "not_run",
		liveQa: { verdict: "not_requested", reasons: [] },
		externalChecks: [],
		openItems: [],
		diagnostics: [truncateMarked(input.diagnostic, RUN_RESULT_LIMITS.stringChars)],
		cost: { usd: input.costUsd, complete: input.costComplete },
		runLog: input.runLog,
	});
}

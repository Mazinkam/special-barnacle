/**
 * Classify a finished dispatch attempt for failover. Only stderr and the harness's
 * own error field are read, never the model's prose. Lines the orchestrator itself
 * writes (timeout diagnostics that quote shell commands) are excluded, so numbers
 * such as `tail -500` are never taken for HTTP 5xx errors.
 */
import type { EventScan } from "./event-scan.ts";
import { isTransientProviderError } from "./transient-error.ts";
import { isQuotaError } from "../provider-fallback.ts";

export type FailureClass = "ok" | "cancelled" | "quota" | "transient" | "stall" | "task";

export interface AttemptSignals {
	exitCode: number;
	outcome: string;
	stderr: string;
	errorMessage?: string;
	stopReason?: string;
	timeoutReason?: "inactivity" | "absolute";
	toolInFlight: boolean;
	cancelled: boolean;
}

export const TRANSIENT_ERROR_RE =
	/service unavailable|\b5\d\d\b|overloaded|pending stream has been canceled|stream ended without a stop reason|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|throttl/i;

const ORCHESTRATOR_LINE_RE =
	/^\s*(\[orchestrator\]|⚠|taskId:|elapsedMs:|sinceLastProgressMs:|turns:|toolCalls:|repeatedToolCalls:|lastProgress:|nestedWorkers:|verified:|partialText:)/;

/** First line of the note dispatch-progress.ts's renderInterruptionReport() renders. */
const INTERRUPTION_REPORT_START_RE = /^\s*UNVERIFIED PARTIAL WORK\b/;

export function providerText(stderr: string, errorMessage?: string): string {
	const lines: string[] = [];
	for (const raw of stderr.split(/\r?\n/)) {
		// index.ts appends the interruption note (dispatch-progress.ts's
		// renderInterruptionReport) last, as `\n${note}`. Its final field,
		// partialText, is unverified assistant prose that can span many lines and
		// can itself contain classifier-triggering substrings (e.g. "Service
		// unavailable") or a taskId that reads like an HTTP status. The per-line
		// prefix filter below drops each *known* report field line, but a
		// continuation line of partialText has no recognizable prefix and would
		// otherwise survive. Because the report is always appended last, once its
		// first line is seen it is safe -- and conservative -- to drop it and
		// every line after it, rather than trying to re-parse partialText's shape.
		if (INTERRUPTION_REPORT_START_RE.test(raw)) break;
		if (raw.trim() && !ORCHESTRATOR_LINE_RE.test(raw)) lines.push(raw);
	}
	return [...lines, errorMessage ?? ""].filter(Boolean).join("\n");
}

export function classifyFailure(s: AttemptSignals): FailureClass {
	if (s.cancelled || s.outcome === "cancelled") return "cancelled";
	if (s.exitCode === 0 && (s.outcome === "completed" || s.outcome === "completed_after_process_error")) return "ok";
	if (s.stopReason === "spend_cap") return "task";
	const text = providerText(s.stderr, s.errorMessage);
	if (isQuotaError(text)) return "quota";
	if (isTransientProviderError(text)) return "transient";
	if (s.outcome === "timed_out" && s.timeoutReason === "inactivity" && !s.toolInFlight) return "stall";
	return "task";
}

export function failureReason(s: AttemptSignals, max = 160): string {
	const lines = providerText(s.stderr, s.errorMessage).split("\n");
	const hit = lines.find((l) => isQuotaError(l) || isTransientProviderError(l)) ?? lines.find((l) => l.trim()) ?? "";
	const fallback = s.outcome === "timed_out" ? `timed out (${s.timeoutReason ?? "unknown"})` : `exit ${s.exitCode}`;
	return (hit.trim() || fallback).slice(0, max);
}

export function hadRealWork(
	scan: Pick<EventScan, "toolCalls" | "finishedWorkers">,
	filesChanged: readonly string[],
	minToolCalls: number,
): boolean {
	return filesChanged.length > 0 || scan.finishedWorkers.length > 0 || scan.toolCalls >= minToolCalls;
}

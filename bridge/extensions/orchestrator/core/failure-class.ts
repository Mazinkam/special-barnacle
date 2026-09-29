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

/**
 * The vocabulary telemetry (`provider_error`/`dispatch_finished`'s `failure_class` field;
 * see contract.json's `failure_class_values`) uses instead of `FailureClass`. This is a
 * pure rename/refinement of `classifyFailure`'s decision, never a second rule table: every
 * value here is derived from a `FailureClass` plus whether the attempt timed out (see
 * `telemetryFailureClass`), not from re-running any pattern match of its own.
 */
export type TelemetryFailureClass = "cancelled" | "quota" | "transient" | "provider_stall" | "task";

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

/**
 * Single construction point for the failure classifier's input shape, so `dispatch/failover.ts`
 * (which decides real routing/failover behavior) and `dispatch/provider-health.ts`'s
 * `dispatchHealth` (which decides the `dispatch_finished`/`provider_error` telemetry class) can
 * never drift into classifying the same attempt two different ways from two different signal
 * sets ("one classifier"). Both callers pass exactly the attempt's OWN stderr/errorMessage here --
 * nested worker evidence (`provider-health.ts`'s `nestedProviderErrors`) is recorded separately
 * (see `providerErrors()`) and may still drive a diagnostic `error_code` fallback there, but must
 * never reach `classifyFailure` and change `failure_class`/the failover decision.
 */
export function attemptSignals(input: AttemptSignals): AttemptSignals {
	return { ...input };
}

export function classifyFailure(s: AttemptSignals): FailureClass {
	if (s.cancelled || s.outcome === "cancelled") return "cancelled";
	if (s.exitCode === 0 && (s.outcome === "completed" || s.outcome === "completed_after_process_error")) return "ok";
	if (s.stopReason === "spend_cap") return "task";
	const text = providerText(s.stderr, s.errorMessage);
	// Quota text can be quoted by timeout/interruption diagnostics; unlike a
	// confirmed transient stream error, never restart timed-out completed work.
	if (isQuotaError(text)) return s.outcome === "timed_out" ? "task" : "quota";
	if (isTransientProviderError(text)) return "transient";
	if (s.outcome === "timed_out" && s.timeoutReason === "inactivity" && !s.toolInFlight) return "stall";
	return "task";
}

/**
 * Rename layer from `classifyFailure`'s failover decision to the telemetry vocabulary
 * (`provider_error`/`dispatch_finished`'s `failure_class`, contract.json's
 * `failure_class_values`). `timedOut` distinguishes the two shapes telemetry has
 * historically split "transient"/"stall" into: a transient provider error that also
 * happened to time out reads as `provider_stall` (the dispatch never got a clean
 * response before the watchdog killed it), while the same error on a non-timed-out
 * attempt reads as `transient`. `stall` (inactivity timeout, no tool in flight) is
 * always `provider_stall`. Everything else passes through unchanged. `wait_stall`
 * (a watchdog kill mid wait-command) is NOT produced here: `classifyFailure` has no
 * visibility into the in-flight tool's command shape (only a boolean), so callers
 * that need to distinguish it must check `core/wait-stall.ts`'s `classifyTimeout`
 * themselves, before falling back to this mapping — see `dispatch/provider-health.ts`.
 */
export function telemetryFailureClass(cls: FailureClass, timedOut: boolean): TelemetryFailureClass {
	switch (cls) {
		case "transient":
			return timedOut ? "provider_stall" : "transient";
		case "stall":
			return "provider_stall";
		case "ok":
			return "task";
		default:
			return cls;
	}
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

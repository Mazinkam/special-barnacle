import { isQuotaError } from "../provider-fallback.ts";
import { isTransientProviderError } from "../core/transient-error.ts";
import { classifyTimeout } from "../core/wait-stall.ts";
import { classifyFailure, providerText, telemetryFailureClass, attemptSignals, type AttemptSignals } from "../core/failure-class.ts";

interface Evidence { message: string; timestamp: string }
interface HealthInput {
 outcome: string;
 exitCode: number;
 timeoutReason?: "inactivity" | "absolute";
 toolInFlight?: { name: string; command?: string; waitPattern?: boolean };
 stderr?: string;
 model?: string;
 stopReason?: string;
 errorMessage?: string;
 nestedProviderErrors?: Evidence[];
}

/**
 * `text` here is always `providerText()`-filtered (orchestrator diagnostic lines and the
 * interruption report already dropped) before this runs, so it is a diagnostic sub-code over
 * exactly the same evidence `classifyFailure` itself reads -- never a second classification
 * table. It never decides quota/transient/task/stall on its own; `dispatchHealth` below always
 * derives `failure_class` from `classifyFailure`/`telemetryFailureClass`, and only attaches
 * whichever of these labels (if any) matches, purely as extra detail alongside that class.
 */
function errorCode(text: string): string | undefined {
 const bounded = text.slice(0, 16_384);
 if (isQuotaError(bounded)) return "quota";
 if (/\bENOTFOUND\b/i.test(bounded)) return "ENOTFOUND";
 if (/\bECONNRESET\b/i.test(bounded)) return "ECONNRESET";
 if (/\bETIMEDOUT\b/i.test(bounded)) return "ETIMEDOUT";
 if (/\bfetch failed\b/i.test(bounded)) return "fetch_failed";
 if (/\b(?:stream (?:has been |was )?cance(?:led|lled)|pending stream has been cance(?:led|lled))\b/i.test(bounded)) return "stream_canceled";
 if (/\b(?:stream ended without (?:a )?stop reason|no stop reason)\b/i.test(bounded)) return "stream_no_stop_reason";
 if (isTransientProviderError(bounded) && /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?|error|code)[\s:=#/-]+5\d\d\b|\bhttp\b[^\n]{0,10}\b5xx\b/i.test(bounded)) return "http_5xx";
 return undefined;
}

function modelIdentity(model?: string): { provider?: string; model?: string } {
 const match = /^([a-zA-Z0-9_-]{1,48})\/([a-zA-Z0-9._/-]{1,120})$/.exec(model ?? "");
 return match ? { provider: match[1], model: match[2] } : {};
}

function endpointHost(message: string): string | undefined {
 const match = /https?:\/\/[^\s"'<>]{1,512}/i.exec(message.slice(0, 16_384));
 const dns = match ? null : /\bgetaddrinfo\s+ENOTFOUND\s+([^\s"'<>]{1,253})(?=\s|$)/i.exec(message.slice(0, 16_384));
 try {
  const host = (match ? new URL(match[0]).hostname : dns?.[1])?.toLowerCase();
  return host && host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : undefined;
 } catch { return undefined; }
}

/** `input.stderr` with the diagnostic tail (`\nnestedWorkers: ...`) that `dispatch-progress.ts`
 *  appends dropped, bounded, and never containing the model's own prose -- the same slice both
 *  `errorCode` and `classifyFailure` (via the `AttemptSignals` built below) read. */
function ownStderr(input: HealthInput): string {
 return (input.stderr ?? "").split("\nnestedWorkers:", 1)[0].slice(0, 16_384);
}

export function dispatchHealth(input: HealthInput): { outcome: string; timeout_reason?: string; failure_class?: string; provider?: string; model?: string; error_code?: string } {
 const stderr = ownStderr(input);
 const nestedMessages = (input.nestedProviderErrors ?? []).map(e => e.message.slice(0, 16_384));
 // Same filtering `classifyFailure` applies internally (drop orchestrator-written diagnostic
 // lines and the interruption report) before either the shared classifier or the `errorCode`
 // diagnostic sub-code below ever look at the text -- one filter, read by both.
 const filteredOwn = providerText(stderr, input.errorMessage);
 const filteredNested = nestedMessages.map(m => providerText(m));
 const code = errorCode(filteredOwn) ?? filteredNested.map(errorCode).find(Boolean);
 const identity = modelIdentity(input.model);

 let failureClass: string | undefined;
 if (input.outcome === "completed" || input.outcome === "completed_after_process_error") {
  failureClass = undefined;
 } else if (
  input.outcome === "timed_out" &&
  classifyTimeout({ outcome: input.outcome, timeoutReason: input.timeoutReason, toolInFlight: input.toolInFlight }) === "wait_stall"
 ) {
  // wait_stall (a watchdog kill mid wait-command) needs the in-flight tool's command shape,
  // which `AttemptSignals` (a plain boolean) does not carry -- see `telemetryFailureClass`'s
  // doc comment. `core/wait-stall.ts` is a distinct, already-shared classifier (also used by
  // `pipeline/hierarchy.ts`), not a second copy of the provider-failure rule table.
  failureClass = "wait_stall";
 } else {
  // Same shared construction `dispatch/failover.ts` uses (`attemptSignals`, core/failure-class.ts),
  // fed the SAME unstripped `input.stderr` failover reads (never `ownStderr`'s tail-stripped
  // slice): failover has no `ownStderr` step, so if this stripped the `\nnestedWorkers: ...`
  // tail (and any `[provider nested error] ...` lines inside it) before classifying, this
  // `failure_class` could disagree with the `FailureClass` failover already acted on for the
  // exact same attempt. `ownStderr` still gates the diagnostic `error_code` above and the own
  // (nested:false) `providerErrors()` row below, so nested evidence still never gets double-
  // counted as this attempt's own row -- it just must never change `failure_class` itself.
  const signals: AttemptSignals = attemptSignals({
   exitCode: input.exitCode,
   outcome: input.outcome,
   stderr: input.stderr ?? "",
   errorMessage: input.errorMessage,
   stopReason: input.stopReason,
   timeoutReason: input.timeoutReason,
   toolInFlight: Boolean(input.toolInFlight),
   cancelled: input.outcome === "cancelled",
  });
  const cls = classifyFailure(signals);
  failureClass = telemetryFailureClass(cls, input.outcome === "timed_out");
 }

 return { outcome: input.outcome, ...(input.timeoutReason ? { timeout_reason: input.timeoutReason } : {}),
  ...(failureClass ? { failure_class: failureClass } : {}), ...(identity.provider ? { provider: identity.provider, provider_model: identity.model } : {}), ...(code ? { error_code: code } : {}) };
}

/** Only normalized diagnostics leave this boundary; never persist the source message. */
export function recordProviderErrors(recordEvent: (event: string, payload: Record<string, unknown>) => void,
 context: { runId: string; taskId?: string; dispatchAttempt?: number }, input: HealthInput): void {
 for (const payload of providerErrors(input)) recordEvent("provider_error", {
  run_id: context.runId, task_id: context.taskId, dispatch_attempt: context.dispatchAttempt ?? 0, ...payload,
 });
}

export function providerErrors(input: HealthInput): Array<Record<string, unknown>> {
 const identity = modelIdentity(input.model);
 const evidence: Array<Evidence & { nested: boolean }> = (input.nestedProviderErrors ?? []).map(e => ({ ...e, nested: true }));
 const stderr = ownStderr(input);
 if (stderr && input.outcome !== "completed" && input.outcome !== "cancelled") {
  evidence.push({ message: stderr, timestamp: new Date().toISOString(), nested: false });
 }
 const grouped = new Map<string, Record<string, unknown>>();
 for (const entry of evidence) {
  const code = errorCode(providerText(entry.message.slice(0, 16_384)));
  if (!code) continue;
  const host = endpointHost(entry.message);
  const key = JSON.stringify([entry.nested, code, host, identity.provider, identity.model]);
  const existing = grouped.get(key);
  if (existing) {
   existing.count = Number(existing.count) + 1;
   if (entry.timestamp < String(existing.first_ts)) existing.first_ts = entry.timestamp;
   if (entry.timestamp > String(existing.last_ts)) existing.last_ts = entry.timestamp;
  } else grouped.set(key, { ...identity, nested: entry.nested, error_code: code, ...(host ? { endpoint_host: host } : {}),
   count: 1, first_ts: entry.timestamp, last_ts: entry.timestamp });
 }
 return [...grouped.values()];
}

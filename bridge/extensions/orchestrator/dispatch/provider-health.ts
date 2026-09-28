import { isQuotaError } from "../provider-fallback.ts";
import { isTransientProviderError } from "../core/transient-error.ts";
import { classifyTimeout } from "../core/wait-stall.ts";

interface Evidence { message: string; timestamp: string }
interface HealthInput {
 outcome: string;
 exitCode: number;
 timeoutReason?: "inactivity" | "absolute";
 toolInFlight?: { name: string; command?: string; waitPattern?: boolean };
 stderr?: string;
 model?: string;
 nestedProviderErrors?: Evidence[];
}

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

export function dispatchHealth(input: HealthInput): { outcome: string; timeout_reason?: string; failure_class?: string; provider?: string; model?: string; error_code?: string } {
 const ownStderr = (input.stderr ?? "").split("\nnestedWorkers:", 1)[0].slice(0, 16_384);
 const code = errorCode(ownStderr) ?? input.nestedProviderErrors?.map(e => errorCode(e.message)).find(Boolean);
 const failureClass = input.outcome === "cancelled" ? "cancelled"
  : input.outcome === "timed_out" ? classifyTimeout(input) === "wait_stall" ? "wait_stall" : code || isTransientProviderError(ownStderr) || input.nestedProviderErrors?.some(e => isTransientProviderError(e.message.slice(0, 16_384))) ? "provider_stall" : "task"
  : input.outcome === "completed" || input.outcome === "completed_after_process_error" ? undefined
  : code === "quota" ? "quota" : isTransientProviderError(ownStderr) || input.nestedProviderErrors?.some(e => isTransientProviderError(e.message.slice(0, 16_384))) ? "transient" : "task";
 const identity = modelIdentity(input.model);
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
 const ownStderr = (input.stderr ?? "").split("\nnestedWorkers:", 1)[0].slice(0, 16_384);
 if (ownStderr && input.outcome !== "completed" && input.outcome !== "cancelled") {
  evidence.push({ message: ownStderr, timestamp: new Date().toISOString(), nested: false });
 }
 const grouped = new Map<string, Record<string, unknown>>();
 for (const entry of evidence) {
  const code = errorCode(entry.message);
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

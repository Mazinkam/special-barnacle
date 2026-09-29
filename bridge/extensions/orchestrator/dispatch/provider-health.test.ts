import { describe, expect, test } from "bun:test";
import { dispatchHealth, providerErrors } from "./provider-health.ts";
import { classifyFailure, telemetryFailureClass, type AttemptSignals } from "../core/failure-class.ts";
import { classifyTimeout } from "../core/wait-stall.ts";

const base = { outcome: "failed" as const, exitCode: 1, model: "openai-codex/gpt-6", timeoutReason: undefined };

test.each([
 ["getaddrinfo ENOTFOUND api.example.com", "ENOTFOUND"],
 ["read ECONNRESET", "ECONNRESET"],
 ["connect ETIMEDOUT", "ETIMEDOUT"],
 ["TypeError: fetch failed", "fetch_failed"],
 ["Pending stream has been canceled", "stream_canceled"],
 ["stream ended without stop reason", "stream_no_stop_reason"],
 ["HTTP 503 Service Unavailable", "http_5xx"],
 ["usage limit reached", "quota"],
] as const)("normalizes %s into %s without leaking the message", (message, code) => {
 const [event] = providerErrors({ ...base, stderr: message, nestedProviderErrors: [] });
 expect(event).toMatchObject({ provider: "openai-codex", model: "gpt-6", error_code: code, count: 1 });
 expect(JSON.stringify(event)).not.toContain(message);
});

test("classifies disposition and distinguishes wait stalls from provider stalls", () => {
 expect(dispatchHealth({ ...base, outcome: "timed_out", timeoutReason: "inactivity", toolInFlight: { name: "bash", waitPattern: true } }).failure_class).toBe("wait_stall");
 // A plain inactivity timeout with no tool in flight and no error text is the same
 // "stall" `classifyFailure` (core/failure-class.ts) already uses to trigger model
 // failover (dispatch/failover.ts) -- the telemetry class must agree, not read "task"
 // while failover switches models underneath it.
 expect(dispatchHealth({ ...base, outcome: "timed_out", timeoutReason: "inactivity" }).failure_class).toBe("provider_stall");
 expect(dispatchHealth({ ...base, outcome: "timed_out", timeoutReason: "absolute", stderr: "fetch failed" }).failure_class).toBe("provider_stall");
 expect(dispatchHealth({ ...base, outcome: "timed_out", timeoutReason: "inactivity", nestedProviderErrors: [{ message: "read ECONNRESET", timestamp: "2026-01-01T00:00:00Z" }] }).failure_class).toBe("provider_stall");
 expect(dispatchHealth({ ...base, stderr: "HTTP 502" }).failure_class).toBe("transient");
 expect(dispatchHealth({ ...base, stderr: "usage limit reached" }).failure_class).toBe("quota");
 expect(dispatchHealth({ ...base, outcome: "cancelled" }).failure_class).toBe("cancelled");
 expect(dispatchHealth({ ...base, outcome: "completed" }).failure_class).toBeUndefined();
 expect(dispatchHealth(base).failure_class).toBe("task");
});

test("does not count the child diagnostic's replay of a nested error as new evidence", () => {
 const entries = providerErrors({ ...base,
  stderr: "failure\nnestedWorkers: worker 1\n[provider nested error] read ECONNRESET",
  nestedProviderErrors: [{ message: "read ECONNRESET", timestamp: "2026-01-01T00:00:00.000Z" }],
 });
 expect(entries).toHaveLength(1);
 expect(entries[0]).toMatchObject({ error_code: "ECONNRESET", count: 1 });
});

test("keeps own and nested errors separate even when code and host match", () => {
 const entries = providerErrors({ ...base, stderr: "read ECONNRESET https://api.example.com/own", nestedProviderErrors: [
  { message: "read ECONNRESET https://api.example.com/nested", timestamp: "2026-01-01T00:00:00.000Z" },
 ] });
 expect(entries).toHaveLength(2);
 expect(entries.map(e => [e.nested, e.count])).toEqual([[true, 1], [false, 1]]);
});

test("extracts DNS endpoint hostname without persisting the diagnostic", () => {
 const message = "getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com";
 const [entry] = providerErrors({ ...base, stderr: message });
 expect(entry).toMatchObject({ error_code: "ENOTFOUND", endpoint_host: "bedrock-runtime.us-east-1.amazonaws.com", nested: false });
 expect(JSON.stringify(entry)).not.toContain(message);
 expect(providerErrors({ ...base, stderr: "getaddrinfo ENOTFOUND ../bad" })[0]).not.toHaveProperty("endpoint_host");
});

test("deduplicates nested snapshots within a dispatch and exposes only endpoint host", () => {
 const entries = providerErrors({ ...base, stderr: "", nestedProviderErrors: [
  { message: "fetch failed https://api.example.com/private?token=secret", timestamp: "2026-01-01T00:00:00.000Z" },
  { message: "fetch failed https://api.example.com/other?token=other", timestamp: "2026-01-01T00:00:02.000Z" },
 ] });
 expect(entries).toHaveLength(1);
 expect(entries[0]).toMatchObject({ error_code: "fetch_failed", endpoint_host: "api.example.com", count: 2, first_ts: "2026-01-01T00:00:00.000Z", last_ts: "2026-01-01T00:00:02.000Z" });
 expect(JSON.stringify(entries)).not.toMatch(/private|secret|other|https:/);
});

describe("one provider-failure classifier: failover's decision and telemetry's failure_class agree", () => {
 // Each row is one attempt disposition. `expectedFailoverClass` is what `classifyFailure`
 // (dispatch/failover.ts's actual decision maker) returns for the equivalent AttemptSignals;
 // `expectedTelemetryClass` is `dispatchHealth`'s failure_class for the same attempt. There is
 // no second regex table here: both columns are derived, in this test, from the SAME shared
 // primitives (`classifyFailure`/`telemetryFailureClass`/`classifyTimeout`) that the production
 // code paths call -- this test would fail if either production path stopped agreeing with them.
 const rows: Array<{
  name: string;
  input: Parameters<typeof dispatchHealth>[0];
  signals: AttemptSignals;
 }> = [
  {
   name: "quota text",
   input: { ...base, stderr: "You have hit your usage limit" },
   signals: { exitCode: 1, outcome: "failed", stderr: "You have hit your usage limit", toolInFlight: false, cancelled: false },
  },
  {
   name: "503",
   input: { ...base, stderr: "HTTP 503 Service Unavailable" },
   signals: { exitCode: 1, outcome: "failed", stderr: "HTTP 503 Service Unavailable", toolInFlight: false, cancelled: false },
  },
  {
   name: "ECONNRESET",
   input: { ...base, stderr: "read ECONNRESET" },
   signals: { exitCode: 1, outcome: "failed", stderr: "read ECONNRESET", toolInFlight: false, cancelled: false },
  },
  {
   name: "stream canceled",
   input: { ...base, stderr: "Pending stream has been canceled" },
   signals: { exitCode: 1, outcome: "failed", stderr: "Pending stream has been canceled", toolInFlight: false, cancelled: false },
  },
  {
   name: "inactivity timeout, no tool in flight",
   input: { ...base, outcome: "timed_out", timeoutReason: "inactivity" },
   signals: { exitCode: 1, outcome: "timed_out", stderr: "", timeoutReason: "inactivity", toolInFlight: false, cancelled: false },
  },
  {
   name: "wait-pattern timeout (bash watch, in flight)",
   input: { ...base, outcome: "timed_out", timeoutReason: "inactivity", toolInFlight: { name: "bash", waitPattern: true } },
   signals: { exitCode: 1, outcome: "timed_out", stderr: "", timeoutReason: "inactivity", toolInFlight: true, cancelled: false },
  },
  {
   name: "spend_cap",
   input: { ...base, stopReason: "spend_cap", stderr: "Service unavailable" },
   signals: { exitCode: 1, outcome: "failed", stderr: "Service unavailable", stopReason: "spend_cap", toolInFlight: false, cancelled: false },
  },
  {
   name: "cancelled",
   input: { ...base, outcome: "cancelled" },
   signals: { exitCode: 1, outcome: "cancelled", stderr: "", toolInFlight: false, cancelled: true },
  },
  {
   name: "plain task error",
   input: { ...base, stderr: "TypeError: x is not a function" },
   signals: { exitCode: 1, outcome: "failed", stderr: "TypeError: x is not a function", toolInFlight: false, cancelled: false },
  },
 ];

 test.each(rows.map((r) => [r.name, r] as const))("%s", (_name, row) => {
  const timedOut = row.input.outcome === "timed_out";
  const timeoutClass = timedOut
   ? classifyTimeout({ outcome: row.input.outcome, timeoutReason: row.input.timeoutReason, toolInFlight: row.input.toolInFlight })
   : "timed_out";
  const expectedFailoverClass = classifyFailure(row.signals);
  const expectedTelemetryClass = timeoutClass === "wait_stall" ? "wait_stall" : telemetryFailureClass(expectedFailoverClass, timedOut);
  expect(dispatchHealth(row.input).failure_class).toBe(expectedTelemetryClass);
 });
});

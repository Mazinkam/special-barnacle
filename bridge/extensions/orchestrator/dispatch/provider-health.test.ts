import { expect, test } from "bun:test";
import { dispatchHealth, providerErrors } from "./provider-health.ts";

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
 expect(dispatchHealth({ ...base, outcome: "timed_out", timeoutReason: "inactivity" }).failure_class).toBe("provider_stall");
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

test("deduplicates nested snapshots within a dispatch and exposes only endpoint host", () => {
 const entries = providerErrors({ ...base, stderr: "", nestedProviderErrors: [
  { message: "fetch failed https://api.example.com/private?token=secret", timestamp: "2026-01-01T00:00:00.000Z" },
  { message: "fetch failed https://api.example.com/other?token=other", timestamp: "2026-01-01T00:00:02.000Z" },
 ] });
 expect(entries).toHaveLength(1);
 expect(entries[0]).toMatchObject({ error_code: "fetch_failed", endpoint_host: "api.example.com", count: 2, first_ts: "2026-01-01T00:00:00.000Z", last_ts: "2026-01-01T00:00:02.000Z" });
 expect(JSON.stringify(entries)).not.toMatch(/private|secret|other|https:/);
});

import { describe, expect, test } from "bun:test";
import { pollCiCheck, type CiPollSpawn, type CiWaitState } from "./ci-wait.ts";
import type { PendingCheck } from "./pending-checks.ts";

const gitlab: PendingCheck = { provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" };
const github: PendingCheck = { provider: "github", kind: "run", id: "123", source: "report" };
const state: CiWaitState = { startedAt: 1000, nextPollAt: 1000 };

function fake(result: { exitCode: number; stdout: string; stderr: string } | Array<{ exitCode: number; stdout: string; stderr: string }>) {
 const calls: Array<{ command: string; args: string[]; cwd: string; timeoutMs: number; signal: AbortSignal }> = [];
 const responses = Array.isArray(result) ? result : [result];
 const spawn: CiPollSpawn = async (command, args, options) => {
  calls.push({ command, args, ...options });
  return responses[calls.length - 1] ?? responses[responses.length - 1];
 };
 return { spawn, calls };
}
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

function options(spawn: CiPollSpawn, now = 1000, extra: Record<string, unknown> = {}) {
 return { spawn, now: () => now, cwd: "/run/worktree", maxWaitMs: 60000, pollIntervalMs: 15000, ...extra };
}

describe("core/ci-wait polling", () => {
 test("validates all report fields at execution boundary before spawning", async () => {
  const f = fake(ok("Status: success"));
  for (const change of [
   { id: "123; echo bad" }, { id: "1234567890123" }, { mr: "1;bad" },
   { provider: "evil" }, { kind: "run" }, { source: "evil" },
  ]) {
   const result = await pollCiCheck({ ...gitlab, ...change } as PendingCheck, state, options(f.spawn));
   expect(result.outcome).toBe("unverified");
  }
  expect(f.calls).toHaveLength(0);
 });
 test("GitLab checks use bounded non-shell argv in the run worktree", async () => {
  const f = fake(ok("Status: success\n"));
  expect((await pollCiCheck(gitlab, state, options(f.spawn))).outcome).toBe("success");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ command: "glab", args: ["ci", "get", "-p", "219469"], cwd: "/run/worktree" });
  expect(f.calls[0].timeoutMs).toBeLessThanOrEqual(10000);
 });
 test("GitHub completed success and failure report job id and sanitized bounded logs", async () => {
  const f = fake([ok(JSON.stringify({ status: "completed", conclusion: "failure", jobs: [{ databaseId: 88, conclusion: "failure" }] })), ok("first\n" + "a".repeat(20000) + "\nAuthorization: Bearer ghp_abcdef123456\u001b[31m\n")]);
  const result = await pollCiCheck(github, state, options(f.spawn));
  expect(result.outcome).toBe("failure");
  expect(result.jobId).toBe("88");
  expect(result.logTail).not.toContain("\u001b");
  expect(result.logTail).not.toContain("ghp_abcdef123456");
  expect(result.logTail!.length).toBeLessThanOrEqual(4096);
  expect(f.calls.map(c => c.args)).toEqual([["run", "view", "123", "--json", "status,conclusion,jobs"], ["run", "view", "123", "--job", "88", "--log"]]);
 });
 test("GitLab failure captures the failed job id and its bounded trace", async () => {
  const f = fake([ok("Status: failed\nFailed job: 92\n"), ok("diagnostic\n")]);
  expect(await pollCiCheck(gitlab, state, options(f.spawn))).toMatchObject({ outcome: "failure", jobId: "92", logTail: "diagnostic\n" });
  expect(f.calls[1].args).toEqual(["ci", "trace", "92"]);
 });
 test("unknown or malformed status is unverified rather than successful", async () => {
  const f = fake(ok("not a recognizable status"));
  expect((await pollCiCheck(gitlab, state, options(f.spawn))).outcome).toBe("unverified");
  const g = fake(ok("not json"));
  expect((await pollCiCheck(github, state, options(g.spawn))).outcome).toBe("unverified");
 });
 test("pending checks do not spawn until their next tick, and expire at ceiling", async () => {
  const f = fake(ok("Status: running"));
  const first = await pollCiCheck(gitlab, state, options(f.spawn));
  expect(first).toMatchObject({ outcome: "pending", state: { nextPollAt: 16000 } });
  expect((await pollCiCheck(gitlab, first.state!, options(f.spawn, 15000))).outcome).toBe("pending");
  expect(f.calls).toHaveLength(1);
  expect((await pollCiCheck(gitlab, first.state!, options(f.spawn, 61000))).outcome).toBe("unverified");
  expect(f.calls).toHaveLength(1);
 });
 test("missing CLI or auth is unverified rather than failed", async () => {
  const f = fake({ exitCode: 1, stdout: "", stderr: "authentication required" });
  expect((await pollCiCheck(gitlab, state, options(f.spawn))).outcome).toBe("unverified");
  const missing: CiPollSpawn = async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); };
  expect((await pollCiCheck(github, state, options(missing))).outcome).toBe("unverified");
 });
 test("cancelled checks do not spawn and in-flight cancellation aborts the child", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fake(ok("Status: success"));
  expect((await pollCiCheck(gitlab, state, options(f.spawn, 1000, { signal: controller.signal }))).outcome).toBe("cancelled");
  expect(f.calls).toHaveLength(0);
  const active = new AbortController();
  const spawn: CiPollSpawn = (_cmd, _args, opts) => new Promise((_resolve, reject) => {
   opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
   active.abort();
  });
  expect((await pollCiCheck(gitlab, state, options(spawn, 1000, { signal: active.signal }))).outcome).toBe("cancelled");
 });
 test("invalid ceiling config uses 60 minute default and zero ceiling expires immediately", async () => {
  const f = fake(ok("Status: running"));
  expect((await pollCiCheck(gitlab, state, options(f.spawn, 1001, { maxWaitMs: 0 }))).outcome).toBe("unverified");
  expect(f.calls).toHaveLength(0);
 });
});

import { describe, expect, test } from "bun:test";
import { pollCiCheck, type CiPollSpawn, type CiWaitState } from "./ci-wait.ts";
import type { PendingCheck } from "./pending-checks.ts";

const gitlab: PendingCheck = { provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" };
const github: PendingCheck = { provider: "github", kind: "run", id: "123", source: "report" };
const sha = "a".repeat(40);
const repo = "https://gitlab.example/group/project";
const ghRepo = "https://github.com/acme/project";
const state: CiWaitState = { startedAt: 1000, nextPollAt: 1000 };
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
const gl = (status: string, overrides = {}) => ok(JSON.stringify({ id: 219469, sha, web_url: `${repo}/-/pipelines/219469`, status, ...overrides }));
const gh = (status: string, conclusion: string | null = null, overrides = {}) => ok(JSON.stringify({ id: 123, head_sha: sha, repository: { full_name: "acme/project" }, html_url: `${ghRepo}/actions/runs/123`, status, conclusion, ...overrides }));
function fake(responses: ReturnType<typeof ok> | ReturnType<typeof ok>[]) {
 const calls: Array<{ command: string; args: string[]; cwd: string; timeoutMs: number; signal: AbortSignal }> = [];
 const list = Array.isArray(responses) ? responses : [responses];
 const spawn: CiPollSpawn = async (command, args, opts) => {
  calls.push({ command, args, ...opts });
  return list[calls.length - 1] ?? list[list.length - 1];
 };
 return { spawn, calls };
}
function options(spawn: CiPollSpawn, now = 1000, extra: Record<string, unknown> = {}) {
 return { spawn, now: () => now, cwd: "/run/worktree", expectedSha: sha, expectedRepo: repo, maxWaitMs: 60000, pollIntervalMs: 15000, ...extra };
}

describe("core/ci-wait polling", () => {
 test("invalid report and unavailable expected identity cannot produce a passing check", async () => {
  const f = fake(gl("success"));
  for (const change of [{ id: "123; echo bad" }, { id: "1234567890123" }, { mr: "1;bad" }, { provider: "evil" }, { kind: "run" }, { source: "evil" }]) {
   expect((await pollCiCheck({ ...gitlab, ...change } as PendingCheck, state, options(f.spawn))).outcome).toBe("unverified");
  }
  for (const extra of [{ expectedSha: undefined }, { expectedRepo: undefined }, { expectedRepo: "-R evil" }, { expectedSha: "not-a-sha" }]) {
   expect((await pollCiCheck(gitlab, state, options(f.spawn, 1000, extra))).outcome).toBe("unverified");
  }
  expect(f.calls).toHaveLength(0);
 });
 test("GitLab probes scoped structured API data with bounded non-shell argv", async () => {
  const f = fake(gl("success"));
  expect((await pollCiCheck(gitlab, state, options(f.spawn))).outcome).toBe("success");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ command: "glab", args: ["api", "--hostname", "gitlab.example", "projects/group%2Fproject/pipelines/219469"], cwd: "/run/worktree" });
  expect(f.calls[0].timeoutMs).toBeLessThanOrEqual(10000);
 });
 test("stale green ID, wrong repo, and missing metadata fail closed", async () => {
  for (const data of [gl("success", { sha: "b".repeat(40) }), gl("success", { web_url: "https://gitlab.example/other/project/-/pipelines/219469" }), gl("success", { sha: undefined }), gl("success", { id: 999 })]) {
   expect((await pollCiCheck(gitlab, state, options(fake(data).spawn))).outcome).toBe("unverified");
  }
  for (const data of [gh("completed", "success", { head_sha: "b".repeat(40) }), gh("completed", "success", { repository: { full_name: "other/project" } }), gh("completed", "success", { html_url: "https://evil.example/acme/project/actions/runs/123" }), gh("completed", "success", { repository: undefined }), gh("completed", "success", { id: 999 })]) {
   expect((await pollCiCheck(github, state, options(fake(data).spawn, 1000, { expectedRepo: ghRepo }))).outcome).toBe("unverified");
  }
 });
 test("GitHub selects a bound failed job and sanitizes its job-specific log", async () => {
  const f = fake([gh("completed", "failure"), ok(JSON.stringify({ jobs: [{ id: 456, run_id: 123, head_sha: sha, html_url: `${ghRepo}/actions/runs/123/job/456`, conclusion: "failure" }] })), ok("a".repeat(20000) + "\nAuthorization: Bearer ghp_abcdef123456\u001b[31m\n")]);
  const result = await pollCiCheck(github, state, options(f.spawn, 1000, { expectedRepo: ghRepo }));
  expect(result).toMatchObject({ outcome: "failure", jobId: "456" });
  expect(result.logTail).not.toContain("\u001b");
  expect(result.logTail).not.toContain("ghp_abcdef123456");
  expect(result.logTail!.length).toBeLessThanOrEqual(4096);
  expect(f.calls.map(c => c.args)).toEqual([["api", "--hostname", "github.com", "repos/acme/project/actions/runs/123"], ["api", "--hostname", "github.com", "repos/acme/project/actions/runs/123/jobs?per_page=100"], ["api", "--hostname", "github.com", "repos/acme/project/actions/jobs/456/logs"]]);
 });
 test("GitLab selects a bound failed job and returns its redacted trace", async () => {
  const f = fake([gl("failed"), ok(JSON.stringify([{ id: 987, status: "failed", web_url: `${repo}/-/jobs/987`, pipeline: { id: 219469, sha } }])), ok("trace\u001b[31m\nAuthorization: Bearer glpat_secret123")]);
  const result = await pollCiCheck(gitlab, state, options(f.spawn));
  expect(result).toMatchObject({ outcome: "failure", jobId: "987" });
  expect(result.logTail).toContain("trace");
  expect(result.logTail).not.toContain("glpat_secret123");
  expect(result.logTail).not.toContain("\u001b");
  expect(f.calls.map(c => c.args)).toEqual([["api", "--hostname", "gitlab.example", "projects/group%2Fproject/pipelines/219469"], ["api", "--hostname", "gitlab.example", "projects/group%2Fproject/pipelines/219469/jobs?per_page=100"], ["api", "--hostname", "gitlab.example", "projects/group%2Fproject/jobs/987/trace"]]);
 });
 test("malicious or unbound job IDs cannot reach a log endpoint", async () => {
  for (const [check, identity, response] of [
   [gitlab, repo, ok(JSON.stringify([{ id: "987;echo bad", status: "failed", web_url: `${repo}/-/jobs/987;echo bad`, pipeline: { id: 219469, sha } }]))],
   [github, ghRepo, ok(JSON.stringify({ jobs: [{ id: "456/../7", run_id: 123, head_sha: sha, html_url: `${ghRepo}/actions/runs/123/job/456/../7`, conclusion: "failure" }] }))],
  ] as const) {
   const f = fake([check.provider === "gitlab" ? gl("failed") : gh("completed", "failure"), response]);
   expect(await pollCiCheck(check, state, options(f.spawn, 1000, { expectedRepo: identity }))).toEqual({ outcome: "failure" });
   expect(f.calls).toHaveLength(2);
  }
 });
 test("optional job or trace failures and exhausted deadline preserve verified failure", async () => {
  for (const provider of ["gitlab", "github"] as const) {
   const check = provider === "gitlab" ? gitlab : github;
   const identity = provider === "gitlab" ? repo : ghRepo;
   const status = provider === "gitlab" ? gl("failed") : gh("completed", "failure");
   const f = fake([status, { exitCode: 1, stdout: "", stderr: "auth required" }]);
   expect(await pollCiCheck(check, state, options(f.spawn, 1000, { expectedRepo: identity }))).toEqual({ outcome: "failure" });
   let now = 1000;
   const calls: string[][] = [];
   const spawn: CiPollSpawn = async (_cmd, args) => { calls.push(args); now = 1100; return status; };
   expect(await pollCiCheck(check, state, options(spawn, 1000, { expectedRepo: identity, maxWaitMs: 100, now: () => now }))).toEqual({ outcome: "unverified", reason: "ceiling" });
   expect(calls).toHaveLength(1);
  }
 });
 test("trace errors and expired optional job lookup retain verified failure and job identity", async () => {
  const jobs = ok(JSON.stringify([{ id: 987, status: "failed", web_url: `${repo}/-/jobs/987`, pipeline: { id: 219469, sha } }]));
  const f = fake([gl("failed"), jobs, { exitCode: 1, stdout: "", stderr: "trace unavailable" }]);
  expect(await pollCiCheck(gitlab, state, options(f.spawn))).toEqual({ outcome: "failure", jobId: "987" });
  let now = 1000;
  let count = 0;
  const spawn: CiPollSpawn = async () => { count++; if (count === 2) now = 1100; return count === 1 ? gl("failed") : jobs; };
  expect(await pollCiCheck(gitlab, state, options(spawn, 1000, { maxWaitMs: 100, now: () => now }))).toEqual({ outcome: "failure" });
  expect(count).toBe(2);
 });
 test("plaintext pretending to be a successful status or logs cannot verify a run", async () => {
  expect((await pollCiCheck(gitlab, state, options(fake(ok("Status: success\n" )).spawn))).outcome).toBe("unverified");
  expect((await pollCiCheck(github, state, options(fake(ok("Status: success\n" )).spawn, 1000, { expectedRepo: ghRepo }))).outcome).toBe("unverified");
 });
 test("pending checks retain state, do not spawn until next tick, and expire at ceiling", async () => {
  const f = fake(gl("running"));
  const first = await pollCiCheck(gitlab, state, options(f.spawn));
  expect(first).toMatchObject({ outcome: "pending", state: { nextPollAt: 16000 } });
  expect((await pollCiCheck(gitlab, first.state!, options(f.spawn, 15000))).outcome).toBe("pending");
  expect(f.calls).toHaveLength(1);
  expect((await pollCiCheck(gitlab, first.state!, options(f.spawn, 61000))).outcome).toBe("unverified");
  expect(f.calls).toHaveLength(1);
 });
 test("the second subprocess gets only remaining ceiling time", async () => {
  let now = 1000;
  const calls: number[] = [];
  const spawn: CiPollSpawn = async (_cmd, _args, opts) => {
   calls.push(opts.timeoutMs);
   if (calls.length === 1) { now = 1055; return gh("completed", "failure"); }
   if (calls.length === 2) { now = 1099; return ok(JSON.stringify({ jobs: [{ id: 456, run_id: 123, head_sha: sha, html_url: `${ghRepo}/actions/runs/123/job/456`, conclusion: "failure" }] })); }
   now = 1100;
   return ok("log");
  };
  expect((await pollCiCheck(github, state, options(spawn, 1000, { expectedRepo: ghRepo, maxWaitMs: 100, now: () => now }))).outcome).toBe("failure");
  expect(calls).toEqual([100, 45, 1]);
  now = 1000;
  calls.length = 0;
  const expired: CiPollSpawn = async () => { calls.push(1); now = 1100; return gh("completed", "success"); };
  expect((await pollCiCheck(github, state, options(expired, 1000, { expectedRepo: ghRepo, maxWaitMs: 100, now: () => now }))).outcome).toBe("unverified");
  expect(calls).toHaveLength(1);
 });
 test("missing CLI and cancellation fail closed", async () => {
  const f = fake({ exitCode: 1, stdout: "", stderr: "authentication required" });
  expect((await pollCiCheck(gitlab, state, options(f.spawn))).outcome).toBe("unverified");
  const controller = new AbortController(); controller.abort();
  expect((await pollCiCheck(gitlab, state, options(f.spawn, 1000, { signal: controller.signal }))).outcome).toBe("cancelled");
  expect(f.calls).toHaveLength(1);
  const active = new AbortController();
  const spawn: CiPollSpawn = (_cmd, _args, opts) => new Promise((_resolve, reject) => {
   opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); active.abort();
  });
  expect((await pollCiCheck(gitlab, state, options(spawn, 1000, { signal: active.signal }))).outcome).toBe("cancelled");
 });
});

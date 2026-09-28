import { expect, test } from "bun:test";
import { dispatchReconAndLeads } from "./hierarchy.ts";
import type { DispatchTask, PlanResponse } from "../core/prompts.ts";
import type { DispatchResult } from "../core/records.ts";
import type { CiPollSpawn } from "../core/ci-wait.ts";
import { waitForPendingChecks } from "./run-orchestration.ts";
import { RunCancellation } from "../cancellation.ts";

const plan = {
 plan_id: "p", run_id: "r", task_class: "investigation", complexity: 8, risk: "medium",
 topology: { depth: 3, leads: 2, workers: 0, shape: "multi_lead" },
 route: { selected: { capability: "lead", effort: "standard", verification_depth: "targeted" }, recommended: { capability: "lead", effort: "standard", verification_depth: "targeted" }, mode: "adaptive", history_sufficient: true, explanation: {} },
 effective_quality_floor: .8, cost_aggressiveness: .5,
} as PlanResponse;
const architect = { taskId: "r-architect", exitCode: 0, stdout: "## Lead assignments\nLead 1: first (depends on: none)\nLead 2: second (depends on: 1)\n" } as DispatchResult;
const result = (task: DispatchTask, stdout: string): DispatchResult => ({
 taskId: task.taskId, capability: task.capability, model: "m", exitCode: 0, stdout, stderr: "", usage: {} as never,
 durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
});

for (const status of ["success", "failure", "unverified"] as const) {
 test(`dependent wave receives ${status} external check without treating it as a passing check`, async () => {
  const batches: DispatchTask[][] = [];
  const checks: string[] = [];
  const output = await dispatchReconAndLeads({ runId: "r", goal: "g", plan, adapter: { lead: { model: "m" } }, architectResult: architect, evidenceMaxChars: 1000, maxLeads: 2, repoRoot: "/repo" }, {
   dispatch: async (tasks) => { batches.push(tasks); return tasks.map((t) => result(t, t.taskId === "r-lead-0" ? "## Pending external checks\n- gh run view 123\nSTATUS: completed" : "STATUS: completed")); },
   capture: async () => {}, setPhase: () => {}, throwIfCancelled: () => {},
   waitForChecks: async (pending) => { checks.push(pending[0].id); return [{ check: pending[0], outcome: status, ...(status === "failure" ? { jobId: "456", logTail: "safe failure" } : {}) }]; },
  });
  expect(checks).toEqual(["123"]);
  expect(batches.map((b) => b.map((t) => t.taskId))).toEqual([["r-lead-0"], ["r-lead-1"]]);
  expect(batches[1][0].task).toContain(status === "success" ? "external check" : status === "failure" ? "456" : "unverified external check");
  if (status === "failure") expect(batches[1][0].task).toContain("safe failure");
  expect(output.pendingChecks[0].outcome).toBe(status);
 });
}

test("CI wait uses cancellable ticks and bounded CLI calls until check succeeds", async () => {
 let now = 0;
 const cancellation = new RunCancellation();
 const rows: string[] = [];
 const calls: number[] = [];
 const spawn: CiPollSpawn = async (_command, _args, options) => {
  calls.push(options.timeoutMs);
  return { exitCode: 0, stdout: JSON.stringify({ status: calls.length === 1 ? "in_progress" : "completed", conclusion: "success" }), stderr: "" };
 };
 const outcomes = await waitForPendingChecks([{ provider: "github", kind: "run", id: "123", source: "report" }], {
  cwd: "/repo", cancellation, now: () => now, spawn,
  scheduleTick: (ms, tick) => { expect(ms).toBe(15000); now += ms; queueMicrotask(tick); return () => {}; },
  setPendingChecks: (checks) => { rows.push(checks[0].outcome); },
 });
 expect(calls).toEqual([10000, 10000]);
 expect(rows).toEqual(["pending", "pending", "success"]);
 expect(outcomes[0].outcome).toBe("success");
});

test("cancelling during a scheduled tick stops waiting without another CLI call", async () => {
 const cancellation = new RunCancellation();
 let calls = 0;
 let timerCleared = false;
 const waiting = waitForPendingChecks([{ provider: "github", kind: "run", id: "123", source: "report" }], {
  cwd: "/repo", cancellation,
  spawn: async () => { calls++; return { exitCode: 0, stdout: '{"status":"in_progress"}', stderr: "" }; },
  scheduleTick: () => () => { timerCleared = true; },
 });
 await new Promise<void>((resolve) => setTimeout(resolve, 0));
 cancellation.cancel();
 await expect(waiting).rejects.toThrow("Orchestration cancelled");
 expect(calls).toBe(1);
 expect(timerCleared).toBe(true);
});

test("ceiling marks a still-running external check unverified instead of passing it", async () => {
 let now = 0;
 let calls = 0;
 const outcomes = await waitForPendingChecks([{ provider: "github", kind: "run", id: "123", source: "report" }], {
  cwd: "/repo", cancellation: new RunCancellation(), now: () => now,
  spawn: async () => { calls++; return { exitCode: 0, stdout: '{"status":"in_progress"}', stderr: "" }; },
  scheduleTick: (ms, tick) => { now += ms; queueMicrotask(tick); return () => {}; },
 });
 // A scoped environment override can be provided by core's own unit tests; this integration
 // test uses the clock seam and checks that the poller never claims success at its ceiling.
 expect(outcomes[0].outcome).toBe("unverified");
 expect(outcomes[0].reason).toBe("ceiling");
 expect(calls).toBeGreaterThan(0);
});

test("CI wait reports unavailable CLI as unverified without retrying", async () => {
 const outcomes = await waitForPendingChecks([{ provider: "gitlab", kind: "pipeline", id: "123", source: "report" }], {
  cwd: "/repo", cancellation: new RunCancellation(), spawn: async () => { throw new Error("ENOENT"); },
 });
 expect(outcomes[0].outcome).toBe("unverified");
 expect(outcomes[0].reason).toBe("cli_unavailable");
});

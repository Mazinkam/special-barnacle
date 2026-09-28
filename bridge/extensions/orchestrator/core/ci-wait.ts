/** One bounded, cancellable CI probe per orchestration tick. No timer or blocking wait lives here. */
import { execFile } from "node:child_process";
import type { PendingCheck } from "./pending-checks.ts";
import { CI_ID_RE } from "./wait-stall.ts";
import { redactCredentials } from "./text-safety.ts";

const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const CALL_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LOG_CHARS = 4096;

export interface CiWaitState { startedAt: number; nextPollAt: number }
export type CiPollOutcome = "pending" | "success" | "failure" | "unverified" | "cancelled";
export interface CiPollResult {
 outcome: CiPollOutcome;
 state?: CiWaitState;
 jobId?: string;
 logTail?: string;
 reason?: "invalid_check" | "ceiling" | "cli_unavailable" | "unknown_status";
}
export interface CiSpawnResult { exitCode: number; stdout: string; stderr: string }
export type CiPollSpawn = (command: string, args: string[], options: { cwd: string; timeoutMs: number; signal: AbortSignal }) => Promise<CiSpawnResult>;

/** execFile never starts a shell; maxBuffer and timeout also apply if the CLI itself hangs. */
export const spawnCiCommand: CiPollSpawn = (command, args, options) => new Promise((resolve, reject) => {
 execFile(command, args, {
  cwd: options.cwd, shell: false, timeout: options.timeoutMs, signal: options.signal,
  encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true,
 }, (error, stdout, stderr) => {
  if (error && ("code" in error && error.code === "ENOENT" || options.signal.aborted)) { reject(error); return; }
  resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
 });
});

/** Only a check whose entire shape agrees with its provider may reach a CLI. */
function validCheck(value: PendingCheck): boolean {
 return (value.provider === "gitlab" && value.kind === "pipeline" || value.provider === "github" && value.kind === "run")
  && typeof value.id === "string" && CI_ID_RE.test(value.id)
  && (value.mr === undefined || typeof value.mr === "string" && CI_ID_RE.test(value.mr))
  && (value.source === "report" || value.source === "killed_command");
}

function safeTail(text: string): string {
 // Strip terminal controls and common bearer credentials before returning output for a dispatch/report.
 return redactCredentials(text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""))
  .slice(-MAX_LOG_CHARS);
}

function parseStatus(check: PendingCheck, stdout: string): { outcome: "pending" | "success" | "failure" | "unverified"; jobId?: string } {
 if (check.provider === "github") {
  try {
   const data: unknown = JSON.parse(stdout);
   if (!data || typeof data !== "object") return { outcome: "unverified" };
   const run = data as { status?: unknown; conclusion?: unknown; jobs?: unknown };
   if (run.status !== "completed") return ["queued", "in_progress", "waiting", "pending", "requested"].includes(String(run.status)) ? { outcome: "pending" } : { outcome: "unverified" };
   if (run.conclusion === "success") return { outcome: "success" };
   if (!["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(String(run.conclusion))) return { outcome: "unverified" };
   const job = Array.isArray(run.jobs) ? run.jobs.find((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    return ["failure", "timed_out"].includes(String((item as { conclusion?: unknown }).conclusion));
   }) as { databaseId?: unknown } | undefined : undefined;
   const jobId = job && String(job.databaseId);
   return { outcome: "failure", ...(jobId && CI_ID_RE.test(jobId) ? { jobId } : {}) };
  } catch { return { outcome: "unverified" }; }
 }
 // glab ci get -p prints a human-readable Status field. Do not treat incidental
 // mentions of "failed" in job logs/metadata as the pipeline's status.
 const status = /^\s*status\s*:\s*(\w+)\s*$/im.exec(stdout)?.[1]?.toLowerCase();
 if (["success", "passed"].includes(status ?? "")) return { outcome: "success" };
 if (["pending", "running", "created", "waiting_for_resource", "preparing", "scheduled", "manual"].includes(status ?? "")) return { outcome: "pending" };
 if (["failed", "canceled", "cancelled", "skipped"].includes(status ?? "")) {
  const jobId = /(?:^|\n)\s*(?:failed\s+job|job\s+id)\s*[:#]\s*([0-9]{1,12})\b/im.exec(stdout)?.[1];
  return { outcome: "failure", ...(jobId ? { jobId } : {}) };
 }
 return { outcome: "unverified" };
}

export interface CiPollOptions {
 cwd: string;
 signal?: AbortSignal;
 spawn?: CiPollSpawn;
 now?: () => number;
 maxWaitMs?: number;
 pollIntervalMs?: number;
}

/** Caller retains `state` and invokes this at its normal session ticks; no sleeps or concurrent polls. */
export async function pollCiCheck(check: PendingCheck, state: CiWaitState, options: CiPollOptions): Promise<CiPollResult> {
 if (!validCheck(check)) return { outcome: "unverified", reason: "invalid_check" };
 if (options.signal?.aborted) return { outcome: "cancelled" };
 const now = (options.now ?? Date.now)();
 const rawCeiling = options.maxWaitMs ?? Number(process.env.HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS ?? DEFAULT_MAX_WAIT_MS);
 const ceiling = Number.isSafeInteger(rawCeiling) && rawCeiling >= 0 ? rawCeiling : DEFAULT_MAX_WAIT_MS;
 if (!Number.isFinite(now) || !Number.isFinite(state.startedAt) || !Number.isFinite(state.nextPollAt) || now - state.startedAt >= ceiling) {
  return { outcome: "unverified", reason: "ceiling" };
 }
 if (now < state.nextPollAt) return { outcome: "pending", state };
 const remaining = ceiling - (now - state.startedAt);
 const timeoutMs = Math.min(CALL_TIMEOUT_MS, remaining);
 const controller = new AbortController();
 const onAbort = () => controller.abort();
 options.signal?.addEventListener("abort", onAbort, { once: true });
 if (options.signal?.aborted) controller.abort();
 const spawn = options.spawn ?? spawnCiCommand;
 const execute = (command: string, args: string[]) => spawn(command, args, { cwd: options.cwd, timeoutMs, signal: controller.signal });
 try {
  if (controller.signal.aborted) return { outcome: "cancelled" };
  const command = check.provider === "gitlab" ? "glab" : "gh";
  const args = check.provider === "gitlab" ? ["ci", "get", "-p", check.id] : ["run", "view", check.id, "--json", "status,conclusion,jobs"];
  const response = await execute(command, args);
  if (controller.signal.aborted) return { outcome: "cancelled" };
  if (response.exitCode !== 0) return { outcome: "unverified", reason: "cli_unavailable" };
  const parsed = parseStatus(check, response.stdout);
  if (parsed.outcome === "pending") {
   const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
   return { outcome: "pending", state: { startedAt: state.startedAt, nextPollAt: now + (Number.isSafeInteger(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_MS) } };
  }
  if (parsed.outcome !== "failure") return parsed.outcome === "success" ? { outcome: "success" } : { outcome: "unverified", reason: "unknown_status" };
  let logTail: string | undefined;
  if (parsed.jobId && !controller.signal.aborted) {
   try {
    const logArgs = check.provider === "gitlab" ? ["ci", "trace", parsed.jobId] : ["run", "view", check.id, "--job", parsed.jobId, "--log"];
    const log = await execute(command, logArgs);
    if (log.exitCode === 0) logTail = safeTail(log.stdout);
   } catch { /* Failure status still stands when logs are unavailable. */ }
  }
  if (controller.signal.aborted) return { outcome: "cancelled" };
  return { outcome: "failure", ...(parsed.jobId ? { jobId: parsed.jobId } : {}), ...(logTail ? { logTail } : {}) };
 } catch {
  return controller.signal.aborted ? { outcome: "cancelled" } : { outcome: "unverified", reason: "cli_unavailable" };
 } finally {
  options.signal?.removeEventListener("abort", onAbort);
 }
}

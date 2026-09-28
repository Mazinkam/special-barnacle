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

interface RepoIdentity { host: string; path: string; url: string }

/** The caller supplies the canonical HTTPS remote, never a path or a CLI flag. */
function parseRepo(value: unknown): RepoIdentity | undefined {
 if (typeof value !== "string") return undefined;
 try {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname.endsWith("/") || url.pathname.endsWith(".git")) return undefined;
  const path = url.pathname.slice(1);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) || path.split("/").includes("..") || path.split("/").includes(".")) return undefined;
  return { host: url.hostname, path, url: `https://${url.hostname}/${path}` };
 } catch { return undefined; }
}

function parseStatus(check: PendingCheck, stdout: string, expectedSha: string, repo: RepoIdentity): "pending" | "success" | "failure" | "unverified" {
 try {
  const data: unknown = JSON.parse(stdout);
  if (!data || typeof data !== "object" || Array.isArray(data)) return "unverified";
  const run = data as Record<string, unknown>;
  const id = run.id;
  if ((typeof id !== "number" || !Number.isSafeInteger(id) || String(id) !== check.id)) return "unverified";
  if (check.provider === "github") {
   const repository = run.repository;
   if (run.head_sha !== expectedSha || !repository || typeof repository !== "object" || (repository as Record<string, unknown>).full_name !== repo.path || run.html_url !== `${repo.url}/actions/runs/${check.id}`) return "unverified";
   if (run.status === "completed") return run.conclusion === "success" ? "success" : ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(String(run.conclusion)) ? "failure" : "unverified";
   return ["queued", "in_progress", "waiting", "pending", "requested"].includes(String(run.status)) ? "pending" : "unverified";
  }
  if (run.sha !== expectedSha || run.web_url !== `${repo.url}/-/pipelines/${check.id}`) return "unverified";
  if (run.status === "success") return "success";
  if (["pending", "running", "created", "waiting_for_resource", "preparing", "scheduled", "manual"].includes(String(run.status))) return "pending";
  return ["failed", "canceled", "cancelled", "skipped"].includes(String(run.status)) ? "failure" : "unverified";
 } catch { return "unverified"; }
}

export interface CiPollOptions {
 cwd: string;
 /** Current candidate commit and canonical HTTPS repository URL, resolved by the caller. */
 expectedSha?: string;
 expectedRepo?: string;
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
 const repo = parseRepo(options.expectedRepo);
 if (!repo || typeof options.expectedSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.expectedSha)) return { outcome: "unverified", reason: "invalid_check" };
 const now = (options.now ?? Date.now)();
 const rawCeiling = options.maxWaitMs ?? Number(process.env.HUMAIN_ORCHESTRATOR_CI_WAIT_MAX_MS ?? DEFAULT_MAX_WAIT_MS);
 const ceiling = Number.isSafeInteger(rawCeiling) && rawCeiling >= 0 ? rawCeiling : DEFAULT_MAX_WAIT_MS;
 if (!Number.isFinite(now) || !Number.isFinite(state.startedAt) || !Number.isFinite(state.nextPollAt) || now - state.startedAt >= ceiling) {
  return { outcome: "unverified", reason: "ceiling" };
 }
 if (now < state.nextPollAt) return { outcome: "pending", state };
 const remaining = ceiling - (now - state.startedAt);
 // Both CLI calls share the same deadline, including time spent in the first call.
 const deadline = now + remaining;
 const controller = new AbortController();
 const onAbort = () => controller.abort();
 options.signal?.addEventListener("abort", onAbort, { once: true });
 if (options.signal?.aborted) controller.abort();
 const spawn = options.spawn ?? spawnCiCommand;
 const execute = (command: string, args: string[]) => {
  const timeLeft = deadline - (options.now ?? Date.now)();
  if (!Number.isFinite(timeLeft) || timeLeft <= 0) return undefined;
  return spawn(command, args, { cwd: options.cwd, timeoutMs: Math.min(CALL_TIMEOUT_MS, timeLeft), signal: controller.signal });
 };
 try {
  if (controller.signal.aborted) return { outcome: "cancelled" };
  const command = check.provider === "gitlab" ? "glab" : "gh";
  // API endpoints are scoped to the expected repository; CLI plaintext is not an identity proof.
  const args = check.provider === "gitlab"
   ? ["api", "--hostname", repo.host, `projects/${encodeURIComponent(repo.path)}/pipelines/${check.id}`]
   : ["api", "--hostname", repo.host, `repos/${repo.path}/actions/runs/${check.id}`];
  const request = execute(command, args);
  if (!request) return { outcome: "unverified", reason: "ceiling" };
  const response = await request;
  if (controller.signal.aborted) return { outcome: "cancelled" };
  if ((options.now ?? Date.now)() >= deadline) return { outcome: "unverified", reason: "ceiling" };
  if (response.exitCode !== 0) return { outcome: "unverified", reason: "cli_unavailable" };
  const parsed = parseStatus(check, response.stdout, options.expectedSha, repo);
  if (parsed === "pending") {
   const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
   return { outcome: "pending", state: { startedAt: state.startedAt, nextPollAt: now + (Number.isSafeInteger(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_MS) } };
  }
  if (parsed !== "failure") return parsed === "success" ? { outcome: "success" } : { outcome: "unverified", reason: "unknown_status" };
  let logTail: string | undefined;
  if (check.provider === "github" && repo.host === "github.com" && !controller.signal.aborted) {
   try {
    const request = execute(command, ["run", "view", check.id, "-R", repo.path, "--log-failed"]);
    if (!request) return { outcome: "unverified", reason: "ceiling" };
    const log = await request;
    if (log.exitCode === 0) logTail = safeTail(log.stdout);
   } catch { /* Verified failure stands even when logs are unavailable. */ }
  }
  if (controller.signal.aborted) return { outcome: "cancelled" };
  if ((options.now ?? Date.now)() >= deadline) return { outcome: "unverified", reason: "ceiling" };
  return { outcome: "failure", ...(logTail ? { logTail } : {}) };
 } catch {
  return controller.signal.aborted ? { outcome: "cancelled" } : { outcome: "unverified", reason: "cli_unavailable" };
 } finally {
  options.signal?.removeEventListener("abort", onAbort);
 }
}

/**
 * Automatic session-usage ingestion (B4.6): after every settled agent turn
 * and on shutdown, run `orchestrator.cli ingest <sessionFile> --granularity
 * session`. Rows are deltas against what is already recorded, so this is
 * safe to run as often as we like and alongside the launchd sweep
 * (install.sh).
 *
 * hooks/* must not import index.ts. `installSessionIngest`'s `runModule` dep
 * is index.ts's one Python spawner (`orchestratorPythonCli().run()`
 * wrapper); `stateRoot` is config.ts's resolved (but not yet `~`-expanded)
 * state root.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@humain/terminal";

import contract from "../contract.json";
import { ingestArgs, SessionIngestScheduler } from "../ingest.ts";

// Match absolute paths under common user homes so the bounded Status Contract
// `error` field never leaks filesystem locations. Mirrors the redaction the
// Python CLI applies when writing `ingest_status.json`. Deliberately not the same
// regex as the Python side (`orchestrator/contract.json`'s `redaction_regex._todo`
// explains why); this side reads its own key from the shared contract.
const PATH_RE = new RegExp(contract.redaction_regex.ts, "g");
export function redactPaths(text: string): string {
	return text.replace(PATH_RE, "<path>");
}

/**
 * Best-effort, atomic write of `ingest_status.json`'s error branch when a
 * session-ingest attempt fails, so `orchestrator-status`/the dashboard can
 * show it without waiting for the next successful sweep.
 */
export function recordHookFailure(stateRoot: string, detail: string): void {
	const root = stateRoot.replace(/^~/, homedir());
	const statusPath = join(root, contract.ingest_status_file);
	const temporaryPath = `${statusPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		let previous: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(statusPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				previous = parsed as Record<string, unknown>;
			}
		} catch {
			// A missing or malformed prior status must not prevent reporting failure.
		}
		const safeDetail = redactPaths(String(detail))
			.replace(/[\u0000-\u001f\u007f]+/g, " ")
			.trim()
			.slice(0, 240);
		const emptyExitDetail = /exit \d+:\s*(.*)$/.exec(safeDetail);
		const previousError = typeof previous.error === "string"
			? redactPaths(previous.error)
					.replace(/[\u0000-\u001f\u007f]+/g, " ")
					.trim()
					.slice(0, 240)
			: "";
		const error = emptyExitDetail && !emptyExitDetail[1].trim()
			? previousError || safeDetail || "session ingest failed"
			: safeDetail || previousError || "session ingest failed";
		const failureCount = previous.failure_count;
		const status = {
			...previous,
			version: 1,
			last_attempt_at: new Date().toISOString(),
			last_success_at: previous.last_success_at ?? null,
			status: contract.ingest_status.status_values.error,
			files_scanned: typeof previous.files_scanned === "number" ? previous.files_scanned : 1,
			emitted: typeof previous.emitted === "number" ? previous.emitted : 0,
			failure_count: typeof failureCount === "number" && Number.isFinite(failureCount) ? failureCount + 1 : 1,
			error,
			sweep_interval_seconds:
				typeof previous.sweep_interval_seconds === "number"
					? previous.sweep_interval_seconds
					: contract.ingest_status.default_sweep_interval_seconds,
		};
		// Written status is exactly contract.json's ingest_status.fields (B4.7): same field set as
		// Python's make_ingest_status, so `...previous` cannot leak stale/unknown keys into the file.
		const orderedStatus = Object.fromEntries(
			contract.ingest_status.fields.map((field) => [field, (status as Record<string, unknown>)[field] ?? null]),
		);
		mkdirSync(root, { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(orderedStatus, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, statusPath);
	} catch {
		// Status reporting is best-effort and must never interrupt a terminal session.
	} finally {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Ignore temporary-file cleanup failures.
		}
	}
}

/** Register the settled fast path and an awaited, bounded shutdown flush. */
export function registerSessionIngestHooks(
	host: Pick<ExtensionAPI, "on">,
	scheduler: Pick<SessionIngestScheduler, "schedule" | "flush">,
	onError: (message: string) => void = () => {},
): void {
	host.on("agent_settled", async (_event, ctx) => {
		scheduler.schedule(ctx.sessionManager.getSessionFile());
	});
	host.on("session_shutdown", async (_event, ctx) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const done = await Promise.race([
				scheduler.flush(ctx.sessionManager.getSessionFile()).then(() => true),
				new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
			]);
			if (!done) onError("shutdown ingestion timed out; retry the session import to refresh durable usage");
		} finally { if (timer !== undefined) clearTimeout(timer); }
	});
}

/** The one Python spawner index.ts's `installSessionIngest` runs `orchestrator.cli ingest` through. */
export interface RunModule {
	(module: string, args: string[], stdin?: string): Promise<{ exitCode: number; stderr: string }>;
}

export function installSessionIngest(pi: ExtensionAPI, stateRoot: string, runModule: RunModule): void {
	const expandedStateRoot = stateRoot.replace(/^~/, homedir());
	const logPath = join(expandedStateRoot, "ingest-hook.log");
	const logError = (message: string) => {
		try {
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
		} catch {
			// Telemetry must never break the session.
		}
	};
	const onError = (message: string) => {
		logError(message);
		recordHookFailure(expandedStateRoot, message);
	};
	const scheduler = new SessionIngestScheduler({
		onError,
		run: async (sessionFile) => {
			const res = await runModule("orchestrator.cli", ingestArgs(sessionFile));
			if (res.exitCode === 0) return { ok: true };
			return { ok: false, detail: `exit ${res.exitCode}: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}` };
		},
	});
	registerSessionIngestHooks(pi, scheduler, onError);
}

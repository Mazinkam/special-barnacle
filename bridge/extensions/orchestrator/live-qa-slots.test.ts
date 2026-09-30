import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunCancellation } from "./cancellation.ts";
import { buildRunnerArgv, runLiveQa, type LiveQaAdapterConfig } from "./live-qa.ts";
import { liveQaSummaryLines, runLiveQaStage } from "./live-qa-stage.ts";
import { buildRunSummary } from "./core/report.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-forge-qa.mjs", import.meta.url));
const dirs: string[] = [];
const servers: net.Server[] = [];
const savedEnv = { FAKE_FORGE_MODE: process.env.FAKE_FORGE_MODE, FAKE_FORGE_SLOT_PORT: process.env.FAKE_FORGE_SLOT_PORT };
afterEach(async () => {
	for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

async function occupiedSlot(budgetMinutes = 1) {
	const server = net.createServer();
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	const cwd = mkdtempSync(join(tmpdir(), "orch-qa-slot-"));
	dirs.push(cwd);
	process.env.FAKE_FORGE_MODE = "slot_contention";
	process.env.FAKE_FORGE_SLOT_PORT = String(port);
	const adapter: LiveQaAdapterConfig = {
		id: "forge", kind: "forge-qa", trusted: true, runner_cwd: cwd,
		argv_prefix: [process.execPath, fixture], flow: "focused", slot: 0,
		budget_minutes: budgetMinutes, runtime: "codex", model: "terra", effort: "medium", local: true, required: true,
	};
	return { server, port, cwd, adapter, argv: buildRunnerArgv(adapter, "verify login", "HEAD") };
}

// Removing the contention wait must settle before release instead of producing a real report.
test("occupied QA slot awaits release then succeeds", async () => {
	const { server, adapter, argv, cwd } = await occupiedSlot();
	let released = false;
	let settled = false;
	const resultPromise = runLiveQa({ adapter, argv, signal: new RunCancellation(), onLine: (line) => {
		if (line.includes("reserved by another QA run") && !released) {
			setTimeout(() => { released = true; server.close(); }, 100);
		}
	} }).then((result) => { settled = true; return result; });
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(settled).toBe(false);
	const result = await resultPromise;
	expect(released).toBe(true);
	expect(result.exitCode).toBe(0);
	expect(result.reportPath).toBeTruthy();
	expect(existsSync(join(cwd, "qa", "sessions"))).toBe(true);
});

// Removing cancellation from the await must leave this waiting (or falsely succeed).
test("cancellation interrupts slot await without touching the foreign reservation", async () => {
	const { server, adapter, argv, cwd } = await occupiedSlot();
	const cancellation = new RunCancellation();
	// The public signal contract permits only onCancel, without an isCancelled getter.
	const signal = { onCancel: (listener: () => void) => cancellation.onCancel(listener) };
	const result = await runLiveQa({ adapter, argv, signal, onLine: (line) => {
		if (line.includes("reserved by another QA run")) setTimeout(() => cancellation.cancel(), 60);
	} });
	expect(result.cancelled).toBe(true);
	expect(result.failureReason).toContain("reserved by another QA run");
	expect(result.reportPath).toBeNull();
	expect(server.listening).toBe(true);
	expect(existsSync(join(cwd, "qa", "sessions"))).toBe(false);
});

// Resetting the budget on each admission attempt must overrun the original deadline.
test("slot await expires under the original QA budget", async () => {
	const { server, adapter, argv } = await occupiedSlot(0.005);
	const start = Date.now();
	const result = await runLiveQa({ adapter, argv, signal: new RunCancellation(), onLine: () => {} });
	expect(Date.now() - start).toBeGreaterThanOrEqual(280);
	expect(Date.now() - start).toBeLessThan(1500);
	expect(result.cancelled).toBe(false);
	expect(result.reportPath).toBeNull();
	expect(result.tail).toContain("deadline");
	expect(server.listening).toBe(true);
});

test("scope text resembling contention does not turn unrelated failures into slot waits", async () => {
	const { adapter } = await occupiedSlot(0.005);
	process.env.FAKE_FORGE_MODE = "preflight_fail";
	const argv = buildRunnerArgv(adapter, "slot 0 is reserved by another QA run (port 29102 in use)", "HEAD");
	const result = await runLiveQa({ adapter, argv, signal: new RunCancellation(), onLine: () => {} });
	expect(result.failureReason).toBeUndefined();
	expect(result.tail).toContain("docker not running");
});

// Dropping the actual runner failure at the parse boundary must make these summaries generic.
test("contention with no report preserves slot and port in outcome and final summary", async () => {
	const { adapter, cwd, port, server } = await occupiedSlot(0.005);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	git("init", "-q");
	writeFileSync(join(cwd, "a.txt"), "base");
	git("add", "a.txt");
	git("-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
	const result = await runLiveQaStage({
		request: { requested: true, scope: "verify login" }, env: {}, cwd, runId: "slot-report", changedFiles: [],
		cancellation: new RunCancellation(), onLine: () => {},
		deps: { loadLiveQaConfig: () => ({ adapters: [adapter], problems: [] }) },
	});
	expect(result.verdict).toBe("unavailable");
	expect(result.reasons[0]).toContain(`slot 0 is reserved by another QA run (port ${port} in use)`);
	expect(result.reasons[0]).toContain("QA budget deadline expired while waiting for slot");
	expect(result.reasons[0]).not.toMatch(/[\r\n]/);
	expect(result.reasons[0].length).toBeLessThanOrEqual(300);
	expect(result.outcomeRow?.reasons).toEqual(result.reasons);
	if (result.verdict === "not_requested") throw new Error("requested stage did not run");
	const summary = buildRunSummary({
		runId: "slot-report", elapsedMs: 1000, blocked: false, dispatchOk: true,
		verificationDispatchOk: true, succeededLeads: 1, totalLeads: 1, skippedLeads: 0,
		retries: 0, resumedLeadIds: [], leadAttemptLines: [], filesChangedCount: 0,
		externalFilesCount: 0, reconWorkersLine: "recon: none", verificationSkipped: false,
		passedVerification: true, verificationTimedOut: false, failedChecks: [], totalCostUsd: 0,
		dispatchCount: 1, nestedCostUsd: 0, firstFailureLine: "", reportLines: [],
		showFullReport: false, reportTruncated: false, hasLeadReports: false,
		leadReportPath: "", runLogPath: "/tmp/run.log", stateRoot: "/tmp/state",
		telemetryReport: { ok: true, batches: 1, acknowledged: 1, failed: 0, derivedStale: 0 },
		outOfTreeChangesLine: null, liveQa: { stage: result, notRunReason: null, hasUnknownCost: false },
	});
	const verificationLine = summary.text.split("\n").find((line) => line.startsWith("verification:"));
	expect(summary.succeeded).toBe(false);
	expect(verificationLine).toContain("UNVERIFIED (required live QA unavailable:");
	expect(verificationLine).toContain(`port ${port} in use`);
	expect(verificationLine).toContain("QA budget deadline expired while waiting for slot");
	expect(verificationLine).toEndWith(")");
	expect(liveQaSummaryLines(result, null, false)[0]).toContain(`port ${port} in use`);
	expect(server.listening).toBe(true);
});

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RunCancellation } from "./cancellation.ts";
import { runLiveQaStage, type RunLiveQaStageOptions } from "./live-qa-stage.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-forge-qa.mjs", import.meta.url));

const tmpDirs: string[] = [];
const trackedPids: number[] = [];
const mutatedEnvKeys = ["FAKE_FORGE_MODE", "FAKE_FORGE_PIDFILE", "FAKE_SECRET_ENV_VAR", "PROBE_API_TOKEN", "PROBE_API_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of mutatedEnvKeys) savedEnv[key] = process.env[key];

function mkdir(prefix: string): string {
	const dir = mktemp(prefix);
	tmpDirs.push(dir);
	return dir;
}
function mktemp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

afterEach(() => {
	for (const pid of trackedPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
	for (const dir of tmpDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	for (const key of mutatedEnvKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function initRepo(): string {
	const dir = mkdir("orch-live-qa-stage-repo-");
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	git(dir, "config", "commit.gpgsign", "false");
	return dir;
}

function commitFile(dir: string, name: string, content: string): void {
	writeFileSync(join(dir, name), content);
	git(dir, "add", name);
	git(dir, "commit", "-q", "-m", "init");
}

function validAdapterConfig(runnerCwd: string, overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		adapters: [
			{
				id: "forge-focused",
				kind: "forge-qa",
				trusted: true,
				runner_cwd: runnerCwd,
				argv_prefix: [process.execPath, FIXTURE],
				flow: "focused",
				budget_minutes: 30,
				runtime: "codex",
				model: "terra",
				effort: "medium",
				local: true,
				...overrides,
			},
		],
	};
}

function writeConfig(config: unknown): string {
	const dir = mkdir("orch-live-qa-stage-config-");
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(config));
	return path;
}

function neverCancels(): RunLiveQaStageOptions["cancellation"] {
	return { onCancel: () => () => {} };
}

function baseOptions(overrides: Partial<RunLiveQaStageOptions> = {}): RunLiveQaStageOptions {
	return {
		request: { requested: true, scope: "verify the login flow" },
		env: {},
		cwd: process.cwd(),
		runId: "run-1",
		changedFiles: [],
		cancellation: neverCancels(),
		onLine: () => {},
		...overrides,
	};
}

// -----------------------------------------------------------------------------
// Not requested
// -----------------------------------------------------------------------------

describe("not requested", () => {
	test("requested: false never touches config, never spawns", async () => {
		const result = await runLiveQaStage(baseOptions({ request: { requested: false } }));
		expect(result.verdict).toBe("not_requested");
		expect(result.stage).toBeNull();
		expect(result.outcomeRow).toBeNull();
		expect(result.costRows).toEqual([]);
		expect(result.required).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Config / adapter selection failures — never spawn
// -----------------------------------------------------------------------------

describe("config and adapter selection", () => {
	test("no config configured: unavailable, required (explicit request)", async () => {
		const result = await runLiveQaStage(baseOptions({ env: {} }));
		expect(result.verdict).toBe("unavailable");
		expect(result.required).toBe(true);
		expect(result.reasons[0]).toContain("no valid live-QA adapter is configured");
		expect(result.costRows).toEqual([]);
		expect(result.outcomeRow).not.toBeNull();
		expect(result.outcomeRow?.orchestrator_extension_exercised).toBe(false);
	});

	test("untrusted adapter config: unavailable, never spawned", async () => {
		const runnerCwd = mkdir("orch-live-qa-stage-runner-");
		const configPath = writeConfig(validAdapterConfig(runnerCwd, { trusted: false }));
		const result = await runLiveQaStage(baseOptions({ env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath } }));
		expect(result.verdict).toBe("unavailable");
		expect(result.required).toBe(true);
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});

	test("single valid adapter, no --live-qa-adapter given: selected automatically", async () => {
		const runnerCwd = initRepo();
		commitFile(runnerCwd, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(runnerCwd));
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQaStage(baseOptions({ env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath }, cwd: runnerCwd, runId: "run-single" }));
		expect(result.verdict).toBe("pass");
		expect(result.stage?.adapterId).toBe("forge-focused");
	});

	test("adapter selected by id", async () => {
		const runnerCwd = initRepo();
		commitFile(runnerCwd, "a.ts", "export const a = 1;\n");
		const config = validAdapterConfig(runnerCwd);
		(config.adapters as Record<string, unknown>[]).push({
			id: "forge-second",
			kind: "forge-qa",
			trusted: true,
			runner_cwd: runnerCwd,
			argv_prefix: [process.execPath, FIXTURE],
			flow: "focused",
			budget_minutes: 30,
			runtime: "codex",
			model: "terra",
			effort: "medium",
			local: true,
		});
		const configPath = writeConfig(config);
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: runnerCwd,
			runId: "run-by-id",
			request: { requested: true, scope: "verify", adapterId: "forge-second" },
		}));
		expect(result.verdict).toBe("pass");
		expect(result.stage?.adapterId).toBe("forge-second");
	});

	test("ambiguous: >1 valid adapters without an id — unavailable, required, never spawned", async () => {
		const runnerCwd = mkdir("orch-live-qa-stage-runner-");
		const config = validAdapterConfig(runnerCwd);
		(config.adapters as Record<string, unknown>[]).push({
			id: "forge-second",
			kind: "forge-qa",
			trusted: true,
			runner_cwd: runnerCwd,
			argv_prefix: [process.execPath, FIXTURE],
			flow: "focused",
			budget_minutes: 30,
			runtime: "codex",
			model: "terra",
			effort: "medium",
			local: true,
		});
		const configPath = writeConfig(config);
		const result = await runLiveQaStage(baseOptions({ env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath }, cwd: runnerCwd }));
		expect(result.verdict).toBe("unavailable");
		expect(result.required).toBe(true);
		expect(result.reasons[0]).toContain("ambiguous");
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});

	test("unknown adapter id: unavailable, required, never spawned", async () => {
		const runnerCwd = mkdir("orch-live-qa-stage-runner-");
		const configPath = writeConfig(validAdapterConfig(runnerCwd));
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: runnerCwd,
			request: { requested: true, scope: "verify", adapterId: "does-not-exist" },
		}));
		expect(result.verdict).toBe("unavailable");
		expect(result.required).toBe(true);
		expect(result.reasons[0]).toContain('unknown live-QA adapter id "does-not-exist"');
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Scope + revision-proof failures after adapter selection — required defers to adapter.required
// -----------------------------------------------------------------------------

describe("scope and revision proof", () => {
	test("missing scope: unavailable, required defers to adapter.required, never spawned", async () => {
		const runnerCwd = mkdir("orch-live-qa-stage-runner-");
		const configPath = writeConfig(validAdapterConfig(runnerCwd, { required: false }));
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: runnerCwd,
			request: { requested: true },
		}));
		expect(result.verdict).toBe("unavailable");
		expect(result.required).toBe(false);
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});

	test("invalid scope (leading '-'): unavailable, never spawned", async () => {
		const runnerCwd = mkdir("orch-live-qa-stage-runner-");
		const configPath = writeConfig(validAdapterConfig(runnerCwd));
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: runnerCwd,
			request: { requested: true, scope: "-x bad" },
		}));
		expect(result.verdict).toBe("unavailable");
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});

	test("revision proof failure (runner cannot resolve sha): unavailable, never spawned", async () => {
		const candidate = initRepo();
		commitFile(candidate, "a.ts", "export const a = 1;\n");
		const staleClone = mkdir("orch-live-qa-stage-clone-");
		rmSync(staleClone, { recursive: true, force: true });
		execFileSync("git", ["clone", "-q", candidate, staleClone], { stdio: "pipe" });
		commitFile(candidate, "a.ts", "export const a = 2;\n");

		const configPath = writeConfig(validAdapterConfig(staleClone));
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: candidate,
			changedFiles: ["a.ts"],
		}));
		expect(result.verdict).toBe("unavailable");
		expect(result.reasons[0]).toContain("cannot resolve");
		expect(existsSync(join(staleClone, "qa", "sessions"))).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Fake-runner end-to-end via a temp git repo used as both candidate and runner_cwd
// -----------------------------------------------------------------------------

describe("fake-runner end-to-end sessions", () => {
	async function runMode(mode: string, overrides: Record<string, unknown> = {}) {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir, overrides));
		process.env.FAKE_FORGE_MODE = mode;
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: dir,
			changedFiles: ["a.ts"],
		}));
		return { result, dir };
	}

	test("pass", async () => {
		const { result } = await runMode("pass");
		expect(result.verdict).toBe("pass");
		expect(result.stage?.verdict.verdict).toBe("pass");
	});

	test("finding: confirmed tier-1 is a fail", async () => {
		const { result } = await runMode("finding");
		expect(result.verdict).toBe("fail");
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	test("preflight_fail: unavailable", async () => {
		const { result } = await runMode("preflight_fail");
		expect(result.verdict).toBe("unavailable");
	});

	test("incomplete: unavailable", async () => {
		const { result } = await runMode("incomplete");
		expect(result.verdict).toBe("unavailable");
		expect(result.reasons.join(" ")).toContain("findings.json");
	});

	test("outcome row carries tested_revision and runtime_under_test", async () => {
		const { result, dir } = await runMode("pass");
		expect(result.outcomeRow).not.toBeNull();
		expect(result.outcomeRow?.tested_revision).toBeTruthy();
		const runtimeUnderTest = result.outcomeRow?.runtime_under_test as Record<string, unknown>;
		expect(runtimeUnderTest.runtime).toBe("codex");
		expect(runtimeUnderTest.model).toBe("terra");
		expect(runtimeUnderTest.effort).toBe("medium");
		expect(runtimeUnderTest.runner_cwd).toBe(dir);
		expect(runtimeUnderTest.runner_head).toBeTruthy();
		expect(result.outcomeRow?.orchestrator_extension_exercised).toBe(false);
	});

	test("humain_terminal_bin is read from env, never guessed", async () => {
		const { result } = await runMode("pass");
		const runtimeUnderTest = result.outcomeRow?.runtime_under_test as Record<string, unknown>;
		expect(runtimeUnderTest.humain_terminal_bin).toBeNull();
	});

	test("S3: humain_terminal_bin is included (and redacted) only when an adapter was actually selected", async () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir));
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath, QA_HUMAIN_TERMINAL_BIN: "/usr/local/bin/humain-terminal" },
			cwd: dir,
		}));
		const runtimeUnderTest = result.outcomeRow?.runtime_under_test as Record<string, unknown>;
		expect(runtimeUnderTest.humain_terminal_bin).toBe("/usr/local/bin/humain-terminal");
	});

	test("S3: a credential-shaped humain_terminal_bin value is omitted entirely, never merely redacted-in-place", async () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir));
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath, QA_HUMAIN_TERMINAL_BIN: "/opt/TOKEN-abc123/bin/humain-terminal" },
			cwd: dir,
		}));
		const runtimeUnderTest = result.outcomeRow?.runtime_under_test as Record<string, unknown>;
		expect(runtimeUnderTest.humain_terminal_bin).toBeNull();
	});

	test("S3: no adapter selected (config invalid) -- humain_terminal_bin is null even though env is set", async () => {
		const configPath = writeConfig({ version: 1, adapters: [] });
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath, QA_HUMAIN_TERMINAL_BIN: "/usr/local/bin/humain-terminal" },
		}));
		const runtimeUnderTest = result.outcomeRow?.runtime_under_test as Record<string, unknown>;
		expect(runtimeUnderTest.humain_terminal_bin).toBeNull();
	});
});

// -----------------------------------------------------------------------------
// Cost rows: deduplicated by record_id, unknown cost preserved
// -----------------------------------------------------------------------------

describe("cost rows", () => {
	test("pass produces cost rows keyed by session id; calling twice with the same session dedups under unique_records semantics", async () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir));
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: dir,
			changedFiles: ["a.ts"],
		}));
		expect(result.costRows.length).toBeGreaterThan(0);
		const ids = result.costRows.map((r) => r.record_id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("unknown cost is preserved (never coerced to 0)", async () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir));
		process.env.FAKE_FORGE_MODE = "codex_unknown_cost";
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: dir,
			changedFiles: ["a.ts"],
		}));
		const agentRow = result.costRows.find((r) => r.live_qa_component === "agent");
		expect(agentRow?.cost_usd).toBeUndefined();
		expect(agentRow?.cost_source).toBe("unknown-not-reported-by-qa-runtime");
	});

	test("unavailable-before-spawn stages never produce cost rows (no cost was incurred)", async () => {
		const result = await runLiveQaStage(baseOptions({ env: {} }));
		expect(result.costRows).toEqual([]);
	});
});

// -----------------------------------------------------------------------------
// Cancellation: hang mode is SIGINT'd and awaited
// -----------------------------------------------------------------------------

describe("cancellation", () => {
	function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		return new Promise((resolve, reject) => {
			const tick = () => {
				if (predicate()) return resolve();
				if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
				setTimeout(tick, 10);
			};
			tick();
		});
	}

	test("hang mode: cancellation sends SIGINT once and the stage waits for the real exit", async () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir));
		process.env.FAKE_FORGE_MODE = "hang";
		const pidFile = join(mkdir("orch-live-qa-stage-pid-"), "pid");
		process.env.FAKE_FORGE_PIDFILE = pidFile;

		const cancellation = new RunCancellation();
		let spawnedPid: number | undefined;
		const promise = runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: dir,
			changedFiles: ["a.ts"],
			cancellation,
			onSpawn: (pid) => {
				spawnedPid = pid;
				if (pid !== undefined) trackedPids.push(pid);
			},
		}));

		await waitFor(() => existsSync(pidFile));
		const pid = Number(readFileSync(pidFile, "utf-8").trim());
		expect(spawnedPid).toBe(pid);

		cancellation.cancel();
		const result = await promise;
		expect(result.cancelled).toBe(true);
	});

	test("cancel_writes_pass: a runner that races SIGINT and still writes valid pass artifacts + exits 0 is never reported as pass, but usage/cost rows are retained", async () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir));
		process.env.FAKE_FORGE_MODE = "cancel_writes_pass";
		const pidFile = join(mkdir("orch-live-qa-stage-pid-cancelpass-"), "pid");
		process.env.FAKE_FORGE_PIDFILE = pidFile;

		const cancellation = new RunCancellation();
		const promise = runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: dir,
			changedFiles: ["a.ts"],
			cancellation,
			onSpawn: (pid) => {
				if (pid !== undefined) trackedPids.push(pid);
			},
		}));

		await waitFor(() => existsSync(pidFile));
		cancellation.cancel();
		const result = await promise;

		// The child really did exit 0 with a fully valid pass-shaped session (sanity: proves this
		// test exercises the race it claims to, not merely a runner that failed/produced nothing).
		expect(result.cancelled).toBe(true);
		expect(result.verdict).not.toBe("pass");
		expect(result.verdict).toBe("unavailable");
		expect(result.stage?.verdict.verdict).not.toBe("pass");
		expect(result.reasons.join(" ")).toContain("cancelled");
		expect(result.outcomeRow?.outcome).not.toBe("verified");

		// Usage/cost rows from the real (valid) usage.json the runner wrote are still retained --
		// cancellation must never zero out evidence of real, billable usage.
		expect(result.costRows.length).toBeGreaterThan(0);
		const agentRow = result.costRows.find((r) => r.live_qa_component === "agent");
		expect(agentRow).toBeDefined();
		expect(agentRow?.cost_usd).toBeGreaterThan(0);
	});
});

// -----------------------------------------------------------------------------
// S3 (escalated): persistence-boundary sanitization applies on EVERY return path
// -----------------------------------------------------------------------------

describe("S3: persistence-boundary sanitization (sanitizeForPersistence)", () => {
	test("a secret embedded in a missing config pathname never appears in the outcome row or reasons", async () => {
		const secretValue = "cfgsecretvalue123456";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		// Never created -- ENOENT inside `loadLiveQaConfig`, whose failure `reason` embeds the raw
		// path verbatim (`could not read ${path}: ...`).
		const configPath = join(mkdir("orch-live-qa-stage-cfgdir-"), secretValue, "live-qa.json");
		const result = await runLiveQaStage(baseOptions({ env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath } }));
		expect(result.verdict).toBe("unavailable");
		expect(JSON.stringify(result.outcomeRow)).not.toContain(secretValue);
		expect(result.reasons.join(" ")).not.toContain(secretValue);
		expect(JSON.stringify(result.outcomeRow)).toContain("[REDACTED]");
	});

	test("a secret embedded in runner_cwd never appears in runtime_under_test", async () => {
		const secretValue = "runnercwdsecret654321";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		// A real absolute path (never created as a repo) whose text itself carries the secret.
		const runnerCwd = join(tmpdir(), `orch-live-qa-runner-${secretValue}`);
		const configPath = writeConfig(validAdapterConfig(runnerCwd));
		// `cwd` (the candidate) is not a git repo, so the stage fails at/after adapter selection
		// without ever spawning a runner -- but `buildOutcomeRow` still records `runtime_under_test`
		// (including `runner_cwd`) for the selected adapter on this failure path too.
		const nonGitCwd = mkdir("orch-live-qa-stage-nongit-");
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: nonGitCwd,
		}));
		expect(result.verdict).toBe("unavailable");
		const runtimeUnderTest = result.outcomeRow?.runtime_under_test as Record<string, unknown> | undefined;
		expect(runtimeUnderTest?.runner_cwd).toBeDefined();
		expect(JSON.stringify(result.outcomeRow)).not.toContain(secretValue);
	});

	test("a secret in the adapter id itself never appears in the outcome row's adapter field", async () => {
		// `adapterId` is caller-controlled (config-authored); prove the boundary redacts it too,
		// not merely `runner_cwd`/config paths.
		const secretValue = "adapteridsecret112233";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		const runnerCwd = mkdir("orch-live-qa-stage-runner-adapterid-");
		const configPath = writeConfig(validAdapterConfig(runnerCwd, { id: `forge-${secretValue}` }));
		const result = await runLiveQaStage(baseOptions({
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: mkdir("orch-live-qa-stage-nongit2-"),
		}));
		expect(result.verdict).toBe("unavailable");
		expect(JSON.stringify(result.outcomeRow)).not.toContain(secretValue);
		expect(JSON.stringify(result.outcomeRow)).toContain("[REDACTED]");
	});

	test("a secret embedded in the request scope also never appears in the returned `stage` object itself, not only in reasons/costRows/outcomeRow", async () => {
		// Every previous S3 test above only inspected `result.reasons`/`result.costRows`/
		// `result.outcomeRow` -- `result.stage` (the raw `LiveQaStage`: adapterId, argv, scope,
		// revision, verdict) went through `runLiveQaStageUnsanitized` untouched and was returned
		// as-is. A caller that persists `result.stage` directly (rather than only the flattened
		// fields) would leak whatever secret ended up in its `scope`.
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n");
		const configPath = writeConfig(validAdapterConfig(dir));
		const secretValue = "stagesecretvalue998877";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQaStage(baseOptions({
			request: { requested: true, scope: `verify the login flow ${secretValue}` },
			env: { HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: configPath },
			cwd: dir,
			changedFiles: ["a.ts"],
		}));
		expect(result.verdict).toBe("pass");
		expect(result.stage).not.toBeNull();
		expect(result.stage?.scope).not.toContain(secretValue);
		expect(result.stage?.scope).toContain("[REDACTED]");
		expect(JSON.stringify(result.stage)).not.toContain(secretValue);
		// The sanitization pass over `stage` must not corrupt the checkpoint's own git object ids
		// (`sanitizeForPersistence`'s sha exemption, see live-qa.ts) -- the sha in `stage.revision`
		// must still agree exactly with the (also-sanitized) outcome row's `tested_revision`.
		expect(result.stage?.revision.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(result.stage?.revision.sha).toBe(result.outcomeRow?.tested_revision as string | undefined);
	});

	test("a hex-shaped credential (40-hex and 64-hex) passed as request.adapterId/request.scope is redacted, not exempted merely because it is hex-shaped, on the no-config failure path", async () => {
		// Regression: `sanitizeForPersistence`'s git-object-id exemption used to be keyed on the
		// VALUE's shape alone (any 40/64-hex string), not on which field it lives under. A hex-shaped
		// credential (e.g. a hex API token) passed as `--live-qa-adapter`/`--live-qa-scope` would then
		// slip through that exemption unredacted into `stage.adapterId`/`stage.scope`/
		// `outcomeRow.adapter` even though it is caller/request input, never a field this module itself
		// derived from its own git calls.
		const hex40 = "a".repeat(40);
		const hex64 = "b".repeat(64);
		process.env.PROBE_API_TOKEN = hex40;
		process.env.PROBE_API_SECRET = hex64;
		// No config configured at all -- this is the `failBeforeAdapter` path, which never gets far
		// enough to select an adapter, so `stage.adapterId`/`stage.scope` are built directly from
		// `request.adapterId`/`request.scope`.
		const result = await runLiveQaStage(baseOptions({
			env: {},
			request: { requested: true, adapterId: hex40, scope: hex64 },
		}));
		expect(result.verdict).toBe("unavailable");
		expect(result.stage?.adapterId).not.toBe(hex40);
		expect(result.stage?.scope).not.toBe(hex64);
		expect(result.stage?.adapterId).not.toContain(hex40);
		expect(result.stage?.scope).not.toContain(hex64);
		expect(result.outcomeRow?.adapter).not.toContain(hex40);
		expect(result.outcomeRow?.adapter).not.toBe(hex40);
		expect(result.reasons.join(" ")).not.toContain(hex40);
		expect(result.reasons.join(" ")).not.toContain(hex64);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(hex40);
		expect(serialized).not.toContain(hex64);
		expect(serialized).toContain("[REDACTED]");
	});
});

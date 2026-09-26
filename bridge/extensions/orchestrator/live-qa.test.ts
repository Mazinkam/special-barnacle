import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RunCancellation } from "./cancellation.ts";
import {
	buildRunnerArgv,
	liveQaCostRows,
	liveQaVerificationOutcomeFor,
	loadLiveQaConfig,
	MAX_ARTIFACT_BYTES,
	parseLiveQaConfig,
	parseLiveQaSession,
	parseNulDelimitedShowScopeRecords,
	prepareTestedRevision,
	proveRevision,
	readConfinedArtifact,
	redactSecrets,
	runLiveQa,
	sanitizeForPersistence,
	validateScope,
	verifyTrustedAncestry,
	type LiveQaAdapterConfig,
	type LiveQaVerdict,
} from "./live-qa.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-forge-qa.mjs", import.meta.url));

// -----------------------------------------------------------------------------
// Cleanup: every temp dir we create and every fixture pid we learn about is
// tracked here and torn down in afterEach, independent of test outcome.
// -----------------------------------------------------------------------------

const tmpDirs: string[] = [];
const trackedPids: number[] = [];
const mutatedEnvKeys = ["FAKE_FORGE_MODE", "FAKE_FORGE_ARGV_LOG", "FAKE_FORGE_PIDFILE", "FAKE_SECRET_ENV_VAR"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of mutatedEnvKeys) savedEnv[key] = process.env[key];

function mkdir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

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

// -----------------------------------------------------------------------------
// Config validation
// -----------------------------------------------------------------------------

function validAdapterEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "forge-focused",
		kind: "forge-qa",
		trusted: true,
		runner_cwd: "/abs/repo",
		argv_prefix: ["bun", "qa"],
		flow: "focused",
		slot: 0,
		budget_minutes: 30,
		runtime: "codex",
		model: "terra",
		effort: "medium",
		local: true,
		...overrides,
	};
}

describe("live-qa config validation", () => {
	test("missing config file produces a problem, never throws", () => {
		const result = loadLiveQaConfig({ HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: "/nonexistent/live-qa-config.json" });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.reason.includes("could not read"))).toBe(true);
	});

	test("unconfigured (env var unset) produces a problem and no adapters", () => {
		const result = loadLiveQaConfig({});
		expect(result.adapters).toEqual([]);
		expect(result.problems[0]?.reason).toContain("not configured");
	});

	test("a relative HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG path is rejected, never resolved against the current working directory", () => {
		const result = loadLiveQaConfig({ HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: "relative/live-qa-config.json" });
		expect(result.adapters).toEqual([]);
		expect(result.problems[0]?.reason).toContain("must be an absolute path");
	});

	test("an absolute HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG path that does not exist still reports the read failure, not the absolute-path check", () => {
		const result = loadLiveQaConfig({ HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG: "/nonexistent/absolute/live-qa-config.json" });
		expect(result.adapters).toEqual([]);
		expect(result.problems[0]?.reason).toContain("could not read");
	});

	test("untrusted adapter is disabled with a problem", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ trusted: false })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "trusted")).toBe(true);
	});

	test("unknown adapter key disables the adapter with a problem", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ extra_flag: true })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "extra_flag" && p.reason.includes("unknown adapter key"))).toBe(true);
	});

	test("unknown top-level key rejects the whole config, not just that key", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry()], unexpected: true });
		expect(result.problems.some((p) => p.field === "unexpected")).toBe(true);
		expect(result.adapters).toEqual([]);
	});

	test("bad slot value is rejected", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ slot: 2 })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "slot")).toBe(true);
	});

	test("missing slot is OK — Forge applies its own default", () => {
		const entry = validAdapterEntry();
		delete entry.slot;
		const result = parseLiveQaConfig({ version: 1, adapters: [entry] });
		expect(result.problems).toEqual([]);
		expect(result.adapters).toHaveLength(1);
		expect(result.adapters[0]?.slot).toBeUndefined();
		expect("slot" in result.adapters[0]!).toBe(false);
	});

	test("relative runner_cwd is rejected", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runner_cwd: "relative/path" })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "runner_cwd")).toBe(true);
	});

	test("bad argv_prefix (empty array) is rejected", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ argv_prefix: [] })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "argv_prefix")).toBe(true);
	});

	test("bad argv_prefix (empty string element) is rejected", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ argv_prefix: ["bun", ""] })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "argv_prefix")).toBe(true);
	});

	test("required defaults to true when omitted, and is validated when present", () => {
		const entryDefault = validAdapterEntry();
		delete entryDefault.required;
		const okResult = parseLiveQaConfig({ version: 1, adapters: [entryDefault] });
		expect(okResult.adapters[0]?.required).toBe(true);

		const badResult = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ required: "yes" })] });
		expect(badResult.adapters).toEqual([]);
		expect(badResult.problems.some((p) => p.field === "required")).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// Model alias validation, mirroring Forge scripts/qa/cli.ts:99-113 (MODELS,
	// HUMAIN_NODE_MODELS, CLAUDE_CODE_MODELS) and its parseArgs validation at cli.ts:199-209.
	// ---------------------------------------------------------------------------

	test("a codex-runtime alias (terra) is accepted", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "codex", model: "terra" })] });
		expect(result.adapters).toHaveLength(1);
		expect(result.problems).toEqual([]);
	});

	test("the resolved model slug (gpt-5.6-terra) is rejected: only the alias is a valid --model value", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "codex", model: "gpt-5.6-terra" })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "model")).toBe(true);
	});

	test("a HUMAIN Node model alias (glm) is accepted only under runtime humain-terminal", () => {
		const ok = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "humain-terminal", model: "glm" })] });
		expect(ok.adapters).toHaveLength(1);

		const bad = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "codex", model: "glm" })] });
		expect(bad.adapters).toEqual([]);
		expect(bad.problems.some((p) => p.field === "model")).toBe(true);
	});

	test("a claude-code alias (sonnet) is rejected under runtime codex, and vice versa", () => {
		const wrongRuntime = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "codex", model: "sonnet" })] });
		expect(wrongRuntime.adapters).toEqual([]);
		expect(wrongRuntime.problems.some((p) => p.field === "model")).toBe(true);

		const claudeOk = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "claude-code", model: "sonnet" })] });
		expect(claudeOk.adapters).toHaveLength(1);

		const claudeBad = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "claude-code", model: "terra" })] });
		expect(claudeBad.adapters).toEqual([]);
		expect(claudeBad.problems.some((p) => p.field === "model")).toBe(true);
	});

	test("an invalid runtime/model combination is rejected at config parse, never forwarded to the runner", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ runtime: "codex", model: "m3" })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "model")).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// argv_prefix credential rejection.
	// ---------------------------------------------------------------------------

	test("argv_prefix element containing '=' (env-style assignment) is rejected", () => {
		const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ argv_prefix: ["env", "FOO=bar", "bun", "qa"] })] });
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.field === "argv_prefix")).toBe(true);
	});

	test.each(["--token", "my-secret-flag", "API_KEY_LOADER", "apikey-tool", "bearer-helper", "PASSWORD_UTIL"])(
		"argv_prefix element that looks credential-shaped (%s) is rejected",
		(element) => {
			const result = parseLiveQaConfig({ version: 1, adapters: [validAdapterEntry({ argv_prefix: ["bun", element] })] });
			expect(result.adapters).toEqual([]);
			expect(result.problems.some((p) => p.field === "argv_prefix")).toBe(true);
		},
	);

	test("duplicate adapter ids reject the whole config, never silently pick one", () => {
		const result = parseLiveQaConfig({
			version: 1,
			adapters: [
				validAdapterEntry({ id: "forge-focused", runner_cwd: "/abs/repo-a" }),
				validAdapterEntry({ id: "forge-focused", runner_cwd: "/abs/repo-b" }),
			],
		});
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.adapter_id === "forge-focused" && p.reason.includes("duplicate adapter id"))).toBe(true);
	});

	test("distinct adapter ids are unaffected by the duplicate-id check", () => {
		const result = parseLiveQaConfig({
			version: 1,
			adapters: [
				validAdapterEntry({ id: "forge-a" }),
				validAdapterEntry({ id: "forge-b" }),
			],
		});
		expect(result.adapters).toHaveLength(2);
		expect(result.problems).toEqual([]);
	});

	test("a malformed entry (invalid in another field) that reuses a VALID entry's id rejects the whole config, not just disables the malformed one", () => {
		const result = parseLiveQaConfig({
			version: 1,
			adapters: [
				validAdapterEntry({ id: "forge-focused" }),
				// Malformed (`trusted` is not literally `true`) but reuses the SAME id -- this entry
				// alone would otherwise be silently disabled (its `id` never counted, since it never
				// makes it into `adapters`), letting the config load with exactly one "unambiguous" valid
				// adapter even though the id is written twice on disk.
				validAdapterEntry({ id: "forge-focused", trusted: false, runner_cwd: "/abs/repo-other" }),
			],
		});
		expect(result.adapters).toEqual([]);
		expect(result.problems.some((p) => p.adapter_id === "forge-focused" && p.reason.includes("duplicate adapter id"))).toBe(true);
	});
});

// -----------------------------------------------------------------------------
// Scope validation and safe argv construction
// -----------------------------------------------------------------------------

function baseAdapter(overrides: Partial<LiveQaAdapterConfig> = {}): LiveQaAdapterConfig {
	return {
		id: "forge-focused",
		kind: "forge-qa",
		trusted: true,
		runner_cwd: "/abs/repo",
		argv_prefix: ["bun", "qa"],
		flow: "focused",
		budget_minutes: 30,
		runtime: "codex",
		model: "terra",
		effort: "medium",
		local: true,
		required: true,
		...overrides,
	};
}

describe("scope validation", () => {
	test("shell metacharacters are accepted as an inert single argv element", () => {
		const scope = 'fix the $(rm -rf /) parser; also "quoted" text';
		const validated = validateScope(scope);
		expect(validated).toEqual({ ok: true, scope });
	});

	test("leading '-' is rejected (would be parsed as a flag)", () => {
		const validated = validateScope("-x fix things");
		expect(validated.ok).toBe(false);
	});

	test("newline is rejected", () => {
		expect(validateScope("fix\nthings").ok).toBe(false);
	});

	test("carriage return is rejected", () => {
		expect(validateScope("fix\rthings").ok).toBe(false);
	});

	test("NUL byte is rejected", () => {
		expect(validateScope("fix\u0000things").ok).toBe(false);
	});

	test("empty scope is rejected", () => {
		expect(validateScope("").ok).toBe(false);
	});
});

describe("buildRunnerArgv", () => {
	test("omits --slot entirely when the adapter has no slot configured", () => {
		const adapter = baseAdapter();
		const argv = buildRunnerArgv(adapter, "fix the login bug", "HEAD");
		expect(argv).not.toContain("--slot");
		expect(argv).toEqual([
			"bun", "qa", "run", "focused", "fix the login bug",
			"--ref", "HEAD", "--budget", "30", "--runtime", "codex",
			"--model", "terra", "--effort", "medium", "--local",
		]);
	});

	test("includes --slot 1 when the adapter has slot: 1", () => {
		const adapter = baseAdapter({ slot: 1 });
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		const slotIdx = argv.indexOf("--slot");
		expect(slotIdx).toBeGreaterThan(-1);
		expect(argv[slotIdx + 1]).toBe("1");
	});

	test("a scope with shell metacharacters is passed as exactly one argv element", () => {
		const adapter = baseAdapter();
		const scope = "scope; rm -rf / #$(evil)";
		const argv = buildRunnerArgv(adapter, scope, "HEAD");
		expect(argv.filter((a) => a === scope)).toEqual([scope]);
		expect(argv.join(" ")).not.toBe(argv.join(""));
	});

	test("argv never passes through a shell: the fake runner sees the scope unsplit", async () => {
		const runnerCwd = mkdir("orch-live-qa-argv-");
		const argvLog = join(mkdir("orch-live-qa-argv-log-"), "argv.json");
		const adapter = baseAdapter({ runner_cwd: runnerCwd, argv_prefix: [process.execPath, FIXTURE] });
		const scope = 'fix; `whoami` && echo "hi" $(pwd)';
		const argv = buildRunnerArgv(adapter, scope, "HEAD");

		process.env.FAKE_FORGE_MODE = "pass";
		process.env.FAKE_FORGE_ARGV_LOG = argvLog;
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(result.exitCode).toBe(0);

		const logged: string[] = JSON.parse(readFileSync(argvLog, "utf-8"));
		expect(logged).toContain(scope);
	});
});

function neverCancels(): { onCancel(listener: () => void): () => void } {
	return { onCancel: () => () => {} };
}

// -----------------------------------------------------------------------------
// Tested-revision proof
// -----------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function initRepo(): string {
	const dir = mkdir("orch-live-qa-repo-");
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	git(dir, "config", "commit.gpgsign", "false");
	return dir;
}

function commitFile(dir: string, name: string, content: string, message: string): string {
	writeFileSync(join(dir, name), content);
	git(dir, "add", name);
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD").trim();
}

describe("prepareTestedRevision", () => {
	test("clean HEAD, same repo: ok, no checkpoint", () => {
		const dir = initRepo();
		const sha = commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-clean", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(true);
		expect(result.sha).toBe(sha);
		expect(result.checkpoint).toBe(false);
		expect(result.checkpoint_ref).toBeNull();
		expect(result.component_exercised).toBe(true);
	});

	test("dirty tree: checkpoint commit captures the change without touching the user's index, HEAD, or branch", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const beforeHead = git(dir, "rev-parse", "HEAD").trim();
		const beforeBranch = git(dir, "symbolic-ref", "HEAD").trim();
		const beforeStage = git(dir, "ls-files", "--stage").trim();

		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		expect(git(dir, "status", "--porcelain").trim().length).toBeGreaterThan(0);

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-dirty", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(true);
		expect(result.checkpoint).toBe(true);
		expect(result.checkpoint_ref).toBe("refs/orchestrator/live-qa/test-dirty");
		expect(result.base_head).toBe(beforeHead);
		expect(result.component_exercised).toBe(true);

		// The user's real HEAD, branch, and index (the actually-staged blob content, not just raw
		// file bytes which git's own stat-cache refresh may touch harmlessly) must be untouched.
		expect(git(dir, "rev-parse", "HEAD").trim()).toBe(beforeHead);
		expect(git(dir, "symbolic-ref", "HEAD").trim()).toBe(beforeBranch);
		expect(git(dir, "ls-files", "--stage").trim()).toBe(beforeStage);
		// The dirty working tree is still dirty (never committed for real).
		expect(git(dir, "status", "--porcelain").trim().length).toBeGreaterThan(0);
		// But the checkpoint commit itself has the new content.
		expect(git(dir, "show", `${result.sha}:a.ts`)).toBe("export const a = 2;\n");
	});

	test("real .git/index is never written to: hash and mtime unchanged across prepareTestedRevision on a dirty tree", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		expect(git(dir, "status", "--porcelain").trim().length).toBeGreaterThan(0);

		const indexPath = join(dir, ".git", "index");
		const before = statSync(indexPath);
		const beforeHash = execFileSync("git", ["hash-object", indexPath], { cwd: dir, encoding: "utf-8" }).trim();

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-index-untouched", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(true);

		const after = statSync(indexPath);
		const afterHash = execFileSync("git", ["hash-object", indexPath], { cwd: dir, encoding: "utf-8" }).trim();
		expect(afterHash).toBe(beforeHash);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	test("runner repository cannot resolve the tested sha: not ok", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const staleClone = mkdir("orch-live-qa-clone-stale-");
		rmSync(staleClone, { recursive: true, force: true });
		execFileSync("git", ["clone", "-q", dir, staleClone], { stdio: "pipe" });
		// Advance the candidate after cloning; the clone never fetches this.
		commitFile(dir, "a.ts", "export const a = 2;\n", "second");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: staleClone, runId: "test-stale", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("cannot resolve");
	});

	test("a different (but up to date) repository proves the revision but reports component_exercised: false", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const freshClone = mkdir("orch-live-qa-clone-fresh-");
		rmSync(freshClone, { recursive: true, force: true });
		execFileSync("git", ["clone", "-q", dir, freshClone], { stdio: "pipe" });
		const sha = commitFile(dir, "a.ts", "export const a = 2;\n", "second");
		execFileSync("git", ["-C", freshClone, "fetch", "-q", "origin"], { stdio: "pipe" });

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: freshClone, runId: "test-diff-repo", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(true);
		expect(result.sha).toBe(sha);
		expect(result.component_exercised).toBe(false);
		expect(result.component_exercised_reason).toBeTruthy();
	});

	// -------------------------------------------------------------------------
	// Regression: the checkpoint tree must be built EXCLUSIVELY from the explicit
	// `changedFiles` candidate set, never from "everything git considers dirty".
	// -------------------------------------------------------------------------

	test("an unrelated untracked file NOT in changedFiles is never included in the checkpoint tree", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		// An unrelated untracked stray file, never reported as changed by this run.
		writeFileSync(join(dir, "secrets.env"), "API_TOKEN=super-secret-value\n");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-checkpoint-scope-untracked", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(true);

		// The checkpoint commit's tree has a.ts's new content, but does NOT contain secrets.env at
		// all -- it was never part of the caller-supplied candidate set.
		expect(git(dir, "show", `${result.sha}:a.ts`)).toBe("export const a = 2;\n");
		expect(() => git(dir, "cat-file", "-e", `${result.sha}:secrets.env`)).toThrow();
		const treeFiles = git(dir, "ls-tree", "-r", "--name-only", result.sha as string).trim().split("\n");
		expect(treeFiles).not.toContain("secrets.env");
	});

	test("a concurrently dirty tracked file NOT in changedFiles is checkpointed at its HEAD content, not its dirty working-tree content", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		commitFile(dir, "b.ts", "export const b = 1;\n", "add b");

		// a.ts is the reported candidate change; b.ts is dirtied CONCURRENTLY (e.g. by another
		// process) but never reported as part of this run's changed-file set.
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		writeFileSync(join(dir, "b.ts"), "export const b = EXCLUDED;\n");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-checkpoint-scope-excluded-edit", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(true);

		expect(git(dir, "show", `${result.sha}:a.ts`)).toBe("export const a = 2;\n");
		// b.ts in the checkpoint tree is HEAD's content, never the concurrently-dirty working-tree
		// content -- the checkpoint never included b.ts's edit at all.
		expect(git(dir, "show", `${result.sha}:b.ts`)).toBe("export const b = 1;\n");
		// The real working tree is untouched and still shows b.ts as dirty.
		expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("export const b = EXCLUDED;\n");
	});

	test("a dirty tree with an empty candidate changed-file set fails closed (ambiguous), never silently checkpoints everything", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-checkpoint-scope-empty", changedFiles: [] });
		expect(result.ok).toBe(false);
		expect(result.checkpoint).toBe(false);
		expect(result.reason).toContain("ambiguous");
	});

	// -------------------------------------------------------------------------
	// Regression: symlinks are compared by target (never skipped), and any changed path this
	// proof cannot content-compare fails closed rather than being silently skipped.
	// -------------------------------------------------------------------------

	test("clean HEAD: a symlink changed file whose target matches HEAD is proven ok", () => {
		const dir = initRepo();
		writeFileSync(join(dir, "target.txt"), "hello\n");
		symlinkSync("target.txt", join(dir, "link.txt"));
		git(dir, "add", "target.txt", "link.txt");
		git(dir, "commit", "-q", "-m", "add symlink");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-symlink-proof-ok", changedFiles: ["link.txt"] });
		expect(result.ok).toBe(true);
		expect(result.checkpoint).toBe(false);
	});

	test("a symlink changed file whose target does NOT match the tested revision is detected, never silently skipped as a non-file", () => {
		const dir = initRepo();
		writeFileSync(join(dir, "target.txt"), "hello\n");
		writeFileSync(join(dir, "other.txt"), "other\n");
		symlinkSync("target.txt", join(dir, "link.txt"));
		git(dir, "add", "target.txt", "other.txt", "link.txt");
		git(dir, "commit", "-q", "-m", "symlink -> target.txt");
		const goodSha = git(dir, "rev-parse", "HEAD").trim();

		// Re-point the symlink to a DIFFERENT target and commit that too, so the working tree
		// (and current HEAD) matches "other.txt", while goodSha (an earlier, still-resolvable
		// commit) recorded "target.txt" -- exercising proveRevision against a sha whose tree
		// genuinely disagrees with the working tree's symlink target, which the previous
		// `if (!stat.isFile()) continue;` would have silently accepted as "ok" (never a file, so
		// never compared at all).
		unlinkSync(join(dir, "link.txt"));
		symlinkSync("other.txt", join(dir, "link.txt"));
		git(dir, "add", "link.txt");
		git(dir, "commit", "-q", "-m", "symlink -> other.txt");

		const result = proveRevision(dir, dir, goodSha, ["link.txt"]);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("symlink");
	});

	// -------------------------------------------------------------------------
	// Regression: content-only comparison is not enough -- git blob hashing is content-addressed,
	// independent of the tree entry's own mode, so a regular-file blob whose content happens to
	// equal a symlink's target text (or vice versa) must still fail the proof on a MODE mismatch,
	// never pass merely because the bytes line up.
	// -------------------------------------------------------------------------

	function buildTreeWithTypeOverride(dir: string, baseSha: string, path: string, mode: "100644" | "120000", content: string): string {
		const tmpIndex = join(mkdir("orch-live-qa-tree-override-"), "index");
		const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
		execFileSync("git", ["read-tree", baseSha], { cwd: dir, env, stdio: "pipe" });
		const blobSha = execFileSync("git", ["hash-object", "-w", "-t", "blob", "--stdin"], { cwd: dir, env, input: content, encoding: "utf-8" }).trim();
		execFileSync("git", ["update-index", "--add", "--cacheinfo", `${mode},${blobSha},${path}`], { cwd: dir, env, stdio: "pipe" });
		const tree = execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf-8" }).trim();
		return execFileSync("git", ["commit-tree", tree, "-p", baseSha, "-m", "type-confusion fixture"], { cwd: dir, encoding: "utf-8" }).trim();
	}

	test("a REGULAR-FILE tree entry whose blob content matches a symlink's target text is rejected on mode, never accepted on content alone", () => {
		const dir = initRepo();
		const baseSha = commitFile(dir, "base.txt", "base\n", "init");
		writeFileSync(join(dir, "target.txt"), "hello\n");
		symlinkSync("target.txt", join(dir, "link.txt"));
		git(dir, "add", "target.txt", "link.txt");
		git(dir, "commit", "-q", "-m", "add real symlink");

		// An ALTERNATE tree where link.txt is a REGULAR FILE (100644) whose blob content is exactly
		// the symlink's target text ("target.txt", no trailing newline) -- byte-identical to what the
		// symlink branch below compares against, but with a DIFFERENT git mode.
		const maliciousSha = buildTreeWithTypeOverride(dir, baseSha, "link.txt", "100644", "target.txt");

		const result = proveRevision(dir, dir, maliciousSha, ["link.txt"]);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("mode");
		expect(result.reason).toContain("type mismatch");
	});

	test("a SYMLINK tree entry whose target text matches a regular file's content is rejected on mode, never accepted on content alone", () => {
		const dir = initRepo();
		const baseSha = commitFile(dir, "base.txt", "base\n", "init");
		// A REGULAR FILE at this path whose content is exactly a valid relative-path string with no
		// trailing newline -- indistinguishable, by content alone, from a symlink whose target is that
		// same string.
		writeFileSync(join(dir, "sneaky.txt"), "target.txt");
		git(dir, "add", "sneaky.txt");
		git(dir, "commit", "-q", "-m", "add regular file with symlink-target-shaped content");

		// An ALTERNATE tree where sneaky.txt is a SYMLINK (120000) whose target text is the exact same
		// bytes ("target.txt") as the working tree's regular-file content.
		const maliciousSha = buildTreeWithTypeOverride(dir, baseSha, "sneaky.txt", "120000", "target.txt");

		const result = proveRevision(dir, dir, maliciousSha, ["sneaky.txt"]);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("mode");
		expect(result.reason).toContain("type mismatch");
	});

	test('a changed path that is a directory fails closed, never silently skipped as "not content-comparable"', () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		mkdirSync(join(dir, "some-dir"));
		writeFileSync(join(dir, "some-dir", "nested.txt"), "nested\n");
		git(dir, "add", "some-dir");
		git(dir, "commit", "-q", "-m", "add dir");
		// Clean HEAD (nothing dirty): exercises `proveRevision` directly, without going through
		// `buildCheckpointIndex`'s own (separate) directory rejection.
		expect(git(dir, "status", "--porcelain").trim()).toBe("");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-dir-proof-fail-closed", changedFiles: ["a.ts", "some-dir"] });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("unsupported type");
	});
});

// -----------------------------------------------------------------------------
// Fake-runner end-to-end sessions
// -----------------------------------------------------------------------------

function fakeAdapter(runnerCwd: string, overrides: Partial<LiveQaAdapterConfig> = {}): LiveQaAdapterConfig {
	return baseAdapter({
		runner_cwd: runnerCwd,
		argv_prefix: [process.execPath, FIXTURE],
		...overrides,
	});
}

async function runFake(mode: string, overrides: Partial<LiveQaAdapterConfig> = {}) {
	const runnerCwd = mkdir("orch-live-qa-runner-");
	const adapter = fakeAdapter(runnerCwd, overrides);
	const argv = buildRunnerArgv(adapter, "verify the login flow", "HEAD");
	process.env.FAKE_FORGE_MODE = mode;
	const lines: string[] = [];
	const startedAtMs = Date.now();
	const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: (l) => lines.push(l) });
	return { adapter, result, lines, runnerCwd, startedAtMs };
}

describe("live-qa session outcomes via the fake runner", () => {
	test("pass: exit 0, no confirmed findings", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		expect(result.exitCode).toBe(0);
		expect(result.reportPath).toBeTruthy();
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("pass");
		expect(verdict.usage?.agent.costSource).toBe("reported");
	});

	test("finding: a confirmed tier-1 finding is a fail even with exit 0", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("finding");
		expect(result.exitCode).toBe(0);
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("fail");
		expect(verdict.reasons.length).toBeGreaterThan(0);
	});

	test("preflight failure: no report line, no session directory — unavailable, never a pass", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("preflight_fail");
		expect(result.exitCode).toBe(1);
		expect(result.reportPath).toBeNull();
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
	});

	test("incomplete: session dir exists but findings.json is missing — unavailable", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("incomplete");
		expect(result.exitCode).toBe(1);
		expect(result.reportPath).toBeTruthy();
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toContain("findings.json");
	});

	test("missing usage.json is tolerated: still a pass, usage is null (not zero-filled)", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("no_usage");
		expect(result.exitCode).toBe(0);
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("pass");
		expect(verdict.usage).toBeNull();
	});

	test("dangling usage.json symlink makes the session unavailable", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		const usagePath = join(dirname(result.reportPath!), "usage.json");
		rmSync(usagePath);
		symlinkSync(join(dirname(usagePath), "missing-target.json"), usagePath);
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
	});

	test("spawn ENOENT is unavailable, never a pass, and reports spawnError", async () => {
		const runnerCwd = mkdir("orch-live-qa-enoent-");
		const adapter = fakeAdapter(runnerCwd, { argv_prefix: ["/nonexistent/definitely-not-a-binary"] });
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		const startedAtMs = Date.now();
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(result.exitCode).toBeNull();
		expect(result.cancelled).toBe(false);
		expect(result.spawnError).toBeTruthy();
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: null, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
	});

	test("unknown cost is preserved as null/unknown in liveQaCostRows, never coerced to 0", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("codex_unknown_cost");
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.usage?.agent.costMicrocents).toBeNull();
		const rows = liveQaCostRows({ runId: "run-1", taskId: "task-1", adapterId: "forge-focused", verdict });
		const agentRow = rows.find((r) => r.live_qa_component === "agent")!;
		expect(agentRow.cost_usd).toBeUndefined();
		expect(agentRow.cost_source).toBe("unknown-not-reported-by-qa-runtime");
	});
});

// -----------------------------------------------------------------------------
// Fake-runner argv validation (mirrors Forge scripts/qa/cli.ts parseArgs usage errors).
// -----------------------------------------------------------------------------

describe("fake runner argv validation (mirrors Forge parseArgs usage errors)", () => {
	test("unknown model alias: exit 2, no session directory, no report line", async () => {
		const { result, runnerCwd } = await runFake("pass", { model: "terra" });
		// Sanity: the happy path really does create a session (proves the assertions below are
		// meaningful, not just "nothing runs").
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(true);

		const runnerCwd2 = mkdir("orch-live-qa-runner-");
		const adapter = fakeAdapter(runnerCwd2);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD").map((a) => (a === "terra" ? "not-a-real-alias" : a));
		process.env.FAKE_FORGE_MODE = "pass";
		const bad = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(bad.exitCode).toBe(2);
		expect(bad.reportPath).toBeNull();
		expect(existsSync(join(runnerCwd2, "qa", "sessions"))).toBe(false);
	});

	test("unknown runtime: exit 2, no session directory", async () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD").map((a) => (a === "codex" ? "not-a-real-runtime" : a));
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(result.exitCode).toBe(2);
		expect(result.reportPath).toBeNull();
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});

	test("unknown effort: exit 2, no session directory", async () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD").map((a) => (a === "medium" ? "not-a-real-effort" : a));
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(result.exitCode).toBe(2);
		expect(result.reportPath).toBeNull();
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});

	test("unknown flag: exit 2, no session directory", async () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = [...buildRunnerArgv(adapter, "scope", "HEAD"), "--not-a-real-flag", "x"];
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(result.exitCode).toBe(2);
		expect(result.reportPath).toBeNull();
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});

	test("a HUMAIN Node model alias under runtime codex: exit 2, no session directory", async () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD").map((a) => (a === "terra" ? "glm" : a));
		process.env.FAKE_FORGE_MODE = "pass";
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(result.exitCode).toBe(2);
		expect(result.reportPath).toBeNull();
		expect(existsSync(join(runnerCwd, "qa", "sessions"))).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Run-id binding (Forge cli.ts:384-399, 506-619): a session must be bound to THIS invocation's
// own parsed run id, never merely "a session directory that happens to exist".
// -----------------------------------------------------------------------------

describe("run-id binding", () => {
	test("a stale pre-existing clean session directory must not produce PASS", async () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		// Plant a fully well-formed, clean (no confirmed findings) session BEFORE this invocation
		// starts, using a run id this invocation will never itself report.
		const staleRunId = "run-19990101-000000-abcd";
		const staleDir = join(runnerCwd, "qa", "sessions", staleRunId);
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(join(staleDir, "report.md"), "# stale\n");
		writeFileSync(join(staleDir, "findings.json"), JSON.stringify({ findings: [] }));

		// Backdate the stale directory's mtime well before "now" so the mtime guard, not just the
		// run-id guard, would also catch it.
		const past = new Date(Date.now() - 60_000);
		utimesSync(staleDir, past, past);

		const startedAtMs = Date.now();
		// This invocation's OWN reported reportPath/runnerRunId point at the stale directory (as if a
		// compromised or buggy runner reported someone else's old session).
		const verdict = parseLiveQaSession({
			runnerCwd,
			reportPath: join(staleDir, "report.md"),
			runnerRunId: staleRunId,
			exitCode: 0,
			startedAtMs,
		});
		expect(verdict.verdict).not.toBe("pass");
		expect(verdict.verdict).toBe("unavailable");
	});

	test("missing runnerRunId is unavailable, never a pass, even with exit 0 and a real report path", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		expect(result.exitCode).toBe(0);
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: null, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a reportPath pointing outside this invocation's own <runnerRunId> session dir is unavailable", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		expect(result.runnerRunId).toBeTruthy();
		// Plant a second, unrelated session and claim ITS report path while still asserting THIS
		// invocation's real runnerRunId — a run-id/report-path mismatch.
		const otherRunId = "run-20200101-000000-face";
		const otherDir = join(runnerCwd, "qa", "sessions", otherRunId);
		mkdirSync(otherDir, { recursive: true });
		writeFileSync(join(otherDir, "report.md"), "# other\n");
		writeFileSync(join(otherDir, "findings.json"), JSON.stringify({ findings: [] }));

		const verdict = parseLiveQaSession({
			runnerCwd,
			reportPath: join(otherDir, "report.md"),
			runnerRunId: result.runnerRunId,
			exitCode: result.exitCode,
			startedAtMs,
		});
		expect(verdict.verdict).toBe("unavailable");
	});
});

// -----------------------------------------------------------------------------
// Report/artifact path confinement (symlink rejection) and freshness (mtime) guards.
// -----------------------------------------------------------------------------

describe("report path confinement and freshness", () => {
	test("a report.md that is a symlink pointing outside the session dir is unavailable, never a pass", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		expect(result.reportPath).toBeTruthy();

		const outsideDir = mkdir("orch-live-qa-outside-");
		const outsideTarget = join(outsideDir, "secret.md");
		writeFileSync(outsideTarget, "outside content\n");

		// Replace the real report.md with a symlink pointing OUTSIDE the session directory
		// entirely -- rejected purely because it IS a symlink at that path, independent of where
		// realpath eventually lands.
		rmSync(result.reportPath!, { force: true });
		symlinkSync(outsideTarget, result.reportPath!);

		const verdict = parseLiveQaSession({
			runnerCwd,
			reportPath: result.reportPath,
			runnerRunId: result.runnerRunId,
			exitCode: result.exitCode,
			startedAtMs,
		});
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toMatch(/symlink/);
	});

	test("a findings.json that is a symlink pointing outside the session dir is unavailable, never a pass", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		const sessionDir = dirname(result.reportPath!);
		const findingsPath = join(sessionDir, "findings.json");

		const outsideDir = mkdir("orch-live-qa-outside-");
		const outsideTarget = join(outsideDir, "findings.json");
		writeFileSync(outsideTarget, JSON.stringify({ findings: [] }));

		rmSync(findingsPath, { force: true });
		symlinkSync(outsideTarget, findingsPath);

		const verdict = parseLiveQaSession({
			runnerCwd,
			reportPath: result.reportPath,
			runnerRunId: result.runnerRunId,
			exitCode: result.exitCode,
			startedAtMs,
		});
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a stale report.md with a fresh session directory mtime is not PASS", () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const runId = "run-20200101-000000-1234";
		const sessionDir = join(runnerCwd, "qa", "sessions", runId);

		const startedAtMs = Date.now();
		// Session directory and findings.json are written AFTER `startedAtMs` -- both genuinely
		// fresh, exactly like a real invocation.
		mkdirSync(sessionDir, { recursive: true });
		const reportPath = join(sessionDir, "report.md");
		writeFileSync(reportPath, "# report\n");
		writeFileSync(join(sessionDir, "findings.json"), JSON.stringify({ findings: [] }));

		// ...but report.md's mtime is backdated well past the filesystem-mtime-granularity slack,
		// simulating a stale report.md left over from an earlier run and never rewritten by this
		// invocation, even though the directory itself (and findings.json) look fresh.
		const past = new Date(startedAtMs - 60_000);
		utimesSync(reportPath, past, past);

		const verdict = parseLiveQaSession({ runnerCwd, reportPath, runnerRunId: runId, exitCode: 0, startedAtMs });
		expect(verdict.verdict).not.toBe("pass");
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toContain("report.md");
	});

	test("a stale findings.json with a fresh session directory and report.md mtime is not PASS", () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const runId = "run-20200101-000000-5678";
		const sessionDir = join(runnerCwd, "qa", "sessions", runId);

		const startedAtMs = Date.now();
		mkdirSync(sessionDir, { recursive: true });
		const reportPath = join(sessionDir, "report.md");
		writeFileSync(reportPath, "# report\n");
		const findingsPath = join(sessionDir, "findings.json");
		writeFileSync(findingsPath, JSON.stringify({ findings: [] }));

		const past = new Date(startedAtMs - 60_000);
		utimesSync(findingsPath, past, past);

		const verdict = parseLiveQaSession({ runnerCwd, reportPath, runnerRunId: runId, exitCode: 0, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toContain("findings.json");
	});
});

// -----------------------------------------------------------------------------
// Findings validation (mirrors Forge scripts/qa/findings.ts FindingInputSchema).
// -----------------------------------------------------------------------------

describe("findings validation", () => {
	function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			title: "Broken login flow",
			severity: "P1",
			tier: 1,
			confirmed: true,
			area: "auth",
			route: "/login",
			identity: "member",
			steps: ["open /login", "submit"],
			expected: "login succeeds",
			actual: "login fails",
			evidenceDir: "evidence/1",
			failureClass: "functional",
			symptom: "500 on submit",
			confidence: 0.9,
			...overrides,
		};
	}

	async function withFindings(findingsBody: unknown, exitCode = 0) {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		process.env.FAKE_FORGE_MODE = "pass";
		const startedAtMs = Date.now();
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		const sessionDir = dirname(result.reportPath!);
		writeFileSync(join(sessionDir, "findings.json"), JSON.stringify(findingsBody));
		return { verdict: parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode, startedAtMs }) };
	}

	test("a well-formed confirmed P1 is a fail", async () => {
		const { verdict } = await withFindings({ findings: [validFinding()] });
		expect(verdict.verdict).toBe("fail");
	});

	test("a malformed P1 (missing required field) with exit 0 is unavailable, never PASS", async () => {
		const broken = validFinding();
		delete broken.evidenceDir;
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).not.toBe("pass");
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a finding with an out-of-range confidence is unavailable, never PASS", async () => {
		const broken = validFinding({ confidence: 1.5 });
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a finding with an empty steps array is unavailable, never PASS", async () => {
		const broken = validFinding({ steps: [] });
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a bare array envelope with a well-formed finding still validates", async () => {
		const { verdict } = await withFindings([validFinding({ confirmed: false, tier: 3 })]);
		expect(verdict.verdict).toBe("pass");
	});

	// Mirrors Forge's scripts/qa/findings.ts FindingInputSchema optional fields: fingerprint?,
	// source?, duplicateOf? (plain optional strings) and retainEnvironment? ({reason: non-empty
	// string}). A malformed value for any of these must make the whole envelope unavailable,
	// never silently dropped or coerced.
	test("well-formed optional fields (fingerprint, source, duplicateOf, retainEnvironment) validate", async () => {
		const { verdict } = await withFindings({
			findings: [validFinding({
				fingerprint: "abc123",
				source: "manual-review",
				duplicateOf: "def456",
				retainEnvironment: { reason: "flaky endpoint under investigation" },
			})],
		});
		expect(verdict.verdict).toBe("fail");
	});

	test("a non-string source is unavailable, never PASS", async () => {
		const broken = validFinding({ source: 123 });
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a non-string duplicateOf is unavailable, never PASS", async () => {
		const broken = validFinding({ duplicateOf: 456 });
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a retainEnvironment with an empty reason is unavailable, never PASS", async () => {
		const broken = validFinding({ retainEnvironment: { reason: "" } });
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a retainEnvironment that is not an object is unavailable, never PASS", async () => {
		const broken = validFinding({ retainEnvironment: "yes please" });
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).toBe("unavailable");
	});

	test("a title over 200 characters is unavailable, never PASS", async () => {
		const broken = validFinding({ title: "x".repeat(201) });
		const { verdict } = await withFindings({ findings: [broken] }, 0);
		expect(verdict.verdict).toBe("unavailable");
	});
});

// -----------------------------------------------------------------------------
// Credential handling: argv_prefix rejection is covered under "live-qa config validation"
// above; this covers runtime redaction of runner output before it reaches onLine/tail.
// -----------------------------------------------------------------------------

describe("results.md verdict authority (T5)", () => {
	test("results.md missing entirely: unavailable, never PASS", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("results_missing");
		expect(result.exitCode).toBe(0);
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toContain("results.md");
	});

	test("results.md reports a FAIL row: fail, even with clean findings and exit 0", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("results_fail");
		expect(result.exitCode).toBe(0);
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("fail");
		expect(verdict.reasons.join(" ")).toContain("FAIL");
	});

	test("results.md reports a BLOCKED row (no FAIL): unavailable, never PASS", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("results_blocked");
		expect(result.exitCode).toBe(0);
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toContain("BLOCKED");
	});

	test("results.md with only PASS rows, clean findings, exit 0: pass", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("pass");
	});

	test("results.md with an unparseable table (no Result column): unavailable", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		const sessionDir = dirname(result.reportPath!);
		writeFileSync(join(sessionDir, "results.md"), "| Step | Notes |\n| --- | --- |\n| login | fine |\n");
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
	});

	test("results.md with a Result value outside PASS|FAIL|BLOCKED: unavailable", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		const sessionDir = dirname(result.reportPath!);
		writeFileSync(join(sessionDir, "results.md"), "| Step | Result |\n| --- | --- |\n| login | maybe |\n");
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
	});
});

describe("cost rows: unknown provenance and record_id (T3/T4)", () => {
	function fakeVerdict(overrides: Partial<LiveQaVerdict> = {}): LiveQaVerdict {
		return {
			verdict: "pass", reasons: [], session_id: null, session_dir: null, findings: [],
			observations_count: 0, artifacts: [], usage: null, exit_code: 0,
			...overrides,
		};
	}

	test("unknown cost provenance never sets cost_usd; the number is kept only as a non-billable hint", () => {
		const verdict = fakeVerdict({
			usage: {
				version: 2,
				agent: {
					status: "recorded", runtime: "codex", model: "m", provider: "p", effort: "medium",
					inputTokens: 1, outputTokens: 1, cacheReadInputTokens: null, cacheCreationInputTokens: null,
					costMicrocents: 12_345, costSource: "unknown", elapsedMs: 1,
				},
				humainCode: { status: "no_runs" },
			},
		});
		const rows = liveQaCostRows({ runId: "run-1", taskId: "task-1", adapterId: "forge-focused", verdict });
		const agentRow = rows.find((r) => r.live_qa_component === "agent")!;
		expect(agentRow.cost_usd).toBeUndefined();
		expect(agentRow.unattributed_cost_usd_hint).toBeCloseTo(12_345 / 1e8);
		expect(agentRow.cost_source).toBe("unknown-not-reported-by-qa-runtime");
	});

	test("missing session_id: record_id is invocation-unique (runId:adapterId:no-session), never a shared ':unknown'", () => {
		const verdict = fakeVerdict({ session_id: null });
		const rowsA = liveQaCostRows({ runId: "run-A", taskId: "task-A", adapterId: "forge-focused", verdict });
		const rowsB = liveQaCostRows({ runId: "run-B", taskId: "task-B", adapterId: "forge-focused", verdict });
		const idA = rowsA.find((r) => r.live_qa_component === "agent")!.record_id;
		const idB = rowsB.find((r) => r.live_qa_component === "agent")!.record_id;
		expect(idA).toBe("live-qa-agent:run-A:forge-focused:no-session");
		expect(idB).toBe("live-qa-agent:run-B:forge-focused:no-session");
		expect(idA).not.toBe(idB);
		expect(String(idA)).not.toContain(":unknown");
	});
});

describe("credential redaction of runner output", () => {
	test("an env var value matching a credential-shaped name, a Bearer token, and URL userinfo are all redacted", async () => {
		const secretValue = "supersecretvalue123";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		const { result, lines } = await runFake("leaky");
		expect(result.exitCode).toBe(0);

		const joinedLines = lines.join("\n");
		expect(joinedLines).not.toContain(secretValue);
		expect(joinedLines).toContain("[REDACTED]");
		expect(joinedLines).not.toContain("abcdef123456");
		expect(joinedLines).toContain("Bearer [REDACTED]");
		expect(joinedLines).not.toContain("leakuser:leakpass1");
		expect(joinedLines).toContain("postgres://[REDACTED]@localhost");

		expect(result.tail).not.toContain(secretValue);
		expect(result.tail).not.toContain("abcdef123456");
		expect(result.tail).not.toContain("leakuser:leakpass1");
	});

	test("a secret in the final non-newline-terminated output line is redacted in onLine and tail", async () => {
		const secretValue = "finalsecretvalue123";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		const { result, lines } = await runFake("leaky_final_line");
		expect(result.exitCode).toBe(0);
		expect(lines.join("\\n")).not.toContain(secretValue);
		expect(lines.join("\\n")).toContain("[REDACTED]");
		expect(result.tail).not.toContain(secretValue);
		expect(result.tail).toContain("[REDACTED]");
	});

	test("a secret split exactly across two separate stdout writes is still fully redacted (never per-chunk)", async () => {
		const secretValue = "supersecretsplitboundaryvalue";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		const { result, lines } = await runFake("leaky_split");
		expect(result.exitCode).toBe(0);

		const joinedLines = lines.join("\n");
		expect(joinedLines).not.toContain(secretValue);
		// The two halves, printed adjacently by the fixture (`secret-part1:<first half>` then
		// `<second half>:secret-part2`), must never appear intact even though neither individual
		// `data` event ever contained the whole value -- proving redaction operates on the
		// reassembled, complete line, not on each raw chunk.
		expect(joinedLines).toContain("[REDACTED]");
		expect(result.tail).not.toContain(secretValue);
	});
});

describe("credential-shaped KEY=VALUE assignment redaction (unconditional, no env-match/length requirement)", () => {
	test("a credential-shaped assignment is redacted even when never exported as a process.env variable", () => {
		const redacted = redactSecrets("running with API_TOKEN=ab and DB_PASSWORD=x", {});
		expect(redacted).toBe("running with API_TOKEN=[REDACTED] and DB_PASSWORD=[REDACTED]");
		expect(redacted).not.toContain("=ab");
		expect(redacted).not.toContain("=x");
	});

	test("a short (<6 char) credential-shaped value is still redacted, unlike the env-substring pass' MIN_REDACTED_ENV_VALUE_LENGTH floor", () => {
		expect(redactSecrets("SECRET_KEY=42", {})).toBe("SECRET_KEY=[REDACTED]");
		expect(redactSecrets("AUTH_TOKEN=hi", {})).toBe("AUTH_TOKEN=[REDACTED]");
	});

	test.each(["PASSWORD", "API_SECRET", "ACCESS_TOKEN", "PRIVATE_KEY", "AUTH_HEADER", "MY_CREDENTIAL", "SESSION_COOKIE", "user_session"])(
		"a %s=<value> assignment is redacted regardless of case",
		(name) => {
			const redacted = redactSecrets(`${name}=realvalue123`, {});
			expect(redacted).toBe(`${name}=[REDACTED]`);
		},
	);

	test("a non-credential-shaped assignment (e.g. MODEL=terra) is left untouched", () => {
		expect(redactSecrets("MODEL=terra --effort medium", {})).toBe("MODEL=terra --effort medium");
	});

	test("DATABASE_URL-style URLs with userinfo are redacted regardless of env match (via the unconditional URL-userinfo pass)", () => {
		const redacted = redactSecrets("DATABASE_URL=postgres://dbuser:dbpass@localhost:5432/app", {});
		expect(redacted).not.toContain("dbuser:dbpass");
		expect(redacted).toContain("postgres://[REDACTED]@localhost:5432/app");
	});

	test("a free-text scope containing a credential-shaped assignment is redacted before persistence (liveQaVerificationOutcomeFor)", () => {
		const stage = {
			adapterId: "forge-focused",
			argv: ["bun", "qa", "run", "focused", "verify AUTH_TOKEN=leaked-value-123 works"],
			scope: "verify AUTH_TOKEN=leaked-value-123 works",
			revision: { ok: true, reason: undefined, sha: "a".repeat(40), tree: "b".repeat(40), base_head: "a".repeat(40), checkpoint: false, checkpoint_ref: null, component_exercised: true } as const,
			verdict: {
				verdict: "pass" as const, reasons: [], session_id: null, session_dir: null, findings: [],
				observations_count: 0, artifacts: [], usage: null, exit_code: 0,
			},
			required: true,
		};
		const outcome = liveQaVerificationOutcomeFor("run-redact-argv", stage);
		expect(outcome.scope).not.toContain("leaked-value-123");
		expect(JSON.stringify(outcome.runner_argv)).not.toContain("leaked-value-123");
	});

	test("a credential-shaped assignment NESTED inside a non-credential assignment's UNQUOTED value is still redacted (note=API_TOKEN=abc)", () => {
		const redacted = redactSecrets("note=API_TOKEN=abc", {});
		expect(redacted).toBe("note=API_TOKEN=[REDACTED]");
		expect(redacted).not.toContain("=abc");
	});

	test('a credential-shaped assignment NESTED inside a non-credential assignment\'s QUOTED value is still redacted (message="API_TOKEN=abc")', () => {
		const redacted = redactSecrets('message="API_TOKEN=abc"', {});
		expect(redacted).toBe('message="API_TOKEN=[REDACTED]"');
		expect(redacted).not.toContain("=abc");
	});

	test("a non-credential outer key with a non-credential nested assignment is left untouched (no false positives from the recursion itself)", () => {
		expect(redactSecrets("note=MODEL=terra", {})).toBe("note=MODEL=terra");
	});

	test("a pathological chain of many nested '=' assignments never stack-overflows and redacts in well under a second (bounded recursion depth)", () => {
		const text = "a=".repeat(20_000) + "a";
		const start = Date.now();
		let redacted = "";
		expect(() => {
			redacted = redactSecrets(text, {});
		}).not.toThrow();
		expect(Date.now() - start).toBeLessThan(1000);
		expect(redacted.length).toBeGreaterThan(0);
	});

	test("a credential nested exactly at the recursion-depth cap is still redacted, never returned verbatim (a=a=a=...=API_TOKEN=abc)", () => {
		const redacted = redactSecrets("a=a=a=a=a=a=a=a=API_TOKEN=abc", {});
		expect(redacted).not.toContain("abc");
	});

	test("a credential nested DEEPER than the recursion-depth cap is still redacted, never returned verbatim", () => {
		const redacted = redactSecrets(`${"a=".repeat(30)}API_TOKEN=abc`, {});
		expect(redacted).not.toContain("abc");
	});

	test("a 64KB adversarial '=' chain past the recursion-depth cap redacts in well under a second (no unbounded work at the cap)", () => {
		const text = `${"a=".repeat(32_000)}API_TOKEN=abc`;
		const start = Date.now();
		let redacted = "";
		expect(() => {
			redacted = redactSecrets(text, {});
		}).not.toThrow();
		expect(Date.now() - start).toBeLessThan(1000);
		expect(redacted).not.toContain("abc");
	});
});

// -----------------------------------------------------------------------------
// Cancellation
// -----------------------------------------------------------------------------

describe("cancellation", () => {
	test("cancellation already signalled before spawn: never spawns, resolves cancelled:true immediately", async () => {
		const runnerCwd = mkdir("orch-live-qa-precancel-");
		const pidFile = join(mkdir("orch-live-qa-precancel-pid-"), "pid");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		process.env.FAKE_FORGE_MODE = "hang";
		process.env.FAKE_FORGE_PIDFILE = pidFile;

		const cancellation = new RunCancellation();
		cancellation.cancel();

		const result = await runLiveQa({ adapter, argv, signal: cancellation, onLine: () => {} });
		expect(result).toMatchObject({ exitCode: null, cancelled: true });
		expect(existsSync(pidFile)).toBe(false); // no child was ever spawned
	});

	test("hang mode: SIGINT is sent once, and the promise resolves only after the child has actually exited", async () => {
		const runnerCwd = mkdir("orch-live-qa-cancel-");
		const pidFile = join(mkdir("orch-live-qa-cancel-pid-"), "pid");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		process.env.FAKE_FORGE_MODE = "hang";
		process.env.FAKE_FORGE_PIDFILE = pidFile;

		const cancellation = new RunCancellation();
		// Tracked for teardown the instant `spawn()` returns, via `onSpawn` — independent of whether
		// the fixture ever manages to write its pidfile within the readiness wait below. This
		// guarantees `afterEach` can always reap the child even if the readiness wait itself throws.
		const promise = runLiveQa({
			adapter,
			argv,
			signal: cancellation,
			onLine: () => {},
			onSpawn: (pid) => {
				if (pid !== undefined) trackedPids.push(pid);
			},
		});

		await waitFor(() => existsSync(pidFile));
		const pid = Number(readFileSync(pidFile, "utf-8").trim());
		await waitFor(() => isAlive(pid));
		expect(isAlive(pid)).toBe(true);

		cancellation.cancel();
		// Calling cancel twice must never cause a second SIGKILL/second resolve; RunCancellation
		// itself only fires listeners once, which is exactly what guarantees "SIGINT exactly once".
		cancellation.cancel();

		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBe(130);
		expect(isAlive(pid)).toBe(false);
	});

	test("onSpawn fires synchronously with the child's pid, even when the runner never becomes ready", async () => {
		const runnerCwd = mkdir("orch-live-qa-onspawn-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		process.env.FAKE_FORGE_MODE = "hang";

		const cancellation = new RunCancellation();
		let spawnedPid: number | undefined;
		const promise = runLiveQa({
			adapter,
			argv,
			signal: cancellation,
			onLine: () => {},
			onSpawn: (pid) => {
				spawnedPid = pid;
				if (pid !== undefined) trackedPids.push(pid);
			},
		});

		expect(spawnedPid).toBeGreaterThan(0);
		cancellation.cancel();
		await promise;
	});
});

// -----------------------------------------------------------------------------
// Security hardening regressions (S1-S6).
// -----------------------------------------------------------------------------

describe("S1: hardened git config -- repo-controlled hooks/fsmonitor/filters never execute", () => {
	test("a malicious hook, fsmonitor command, and gitattributes clean filter never fire during a dirty checkpoint", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");

		const markerDir = mkdir("orch-live-qa-marker-");
		const hookMarker = join(markerDir, "hook-fired");
		const fsmonitorMarker = join(markerDir, "fsmonitor-fired");
		const filterMarker = join(markerDir, "filter-fired");

		// Wire the malicious filter via .gitattributes/.git/config -- deliberately left UNCOMMITTED
		// and never `git add`ed by this setup (an unhardened `git add`/`git commit` of a NEW
		// .gitattributes trips git's own attribute-stack refresh, which re-invokes the clean filter
		// on already-tracked paths under it as a side effect of THAT command -- a false positive
		// that has nothing to do with `prepareTestedRevision`'s own hardening). Untracked
		// .gitattributes on disk is exactly what a lead/worker's uncommitted edit would look like,
		// and is exactly what this checkpoint mechanism must handle safely.
		writeFileSync(join(dir, ".gitattributes"), "a.ts filter=evil\n");
		git(dir, "config", "filter.evil.clean", `sh -c "touch '${filterMarker}'; cat"`);

		// Dirtied via a plain filesystem write, verified via a plain filesystem read -- deliberately
		// NOT via any `git` invocation of our own (even a read-only `status`), since the filter is
		// ALREADY configured at this point and any unhardened git call here would trip the filter
		// marker itself, a false failure unrelated to `prepareTestedRevision`'s own hardening.
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("export const a = 2;\n");

		// NOW install the malicious hook and fsmonitor command -- strictly after every setup git
		// call above, so only `prepareTestedRevision`'s OWN (hardened) git calls can possibly fire
		// them.
		const hookPath = join(dir, ".git", "hooks", "reference-transaction");
		writeFileSync(hookPath, `#!/bin/sh\ntouch '${hookMarker}'\nexit 0\n`);
		execFileSync("chmod", ["+x", hookPath]);
		git(dir, "config", "core.fsmonitor", `sh -c "touch '${fsmonitorMarker}'; exit 0"`);

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-hardened", changedFiles: ["a.ts"] });

		expect(existsSync(hookMarker)).toBe(false);
		expect(existsSync(fsmonitorMarker)).toBe(false);
		expect(existsSync(filterMarker)).toBe(false);
		// Either it succeeded with the RAW (unfiltered) content, or it failed closed -- never ran
		// the filter/hook/fsmonitor command to get there.
		if (result.ok) {
			expect(execFileSync("git", ["show", `${result.sha}:a.ts`], { cwd: dir, encoding: "utf-8" })).toBe("export const a = 2;\n");
		}
	});
});

describe("S1a: repository-wide filter-attribute enumeration (not just changedFiles)", () => {
	test("a dirty tracked file OUTSIDE changedFiles with a repo-controlled clean filter refuses the whole checkpoint, even though only a.ts was reported", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		commitFile(dir, "b.ts", "export const b = 1;\n", "add b");

		const markerDir = mkdir("orch-live-qa-marker-s1a-");
		const filterMarker = join(markerDir, "filter-fired-s1a");
		// b.ts carries the malicious filter attribute; a.ts does not. `changedFiles` below reports
		// ONLY a.ts -- the previous (fixed) implementation checked only the reported files' own
		// attributes and would have let this proceed straight to `git status`, which itself invokes
		// b.ts's clean filter to answer "is b.ts dirty" (verified empirically: a plain, hardened
		// `git status --porcelain` on this exact setup fires the marker).
		writeFileSync(join(dir, ".gitattributes"), "b.ts filter=evil\n");
		git(dir, "config", "filter.evil.clean", `sh -c "touch '${filterMarker}'; cat"`);
		writeFileSync(join(dir, "b.ts"), "export const b = 2;\n"); // dirty, NOT in changedFiles
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n"); // dirty, IS in changedFiles

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-s1a-tracked", changedFiles: ["a.ts"] });

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("repository-local git config defines filter drivers");
		expect(existsSync(filterMarker)).toBe(false);
	});

	test("an untracked file OUTSIDE changedFiles with a repo-controlled clean filter also refuses the whole checkpoint", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");

		const markerDir = mkdir("orch-live-qa-marker-s1a-untracked-");
		const filterMarker = join(markerDir, "filter-fired-s1a-untracked");
		writeFileSync(join(dir, ".gitattributes"), "c.ts filter=evil\n");
		git(dir, "config", "filter.evil.clean", `sh -c "touch '${filterMarker}'; cat"`);
		writeFileSync(join(dir, "c.ts"), "export const c = 1;\n"); // untracked, never reported
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-s1a-untracked", changedFiles: ["a.ts"] });

		expect(result.ok).toBe(false);
		expect(existsSync(filterMarker)).toBe(false);
	});
});

describe("parseNulDelimitedShowScopeRecords: NUL-delimited git config -z parsing", () => {
	test("empty output (no matching entries) parses to an empty list, not null", () => {
		expect(parseNulDelimitedShowScopeRecords("")).toEqual([]);
	});

	test("a single local-scope entry with a plain single-line value", () => {
		const raw = "local\0filter.foo.clean\ncat\0";
		expect(parseNulDelimitedShowScopeRecords(raw)).toEqual(["local"]);
	});

	test("multiple entries, including one whose value contains an embedded literal newline", () => {
		const raw = "local\0filter.aaa.clean\nline1\nline2\0local\0filter.bbb.clean\ncat\0";
		expect(parseNulDelimitedShowScopeRecords(raw)).toEqual(["local", "local"]);
	});

	test("a global-scope entry is parsed as 'global', not conflated with 'local'", () => {
		const raw = "global\0filter.lfs.clean\ngit-lfs clean -- %f\0";
		expect(parseNulDelimitedShowScopeRecords(raw)).toEqual(["global"]);
	});

	test("output missing the trailing NUL is unparseable: fails closed with null, never silently treated as empty", () => {
		const raw = "local\0filter.foo.clean\ncat";
		expect(parseNulDelimitedShowScopeRecords(raw)).toBeNull();
	});

	test("an odd number of NUL-delimited fields is unparseable: fails closed with null", () => {
		const raw = "local\0filter.foo.clean\ncat\0dangling\0";
		expect(parseNulDelimitedShowScopeRecords(raw)).toBeNull();
	});

	test("a record whose key/value half has no newline separator at all is unparseable: fails closed with null", () => {
		const raw = "local\0no-newline-here\0";
		expect(parseNulDelimitedShowScopeRecords(raw)).toBeNull();
	});
});

describe("S1c: filter DRIVER config guard (authoritative -- runs before check-attr)", () => {
	for (const driverName of ["false", "unset", "unspecified"] as const) {
		test(`attribute value literally "${driverName}" plus a matching local filter.${driverName}.clean driver refuses the checkpoint (check-attr's text output cannot disambiguate this from a genuinely unset/negated attribute)`, () => {
			const dir = initRepo();
			commitFile(dir, "a.ts", "export const a = 1;\n", "init");
			const markerDir = mkdir("orch-live-qa-marker-s1c-");
			const marker = join(markerDir, `filter-fired-${driverName}`);
			writeFileSync(join(dir, ".gitattributes"), `a.ts filter=${driverName}\n`);
			git(dir, "config", `filter.${driverName}.clean`, `sh -c "touch '${marker}'; cat"`);
			writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

			const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: `test-s1c-${driverName}`, changedFiles: ["a.ts"] });

			expect(result.ok).toBe(false);
			expect(result.reason).toContain("repository-local git config defines filter drivers");
			expect(existsSync(marker)).toBe(false);
		});
	}

	test("a filter.<name>.clean value containing an embedded, literal newline is still detected as a local driver (NUL-delimited -z parsing, not line-based)", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const markerDir = mkdir("orch-live-qa-marker-s1c-multiline-");
		const marker = join(markerDir, "filter-fired-multiline");
		writeFileSync(join(dir, ".gitattributes"), "a.ts filter=evil\n");
		// The driver's own command VALUE embeds a literal newline -- without `-z`, the newline-based
		// parser this guard used to use would misread this single entry as two separate "lines", the
		// second of which has no scope prefix at all, and could therefore fail to recognize this as a
		// local-scope entry.
		git(dir, "config", "filter.evil.clean", `sh -c "touch '${marker}'\ncat"`);
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-s1c-multiline", changedFiles: ["a.ts"] });

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("repository-local git config defines filter drivers");
		expect(existsSync(marker)).toBe(false);
	});

	test("git rm --cached + .gitignore hides the file from both ls-files enumerations, but the driver-config guard still refuses (it never depends on path enumeration at all)", () => {
		const dir = initRepo();
		commitFile(dir, "tracked.ts", "secret content\n", "init");
		writeFileSync(join(dir, ".gitattributes"), "tracked.ts filter=evil\n");
		git(dir, "add", ".gitattributes");
		git(dir, "commit", "-q", "-m", "attrs");
		git(dir, "rm", "--cached", "-q", "tracked.ts");
		writeFileSync(join(dir, ".gitignore"), "tracked.ts\n");

		const markerDir = mkdir("orch-live-qa-marker-s1c-rmcached-");
		const marker = join(markerDir, "filter-fired-rmcached");
		git(dir, "config", "filter.evil.clean", `sh -c "touch '${marker}'; cat"`);

		// tracked.ts is now invisible to BOTH `ls-files -z` (removed from the index) and
		// `ls-files -z --others --exclude-standard` (untracked but ignored) -- exactly the gap
		// `git ls-tree -r -z --name-only HEAD` closes, and exactly what the driver-config guard
		// above makes irrelevant regardless of path enumeration.
		expect(git(dir, "ls-files")).not.toContain("tracked.ts");
		expect(git(dir, "ls-files", "--others", "--exclude-standard")).not.toContain("tracked.ts");

		// Something else dirty, so the checkpoint path (read-tree HEAD, which restores tracked.ts
		// from HEAD into the temp index) is actually exercised.
		writeFileSync(join(dir, "other.txt"), "dirty\n");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-s1c-rmcached", changedFiles: ["other.txt"] });

		expect(result.ok).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});

	test("a filter driver configured via a LOCAL .git/config `include.path` pointing at an external file is detected (git attributes its scope to the including LOCAL file)", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const includeDir = mkdir("orch-live-qa-include-s1c-");
		const includedConfig = join(includeDir, "included.gitconfig");
		const marker = join(includeDir, "filter-fired-include");
		writeFileSync(includedConfig, `[filter "evil"]\n\tclean = sh -c "touch '${marker}'; cat"\n`);
		writeFileSync(
			join(dir, ".git", "config"),
			readFileSync(join(dir, ".git", "config"), "utf-8") + `\n[include]\n\tpath = ${includedConfig}\n`,
		);
		writeFileSync(join(dir, ".gitattributes"), "a.ts filter=evil\n");
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-s1c-include", changedFiles: ["a.ts"] });

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("repository-local git config defines filter drivers");
		expect(existsSync(marker)).toBe(false);
	});

	test("a repo with ONLY a GLOBAL filter driver (no local/worktree drivers) still checkpoints normally -- global/operator-trusted drivers are allowed", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const globalDir = mkdir("orch-live-qa-global-s1c-");
		const globalConfig = join(globalDir, "gitconfig");
		const marker = join(globalDir, "global-filter-fired");
		// A harmless global driver, mirroring an operator-installed `git-lfs`: `a.ts` below carries no
		// `filter=` attribute at all, so this driver is never actually invoked either way -- this test
		// only proves the driver-config guard itself does not refuse on a GLOBAL-scope entry.
		writeFileSync(globalConfig, `[filter "global-lfs"]\n\tclean = sh -c "touch '${marker}'; cat"\n\tsmudge = cat\n\trequired = false\n`);
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");

		const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = globalConfig;
		try {
			const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-s1c-global", changedFiles: ["a.ts"] });
			expect(result.ok).toBe(true);
			expect(result.checkpoint).toBe(true);
		} finally {
			if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
		}
	});
});

describe("Performance: the check-attr/ls-files/ls-tree preflight scales to thousands of files", () => {
	test("a repository with ~5000 tracked files completes prepareTestedRevision in well under 5s", () => {
		const dir = initRepo();
		const gitCwd = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		for (let i = 0; i < 5000; i++) {
			writeFileSync(join(dir, `file-${i}.txt`), `content ${i}\n`);
		}
		gitCwd("add", "-A");
		gitCwd("commit", "-q", "-m", "bulk add 5000 files");

		const start = Date.now();
		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-perf-5000", changedFiles: [] });
		const elapsed = Date.now() - start;

		expect(result.ok).toBe(true);
		expect(elapsed).toBeLessThan(5000);
	}, 30_000);
});

describe("S1b: no-network git -- lazy/promisor fetch never runs a repo-controlled transport command", () => {
	test("a runner configured as a partial-clone/promisor remote with a marker-writing sshCommand never fetches; proof is unavailable, marker never fires", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const staleClone = mkdir("orch-live-qa-clone-promisor-");
		rmSync(staleClone, { recursive: true, force: true });
		execFileSync("git", ["clone", "-q", dir, staleClone], { stdio: "pipe" });
		// Advance the candidate after cloning, so the runner (staleClone) is missing this commit --
		// exactly the condition under which git's own on-demand promisor fetch would normally kick in.
		commitFile(dir, "a.ts", "export const a = 2;\n", "second");

		const markerDir = mkdir("orch-live-qa-promisor-marker-");
		const marker = join(markerDir, "ssh-fired");
		const sshScript = join(markerDir, "ssh.sh");
		writeFileSync(sshScript, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
		execFileSync("chmod", ["+x", sshScript]);

		git(staleClone, "config", "remote.origin.promisor", "true");
		git(staleClone, "config", "remote.origin.url", "ssh://example.invalid/x");
		git(staleClone, "config", "core.sshCommand", sshScript);
		git(staleClone, "config", "extensions.partialClone", "origin");
		git(staleClone, "config", "core.repositoryformatversion", "1");

		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: staleClone, runId: "test-promisor", changedFiles: ["a.ts"] });

		expect(result.ok).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("S1: hardened git config (isolated commands)", () => {
	test("gitCommonDirReal-affecting rev-parse and the checkpoint's status/hash-object/update-index/write-tree/commit-tree calls never touch a repo-controlled fsmonitor hook", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const markerDir = mkdir("orch-live-qa-marker2-");
		const fsmonitorMarker = join(markerDir, "fsmonitor-fired-2");
		git(dir, "config", "core.fsmonitor", `sh -c "touch '${fsmonitorMarker}'; exit 0"`);
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId: "test-hardened-2", changedFiles: ["a.ts"] });
		expect(result.ok).toBe(true);
		expect(existsSync(fsmonitorMarker)).toBe(false);
	});
});

describe("S2: update-ref is create-only", () => {
	test("a pre-existing symbolic ref at the checkpoint path is never moved; result is unavailable", () => {
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const runId = "test-preexisting-ref";
		const ref = `refs/orchestrator/live-qa/${runId}`;
		const branchRef = git(dir, "symbolic-ref", "HEAD").trim();
		git(dir, "symbolic-ref", ref, branchRef);

		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId, changedFiles: ["a.ts"] });

		expect(result.ok).toBe(false);
		expect(git(dir, "symbolic-ref", "HEAD").trim()).toBe(branchRef);
		expect(git(dir, "symbolic-ref", ref).trim()).toBe(branchRef);
	});

	test("a DANGLING pre-existing symbolic ref (pointing at a branch that does not exist) is never converted into a real ref; result is unavailable", () => {
		// S2 (escalated): `git update-ref --no-deref <ref> <sha> <40 zeros>` alone is NOT sufficient --
		// a dangling symbolic ref has no resolvable SHA of its own, so git's old-value comparison
		// reads it as "ref does not exist" and happily replaces it with a brand-new plain ref
		// (verified empirically). The fix checks `git symbolic-ref -q`/`git show-ref --verify -q`
		// BEFORE ever calling `update-ref`.
		const dir = initRepo();
		commitFile(dir, "a.ts", "export const a = 1;\n", "init");
		const runId = "test-dangling-ref";
		const ref = `refs/orchestrator/live-qa/${runId}`;
		git(dir, "symbolic-ref", ref, "refs/heads/does-not-exist");

		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		const result = prepareTestedRevision({ candidateCwd: dir, runnerCwd: dir, runId, changedFiles: ["a.ts"] });

		expect(result.ok).toBe(false);
		// The ref is still the SAME dangling symbolic ref -- never quietly converted into a real ref
		// pointing at the checkpoint commit.
		expect(git(dir, "symbolic-ref", "-q", ref).trim()).toBe("refs/heads/does-not-exist");
	});
});

describe("S5: sessions-root confinement", () => {
	test("a symlinked qa directory under runner_cwd makes the session unavailable, never followed", () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		const outsideDir = mkdir("orch-live-qa-outside-qa-");
		mkdirSync(join(outsideDir, "sessions", "run-20200101-000000-aaaa"), { recursive: true });
		symlinkSync(outsideDir, join(runnerCwd, "qa"));

		const verdict = parseLiveQaSession({
			runnerCwd,
			reportPath: join(runnerCwd, "qa", "sessions", "run-20200101-000000-aaaa", "report.md"),
			runnerRunId: "run-20200101-000000-aaaa",
			exitCode: 0,
			startedAtMs: Date.now(),
		});
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toMatch(/symlink/);
	});

	test("a symlinked qa/sessions directory makes the session unavailable, never followed", () => {
		const runnerCwd = mkdir("orch-live-qa-runner-");
		mkdirSync(join(runnerCwd, "qa"), { recursive: true });
		const outsideSessions = mkdir("orch-live-qa-outside-sessions-");
		symlinkSync(outsideSessions, join(runnerCwd, "qa", "sessions"));

		const verdict = parseLiveQaSession({
			runnerCwd,
			reportPath: join(runnerCwd, "qa", "sessions", "run-20200101-000000-bbbb", "report.md"),
			runnerRunId: "run-20200101-000000-bbbb",
			exitCode: 0,
			startedAtMs: Date.now(),
		});
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toMatch(/symlink/);
	});
});

describe("S7: ancestor directory ownership/writability (verifyTrustedAncestry, TOCTOU mitigation)", () => {
	test("a group/world-writable directory in the chain is rejected, even when it is otherwise a real, owned, non-symlinked directory", () => {
		const root = realpathSync(mkdir("orch-live-qa-ancestry-root-"));
		const session = join(root, "session");
		mkdirSync(session);
		chmodSync(session, 0o777);

		const result = verifyTrustedAncestry(session, root);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/writable/);
	});

	test("a symlinked ancestor directory between fromDir and the trusted root is rejected, never followed", () => {
		const root = realpathSync(mkdir("orch-live-qa-ancestry-root2-"));
		mkdirSync(join(root, "outside", "deep"), { recursive: true });
		mkdirSync(join(root, "mid"));
		// "linked" is an ancestor of `fromDir` below, not `fromDir` itself -- proving the walk
		// re-lstats EVERY ancestor path (not merely the leaf `fromDirReal` it was called with), since
		// `fromDirReal` is only ever resolved/verified once, by the CALLER, before this function ever
		// runs.
		symlinkSync(join(root, "outside"), join(root, "mid", "linked"));
		const fromDir = join(root, "mid", "linked", "deep");

		const result = verifyTrustedAncestry(fromDir, root);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/symlink/);
	});

	test("a fully owned, non-writable-by-others chain from fromDir up to and including the trusted root is accepted", () => {
		const root = realpathSync(mkdir("orch-live-qa-ancestry-root3-"));
		const session = join(root, "qa", "sessions", "run-1");
		mkdirSync(session, { recursive: true });

		const result = verifyTrustedAncestry(session, root);
		expect(result.ok).toBe(true);
	});

	test("a real mktemp -d directory's full ancestry, up to filesystem root '/', passes (macOS /var/folders/.../T and /private/tmp-under-sticky-/tmp shapes alike)", () => {
		const root = realpathSync(mkdir("orch-live-qa-ancestry-realroot-"));
		const session = join(root, "session");
		mkdirSync(session);

		const result = verifyTrustedAncestry(session, root);
		expect(result.ok).toBe(true);
	});

	test("a group/world-writable, non-sticky directory ABOVE the trusted root is rejected -- an earlier version of this check stopped walking at (and including) the trusted root and never inspected anything above it", () => {
		const base = realpathSync(mkdir("orch-live-qa-ancestry-parent-"));
		const root = join(base, "root");
		mkdirSync(root);
		const session = join(root, "session");
		mkdirSync(session);
		chmodSync(base, 0o777); // group/world-writable, NOT sticky -- unlike /tmp, this must be rejected
		try {
			const result = verifyTrustedAncestry(session, root);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/writable/);
		} finally {
			chmodSync(base, 0o755);
		}
	});

	test("a sticky, root-owned directory (like /tmp, /private/tmp) with a trusted child is accepted; the same sticky directory with an UNTRUSTED (foreign-owned) child is rejected -- the sticky bit never launders trust for a child this process does not own (injected lstat: a real foreign-uid directory cannot be created without root)", () => {
		const uid = process.getuid!();
		const foreignUid = uid + 999_999;
		const mk = (dirUid: number, mode: number): { uid: number; mode: number; isSymbolicLink(): boolean; isDirectory(): boolean } => ({
			uid: dirUid,
			mode,
			isSymbolicLink: () => false,
			isDirectory: () => true,
		});

		const trustedStats: Record<string, ReturnType<typeof mk>> = {
			"/fake-ancestry/tmp/trusted-child": mk(uid, 0o700),
			"/fake-ancestry/tmp": mk(0, 0o1777),
			"/fake-ancestry": mk(0, 0o755),
			"/": mk(0, 0o755),
		};
		const trustedResult = verifyTrustedAncestry("/fake-ancestry/tmp/trusted-child", "/fake-ancestry/tmp/trusted-child", {
			lstat: (p) => {
				const s = trustedStats[p];
				if (!s) throw new Error(`test bug: unexpected lstat(${p})`);
				return s;
			},
		});
		expect(trustedResult.ok).toBe(true);

		const foreignStats: Record<string, ReturnType<typeof mk>> = {
			"/fake-ancestry/tmp/foreign-child": mk(foreignUid, 0o755),
			"/fake-ancestry/tmp": mk(0, 0o1777),
			"/fake-ancestry": mk(0, 0o755),
			"/": mk(0, 0o755),
		};
		const foreignResult = verifyTrustedAncestry("/fake-ancestry/tmp/foreign-child", "/fake-ancestry/tmp/foreign-child", {
			lstat: (p) => {
				const s = foreignStats[p];
				if (!s) throw new Error(`test bug: unexpected lstat(${p})`);
				return s;
			},
		});
		expect(foreignResult.ok).toBe(false);
		if (!foreignResult.ok) expect(foreignResult.reason).toMatch(/uid/);
	});

	test("end-to-end: a group/world-writable real session directory makes parseLiveQaSession report unavailable, never a pass, even with fully valid artifacts", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		expect(result.exitCode).toBe(0);
		const sessionDir = dirname(result.reportPath!);
		chmodSync(sessionDir, 0o777);

		const verdict = parseLiveQaSession({
			runnerCwd,
			reportPath: result.reportPath,
			runnerRunId: result.runnerRunId,
			exitCode: result.exitCode,
			startedAtMs,
		});
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toMatch(/writable/);
	});
});

describe("TOCTOU-hardened artifact reads (readConfinedArtifact)", () => {
	test("a regular file within the size limit is read via the hardened open, with its fstat mtime returned", () => {
		const dir = realpathSync(mkdir("orch-live-qa-artifact-read-"));
		const p = join(dir, "findings.json");
		writeFileSync(p, "hello world");
		const lst = statSync(p);
		const result = readConfinedArtifact(p, dir, "findings.json", lst);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.content).toBe("hello world");
			expect(result.mtimeMs).toBeCloseTo(lst.mtimeMs, 0);
		}
	});

	test("a symlink swapped in after the confinement lstat is rejected by O_NOFOLLOW at open time, never followed", () => {
		const dir = mkdir("orch-live-qa-artifact-read-symlink-");
		const real = join(dir, "findings.json");
		writeFileSync(real, "original content");
		const lst = statSync(real); // the confinement check's own lstat, taken BEFORE the swap below
		const outsideTarget = mkdir("orch-live-qa-artifact-read-symlink-target-");
		writeFileSync(join(outsideTarget, "secret.json"), "attacker content");
		unlinkSync(real);
		symlinkSync(join(outsideTarget, "secret.json"), real);

		const result = readConfinedArtifact(real, dir, "findings.json", lst);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/symlink|not a regular file/i);
	});

	test("a FIFO artifact is rejected WITHOUT hanging (O_NONBLOCK keeps open from blocking; fstat then rejects the non-regular-file type)", async () => {
		const dir = mkdir("orch-live-qa-artifact-read-fifo-");
		const p = join(dir, "findings.json");
		execFileSync("mkfifo", [p]);
		const lst = statSync(p, { bigint: false });

		const start = Date.now();
		const result = await Promise.race([
			Promise.resolve(readConfinedArtifact(p, dir, "findings.json", lst)),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("readConfinedArtifact hung on a FIFO with no writer")), 2000)),
		]);
		expect(Date.now() - start).toBeLessThan(2000);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/not a regular file/i);
	});

	test("an artifact larger than MAX_ARTIFACT_BYTES is rejected as unreadable evidence, never partially read", () => {
		const dir = realpathSync(mkdir("orch-live-qa-artifact-read-oversized-"));
		const p = join(dir, "findings.json");
		// Sparse-ish large file: write in one shot slightly over the cap.
		writeFileSync(p, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x41));
		const lst = statSync(p);

		const result = readConfinedArtifact(p, dir, "findings.json", lst);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("over the");
	});

	test("dev/ino mismatch against the confinement-check lstat (a same-path swap to a different regular file) is detected", () => {
		const dir = mkdir("orch-live-qa-artifact-read-swap-");
		const p = join(dir, "findings.json");
		writeFileSync(p, "original");
		const lst = statSync(p);
		unlinkSync(p);
		writeFileSync(p, "replaced"); // new inode at the same path

		const result = readConfinedArtifact(p, dir, "findings.json", lst);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/device\/inode mismatch/);
	});

	// -------------------------------------------------------------------------
	// End-to-end via parseLiveQaSession: a real session's findings.json is swapped for a FIFO or
	// an oversized file AFTER a legitimate run produced it, proving the whole verdict-parsing path
	// (not merely the helper in isolation) fails closed without hanging.
	// -------------------------------------------------------------------------

	test("end-to-end: a FIFO in place of findings.json makes the session unavailable without hanging", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		const findingsPath = join(dirname(result.reportPath!), "findings.json");
		rmSync(findingsPath);
		execFileSync("mkfifo", [findingsPath]);

		const start = Date.now();
		const verdict = await Promise.race([
			Promise.resolve(parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs })),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("parseLiveQaSession hung on a FIFO artifact")), 2000)),
		]);
		expect(Date.now() - start).toBeLessThan(2000);
		expect(verdict.verdict).toBe("unavailable");
	});

	test("end-to-end: an oversized findings.json makes the session unavailable, never a pass", async () => {
		const { result, runnerCwd, startedAtMs } = await runFake("pass");
		const findingsPath = join(dirname(result.reportPath!), "findings.json");
		writeFileSync(findingsPath, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x7b));

		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("unavailable");
		expect(verdict.reasons.join(" ")).toContain("over the");
	});
});

describe("S6: bounded per-stream buffer", () => {
	test("a stream that writes >1MB with no newline at all is discarded outright (never buffered or emitted as content) and reported once as a byte-count marker", async () => {
		const runnerCwd = mkdir("orch-live-qa-flood-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		process.env.FAKE_FORGE_MODE = "flood_no_newline";
		const lines: string[] = [];
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: (l) => lines.push(l) });
		expect(result.exitCode).toBe(0);
		// S4/S6 (escalated): the previous behaviour re-emitted the oversized pending buffer as
		// cap-sized fragments, which is itself a leak surface (a secret straddling a fragment
		// boundary is never redacted in either half). The fixed behaviour discards the content
		// entirely and reports exactly one count-only marker line once the stream closes (the flood
		// never emits a newline of its own). The fixture's own two ordinary log lines before the
		// flood starts are unaffected.
		const markerLines = lines.filter((l) => /^\[live-qa\] output line exceeded 65536 bytes; \d+ bytes discarded$/.test(l));
		expect(markerLines.length).toBe(1);
		expect(markerLines[0]).toContain("2400000 bytes discarded");
		for (const l of lines) {
			expect(l).not.toContain("A".repeat(100));
			expect(l.length).toBeLessThan(200);
		}
		expect(result.tail).not.toContain("A".repeat(100));
	});
});

describe("S4/S6: a secret embedded in an overlong (>64KiB) unterminated line is discarded, never fragmented into onLine/tail", () => {
	test("no half of the secret leaks across the discard boundary, and parsing resumes on the next line (report/run-id still parsed)", async () => {
		const secretValue = "overflow-secret-value-987654321";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		const { result, lines } = await runFake("overflow_secret_then_recovers");
		expect(result.exitCode).toBe(0);
		const joined = lines.join("\n");
		expect(joined).not.toContain(secretValue);
		// Not even a fragment of either half leaks -- proves this is a discard, not a redaction that
		// could still miss a fragment straddling the cap boundary.
		expect(joined).not.toContain(secretValue.slice(0, 10));
		expect(joined).not.toContain(secretValue.slice(-10));
		expect(result.tail).not.toContain(secretValue);
		expect(lines.some((l) => /^\[live-qa\] output line exceeded 65536 bytes; \d+ bytes discarded$/.test(l))).toBe(true);
		// The discard does not corrupt the rest of the stream: subsequent lines still parse.
		expect(result.reportPath).toBeTruthy();
		expect(result.runnerRunId).toBeTruthy();
	});
});

describe("S3/S4: redaction at persistence (findings, multi-line secrets)", () => {
	test("a secret echoed into findings.json's own title/fingerprint is redacted before it enters the verdict, outcome, or cost rows", async () => {
		const secretValue = "findingsecretvalue123456";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		const { result, runnerCwd, startedAtMs } = await runFake("leaky_findings");
		const verdict = parseLiveQaSession({ runnerCwd, reportPath: result.reportPath, runnerRunId: result.runnerRunId, exitCode: result.exitCode, startedAtMs });
		expect(verdict.verdict).toBe("fail");
		const serializedVerdict = JSON.stringify(verdict);
		expect(serializedVerdict).not.toContain(secretValue);
		expect(serializedVerdict).toContain("[REDACTED]");

		const rows = liveQaCostRows({ runId: "run-1", taskId: "task-1", adapterId: "forge-focused", verdict });
		expect(JSON.stringify(rows)).not.toContain(secretValue);
	});

	test("a multi-line credential-shaped env value is redacted line-by-line, even when only one line is ever echoed at a time", async () => {
		const secretValue = "-----BEGIN KEY-----\nAAAAAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBB\n-----END KEY-----";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		const { lines } = await runFake("leaky_multiline");
		const joined = lines.join("\n");
		for (const component of secretValue.split("\n")) {
			expect(joined).not.toContain(component);
		}
		expect(joined).toContain("[REDACTED]");
	});
});

describe("sanitizeForPersistence: structured proof fields (git object ids) are never corrupted by substring redaction", () => {
	test("an env secret that is a SUBSTRING of a tested_revision/tested_tree/base_head sha is left byte-for-byte intact, never spliced with [REDACTED]", () => {
		const secretValue = "cafebabe12";
		process.env.FAKE_SECRET_ENV_VAR = secretValue;
		try {
			const shaWithSecretSubstring = `${secretValue}${"0".repeat(30)}`;
			expect(shaWithSecretSubstring).toHaveLength(40);
			const sha256WithSecretSubstring = `${secretValue}${"1".repeat(54)}`;
			expect(sha256WithSecretSubstring).toHaveLength(64);

			const value = {
				tested_revision: shaWithSecretSubstring,
				tested_tree: sha256WithSecretSubstring,
				base_head: shaWithSecretSubstring,
				unrelated_field: `token=${secretValue}-and-more-text`,
			};

			const sanitized = sanitizeForPersistence(value, process.env);

			expect(sanitized.tested_revision).toBe(shaWithSecretSubstring);
			expect(sanitized.tested_tree).toBe(sha256WithSecretSubstring);
			expect(sanitized.base_head).toBe(shaWithSecretSubstring);
			expect(sanitized.unrelated_field).not.toContain(secretValue);
			expect(sanitized.unrelated_field).toContain("[REDACTED]");
		} finally {
			delete process.env.FAKE_SECRET_ENV_VAR;
		}
	});

	test("numbers, booleans, and null pass through sanitizeForPersistence completely unchanged", () => {
		process.env.FAKE_SECRET_ENV_VAR = "somesecretvalue123456";
		try {
			const value = { cost_usd: 0.0025, checkpoint: true, session_id: null, count: 0 };
			const sanitized = sanitizeForPersistence(value, process.env);
			expect(sanitized).toEqual(value);
		} finally {
			delete process.env.FAKE_SECRET_ENV_VAR;
		}
	});
});

describe("S6 corollary: redactSecrets performance on a large secret-free line", () => {
	test("a single 64KB line with no matching secret/URL pattern redacts in well under a second (no catastrophic backtracking)", async () => {
		const runnerCwd = mkdir("orch-live-qa-flood2-");
		const adapter = fakeAdapter(runnerCwd);
		const argv = buildRunnerArgv(adapter, "scope", "HEAD");
		process.env.FAKE_FORGE_MODE = "flood_no_newline";
		const startedAt = Date.now();
		const result = await runLiveQa({ adapter, argv, signal: neverCancels(), onLine: () => {} });
		expect(result.exitCode).toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(3000);
	});
});

describe("URL userinfo redaction: linear-time manual scanner (replaces the length-capped regex)", () => {
	test("a userinfo longer than the old 256-char regex cap is still fully redacted", () => {
		// Escalated regression: the previous `[^/\s@]{1,256}` bounded quantifier existed to avoid
		// catastrophic backtracking, but as a side effect it made the WHOLE pattern fail to match
		// (leaking the credential entirely, unredacted) whenever the real userinfo was longer than
		// 256 characters -- a perfectly realistic password length.
		const longPassword = "p".repeat(300);
		const text = `connecting to postgres://dbuser:${longPassword}@db.example.com:5432/app`;
		const redacted = redactSecrets(text, {});
		expect(redacted).not.toContain(longPassword);
		expect(redacted).toBe("connecting to postgres://[REDACTED]@db.example.com:5432/app");
	});

	test("a 1MB line with no '://' at all redacts in well under 200ms (no pathological backtracking)", () => {
		const text = "x".repeat(1024 * 1024);
		const start = Date.now();
		redactSecrets(text, {});
		expect(Date.now() - start).toBeLessThan(200);
	});

	test("1MB of 'a://' repetitions redacts in well under 200ms", () => {
		const text = "a://".repeat(256 * 1024); // 1MB
		const start = Date.now();
		redactSecrets(text, {});
		expect(Date.now() - start).toBeLessThan(200);
	});

	test("a scheme not starting with a letter, or no '@' before the authority ends, is left untouched", () => {
		expect(redactSecrets("path is 1://not-a-scheme@host", {})).toContain("1://not-a-scheme@host");
		expect(redactSecrets("see https://example.com/path?x=1", {})).toBe("see https://example.com/path?x=1");
	});
});

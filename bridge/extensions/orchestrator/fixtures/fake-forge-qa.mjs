#!/usr/bin/env node
// Fake `bun qa run focused ...` for live-qa.test.ts. Emulates just enough of Forge's real
// scripts/qa/cli.ts runOne() output contract for the orchestrator adapter to parse against,
// without a real Forge checkout, Docker, or a QA agent. Never invoked by production code —
// tests point `argv_prefix` at [process.execPath, thisFile].
//
// Usage mirrors the real CLI: `fake-forge-qa.mjs run focused "<scope>" --slot 0 --ref <ref>
// --budget <n> --runtime <r> --model <m> --effort <e> --local`. `cwd` at spawn time is the
// adapter's `runner_cwd` ("repoRoot" in Forge's own terms).
//
// FAKE_FORGE_MODE selects behaviour:
//   pass               - exit 0, session with report.md + findings.json (no confirmed findings)
//   finding            - exit 0, session with one confirmed tier-1 finding (still a fail verdict)
//   tier3              - exit 0, session with one tier-3 (observation only) finding
//   preflight_fail     - exit 1, no session directory created at all
//   incomplete         - exit 1, session directory created but no findings.json
//   hang               - never exits on its own; exits 130 only after receiving SIGINT
//   cancel_writes_pass - never exits on its own UNTIL SIGINT, at which point it writes a full
//                        pass-shaped session (report.md + findings.json with no confirmed
//                        findings + usage.json + a PASS-only results.md) and exits 0 anyway --
//                        regression fixture proving a cancelled run's own "pass" verdict, even
//                        with genuinely valid artifacts and a clean exit, must never be trusted
//                        as a completed pass by the STAGE layer (live-qa-stage.ts), which is the
//                        only layer that knows the run was cancelled at all.
//   no_usage           - exit 0, session with report.md + findings.json, no usage.json
//   codex_unknown_cost - exit 0, usage.json with agent.costSource "unknown", costMicrocents null
//   leaky              - exit 0, pass-shaped session, but first logs lines containing a
//                        credential-shaped env var value, a `Bearer <token>`, and a URL with
//                        userinfo, so live-qa.test.ts can assert the adapter redacts them.
//   leaky_split        - exit 0, pass-shaped session; writes RAW (unprefixed) stdout in two
//                        separate `stdout.write` calls with a delay between them, splitting the
//                        credential-shaped env var value exactly in half across that boundary.
//                        Regression fixture for "redaction must operate on complete buffered
//                        lines, never per-chunk" -- a chunk-scoped redaction would never see
//                        either half match the full secret.
//
// Before any of the above: this fake mirrors Forge's own argv validation (scripts/qa/cli.ts
// parseArgs) closely enough for the orchestrator adapter's tests to exercise it end-to-end.
// An unknown flag, or a --model/--runtime/--effort value outside Forge's own alias tables, is a
// USAGE ERROR: exit code 2, nothing written to stderr but a one-line diagnostic, and — critically
// — NO qa/sessions/<runId> directory is ever created (mirrors Forge: `parseArgs` throws before
// `runOne` creates anything). This happens before any FAKE_FORGE_* instrumentation writes below.
//
// FAKE_FORGE_ARGV_LOG, if set, receives the exact argv (JSON array) this process was invoked
// with, so tests can assert on it without a shell (no injection surface to prove).
//
// FAKE_FORGE_PIDFILE, if set, receives this process's pid (as plain text) before any mode logic
// runs, so a test can poll for it and later confirm (via `process.kill(pid, 0)`) that the child
// has actually exited once the adapter's returned promise settles.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_FORGE_MODE ?? "pass";
const repoRoot = process.cwd();
const argv = process.argv.slice(2);

if (process.env.FAKE_FORGE_PIDFILE) {
	writeFileSync(process.env.FAKE_FORGE_PIDFILE, String(process.pid));
}

if (process.env.FAKE_FORGE_ARGV_LOG) {
	writeFileSync(process.env.FAKE_FORGE_ARGV_LOG, JSON.stringify(argv));
}

// -----------------------------------------------------------------------------
// Argv validation, mirroring Forge's scripts/qa/cli.ts parseArgs closely enough for
// live-qa.test.ts to exercise the "usage error" path end to end. Runs BEFORE any run id is
// minted or any log line is printed — an unknown flag or bad alias must produce exit 2 with
// no session directory and no `[qa slot=N run=<id>]` line at all, exactly like a real
// `parseArgs` throw.
// -----------------------------------------------------------------------------
const MODELS = new Set(["luna", "terra", "astra", "sol"]);
const HUMAIN_NODE_MODELS = new Set(["m3", "m3preview", "glm", "glm52", "qwen"]);
const CLAUDE_CODE_MODELS = new Set(["sonnet", "opus", "haiku", "fable"]);
const ALLOWED_FLAGS = new Set([
	"--slot", "--ref", "--budget", "--model", "--effort", "--runtime", "--local", "--flag", "--keep", "--verbose",
]);

function usageError(reason) {
	console.error(`fake-forge-qa: usage error: ${reason}`);
	process.exit(2);
}

for (const token of argv) {
	if (token.startsWith("--") && !ALLOWED_FLAGS.has(token)) usageError(`unknown flag ${token}`);
}
function getFlag(name) {
	const idx = argv.indexOf(`--${name}`);
	return idx >= 0 ? argv[idx + 1] : undefined;
}
const runtimeArg = getFlag("runtime") ?? "codex";
if (!["codex", "humain-terminal", "claude-code"].includes(runtimeArg)) usageError(`invalid runtime "${runtimeArg}"`);
const effortArg = getFlag("effort") ?? "medium";
if (!["low", "medium", "high", "xhigh"].includes(effortArg)) usageError(`invalid effort "${effortArg}"`);
const modelArg = getFlag("model") ?? (runtimeArg === "claude-code" ? "sonnet" : "terra");
const isNodeModel = runtimeArg !== "claude-code" && HUMAIN_NODE_MODELS.has(modelArg);
const modelArgOk = runtimeArg === "claude-code" ? CLAUDE_CODE_MODELS.has(modelArg) : isNodeModel || MODELS.has(modelArg);
if (!modelArgOk) usageError(`invalid model "${modelArg}" for runtime "${runtimeArg}"`);
if (isNodeModel && runtimeArg !== "humain-terminal") usageError("HUMAIN Node models require the humain-terminal runtime");

function nowIso() {
	return new Date().toISOString();
}

function newRunId() {
	const now = new Date();
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
	const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	return `run-${stamp}-${hex}`;
}

function log(line) {
	console.log(`[${nowIso()}] [qa slot=0 run=${runId}] ${line}`);
}

const slotIdx = argv.indexOf("--slot");
const slot = slotIdx >= 0 ? argv[slotIdx + 1] : "0";
const runId = newRunId();

log(`focused: scope=${argv[2] ?? ""} | ref=${argv[argv.indexOf("--ref") + 1] ?? "HEAD"} | slot=${slot}`);
log("QA session starting");

// Realistic results.md content mirroring Forge's own prompt contract (scripts/qa/prompts/
// common.md item 3): a Markdown table with a `Result` column of exactly PASS|FAIL|BLOCKED.
const RESULTS_MD_PASS = "| Step | Result |\n| --- | --- |\n| login flow | PASS |\n";
const RESULTS_MD_FAIL = "| Step | Result |\n| --- | --- |\n| login flow | FAIL |\n";
const RESULTS_MD_BLOCKED = "| Step | Result |\n| --- | --- |\n| login flow | BLOCKED |\n";

function writeSession(opts) {
	const durable = join(repoRoot, "qa", "sessions", runId);
	mkdirSync(durable, { recursive: true });
	writeFileSync(join(durable, "report.md"), "# Fake QA report\n\nSTATUS: fake\n");
	if (opts.findings !== undefined) {
		writeFileSync(join(durable, "findings.json"), JSON.stringify({ findings: opts.findings }));
	}
	if (opts.usage !== undefined) {
		writeFileSync(join(durable, "usage.json"), JSON.stringify(opts.usage));
	}
	// `results` may be a string (exact content), `null` (omit the file entirely), or undefined
	// (default: a valid PASS-only table) -- see FAKE_FORGE_MODE `results_*` variants below.
	if (opts.results !== null) {
		writeFileSync(join(durable, "results.md"), opts.results !== undefined ? opts.results : RESULTS_MD_PASS);
	}
	return join(durable, "report.md");
}

function baseUsage(overrides = {}) {
	return {
		version: 2,
		agent: {
			status: "recorded",
			runtime: "codex",
			model: "gpt-5.6-terra",
			provider: "openai-codex",
			effort: "medium",
			requestUnit: "codex_turn",
			requestsStarted: 3,
			requestsCompleted: 3,
			toolCalls: 5,
			inputTokens: 1000,
			cacheReadInputTokens: 200,
			cacheCreationInputTokens: 50,
			outputTokens: 300,
			reasoningOutputTokens: 100,
			totalTokens: 1300,
			costMicrocents: 250_000,
			costSource: "reported",
			elapsedMs: 60_000,
			...overrides.agent,
		},
		humainCode: overrides.humainCode ?? { status: "no_runs", runCount: 0, runs: [], totals: { inputTokens: null, outputTokens: null, costMicrocents: null }, costSource: "runs.cost_microcents" },
	};
}

function finish(exitCode, reportPath) {
	if (reportPath) {
		log(`QA session finished: exit=${exitCode}, signal=none, timedOut=false`);
		log(`report: ${reportPath}`);
	}
	process.exitCode = exitCode;
}

switch (mode) {
	case "pass": {
		const reportPath = writeSession({ findings: [], usage: baseUsage() });
		finish(0, reportPath);
		break;
	}
	case "finding": {
		const findings = [{
			fingerprint: "abc123def4567890",
			title: "Broken login flow",
			severity: "P1",
			tier: 1,
			confirmed: true,
			area: "auth",
			route: "/login",
			identity: "member",
			steps: ["open /login", "submit credentials"],
			expected: "login succeeds",
			actual: "login returns 500",
			evidenceDir: "evidence/finding-1",
			failureClass: "functional",
			symptom: "500 on submit",
			confidence: 0.95,
		}];
		const reportPath = writeSession({ findings, usage: baseUsage() });
		finish(0, reportPath);
		break;
	}
	case "tier3": {
		const findings = [{
			fingerprint: "0000000000000001",
			title: "Minor copy nit",
			severity: "P3",
			tier: 3,
			confirmed: true,
			area: "marketing",
			route: "/pricing",
			identity: "visitor",
			steps: ["open /pricing"],
			expected: "copy reads correctly",
			actual: "typo in heading",
			evidenceDir: "evidence/tier3-1",
			failureClass: "cosmetic",
			symptom: "typo",
			confidence: 0.5,
		}];
		const reportPath = writeSession({ findings, usage: baseUsage() });
		finish(0, reportPath);
		break;
	}
	case "preflight_fail": {
		log("stack: docker not running");
		process.exitCode = 1;
		break;
	}
	case "incomplete": {
		const reportPath = writeSession({ usage: baseUsage() });
		finish(1, reportPath);
		break;
	}
	case "hang": {
		log("QA session running (will not exit on its own)");
		process.on("SIGINT", () => {
			log("received SIGINT; exiting 130 (no cleanup performed by this fake)");
			process.exit(130);
		});
		setInterval(() => {}, 1 << 30); // keep the event loop alive
		break;
	}
	case "cancel_writes_pass": {
		log("QA session running (will not exit on its own; SIGINT writes full pass artifacts and exits 0 anyway)");
		const keepAlive = setInterval(() => {}, 1 << 30);
		process.on("SIGINT", () => {
			log("received SIGINT; racing to write pass artifacts and exit 0 anyway");
			clearInterval(keepAlive);
			const reportPath = writeSession({ findings: [], usage: baseUsage() });
			finish(0, reportPath);
			process.exit(0);
		});
		break;
	}
	case "no_usage": {
		const reportPath = writeSession({ findings: [] });
		finish(0, reportPath);
		break;
	}
	case "results_blocked": {
		// Clean exit, clean findings, but results.md itself reports a BLOCKED step: T5 says this
		// is unavailable (blocked is not a pass), never PASS, regardless of exit code/findings.
		const reportPath = writeSession({ findings: [], usage: baseUsage(), results: RESULTS_MD_BLOCKED });
		finish(0, reportPath);
		break;
	}
	case "results_fail": {
		// Clean exit, clean findings, but results.md itself reports a FAIL step: T5 says this is a
		// fail even though nothing else in the session says so.
		const reportPath = writeSession({ findings: [], usage: baseUsage(), results: RESULTS_MD_FAIL });
		finish(0, reportPath);
		break;
	}
	case "results_missing": {
		// Clean exit, clean findings, but results.md is never written at all: T5 says missing
		// results.md is unavailable, never a pass.
		const reportPath = writeSession({ findings: [], usage: baseUsage(), results: null });
		finish(0, reportPath);
		break;
	}
	case "codex_unknown_cost": {
		const reportPath = writeSession({
			findings: [],
			usage: baseUsage({ agent: { costMicrocents: null, costSource: "unknown" } }),
		});
		finish(0, reportPath);
		break;
	}
	case "leaky": {
		log(`env value: ${process.env.FAKE_SECRET_ENV_VAR ?? ""}`);
		log("auth header: Bearer abcdef123456");
		log("db: postgres://leakuser:leakpass1@localhost:5432/appdb");
		const reportPath = writeSession({ findings: [], usage: baseUsage() });
		finish(0, reportPath);
		break;
	}
	case "leaky_final_line": {
		const secret = process.env.FAKE_SECRET_ENV_VAR ?? "";
		const reportPath = writeSession({ findings: [], usage: baseUsage() });
		process.stdout.write(`final secret: ${secret}`);
		finish(0, reportPath);
		break;
	}
	case "leaky_split": {
		const secret = process.env.FAKE_SECRET_ENV_VAR ?? "";
		const half = Math.ceil(secret.length / 2);
		// Two separate raw writes with a delay between them so Node delivers them as two distinct
		// 'data' events on the parent's pipe -- never merged back into one chunk by the OS/Node
		// before the adapter reads them. Deliberately bypasses `log()` (no timestamp/run-id prefix
		// on this particular line) so the secret's two halves are exactly adjacent across the
		// write boundary, with nothing else able to accidentally separate them.
		process.stdout.write(`secret-part1:${secret.slice(0, half)}`);
		setTimeout(() => {
			process.stdout.write(`${secret.slice(half)}:secret-part2\n`);
			const reportPath = writeSession({ findings: [], usage: baseUsage() });
			finish(0, reportPath);
		}, 50);
		break;
	}
	case "leaky_findings": {
		// S3/S4 regression fixture: a secret echoed into findings.json's OWN title/fingerprint
		// fields, never into stdout/stderr at all -- proves redaction is applied at persistence
		// (parseLiveQaSession), not merely to the runner's stdout stream.
		const secret = process.env.FAKE_SECRET_ENV_VAR ?? "";
		const findings = [{
			fingerprint: `fp-${secret}`,
			title: `Leaked secret ${secret} in login flow`,
			severity: "P1", tier: 1, confirmed: true, area: "auth", route: "/login", identity: "member",
			steps: ["open /login"], expected: "login succeeds", actual: "secret leaked",
			evidenceDir: "evidence/leak-1", failureClass: "functional", symptom: "leak", confidence: 0.9,
		}];
		const reportPath = writeSession({ findings, usage: baseUsage() });
		finish(0, reportPath);
		break;
	}
	case "leaky_multiline": {
		// S4 regression fixture: a multi-line (PEM-style) credential-shaped env value, echoed ONE
		// LINE AT A TIME (never the whole value on a single line) -- proves redaction operates on
		// each newline-split COMPONENT of the env value, not only on a whole-value match.
		const secret = process.env.FAKE_SECRET_ENV_VAR ?? "";
		for (const line of secret.split("\n")) {
			log(`pem line: ${line}`);
		}
		const reportPath = writeSession({ findings: [], usage: baseUsage() });
		finish(0, reportPath);
		break;
	}
	case "flood_no_newline": {
		// S6 regression fixture: >1MB written with NO newline at all, so the adapter's per-stream
		// pending-buffer cap (never the runner's own behaviour) is what keeps memory bounded.
		const chunk = "A".repeat(200_000);
		for (let i = 0; i < 12; i++) process.stdout.write(chunk);
		process.exitCode = 0;
		break;
	}
	case "overflow_secret_then_recovers": {
		// S4/S6 regression fixture: a pending line exceeds the 64KiB discard cap WITHOUT a newline
		// while a credential-shaped secret sits inside the overflowing span -- proves the secret is
		// discarded OUTRIGHT (never emitted as a redacted fragment straddling the cap boundary), and
		// that ordinary parsing (report:/run= lines) resumes correctly once a newline finally
		// arrives.
		const secret = process.env.FAKE_SECRET_ENV_VAR ?? "";
		const padding = "P".repeat(65530);
		process.stdout.write(`${padding}${secret}more-tail-no-newline`);
		process.stdout.write("\n");
		const reportPath = writeSession({ findings: [], usage: baseUsage() });
		finish(0, reportPath);
		break;
	}
	default: {
		console.error(`fake-forge-qa: unknown FAKE_FORGE_MODE "${mode}"`);
		process.exitCode = 2;
	}
}

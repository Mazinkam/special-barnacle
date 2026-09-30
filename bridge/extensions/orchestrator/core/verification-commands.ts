/**
 * Picks the verification commands QA and leads are told to run, based on the repo the run is
 * actually operating in. The orchestrator's own suites (pytest, `bun test ./bridge`,
 * typecheck-bridge) only exist in this skill repo; running them from another repo's cwd always
 * fails and used to burn every escalation retry on a verdict that could never pass.
 *
 * Reads only files under the given `repoRoot` (never `process.cwd()`), so callers stay explicit.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type VerificationSource = "orchestrator-repo" | "package-scripts" | "project-docs";

export interface VerificationPlan {
	source: VerificationSource;
	/** Concrete commands to run from the repo root. Empty for `project-docs`. */
	commands: readonly string[];
	/** Repo guidance file (e.g. AGENTS.md) whose test rules take precedence, if present. */
	guidanceFile: string | null;
}

/** The skill repo's own canonical verification commands (README.md "Verify" section). */
export const ORCHESTRATOR_VERIFICATION_COMMANDS: readonly string[] = [
	"python3 -B -m pytest -p no:cacheprovider -q",
	"bun test ./bridge",
	"./scripts/typecheck-bridge.sh --all",
];

/** Used when nothing about the repo is known; pure, so prompt formatters can default to it. */
export const DOCUMENTED_VERIFICATION: VerificationPlan = { source: "project-docs", commands: [], guidanceFile: null };

/** package.json scripts offered as verification, in order. `test` is deliberately excluded:
 *  some repos (e.g. humain-terminal) forbid running their full suite. */
const SCRIPT_NAMES = ["check", "typecheck", "lint"] as const;

const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

function isOrchestratorRepo(repoRoot: string): boolean {
	return (
		existsSync(join(repoRoot, "orchestrator", "method.json")) &&
		existsSync(join(repoRoot, "bridge", "extensions", "orchestrator")) &&
		existsSync(join(repoRoot, "scripts", "typecheck-bridge.sh"))
	);
}

function scriptRunner(repoRoot: string): string {
	if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun run";
	if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm run";
	if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
	return "npm run";
}

function packageScripts(repoRoot: string): string[] {
	const manifest = join(repoRoot, "package.json");
	if (!existsSync(manifest)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
		if (!parsed || typeof parsed !== "object") return [];
		const scripts = (parsed as { scripts?: unknown }).scripts;
		if (!scripts || typeof scripts !== "object") return [];
		return SCRIPT_NAMES.filter((name) => typeof (scripts as Record<string, unknown>)[name] === "string");
	} catch {
		return [];
	}
}

export function resolveVerificationPlan(repoRoot: string): VerificationPlan {
	if (isOrchestratorRepo(repoRoot)) {
		return { source: "orchestrator-repo", commands: ORCHESTRATOR_VERIFICATION_COMMANDS, guidanceFile: null };
	}
	const guidanceFile = GUIDANCE_FILES.find((name) => existsSync(join(repoRoot, name))) ?? null;
	const scripts = packageScripts(repoRoot);
	if (scripts.length > 0) {
		const runner = scriptRunner(repoRoot);
		return { source: "package-scripts", commands: scripts.map((name) => `${runner} ${name}`), guidanceFile };
	}
	return { source: "project-docs", commands: [], guidanceFile };
}

/** Prompt lines describing how to verify work in this repo. */
export function verificationLines(plan: VerificationPlan): string[] {
	if (plan.source === "orchestrator-repo") {
		return [`Verification commands: ${plan.commands.join(" · ")}`];
	}
	const guidance = plan.guidanceFile
		? `Follow the test rules in ${plan.guidanceFile} first (it may forbid full-suite runs).`
		: "Use the verification commands documented in this repo (README or contributor docs).";
	const tests =
		"Tests: run the targeted tests that cover the changed files, as this repo documents. Do not run the orchestrator skill's own suites (pytest, `bun test ./bridge`, typecheck-bridge) here.";
	if (plan.source === "package-scripts") {
		return [`Verification commands: ${plan.commands.join(" · ")}`, guidance, tests];
	}
	return ["Verification commands: this repo's own documented checks.", guidance, tests];
}

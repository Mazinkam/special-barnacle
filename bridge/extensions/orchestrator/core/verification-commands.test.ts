import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORCHESTRATOR_VERIFICATION_COMMANDS, resolveVerificationPlan, verificationLines } from "./verification-commands.ts";

const skillRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dirs: string[] = [];
function repo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "verify-plan-"));
	dirs.push(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveVerificationPlan", () => {
	test("uses the orchestrator's own suites only inside the skill repo", () => {
		const plan = resolveVerificationPlan(skillRoot);
		expect(plan.source).toBe("orchestrator-repo");
		expect(plan.commands).toEqual(ORCHESTRATOR_VERIFICATION_COMMANDS);
	});

	test("uses package scripts with the repo's package manager and never the full test script", () => {
		const dir = repo({
			"package.json": JSON.stringify({ scripts: { test: "vitest", check: "biome check", typecheck: "tsc" } }),
			"bun.lock": "",
			"AGENTS.md": "# rules",
		});
		const plan = resolveVerificationPlan(dir);
		expect(plan).toEqual({ source: "package-scripts", commands: ["bun run check", "bun run typecheck"], guidanceFile: "AGENTS.md" });
		const text = verificationLines(plan).join("\n");
		expect(text).toContain("Follow the test rules in AGENTS.md first");
		expect(text).not.toContain("python3 -B -m pytest");
	});

	test("defaults to npm when no lockfile identifies another runner", () => {
		const dir = repo({ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }) });
		expect(resolveVerificationPlan(dir).commands).toEqual(["npm run lint"]);
	});

	test("falls back to the repo's documented checks when there is no usable manifest", () => {
		const dir = repo({ "package.json": "{not json", "CLAUDE.md": "# rules" });
		const plan = resolveVerificationPlan(dir);
		expect(plan).toEqual({ source: "project-docs", commands: [], guidanceFile: "CLAUDE.md" });
		expect(verificationLines(plan)[0]).toBe("Verification commands: this repo's own documented checks.");
	});

	test("does not treat a partial copy of the skill layout as the skill repo", () => {
		const dir = repo({ "orchestrator/method.json": "{}" });
		expect(resolveVerificationPlan(dir).source).toBe("project-docs");
	});
});

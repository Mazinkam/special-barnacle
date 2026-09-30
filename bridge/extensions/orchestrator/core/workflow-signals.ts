import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowPolicy } from "../models.ts";
import { discoverChecks, type DiscoveredCheck, type RepoReader } from "./check-discovery.ts";
import { matchesAny } from "./path-glob.ts";

export interface WorkflowSignals {
	candidates: string[]; packages: string[]; riskPathHits: string[]; interfaceHits: string[];
	testsNearby: boolean; checks: DiscoveredCheck[]; ambiguous: boolean; triageRisk: string; taskClass: string;
}

const TOKEN = /[\w@.\-]+(?:\/[\w@.\-]+)*\.[A-Za-z0-9]+|[\w@.\-]+(?:\/[\w@.\-]+)+/g;
const MAX_DIR_EXPANSION = 25;

function resolveCandidates(goal: string, files: string[]): string[] {
	const set = new Set(files);
	const out = new Set<string>();
	for (const raw of goal.match(TOKEN) ?? []) {
		const token = raw.replace(/^\.\//, "").replace(/[.,;:)]+$/, "");
		if (set.has(token)) { out.add(token); continue; }
		const underDir = files.filter((f) => f.startsWith(`${token.replace(/\/$/, "")}/`));
		if (underDir.length > 0) { underDir.slice(0, MAX_DIR_EXPANSION).forEach((f) => out.add(f)); continue; }
		if (!token.includes("/")) {
			const byBase = files.filter((f) => f === token || f.endsWith(`/${token}`));
			if (byBase.length === 1) out.add(byBase[0]);
		}
	}
	return [...out].sort();
}

function packageOf(file: string, files: Set<string>): string {
	const parts = file.split("/");
	for (let i = parts.length - 1; i > 0; i--) {
		const dir = parts.slice(0, i).join("/");
		if (files.has(`${dir}/package.json`) || files.has(`${dir}/pyproject.toml`)) return dir;
	}
	return ".";
}

const TEST_FILE = /(^|\/)(tests?\/|test_[^/]+\.py$|[^/]+\.(test|spec)\.[jt]sx?$)/;

function hasAdjacentTest(file: string, files: Set<string>): boolean {
	if (TEST_FILE.test(file)) return true;
	const slash = file.lastIndexOf("/");
	const dir = slash < 0 ? "" : file.slice(0, slash + 1);
	const base = file.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const stem = dot < 0 ? base : base.slice(0, dot);
	const ext = dot < 0 ? "" : base.slice(dot + 1);
	const options = [`${dir}${stem}.test.${ext}`, `${dir}${stem}.spec.${ext}`, `${dir}test_${stem}.py`, `tests/test_${stem}.py`];
	return options.some((o) => files.has(o)) || [...files].some((f) => f.startsWith("tests/") && f.endsWith(`/test_${stem}.py`));
}

export function collectWorkflowSignals(input: { goal: string; files: string[]; reader: RepoReader; triageRisk: string; taskClass: string; policy: WorkflowPolicy }): WorkflowSignals {
	const fileSet = new Set(input.files);
	const candidates = resolveCandidates(input.goal, input.files);
	const packages = [...new Set(candidates.map((f) => packageOf(f, fileSet)))].sort();
	const hits = (globs: string[]) => candidates.flatMap((f) => matchesAny(f, globs).map((g) => `${f} ⇐ ${g}`));
	return {
		candidates,
		packages,
		riskPathHits: hits(input.policy.risk_path_globs),
		interfaceHits: hits(input.policy.interface_globs),
		testsNearby: candidates.length > 0 && candidates.every((f) => hasAdjacentTest(f, fileSet)),
		checks: discoverChecks(input.reader, packages.length ? packages : ["."]),
		ambiguous: candidates.length === 0,
		triageRisk: input.triageRisk,
		taskClass: input.taskClass,
	};
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

export function listRepoFiles(cwd: string, timeoutMs: number): string[] | null {
	try {
		const out = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "ls-files", "-z"], { cwd, env: GIT_ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
		return out.toString("utf8").split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

export function fsReader(root: string): RepoReader {
	return {
		exists: (rel) => existsSync(join(root, rel)),
		read: (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } },
	};
}

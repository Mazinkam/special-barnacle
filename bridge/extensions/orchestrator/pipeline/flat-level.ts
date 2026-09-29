import type { DispatchTask } from "../core/prompts.ts";
import type { DispatchResult } from "../core/records.ts";
import type { DiscoveredCheck } from "../core/check-discovery.ts";
import { runChecks as defaultRunChecks, type CheckRunResult } from "./check-runner.ts";
import type { ResolvedCheck } from "./hierarchy.ts";
import { hasExplicitFailVerdict, type VerificationResult } from "./verify-loop.ts";

const REPORT_CONTRACT = [
	"When done, end your reply with:",
	"## Files Changed",
	"- <each repo-relative path you modified, or 'None'>",
	"",
	"STATUS: completed|partial|blocked",
].join("\n");

export function implementerTask(runId: string, goal: string, providedContext: string, level: "direct" | "checked"): DispatchTask {
	return {
		taskId: `${runId}-impl`,
		capability: "implementation_strong",
		task: [
			`Workflow level: ${level}. You are the only implementer; there is no lead or architect.`,
			"Make the smallest correct change for the goal. Run the repository's relevant tests before finishing.",
			"Do not modify tests to make them pass unless the goal asks for it. Do not add dependencies.",
			"",
			"## Goal",
			goal,
			...(providedContext ? ["", "## Provided context", providedContext] : []),
			"",
			REPORT_CONTRACT,
		].join("\n"),
	};
}

export type FlatDispatch = {
	leadResults: DispatchResult[]; workerResults: DispatchResult[]; architectResult: undefined; skippedLeads: number;
	leadTasks: DispatchTask[]; resumedLeadTaskIds: string[]; retriedLeadTaskIds: string[]; resumedAttemptResults: DispatchResult[]; pendingChecks: ResolvedCheck[];
};

export async function dispatchFlat(
	input: { runId: string; goal: string; providedContext: string; level: "direct" | "checked" },
	deps: { dispatch(tasks: DispatchTask[]): Promise<DispatchResult[]>; captureDispatchCost(r: DispatchResult): Promise<void> },
): Promise<FlatDispatch> {
	const task = implementerTask(input.runId, input.goal, input.providedContext, input.level);
	const results = await deps.dispatch([task]);
	for (const r of results) await deps.captureDispatchCost(r);
	return { leadResults: results, workerResults: [], architectResult: undefined, skippedLeads: 0, leadTasks: [task],
		resumedLeadTaskIds: [], retriedLeadTaskIds: [], resumedAttemptResults: [], pendingChecks: [] };
}

const stripEmphasis = (line: string): string => {
	let t = line.trim();
	for (;;) {
		const m = /^(\*\*|__)(.*)\1$/.exec(t);
		if (!m) return t;
		t = m[2]!.trim();
	}
};

/** True when a fenced code block (CommonMark rules) is still open after scanning `lines`. */
function fenceOpenAfter(lines: string[]): boolean {
	let fence: { ch: string; len: number } | undefined;
	for (const line of lines) {
		const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!m) continue;
		const ch = m[1]![0]!;
		if (fence) {
			if (ch === fence.ch && m[1]!.length >= fence.len && m[2]!.trim() === "") fence = undefined;
		} else if (ch !== "`" || !m[2]!.includes("`")) {
			fence = { ch, len: m[1]!.length };
		}
	}
	return fence !== undefined;
}

/**
 * Strict positional contract (no Markdown parsing): the LAST line of the output is exactly `PASS`
 * (emphasis allowed) directly under a `## Verdict` heading, or exactly `VERDICT: PASS`; the verdict
 * is not inside an open fence or blockquote. Anything else is not an affirmative pass.
 */
function hasAffirmativePassVerdict(rawText: string): boolean {
	const lines = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((l) => l.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const last = lines.length - 1;
	if (last < 0) return false;
	const lastLine = lines[last]!;
	if (/^(\t| {4})/.test(lastLine) || lastLine.trimStart().startsWith(">")) return false;
	const body = stripEmphasis(lastLine);
	let start: number; // first line of the verdict block
	if (/^VERDICT:\s*(\*\*|__)?PASS(\*\*|__)?$/i.test(body)) {
		start = last;
	} else if (body === "PASS") {
		let h = last - 1;
		while (h >= 0 && lines[h]!.trim() === "") h--;
		if (h < 0 || !/^ {0,3}#{1,3}[ \t]+verdict$/i.test(lines[h]!)) return false;
		start = h;
	} else return false;
	if (start > 0 && lines[start - 1]!.trimStart().startsWith(">")) return false;
	if (fenceOpenAfter(lines.slice(0, start))) return false;
	return true;
}

function reviewTask(runId: string, goal: string, files: string[], checks: CheckRunResult[]): DispatchTask {
	return {
		taskId: `${runId}-review`,
		capability: "technical_review",
		tools: ["read", "grep", "find", "ls"],
		task: [
			"Independently review the change for the goal below. Read the changed files; do not edit anything.",
			"", "## Goal", goal,
			"", "## Changed files", ...files.map((f) => `- ${f}`),
			"", "## Deterministic checks", ...checks.map((c) => `- ${c.name}: ${c.status}`),
			"", "End your output with `## Verdict` on its own line and then, on the next line and as the LAST line of the output, exactly `PASS` or `FAIL` (nothing else on that line, nothing after it).",
			"If the verdict is FAIL, list the blocking issues BEFORE the `## Verdict` heading.",
		].join("\n"),
	};
}

export async function runFlatVerification(
	input: { runId: string; level: "direct" | "checked"; files: string[]; checks: DiscoveredCheck[]; repoRoot: string; checkTimeoutMs: number; goal: string },
	deps: { dispatch(tasks: DispatchTask[]): Promise<DispatchResult[]>; captureDispatchCost(r: DispatchResult): Promise<void>; recordOutcome(o: Record<string, unknown>): void; runChecks?: typeof defaultRunChecks },
): Promise<VerificationResult> {
	if (input.files.length === 0) return { passed: true, skipped: true, summary: "no files changed", failedChecks: [] };
	const results = await (deps.runChecks ?? defaultRunChecks)(input.checks, input.repoRoot, input.checkTimeoutMs);
	const failedChecks = results.filter((r) => r.status !== "pass").map((r) => r.name);
	let dispatch: DispatchResult | undefined;
	if (failedChecks.length === 0 && input.level === "checked") {
		[dispatch] = await deps.dispatch([reviewTask(input.runId, input.goal, input.files, results)]);
		if (dispatch) await deps.captureDispatchCost(dispatch);
		if (!dispatch || dispatch.exitCode !== 0 || hasExplicitFailVerdict(dispatch.stdout) || !hasAffirmativePassVerdict(dispatch.stdout)) failedChecks.push("review");
	}
	const passed = failedChecks.length === 0 && results.length > 0;
	if (results.length === 0) failedChecks.push("no deterministic checks ran");
	deps.recordOutcome({
		run_id: input.runId, task_id: `${input.runId}-qa`, verification_scope: "run",
		outcome: passed ? "verified" : "fail", verification: passed, workflow_level: input.level,
		checks: results.map((r) => ({ name: r.name, status: r.status === "pass" ? "pass" : "fail" })),
		check_commands: results.map((r) => r.argv.join(" ")),
		evidence_status: results.length ? "verified" : "unverified_checks_unavailable",
	});
	return { passed, summary: passed ? `${results.length} deterministic check(s) passed` : `failed: ${failedChecks.join(", ")}`, failedChecks, ...(dispatch ? { dispatch } : {}) };
}

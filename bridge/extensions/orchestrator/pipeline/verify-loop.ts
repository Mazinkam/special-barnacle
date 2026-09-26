/**
 * QA verification (B4.6): dispatch the QA agent against the union of files
 * changed by workers/leads and return a pass/fail verdict the caller's
 * escalation logic can act on. Parses a tolerant output shape: ANY "FAIL"
 * token in the QA output flips the verdict.
 *
 * pipeline/* must not import index.ts. `dispatch`/`captureDispatchCost`/
 * `recordOutcome` are required fields on `deps` (no default referencing an
 * index.ts singleton); index.ts's caller supplies its own real
 * `dispatchParallel`/`captureDispatchCost`/telemetry `recordOutcome`.
 */
import type { ExtensionContext } from "@humain/terminal";

import type { Adapter } from "../adapters/adapter-resolver.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { QA_SCOPE_RULES, type DispatchTask } from "../core/prompts.ts";
import type { RunContext } from "../run/context.ts";
import type { RunSession } from "../run/session.ts";

export interface VerificationResult {
	passed: boolean;
	summary: string;
	failedChecks: string[];
	/** True when no QA agent ran at all (nothing changed) — `passed` is vacuous. */
	skipped?: boolean;
	/** The QA dispatch, so the caller can bill it into the run total. */
	dispatch?: DispatchResult;
}

/** The dispatch/billing/telemetry seams `runVerification` needs; index.ts's caller supplies the real ones. */
export interface VerifyDeps {
	/** Fans a batch of tasks out to their own subprocesses; already bound to cwd/runId/adapter/ctx/run. */
	dispatch: (tasks: DispatchTask[]) => Promise<DispatchResult[]>;
	captureDispatchCost: (
		opts: CaptureOpts,
		result: DispatchResult,
		run: RunContext<RunSession> | null,
	) => Promise<void>;
	recordOutcome: (outcome: Record<string, unknown>) => void;
}

export function qaVerificationOutcomeFor(runId: string, passed: boolean, quality: number, note: string): Record<string, unknown> {
	return {
		run_id: runId,
		task_id: `${runId}-qa`,
		outcome: passed ? "verified" : "fail",
		verification_scope: "run",
		quality,
		note,
	};
}

export function parseFailedChecks(text: string): string[] {
	const fails: string[] = [];
	// Explicit failing status words, matched whole-word (case-insensitive) and not preceded by a
	// digit (so a leading count like "0 failed" is judged by nonZeroCountRe instead).
	const statusWordRe = /(?<!\d)(?<!\d\s)\b(FAILED|FAIL|ERROR)\b/i;
	// Failing symbols: never part of a count, always a standalone status marker.
	const statusSymbolRe = /[\u2717\u274c]/;
	const statusRe = (cell: string): boolean => statusWordRe.test(cell) || statusSymbolRe.test(cell);
	// A non-zero count of errors/failures, e.g. "2 errors", "1 failed" — but not "0 errors".
	const nonZeroCountRe = /\b[1-9]\d*\s+(error|errors|failed|failures?)\b/i;
	// Markdown table rows: `| label | status cell |`.
	const rowRe = /\|\s*([^|]+?)\s*\|\s*([^|]*)\|/g;
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(text)) !== null) {
		const label = m[1].trim();
		const cell = m[2];
		if (statusRe(cell) || nonZeroCountRe.test(cell)) {
			fails.push(label);
		}
	}
	// Bullet points labelled FAIL: `- foo: FAIL`.
	const bulletRe = /^[-*]\s+(.+?):\s*(.*)$/gim;
	while ((m = bulletRe.exec(text)) !== null) {
		const label = m[1].trim();
		const rest = m[2];
		if (statusRe(rest) || nonZeroCountRe.test(rest)) {
			fails.push(label);
		}
	}
	return Array.from(new Set(fails));
}

/**
 * Run the QA agent against the union of files changed by workers. Returns a
 * pass/fail verdict that downstream escalation logic can act on. Parses a
 * tolerant output shape: ANY "FAIL" token in the QA output flips the verdict.
 */
export async function runVerification(
	runId: string,
	planId: string,
	filesChanged: string[],
	ctx: ExtensionContext,
	/** The run this QA pass belongs to; threaded through to `deps.dispatch` and
	 *  `deps.captureDispatchCost` instead of an implicit "active run" read (B4.4). */
	run: RunContext<RunSession> | null,
	captureOpts: CaptureOpts,
	deps: VerifyDeps,
): Promise<VerificationResult> {
	if (filesChanged.length === 0) {
		return {
			passed: true,
			skipped: true,
			summary: "No files changed — verification skipped.",
			failedChecks: [],
		};
	}

	const qaTask = [
		`Run the project verification suite for these changed files:`,
		"",
		...filesChanged.map((f) => `- \`${f}\``),
		"",
		"Run typecheck, unit tests, integration tests, lint as applicable.",
		...QA_SCOPE_RULES,
		"Respond with the standard QA output format.",
	].join("\n");

	const [qaResult] = await deps.dispatch([{ capability: "qa_agent", task: qaTask, taskId: `${runId}-qa` }]);

	if (!qaResult) {
		return {
			passed: false,
			summary: "QA dispatch produced no result.",
			failedChecks: ["qa-dispatch"],
		};
	}

	// The QA agent is a billable dispatch like any other. Recording only its
	// outcome left its spend out of both metrics.jsonl and the run total.
	await deps.captureDispatchCost({ ...captureOpts, planId }, qaResult, run);

	const out = qaResult.stdout;
	const failedChecks = parseFailedChecks(out);
	const passed = qaResult.exitCode === 0 && failedChecks.length === 0;

	deps.recordOutcome(qaVerificationOutcomeFor(runId, passed, passed ? 0.95 : 0.0, out.slice(0, 2000)));

	return {
		passed,
		summary: out.slice(0, 500),
		failedChecks,
		dispatch: qaResult,
	};
}

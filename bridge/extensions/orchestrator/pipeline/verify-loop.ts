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
	// Markdown table rows: `| label | col | ... | status cell |`. Parsed whole-line so a
	// failing status in any column beyond the label is caught, not just the second cell.
	const separatorRowRe = /^:?-+:?$/;
	// Header names that identify a column as carrying a pass/fail status.
	const statusHeaderRe = /^(status|result|verdict|outcome|pass\/fail|state)$/i;
	// Header names that identify a column as carrying an error/failure count.
	const countHeaderRe = /^(errors?|failures?|failed)$/i;
	// Header names for free-text columns that legitimately mention "FAIL" without meaning it
	// (e.g. "Notes: no FAIL found") — excluded from the header-less fallback scan.
	const notesHeaderRe = /^(notes?|details?|comments?|description|reason|evidence)$/i;
	const lines = text.split(/\r?\n/);
	const cellsOf = (line: string): string[] | null => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) return null;
		const raw = trimmed.split("|");
		// A leading/trailing `|` produces an empty first/last element; drop them.
		if (raw.length > 0 && raw[0]!.trim() === "") raw.shift();
		if (raw.length > 0 && raw[raw.length - 1]!.trim() === "") raw.pop();
		if (raw.length < 2) return null;
		return raw.map((c) => c.trim());
	};
	const isSeparatorRow = (cells: string[]): boolean => cells.every((c) => separatorRowRe.test(c));
	for (let i = 0; i < lines.length; i++) {
		const cells = cellsOf(lines[i]!);
		if (!cells) continue;
		if (isSeparatorRow(cells)) continue;
		// A row immediately followed by a separator row is the header row — skip it, but use its
		// column names to decide which columns of the data rows below are worth checking.
		const nextCells = i + 1 < lines.length ? cellsOf(lines[i + 1]!) : null;
		if (nextCells && isSeparatorRow(nextCells)) continue;
		// Find the nearest preceding header row (a row immediately followed by a separator row),
		// scanning back through contiguous table rows only.
		let header: string[] | null = null;
		for (let j = i - 1; j >= 0; j--) {
			const prevCells = cellsOf(lines[j]!);
			if (!prevCells) break; // left the table entirely without finding a header
			if (isSeparatorRow(prevCells)) continue; // the separator row itself; keep looking above it
			const afterPrev = cellsOf(lines[j + 1]!);
			if (afterPrev && isSeparatorRow(afterPrev)) {
				header = prevCells;
				break;
			}
			// Another data row above `i`; keep scanning back toward the header.
		}
		const label = cells[0]!;
		const rest = cells.slice(1);
		const restIndices = rest.map((_, idx) => idx);
		let indicesToCheck = restIndices;
		if (header) {
			const headerRest = header.slice(1);
			const recognized = restIndices.filter((idx) => {
				const headerCell = headerRest[idx];
				return headerCell !== undefined && (statusHeaderRe.test(headerCell) || countHeaderRe.test(headerCell));
			});
			if (recognized.length > 0) {
				indicesToCheck = recognized;
			} else {
				// No recognized status/count column: fall back to every non-label cell except
				// free-text columns (notes/details/comment(s)/description/reason/evidence).
				indicesToCheck = restIndices.filter((idx) => {
					const headerCell = headerRest[idx];
					return headerCell === undefined || !notesHeaderRe.test(headerCell);
				});
			}
		}
		// Headerless tables: fail-safe, keep checking every non-label cell (indicesToCheck === restIndices).
		if (indicesToCheck.some((idx) => statusRe(rest[idx]!) || nonZeroCountRe.test(rest[idx]!))) {
			fails.push(label);
		}
	}
	let m: RegExpExecArray | null;
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
 * Detect an explicit QA verdict of FAIL when the QA agent's output follows the standard
 * `orch-qa-agent.md` output format (a `## Verdict` heading followed by `PASS`/`FAIL`), or
 * the looser `Verdict: FAIL` / `STATUS: fail` line forms. Returns true only for an explicit
 * FAIL — an explicit PASS, or no verdict line at all, returns false.
 */
export function hasExplicitFailVerdict(text: string): boolean {
	// `## Verdict` heading followed (on a later non-blank line) by FAIL/FAILED, before the next
	// heading or end of text.
	const headingMatch = /^#{1,6}\s*Verdict\s*$/im.exec(text);
	if (headingMatch) {
		const rest = text.slice(headingMatch.index + headingMatch[0].length);
		const nextHeading = /^#{1,6}\s/m.exec(rest);
		const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
		const firstNonBlank = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
		if (firstNonBlank && /\b(FAIL|FAILED)\b/i.test(firstNonBlank) && !/\bPASS\b/i.test(firstNonBlank)) {
			return true;
		}
	}
	// `Verdict: FAIL` / `STATUS: fail` line forms.
	const lineMatch = /^\s*(?:Verdict|Status)\s*:\s*(.+)$/im.exec(text);
	if (lineMatch && /\b(FAIL|FAILED)\b/i.test(lineMatch[1]!) && !/\bPASS\b/i.test(lineMatch[1]!)) {
		return true;
	}
	return false;
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
	if (hasExplicitFailVerdict(out) && !failedChecks.includes("verdict")) {
		failedChecks.push("verdict");
	}
	const passed = qaResult.exitCode === 0 && failedChecks.length === 0;

	deps.recordOutcome(qaVerificationOutcomeFor(runId, passed, passed ? 0.95 : 0.0, out.slice(0, 2000)));

	return {
		passed,
		summary: out.slice(0, 500),
		failedChecks,
		dispatch: qaResult,
	};
}

/**
 * QA verification (B4.6): dispatch the QA agent against the union of files
 * changed by workers/leads and return a pass/fail verdict the caller's
 * escalation logic can act on. Parses a tolerant output shape: fenced code
 * blocks and blockquoted lines are stripped first (so quoted/example output
 * can't flip the verdict), then a row/bullet fails when its recognized
 * status/count column (or, absent a header, any non-label cell) carries a
 * FAIL/FAILED/ERROR word, a fail symbol (✗/❌), or a non-zero error/failure
 * count — or when the output has an explicit `## Verdict`/`Verdict:`/`Status:`
 * line reading FAIL/FAILED (see `parseFailedChecks`, `hasExplicitFailVerdict`).
 *
 * pipeline/* must not import index.ts. `dispatch`/`captureDispatchCost`/
 * `recordOutcome` are required fields on `deps` (no default referencing an
 * index.ts singleton); index.ts's caller supplies its own real
 * `dispatchParallel`/`captureDispatchCost`/telemetry `recordOutcome`.
 */
import type { ExtensionContext } from "@humain/terminal";

import type { Adapter } from "../adapters/adapter-resolver.ts";
import { testedRevisionFor } from "../adapters/git-changes.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { QA_SCOPE_RULES, repoRootGuardrail, type DispatchTask } from "../core/prompts.ts";
import type { RunContext, RunSessionLike } from "../run/context.ts";

export type CheckOutcome = "pass" | "fail" | "skipped" | "unavailable";

export interface CheckResult {
	id: string;
	result: CheckOutcome;
}

/** Factual verification evidence attachable to a verification outcome row (Phase 1 item 5).
 *  Every field defaults to "not observed" (empty/null), never a guess. */
export interface VerificationEvidencePayload {
	checks?: CheckResult[];
	tested_revision?: string | null;
	tested_revision_dirty?: boolean | null;
	tested_revision_unavailable_reason?: string;
	review_verdicts?: { role: string; verdict: string }[];
	artifacts?: string[];
	outcome_finality?: "immediate" | "delayed";
}

const CHECK_STATUS_WORDS: Record<string, CheckOutcome> = {
	pass: "pass", passed: "pass", ok: "pass", "\u2713": "pass", "\u2714": "pass",
	fail: "fail", failed: "fail", "\u2717": "fail", error: "fail",
	skip: "skipped", skipped: "skipped", "n/a": "skipped", na: "skipped",
	unavailable: "unavailable", blocked: "unavailable",
};

/**
 * Every check the QA agent reported a status for -- pass, fail, skipped, or unavailable -- not
 * just the failures `parseFailedChecks` extracts. Factual verification evidence (Phase 1 item 5)
 * needs the full set, including checks the QA agent explicitly could not run, so a missing check
 * reads as "not reported" rather than silently absent. The `environment` check name is special:
 * `QA_SCOPE_RULES` tells the QA agent to report it as FAIL when a test command cannot run at all
 * (missing interpreter/dependency/service) -- that is evidence the check was unavailable, not that
 * the code under test failed, so it is normalized to `unavailable` here rather than left as `fail`.
 */
export function parseCheckResults(text: string): CheckResult[] {
	const byId = new Map<string, CheckOutcome>();
	const record = (idRaw: string, wordRaw: string) => {
		const id = idRaw.trim();
		if (!id) return;
		const word = CHECK_STATUS_WORDS[wordRaw.trim().toLowerCase()];
		if (!word) return;
		byId.set(id, id.toLowerCase() === "environment" && word === "fail" ? "unavailable" : word);
	};
	const statusAlt = "pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|unavailable|blocked|error|n\\/?a|\u2713|\u2714|\u2717";
	const rowRe = new RegExp(`\\|\\s*([^|]+?)\\s*\\|\\s*[^|]*?\\b(${statusAlt})\\b[^|]*?\\|`, "gi");
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(text)) !== null) record(m[1], m[2]);
	const bulletRe = new RegExp(`^[-*]\\s+(.+?):\\s*(${statusAlt})\\b`, "gim");
	while ((m = bulletRe.exec(text)) !== null) record(m[1], m[2]);
	return Array.from(byId, ([id, result]) => ({ id, result }));
}

/**
 * T8: a claim recorded ALONGSIDE the gate verdict, never a replacement for it -- `passed` is
 * computed exactly as before (`qaResult.exitCode === 0 && failedChecks.length === 0`), so an
 * all-skipped QA run still passes the gate. `evidence_status` exists so a downstream reader never
 * has to mistake "exited 0" for "something was actually checked".
 */
export function evidenceStatusFor(checks: CheckResult[]): "verified" | "unverified_checks_unavailable" {
	return checks.length > 0 && checks.some((c) => c.result === "pass" || c.result === "fail")
		? "verified"
		: "unverified_checks_unavailable";
}

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
		run: RunContext<RunSessionLike> | null,
	) => Promise<void>;
	recordOutcome: (outcome: Record<string, unknown>) => void;
}

export function qaVerificationOutcomeFor(
	runId: string,
	passed: boolean,
	quality: number,
	note: string,
	evidence: VerificationEvidencePayload = {},
): Record<string, unknown> {
	const checks = evidence.checks ?? [];
	return {
		run_id: runId,
		task_id: `${runId}-qa`,
		outcome: passed ? "verified" : "fail",
		verification_scope: "run",
		quality,
		note,
		// Factual verification evidence (Phase 1 item 5) -- additive fields alongside the existing
		// pass/fail `outcome`/`quality`. Never a manufactured score: `checks` is exactly what the QA
		// agent's own output reported, `tested_revision` is read from git, and anything not actually
		// observed is recorded as null/empty plus an explicit reason, never guessed.
		checks,
		// Checks the QA agent could not evaluate at all (environment failures) or explicitly
		// skipped, listed by id so a consumer never has to infer "unavailable" from a missing row.
		checks_unavailable: checks.filter((c) => c.result === "unavailable" || c.result === "skipped").map((c) => c.id),
		// T8: `outcome`/`quality`/`verification_scope` above are the GATE verdict and are deliberately
		// UNCHANGED by this field -- an exit-0 QA dispatch whose checks are all `skipped`/`unavailable`
		// (or that reported none at all) still passes the gate exactly as it did before.
		// `evidence_status` records, alongside that verdict, whether any of it is backed by a check
		// that actually ran to a pass/fail result.
		evidence_status: evidenceStatusFor(checks),
		// The QA agent's own free-text output has no structured field for the literal shell command
		// each check ran -- only a check name and a pass/fail/skip word (see `parseCheckResults`).
		// Recording a guessed command would be a fabrication; this stays explicitly null with a
		// reason until the QA output format itself is extended to report commands.
		check_commands: null,
		check_commands_unavailable_reason: "QA agent output has no structured command field; only check name + pass/fail/skip status is parsed",
		tested_revision: evidence.tested_revision ?? null,
		tested_revision_dirty: evidence.tested_revision_dirty ?? null,
		...(evidence.tested_revision_unavailable_reason ? { tested_revision_unavailable_reason: evidence.tested_revision_unavailable_reason } : {}),
		review_verdicts: evidence.review_verdicts ?? [],
		artifacts: evidence.artifacts ?? [],
		// This row is the immediate verdict from the QA dispatch itself. A later signal about the
		// same task (`reopened`/`regression`/`rollback`/`human_correction` on a subsequent outcomes
		// row) is a separate row, not a rewrite of this one -- `outcome_finality` names which kind
		// this is.
		outcome_finality: evidence.outcome_finality ?? "immediate",
	};
}

/**
 * Strip fenced code blocks (``` / ~~~) and blockquote lines (`> ...`) before parsing a QA
 * report for status tables/bullets/verdict lines. A QA report legitimately quotes or shows
 * example FAIL output (e.g. "here's what a failing report looks like") without that being its
 * own actual verdict; without this, such an example flips the real verdict.
 */
function stripQuotedAndFencedContent(text: string): string {
	const lines = text.split(/\r?\n/);
	// A fence marker is a run of 3+ backticks or 3+ tildes (not mixed). Captured so a closing
	// fence can be checked against the opening one: same character, and at least as long
	// (CommonMark's closing-fence rule) — a ~~~ never closes a ``` fence, and vice versa.
	const fenceRe = /^\s*(`{3,}|~{3,})/;
	const blockquoteRe = /^\s*>/;
	// Find the matching closing fence for an opening fence at `openIndex`, scanning forward.
	// Returns -1 if the fence never closes (fail-safe: caller then leaves the lines from the
	// unmatched opening fence onward untouched, so a real verdict after it is never swallowed).
	const findClosingFence = (openIndex: number, marker: string): number => {
		const char = marker[0]!;
		const minLen = marker.length;
		for (let i = openIndex + 1; i < lines.length; i++) {
			const m = fenceRe.exec(lines[i]!);
			if (m && m[1]!.startsWith(char) && m[1]!.length >= minLen && /^[`~]*$/.test(lines[i]!.trim())) {
				return i;
			}
		}
		return -1;
	};
	const kept: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const m = fenceRe.exec(line);
		if (m) {
			const closeIndex = findClosingFence(i, m[1]!);
			if (closeIndex === -1) {
				// Unterminated fence: fail-safe, keep everything from here on and parse it normally
				// instead of discarding it (an unclosed fence must never hide a real verdict).
				for (let j = i; j < lines.length; j++) kept.push(lines[j]!);
				break;
			}
			// Skip the opening fence, the fenced body, and the closing fence.
			i = closeIndex + 1;
			continue;
		}
		if (blockquoteRe.test(line)) {
			i++;
			continue;
		}
		kept.push(line);
		i++;
	}
	return kept.join("\n");
}

export function parseFailedChecks(rawText: string): string[] {
	const text = stripQuotedAndFencedContent(rawText);
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
export function hasExplicitFailVerdict(rawText: string): boolean {
	const text = stripQuotedAndFencedContent(rawText);
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
 * pass/fail verdict that downstream escalation logic can act on — see
 * `parseFailedChecks`/`hasExplicitFailVerdict` for the exact tolerant-parsing
 * rules (header-aware status/count columns, explicit verdict lines, and
 * fenced/blockquoted content ignored).
 */
export async function runVerification(
	runId: string,
	planId: string,
	filesChanged: string[],
	ctx: ExtensionContext,
	/** The run this QA pass belongs to; threaded through to `deps.dispatch` and
	 *  `deps.captureDispatchCost` instead of an implicit "active run" read (B4.4). */
	run: RunContext<RunSessionLike> | null,
	captureOpts: CaptureOpts,
	deps: VerifyDeps,
	/** The run's cwd, resolved absolute (docs/architecture-review.md C4): grounds the QA prompt in
	 *  the repo it is actually running against, instead of letting it guess and run `find /`. */
	repoRoot: string,
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
		...repoRootGuardrail(repoRoot),
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

	// Factual verification evidence (Phase 1 item 5): every check the QA agent reported a status
	// for, plus the exact revision/working-tree state verification actually ran against -- both
	// recorded alongside (never instead of) the pass/fail gate verdict above.
	const checks = parseCheckResults(out);
	const revision = testedRevisionFor(repoRoot);
	deps.recordOutcome(qaVerificationOutcomeFor(runId, passed, passed ? 0.95 : 0.0, out.slice(0, 2000), {
		checks,
		tested_revision: revision.revision,
		tested_revision_dirty: revision.dirty,
		...(revision.unavailable_reason ? { tested_revision_unavailable_reason: revision.unavailable_reason } : {}),
		review_verdicts: [{ role: "qa_agent", verdict: passed ? "pass" : "fail" }],
		artifacts: [],
	}));

	return {
		passed,
		summary: out.slice(0, 500),
		failedChecks,
		dispatch: qaResult,
	};
}

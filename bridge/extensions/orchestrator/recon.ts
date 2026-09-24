/**
 * Pure Rule-2 (pre-implementation recon) planning and evidence formatting.
 * No HT imports so this can be unit-tested with `bun test`. All policy —
 * minimum complexity, worker counts by complexity band, the recon capability,
 * and which task classes skip recon — is read from the `method` the caller
 * supplies (normally `METHOD.rules.pre_implementation_recon` from
 * `models.ts`, itself sourced from `method.json`). This module does not
 * define or duplicate any of those thresholds.
 *
 * `dispatchHierarchical()` (Task 2) owns turning `ReconTaskPlan[]` into real
 * subagent dispatches; this module only computes what should run and how to
 * fold completed results back into a bounded evidence packet for the lead.
 */

import { summarizeStderr } from "./dispatch-outcome.ts";

/** The slice of `METHOD.rules.pre_implementation_recon` this module needs. */
export interface ReconPolicy {
	min_complexity: number;
	workers_by_complexity: { min: number; max: number; workers: number }[];
	worker_capability: string;
	skip_for_task_classes: string[];
}

export interface ReconPlanInput {
	method: ReconPolicy;
	complexity: number;
	taskClass: string;
	goal: string;
	runId: string;
}

/** One planned, read-only recon dispatch. Shape matches the bridge's DispatchTask. */
export interface ReconTaskPlan {
	taskId: string;
	capability: string;
	task: string;
	/** Explicit tool boundary, independent of the model capability's persona. */
	tools: string[];
}

/** The subset of a completed dispatch result this module needs to build evidence. */
export interface ReconDispatchResult {
	taskId: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Read-only recon focuses, one per potential worker, ordered from most to
 * least universally useful. `workers_by_complexity` never asks for more than
 * five (see method.json), so five is enough to cover every band.
 *
 * SKILL.md Rule 2 also lists "recent related changes" as a candidate question.
 * It is deliberately absent: answering it needs `git log`, which would mean
 * granting `bash` and giving up the hard read-only tool boundary below. An
 * unbypassable boundary is worth more than one extra question, so the two are
 * kept consistent here and in SKILL.md rather than silently diverging.
 */
const RECON_QUESTIONS: readonly string[] = [
	"Identify the affected files, functions, and call sites this task must touch or reference. List exact paths and symbols.",
	"Identify existing tests that already cover this area, and note any gaps a fix or feature would need to close.",
	"Identify conventions, patterns, and prior art already established in this codebase for this kind of change.",
	"Identify the external interfaces, dependencies, or callers that this change could impact.",
	"Identify likely risks and edge cases based on how this code currently behaves.",
];

/** Wraps a recon question with an explicit, unambiguous read-only instruction. */
function readOnlyReconPrompt(goal: string, question: string): string {
	return [
		`Read-only reconnaissance for the following task. Do not implement anything yet.`,
		"",
		`Task goal: ${goal}`,
		"",
		question,
		"",
		"Do not edit, commit, push, switch branches, stash, or otherwise modify the working " +
			"tree in any way. Investigate and report your findings as plain text only.",
	].join("\n");
}

/**
 * Rule 2: derive the parallel, read-only recon fan-out for a task from the
 * method's own policy. Returns [] when the task is below the policy's
 * minimum complexity or its task class is exempt (e.g. investigation and
 * qa_verification tasks are already recon-shaped).
 */
export function planReconTasks(input: ReconPlanInput): ReconTaskPlan[] {
	const { method, complexity, taskClass, goal, runId } = input;
	if (complexity < method.min_complexity) return [];
	if (method.skip_for_task_classes.includes(taskClass)) return [];
	const band = method.workers_by_complexity.find(({ min, max }) => complexity >= min && complexity <= max);
	const count = Math.max(0, band?.workers ?? 0);
	return RECON_QUESTIONS.slice(0, count).map((question, index) => ({
		taskId: `${runId}-recon-${index}`,
		capability: method.worker_capability,
		task: readOnlyReconPrompt(goal, question),
		tools: ["read", "grep", "find", "ls"],
	}));
}

const TRUNCATION_MARKER = "…[truncated]";

/**
 * `evidence_packet_max_tokens` is the AGGREGATE budget for the one combined
 * packet a lead receives, not a per-worker allowance — the cost being bounded
 * is the lead's input prompt, which carries every worker's output at once. So
 * `formatReconEvidence` splits `maxChars` into an equal per-worker share and
 * re-caps the assembled packet at the total. See method.json
 * `rules.pre_implementation_recon.evidence_packet_rationale`.
 *
 * Truncate `text` to at most `maxChars` UTF-16 code units, appending an
 * explicit marker so a bounded evidence packet is never mistaken for a
 * complete one. Builds up by Unicode code point (not raw UTF-16 unit) so a
 * surrogate pair is never split across the cut, then re-checks the resulting
 * length so the guarantee holds regardless of the marker's own encoding.
 */
function truncate(text: string, maxChars: number): string {
	const limit = Math.max(0, Math.trunc(maxChars));
	if (text.length <= limit) return text;
	if (limit === 0) return "";
	if (TRUNCATION_MARKER.length >= limit) return TRUNCATION_MARKER.slice(0, limit);

	const budget = limit - TRUNCATION_MARKER.length;
	let kept = "";
	for (const char of text) {
		const next = kept + char;
		if (next.length > budget) break;
		kept = next;
	}
	return kept + TRUNCATION_MARKER;
}

/**
 * Fold completed recon dispatch results into one evidence packet for the
 * lead: successful workers contribute their reported findings, failed
 * workers contribute a summarized diagnostic (via `summarizeStderr`, shared
 * with the rest of the bridge's dispatch-outcome handling) rather than being
 * silently dropped. Failure headers and a fair share of diagnostic space are
 * reserved before allocating any space to successful output. Failures appear
 * first so successful output cannot hide a later failure at the aggregate cap.
 * Truncation is code-point-safe and marked explicitly. Caps too small to hold
 * the failure headers and markers necessarily yield best-effort evidence.
 */
export function formatReconEvidence(results: ReconDispatchResult[], maxChars: number): string {
	if (results.length === 0) return "";
	const limit = Math.max(0, Math.trunc(maxChars));
	const perPacketBudget = Math.max(1, Math.floor(limit / results.length));
	const failures = results.filter((result) => result.exitCode !== 0);
	const successes = results.filter((result) => result.exitCode === 0);
	const headers = failures.map((result) => `### ${result.taskId} unavailable (failed, exit ${result.exitCode})\n`);
	const structuralSize = headers.reduce((size, header) => size + header.length, 0)
		+ Math.max(0, failures.length - 1) * 2;
	// Leave a marker for omitted successful evidence, without risking a failure.
	const successReserve = successes.length > 0 ? TRUNCATION_MARKER.length + 2 : 0;
	const diagnosticBudget = Math.max(0, Math.min(
		perPacketBudget,
		Math.floor((limit - structuralSize - successReserve) / Math.max(1, failures.length)),
	));
	const failureEvidence = failures.map((result, index) => {
		// Reuse line selection, but bypass its UTF-16 slicing: all cuts belong
		// to truncate(), which preserves code points and adds our marker.
		const diagnostic = summarizeStderr(result.stderr, Infinity) || "(no diagnostics available)";
		return headers[index] + truncate(diagnostic, diagnosticBudget);
	}).join("\n\n");
	const successfulEvidence = successes.map((result) => {
		const body = truncate(result.stdout.trim() || "(no output reported)", perPacketBudget);
		return `### ${result.taskId}\n${body}`;
	}).join("\n\n");
	const separator = failureEvidence && successfulEvidence ? "\n\n" : "";
	const remaining = limit - failureEvidence.length - separator.length;
	return truncate(failureEvidence + separator + truncate(successfulEvidence, remaining), limit);
}

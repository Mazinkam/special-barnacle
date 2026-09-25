/**
 * Structured handoffs between a scoped lead's plan -> integrate -> report
 * phases. A scoped lead is a single long-lived process moving through
 * phases (not three fresh dispatches), so continuity across phases depends
 * on the PRIOR phase's output being a machine-checkable record — not prose
 * the next phase has to re-derive by re-reading the whole transcript.
 *
 * Every function here is pure: no filesystem, no process spawning, no
 * network. Extraction/validation never throw on malformed input — a broken
 * handoff is a signal to fall back to a fresh long-lived lead, not a crash.
 *
 * Diagnostics (extraction problems, validation problems, staleness/
 * continuation reasons) are always fixed codes (optionally `code:field`),
 * never model-supplied values — a handoff is untrusted input and must not
 * be echoed back into logs/prompts verbatim.
 */

export interface HandoffDecision {
	decision: string;
	rationale: string;
}

export interface HandoffWorkItem {
	task_id: string;
	summary: string;
	result: string;
	files?: string[];
}

export type HandoffVerificationOutcome = "pass" | "fail" | "unavailable" | "skipped";

export interface HandoffVerification {
	command: string;
	outcome: HandoffVerificationOutcome;
	revision?: string;
}

export interface HandoffArtifact {
	ref: string;
	description: string;
}

export type HandoffPhase = "plan" | "integrate" | "report";

export interface LeadHandoff {
	schema_version: 1;
	phase: HandoffPhase;
	run_id: string;
	lead_task_id: string;
	/** Revision the lead started this phase from. */
	base_revision: string;
	/** Revision verification actually ran against, when it ran; null/absent when untested. */
	tested_revision?: string | null;
	decisions: HandoffDecision[];
	constraints: string[];
	/** Path/glob -> owning scope note; mirrors LeadAssignment.owns but as evidence, not a plan input. */
	file_ownership: Record<string, string[]>;
	work: HandoffWorkItem[];
	unresolved_risks: string[];
	verification: HandoffVerification[];
	artifacts: HandoffArtifact[];
}

export interface ExpectedHandoff {
	phase: HandoffPhase;
	runId: string;
	leadTaskId: string;
}

/** Per-field size caps enforced by `validateHandoff` (defense against runaway model output). */
export const HANDOFF_MAX_STRING_CHARS = 4000;
export const HANDOFF_MAX_ARRAY_LEN = 200;

/** Default cap on the fenced JSON blob `extractHandoff` will attempt to parse. */
export const DEFAULT_MAX_INPUT_CHARS = 64_000;

const HANDOFF_SECTION_RE = /^##\s*Handoff\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im;
const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)```/i;

/**
 * Pull the `LeadHandoff` JSON out of a `## Handoff` section. Never throws:
 * a missing heading, missing fence, oversized fence, or unparsable/
 * non-object JSON all become a fixed-code `problems` entry with no
 * `handoff`, so the caller can fall back safely without echoing any
 * model-supplied text (including raw parser error messages) back out.
 */
export function extractHandoff(text: string, opts?: { maxInputChars?: number }): { handoff?: LeadHandoff; problems: string[] } {
	const maxInputChars = opts?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
	const problems: string[] = [];
	const section = HANDOFF_SECTION_RE.exec(text)?.[1];
	if (!section) {
		problems.push("missing_handoff_section");
		return { problems };
	}
	const fence = JSON_FENCE_RE.exec(section)?.[1];
	if (!fence) {
		problems.push("missing_json_fence");
		return { problems };
	}
	if (fence.length > maxInputChars) {
		problems.push("input_too_large");
		return { problems };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fence);
	} catch {
		problems.push("json_parse_error");
		return { problems };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		problems.push("handoff_not_object");
		return { problems };
	}
	return { handoff: parsed as LeadHandoff, problems };
}

function isStringArray(x: unknown): x is string[] {
	return Array.isArray(x) && x.every((i) => typeof i === "string");
}

/**
 * Completeness + identity + size check. Returns [] only when every required
 * key is present with the right shape, within the per-field size caps, AND
 * phase/run_id/lead_task_id match what the caller expected to receive back
 * (guards against a stale or mismatched handoff being silently accepted).
 * All problems are fixed codes (`missing_field:x`, `invalid_field:x`,
 * `field_too_large:x`, `phase_mismatch`, `run_id_mismatch`,
 * `lead_task_id_mismatch`) — never the model-supplied value itself.
 */
export function validateHandoff(h: LeadHandoff, expect: ExpectedHandoff): string[] {
	const problems: string[] = [];
	if (!h || typeof h !== "object") {
		problems.push("invalid_field:handoff");
		return problems;
	}
	const any = h as unknown as Record<string, unknown>;

	if (any.schema_version !== 1) problems.push("invalid_field:schema_version");

	if (any.phase !== "plan" && any.phase !== "integrate" && any.phase !== "report") {
		problems.push("invalid_field:phase");
	} else if (any.phase !== expect.phase) {
		problems.push("phase_mismatch");
	}

	if (typeof any.run_id !== "string" || any.run_id.length === 0) {
		problems.push("missing_field:run_id");
	} else if (any.run_id.length > HANDOFF_MAX_STRING_CHARS) {
		problems.push("field_too_large:run_id");
	} else if (any.run_id !== expect.runId) {
		problems.push("run_id_mismatch");
	}

	if (typeof any.lead_task_id !== "string" || any.lead_task_id.length === 0) {
		problems.push("missing_field:lead_task_id");
	} else if (any.lead_task_id.length > HANDOFF_MAX_STRING_CHARS) {
		problems.push("field_too_large:lead_task_id");
	} else if (any.lead_task_id !== expect.leadTaskId) {
		problems.push("lead_task_id_mismatch");
	}

	if (typeof any.base_revision !== "string" || any.base_revision.length === 0) {
		problems.push("missing_field:base_revision");
	} else if (any.base_revision.length > HANDOFF_MAX_STRING_CHARS) {
		problems.push("field_too_large:base_revision");
	}

	if (any.tested_revision !== undefined && any.tested_revision !== null) {
		if (typeof any.tested_revision !== "string") {
			problems.push("invalid_field:tested_revision");
		} else if (any.tested_revision.length > HANDOFF_MAX_STRING_CHARS) {
			problems.push("field_too_large:tested_revision");
		}
	}

	if (any.decisions === undefined) {
		problems.push("missing_field:decisions");
	} else if (
		!Array.isArray(any.decisions) ||
		!any.decisions.every((d) => d && typeof d === "object" && typeof (d as HandoffDecision).decision === "string" && typeof (d as HandoffDecision).rationale === "string")
	) {
		problems.push("invalid_field:decisions");
	} else if (
		any.decisions.length > HANDOFF_MAX_ARRAY_LEN ||
		any.decisions.some(
			(d) => (d as HandoffDecision).decision.length > HANDOFF_MAX_STRING_CHARS || (d as HandoffDecision).rationale.length > HANDOFF_MAX_STRING_CHARS,
		)
	) {
		problems.push("field_too_large:decisions");
	}

	if (any.constraints === undefined) {
		problems.push("missing_field:constraints");
	} else if (!isStringArray(any.constraints)) {
		problems.push("invalid_field:constraints");
	} else if (any.constraints.length > HANDOFF_MAX_ARRAY_LEN || any.constraints.some((c) => c.length > HANDOFF_MAX_STRING_CHARS)) {
		problems.push("field_too_large:constraints");
	}

	if (any.file_ownership === undefined) {
		problems.push("missing_field:file_ownership");
	} else if (
		typeof any.file_ownership !== "object" ||
		any.file_ownership === null ||
		Array.isArray(any.file_ownership) ||
		!Object.values(any.file_ownership).every(isStringArray)
	) {
		problems.push("invalid_field:file_ownership");
	} else {
		const keys = Object.keys(any.file_ownership);
		const values = Object.values(any.file_ownership) as string[][];
		const tooLarge =
			keys.length > HANDOFF_MAX_ARRAY_LEN ||
			keys.some((k) => k.length > HANDOFF_MAX_STRING_CHARS) ||
			values.some((v) => v.length > HANDOFF_MAX_ARRAY_LEN || v.some((s) => s.length > HANDOFF_MAX_STRING_CHARS));
		if (tooLarge) problems.push("field_too_large:file_ownership");
	}

	if (any.work === undefined) {
		problems.push("missing_field:work");
	} else if (
		!Array.isArray(any.work) ||
		!any.work.every((w) => {
			const item = w as HandoffWorkItem;
			return (
				item &&
				typeof item === "object" &&
				typeof item.task_id === "string" &&
				typeof item.summary === "string" &&
				typeof item.result === "string" &&
				(item.files === undefined || isStringArray(item.files))
			);
		})
	) {
		problems.push("invalid_field:work");
	} else {
		const tooLarge =
			any.work.length > HANDOFF_MAX_ARRAY_LEN ||
			any.work.some((w) => {
				const item = w as HandoffWorkItem;
				return (
					item.task_id.length > HANDOFF_MAX_STRING_CHARS ||
					item.summary.length > HANDOFF_MAX_STRING_CHARS ||
					item.result.length > HANDOFF_MAX_STRING_CHARS ||
					(item.files?.length ?? 0) > HANDOFF_MAX_ARRAY_LEN ||
					(item.files ?? []).some((f) => f.length > HANDOFF_MAX_STRING_CHARS)
				);
			});
		if (tooLarge) problems.push("field_too_large:work");
	}

	if (any.unresolved_risks === undefined) {
		problems.push("missing_field:unresolved_risks");
	} else if (!isStringArray(any.unresolved_risks)) {
		problems.push("invalid_field:unresolved_risks");
	} else if (any.unresolved_risks.length > HANDOFF_MAX_ARRAY_LEN || any.unresolved_risks.some((r) => r.length > HANDOFF_MAX_STRING_CHARS)) {
		problems.push("field_too_large:unresolved_risks");
	}

	const validOutcomes = new Set(["pass", "fail", "unavailable", "skipped"]);
	if (any.verification === undefined) {
		problems.push("missing_field:verification");
	} else if (
		!Array.isArray(any.verification) ||
		!any.verification.every((v) => {
			const item = v as HandoffVerification;
			return (
				item &&
				typeof item === "object" &&
				typeof item.command === "string" &&
				validOutcomes.has(item.outcome) &&
				(item.revision === undefined || typeof item.revision === "string")
			);
		})
	) {
		problems.push("invalid_field:verification");
	} else {
		const tooLarge =
			any.verification.length > HANDOFF_MAX_ARRAY_LEN ||
			any.verification.some((v) => {
				const item = v as HandoffVerification;
				return item.command.length > HANDOFF_MAX_STRING_CHARS || (item.revision?.length ?? 0) > HANDOFF_MAX_STRING_CHARS;
			});
		if (tooLarge) problems.push("field_too_large:verification");
	}

	if (any.artifacts === undefined) {
		problems.push("missing_field:artifacts");
	} else if (
		!Array.isArray(any.artifacts) ||
		!any.artifacts.every((a) => {
			const item = a as HandoffArtifact;
			return item && typeof item === "object" && typeof item.ref === "string" && typeof item.description === "string";
		})
	) {
		problems.push("invalid_field:artifacts");
	} else {
		const tooLarge =
			any.artifacts.length > HANDOFF_MAX_ARRAY_LEN ||
			any.artifacts.some((a) => {
				const item = a as HandoffArtifact;
				return item.ref.length > HANDOFF_MAX_STRING_CHARS || item.description.length > HANDOFF_MAX_STRING_CHARS;
			});
		if (tooLarge) problems.push("field_too_large:artifacts");
	}

	return problems;
}

/**
 * A handoff is only safe to trust against a KNOWN current revision:
 * - `currentHead === null` (unknown) is always unsafe — we cannot verify
 *   the handoff describes the code actually on disk.
 * - When the handoff reports a `tested_revision`, that is the strongest
 *   claim it makes ("verification ran against this revision") and it must
 *   equal the current head.
 * - Otherwise fall back to `base_revision` (the phase never got as far as
 *   testing anything, so its only claim is "I started from this revision").
 *
 * `reason` is always a fixed code (`stale:unknown_head`,
 * `stale:tested_revision_mismatch`, `stale:base_revision_mismatch`) — never
 * the actual revision strings, which are untrusted model-supplied values.
 */
export function handoffStaleness(h: LeadHandoff, currentHead: string | null): { stale: boolean; reason?: string } {
	if (currentHead === null) {
		return { stale: true, reason: "stale:unknown_head" };
	}
	if (typeof h.tested_revision === "string") {
		if (h.tested_revision !== currentHead) {
			return { stale: true, reason: "stale:tested_revision_mismatch" };
		}
		return { stale: false };
	}
	if (h.base_revision !== currentHead) {
		return { stale: true, reason: "stale:base_revision_mismatch" };
	}
	return { stale: false };
}

export type ContinuationDecision = { action: "continue" } | { action: "fallback_long_lived_lead"; reason: string };

/**
 * The single gate a caller needs: any extraction problem, any validation
 * problem, revision staleness against the current head, or an unknown/
 * changed dirty-tree fingerprint since the prior phase means the
 * scoped-lead shortcut is not trustworthy this time — fall back to a fresh
 * long-lived lead rather than continue on a handoff that might describe the
 * wrong code, a different task, or uncommitted work that has since moved.
 *
 * `treeUnchanged` is bridge-observed (not model-supplied): whether the
 * dirty-tree fingerprint of the relevant files is unchanged since the
 * previous phase ended. `null`/`undefined` means the caller could not
 * establish this and must fall back (`stale:tree_unknown`); `false` means
 * it changed (`stale:tree_changed`).
 *
 * `reason` is always built from fixed codes (joining `problems`/validation
 * codes, which are themselves fixed codes) — never a model-supplied value.
 */
export function decideContinuation(input: {
	handoff?: LeadHandoff;
	problems: string[];
	currentHead: string | null;
	expect: ExpectedHandoff;
	treeUnchanged?: boolean | null;
}): ContinuationDecision {
	if (input.problems.length > 0) {
		return { action: "fallback_long_lived_lead", reason: `handoff_extraction_failed:${input.problems.join(",")}` };
	}
	if (!input.handoff) {
		return { action: "fallback_long_lived_lead", reason: "no_handoff" };
	}
	const validationProblems = validateHandoff(input.handoff, input.expect);
	if (validationProblems.length > 0) {
		return { action: "fallback_long_lived_lead", reason: `handoff_invalid:${validationProblems.join(",")}` };
	}
	const staleness = handoffStaleness(input.handoff, input.currentHead);
	if (staleness.stale) {
		return { action: "fallback_long_lived_lead", reason: staleness.reason ?? "stale:unknown" };
	}
	if (input.treeUnchanged === false) {
		return { action: "fallback_long_lived_lead", reason: "stale:tree_changed" };
	}
	if (input.treeUnchanged === undefined || input.treeUnchanged === null) {
		return { action: "fallback_long_lived_lead", reason: "stale:tree_unknown" };
	}
	return { action: "continue" };
}

function orderedHandoff(h: LeadHandoff): Record<string, unknown> {
	const out: Record<string, unknown> = {
		schema_version: h.schema_version,
		phase: h.phase,
		run_id: h.run_id,
		lead_task_id: h.lead_task_id,
		base_revision: h.base_revision,
	};
	if ("tested_revision" in h) out.tested_revision = h.tested_revision;
	out.decisions = h.decisions.map((d) => ({ decision: d.decision, rationale: d.rationale }));
	out.constraints = [...h.constraints];
	out.file_ownership = Object.fromEntries(
		Object.keys(h.file_ownership)
			.sort()
			.map((k) => [k, [...h.file_ownership[k]]]),
	);
	out.work = h.work.map((w) => ({
		task_id: w.task_id,
		summary: w.summary,
		result: w.result,
		...(w.files !== undefined ? { files: [...w.files] } : {}),
	}));
	out.unresolved_risks = [...h.unresolved_risks];
	out.verification = h.verification.map((v) => ({
		command: v.command,
		outcome: v.outcome,
		...(v.revision !== undefined ? { revision: v.revision } : {}),
	}));
	out.artifacts = h.artifacts.map((a) => ({ ref: a.ref, description: a.description }));
	return out;
}

const MIN_FIELD_CHARS = 20;
const MAX_SHRINK_ITERATIONS = 200;

function truncationMarker(h: LeadHandoff): string {
	const ref = h.artifacts[0]?.ref ?? "unavailable";
	return `…[truncated; full evidence: ${ref}]`;
}

/**
 * Render a handoff as deterministic JSON, bounded to `maxChars`. Over
 * budget, shrinks the biggest free-text `work[].summary`/`work[].result`
 * fields first — never decisions, unresolved_risks, file_ownership,
 * revisions, verification outcomes, or artifact refs, since those are what
 * the next phase actually needs to act correctly. Every shrink is marked
 * explicitly so the next phase knows to go read the linked artifact.
 *
 * `withinBudget` is false when even the required (non-shrinkable) fields
 * cannot fit inside `maxChars` — the shrink loop hits its floor and `text`
 * is still over budget. Callers must fall back rather than trust a
 * `text` that exceeds `maxChars` when `withinBudget` is false. Whenever
 * `withinBudget` is true, `text.length <= maxChars` holds.
 */
export function boundHandoff(h: LeadHandoff, maxChars: number): { text: string; truncated: boolean; withinBudget: boolean } {
	const ordered = orderedHandoff(h);
	let text = JSON.stringify(ordered);
	if (text.length <= maxChars) return { text, truncated: false, withinBudget: true };

	const marker = truncationMarker(h);
	const work = (ordered.work as Array<Record<string, unknown>>).map((w) => ({ ...w }));
	const shrunk = new Set<string>();

	let guard = 0;
	while (text.length > maxChars && guard < MAX_SHRINK_ITERATIONS) {
		guard++;
		let best: { idx: number; field: "summary" | "result"; contentLen: number } | null = null;
		work.forEach((w, idx) => {
			for (const field of ["summary", "result"] as const) {
				const key = `${idx}.${field}`;
				const raw = String(w[field] ?? "");
				const contentLen = shrunk.has(key) ? raw.length - marker.length - 1 : raw.length;
				if (contentLen > MIN_FIELD_CHARS && (!best || contentLen > best.contentLen)) {
					best = { idx, field, contentLen };
				}
			}
		});
		if (!best) break; // nothing left that can shrink further
		const { idx, field } = best;
		const key = `${idx}.${field}`;
		const raw = String(work[idx][field] ?? "");
		const base = shrunk.has(key) ? raw.slice(0, raw.length - marker.length - 1) : raw;
		const newLen = Math.max(MIN_FIELD_CHARS, Math.floor(base.length / 2));
		work[idx][field] = `${base.slice(0, newLen)} ${marker}`;
		shrunk.add(key);
		ordered.work = work;
		text = JSON.stringify(ordered);
	}
	return { text, truncated: true, withinBudget: text.length <= maxChars };
}

/**
 * Append phase-specific instructions to a base prompt. `integrate` and
 * `report` carry the prior phase's bounded handoff forward verbatim and are
 * explicit that a phase change is NOT, by itself, a reason to restart
 * workers or re-run tests that already passed.
 */
export function scopedPhasePrompt(phase: HandoffPhase, basePrompt: string, prior?: { text: string }): string {
	const sections: string[] = [basePrompt.trim()];
	if (phase === "plan") {
		sections.push(
			[
				"## Phase: plan",
				'Before finishing, append a `## Handoff` section containing a single ```json fenced block holding a LeadHandoff object with `"phase": "plan"`. Record every decision with its rationale, every unresolved risk/open question, and the file ownership you are claiming — the integrate phase will act on this record instead of re-deriving it from scratch.',
			].join("\n"),
		);
	} else if (phase === "integrate") {
		sections.push(
			[
				"## Phase: integrate",
				"You are continuing the SAME scoped lead that ran the plan phase, not starting over. Do not restart any worker and do not re-run verification that already passed, solely because the phase changed — only re-run checks the prior handoff marks failed, unavailable, or skipped, or that your new changes require.",
				prior ? `Prior handoff:\n${prior.text}` : "No prior handoff was available; proceed conservatively and re-establish context before making changes.",
			].join("\n\n"),
		);
	} else {
		sections.push(
			[
				"## Phase: report",
				"You are continuing the SAME scoped lead that ran the plan and integrate phases, not starting over. Report from the prior (integrate) handoff below without re-running checks that already passed or restarting any worker; only note what genuinely still needs attention.",
				prior ? `Prior handoff:\n${prior.text}` : "No prior handoff was available; proceed conservatively and re-establish context before reporting.",
				"Do not weaken, skip, or reinterpret any review/QA gate defined earlier in this task — report the outcome against those gates as they stand.",
			].join("\n\n"),
		);
	}
	return sections.join("\n\n");
}

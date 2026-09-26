/**
 * C7 (docs/architecture-review.md): a goal that is short and refers to something outside
 * itself — "do A then C then B", "implement option 2", "go with the above" — arrives at the
 * dispatched agents with no meaning to attach the reference to (run `ht-orch-1790278601688-u4l8jt`
 * blocked for exactly this reason). This module only decides whether a *goal string* looks like
 * that; whether to actually stop the run also depends on whether the operator already attached
 * context (`--context`/`--with-last-reply`) or passed `--force` — that combination is the command
 * layer's decision (`commands/orchestrate.ts`), not this pure function's.
 */

/** Above this length a goal is assumed to carry enough of its own context to not need this check. */
export const SHORT_GOAL_MAX_CHARS = 200;

/**
 * A standalone single capital letter used as an item reference ("do A then C then B"),
 * excluding "I" (the pronoun, not a list marker). Requires a word boundary on both sides so it
 * does not match a letter inside a longer uppercase run like "API", nor "a"/"i" in lower case.
 */
const STANDALONE_LETTER_RE = /\b[A-HJ-Z]\b/;

/** Phrases that only make sense if something outside the goal text already said what they refer to. */
const REFERENCE_PHRASE_RE = /\b(option\s+\d+|the above|as discussed|that plan)\b/i;

/**
 * True when `goal` is short and contains a standalone capital-letter reference or one of the
 * known "refers to something outside this message" phrases. Conservative on purpose: a goal like
 * "add a README for part B" IS a reference to outside context (what is "part B"?), so it is
 * flagged even though it also reads as a normal, self-contained-looking request.
 */
export function goalRefersToMissingContext(goal: string): boolean {
	const trimmed = goal.trim();
	if (trimmed.length === 0 || trimmed.length >= SHORT_GOAL_MAX_CHARS) return false;
	return STANDALONE_LETTER_RE.test(trimmed) || REFERENCE_PHRASE_RE.test(trimmed);
}

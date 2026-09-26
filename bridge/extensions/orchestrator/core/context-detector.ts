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
const STANDALONE_LETTER_RE = /\b[A-HJ-Z]\b/g;

/** Phrases that only make sense if something outside the goal text already said what they refer to. */
const REFERENCE_PHRASE_RE = /\b(option\s+\d+|the above|as discussed|that plan)\b/i;

/**
 * True when the `"A"` matched at `index` in `text` is the sentence-initial indefinite article
 * ("A new endpoint for users...") rather than an item-reference letter ("do A then B"): it sits
 * right after the start of the string, a newline, or `. `/`! `/`? `, and is itself followed by a
 * space and a lowercase word. A letter reference like "Do A then B" is not excluded by this —
 * "A" there is the second word, not sentence-initial — nor is "A new plan: do B then C", whose
 * "A" IS sentence-initial-and-excluded but whose B/C still flag the goal on their own.
 */
function isSentenceInitialArticleA(text: string, index: number): boolean {
	if (text[index] !== "A") return false;
	const before = text.slice(0, index);
	const sentenceInitial = index === 0 || /[.!?]\s$/.test(before) || /\n$/.test(before);
	const followedByLowercaseWord = /^ [a-z]/.test(text.slice(index + 1));
	return sentenceInitial && followedByLowercaseWord;
}

/**
 * True when `goal` is short and contains a standalone capital-letter reference or one of the
 * known "refers to something outside this message" phrases. Conservative on purpose: a goal like
 * "add a README for part B" IS a reference to outside context (what is "part B"?), so it is
 * flagged even though it also reads as a normal, self-contained-looking request. A sentence-
 * initial "A" ("A new endpoint for users") is not, on its own, such a reference — see
 * `isSentenceInitialArticleA` — but any OTHER standalone letter, including a non-sentence-initial
 * "A", still flags the goal exactly as before.
 */
export function goalRefersToMissingContext(goal: string): boolean {
	const trimmed = goal.trim();
	if (trimmed.length === 0 || trimmed.length >= SHORT_GOAL_MAX_CHARS) return false;
	if (REFERENCE_PHRASE_RE.test(trimmed)) return true;
	const re = new RegExp(STANDALONE_LETTER_RE.source, STANDALONE_LETTER_RE.flags);
	let match: RegExpExecArray | null;
	while ((match = re.exec(trimmed))) {
		if (isSentenceInitialArticleA(trimmed, match.index)) continue;
		return true;
	}
	return false;
}

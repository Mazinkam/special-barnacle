/**
 * Pure parsing of a `## Pending external checks` report section into
 * structured `PendingCheck` records — the report-side counterpart to
 * `wait-stall.ts`'s `extractCiRefs` (which recovers a CI ref from the
 * bash command a lead was killed mid-run of). A lead that finishes its
 * report normally (no watchdog kill) but is still waiting on a CI pipeline
 * or run it kicked off should be able to say so explicitly in its report,
 * instead of the orchestrator only ever learning about pending CI from a
 * timeout classification.
 *
 * Like `run-outcome.ts`, this parses untrusted,
 * model-supplied report text: extraction never throws, and every failure
 * mode becomes a FIXED-CODE entry in `problems` — optionally with a
 * 1-based line number, but NEVER any of the line's own text, sanitized or
 * otherwise. There is no snippet mechanism anywhere in this module: an
 * oversized/hostile line is reported as `line_too_long:<lineNumber>` and
 * nothing else. The section is read strictly line-anchored — a `##
 * Pending external checks` mentioned mid-sentence, or content after the
 * section's natural end (`## ` heading or `STATUS:` line), is never
 * treated as part of the section.
 *
 * No `node:fs`, no process, no network — pure string/data transforms only.
 */
import { CI_ID_RE } from "./wait-stall.ts";

export interface PendingCheck {
	provider: "gitlab" | "github";
	kind: "pipeline" | "run";
	id: string;
	mr?: string;
	source: "report" | "killed_command";
}

export const PENDING_CHECKS_HEADING = "## Pending external checks";

/** Cap on the number of distinct checks either function will return, mirroring
 *  `MAX_CI_REFS` in wait-stall.ts. */
const MAX_PENDING_CHECKS = 20;

/** Longest a single report line is trusted to be before it is skipped outright rather than
 *  parsed; guards against a pathological single "line" dragging parsing cost or false matches. */
const MAX_LINE_CHARS = 500;

// Line-anchored, case-insensitive heading match; the section body runs until the next `## `
// heading or a `STATUS:`-style line (mirrors `run-outcome.ts`'s `## Files Changed` parsing),
// or end of text. Both are tested against ONE LINE AT A TIME by `extractPendingChecksSection`
// below rather than as a single regex over the whole report body: a single regex combining an
// unbounded `[\s\S]*?` capture with a `^` lookahead that itself contains `\s` is quadratic on
// input like a report with 100KB of blank lines before the section ever closes, because `\s`
// re-scans (and backtracks over) every blank line once per capture-boundary attempt. A per-line
// scan is linear in the input length regardless of content.
const PENDING_CHECKS_HEADING_LINE_RE = /^##\s+pending external checks\s*$/i;
const PENDING_CHECKS_SECTION_END_RE = /^##\s|^[\s>*_`-]*STATUS[*_`]*\s*:/i;

/** Cap on how much of the report is ever split into lines and scanned for the heading, mirroring
 *  `CLASSIFY_LIMIT_CHARS` in wait-stall.ts: classification only needs to see whether/where the
 *  heading occurs, so anything beyond this many characters is dropped before scanning starts,
 *  which keeps `extractPendingChecksSection` linear regardless of how large the report is. */
const MAX_SECTION_SCAN_CHARS = 256 * 1024;

/**
 * Find the `## Pending external checks` section via a single linear line-by-line scan (no
 * backtracking-prone whole-string regex — see `PENDING_CHECKS_HEADING_LINE_RE` above): split the
 * (length-capped) report text on newlines, find the first line that is exactly a `##  Pending
 * external checks` heading (case-insensitive, arbitrary trailing whitespace), then collect every
 * following line up to — but not including — the next `## `-heading line or `STATUS:`-style line,
 * or the end of input. Returns `undefined` when no heading line is found at all (including when a
 * heading is merely mentioned mid-sentence, since that never matches the line-anchored heading
 * regex on its own line).
 */
function extractPendingChecksSection(reportText: string): string | undefined {
	const scanned = reportText.length > MAX_SECTION_SCAN_CHARS ? reportText.slice(0, MAX_SECTION_SCAN_CHARS) : reportText;
	const lines = scanned.split(/\r?\n/);

	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (PENDING_CHECKS_HEADING_LINE_RE.test(lines[i])) {
			startIdx = i;
			break;
		}
	}
	if (startIdx === -1) return undefined;

	const sectionLines: string[] = [];
	for (let i = startIdx + 1; i < lines.length; i++) {
		if (PENDING_CHECKS_SECTION_END_RE.test(lines[i])) break;
		sectionLines.push(lines[i]);
	}
	return sectionLines.join("\n");
}

const NONE_SECTION_RE = /^(?:none|n\/a|nothing)\.?$/i;

function stripBulletMarker(line: string): string {
	return line.replace(/^[\s]*(?:[-*+>]+|\d+[.)])\s*/, "");
}

/** Strips a single leading `(` and/or a single trailing `)` from `token` — nothing else. This
 *  is the ONLY punctuation-stripping allowed anywhere in id/mr/pr token validation, and it
 *  exists solely so a parenthesized aside like `(MR !163)` still parses; every other decorated
 *  token (`123,`, `123.`, `123;`) is rejected outright rather than trimmed. */
function stripParens(token: string): string {
	return token.replace(/^\(+/, "").replace(/\)+$/, "");
}

function normalizeContextWord(token: string): string {
	return token.toLowerCase().replace(/^[`*_(]+/, "").replace(/[`*_).:,;]+$/, "");
}

const GITLAB_EXPLICIT = new Set(["glab", "gitlab"]);
const GITHUB_EXPLICIT = new Set(["gh", "github"]);
// Deliberately excludes "mr"/"pr": those words are reference-syntax markers (see
// `mrSyntaxProvider` below), not reliable signals of the CHECK's own provider — a check's
// provider must be inferable independent of which mr/pr syntax happens to be used, or a
// mismatched mr/pr reference could never be cleanly dropped (it would just look ambiguous).
const GITLAB_IMPLICIT = new Set(["pipeline"]);
const GITHUB_IMPLICIT = new Set(["run", "workflow"]);
/** Context words whose immediately-following token is a direct id-value position (used both
 *  to pick up an id via adjacency and, for the flag-shaped subset in `ID_FLAG_WORDS`, to refuse
 *  any fallback elsewhere on the line when that adjacent value turns out to be invalid). */
const ID_CONTEXT_WORDS = new Set(["-p", "--pipeline-id", "pipeline", "run", "id"]);
/** The subset of `ID_CONTEXT_WORDS` that are precise, flag-shaped id markers (as opposed to
 *  `run`, the only context word with a looser, subcommand-aware adjacency rule — see
 *  `RUN_SUBCOMMANDS` below). When one of these appears (including `pipeline`, which — unlike
 *  `run` — is held to the exact same strict rule regardless of provider context), the id MUST
 *  come from the token immediately following it — never from an unrelated number elsewhere on
 *  the line, and never merely because an explicit provider token appeared earlier on the line. */
const ID_FLAG_WORDS = new Set(["-p", "--pipeline-id", "id", "pipeline"]);
/** The only known `gh run` subcommands that may sit between the `run` context word and its id
 *  (`gh run watch 123`, `gh run view 123`, `gh run rerun 123`) — descriptive text of any other
 *  shape immediately after `run` (e.g. `run invalid 42`) is never trusted to precede a real id
 *  and rejects the whole line outright, regardless of whether an explicit provider token
 *  (`gh`/`github`) appeared earlier on the line. */
const RUN_SUBCOMMANDS = new Set(["view", "watch", "rerun"]);

interface LineResult {
	check?: PendingCheck;
	problems: string[];
}

function parseLine(rawLine: string, lineNumber: number): LineResult {
	// Fixed code plus only the 1-based line number — never any of the line's own text — so a
	// hostile report body can never inject untrusted content into a diagnostic (see module doc).
	if (rawLine.length > MAX_LINE_CHARS) return { problems: [`line_too_long:${lineNumber}`] };

	const stripped = stripBulletMarker(rawLine).trim();
	if (stripped === "") return { problems: [] };

	const tokens = stripped.split(/\s+/).filter(Boolean);

	let explicitGitlab = false;
	let explicitGithub = false;
	let implicitGitlab = false;
	let implicitGithub = false;
	let idCandidate: string | undefined;
	let idFallback: string | undefined;
	let mrCandidate: string | undefined;
	let mrSyntaxProvider: "gitlab" | "github" | undefined;
	let noFallback = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const contextWord = normalizeContextWord(token);
		const parenStripped = stripParens(token);
		const bangMatch = /^!(\d+)$/.exec(parenStripped);
		const hashMatch = /^#(\d+)$/.exec(parenStripped);

		if (bangMatch) {
			if (mrCandidate === undefined && CI_ID_RE.test(bangMatch[1])) {
				mrCandidate = bangMatch[1];
				mrSyntaxProvider = "gitlab";
			}
		} else if (hashMatch) {
			if (mrCandidate === undefined && CI_ID_RE.test(hashMatch[1])) {
				mrCandidate = hashMatch[1];
				mrSyntaxProvider = "github";
			}
		} else if (CI_ID_RE.test(token)) {
			// Whole-token digits only — no decoration stripping at all for a bare numeric token.
			const prevWord = i > 0 ? normalizeContextWord(tokens[i - 1]) : "";
			if (prevWord === "mr") {
				if (mrCandidate === undefined) {
					mrCandidate = token;
					mrSyntaxProvider = "gitlab";
				}
			} else if (prevWord === "pr") {
				if (mrCandidate === undefined) {
					mrCandidate = token;
					mrSyntaxProvider = "github";
				}
			} else if (ID_CONTEXT_WORDS.has(prevWord)) {
				if (idCandidate === undefined) idCandidate = token;
			} else if (idFallback === undefined) {
				idFallback = token;
			}
		}

		if (contextWord === "run") {
			// `run` is the ONLY context word with a looser, subcommand-aware adjacency rule —
			// this is deliberately independent of whether an explicit provider token
			// (`gh`/`github`) appeared earlier on the line, unlike the old behavior: a bare
			// `run invalid 42` and an explicit `github run invalid 42` must both reject the
			// same way, since neither has a real id or a known subcommand immediately after
			// `run`. Only a directly-following valid id (`run 123`) or one of the known
			// `gh run` subcommands (`view`/`watch`/`rerun`, see `RUN_SUBCOMMANDS`) followed
			// eventually by a valid id (picked up via `idFallback` below) is accepted.
			const next = tokens[i + 1];
			const nextWord = next !== undefined ? normalizeContextWord(next) : undefined;
			const nextIsValidId = next !== undefined && CI_ID_RE.test(next);
			const nextIsKnownSubcommand = nextWord !== undefined && RUN_SUBCOMMANDS.has(nextWord);
			// A following context word (e.g. `run id: 456`) is not itself rejected here — it is
			// independently validated (strictly) on its own iteration below, so `run` merely
			// defers to it rather than double-checking or, worse, rejecting a perfectly valid
			// `id:`/`-p`/`--pipeline-id` marker as if it were arbitrary descriptive text.
			const nextIsContextWord = nextWord !== undefined && ID_CONTEXT_WORDS.has(nextWord);
			if (!nextIsValidId && !nextIsKnownSubcommand && !nextIsContextWord) {
				return { problems: ["missing_id"] };
			}
		} else if (ID_CONTEXT_WORDS.has(contextWord)) {
			// Every other context word (`-p`, `--pipeline-id`, `id`, and `pipeline` — see
			// `ID_FLAG_WORDS`) is always a precise marker, regardless of provider: the id MUST
			// be the very next token, or the line is rejected outright — it must never
			// silently fall through to some other number elsewhere on the line. This is what
			// rejects `- glab pipeline invalid 42` (an explicit provider does NOT loosen
			// `pipeline`'s adjacency the way it used to) as well as the provider-less
			// `- pipeline invalid 42`.
			const next = tokens[i + 1];
			if (next === undefined || !CI_ID_RE.test(next)) {
				return { problems: ["missing_id"] };
			}
			// The adjacent value is the only value ever trusted for this context word: no other
			// number on the line may be substituted for it via `idFallback`.
			noFallback = true;
		}

		if (GITLAB_EXPLICIT.has(contextWord)) explicitGitlab = true;
		else if (GITHUB_EXPLICIT.has(contextWord)) explicitGithub = true;
		if (GITLAB_IMPLICIT.has(contextWord)) implicitGitlab = true;
		if (GITHUB_IMPLICIT.has(contextWord)) implicitGithub = true;
	}

	let provider: "gitlab" | "github" | undefined;
	if (explicitGitlab && explicitGithub) return { problems: ["ambiguous_provider"] };
	if (explicitGitlab) provider = "gitlab";
	else if (explicitGithub) provider = "github";
	else if (implicitGitlab && implicitGithub) return { problems: ["ambiguous_provider"] };
	else if (implicitGitlab) provider = "gitlab";
	else if (implicitGithub) provider = "github";

	if (!provider) return { problems: ["unknown_provider"] };

	const id = idCandidate ?? (noFallback ? undefined : idFallback);
	if (!id) return { problems: ["missing_id"] };

	const problems: string[] = [];
	let mr = mrCandidate;
	// MR (`!123`/`MR 123`) syntax only belongs to gitlab; PR (`#123`/`PR 123`) syntax only
	// belongs to github. A mismatch (e.g. a `#12` reference on a gitlab pipeline check) drops
	// the mr reference with a problem rather than either rejecting the whole check or silently
	// attaching a cross-provider reference to it.
	if (mr !== undefined && mrSyntaxProvider !== provider) {
		mr = undefined;
		problems.push("mr_provider_mismatch");
	}

	const check: PendingCheck = {
		provider,
		kind: provider === "gitlab" ? "pipeline" : "run",
		id,
		source: "report",
	};
	if (mr !== undefined) check.mr = mr;
	return { check, problems };
}

/**
 * Parse the `## Pending external checks` section out of a lead report.
 * Missing section, or a section that just says `None`/`N/A`/`Nothing`
 * (optionally trailing-punctuated, case-insensitive), both cleanly yield no
 * checks and no problems — those are expected, healthy states, not defects
 * in the report. Every other per-line failure (ambiguous or unrecognized
 * provider, no extractable id, an oversized line) becomes a fixed-code
 * `problems` entry and that line is skipped, never thrown on.
 */
export function parsePendingChecks(reportText: string): { checks: PendingCheck[]; problems: string[] } {
	const problems: string[] = [];
	const section = extractPendingChecksSection(reportText);
	if (section === undefined) return { checks: [], problems };

	const trimmedSection = section.trim();
	if (trimmedSection === "" || NONE_SECTION_RE.test(trimmedSection)) return { checks: [], problems };

	const checks: PendingCheck[] = [];
	const indexByKey = new Map<string, number>();
	let truncated = false;

	const lines = section.split("\n");
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const { check, problems: lineProblems } = parseLine(lines[lineIdx], lineIdx + 1);
		problems.push(...lineProblems);
		if (!check) continue;

		const key = `${check.provider}:${check.id}`;
		const existingIdx = indexByKey.get(key);
		if (existingIdx !== undefined) {
			if (!checks[existingIdx].mr && check.mr) checks[existingIdx].mr = check.mr;
			continue;
		}
		if (checks.length >= MAX_PENDING_CHECKS) {
			truncated = true;
			continue;
		}
		indexByKey.set(key, checks.length);
		checks.push(check);
	}

	if (truncated) problems.push("truncated:max_checks");
	return { checks, problems };
}

/**
 * Merge two `PendingCheck` lists (e.g. checks parsed from a report plus a
 * check recovered from a `wait_stall` kill's in-flight command) into one,
 * deduped by `provider:kind:id`. The first occurrence of a given check
 * wins; if a later duplicate carries an `mr` the first occurrence lacks,
 * that `mr` is backfilled onto the kept entry. Capped at `MAX_PENDING_CHECKS`
 * total, counting only distinct checks (a duplicate never consumes a cap
 * slot).
 */
export function mergePendingChecks(a: PendingCheck[], b: PendingCheck[]): PendingCheck[] {
	const result: PendingCheck[] = [];
	const indexByKey = new Map<string, number>();

	for (const item of [...a, ...b]) {
		const key = `${item.provider}:${item.kind}:${item.id}`;
		const existingIdx = indexByKey.get(key);
		if (existingIdx !== undefined) {
			if (!result[existingIdx].mr && item.mr) result[existingIdx].mr = item.mr;
			continue;
		}
		if (result.length >= MAX_PENDING_CHECKS) continue;
		indexByKey.set(key, result.length);
		result.push({ ...item });
	}

	return result;
}

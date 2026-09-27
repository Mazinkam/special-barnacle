/**
 * Pure helpers for distinguishing a "wait stall" — a lead that got killed by
 * the inactivity watchdog while it was legitimately blocked on a bash
 * command that itself polls/waits (a CI status poll loop, `watch`, `gh run
 * watch`, `glab ci status --live`) — from a genuine stuck-lead timeout.
 *
 * This module exists because of a real incident: an orchestrated lead ran
 * `for i in $(seq 1 40); do glab ci get -p 219469 ...; sleep 60; done` to
 * poll a GitLab pipeline, and the inactivity watchdog killed it mid-loop
 * (no stdout for the sleep duration looks identical to a hung process). The
 * fix is not to make the watchdog smarter about semantics — it is to give
 * the caller (which already has the in-flight tool call at kill time) a way
 * to classify that kill as `wait_stall` instead of `timed_out`, and to
 * recover which CI pipeline/run the lead was waiting on so it can be polled
 * out-of-band instead of being silently dropped.
 *
 * Everything here is a pure string/data transform: no `node:fs`, no
 * `node:child_process`, no network, no session access. Like
 * `transient-error.ts`, this is a classifier over untrusted text (the
 * in-flight bash command), so it must never throw on malformed input and
 * must guard against false positives from incidental substrings (e.g. `gh
 * pr checks` without `--watch`, `grep -r watch src/`, `cat stopwatch.ts`)
 * AND must never take super-linear time on adversarial input (a hostile
 * command is exactly the kind of string this module is guaranteed to see —
 * it comes straight from a bash tool call the classifier does not control).
 *
 * All command-shape analysis below (loop detection, CLI-subcommand
 * matching, CI ref extraction) is built on ONE single-pass tokenizer
 * (`tokenize`) rather than regexes with unbounded/nested quantifiers. A
 * whole-string regex trying to relate a quote open to its close, or a
 * command name to a flag that may or may not exist anywhere later in the
 * string, is exactly the shape that risks quadratic-or-worse rescanning on
 * adversarial input (e.g. `'"\\'.repeat(n)` re-triggering an
 * escaped-unterminated-quote scan, or `' \n'.repeat(n)` re-scanning
 * whitespace runs at every newline-boundary check). A single index-based
 * character scan that never re-reads a position it has already consumed is
 * linear in the input length regardless of content.
 */

/** A single CI pipeline/run id: digits only, capped at 12 digits (GitLab pipeline ids and
 *  GitHub run ids are both well within this range; the cap rejects glued-together garbage
 *  like a 13+ digit token pasted next to unrelated numbers). */
export const CI_ID_RE = /^[0-9]{1,12}$/;

/**
 * Hard cap on how much of a command is ever examined for wait-command
 * classification. Classification only needs to see the *shape* of the
 * command (a loop header, a CLI subcommand name); anything beyond this
 * many characters is dropped before any pattern runs, which is what keeps
 * every check below linear in the worst case regardless of how large an
 * adversarial or pathological command string is.
 */
const CLASSIFY_LIMIT_CHARS = 16 * 1024;

/**
 * One word produced by `tokenize`: `value` is the word's content with
 * quotes removed and backslash escapes resolved (so `"glab ci status
 * --live"` inside a quoted string never looks like a real word — it stays
 * one single word with literal spaces embedded in `value`, never split).
 * `cmdStart` is true when this word is the first word of a new "simple
 * command" — at the very start of the input, immediately after a shell
 * separator/subshell character (`;`, `&`, `|`, a newline, `(`, `)`, `{`,
 * `}`), or immediately after a `then`/`do`/`else` word that itself had
 * `cmdStart === true`. This is the single source of truth both consumers
 * below (`groupIntoCommands` and `hasSleepInLoop`) rely on for "command
 * position", replacing the old regex-based `CMD_BOUNDARY` and
 * `LOOP_CMD_POSITION_CHARS` character-class checks with one already-computed
 * flag per word.
 */
interface Word {
	value: string;
	cmdStart: boolean;
}

/** Characters that end a word AND are themselves discarded (never part of any word's `value`):
 *  plain whitespace, and the shell separator/subshell characters that also put the following
 *  word into command position. Kept as a single Set (not a regex) so membership testing is a
 *  single hash lookup with no backtracking of any kind. */
const BOUNDARY_CHARS = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "{", "}"]);

/** The subset of `BOUNDARY_CHARS` that, beyond ending the current word, also put the *next*
 *  word into command position (plain whitespace ends a word but does not by itself start a new
 *  command — `echo do` must not treat `do` as a loop opener merely because it follows a space). */
const CMD_START_CHARS = new Set([";", "&", "|", "\n", "(", ")", "{", "}"]);

/** Reserved words that, when read in command position, put the word immediately after them
 *  into command position too (`do sleep 5` — `do` itself starts a "command", and the `sleep`
 *  right after it is the actual command being started; `then`/`else` behave the same way in an
 *  `if`/`case` construct). A reserved word read OUTSIDE command position (`echo do; sleep 2`)
 *  is just a plain argument and does not propagate anything. */
const CMD_START_PROPAGATING_WORDS = new Set(["then", "do", "else"]);

/**
 * Single-pass, index-based tokenizer: the one place in this module that
 * ever reads quote/escape/separator characters. Every character of `text`
 * is visited at most a small constant number of times (once to detect it
 * is a boundary/quote/escape character, once to copy it into a word's
 * value) — there is no rescanning of any suffix of the input at any point,
 * so this is O(text.length) regardless of content, including content that
 * is nothing but backslashes, quotes, or newlines.
 *
 * Shell shapes handled:
 * - Single quotes (`'...'`): every character up to the matching `'` (or end
 *   of input, if unterminated) is taken completely literally — no escapes
 *   recognized inside, matching real shell single-quote semantics. Spaces
 *   inside a quoted span do NOT split the word — `'gh run watch 123'` is
 *   one word with an embedded space, not four words, which is exactly what
 *   keeps a command merely *mentioning* another command inside a string
 *   literal from being mistaken for the real thing.
 * - Double quotes (`"..."`): a backslash inside escapes exactly the next
 *   character (added to the word literally, both characters consumed);
 *   any other character is taken literally, up to the matching `"` (or end
 *   of input, if unterminated).
 * - A backslash outside any quotes escapes exactly the next character
 *   (added to the word literally); a trailing backslash with nothing after
 *   it is taken as a literal backslash.
 * - Any of `BOUNDARY_CHARS` outside a quote ends the current word (without
 *   being added to it) and, for the subset in `CMD_START_CHARS`, puts the
 *   following word into command position.
 */
function tokenize(text: string): Word[] {
	const words: Word[] = [];
	const n = text.length;
	let i = 0;
	let cmdPos: boolean = true;

	while (i < n) {
		const ch = text[i];
		if (BOUNDARY_CHARS.has(ch)) {
			if (CMD_START_CHARS.has(ch)) cmdPos = true;
			i++;
			continue;
		}

		const parts: string[] = [];
		while (i < n && !BOUNDARY_CHARS.has(text[i])) {
			const c = text[i];
			if (c === "'") {
				i++;
				const start = i;
				while (i < n && text[i] !== "'") i++;
				parts.push(text.slice(start, i));
				if (i < n) i++; // consume closing quote, if present
				continue;
			}
			if (c === '"') {
				i++;
				const segStart = i;
				let buf = "";
				let lastFlush = segStart;
				while (i < n && text[i] !== '"') {
					if (text[i] === "\\" && i + 1 < n) {
						buf += text.slice(lastFlush, i) + text[i + 1];
						i += 2;
						lastFlush = i;
					} else {
						i++;
					}
				}
				buf += text.slice(lastFlush, i);
				parts.push(buf);
				if (i < n) i++; // consume closing quote, if present
				continue;
			}
			if (c === "\\") {
				if (i + 1 < n) {
					parts.push(text[i + 1]);
					i += 2;
				} else {
					parts.push("\\");
					i++;
				}
				continue;
			}
			const start = i;
			while (i < n && !BOUNDARY_CHARS.has(text[i]) && text[i] !== "'" && text[i] !== '"' && text[i] !== "\\") i++;
			parts.push(text.slice(start, i));
		}

		const value = parts.length === 1 ? parts[0] : parts.join("");
		const startedAtCmdPos: boolean = cmdPos;
		words.push({ value, cmdStart: startedAtCmdPos });
		cmdPos = startedAtCmdPos && CMD_START_PROPAGATING_WORDS.has(value.toLowerCase());
	}

	return words;
}

/**
 * Group a flat `tokenize` result into "simple commands" — one array of
 * word values per maximal run starting at a `cmdStart === true` word. This
 * is the direct replacement for the old `CMD_BOUNDARY`-anchored regexes
 * (CLI-subcommand matching) and `SEGMENT_SPLIT_RE` (CI ref option-scan
 * bounding): both now operate on an already-bounded array of words instead
 * of re-scanning substrings of the original text.
 */
function groupIntoCommands(words: readonly Word[]): string[][] {
	const commands: string[][] = [];
	let current: string[] | undefined;
	for (const word of words) {
		if (word.cmdStart || current === undefined) {
			current = [];
			commands.push(current);
		}
		current.push(word.value);
	}
	return commands;
}

/**
 * True when `command`'s first `prefix.length` words case-insensitively
 * equal `prefix`, in order — the array-based replacement for a
 * `CMD_BOUNDARY`-anchored `\bfoo\s+bar\s+baz\b` regex.
 */
function matchesPrefix(command: readonly string[], prefix: readonly string[]): boolean {
	if (command.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (command[i].toLowerCase() !== prefix[i]) return false;
	}
	return true;
}

/** True when some word in `command` case-insensitively equals `flag` — the array-based
 *  replacement for the old bounded `FLAG_GAP` regex fragment. Since `command` is already one
 *  bounded simple command (see `groupIntoCommands`), no artificial character-count bound is
 *  needed here: the array itself can never cross into a different simple command. */
function commandHasFlag(command: readonly string[], flag: string): boolean {
	for (const word of command) {
		if (word.toLowerCase() === flag) return true;
	}
	return false;
}

/**
 * Patterns that mark a bash command as a "wait command": one whose job is
 * to sit and poll/watch something, so the watchdog seeing no new stdout for
 * a while is expected behavior, not a stuck process. Each entry's `match`
 * runs against ONE already-tokenized simple command (see
 * `groupIntoCommands`) — no regex, no unbounded gap-then-literal shape, so
 * every entry is O(command.length) with no possibility of backtracking.
 * Kept as a documented, inspectable list (rather than one giant check) so
 * each shape's rationale and false-positive guard is legible on its own.
 *
 * The `sleep`-inside-a-loop shape is deliberately NOT expressed here — see
 * `hasSleepInLoop` below — because a loop body can be arbitrarily long and
 * multi-line, and relating a loop opener to a `sleep` to a `done` needs a
 * running depth counter across many simple commands, not a single-command
 * check.
 */
export const WAIT_PATTERNS: ReadonlyArray<{ readonly name: string; readonly match: (command: readonly string[]) => boolean }> = [
	{
		// `watch` as its own command word, optionally with flags, e.g. `watch
		// -n 5 kubectl get pods`.
		name: "watch-command",
		match: (command) => command.length > 0 && command[0].toLowerCase() === "watch",
	},
	{
		// GitLab CLI's live-following pipeline status view — explicitly a
		// blocking watch loop by design.
		name: "glab-ci-status-live",
		match: (command) => matchesPrefix(command, ["glab", "ci", "status"]) && commandHasFlag(command, "--live"),
	},
	{
		// GitHub CLI's run-watching subcommand, e.g. `gh run watch 123`.
		name: "gh-run-watch",
		match: (command) => matchesPrefix(command, ["gh", "run", "watch"]),
	},
	{
		// GitHub CLI's checks-watching flag, e.g. `gh pr checks --watch`.
		// Requires the literal `--watch` flag (not just `gh pr checks` alone,
		// which returns immediately without it).
		name: "gh-pr-checks-watch",
		match: (command) => matchesPrefix(command, ["gh", "pr", "checks"]) && commandHasFlag(command, "--watch"),
	},
];

/**
 * True when `sleep` appears as its own word while inside a `do ... done`
 * loop body whose `do` is genuinely in command position and was actually
 * opened by a preceding `for`/`while`/`until` header — not merely any `do`
 * word anywhere in the string. Scans anywhere in `words`, including across
 * multiple simple commands (`case`, `echo`, pipelines) between the loop
 * header and the `sleep`, and even if the loop is never closed with a
 * trailing `done` (a lead killed mid-typing a loop is still `sleep`-inside-
 * a-loop).
 *
 * `words` comes straight from `tokenize`, so its `cmdStart` flag already
 * reflects quote-awareness and reserved-word propagation; this function
 * does nothing but track two small pieces of state (`depth`,
 * `pendingLoopHeader`) across the already-bounded word list. A
 * `for`/`while`/`until` word is only recorded as a pending loop header when
 * read at `cmdStart`; a `do` word only opens a loop (incrementing `depth`
 * and clearing the pending header) when BOTH `cmdStart` is true AND a
 * header is pending; a `done` word only closes a loop (decrementing
 * `depth`) when `cmdStart` is true. `sleep` also requires `cmdStart`, so a
 * mention of the word as an argument (for example, `echo sleep`) is ignored.
 *
 * This keeps `echo do; sleep 2` (the `do` is an argument to `echo`, not in
 * command position) and `echo for while until do; sleep 1` (none of those
 * keywords are in command position either) from being misclassified as a
 * wait command, while still recognizing `until x; do sleep 5; done`,
 * `while true; do ...; sleep 30; done`, and an unterminated `for i in 1 2;
 * do sleep 5`. It also does NOT flag `for x in a; do echo x; done; sleep 2;
 * for y in b; do echo y; done` — the two loops are fully closed before
 * either `sleep`, so depth is back to 0 by the time `sleep 2` is seen.
 *
 * Being a single pass over an already-bounded word array with no regex
 * involved anywhere, this is O(words.length) regardless of content.
 */
function hasSleepInLoop(words: readonly Word[]): boolean {
	let depth = 0;
	let pendingLoopHeader = false;

	for (const { value, cmdStart } of words) {
		const token = value.toLowerCase();
		if (cmdStart && (token === "for" || token === "while" || token === "until")) {
			pendingLoopHeader = true;
		} else if (cmdStart && token === "do") {
			if (pendingLoopHeader) {
				depth++;
				pendingLoopHeader = false;
			}
		} else if (cmdStart && token === "done") {
			if (depth > 0) depth--;
		} else if (cmdStart && token === "sleep" && depth > 0) {
			return true;
		}
	}
	return false;
}

/**
 * True when `cmd` looks like a command whose job is to poll/watch and
 * therefore block without producing new stdout for a while — a legitimate
 * reason for the inactivity watchdog to see silence, not evidence the
 * process is stuck. `undefined`/empty always returns false.
 *
 * Only the first `CLASSIFY_LIMIT_CHARS` of `cmd` are ever examined (see
 * `CLASSIFY_LIMIT_CHARS`), and the whole check is a single `tokenize` pass
 * plus two bounded linear scans over its already-bounded output
 * (`WAIT_PATTERNS`, `hasSleepInLoop`) — no regex, no rescanning — so this
 * never runs on more than a bounded prefix of the input in more than
 * linear time, regardless of how large or adversarial `cmd` is.
 */
export function isWaitCommand(cmd: string | undefined): boolean {
	if (!cmd) return false;
	const truncated = cmd.length > CLASSIFY_LIMIT_CHARS ? cmd.slice(0, CLASSIFY_LIMIT_CHARS) : cmd;
	const words = tokenize(truncated);
	const commands = groupIntoCommands(words);
	if (commands.some((command) => WAIT_PATTERNS.some((p) => p.match(command)))) return true;
	return hasSleepInLoop(words);
}

export type TimeoutClassification = "wait_stall" | "timed_out";

/**
 * Classify a dispatch's terminal timeout as a `wait_stall` (the lead was
 * killed mid-wait-command by the inactivity watchdog — recoverable, not a
 * real stuck process) or `timed_out` (a genuine timeout, including the
 * absolute ceiling, which always fires regardless of what the lead was
 * doing, and any outcome other than `"timed_out"` — a spend cap, an
 * explicit cancellation, a normal completion — none of which are watchdog
 * kills at all).
 *
 * `wait_stall` requires ALL of:
 * - `outcome`, when given, is exactly `"timed_out"` (any other outcome —
 *   `"cancelled"`, `"failed"`, etc. — is never a wait stall).
 * - `timeoutReason === "inactivity"` (the absolute ceiling is a hard cutoff
 *   independent of what the lead was doing, so it is never a wait stall).
 * - a bash tool call was actually in flight at kill time (`name` matches
 *   `"bash"` case-insensitively — a tool named `Bash`/`BASH` still counts).
 * - EITHER `toolInFlight.waitPattern === true` (the dispatch layer's own
 *   classification, computed from the raw, un-truncated command at the
 *   moment the watchdog actually killed the lead — the caller may have more
 *   context, e.g. the full un-truncated command text, than this module ever
 *   sees) OR `isWaitCommand(toolInFlight.command)` returns true.
 *
 * `toolInFlight.waitPattern` is trust-sensitive: it must only ever be set
 * from the result of an ACTUAL watchdog kill's in-flight tool call — never
 * speculatively, never from a command that merely "looks like" a wait
 * command by some other heuristic — because a `wait_stall` classification
 * changes what the orchestrator does next (it recovers a CI ref and polls
 * out-of-band instead of treating the dispatch as failed). Passing `true`
 * for anything other than "the watchdog actually fired and this bash call
 * was in flight" will misclassify a genuine stuck process as recoverable.
 */
export function classifyTimeout(input: {
	outcome?: string;
	timeoutReason?: "inactivity" | "absolute";
	toolInFlight?: { name: string; command?: string; waitPattern?: boolean };
}): TimeoutClassification {
	if (input.outcome !== undefined && input.outcome !== "timed_out") return "timed_out";
	if (input.timeoutReason !== "inactivity") return "timed_out";
	const tool = input.toolInFlight;
	if (!tool || tool.name.toLowerCase() !== "bash") return "timed_out";
	if (tool.waitPattern === true) return "wait_stall";
	return isWaitCommand(tool.command) ? "wait_stall" : "timed_out";
}

export interface CiRef {
	provider: "gitlab" | "github";
	kind: "pipeline" | "run";
	id: string;
}

/** Cap on the number of distinct CI refs `extractCiRefs` will return, mirroring the
 *  defensive array caps used elsewhere (e.g. `HANDOFF_MAX_ARRAY_LEN` in lead-handoff.ts). */
const MAX_CI_REFS = 20;

/**
 * A capture is only trusted if the WHOLE captured token is pure digits
 * (`CI_ID_RE`) — no stripping of leading/trailing punctuation of any kind.
 * `123,`/`123.`/`123;` (the last of which cannot actually occur here since
 * `;` is already a command-splitting boundary character — see `tokenize`)
 * are all rejected because the token as captured is not entirely digits.
 * `$(curl evil)` never validates because `(` ends the word before `curl`
 * even starts, and what remains (`$`) is not all-digits either.
 */
function extractValidId(raw: string | undefined): string | null {
	return raw !== undefined && CI_ID_RE.test(raw) ? raw : null;
}

/**
 * Find the value of a flag that may appear anywhere in `command` (bounded
 * to this one already-split simple command — see `groupIntoCommands`),
 * accepting both `<flag> <value>` (two words) and `<flag>=<value>` (one
 * word) forms, case-insensitively on the flag name. Returns the first
 * match's value, or `undefined` if the flag never appears. Since `command`
 * is already bounded to a single simple command, this is a single linear
 * scan with no possibility of crossing into a different simple command or
 * re-scanning any suffix of the original text.
 */
function findFlagValue(command: readonly string[], flagNames: readonly string[]): string | undefined {
	const lowerFlags = flagNames.map((f) => f.toLowerCase());
	for (let i = 0; i < command.length; i++) {
		const lower = command[i].toLowerCase();
		for (const flag of lowerFlags) {
			if (lower === flag) return command[i + 1];
			if (lower.startsWith(`${flag}=`)) return command[i].slice(flag.length + 1);
		}
	}
	return undefined;
}

/**
 * Extractors for CI pipeline/run ids from a single already-tokenized
 * simple command (see `groupIntoCommands`). Each `extract` runs entirely
 * over that one bounded array of words — never over raw text, never with
 * an unbounded scan that could cross into a different simple command —
 * which is what keeps a 100KB adversarial single command like `'glab ci
 * get '.repeat(n)` (no `-p` anywhere) resolving in milliseconds instead of
 * rescanning the remaining tail of the string once per occurrence. Kept as
 * a documented, inspectable list rather than one mega-check.
 */
const CI_REF_EXTRACTORS: ReadonlyArray<{
	readonly provider: CiRef["provider"];
	readonly kind: CiRef["kind"];
	readonly extract: (command: readonly string[]) => string | null;
}> = [
	// `glab ci get -p <id>` / `glab ci get --pipeline-id <id>` (same command only)
	{
		provider: "gitlab",
		kind: "pipeline",
		extract: (command) => (matchesPrefix(command, ["glab", "ci", "get"]) ? extractValidId(findFlagValue(command, ["-p", "--pipeline-id"])) : null),
	},
	// `glab ci status ... -p <id>` / `--pipeline-id <id>` (same command only)
	{
		provider: "gitlab",
		kind: "pipeline",
		extract: (command) => (matchesPrefix(command, ["glab", "ci", "status"]) ? extractValidId(findFlagValue(command, ["-p", "--pipeline-id"])) : null),
	},
	// `glab ci view <id>` (immediately following word only)
	{
		provider: "gitlab",
		kind: "pipeline",
		extract: (command) => (matchesPrefix(command, ["glab", "ci", "view"]) ? extractValidId(command[3]) : null),
	},
	// `gh run view <id>` / `gh run watch <id>` (immediately following word only)
	{
		provider: "github",
		kind: "run",
		extract: (command) => {
			if (command.length < 4) return null;
			if (command[0].toLowerCase() !== "gh" || command[1].toLowerCase() !== "run") return null;
			const sub = command[2].toLowerCase();
			if (sub !== "view" && sub !== "watch") return null;
			return extractValidId(command[3]);
		},
	},
];

/** Longest tail ever inspected, per word, when hunting for a `/pipelines/<id>` REST path —
 *  mirrors the old `\S{1,20}` capture bound so a single pathologically long word (no internal
 *  whitespace at all) can never be scanned past a small fixed prefix looking for an id. */
const PIPELINE_PATH_ID_MAX_CHARS = 20;

/**
 * `glab api .../pipelines/<id>` style REST paths: scans each word (already
 * whitespace/quote/separator-bounded by `tokenize`, so this can never cross
 * into a different word) for the literal substring `/pipelines/`, then
 * takes the run of characters after it up to the next `/` or the end of the
 * word, capped at `PIPELINE_PATH_ID_MAX_CHARS`. Word-scoped, not
 * command-scoped, since the real pattern here is a REST path glued into one
 * token, not a CLI subcommand shape — unlike every other extractor above.
 */
function extractPipelinePathIds(words: readonly Word[]): string[] {
	const marker = "/pipelines/";
	const out: string[] = [];
	for (const { value } of words) {
		const idx = value.toLowerCase().indexOf(marker);
		if (idx === -1) continue;
		const rest = value.slice(idx + marker.length, idx + marker.length + PIPELINE_PATH_ID_MAX_CHARS + 1);
		const slashIdx = rest.indexOf("/");
		const candidate = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
		const id = extractValidId(candidate.length > PIPELINE_PATH_ID_MAX_CHARS ? undefined : candidate);
		if (id) out.push(id);
	}
	return out;
}

/**
 * Pull well-formed CI pipeline/run references out of a bash command. Never
 * throws on malformed input; incidental numbers from unrelated commands
 * (`seq 1 40`, `sleep 60`, `tail -500`) are never matched because every
 * extractor requires the specific `glab`/`gh` subcommand shape immediately
 * before the id, not a bare number anywhere in the string, and no
 * extractor's flag scan can cross into a different simple command (see
 * `groupIntoCommands`). Results are deduped by `provider:kind:id` and capped
 * at `MAX_CI_REFS`.
 */
export function extractCiRefs(cmd: string | undefined): CiRef[] {
	if (!cmd) return [];
	const words = tokenize(cmd);
	const commands = groupIntoCommands(words);
	const seen = new Set<string>();
	const out: CiRef[] = [];

	const push = (provider: CiRef["provider"], kind: CiRef["kind"], id: string): boolean => {
		const key = `${provider}:${kind}:${id}`;
		if (seen.has(key)) return true;
		seen.add(key);
		out.push({ provider, kind, id });
		return out.length < MAX_CI_REFS;
	};

	for (const command of commands) {
		for (const extractor of CI_REF_EXTRACTORS) {
			const id = extractor.extract(command);
			if (!id) continue;
			if (!push(extractor.provider, extractor.kind, id)) return out;
		}
	}

	for (const id of extractPipelinePathIds(words)) {
		if (!push("gitlab", "pipeline", id)) return out;
	}

	return out;
}

/**
 * Shared pure text-safety helpers used wherever a string that did not
 * originate from the orchestrator's own prompt construction — a changed
 * file's name (C3), a `--context` file's on-disk label (C6) — is about to be
 * rendered on what is meant to be a single line inside a Markdown/XML-ish
 * prompt. No `node:fs`, no session access: everything here is a pure string
 * transform, shared by `core/prompts.ts` and `core/context.ts` so the two
 * call sites cannot drift into inconsistent escaping.
 */

/**
 * Escapes ASCII control characters (0x00-0x1F, 0x7F) — including newlines and
 * carriage returns — in `text`, so a value an attacker controls (a filename,
 * a `--context` label) can never inject new Markdown structure (a fresh
 * `## heading`, a blank line that starts a new paragraph) or break out of a
 * one-line rendering, no matter what bytes it contains. `\n`/`\r`/`\t` get
 * short mnemonic escapes; every other control character becomes `\xNN`.
 * Everything else (including non-ASCII text) passes through unchanged.
 */
export function sanitizeControlChars(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, (ch) => {
		switch (ch) {
			case "\n":
				return "\\n";
			case "\r":
				return "\\r";
			case "\t":
				return "\\t";
			default:
				return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
		}
	});
}

/**
 * `credentialish` name component shared by every assignment-style redaction
 * below: TOKEN, SECRET, PASSWORD, PASSWD, API_KEY/APIKEY, ACCESS_KEY,
 * PRIVATE_KEY, CREDENTIAL, and AUTH. `auth` is deliberately followed by a
 * negative lookahead for another letter so it matches `AUTH`/`GH_AUTH`/
 * `AUTH_TOKEN` but NOT the "auth" inside an unrelated word like
 * `Authorization` (that header is instead handled by the dedicated
 * `authKw`/`bearerKw` trigger alternatives below, so its value is still
 * redacted — just not by pretending "Authorization" itself is a credential
 * name and truncating the match at the literal word "Bearer").
 */
const CRED_TERM = "(?:token|secret|passwd|password|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?![a-zA-Z]))";

/**
 * A credential-shaped identifier: the term above with any surrounding
 * word/hyphen/dot characters (e.g. `GITLAB_TOKEN`, `PRIVATE-TOKEN`,
 * `db.password`). The surrounding parts are BOUNDED (`{0,64}`, not `*`/`*?`)
 * on purpose: an unbounded quantifier here would make the trigger scan
 * quadratic on hostile input — `[\w.-]` also matches `.`, so an input like
 * `'a.'.repeat(51200)` (a single `\b`-delimited run of word/dot characters
 * with no credential term anywhere in it) would let the lazy/greedy
 * name-part scan all the way to the end of the string from every `\b`
 * position before failing to find the term, i.e. O(n^2). Bounding the name
 * part caps each failed attempt to constant work, so the whole scan is O(n).
 */
const NAME_PART = "[\\w.-]{0,64}";
const CRED_NAME = `${NAME_PART}${CRED_TERM}${NAME_PART}`;

/**
 * Whole-string match against the credential-name shape above — used by
 * `dispatch-progress.ts`'s `redactDeep` to redact an object VALUE outright
 * when its KEY is credential-shaped (`{ password: 42 }`, `{ token: { ... } }`),
 * regardless of the value's type, instead of relying on `redactCredentials`
 * ever seeing the value as a string.
 */
const CRED_NAME_WHOLE_RE = new RegExp(`^${CRED_NAME}$`, "i");

/** True when `key` is, on its own, a credential-shaped identifier (matches
 *  the same TOKEN/SECRET/PASSWORD/API_KEY/... name set as `redactCredentials`). */
export function isCredentialName(key: string): boolean {
	return typeof key === "string" && CRED_NAME_WHOLE_RE.test(key);
}

/**
 * FAIL-CLOSED value handling. Earlier versions of this file tried to
 * compute a credential value's precise extent — where its closing quote
 * is, which character terminates an unquoted run — with a plain
 * index-based scanner. That approach kept losing to new bypasses because
 * "precise extent" is not actually a well-defined thing for untrusted,
 * adversarial shell/JSON text: a shell backslash-escaped space
 * (`password=first\ EXPOSED`), concatenated quoted fragments
 * (`password='first'"EXPOSED"`), ANSI-C quoting (`password=$'first
 * EXPOSED'`), a bare comma inside an unquoted value (`password=first,
 * EXPOSED`), a JSON array value (`{"password":["first","EXPOSED"]}`), or a
 * `\uXXXX`-obfuscated key (`{"pass\u0077ord":"EXPOSED"}`) can all make a
 * scanner stop "at the end of the value" while a real secret continues past
 * that point.
 *
 * The fix is to stop guessing: once a credential TRIGGER (an assignment
 * `name=`/`name:`, a `--flag`, a JSON/escaped-JSON/single-quoted key,
 * `Bearer`, or `Authorization:`) is found, everything from the start of its
 * value through the END OF THE INPUT is replaced with a single
 * `[REDACTED]` marker (see `redactCredentials` below). This intentionally
 * sacrifices any diagnostic text that happened to follow the credential on
 * the same line — an acceptable loss because the strings this module
 * redacts are only ever watchdog/status-line diagnostics rendered back to a
 * human or a log; the actual `wait`/CI failure detection that drives
 * orchestrator behavior runs on the raw, unredacted command upstream of
 * this function, so nothing operationally important depends on the tail
 * surviving redaction.
 */

/**
 * `\uXXXX`/`\xXX`-escape decoding used ONLY to detect credential names that
 * were obfuscated to dodge `TRIGGER_RE` (e.g. `{"pass\u0077ord":"EXPOSED"}`,
 * where the literal text never spells "password"). `ESCAPE_RE` (no `g`
 * flag, so it is safe to reuse across calls with `.test()`/`String#search`)
 * finds the first such escape; `ESCAPE_DECODE_RE` (the `g`-flagged twin)
 * drives the actual decode. Both patterns are fixed-width literal-plus-hex
 * shapes with no nested quantifiers, so scanning for them is linear and
 * carries no backtracking risk.
 */
const ESCAPE_RE = /\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}/;
const ESCAPE_DECODE_RE = /\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})/g;

/** Decodes every `\uXXXX`/`\xXX` escape in `text` into its literal character. */
function decodeEscapes(text: string): string {
	return text.replace(ESCAPE_DECODE_RE, (_match, u: string | undefined, x: string | undefined) => String.fromCharCode(parseInt((u ?? x) as string, 16)));
}

/**
 * Locates credential TRIGGERS — never values — with a single linear regex
 * pass. Every alternative below matches a fixed, bounded shape (a `\b`-
 * anchored `CRED_NAME`, a single-width operator, a literal keyword): none of
 * them can backtrack quadratically, and none of them consume the value
 * itself. `redactCredentials` below determines what happens to the value
 * once a trigger's end position is known: everything from there through
 * the end of the input becomes `[REDACTED]` (see the fail-closed rule
 * above).
 *
 * - `(?<flagPrefix>)(?<flagName>)`: `--flag`/`-flag` followed by whitespace
 *   with no `:`/`=` immediately after that whitespace (`--password value`).
 *   The trailing `(?![:=])` keeps this alternative from claiming a
 *   `--flag : value`/`--flag = value` shape that the assignment alternative
 *   below is better suited to (it normalizes the operator to `=`).
 * - `(?<asgName>)`: `name=value` / `name:value` / `name : value`, and the
 *   JSON forms `"name":`/`'name':`/the escaped `\"name\":` (the optional
 *   `(?:\\?["'])?` consumes the name's own closing quote, if any, before the
 *   operator).
 * - `(?<bearerKw>)`: the literal word `Bearer` followed by whitespace —
 *   including a real newline/CR (`\s+`, not `[ \t]+`), so `Bearer\nEXPOSED`
 *   is still caught even when the space after "Bearer" is a line break
 *   rather than a literal space/tab.
 * - `(?<authKw>)`: `Authorization:` — but NOT when immediately followed by
 *   `Bearer` (that case is instead handled by the `bearerKw` alternative a
 *   few characters later, so the header name and the word `Bearer` both stay
 *   visible in the output and only the actual token is redacted). The
 *   negative lookahead here uses the SAME `[ \t]+` shape `bearerKw` used to
 *   require historically (not `\s+`) so the two alternatives stay aligned:
 *   whenever `bearerKw`'s own whitespace-after-"Bearer" requirement would be
 *   satisfied by something other than a literal space/tab (a real newline),
 *   this lookahead deliberately fails to match too, so `authKw` claims the
 *   trigger instead and the fail-closed redaction still covers the value —
 *   see `Authorization: Bearer\nEXPOSED` in the tests.
 */
const TRIGGER_SOURCE = [
	String.raw`(?<flagPrefix>--?)(?<flagName>${CRED_NAME})\b[ \t]+(?![:=])`,
	String.raw`\b(?<asgName>${CRED_NAME})\b(?:\\?["'])?\s*[:=]\s*`,
	String.raw`\b(?<bearerKw>Bearer)\b\s+`,
	String.raw`\b(?<authKw>Authorization)\b\s*:(?![ \t]*Bearer[ \t]+)\s*`,
].join("|");
const TRIGGER_RE = new RegExp(TRIGGER_SOURCE, "gi");
/** Stateless (no `g` flag) twin of `TRIGGER_RE`, safe to reuse across `.test()`
 *  calls — used only to check whether a trigger is present at all, e.g. when
 *  deciding whether `\uXXXX`-decoding revealed a trigger the plain scan missed. */
const TRIGGER_TEST_RE = new RegExp(TRIGGER_SOURCE, "i");

/** Provider-specific token shapes: GitLab PATs, GitHub's `ghp_`/`gho_`/`ghu_`/
 *  `ghs_`/`ghr_` prefixes and `github_pat_...`, Slack's `xox[baprs]-...`, AWS
 *  access key ids (`AKIA` + 16 uppercase-alnum), and OpenAI-style `sk-...` keys.
 *  Each token-shape run is a single unbounded character-class run
 *  (`[^\s'"]+`-style) rather than a length-bounded quantifier, so there is no
 *  cutoff a longer real-world token could ever fall past. */
const TOKEN_SHAPE_PATTERNS: readonly RegExp[] = [
	/\bglpat-\S+/gi,
	/\bgithub_pat_[A-Za-z0-9_]+/g,
	/\bgh[pousr]_\S+/g,
	/\bxox[baprs]-[A-Za-z0-9-]+/gi,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bsk-[A-Za-z0-9]{16,}\b/g,
];

/** URL userinfo, e.g. `https://user:pass@host` -> `https://***@host`. A
 *  single unbounded character-class run (`[^\s/@]+`), not a length-bounded
 *  quantifier — linear (one character class repeated) with no cutoff a
 *  longer userinfo string could fall past. */
const URL_USERINFO_RE = /:\/\/[^\s/@]+@/g;

/**
 * Hard cap on how much of `text` is scanned for credentials.
 * `redactCredentials`'s callers already cap what they retain (e.g. 2000
 * chars in `dispatch-progress.ts`), so scanning further than this is pure
 * cost with no additional real-world benefit; capping it also keeps the
 * trigger regex and every `scanValue` walk bounded to a fixed amount of work
 * regardless of how large the untrusted input is. Anything past the cap is
 * dropped entirely (never retained unredacted) and replaced with a visible
 * marker.
 */
const REDACT_SCAN_LIMIT = 64 * 1024;

/**
 * Pure, linear-time credential redaction over untrusted text (an in-flight
 * bash command, a rendered diagnostic). No catastrophic-backtracking risk:
 * `TRIGGER_RE` only ever matches a fixed, bounded trigger shape (a `\b`-
 * anchored `CRED_NAME`, a single-width operator, a literal keyword) — never
 * a value — so there is no length-bounded value pattern for a secret to
 * slip past.
 *
 * Only the FIRST trigger in the (already `REDACT_SCAN_LIMIT`-capped) input
 * matters: per the fail-closed rule above, once it is found, everything
 * from the start of its value through the end of the input becomes a
 * single `[REDACTED]` marker, so there is nothing left downstream of it for
 * a second trigger to govern. Before that scan runs, a separate pass
 * decodes `\uXXXX`/`\xXX` escapes into a throwaway copy used only to check
 * whether a trigger was hiding behind an obfuscated name (e.g.
 * `{"pass\u0077ord":"EXPOSED"}`, whose literal text never spells
 * "password"). If the decoded copy reveals a trigger the plain scan missed
 * entirely, or reveals one that sits EARLIER than the first plain trigger's
 * value start (an obfuscated key followed, later in the input, by an
 * ordinary trigger — e.g. `{"pass\u0077ord":"EXPOSED"}; token=other`), this
 * fails closed by truncating at the first escape sequence and appending the
 * marker there — sacrificing whatever readable prefix came after it,
 * exactly like the main rule does for an ordinary trigger's tail. Whichever
 * cutoff (the escape's or the plain trigger's) comes first in the input
 * wins, since either one on its own is sufficient to prove a credential
 * value follows.
 */
export function redactCredentials(text: string): string {
	const truncated = text.length > REDACT_SCAN_LIMIT;
	const scanned = truncated ? text.slice(0, REDACT_SCAN_LIMIT) : text;

	let escapeCutoff = -1;
	if (ESCAPE_RE.test(scanned) && TRIGGER_TEST_RE.test(decodeEscapes(scanned))) {
		const cutoff = scanned.search(ESCAPE_RE);
		if (cutoff !== -1) escapeCutoff = cutoff;
	}

	TRIGGER_RE.lastIndex = 0;
	const match = TRIGGER_RE.exec(scanned);
	let out: string;
	if (match) {
		const triggerStart = match.index;
		const valueStart = triggerStart + match[0].length;

		if (escapeCutoff !== -1 && escapeCutoff < valueStart) {
			out = `${scanned.slice(0, escapeCutoff)}[REDACTED]`;
		} else {
			const groups = match.groups ?? {};

			let replacementPrefix: string;
			if (groups.flagName !== undefined) {
				replacementPrefix = `${groups.flagPrefix}${groups.flagName} `;
			} else if (groups.asgName !== undefined) {
				replacementPrefix = `${groups.asgName}=`;
			} else if (groups.bearerKw !== undefined) {
				replacementPrefix = "Bearer ";
			} else {
				replacementPrefix = match[0]; // authKw: already includes "Authorization:" through the operator.
			}

			out = `${scanned.slice(0, triggerStart)}${replacementPrefix}[REDACTED]`;
		}
	} else if (escapeCutoff !== -1) {
		out = `${scanned.slice(0, escapeCutoff)}[REDACTED]`;
	} else {
		out = scanned;
	}

	for (const pattern of TOKEN_SHAPE_PATTERNS) out = out.replace(pattern, "[REDACTED]");
	out = out.replace(URL_USERINFO_RE, "://***@");

	return truncated ? `${out}\u2026[REDACTED: input exceeded ${REDACT_SCAN_LIMIT}-char redaction scan limit; remainder dropped]` : out;
}

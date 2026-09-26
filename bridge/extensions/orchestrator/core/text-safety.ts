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

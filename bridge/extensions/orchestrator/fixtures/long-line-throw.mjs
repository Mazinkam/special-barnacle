// Generator (not a directly-runnable child) for a fixture that reproduces
// HT's real failure mode: a minified bundle line that can run to ~650 KB.
// On an uncaught exception Node prints the OFFENDING SOURCE LINE first, then
// the error's name/message/stack. A child's stderr read over a pipe is
// dropped past Node's ~64 KiB async pipe buffer once the process exits, so
// with a source line this long the actual "name: message" + stack never
// arrives on a pipe — only through a real file descriptor.
//
// The generated child script itself is >300 KB (a long array literal shares
// the same source line as the `throw`). That is deliberately NOT committed
// to the repo; this small generator is committed instead, and
// index.test.ts calls `writeLongLineThrowFixture(path)` to materialize the
// actual long-line script into a temp directory at test time.
import { writeFileSync } from "node:fs";

/** Distinctive marker asserted by the caller so a match cannot be a coincidence. */
export const SENTINEL = "HAO_STDERR_SENTINEL_7f3c";

/**
 * Write a child script to `path` whose `throw` statement sits on the same
 * source line as a long array literal, making that line longer than
 * `minLineBytes` (default comfortably over 300 KB).
 */
export function writeLongLineThrowFixture(path, { minLineBytes = 320_000 } = {}) {
	const digitsPerEntry = 2; // "0," repeated
	const entries = Math.ceil(minLineBytes / digitsPerEntry);
	const padding = "0,".repeat(entries);
	// Everything below is one single source line on purpose.
	const source = `const padding = [${padding}0]; if (padding.length > 0) { throw new Error(${JSON.stringify(SENTINEL)}); }\n`;
	writeFileSync(path, source, "utf8");
	return Buffer.byteLength(source, "utf8");
}

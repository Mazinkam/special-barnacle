/**
 * `## Provided context` block construction (docs/architecture-review.md C6):
 * agents ran on the goal string alone, so a goal like "do A then C then B"
 * arrived with no meaning. `--context <file>` and `--with-last-reply` let the
 * operator attach the missing material explicitly; this module turns
 * whatever text the command layer already read (file contents, the last
 * assistant message) into the formatted block `architectPrompt`/`leadPrompt`
 * insert. Pure: no `node:fs`, no session access — reading files and the
 * session happens in `commands/orchestrate.ts`, which passes the raw
 * strings in.
 */
import { relative } from "node:path";

import { redactPaths } from "../hooks/ingest.ts";

/** Per-file/per-source cap (docs/architecture-review.md C6: "40 k characters per file"). */
export const CONTEXT_SOURCE_MAX_CHARS = 40_000;

export interface ContextSource {
	/** Shown to the model as the section heading; must not contain an absolute home path. */
	label: string;
	content: string;
}

/**
 * A `--context <file>`'s on-disk path, turned into a label safe to paste into a prompt: the
 * path relative to the run's cwd when the file is inside it (the common case), or — when it
 * isn't (`relative` starts with `..`) — the absolute path run through `redactPaths` so a file
 * outside the repo never leaks the operator's home directory into the prompt.
 */
export function contextFileLabel(cwd: string, absPath: string): string {
	const rel = relative(cwd, absPath);
	const shown = rel.startsWith("..") ? redactPaths(absPath) : rel;
	return `file: ${shown}`;
}

/** One source's content, capped at `CONTEXT_SOURCE_MAX_CHARS` with an explicit truncation note. */
export function formatContextSource(source: ContextSource): string {
	const over = source.content.length - CONTEXT_SOURCE_MAX_CHARS;
	const body =
		over > 0
			? `${source.content.slice(0, CONTEXT_SOURCE_MAX_CHARS)}\n\n[... truncated: ${over} more character(s) omitted (capped at ${CONTEXT_SOURCE_MAX_CHARS} characters per source) ...]`
			: source.content;
	return `### ${source.label}\n\n${body}`;
}

/**
 * The full `## Provided context` block for zero or more sources, or `""` when there are none —
 * callers splice `""` in as nothing (no extra blank lines), keeping `architectPrompt`/`leadPrompt`
 * byte-identical to their pre-C6 output for a run with no `--context`/`--with-last-reply`.
 */
export function buildProvidedContextBlock(sources: ContextSource[]): string {
	if (sources.length === 0) return "";
	return ["## Provided context", "", sources.map(formatContextSource).join("\n\n---\n\n")].join("\n");
}

/** Label for the `--with-last-reply` source (docs/architecture-review.md C6). */
export const LAST_REPLY_LABEL = "last assistant reply";

/**
 * Minimal shape of a session entry this needs — `ctx.sessionManager.getEntries()`'s real
 * elements have many more fields; this stays structurally typed so tests can pass plain
 * objects instead of building a real `SessionEntry`.
 */
export interface MinimalMessageEntry {
	type: string;
	message?: {
		role?: string;
		content?: string | Array<{ type: string; text?: string }>;
	};
}

/**
 * The last assistant message's text in `entries` (session order, oldest first), or `null` when
 * there is none — the command layer treats `null` as a user error ("no assistant message found"),
 * per docs/architecture-review.md C6.
 */
export function lastAssistantReplyText(entries: readonly MinimalMessageEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			if (content.trim()) return content;
			continue;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join(" ")
				.trim();
			if (text) return text;
		}
	}
	return null;
}

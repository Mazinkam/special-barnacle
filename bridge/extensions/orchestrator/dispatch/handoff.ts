/**
 * The "Resume from a failed attempt" section added to a dispatch's original prompt
 * when the previous attempt did real work (spec §5.4). Pure and bounded.
 */
import type { EventScan } from "../core/event-scan.ts";

export const HANDOFF_MAX_CHARS = 12_000;
const FILES_MAX = 100;
const LAST_TEXT_MAX = 4_000;
const CLOSING = "Continue from here. Re-run the verification before claiming success.";

export interface HandoffInput {
	taskId: string;
	attempt: number;
	previousModel: string;
	failureClass: string;
	reason: string;
	filesChanged: readonly string[];
	scan: EventScan;
	redact?: (s: string) => string;
}

export function buildHandoff(i: HandoffInput): string {
	const redact = i.redact ?? ((s: string) => s);
	// Redact every untrusted piece BEFORE any bounding/truncation is applied to it.
	// Truncating first can slice a secret in half, leaving an unredacted fragment
	// that no longer matches the redactor's pattern (e.g. a partial "SECRET-..." token).
	const header = redact(`## Resume from a failed attempt (attempt ${i.attempt} of ${i.taskId}; previous model ${i.previousModel} failed: ${i.failureClass} ${i.reason})`);
	const filesRaw = i.filesChanged.length === 0
		? "(none detected)"
		: i.filesChanged.slice(0, FILES_MAX).join(", ") + (i.filesChanged.length > FILES_MAX ? ` +${i.filesChanged.length - FILES_MAX} more` : "");
	const files = redact(filesRaw);
	const finishedRaw = i.scan.finishedWorkers.map((w) => `${w.id} ${w.ok ? "✓" : "✗"}${w.summary ? ` ${w.summary}` : ""}`).join("; ") || "(none)";
	const finished = redact(finishedRaw);
	const unfinished = redact(i.scan.unfinishedWorkers.join(", ") || "(none)");
	// Redact the FULL last-text before bounding it, then bound the redacted result so an
	// expanding redactor (e.g. one that replaces short tokens with longer ones) can't blow
	// past LAST_TEXT_MAX.
	const lastRedacted = redact(i.scan.lastAssistantText || "(none)");
	const last = lastRedacted.length > LAST_TEXT_MAX ? `…${lastRedacted.slice(-(LAST_TEXT_MAX - 1))}` : lastRedacted;
	const body = [
		header,
		"Work already on disk: verify it, don't redo it.",
		`- Files changed since this dispatch started: ${files}`,
		`- Finished nested workers: ${finished}   Unfinished: ${unfinished}`,
		`- Last plan/report text from the previous attempt (bounded): ${last}`,
	].join("\n");
	const room = HANDOFF_MAX_CHARS - CLOSING.length - 1;
	return `${body.length <= room ? body : `${body.slice(0, room - 1)}…`}\n${CLOSING}`;
}

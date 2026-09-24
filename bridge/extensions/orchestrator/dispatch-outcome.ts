/**
 * Pure child-process outcome and stderr handling for the orchestrator bridge.
 * Keeping this separate from the HT extension makes teardown recovery testable
 * without importing terminal runtime APIs.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, writeSync } from "node:fs";

const DEFAULT_HEAD_BYTES = 8 * 1024;
const DEFAULT_TAIL_BYTES = 56 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * On-disk cap for a child's real stderr file (see index.ts's
 * runSubagentProcess: stderr now lands on a file descriptor, not a pipe, so
 * nothing is silently dropped at Node's ~64 KiB async-pipe boundary). Left
 * fully unbounded, a chatty or malicious child — or one repeatedly dumping
 * HT's ~650 KB minified-bundle crash output — could grow a single dispatch's
 * diagnostic file without limit for the run's lifetime. 8 MiB is generous
 * enough to hold many multiples of that single-line bundle output plus a
 * full head/tail, while remaining a small, fixed, and predictable disk cost
 * per dispatch.
 */
export const MAX_CHILD_STDERR_DISK_BYTES = 8 * 1024 * 1024;
const CAP_HEAD_BYTES = 64 * 1024;
const CAP_MARKER_RESERVE_BYTES = 512;

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
	const joined = new Uint8Array(left.length + right.length);
	joined.set(left);
	joined.set(right, left.length);
	return joined;
}

function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/**
 * Retains only enough child stderr for diagnostics: the start establishes the
 * runtime context, while the tail typically holds Node's actual exception.
 */
export class BoundedCapture {
	private readonly headLimit: number;
	private readonly tailLimit: number;
	private head: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	private tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	private totalBytes = 0;

	constructor(headBytes = DEFAULT_HEAD_BYTES, tailBytes = DEFAULT_TAIL_BYTES) {
		this.headLimit = Math.max(0, Math.trunc(headBytes));
		this.tailLimit = Math.max(0, Math.trunc(tailBytes));
	}

	get elidedBytes(): number {
		return Math.max(0, this.totalBytes - this.head.length - this.tail.length);
	}

	append(chunk: string): void {
		const bytes = encoder.encode(chunk);
		this.totalBytes += bytes.length;
		const headBytes = Math.min(this.headLimit - this.head.length, bytes.length);
		if (headBytes > 0) this.head = concatBytes(this.head, bytes.subarray(0, headBytes));

		const tailInput = bytes.subarray(Math.max(0, headBytes));
		if (tailInput.length === 0 || this.tailLimit === 0) return;
		const joinedTail = concatBytes(this.tail, tailInput);
		this.tail = joinedTail.length > this.tailLimit
			? joinedTail.subarray(joinedTail.length - this.tailLimit)
			: joinedTail;
	}

	text(): string {
		if (this.elidedBytes === 0) return decoder.decode(concatBytes(this.head, this.tail));
		return (
			decoder.decode(this.head) +
			`\n[orchestrator] … ${this.elidedBytes} bytes elided …\n` +
			decoder.decode(this.tail)
		);
	}
}

/**
 * Stream a (possibly large, up to `MAX_CHILD_STDERR_DISK_BYTES`) child-stderr
 * file back through `BoundedCapture` so the in-memory summary returned to
 * callers stays small even though the on-disk file is not. Reads through a
 * fixed-size buffer with a persistent `TextDecoder` (rather than
 * `readFileSync` + a single `toString`) so decoding is correct across
 * multi-byte characters split at a chunk boundary, and so memory use during
 * the read itself is bounded too.
 */
export function readStderrFileBounded(path: string, headBytes?: number, tailBytes?: number): string {
	if (!existsSync(path)) return "";
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return "";
	}
	try {
		const capture = new BoundedCapture(headBytes, tailBytes);
		const streamingDecoder = new TextDecoder();
		const buffer = Buffer.alloc(64 * 1024);
		let n: number;
		while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
			capture.append(streamingDecoder.decode(buffer.subarray(0, n), { stream: true }));
		}
		capture.append(streamingDecoder.decode());
		return capture.text();
	} finally {
		closeSync(fd);
	}
}

function readRange(fd: number, length: number, position: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const n = readSync(fd, buffer, offset, length - offset, position + offset);
		if (n <= 0) break;
		offset += n;
	}
	return buffer.subarray(0, offset);
}

/**
 * If the file at `path` exceeds `maxBytes`, return a head + marker + tail
 * replacement content that fits within the cap; otherwise return `undefined`
 * (nothing to rewrite). The tail is kept, not dropped: on an uncaught
 * exception Node prints the offending source line first, then the actual
 * error name/message/stack — the useful diagnostic is almost always in the
 * last bytes written, not the first. Reads with explicit positions so a
 * file far larger than the cap is never fully loaded into memory.
 */
export function capChildStderrFile(
	path: string,
	maxBytes: number = MAX_CHILD_STDERR_DISK_BYTES,
	headBytes: number = CAP_HEAD_BYTES,
): string | undefined {
	const fd = openSync(path, "r");
	let size: number;
	try {
		size = fstatSync(fd).size;
		if (size <= maxBytes) return undefined;
		const clampedHeadBytes = Math.min(headBytes, size);
		const tailBytes = Math.max(0, maxBytes - clampedHeadBytes - CAP_MARKER_RESERVE_BYTES);
		const head = readRange(fd, clampedHeadBytes, 0);
		const tail = readRange(fd, tailBytes, Math.max(head.length, size - tailBytes));
		const elided = size - head.length - tail.length;
		const marker = `\n[orchestrator] … ${elided} bytes elided (on-disk stderr exceeded the ${maxBytes}-byte cap) …\n`;
		return `${head.toString("utf8")}${marker}${tail.toString("utf8")}`;
	} finally {
		closeSync(fd);
	}
}

/** Truncate-and-rewrite `path` in place to `content`. Used for the ephemeral
 * (no-session) temp-file fallback, which owns the file outright and has no
 * `RunDiagnostics` inode-checked writer to go through. */
export function rewriteFileInPlace(path: string, content: string): void {
	const fd = openSync(path, "w");
	try {
		writeSync(fd, content, null, "utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Omit recursive worker histories from the per-dispatch event log. The log
 * retains the event and all execution metadata so it remains useful without
 * duplicating nested subagent transcripts on every progress update.
 */
export function trimEventForLog(event: unknown): unknown {
	if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "tool_execution_update") {
		return event;
	}
	const partialResult = (event as { partialResult?: unknown }).partialResult;
	if (!partialResult || typeof partialResult !== "object") return event;
	const details = (partialResult as { details?: unknown }).details;
	if (!details || typeof details !== "object") return event;
	const results = (details as { results?: unknown }).results;
	if (!Array.isArray(results)) return event;

	return {
		...(event as Record<string, unknown>),
		partialResult: {
			...(partialResult as Record<string, unknown>),
			details: {
				...(details as Record<string, unknown>),
				results: results.map((result) => {
					if (!result || typeof result !== "object") return result;
					const { messages: _messages, ...trimmedResult } = result as Record<string, unknown>;
					return trimmedResult;
				}),
			},
		},
	};
}

function wasPipeTruncated(stderr: string): boolean {
	if (stderr.length === 65_536) return true;
	return stderr.includes("file://") && !/\bNode\.js v\d/.test(stderr) && !/(?:\r?\n)$/.test(stderr);
}

function truncateSummary(summary: string, maxLen: number, suffix: string): string {
	const limit = Math.max(0, Math.trunc(maxLen));
	const trimmed = summary.trim();
	if (!suffix) return trimmed.slice(0, limit).trim();
	if (limit <= suffix.length) return suffix.slice(0, limit);
	if (trimmed.length + suffix.length <= limit) return `${trimmed}${suffix}`;
	return `${trimmed.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
}

/** Return one useful stderr line without surfacing minified runtime bundles. */
export function summarizeStderr(stderr: string, maxLen = 160): string {
	const lines = stderr.split(/\r?\n/);
	const marker = [...lines].reverse().find((line) => line.trim().startsWith("[orchestrator]"));
	const errorLine = lines.find(
		(line) =>
			line.length <= 400 &&
			/^\s*(?:[A-Za-z]*Error|Uncaught [A-Za-z]*Error|error)\b.*:/.test(line),
	);
	const fallback = [...lines]
		.reverse()
		.find((line) => line.trim().length > 0 && line.length <= 400 && !line.trim().startsWith("file://"));
	const hasBundledLine = lines.some((line) => byteLength(line) > 400);
	const summary = marker?.trim() || errorLine?.trim() || fallback?.trim() || (
		hasBundledLine
			? `(diagnostic buried in ${byteLength(stderr)} bytes of bundled runtime output; see stderr log)`
			: ""
	);
	const truncation = wasPipeTruncated(stderr) ? " [stderr truncated by child pipe]" : "";
	return truncateSummary(summary, maxLen, truncation);
}

export interface DispatchOutcomeInput {
	exitCode: number;
	sawAgentSettled: boolean;
	sawAgentEnd: boolean;
	hasFinalText: boolean;
	lastStopReason?: string;
	timedOut: boolean;
	cancelled?: boolean;
	spawnFailed: boolean;
	stderrSummary: string;
}

export interface DispatchOutcome {
	status: "completed" | "completed_after_process_error" | "failed" | "timed_out" | "cancelled";
	effectiveExitCode: number;
	note?: string;
}

/**
 * A terminal settled/stop answer is authoritative. An exit after that point is
 * usually extension teardown, so preserve the answer rather than failing it.
 */
export function classifyDispatchOutcome(input: DispatchOutcomeInput): DispatchOutcome {
	if (input.cancelled) {
		return { status: "cancelled", effectiveExitCode: 137, note: input.stderrSummary || undefined };
	}
	if (input.timedOut || input.exitCode === 124) {
		return { status: "timed_out", effectiveExitCode: input.exitCode, note: input.stderrSummary || undefined };
	}
	if (input.exitCode === 0) {
		// HT's --mode json exits 0 even when the final turn is a provider error
		// (quota, auth, overload) or an abort; only text mode sets exit 1. The
		// final stop reason is the authoritative signal.
		if (input.lastStopReason === "error" || input.lastStopReason === "aborted") {
			return { status: "failed", effectiveExitCode: 1, note: input.stderrSummary || `final turn ended in ${input.lastStopReason}` };
		}
		return { status: "completed", effectiveExitCode: 0 };
	}
	if (
		!input.spawnFailed &&
		input.sawAgentSettled &&
		input.hasFinalText &&
		input.lastStopReason === "stop"
	) {
		return {
			status: "completed_after_process_error",
			effectiveExitCode: 0,
			note: `completed; process exited ${input.exitCode} after settle: ${input.stderrSummary}`,
		};
	}
	return { status: "failed", effectiveExitCode: input.exitCode, note: input.stderrSummary || undefined };
}

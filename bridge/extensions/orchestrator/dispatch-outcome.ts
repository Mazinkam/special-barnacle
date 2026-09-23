/**
 * Pure child-process outcome and stderr handling for the orchestrator bridge.
 * Keeping this separate from the HT extension makes teardown recovery testable
 * without importing terminal runtime APIs.
 */

const DEFAULT_HEAD_BYTES = 8 * 1024;
const DEFAULT_TAIL_BYTES = 56 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
	spawnFailed: boolean;
	stderrSummary: string;
}

export interface DispatchOutcome {
	status: "completed" | "completed_after_process_error" | "failed" | "timed_out";
	effectiveExitCode: number;
	note?: string;
}

/**
 * A terminal settled/stop answer is authoritative. An exit after that point is
 * usually extension teardown, so preserve the answer rather than failing it.
 */
export function classifyDispatchOutcome(input: DispatchOutcomeInput): DispatchOutcome {
	if (input.timedOut || input.exitCode === 124) {
		return { status: "timed_out", effectiveExitCode: input.exitCode, note: input.stderrSummary || undefined };
	}
	if (input.exitCode === 0) return { status: "completed", effectiveExitCode: 0 };
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

/**
 * `/orchestrate` (B4.6): the triage -> plan -> size -> confirm -> dispatch ->
 * verify/escalate -> finalize flow lives in `pipeline/run-orchestration.ts`
 * (`runOrchestration`); this module owns arg parsing, model resolution,
 * session/registry setup, and the run's single cleanup point (the
 * cancellation/crash catch block, `session.close()`/`release()`/`finish()`
 * in `finally`). It also owns the final summary's `notify`/`postRunMessage`
 * pair: `runOrchestration` returns a `RunReport` (core/report.ts) rather than
 * posting anything itself, so this is the one place that decides how (and
 * whether) a settled run's outcome reaches the user.
 *
 * commands/* must not import index.ts. Every function this handler used to
 * call on index.ts's module scope (the resolved-adapter/session/telemetry
 * seams, the config constants) is a required field on `deps` instead; every
 * pure helper (git/lead-sizing/escalation/verdict-building/...) is imported
 * directly from its own module, same as any other caller.
 */
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseArgs, usageText, type ModelOverrides } from "../core/args.ts";
import { assembleProvidedContextBlock, contextFileLabel, CONTEXT_SOURCE_MAX_CHARS, formatContextSource, lastAssistantReplyText, LAST_REPLY_LABEL, providedContextAssemblyOverhead, providedContextSeparatorLength, type ContextSource } from "../core/context.ts";
import { goalRefersToMissingContext } from "../core/context-detector.ts";
import { redactPaths } from "../hooks/ingest.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import type { DispatchTask, PlanResponse } from "../core/prompts.ts";
import { buildRunSummary } from "../core/report.ts";
import type { TriageResult } from "../core/triage.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";
import { policyIdFor } from "../adapters/adapter-resolver.ts";
import { formatAdapterTable, userLayerWarnings } from "../models.ts";
import { safeUi } from "../run/ui-sink.ts";
import type { RunSession, RunTiming } from "../run/session.ts";
import type { RunContext, RunRegistry } from "../run/context.ts";
import type { FlushReport, QueueStats } from "../record-queue.ts";
import { runOrchestration, warnTelemetry, type RunOrchestrationDeps } from "../pipeline/run-orchestration.ts";

/** `planRun`'s options; structurally identical to index.ts's own (private) `PlanOptions` —
 *  redeclared here rather than imported so this module never has to import index.ts. */
interface PlanOptions {
	goal: string;
	taskClass: string;
	complexity: number;
	risk: string;
	qualityFloor?: number;
	costAggressiveness?: number;
}

/** The seams `registerOrchestrateCommand` needs; index.ts's caller supplies the real ones. */
export interface OrchestrateDeps {
	runRegistry: RunRegistry<RunSession>;
	resolveAdapter(ctx: ExtensionContext, overrides: ModelOverrides): Promise<FullResolution>;
	createSession(runId: string, ctx: ExtensionContext, goal: string): RunSession;
	triageTask(
		runId: string,
		goal: string,
		cwd: string,
		ctx: ExtensionContext,
		run: RunContext<RunSession> | null,
		costSink: { usd: number },
		adapter: Adapter,
	): Promise<TriageResult | null>;
	planRun(runId: string, opts: PlanOptions): Promise<PlanResponse>;
	recordEvent(event: string, payload: Record<string, unknown>): void;
	recordOutcome(outcome: Record<string, unknown>): void;
	captureDispatchCost(opts: CaptureOpts, result: DispatchResult, run: RunContext<RunSession> | null): Promise<void>;
	dispatchParallel(
		cwd: string,
		runId: string,
		tasks: DispatchTask[],
		adapter: Adapter,
		ctx: ExtensionContext,
		run: RunContext<RunSession> | null,
	): Promise<DispatchResult[]>;
	completeRun(runId: string, summary: Record<string, unknown>, timing?: RunTiming, since?: QueueStats): Promise<FlushReport>;
	failRun(runId: string, error: string, timing?: RunTiming, since?: QueueStats): Promise<FlushReport>;
	/** Ceiling on the topology's requested lead count (config.ts's `maxLeads`). */
	maxLeads: number;
	/** Rule-2 recon evidence packet budget (config.ts's `reconEvidenceMaxChars`). */
	reconEvidenceMaxChars: number;
	/** `<STATE_ROOT>`, shown in the final summary's ledger line. */
	stateRoot: string;
	/** Where `orchestrator-profiles.json` lives; used to build the usage text. */
	profilesPath: string;
}

/** Goals that ask the agents to come back with questions cannot be honored headlessly. */
function goalExpectsInteraction(goal: string): boolean {
	return /\b(ask|raise)\b.*\bquestions?\b|\bclarif(y|ication)|\bcheck (back )?with me\b|\bconfirm with me\b/i.test(goal);
}

/**
 * Bytes read from disk before `core/context.ts`'s per-source
 * `CONTEXT_SOURCE_MAX_CHARS` (character) cap is applied — generous headroom
 * (4x) for multi-byte UTF-8 content — so a huge `--context` file is never
 * read in full: only this bounded prefix ever touches memory
 * (docs/architecture-review.md C6).
 */
export const CONTEXT_FILE_PREFIX_BYTES = 4 * CONTEXT_SOURCE_MAX_CHARS;

/**
 * Aggregate cap across every `--context` file plus `--with-last-reply`
 * combined (docs/architecture-review.md C6): a single huge attachment is
 * already capped per-source (`CONTEXT_SOURCE_MAX_CHARS`), but several
 * attachments each near that cap could otherwise blow the prompt budget out
 * together. This bounds the final RENDERED `## Provided context` block —
 * labels, `<provided-context>` wrappers, and per-source notes all count,
 * not just raw file content — because that rendered text, not the raw
 * bytes on disk, is what actually reaches the model. Sources are consumed
 * IN ORDER and the budget is tracked incrementally: as soon as a source's
 * own rendered size would not fit in what is left, reading stops entirely
 * (no later `--context` file is even opened) and every source from that
 * point on, including the one that did not fit, is counted into ONE
 * collapsed omission notice appended at the end — not a truncation/omission
 * message per source. `loadProvidedContext` reserves `core/context.ts`'s
 * `providedContextAssemblyOverhead` (the header, per-section separators, and
 * the collapsed omission notice itself) OUT OF this budget before
 * accumulating any source, so the final ASSEMBLED block
 * (`assembleProvidedContextBlock`'s output) never exceeds this many
 * characters either — not just the sum of the sources' own rendered lengths
 * (docs/architecture-review.md C6).
 */
export const CONTEXT_AGGREGATE_MAX_CHARS = 160_000;

/**
 * Ceiling on the number of `--context <file>` flags a single run will accept
 * (docs/architecture-review.md C6), enforced BEFORE any file is opened — a
 * separate, independent guard from `CONTEXT_AGGREGATE_MAX_CHARS`: that caps
 * total rendered characters once files are read; this caps the number of
 * disk reads/open file descriptors a single `/orchestrate` invocation will
 * attempt at all; a typo'd shell glob (`--context *`) expanding into
 * hundreds or thousands of arguments fails fast here, with a clear error,
 * rather than the aggregate budget silently eating the run into it one file
 * at a time.
 */
export const MAX_CONTEXT_FILES = 16;

/**
 * Trims the trailing bytes of `buf` that would otherwise split a multi-byte
 * UTF-8 character in half — only relevant when `buf` is itself a bounded
 * prefix of a larger file (`CONTEXT_FILE_PREFIX_BYTES`), since the true end
 * of the file's last character is never read. Walks back at most 3 bytes
 * (the longest UTF-8 continuation run) looking for the lead byte of a
 * sequence that is not fully present in `buf`.
 */
function trimTrailingIncompleteUtf8(buf: Buffer): Buffer {
	const len = buf.length;
	for (let back = 1; back <= 3 && back <= len; back++) {
		const byte = buf[len - back];
		if ((byte & 0xc0) === 0x80) continue; // a UTF-8 continuation byte: keep walking back
		let seqLen = 1;
		if ((byte & 0xe0) === 0xc0) seqLen = 2;
		else if ((byte & 0xf0) === 0xe0) seqLen = 3;
		else if ((byte & 0xf8) === 0xf0) seqLen = 4;
		return seqLen > back ? buf.subarray(0, len - back) : buf;
	}
	return buf;
}

/**
 * Reads a `--context <file>` off disk, hardened against everything a hostile
 * or merely surprising path can do (docs/architecture-review.md C6):
 *
 * - Every path component strictly below a trusted anchor is `lstat`'d and
 *   rejected if it is a symlink — not just the immediate containing
 *   directory. A symlink anywhere in the chain (`docs/link/sso/x.json` with
 *   `docs/link -> ~/.aws`, however many levels up) is caught, not only a
 *   symlinked immediate parent. The anchor itself (`chooseTrustAnchor`
 *   below) is `realpath`'d but never itself `lstat`'d, which is what lets a
 *   symlinked top-level directory — macOS's `/tmp` -> `/private/tmp`,
 *   `/var` -> `/private/var`, and therefore every `os.tmpdir()`-based path
 *   — sit "above" the anchor without every ordinary temp file being
 *   rejected as symlinked for reasons that have nothing to do with the
 *   operator's path. The open itself also uses `O_NOFOLLOW` (the file's own
 *   path is refused if it is a symlink, kernel-enforced) as a second,
 *   independent check on the leaf.
 * - Only a regular file is accepted (`fstat(fd).isFile()`); FIFOs, device
 *   files, and directories are rejected with a clear message instead of
 *   hanging (`O_NONBLOCK`, where the platform has it, keeps an `open()` on a
 *   FIFO with no writer from blocking forever) or throwing something
 *   confusing.
 * - At most `CONTEXT_FILE_PREFIX_BYTES` is ever read, regardless of the
 *   file's real size — a multi-megabyte attachment is truncated, not read
 *   into memory in full.
 * - Binary content (a NUL byte in the prefix, or bytes that are not valid
 *   UTF-8 once any trailing split multi-byte character is trimmed) is
 *   rejected: this is a prompt-text attachment mechanism, not a general file
 *   upload.
 *
 * RESIDUAL RACE: Node has no `openat`, so every check above (the lstat walk,
 * the `realpath` equality check, and their post-open repeat below) is
 * necessarily a separate syscall from the `open()` that follows it — a
 * directory component could in principle be swapped for a symlink in the
 * instant between the LAST check and `open()` itself. The post-open
 * dev+ino re-verification narrows this window (it catches a swap that
 * happened before the open completed) but cannot close it entirely; this is
 * accepted as a residual risk for a single-operator CLI reading files it
 * already trusted enough to name on its own command line, not eliminated.
 *
 * Throws a plain `Error` with an operator-facing message on any rejection;
 * the caller (`loadProvidedContext`) turns that into `{ error }`.
 */
/** Best-effort `realpath`, used only to name the symlink target in a rejection message; `null` on failure. */
function safeRealpath(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** `realpath`, but a failure becomes the same operator-facing rejection every other unreadable-path
 *  case in this module throws — used for the trust anchor itself, which must resolve for any of
 *  the checks below to mean anything. */
function realpathOrThrow(path: string): string {
	try {
		return realpathSync(path);
	} catch (err) {
		throw new Error(`could not read the file (${(err as Error).message}). Fix the path or drop the flag.`);
	}
}

/** True when `child` is strictly inside (a descendant of, never equal to) directory `parent` —
 *  both given as normalized absolute paths, neither `realpath`'d. Used by `chooseTrustAnchor` to
 *  decide which lexical directory to walk from; matching on the LEXICAL (not `realpath`'d) form is
 *  what lets the walk below actually detect a symlinked component — resolving first would already
 *  have thrown away the very thing being checked for. */
function isStrictlyInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The first path segment after the root, e.g. `/var/folders/xx/T/foo` -> `/var`. Used as the
 *  trust anchor's lexical directory when `absLexical` is neither inside `cwd` nor the home
 *  directory (`chooseTrustAnchor`'s fallback branch): `realpath`'d, this tolerates a symlinked
 *  top-level directory (macOS's `/tmp` -> `/private/tmp`, `/var` -> `/private/var`) without
 *  walking — or having to trust — the whole ancestor chain down from `/`. */
function firstTopLevelComponent(absLexical: string): string {
	const withoutRoot = absLexical.slice(1);
	const firstSep = withoutRoot.indexOf(sep);
	const first = firstSep === -1 ? withoutRoot : withoutRoot.slice(0, firstSep);
	return sep + first;
}

/** The directory the ancestor-symlink walk starts from (docs/architecture-review.md C6). */
interface TrustAnchor {
	/** The anchor directory in its ORIGINAL (lexical, not `realpath`'d) spelling — the walk below
	 *  starts here, not from `real`: `realpath`-ing first would already have resolved away the very
	 *  symlink the walk exists to catch. */
	lexical: string;
	/** `realpath(lexical)` — trusted without itself being `lstat`'d; see `firstTopLevelComponent`'s
	 *  doc for why a symlinked top-level directory is deliberately tolerated here. */
	real: string;
}

/**
 * Picks the directory the ancestor-symlink walk in `walkAncestorsForSymlinks` starts from
 * (docs/architecture-review.md C6): `realpath(cwd)` when `absLexical` is lexically inside `cwd`
 * (the common case — an operator's `--context docs/plan.md`); otherwise `realpath(homedir())`
 * when it is inside the home directory, checked against BOTH the lexical and the already-resolved
 * home path (a home directory that is itself reached through a symlink, e.g. an NFS mount, must
 * not make every file under it look "outside" the anchor); otherwise `realpath` of the path's own
 * first top-level component (`/tmp`, `/var`, ...), which sits `realpath`-equivalent to but
 * lexically above the anchor so a symlinked top-level directory is tolerated without being trusted
 * blindly — everything BELOW it is still walked and `lstat`'d.
 */
function chooseTrustAnchor(absLexical: string, cwd: string): TrustAnchor {
	const cwdLexical = resolve(cwd);
	if (isStrictlyInside(absLexical, cwdLexical)) {
		return { lexical: cwdLexical, real: realpathOrThrow(cwdLexical) };
	}
	const homeLexical = resolve(homedir());
	const homeReal = safeRealpath(homeLexical);
	if (isStrictlyInside(absLexical, homeLexical)) {
		return { lexical: homeLexical, real: homeReal ?? realpathOrThrow(homeLexical) };
	}
	if (homeReal && isStrictlyInside(absLexical, homeReal)) {
		return { lexical: homeReal, real: homeReal };
	}
	const top = firstTopLevelComponent(absLexical);
	return { lexical: top, real: realpathOrThrow(top) };
}

/**
 * `lstat`'s every path component strictly below `anchor.lexical` on the way to `absLexical`
 * (docs/architecture-review.md C6) — including the file itself — and rejects if any of them is a
 * symlink, since the kernel would otherwise silently follow it while resolving the rest of the
 * path (the original bug this closes: only the immediate parent was ever checked, so a symlink
 * anywhere higher up — `docs/link/sso/x.json` with `docs/link -> ~/.aws` — was never caught).
 * `anchor.lexical` itself is never `lstat`'d (see `chooseTrustAnchor`'s doc). Returns the path
 * segments below the anchor, so the caller can reconstruct `join(anchor.real, ...segments)`.
 */
function walkAncestorsForSymlinks(anchor: TrustAnchor, absLexical: string): string[] {
	const relPart = relative(anchor.lexical, absLexical);
	const segments = relPart.split(sep).filter(Boolean);
	let cur = anchor.lexical;
	for (const [i, seg] of segments.entries()) {
		cur = join(cur, seg);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(cur);
		} catch (err) {
			throw new Error(`could not read the file (${(err as Error).message}). Fix the path or drop the flag.`);
		}
		if (st.isSymbolicLink()) {
			const target = safeRealpath(cur);
			const targetNote = target ? ` (resolves to ${redactPaths(target)})` : "";
			const refusal = "pass the target path directly instead (this refusal is deliberate — see docs/architecture-review.md C6).";
			if (i === segments.length - 1) {
				throw new Error(`is a symlink${targetNote}; ${refusal}`);
			}
			if (i === segments.length - 2) {
				throw new Error(`its containing directory is a symlink${targetNote}; ${refusal}`);
			}
			throw new Error(`an ancestor directory ("${redactPaths(cur)}")${targetNote} is a symlink; ${refusal}`);
		}
	}
	return segments;
}

export function readContextFileSafely(abs: string, cwd: string): { content: string; truncatedOnDisk: boolean } {
	const anchor = chooseTrustAnchor(abs, cwd);
	const segments = walkAncestorsForSymlinks(anchor, abs);
	const expectedPath = join(anchor.real, ...segments);
	// Additionally require realpath(abs) === the anchor-reconstructed path: a mismatch means
	// something in the chain resolves somewhere the lstat walk above did not see
	// (docs/architecture-review.md C6).
	let realAbs: string;
	try {
		realAbs = realpathSync(abs);
	} catch (err) {
		throw new Error(`could not read the file (${(err as Error).message}). Fix the path or drop the flag.`);
	}
	if (realAbs !== expectedPath) {
		throw new Error(
			`resolves outside its expected location; pass the target path directly instead (this refusal is deliberate — see docs/architecture-review.md C6).`,
		);
	}

	const nonBlock = fsConstants.O_NONBLOCK ?? 0;
	let fd: number;
	try {
		fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | nonBlock);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ELOOP") {
			const target = safeRealpath(abs);
			throw new Error(
				`is a symlink${target ? ` (resolves to ${redactPaths(target)})` : ""}; pass the target path directly instead (this refusal is deliberate — see docs/architecture-review.md C6).`,
			);
		}
		throw new Error(`could not read the file (${e.message}). Fix the path or drop the flag.`);
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			const kind = stat.isDirectory() ? "a directory" : stat.isFIFO() ? "a FIFO" : "not a regular file";
			throw new Error(`is ${kind}; only regular files can be attached with --context.`);
		}
		// Re-verify after opening (docs/architecture-review.md C6): narrows — does not close, see this
		// function's doc — the TOCTOU window between the checks above and this `open()` by re-stat'ing
		// via the anchor's own trusted real path and re-walking the component lstat chain. A mismatch
		// on either means a directory component was swapped out from under us in between.
		let expectedStat: ReturnType<typeof statSync>;
		try {
			expectedStat = statSync(expectedPath);
		} catch (err) {
			throw new Error(`could not read the file (${(err as Error).message}). Fix the path or drop the flag.`);
		}
		if (stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) {
			throw new Error(
				`changed underneath the safety check (possible symlink race); pass the target path directly instead (this refusal is deliberate — see docs/architecture-review.md C6).`,
			);
		}
		walkAncestorsForSymlinks(anchor, abs);

		const cap = Math.min(CONTEXT_FILE_PREFIX_BYTES, stat.size);
		const buffer = Buffer.alloc(cap);
		let readTotal = 0;
		while (readTotal < buffer.length) {
			const n = readSync(fd, buffer, readTotal, buffer.length - readTotal, null);
			if (n === 0) break;
			readTotal += n;
		}
		const bytes = buffer.subarray(0, readTotal);
		if (bytes.includes(0)) {
			throw new Error(`looks like binary content (a NUL byte was found); only text files can be attached with --context.`);
		}
		const truncatedOnDisk = stat.size > readTotal;
		const decodable = truncatedOnDisk ? trimTrailingIncompleteUtf8(bytes) : bytes;
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(decodable);
		} catch {
			throw new Error(`is not valid UTF-8 text; only text files can be attached with --context.`);
		}
		return { content, truncatedOnDisk };
	} finally {
		closeSync(fd);
	}
}

/**
 * Reads every `--context <file>` and, when asked, the current session's last assistant message,
 * building the `## Provided context` block the architect/lead prompts insert
 * (docs/architecture-review.md C6). A missing/unreadable/symlinked/binary/non-regular file or an
 * absent last reply is a user error: returned as `{ error }` instead of thrown, so the caller can
 * stop the run before a session/run dir is ever created. File reading and session access live
 * here (not in `core/context.ts`) so that module stays a pure string formatter.
 *
 * Three independent bounds apply, checked in this order:
 * 1. `MAX_CONTEXT_FILES` — a hard cap on the NUMBER of `--context` flags, enforced before any
 *    file is opened.
 * 2. `readContextFileSafely`'s `CONTEXT_FILE_PREFIX_BYTES` — a per-file cap on how much of any
 *    one file is ever read off disk.
 * 3. `CONTEXT_AGGREGATE_MAX_CHARS` — a cap on the total RENDERED size of the `## Provided
 *    context` block (labels, `<provided-context>` wrappers, and notes all counted, not just raw
 *    content). Sources are read and rendered ONE AT A TIME, in order; as soon as one does not fit
 *    in what is left, reading stops — no later `--context` file is even opened — and everything
 *    from that point on is folded into ONE collapsed omission notice naming how many attachments
 *    were skipped, rather than a truncation/omission message per source.
 */
export function loadProvidedContext(
	cwd: string,
	contextFiles: string[],
	withLastReply: boolean,
	ctx: ExtensionContext,
): { block: string } | { error: string } {
	if (contextFiles.length > MAX_CONTEXT_FILES) {
		return {
			error: `--context: ${contextFiles.length} files attached; at most ${MAX_CONTEXT_FILES} are allowed per run. Combine them into fewer files or drop some.`,
		};
	}

	const renderedSources: string[] = [];
	// The largest number of attachments a single call could ever report omitted: every --context
	// file (bounded by MAX_CONTEXT_FILES) plus, at most, --with-last-reply itself
	// (docs/architecture-review.md C6). Reserving budget for this now guarantees the FINAL
	// assembled block (header, per-section separators, and the collapsed omission notice all
	// included) never exceeds CONTEXT_AGGREGATE_MAX_CHARS, regardless of how many sources end up
	// included vs. omitted.
	const maxOmittedCount = MAX_CONTEXT_FILES + 1;
	let budgetLeft = CONTEXT_AGGREGATE_MAX_CHARS - providedContextAssemblyOverhead(maxOmittedCount);
	let omittedCount = 0;

	for (const raw of contextFiles) {
		// Once the aggregate budget is exhausted, stop reading entirely — this file is never opened,
		// only counted (docs/architecture-review.md C6).
		if (budgetLeft <= 0) {
			omittedCount++;
			continue;
		}
		const abs = resolve(cwd, raw);
		let read: { content: string; truncatedOnDisk: boolean };
		try {
			read = readContextFileSafely(abs, cwd);
		} catch (err) {
			return { error: `--context ${raw}: ${(err as Error).message}` };
		}
		const source: ContextSource = {
			label: contextFileLabel(cwd, abs),
			content: read.content,
			diskTruncationNote: read.truncatedOnDisk
				? `\n\n[... this file is larger than the ${CONTEXT_FILE_PREFIX_BYTES}-byte read limit; only the beginning was read ...]`
				: undefined,
		};
		const rendered = formatContextSource(source);
		const cost = rendered.length + providedContextSeparatorLength(renderedSources.length);
		if (cost > budgetLeft) {
			omittedCount++;
			budgetLeft = 0;
			continue;
		}
		renderedSources.push(rendered);
		budgetLeft -= cost;
	}

	if (withLastReply) {
		const text = lastAssistantReplyText(ctx.sessionManager.getEntries());
		if (text === null) {
			return { error: "--with-last-reply: no assistant message found in the current session." };
		}
		if (budgetLeft <= 0) {
			omittedCount++;
		} else {
			const rendered = formatContextSource({ label: LAST_REPLY_LABEL, content: text });
			const cost = rendered.length + providedContextSeparatorLength(renderedSources.length);
			if (cost > budgetLeft) {
				omittedCount++;
			} else {
				renderedSources.push(rendered);
				budgetLeft -= cost;
			}
		}
	}

	return { block: assembleProvidedContextBlock(renderedSources, omittedCount) };
}

/**
 * Post a run's terminal outcome to the chat as a custom message, so the user sees it
 * even though `/orchestrate` returned long before the run settled. `sendMessage` can
 * throw after the session has moved on (e.g. a later shutdown); that failure is not
 * this run's problem to surface, so it is swallowed and logged instead.
 */
function postRunMessage(
	pi: ExtensionAPI,
	runId: string,
	outcome: "completed" | "failed" | "cancelled",
	content: string,
	costUsd: number,
): void {
	try {
		pi.sendMessage(
			{ customType: "orchestrator-run", content, display: true, details: { runId, outcome, costUsd } },
			{ triggerTurn: false },
		);
	} catch (err) {
		console.warn(`[orchestrator] could not post run ${runId} summary to chat: ${(err as Error)?.message ?? err}`);
	}
}

export function registerOrchestrateCommand(pi: ExtensionAPI, deps: OrchestrateDeps): void {
	const usage = usageText(deps.profilesPath);
	pi.registerCommand("orchestrate", {
		description:
			"Plan and dispatch a hierarchical agent run. " +
			"Args: <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical] " +
			"[--profile NAME] [--lead-size small|standard|large] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--frontier ALIAS] [--model <capability>=ALIAS] [--effort LEVEL] " +
			"[--quality-floor F] [--cost-aggressiveness C] [--max-retries R] [--interactive] " +
			"[--context FILE ...] [--with-last-reply] [--force]\n\n" +
			"With no triage flags, an LLM triage call (cheapest configured model) " +
			"auto-fills task_class, complexity, and risk from the goal text. " +
			"Models: flags > profile (orchestrator-profiles.json) > cost-tier resolver. See /orchestrator-models.",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (!parsed.goal) {
				ctx.ui.notify(usage, "warning");
				return;
			}
			if (parsed.unknownFlags.length > 0) {
				ctx.ui.notify(`Unknown flag(s): ${parsed.unknownFlags.join(", ")}\n${usage}`, "error");
				return;
			}
			const alreadyActive = deps.runRegistry.active();
			if (alreadyActive) {
				ctx.ui.notify(
					`An orchestration is already running (${alreadyActive.session.runId}). Wait for it to finish; its log is ${alreadyActive.session.file("run.log")}.`,
					"warning",
				);
				return;
			}

			// -----------------------------------------------------------------
			// C7 (docs/architecture-review.md): a short goal that refers to something outside
			// itself ("do A then C then B", "implement option 2", "the above") blocks the
			// dispatched agents, who have nothing to attach the reference to. Stop before
			// triage/planning/dispatch — no run dir is created — unless the operator already
			// attached context or explicitly asked to skip this check.
			// -----------------------------------------------------------------
			const hasContext = parsed.contextFiles.length > 0 || parsed.withLastReply;
			if (!hasContext && !parsed.force && goalRefersToMissingContext(parsed.goal)) {
				ctx.ui.notify(
					"This goal looks short and refers to something outside itself (a lettered/numbered item, " +
						'"the above", "as discussed", or similar) that the dispatched agents will not have. ' +
						"Attach it with --context <file> (repeatable) or --with-last-reply, or skip this check with --force.",
					"warning",
				);
				return;
			}

			// C6 (docs/architecture-review.md): read every --context file and, when asked, the
			// session's last assistant reply, before anything else is spent. A missing file or an
			// absent last reply stops the run here — no session/run dir is created.
			const providedContextResult = loadProvidedContext(process.cwd(), parsed.contextFiles, parsed.withLastReply, ctx);
			if ("error" in providedContextResult) {
				ctx.ui.notify(providedContextResult.error, "error");
				return;
			}
			const providedContext = providedContextResult.block;

			// -----------------------------------------------------------------
			// Step 0: resolve models. Done before anything is spent so a typo in
			// --premium or the override file stops the run here, not after a
			// 10-minute architect pass on the wrong model.
			// -----------------------------------------------------------------
			const resolved = await deps.resolveAdapter(ctx, parsed.models);
			const adapter = resolved.adapter;
			const overrideErrors = userLayerWarnings(resolved);
			if (overrideErrors.length > 0 || resolved.profiles.problems.length > 0) {
				ctx.ui.notify(
					`Model configuration is invalid — nothing was dispatched:\n${[...resolved.profiles.problems, ...overrideErrors].map((w) => `- ${w}`).join("\n")}\n\nFix with /orchestrator-models set <capability|tier> <alias>, or /orchestrator-models list to see aliases.`,
					"error",
				);
				return;
			}
			for (const w of resolved.warnings) ctx.ui.notify(w, "warning");
			for (const n of resolved.profiles.notes) ctx.ui.notify(n, "info");

			if (goalExpectsInteraction(parsed.goal)) {
				ctx.ui.notify(
					"Heads-up: dispatched agents run non-interactively and cannot ask you questions mid-run. " +
						"They are instructed to make the conservative choice and list open questions in their final report, which is shown when the run completes.",
					"warning",
				);
			}

			const runId = `ht-orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const session = deps.createSession(runId, ctx, parsed.goal);
			// Re-check: the first guard above ran before the `await resolveAdapter` a few lines up,
			// so a second /orchestrate invocation could have raced through that same window and
			// already claimed the registry by the time we get here. Losing this race must not let two
			// sessions both believe they own it, so `claim()` re-checks and sets atomically, right
			// before the write, instead of trusting the guard above's now-stale result.
			const claimed = deps.runRegistry.claim(
				session,
				{ profile: resolved.profileName, policy_id: policyIdFor(resolved.profileName, adapter) },
				resolved.table,
			);
			if (!claimed) {
				ctx.ui.notify(
					`An orchestration is already running (${deps.runRegistry.active()!.session.runId}). Wait for it to finish; its log is ${deps.runRegistry.active()!.session.file("run.log")}.`,
					"warning",
				);
				session.close();
				await session.sealDiagnostics();
				session.finish();
				return;
			}
			session.log(`policy: ${claimed.tags.policy_id}`);
			session.log(`models (profile "${resolved.profileName}"):\n${formatAdapterTable(resolved).map((l) => `  ${l}`).join("\n")}`);
			for (const n of resolved.notes) session.log(`note: ${n}`);

			// Everything from here on (triage, plan, dispatch, verification, completion)
			// runs detached from the command handler: /orchestrate returns as soon as this
			// promise is started, so the session stays responsive (queueing /omsg, checking
			// orchestrator_status, issuing /orchestrate-cancel) while children run. The
			// try/catch/finally below is the run's single cleanup point regardless of how
			// it ends — success, failure, cancellation, or shutdown.
			const runPromise = (async () => {
			const cwd = process.cwd();
			try {
				const orchestrationDeps: RunOrchestrationDeps = {
					triageTask: deps.triageTask,
					planRun: deps.planRun,
					recordEvent: deps.recordEvent,
					recordOutcome: deps.recordOutcome,
					captureDispatchCost: deps.captureDispatchCost,
					dispatchParallel: deps.dispatchParallel,
					completeRun: deps.completeRun,
					failRun: deps.failRun,
					maxLeads: deps.maxLeads,
					reconEvidenceMaxChars: deps.reconEvidenceMaxChars,
					stateRoot: deps.stateRoot,
					providedContext,
				};
				const result = await runOrchestration(runId, cwd, parsed, adapter, resolved, ctx, session, claimed, orchestrationDeps);
				if (result.kind === "completed") {
					const { text: summaryText, succeeded } = buildRunSummary(result.report);
					session.log(summaryText);
					safeUi(() => ctx.ui.notify(summaryText, succeeded ? "info" : "warning"));
					postRunMessage(pi, runId, succeeded ? "completed" : "failed", summaryText, result.report.totalCostUsd);
				}
			} catch (err) {
				if (session.cancellation.isCancelled) {
					const stopped = session.cancelledDispatches();
					session.log(`run cancelled by user; stopped dispatches: ${stopped.join(", ") || "none active"}`);
					const cancelReason = session.cancelReason;
					const cancelNote =
						cancelReason === "shutdown"
							? "cancelled (session shutdown)"
							: cancelReason === "signal"
								? "cancelled (signal)"
								: "cancelled by user (/orchestrate-cancel)";
					warnTelemetry(ctx, await deps.failRun(runId, cancelNote, session.terminalTiming(), session.telemetryBaseline));
					const cancelText = `Orchestration cancelled. ${stopped.length ? `Stopped: ${stopped.join(", ")}. ` : "No child dispatch was active. "}See ${session.file("run.log")}`;
					safeUi(() => ctx.ui.notify(cancelText, "info"));
					// Only a user-initiated cancel (/orchestrate-cancel) has a live session to post
					// into; a shutdown or signal cancel means the session itself is going away.
					if (cancelReason === "user") {
						postRunMessage(pi, runId, "cancelled", cancelText, session.totalCost());
					}
				} else {
					// Any uncaught throw used to leave the run half-recorded (no outcome
					// row) and the UI stuck on the last notify. Record + surface it.
					const message = (err as Error).stack ?? String(err);
					session.log(`run crashed: ${message}`);
					warnTelemetry(ctx, await deps.failRun(runId, `crashed: ${(err as Error).message}`, session.terminalTiming(), session.telemetryBaseline));
					const crashText = `Orchestration crashed: ${(err as Error).message}\nSee ${session.file("run.log")}`;
					safeUi(() => ctx.ui.notify(crashText, "error"));
					postRunMessage(pi, runId, "failed", crashText, session.totalCost());
				}
			} finally {
				try {
					safeUi(() => session.close());
					await session.sealDiagnostics();
				} finally {
					// A newer race winner may already have replaced the registry's active
					// context with its own (see the re-check guard above); release() only
					// clears the registry when `claimed` — by identity — is still the
					// current owner, so a stale run's finally never clobbers a newer one.
					deps.runRegistry.release(claimed);
					session.finish();
				}
			}
			})();
			session.runPromise = runPromise;
			runPromise.catch((err) => {
				console.error(`[orchestrator] run ${runId} background task rejected unexpectedly: ${(err as Error)?.stack ?? err}`);
			});
		},
	});

}

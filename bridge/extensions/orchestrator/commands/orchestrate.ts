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
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { parseArgs, usageText, type ModelOverrides } from "../core/args.ts";
import { buildProvidedContextBlock, contextFileLabel, CONTEXT_SOURCE_MAX_CHARS, lastAssistantReplyText, LAST_REPLY_LABEL, type ContextSource } from "../core/context.ts";
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
const CONTEXT_FILE_PREFIX_BYTES = 4 * CONTEXT_SOURCE_MAX_CHARS;

/**
 * Aggregate cap across every `--context` file plus `--with-last-reply`
 * combined (docs/architecture-review.md C6): a single huge attachment is
 * already capped per-source (`CONTEXT_SOURCE_MAX_CHARS`), but several
 * attachments each near that cap could otherwise blow the prompt budget out
 * together. Sources are consumed in order; once the budget is exhausted,
 * later content is truncated (with a note) rather than the run being
 * rejected outright.
 */
export const CONTEXT_AGGREGATE_MAX_CHARS = 160_000;

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
 * - Symlinks are rejected outright, at two points: the immediate containing
 *   directory is `lstat`'d first (a symlinked parent is rejected before any
 *   open() call reaches it), and the open itself uses `O_NOFOLLOW` (the
 *   file's own path is refused if it is a symlink, kernel-enforced, no
 *   TOCTOU window). Deliberately does not walk the whole ancestor chain with
 *   `realpath` — on macOS `/tmp` (and therefore every `os.tmpdir()`-based
 *   path) already resolves through `/private/tmp`, so a full-chain
 *   comparison would reject ordinary temp files as "symlinked" for reasons
 *   that have nothing to do with the operator's path.
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

export function readContextFileSafely(abs: string): { content: string; truncatedOnDisk: boolean } {
	const parent = dirname(abs);
	let parentStat: ReturnType<typeof lstatSync>;
	try {
		parentStat = lstatSync(parent);
	} catch (err) {
		throw new Error(`could not read the file (${(err as Error).message}). Fix the path or drop the flag.`);
	}
	if (parentStat.isSymbolicLink()) {
		const target = safeRealpath(parent);
		throw new Error(
			`its containing directory is a symlink${target ? ` (resolves to ${redactPaths(target)})` : ""}; pass the target path directly instead (this refusal is deliberate — see docs/architecture-review.md C6).`,
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
 * here (not in `core/context.ts`) so that module stays a pure string formatter. Every source is
 * bounded per-file (`readContextFileSafely`'s `CONTEXT_FILE_PREFIX_BYTES`) and, once collected,
 * bounded again in aggregate (`CONTEXT_AGGREGATE_MAX_CHARS`) so several near-cap attachments
 * together cannot blow the prompt budget out.
 */
export function loadProvidedContext(
	cwd: string,
	contextFiles: string[],
	withLastReply: boolean,
	ctx: ExtensionContext,
): { block: string } | { error: string } {
	const sources: ContextSource[] = [];
	for (const raw of contextFiles) {
		const abs = resolve(cwd, raw);
		let read: { content: string; truncatedOnDisk: boolean };
		try {
			read = readContextFileSafely(abs);
		} catch (err) {
			return { error: `--context ${raw}: ${(err as Error).message}` };
		}
		const content = read.truncatedOnDisk
			? `${read.content}\n\n[... this file is larger than the ${CONTEXT_FILE_PREFIX_BYTES}-byte read limit; only the beginning was read ...]`
			: read.content;
		sources.push({ label: contextFileLabel(cwd, abs), content });
	}
	if (withLastReply) {
		const text = lastAssistantReplyText(ctx.sessionManager.getEntries());
		if (text === null) {
			return { error: "--with-last-reply: no assistant message found in the current session." };
		}
		sources.push({ label: LAST_REPLY_LABEL, content: text });
	}
	let budgetLeft = CONTEXT_AGGREGATE_MAX_CHARS;
	for (const source of sources) {
		if (budgetLeft <= 0) {
			source.content = `[... omitted: the aggregate --context/--with-last-reply budget (${CONTEXT_AGGREGATE_MAX_CHARS} characters total) was already used up by earlier sources ...]`;
			continue;
		}
		if (source.content.length > budgetLeft) {
			const over = source.content.length - budgetLeft;
			source.content = `${source.content.slice(0, budgetLeft)}\n\n[... truncated: the aggregate --context/--with-last-reply budget (${CONTEXT_AGGREGATE_MAX_CHARS} characters total) was exceeded; ${over} more character(s) of this source omitted ...]`;
			budgetLeft = 0;
		} else {
			budgetLeft -= source.content.length;
		}
	}
	return { block: buildProvidedContextBlock(sources) };
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

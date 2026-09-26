/**
 * The remaining `runSubagentProcess` (B4.5 step 5) — spawns
 * `humain-terminal --mode json -p --no-session` as a one-shot subagent and
 * parses its JSON event stream for the assistant `message_end`, which
 * carries `model`, `usage`, and `cost.total`. This is the same on-the-wire
 * protocol the human-facing subagent tool uses internally — we just launch
 * it from a context (extension handler) where the human-facing wrapper
 * doesn't have what it needs.
 *
 * Everything argv/env/persona/event-accounting/outcome-classification this
 * used to do inline now lives in dispatch/child-args.ts, dispatch/persona.ts,
 * dispatch/child-events.ts and dispatch/stderr-sink.ts; this module is the
 * process lifecycle (spawn, timeouts, cancellation, spend caps, stdout/stderr
 * capture, the close handler's byte-diffing) that ties them together.
 *
 * dispatch/* must not import index.ts. `RunSession` (index.ts) is never named
 * here — `DispatchSession` below is the structural slice of it this module
 * actually calls, so `RunSession` satisfies it without either module
 * importing the other. Similarly, `recordEvent` (index.ts's telemetry
 * wrapper) is taken as an optional opts field rather than imported: index.ts's
 * re-exported `runSubagentProcess` supplies the real one by default.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { discoverAgents, type ExtensionContext, renderTaskWithContext, type SubagentUsageStats } from "@humain/terminal";

import { RunCancellation } from "../cancellation.ts";
import { RunDiagnostics, type DiagnosticWriter } from "../run-diagnostics.ts";
import { SpendCapTracker, capFor, type SpendCapVerdict } from "../spend-cap.ts";
import { NestedCostTracker } from "../nested-cost.ts";
import { killProcessTree } from "../adapters/process-reaper.ts";
import {
	DispatchProgressTracker,
	ORCHESTRATING_CAPABILITIES,
	buildInterruptionReport,
	renderInterruptionReport,
	summarizeInterruption,
	resolveDispatchTimeoutPolicy,
	applyLeadTimeoutOverride,
	type DispatchTimeoutPolicy,
	type InterruptionReport,
} from "../dispatch-progress.ts";
import type { ProgressObservation, TimeoutCheck } from "../dispatch-progress.ts";
import {
	BoundedCapture,
	capChildStderrFile,
	classifyDispatchOutcome,
	MAX_CHILD_STDERR_DISK_BYTES,
	readStderrFileBounded,
	summarizeStderr,
	trimEventForLog,
} from "./stderr-sink.ts";
import { buildChildArgs, buildChildEnv, personaCanMutateFor } from "./child-args.ts";
import { resolvePersona } from "./persona.ts";
import { ChildEventAccumulator, type ChildEventDelta, type ChildStreamEvent } from "./child-events.ts";

/** Sentinel agent name: spawn with HT's default system prompt, no persona file. */
export const NO_PERSONA = "__no_persona__";

export const PERSONA_TMP_PREFIX = "orch-agent-";

/**
 * PIDs of dispatched children that are still running. Children are spawned
 * `detached` (own process group) so a timeout can kill their whole subtree; the
 * flip side is that they would outlive a killed parent, so the parent reaps them
 * on the way out. index.ts's activation wiring passes this same set into
 * `adapters/process-reaper.ts`'s `installDispatchReaper`.
 */
export const liveDispatchPids = new Set<number>();

/** Ensure failures in a child stream listener cannot escape into the TUI. */
export function guardChildStreamHandler(
	handlerName: string,
	handler: () => void,
	onFailure: {
		appendStderr: (text: string) => void;
		kill: () => void;
		finish: (exitCode: number) => void;
	},
): void {
	try {
		handler();
	} catch (error) {
		let message = "unknown error";
		try {
			message = error instanceof Error ? error.message : String(error);
		} catch {
			/* a malformed thrown value must not escape the stream listener */
		}
		try {
			onFailure.appendStderr(`\n[orchestrator] ${handlerName} handler failed: ${message}`);
		} catch {
			/* avoid a diagnostic failure escaping the stream listener */
		}
		try {
			onFailure.kill();
		} catch {
			/* killing a child that already exited is harmless */
		}
		try {
			onFailure.finish(1);
		} catch {
			/* the stream listener must never throw */
		}
	}
}

/**
 * The structural slice of `RunSession` (index.ts) that a dispatch actually
 * calls. Declared here, not imported from index.ts, so dispatch/* never
 * depends on the HT extension module; `RunSession` satisfies this
 * structurally with no explicit `implements`.
 */
export interface DispatchSession {
	readonly runId: string;
	readonly ctx: ExtensionContext;
	readonly dir: string;
	readonly cancellation: RunCancellation;
	readonly diagnostics: RunDiagnostics;
	readonly spendCaps: SpendCapTracker;
	log(line: string): void;
	writeDiagnostic(name: string, text: string): boolean;
	drainMessages(recipient: string): string[];
	startDispatch(taskId: string, label: string, model: string, depth?: number): void;
	endDispatch(taskId: string, exitCode: number, costUsd: number, note?: string): void;
	onChildEvent(taskId: string, event: ChildStreamEvent, delta: ChildEventDelta): void;
	setNestedCost(taskId: string, costUsd: number): void;
	recordProgress(taskId: string, observation: ProgressObservation, check: TimeoutCheck, now?: number): void;
}

export interface SubagentProcessResult {
	exitCode: number;
	/** Every assistant text block, in order, joined by blank lines. */
	stdout: string;
	/** The LAST assistant text block — the child's final answer. */
	finalText: string;
	/** Bounded head-and-tail capture of the raw JSON event stream for diagnostics. */
	rawStdout: string;
	/** False when the resolved persona had no write/edit tool, so it cannot have changed files. */
	personaCanMutate: boolean;
	stderr: string;
	model?: string;
	usage: SubagentUsageStats;
	costUsd: number;
	/** Spend of `subagent` calls the child made itself (not bridge dispatches); excluded from `costUsd`. */
	nestedCostUsd?: number;
	/** True only when every received usage block explicitly reported a valid cost (including $0). */
	costReported: boolean;
	durationMs: number;
	stopReason?: string;
	/** Process disposition after considering terminal JSON events. */
	outcome: "completed" | "completed_after_process_error" | "failed" | "timed_out" | "cancelled";
	timeoutReason?: "inactivity" | "absolute";
	interruption?: InterruptionReport;
	/** Raw child exit code before terminal-result recovery. */
	processExitCode: number;
	/** Teardown error retained alongside a valid settled result. */
	postCompletionError?: string;
}

/**
 * Pick the right binary + args to invoke Pi in --mode json. Mirrors the
 * getCliInvocation() helper in the coding-agent subagent tool, inlined here because
 * that helper is module-private.
 */
function orchCliInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}
	// HT ships as a compiled bun binary, so argv[1] is a /$bunfs/root/ virtual
	// path and we fall through to here. `basename` must come from the static
	// node:path import — an earlier revision referenced a bare `path.basename`
	// with no `path` binding in scope, which threw ReferenceError on every
	// dispatch and produced the "0 succeeded / $0.0000" phantom runs.
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: extraArgs };
	}
	return { command: "humain-terminal", args: extraArgs };
}

/**
 * Narrow, single-signature shape for the child launcher seam. `spawn` itself
 * is a heavily overloaded function (stdio-shape-dependent return types,
 * options-optional variants, ...); assigning that whole overload set to an
 * optional property makes both the default (`spawn`) and a test's injected
 * function fight the overload resolver. Only the
 * `(command, args, options) => ChildProcess` overload is ever used at the one
 * call site below, so the seam is typed to exactly that call shape — the real
 * `spawn` satisfies it structurally, and tests can supply a plain function
 * without fighting the overload set.
 */
type ChildSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

interface StderrTarget {
	readonly path: string;
	readonly fd: number;
	/**
	 * The diagnostic name every `diagnosticWriter.write/append` call for this
	 * dispatch must target. Equal to the dispatch's own `<taskId>.stderr.log`
	 * name in the normal case (where `path` above IS that same diagnostics
	 * file). In the taskId-collision fallback case, `path` is instead a
	 * private temp file, and this is a distinct, reserved name (`<name>.fallback`,
	 * or `.fallback-2`, `.fallback-3`, ... if already taken) so writes for this
	 * dispatch can never land on — and so can never clobber — the earlier
	 * dispatch's own `<taskId>.stderr.log`.
	 */
	readonly persistName: string;
	/** Close the caller's copy of the fd. Idempotent. */
	closeFd(): void;
	/** Release the write lease/temp file. Idempotent; closes the fd first if not already closed. */
	release(): void;
}

/**
 * Fallback diagnostic names already claimed for a given `RunDiagnostics`
 * instance, keyed by owner so concurrent taskId collisions within one session
 * pick distinct escape-hatch names instead of racing each other onto the same
 * `.fallback` file. Reservation happens synchronously (no `await` between
 * checking and claiming), so within-process races cannot occur even though
 * dispatches run concurrently.
 */
const reservedFallbackNames = new WeakMap<RunDiagnostics, Set<string>>();

function reserveFallbackName(diagnostics: RunDiagnostics, stderrName: string): string {
	let reserved = reservedFallbackNames.get(diagnostics);
	if (!reserved) {
		reserved = new Set();
		reservedFallbackNames.set(diagnostics, reserved);
	}
	let candidate = `${stderrName}.fallback`;
	let attempt = 2;
	while (reserved.has(candidate) || existsSync(join(diagnostics.dir, candidate))) {
		candidate = `${stderrName}.fallback-${attempt}`;
		attempt += 1;
	}
	reserved.add(candidate);
	return candidate;
}

/**
 * Open the destination for a child's stderr as a real file descriptor,
 * never a pipe. Node prints the offending source line first on an uncaught
 * exception, then the error's name/message/stack; HT's minified bundle has
 * source lines up to ~650 KB, and Node's async pipe read can silently drop
 * everything past its ~64 KiB buffer once the child exits — exactly where
 * that name/message/stack lives. A real fd has no such loss: the child
 * writes straight to a file, and the bytes are visible to any other reader
 * (including this process, after `close`) as soon as the write syscall
 * returns.
 *
 * With a session, the destination is the run's own `<taskId>.stderr.log`,
 * opened under `RunDiagnostics`' fresh-directory/inode/lease guarantees
 * (see run-diagnostics.ts) so it participates in the same drain-then-seal
 * lifecycle as every other diagnostic file. Without a session (e.g. triage,
 * or a caller that never started a run), it is a private mode-0600 temp file
 * that the caller must remove via `release()`.
 */
function openStderrTarget(session: DispatchSession | undefined, stderrName: string): StderrTarget {
	if (session) {
		try {
			const backing = session.diagnostics.openChildStderrFile(stderrName);
			return { path: backing.path, fd: backing.fd, persistName: stderrName, closeFd: backing.closeFd, release: backing.release };
		} catch (err) {
			// A reused taskId within one session (unexpected, but not worth failing
			// the whole dispatch over) or diagnostics already closing/sealed. Fall
			// back to a private temp file rather than losing the fd-vs-pipe fix —
			// but that fallback is otherwise invisible, so log it. `persistName`
			// below is a reserved name distinct from `stderrName`: every later
			// `diagnosticWriter.write/append` call for THIS dispatch must route
			// through it, never through `stderrName` itself, or it would reopen
			// and clobber the earlier dispatch's already-registered file.
			const message = `stderr for ${stderrName} fell back to a private temp file: ${(err as Error).message}`;
			console.warn(`[orchestrator] ${message}`);
			try { session.log(message); } catch { /* best-effort */ }
			const dir = mkdtempSync(join(tmpdir(), "orch-subagent-stderr-"));
			const path = join(dir, stderrName);
			const persistName = reserveFallbackName(session.diagnostics, stderrName);
			let fd: number;
			try {
				fd = openSync(path, "wx", 0o600);
			} catch (openErr) {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
				throw openErr;
			}
			let fdOpen = true;
			const closeFd = () => {
				if (!fdOpen) return;
				fdOpen = false;
				try { closeSync(fd); } catch { /* already closed */ }
			};
			return {
				path,
				fd,
				persistName,
				closeFd,
				release: () => {
					closeFd();
					// finish()/the 'close' handler already persist this dispatch's real
					// and orchestrator-authored content under `persistName` as it goes
					// (see runSubagentProcess); nothing further needs copying here.
					// Just remove the private temp file/dir.
					try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
				},
			};
		}
	}
	// No session at all (e.g. triage): private mode-0600 temp file, removed via
	// release(). `persistName` is unused here — nothing ever writes through a
	// `diagnosticWriter`, since there is no session to own one.
	const dir = mkdtempSync(join(tmpdir(), "orch-subagent-stderr-"));
	const path = join(dir, stderrName);
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (err) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
		throw err;
	}
	let fdOpen = true;
	const closeFd = () => {
		if (!fdOpen) return;
		fdOpen = false;
		try { closeSync(fd); } catch { /* already closed */ }
	};
	return {
		path,
		fd,
		persistName: stderrName,
		closeFd,
		release: () => {
			closeFd();
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
		},
	};
}

export async function runSubagentProcess(opts: {
	cwd: string;
	agentName: string;
	task: string;
	model: string;
	effort?: string;
	tools?: string[];
	ctx: ExtensionContext;
	/** Stable id used for the progress board and log file names. */
	taskId?: string;
	/** Short human label for the progress board (defaults to agentName). */
	label?: string;
	/** Selects the wall clock: orchestrating capabilities wait on their own children. */
	capability?: string;
	/** Nesting depth for the widget (0 = top-level, 1 = child of a lead, etc.). */
	depth?: number;
	/** Test seam for deterministic progress/absolute timeout coverage. */
	leadTimeouts?: { inactivityMs: number; maxMs: number };
	/**
	 * Owning session, so this dispatch's progress/diagnostics land on the run's
	 * board and log (B4.4: every production caller now passes its RunContext's
	 * `session` explicitly — dispatchParallel's `runOn`, triageTask, and
	 * checkModels's probe all do; this function itself never reads a module-level
	 * "active run" global). Omitted entirely by tests that want the "no session"
	 * behaviour (diagnostics go to a private temp file; see openStderrTarget).
	 */
	session?: DispatchSession;
	/**
	 * Test seam only: replaces the real child launcher. Defaults to node's
	 * `spawn`; production callers never set this. Lets tests exercise the real
	 * stream/event/close handling below against a deterministic local fixture
	 * instead of the actual `humain-terminal --mode json` binary.
	 */
	/*
	 * This branch previously added a second positional parameter
	 * (`spawnProcess: ChildSpawner = spawn`) for the same purpose. Converged on
	 * `spawnChild` instead of shipping two seams for one job: it is the one
	 * main's suite already exercises, and keeping it inside the options object
	 * means the next seam does not grow the signature again.
	 */
	spawnChild?: ChildSpawner;
	/**
	 * Test seam only: replaces the real `discoverAgents` import from `@humain/terminal`.
	 * Production callers never set this; defaults to the real `discoverAgents`.
	 */
	discoverAgentsFn?: typeof discoverAgents;
	/**
	 * Telemetry sink for `spend_cap_exceeded`. Optional so dispatch/* never
	 * has to import index.ts's `recordEvent` (which wraps its telemetry
	 * singleton); defaults to a no-op. index.ts's re-exported
	 * `runSubagentProcess` supplies the real one when the caller omits it.
	 */
	recordEvent?: (event: string, payload: Record<string, unknown>) => void;
	/**
	 * The child's base env (before `buildChildEnv`'s dispatch overrides) and the
	 * source `resolveDispatchTimeoutPolicy` reads its `HUMAIN_ORCHESTRATOR_*_TIMEOUT_MS`
	 * overrides from, called fresh at each of the three points below (B4.4 review
	 * fix) so a caller that mutates `process.env` between dispatches (index.test.ts
	 * does) is still observed, exactly as when this module read `process.env`
	 * directly. Required (B4.5 hardening): an omitted getter used to default to
	 * `() => ({})`, which spawned the child with an EMPTY environment (no PATH,
	 * no HOME, no provider credentials) whenever a caller forgot it — silent and
	 * far worse than a type error. dispatch/* itself still never imports
	 * `process.env`/config.ts: index.ts's re-exported `runSubagentProcess` keeps
	 * `env` optional for ITS callers and always supplies `config.ts`'s `liveEnv`
	 * here.
	 */
	env: () => NodeJS.ProcessEnv;
}): Promise<SubagentProcessResult> {
	const session = opts.session;
	const recordEvent = opts.recordEvent ?? (() => {});
	const envGetter = opts.env;
	session?.cancellation.throwIfCancelled();
	const taskId = opts.taskId ?? `${opts.agentName}-${Date.now()}`;
	const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]+/g, "_");
	const eventsName = `${safeTaskId}.events.jsonl`;
	const stderrName = `${safeTaskId}.stderr.log`;
	if (session) {
		try {
			session.writeDiagnostic(`${safeTaskId}.prompt.md`, opts.task);
		} catch {
			/* best-effort */
		}
		session.startDispatch(taskId, opts.label ?? opts.agentName, opts.model, opts.depth ?? 0);
	}

	// Resolve the orchestrator agent persona the same way the subagent tool
	// does: read the agent markdown from the runtime's agents/ directories and
	// pass its body via --append-system-prompt (dispatch/persona.ts). There is NO
	// `--agent` CLI flag; passing one makes HT exit 1 with "Unknown option:
	// --agent" before it ever contacts a provider, which is what silently
	// zeroed out every dispatch.
	const personaResolution = resolvePersona({
		cwd: opts.cwd,
		agentName: opts.agentName,
		noPersonaSentinel: NO_PERSONA,
		discoverAgents: opts.discoverAgentsFn ?? discoverAgents,
		tmpPrefix: PERSONA_TMP_PREFIX,
	});
	// A persona that WAS found but whose prompt file failed to write (or whose
	// discovery threw) must not silently fall back to the default persona with
	// no trace: log it on the session and surface it as a dispatch diagnostic.
	if (personaResolution.error && session) {
		session.log(`persona resolution for ${opts.agentName} failed: ${personaResolution.error}`);
		try {
			session.writeDiagnostic(`${safeTaskId}.persona-error.log`, personaResolution.error);
		} catch {
			/* best-effort diagnostic write */
		}
	}

	const tools = opts.tools && opts.tools.length > 0 ? opts.tools : personaResolution.tools;
	const personaCanMutate = personaCanMutateFor(tools);
	const args = buildChildArgs({
		model: opts.model,
		effort: opts.effort,
		promptPath: personaResolution.promptPath,
		tools,
		task: renderTaskWithContext(opts.task, undefined),
	});

	const startedAt = Date.now();
	return new Promise<SubagentProcessResult>((resolve) => {
		const invocation = orchCliInvocation(args);
		const env: NodeJS.ProcessEnv = buildChildEnv(envGetter(), { cwd: opts.cwd });
		let buffer = "";
		// Raw child events can recursively include full worker histories. Retain
		// only diagnostics, never the unbounded stream.
		const stdoutCapture = new BoundedCapture();
		// Node can truncate a chatty child's async pipe at 64 KiB, so retain both
		// the runtime header and the diagnostic tail without unbounded memory use.
		const stderrCapture = new BoundedCapture();
		// The one accumulator for this dispatch's child event stream (B4.5 step 3):
		// owns usage/cost/turns/model/stopReason/settled-flags so neither this
		// function nor `session.onChildEvent` re-derives them independently.
		const events = new ChildEventAccumulator();
		const nestedCost = new NestedCostTracker();
		/** Own turns plus the child's own subagent calls: what the dispatch has cost so far. */
		const spentSoFar = () => events.usage.cost + nestedCost.total();
		let timedOut = false;
		let cancelledByListener = false;
		let timeoutReason: "inactivity" | "absolute" | undefined;
		let interruption: InterruptionReport | undefined;
		let spawnFailed = false;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let removeCancellationListener: (() => void) | undefined;
		let progressTracker: DispatchProgressTracker | undefined;
		let isLead = false;
		let dispatchStartedAt = startedAt;
		let toolCalls = 0;
		let assistantTurns = 0;
		let interruptionNote: string | undefined;
		let armTimer: () => void = () => {};
		let handleExpiry: (reason: "inactivity" | "absolute") => void = () => {};
		let handleSpendCap: (verdict: Exclude<SpendCapVerdict, "ok">) => void = () => {};
		// `--mode json` writes newline-delimited events, NOT plain prose. Callers
		// need the assistant's text, so accumulate it here; handing them the raw
		// event stream made triage's JSON.parse fail every single time.
		const assistantTexts: string[] = [];

		const cleanupPrompt = () => {
			personaResolution.cleanup();
		};

		const recordInterruption = (reason: InterruptionReport["reason"]): string => {
			if (interruptionNote) return interruptionNote;
			const now = Date.now();
			// The tracker is created only after a successful spawn; a cancellation
			// racing a synchronous spawn failure still needs an honest note.
			if (!progressTracker) {
				progressTracker = new DispatchProgressTracker(resolveDispatchTimeoutPolicy(opts.capability, envGetter()), dispatchStartedAt);
			}
			interruption = buildInterruptionReport({
				taskId,
				reason,
				startedAt: dispatchStartedAt,
				now,
				turns: assistantTurns,
				toolCalls,
				partialText: assistantTexts[assistantTexts.length - 1] ?? "",
				tracker: progressTracker,
			});
			interruptionNote = renderInterruptionReport(interruption);
			stderrCapture.append(`\n${interruptionNote}`);
			return interruptionNote;
		};
		let diagnosticWriter: DiagnosticWriter | undefined;
		let stderrPrefix = "";
		let stderrTarget: StderrTarget | undefined;
		// Decided exactly once, at the moment finish() first runs, from the size the
		// child itself had written to the backing file *before* any orchestrator note
		// is written into it. The close handler reuses this same decision instead of
		// re-stat'ing after finish() has already written into the file: re-stat'ing
		// there mistook the orchestrator's own just-written notes for real child bytes
		// and appended the same notes a second time (BLOCKING 1).
		let settledFileBytes: number | undefined;
		// Set only when finish() itself writes its own notes into the *real*
		// backing file (fileBytes === 0 at settle, non-fallback target): the
		// file size immediately after that write. The 'close' handler diffs
		// against this, not a fresh unconditional re-stat, to tell "the
		// orchestrator's own notes" apart from "real child bytes that arrived
		// between settle and close" (the latter must be preserved, not
		// truncated away).
		let noteWriteBytes: number | undefined;
		const currentStderrFileBytes = (): number => {
			if (!stderrTarget) return 0;
			try { return statSync(stderrTarget.path).size; } catch { return 0; }
		};
		const finish = (processExitCode: number) => {
			if (settled) return;
			const cancelled = cancelledByListener || session?.cancellation.isCancelled === true;
			cancelledByListener = cancelled;
			if (cancelled) session?.log(recordInterruption("cancelled"));
			settled = true;
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			removeCancellationListener?.();
			if (typeof proc?.pid === "number") liveDispatchPids.delete(proc.pid);
			cleanupPrompt();
			// Real child stderr now lands on a file, not a pipe (see openStderrTarget);
			// nothing streams it into stderrCapture in real time, so read whatever the
			// child has written so far — settlement can race the child's own exit on a
			// timeout/cancel, and the file may still be mid-write at this exact instant.
			// The 'close' handler below re-reads the final, complete content.
			const fileBytes = currentStderrFileBytes();
			if (settledFileBytes === undefined) settledFileBytes = fileBytes;
			const fileText = fileBytes > 0 ? readStderrFileBounded(stderrTarget!.path) : "";
			const rawStderr = stderrCapture.text() + (fileText ? `\n${fileText}` : "");
			const stderrSummary = summarizeStderr(rawStderr);
			const finalText = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "";
			// Only recover a process error after the JSON protocol proved the child
			// completed normally; failures before settlement still fail the dispatch.
			const outcome = classifyDispatchOutcome({
				exitCode: processExitCode,
				sawAgentSettled: events.sawAgentSettled,
				sawAgentEnd: events.sawAgentEnd,
				hasFinalText: Boolean(finalText),
				lastStopReason: events.stopReason,
				timedOut,
				cancelled,
				spawnFailed,
				stderrSummary,
			});
			stderrPrefix = outcome.status === "completed_after_process_error"
				? `[orchestrator] child produced a terminal result (agent_settled, stopReason=stop) then exited ${processExitCode}; result kept.\n`
				: "";
			// The prefix belongs at the START of both the returned stderr and the
			// persisted stderr.log — it is a warning about how to read what follows,
			// not a trailing note (pre-change behavior; a later refactor accidentally
			// dropped it from the returned `stderr`, keeping it only in the file write).
			// When real child bytes are on disk, the persisted log is written as
			// prefix + child content + our own notes (BLOCKING 2, review round 2) —
			// mirror that ordering here too, so the returned value and the log agree
			// on what comes first. `stderrSummary`/classification above already ran
			// against `rawStderr` in its original (notes, then file) order; reordering
			// only the string handed back to the caller does not change either.
			const stderr = stderrPrefix
				? fileBytes > 0
					? `${stderrPrefix}${fileText}${stderrCapture.text() ? `\n${stderrCapture.text()}` : ""}`
					: `${stderrPrefix}${rawStderr}`
				: rawStderr;
			if (diagnosticWriter) {
				// If the child already has real bytes on disk (a real fd-backed stderr
				// file), leave that file alone here: it may still be open for writing by
				// a not-yet-exited child, and overwriting it now would race that write.
				// The 'close' handler caps and appends our notes once the child has
				// fully exited. Only the legacy (no real file content) path needs the
				// full write here, matching pre-fd behavior for test doubles that
				// bypass stdio entirely and stream stderr straight into stderrCapture.
				if (fileBytes === 0) {
					diagnosticWriter.write(stderrTarget!.persistName, stderrPrefix + stderrCapture.text());
					// Only meaningful (and only safe to compare against later) when
					// `persistName` IS the real backing file at `stderrTarget.path`
					// (the non-fallback case): record how large that write left it, so
					// the 'close' handler can tell its own notes apart from any real
					// child bytes that land afterward, before the process actually exits.
					if (stderrTarget!.persistName === stderrName) noteWriteBytes = currentStderrFileBytes();
				}
			}
			session?.endDispatch(taskId, outcome.effectiveExitCode, events.usage.cost, interruptionNote ? summarizeInterruption(interruption!) : outcome.note);
			resolve({
				exitCode: outcome.effectiveExitCode,
				stdout: assistantTexts.join("\n\n"),
				finalText,
				rawStdout: stdoutCapture.text(),
				personaCanMutate,
				stderr,
				model: events.model,
				usage: events.usage,
				costUsd: events.usage.cost,
				nestedCostUsd: nestedCost.total(),
				costReported: events.costReported,
				durationMs: Date.now() - startedAt,
				stopReason: events.stopReason,
				outcome: outcome.status,
				processExitCode,
				timeoutReason,
				interruption,
				postCompletionError: outcome.status === "completed_after_process_error" ? outcome.note : undefined,
			});
		};

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: ChildStreamEvent;
			try {
				event = JSON.parse(trimmed) as ChildStreamEvent;
			} catch {
				// Unparseable protocol lines are dropped: they cannot safely be JSONL.
				return;
			}
			diagnosticWriter?.append(eventsName, `${JSON.stringify(trimEventForLog(event))}\n`);
			// A timeout/cancellation settles the result before stdio closes. Preserve
			// trailing diagnostics under the producer lease, but never revive progress
			// or mutate the already-returned usage/result after that boundary.
			if (settled) return;
			const now = Date.now();
			const observation = cancelledByListener ? undefined : progressTracker?.observe(event, now);
			// The one place cost/turns/model/stopReason/settled-flags are derived from
			// the raw event (dispatch/child-events.ts); both the board update below
			// and this function's own bookkeeping consume its delta instead of each
			// re-deriving the same numbers from `event` independently.
			const delta = events.absorb(event);
			session?.onChildEvent(taskId, event, delta);
			if (delta.turn) {
				assistantTurns += 1;
				// A provider error arrives as a turn with stopReason "error" and an
				// errorMessage, not on stderr (the child still exits 0 in json mode).
				// Keep it in the stderr capture so the failure is explainable and the
				// codex -> Bedrock quota fallback can see it.
				if (delta.turn.errorMessage && delta.turn.errorKind) {
					stderrCapture.append(`\n[provider ${delta.turn.errorKind}] ${delta.turn.errorMessage}`);
				}
				if (delta.turn.text) assistantTexts.push(delta.turn.text);
				// Spend cap is checked AFTER the message text is kept, so an enforced
				// stop never discards the turn that crossed the cap. A final turn
				// (stopReason "stop") is only warned about: killing it would throw away
				// a finished report to save nothing.
				if (delta.turn.hadUsage) {
					const verdict = session?.spendCaps.observe(taskId, opts.capability ?? "unknown", spentSoFar()) ?? "ok";
					if (verdict !== "ok") handleSpendCap(verdict === "stop" && delta.turn.stopReason === "stop" ? "warn" : verdict);
				}
			}
			if (nestedCost.observe(event)) {
				session?.setNestedCost(taskId, nestedCost.total());
				const verdict = session?.spendCaps.observe(taskId, opts.capability ?? "unknown", spentSoFar()) ?? "ok";
				if (verdict !== "ok") handleSpendCap(verdict);
			}
			if (progressTracker && observation) {
				if (event.type === "tool_execution_start") toolCalls += 1;
				const check = progressTracker.check(now);
				session?.recordProgress(taskId, observation, {
					...check,
					warnings: isLead ? check.warnings : [],
				}, now);
				if (isLead) {
					for (const warning of check.warnings) stderrCapture.append(`\n${warning.text}`);
					if (check.expired) handleExpiry(check.expired);
					else if (observation.kind === "progress") {
						if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
						timeoutTimer = undefined;
						armTimer();
					}
				}
			}
		};

		// spawn() itself throws synchronously on argument-validation errors (as
		// opposed to ENOENT, which arrives as an async 'error' event). Without this
		// guard the throw escapes before any listener exists, so finish() never
		// runs and the persona prompt temp dir leaks.
		// Optional so `finish()` can run from the synchronous-spawn-throw path,
		// where no child was ever created.
		let proc: ChildProcess | undefined;
		const spawnChild: ChildSpawner = opts.spawnChild ?? spawn;
		try {
			diagnosticWriter = session?.diagnostics.writer();
			stderrTarget = openStderrTarget(session ?? undefined, stderrName);
			proc = spawnChild(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", stderrTarget.fd],
				env,
				// Make the child a process-group leader so a timeout can kill the
				// whole tree. A dispatched lead spawns its own subagents, and
				// SIGKILL on the direct pid alone leaves those grandchildren
				// orphaned, still running, and still billing with nothing reading
				// their output. We never unref(), so we still await this child.
				detached: true,
			});
			// The child has (or, on POSIX, will momentarily) inherit its own copy of
			// the fd via the underlying fork/exec; ours is no longer needed. Closing
			// it here does not affect the child's ability to keep writing to the file.
			stderrTarget.closeFd();
		} catch (err) {
			spawnFailed = true;
			stderrCapture.append(`\n[orchestrator] spawn threw: ${(err as Error).message}`);
			// A throw from finish() itself (e.g. a diagnostic write failure) must not
			// leak the fd/lease/temp dir; release/close unconditionally.
			try {
				finish(1);
			} finally {
				stderrTarget?.release();
				diagnosticWriter?.close();
			}
			return;
		}


		if (typeof proc.pid === "number") liveDispatchPids.add(proc.pid);
		dispatchStartedAt = Date.now();
		// Policy is resolved per dispatch (env read now, not at module load) so
		// operators and tests can change limits without reloading the extension.
		// `leadTimeouts` is a test seam that only applies to orchestrating capabilities.
		const timeoutOverride = ORCHESTRATING_CAPABILITIES.has(opts.capability ?? "") ? opts.leadTimeouts : undefined;
		const policy: DispatchTimeoutPolicy = applyLeadTimeoutOverride(
			resolveDispatchTimeoutPolicy(opts.capability, envGetter()),
			timeoutOverride,
		);
		isLead = policy.mode === "lead";
		progressTracker = new DispatchProgressTracker(policy, dispatchStartedAt);
		for (const note of policy.notes) {
			stderrCapture.append(`\n[orchestrator] timeout configuration: ${note}`);
			session?.log(`dispatch ${taskId} timeout configuration: ${note}`);
		}

		handleExpiry = (reason) => {
			if (settled || cancelledByListener) return;
			timedOut = true;
			timeoutReason = reason;
			const explanation = progressTracker?.describeExpiry(reason, opts.capability, Date.now()) ?? reason;
			stderrCapture.append(`\n[orchestrator] ${reason} timeout: ${explanation}`);
			const report = recordInterruption(reason === "inactivity" ? "inactivity_timeout" : "absolute_timeout");
			session?.log(report);
			if (proc) killProcessTree(proc);
			finish(124);
		};

		handleSpendCap = (verdict) => {
			if (settled || cancelledByListener) return;
			const capability = opts.capability ?? "unknown";
			const cap = capFor(capability);
			const message = `spend cap $${cap.toFixed(2)} for ${capability} exceeded by ${taskId} at $${spentSoFar().toFixed(4)}${nestedCost.total() > 0 ? ` ($${nestedCost.total().toFixed(4)} in its subagents)` : ""}`;
			session?.log(`${message} (${verdict === "stop" ? "stopping it" : "warn only"})`);
			recordEvent("spend_cap_exceeded", {
				run_id: session?.runId, task_id: taskId, capability, model: opts.model,
				cap_usd: cap, cost_usd: spentSoFar(), nested_cost_usd: nestedCost.total(), action: verdict,
			});
			session?.ctx.ui?.notify?.(`${message}${verdict === "stop" ? " — stopping it" : ""}`, "warning");
			if (verdict !== "stop") return;
			events.stopReason = "spend_cap";
			stderrCapture.append(`\n[orchestrator] ${message}; dispatch stopped (dispatch_spend_cap.mode=enforce)`);
			if (proc) killProcessTree(proc);
			finish(125);
		};

		removeCancellationListener = session?.cancellation.onCancel(() => {
			if (proc && !settled) {
				cancelledByListener = true;
				if (timeoutTimer !== undefined) {
					clearTimeout(timeoutTimer);
					timeoutTimer = undefined;
				}
				// Drain already-buffered usage before billing, but do not depend on
				// close: a detached descendant can hold inherited pipes open forever.
				// Keep this inside shutdown's 2s budget. finish() is idempotent and
				// clears the timer; only real close releases the diagnostic lease, so
				// an undrained producer still prevents sealing after we settle.
				timeoutTimer = setTimeout(() => finish(137), 1000);
				killProcessTree(proc);
			}
		});

		armTimer = () => {
			if (settled || cancelledByListener || !progressTracker) return;
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			const now = Date.now();
			const check = progressTracker.peek(now);
			if (check.expired) {
				handleExpiry(check.expired);
				return;
			}
			const delay = Math.max(50, Math.min(30_000, check.nextCheckMs));
			timeoutTimer = setTimeout(() => {
				timeoutTimer = undefined;
				if (settled || cancelledByListener || !progressTracker) return;
				const tickNow = Date.now();
				const tickCheck = progressTracker.check(tickNow);
				session?.recordProgress(taskId, { kind: "heartbeat", detail: "timer" }, tickCheck, tickNow);
				for (const warning of tickCheck.warnings) stderrCapture.append(`\n${warning.text}`);
				if (tickCheck.expired) handleExpiry(tickCheck.expired);
				else armTimer();
			}, delay);
		};
		// A cancellation that fired synchronously above is already stopping the
		// child; never arm another execution deadline. Do NOT return early here: handlers must
		// still attach to drain usage and catch a late child 'error' event.
		if (isLead) {
			armTimer();
		} else if (!settled && !cancelledByListener) {
			// Leaf dispatches retain their fixed wall-clock timeout
			// (HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS); no inactivity rule applies.
			const leafTimeoutMs = policy.absoluteMs;
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				timedOut = true;
				stderrCapture.append(
					`\n[orchestrator] dispatch timed out after ${Math.round(leafTimeoutMs / 60000)}min ` +
						`(capability=${opts.capability ?? "unknown"}); killing process group`,
				);
				if (proc) killProcessTree(proc);
				finish(124);
			}, leafTimeoutMs);
		}

		const streamFailure = {
			appendStderr: (text: string) => stderrCapture.append(text),
			kill: () => killProcessTree(proc),
			finish,
		};
		proc.stdout?.on("data", (data) => {
			guardChildStreamHandler("stdout", () => {
				const chunk = data.toString();
				stdoutCapture.append(chunk);
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			}, streamFailure);
		});

		proc.stderr?.on("data", (data) => {
			// Only ever fires for a test double that hands us a real stream (see
			// openStderrTarget's fallback for anything spawned for real: stdio[2] is
			// a raw fd there, so `proc.stderr` is null and this listener is inert).
			stderrCapture.append(data.toString());
		});

		proc.on("close", (code) => {
			try {
				guardChildStreamHandler("stdout", () => {
					if (buffer.trim()) processLine(buffer);
					finish(code ?? 0);
					// Early settlement on timeout/error is not pipe drain. Keep the lease
					// until close. Reuse the *settle-time* byte count decided inside
					// finish() above, not a fresh stat here: finish() may have just written
					// orchestrator notes into an until-then-empty file, and re-stat'ing
					// after that would mistake those notes for real child bytes and append
					// the same notes a second time (BLOCKING 1). capChildStderrFile and the
					// read-back below run inside this same guarded handler so a throw here
					// cannot escape as an uncaught exception on the 'close' event.
					const fileBytes = settledFileBytes ?? 0;
					const persistName = stderrTarget?.persistName ?? stderrName;
					// The taskId-collision fallback target (see openStderrTarget) writes its
					// own persisted content to persistName, a name distinct from
					// stderrTarget.path's physical file; re-stat'ing that path here is
					// always safe (finish() never writes through it), unlike the
					// non-fallback case where path IS the persisted file itself.
					const isFallback = persistName !== stderrName;
					if (diagnosticWriter) {
						if (fileBytes > 0 || (isFallback && currentStderrFileBytes() > 0)) {
							// Real child bytes exist on the backing file - either observed at
							// settle, or (fallback only) arrived since. Persist them with the
							// recovered-result prefix LEADING, not trailing (BLOCKING 2, review
							// round 2): read the (possibly on-disk-capped) content once and
							// write prefix+content, then append our own notes after it. Reserve
							// room for the prefix and the notes in the cap itself (WARNING,
							// review round 3) so the composed prefix+content+notes never
							// exceeds MAX_CHILD_STDERR_DISK_BYTES even though only `content` is
							// capped directly.
							const notes = stderrCapture.text();
							const notesSuffix = notes ? `\n${notes}` : "";
							const reserveBytes = Buffer.byteLength(stderrPrefix, "utf8") + Buffer.byteLength(notesSuffix, "utf8");
							const budget = Math.max(0, MAX_CHILD_STDERR_DISK_BYTES - reserveBytes);
							const capped = capChildStderrFile(stderrTarget!.path, budget);
							if (isFallback) {
								// The backing file is a private temp file distinct from
								// persistName's real file (see openStderrTarget's fallback):
								// its content must actually be copied over. `capped` already
								// read it through bounded, fixed-position reads when it's
								// over budget; when under budget, `size <= budget` by
								// definition of capChildStderrFile, so this read is bounded
								// by the same cap - never an unbounded whole-file load.
								const content = capped ?? readFileSync(stderrTarget!.path, "utf8");
								diagnosticWriter.write(persistName, `${stderrPrefix}${content}`);
								if (notes) diagnosticWriter.append(persistName, notesSuffix);
							} else if (capped !== undefined || stderrPrefix) {
								// Same physical file as persistName: only rewrite it when
								// something must actually change (a prefix to prepend, or
								// on-disk content that must shrink to fit the cap) - never an
								// unconditional read-then-truncate-then-write, which would
								// open a window where a concurrently-writing escaped
								// descendant's bytes land between the read and the truncate
								// and are lost (WARNING, review round 3).
								const content = capped ?? readFileSync(stderrTarget!.path, "utf8");
								diagnosticWriter.write(persistName, `${stderrPrefix}${content}`);
								if (notes) diagnosticWriter.append(persistName, notesSuffix);
							} else if (notes) {
								// Nothing to prepend and nothing to cap: the child's bytes are
								// already exactly where they belong: only the notes are new.
								diagnosticWriter.append(persistName, notesSuffix);
							}
						} else if (!isFallback && noteWriteBytes !== undefined && currentStderrFileBytes() > noteWriteBytes) {
							// finish() already wrote our notes into the real backing file
							// (settle saw 0 bytes there), and the child kept writing real
							// bytes for a moment before actually exiting. Those bytes landed
							// through the same O_APPEND fd as everything else in this
							// (non-fallback) file - persistName IS stderrTarget.path here - so
							// they are already exactly where they belong. Re-reading and
							// re-appending them (as review round 2 did, via an unbounded
							// Buffer.alloc(lateBytes) with no cap check) duplicated them in
							// the sealed log and could allocate without bound (BLOCKING,
							// review round 3). Only cap the file if it has now grown past the
							// limit; otherwise leave it untouched.
							const capped = capChildStderrFile(stderrTarget!.path, MAX_CHILD_STDERR_DISK_BYTES);
							if (capped !== undefined) diagnosticWriter.write(persistName, capped);
						} else {
							// Nothing real ever landed in the backing file (a test double that
							// bypasses stdio entirely): fall back to persisting stderrCapture's
							// text wholesale, matching the pre-fd behavior exactly, including
							// any trailing diagnostics that arrived after finish() resolved.
							// finish() already wrote this same content once (when fileBytes was
							// 0 at settle time); this re-write is an idempotent overwrite with
							// identical content, not a duplicate append.
							diagnosticWriter.write(persistName, stderrPrefix + stderrCapture.text());
						}
					}
				}, streamFailure);
			} finally {
				stderrTarget?.release();
				diagnosticWriter?.close();
			}
		});


		proc.on("error", (err) => {
			spawnFailed = true;
			stderrCapture.append(`\n[orchestrator] spawn error: ${err.message}`);
			finish(1);
		});
	});
}

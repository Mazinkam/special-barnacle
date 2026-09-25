/**
 * `RunSession` (B4.6): one `/orchestrate` invocation's live progress board and
 * on-disk log under `<STATE_ROOT>/runs/<runId>/`:
 *
 *   run.log                     human-readable timeline (phases, dispatches, verdicts)
 *   <taskId>.prompt.md          exact task prompt sent to the child
 *   <taskId>.events.jsonl       the child's raw --mode json stream
 *   <taskId>.stderr.log         the child's stderr
 *
 * Extracted from index.ts with the two pieces of module state it used to read
 * directly — the runs directory and the telemetry queue's counters at start —
 * injected via `RunSessionDeps` instead, so this module never reads
 * config.ts/a module-level telemetry singleton itself. index.ts's exported
 * `RunSession` is a thin subclass that supplies the real `runsDir()`/
 * `recordQueue.snapshot()` as those deps, so every existing
 * `new RunSession(runId, ctx, goal, cwd?)` call site (including
 * `index.test.ts`'s) is unchanged.
 *
 * The pure status-bar/widget-line computation lives in `run/board.ts`
 * (`renderBoard`); this module owns the mutable per-dispatch state and the
 * one place that calls `ctx.ui.setStatus`/`setWidget` with the result.
 *
 * run/* must not import index.ts.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

import type { ExtensionContext } from "@humain/terminal";

import { RunDiagnostics } from "../run-diagnostics.ts";
import { RunCancellation } from "../cancellation.ts";
import { SpendCapTracker } from "../spend-cap.ts";
import type { QueueStats } from "../record-queue.ts";
import type { ChildEventDelta } from "../dispatch/child-events.ts";
import type { ProgressObservation, TimeoutCheck } from "../dispatch-progress.ts";
import { applyObservation, applyWarnings, createProgressView, fmtElapsed } from "../run-ui.ts";
import { safeUi } from "./ui-sink.ts";
import {
	type BoardSnapshot,
	type DispatchProgress,
	MAX_ACTIVITY_TAIL,
	type OrchestratorStatus,
	renderBoard,
	shortArgs,
	type WorktreeInfo,
} from "./board.ts";

/** Manifest `python3 -m orchestrator.cli archive-runs --execute` leaves next to a run's `<name>.gz` files. */
const ARCHIVE_MANIFEST = "archive.manifest.json";

/**
 * Where a run diagnostic can be read *now*. The opt-in `archive-runs --execute` command replaces
 * the diagnostics of old completed runs with `<name>.gz` + a manifest (`run.log` itself is never
 * archived), so a path remembered from the progress board or an old notification may no longer
 * exist as-is. Returns the path unchanged while it is readable; otherwise a lookup/restore hint
 * instead of a silently broken link.
 */
export function describeRunArtifact(path: string): string {
	if (existsSync(path)) return path;
	const runDir = dirname(path);
	const name = basename(path);
	const archived = join(runDir, `${name}.gz`);
	let listed = false;
	try {
		const manifest = JSON.parse(readFileSync(join(runDir, ARCHIVE_MANIFEST), "utf-8"));
		listed = manifest?.format_version === 1 && typeof manifest?.files?.[name] === "object";
	} catch {
		/* no readable manifest: the file was never archived by us */
	}
	if (listed && existsSync(archived)) {
		return `${path} (archived as ${archived} — read with \`gunzip -c\`, or restore the run with \`python3 -m orchestrator.cli restore-run ${basename(runDir)}\`)`;
	}
	return `${path} (missing)`;
}

/**
 * Detect the git worktree the orchestrator is running in. Cheap: two short
 * `git` invocations cached at session start. Returns null when `cwd` is not
 * inside a git worktree so callers can fall back gracefully.
 */
function detectWorktree(cwd: string): WorktreeInfo | null {
	try {
		const rootR = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8", timeout: 5000,
		});
		if (rootR.status !== 0 || !rootR.stdout.trim()) return null;
		const root = rootR.stdout.trim();
		const branchR = spawnSync("git", ["-C", cwd, "branch", "--show-current"], {
			encoding: "utf-8", timeout: 5000,
		});
		const branch = branchR.status === 0 ? branchR.stdout.trim() : "";
		return {
			root,
			branch,
			shortBranch: branch || "(detached)",
			name: basename(root),
		};
	} catch {
		return null;
	}
}

/** Hard cap on buffered user messages so a chatty operator can't blow context. */
const MAX_QUEUED_MESSAGES = 10;
/** Soft per-message cap in characters; longer messages are truncated in the
 *  prompt but preserved in full in run.log. */
const MAX_MESSAGE_CHARS = 1500;

/** Time fields recorded at the run's terminal boundary (complete/fail/cancel/crash). */
export interface RunTiming {
	started_at: string;
	finished_at: string;
	elapsed_ms: number;
	elapsed_source: "monotonic";
}

/**
 * The two things this class used to read from module state, injected instead
 * (B4.6): where per-run logs land, and the telemetry queue's counters at the
 * moment the run starts (so the terminal summary can report every record
 * failure since then, not just the final drain).
 */
export interface RunSessionDeps {
	/** `<STATE_ROOT>/runs`; the session appends `/<runId>` itself. */
	runsDir(): string;
	/** `recordQueue.snapshot()` at construction time. */
	telemetrySnapshot(): QueueStats;
}

export class RunSession {
	readonly runId: string;
	readonly ctx: ExtensionContext;
	readonly goal: string;
	readonly dir: string;
	/** Git worktree the run is operating in (null when cwd isn't git-tracked). */
	readonly worktree: WorktreeInfo | null;
	private readonly dispatches = new Map<string, DispatchProgress>();
	private phase = "starting";
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly startedAt = Date.now();
	// The ISO stamp for the ledger is derived from the same wall-clock read as `startedAt`, and
	// elapsed time uses a monotonic origin: `Date.now()` can step (NTP, sleep/wake) mid-run, so
	// the duration written to outcomes must never be derived from two wall-clock reads.
	private readonly startedAtIso = new Date(this.startedAt).toISOString();
	private readonly startedMono = performance.now();
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	readonly cancellation = new RunCancellation();
	/** Reason the run was cancelled, set by `cancel()`. Distinguishes a user-initiated
	 *  cancel (post a summary message to chat) from a session shutdown (do not). */
	private _cancelReason: "user" | "shutdown" | "signal" | undefined;
	get cancelReason(): "user" | "shutdown" | "signal" | undefined {
		return this._cancelReason;
	}
	/** The detached background promise started by the `/orchestrate` handler after its
	 *  synchronous prelude returns. Set once, right before the handler returns; awaited
	 *  by `session_shutdown` and by tests that need the run to have fully settled. */
	runPromise?: Promise<void>;
	/** Per-dispatch spend cap (method.json rules.dispatch_spend_cap). Replaceable in tests. */
	spendCaps = new SpendCapTracker();
	/** User messages queued while a run is live; drained at the next dispatch boundary. */
	private queuedMessages: Array<{ text: string; queuedAt: number }> = [];
	/** History of message batches we've folded into prompts, so the user can see delivery. */
	private deliveryLog: Array<{ count: number; to: string; ts: number }> = [];
	readonly diagnostics: RunDiagnostics;
	private terminalAcknowledged = false;
	private resolveFinished!: () => void;
	/** Resolves after the command's producers, terminal telemetry and cleanup have settled. */
	readonly finished = new Promise<void>(resolve => { this.resolveFinished = resolve; });

	finish(): void { this.resolveFinished(); }
	/**
	 * Telemetry counters when this run started. The terminal summary reports every record
	 * failure since then — including timer flushes that failed mid-run — not just the final drain.
	 */
	readonly telemetryBaseline: QueueStats;

	constructor(runId: string, ctx: ExtensionContext, goal: string, cwd: string, deps: RunSessionDeps) {
		this.runId = runId;
		this.ctx = ctx;
		this.goal = goal;
		this.dir = join(deps.runsDir(), runId);
		this.telemetryBaseline = deps.telemetrySnapshot();
		this.diagnostics = new RunDiagnostics(this.dir, runId);
		this.worktree = detectWorktree(cwd);
		try {
			mkdirSync(this.dir, { recursive: true });
		} catch (err) {
			console.warn(`[orchestrator] could not create run dir ${this.dir}: ${(err as Error).message}`);
		}
		this.log(`run ${runId} started`);
		this.log(`goal: ${goal}`);
		if (this.worktree) {
			this.log(`worktree: ${this.worktree.root} [${this.worktree.shortBranch}]`);
		}
		// Elapsed counters must tick even when a child is silent — a frozen board
		// is indistinguishable from a hung run, which is the complaint that led here.
		this.tickTimer = setInterval(() => safeUi(() => this.render()), 1000);
	}

	/**
	 * Append a user message to be delivered to the next dispatched task. Returns
	 * the new queue depth. We drain on dispatch — never mid-flight — because
	 * the subprocess protocol (humain-terminal --mode json --no-session) has no
	 * stdin injection channel.
	 */
	enqueueMessage(text: string): number {
		const trimmed = text.trim();
		if (!trimmed) return this.queuedMessages.length;
		const capped = trimmed.length > MAX_MESSAGE_CHARS
			? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}…`
			: trimmed;
		if (this.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
			this.queuedMessages.shift();
		}
		this.queuedMessages.push({ text: capped, queuedAt: Date.now() });
		this.log(`user message queued (depth=${this.queuedMessages.length}): ${capped.slice(0, 200)}`);
		this.render();
		return this.queuedMessages.length;
	}

	/**
	 * Atomically return queued messages and clear the queue, recording the
	 * delivery in the run's delivery log. Returns [] when nothing queued.
	 */
	drainMessages(recipient: string): string[] {
		if (this.queuedMessages.length === 0) return [];
		const msgs = this.queuedMessages.map((m) => m.text);
		this.deliveryLog.push({
			count: msgs.length,
			to: recipient,
			ts: Date.now(),
		});
		// Keep the delivery log bounded.
		if (this.deliveryLog.length > 20) this.deliveryLog.splice(0, this.deliveryLog.length - 20);
		this.queuedMessages.length = 0;
		this.log(`delivered ${msgs.length} user message(s) to ${recipient}`);
		this.render();
		return msgs;
	}

	/** Number of currently queued (undelivered) messages. */
	queuedDepth(): number {
		return this.queuedMessages.length;
	}

	file(name: string): string {
		return join(this.dir, name);
	}

	writeDiagnostic(name: string, text: string): boolean {
		return this.diagnostics.write(name, text);
	}

	acknowledgeTerminal(ok: boolean): void {
		this.terminalAcknowledged = ok;
	}

	async sealDiagnostics(terminal = Promise.resolve(this.terminalAcknowledged)): Promise<boolean> {
		const sealed = await this.diagnostics.seal(terminal);
		if (!sealed) safeUi(() => this.ctx.ui.notify(
			`Diagnostics remain UNSEALED and archive-ineligible: producer drain/terminal acknowledgement did not complete or sealing failed. Raw diagnostics retained: ${this.dir}`,
			"warning",
		));
		return sealed;
	}

	/**
	 * Time fields recorded at the run's terminal boundary (complete/fail/cancel/crash).
	 * `elapsed_ms` is monotonic and clamped at zero; consumers treat a run without these
	 * fields as "duration unknown", never as zero.
	 */
	terminalTiming(): RunTiming {
		return {
			started_at: this.startedAtIso,
			finished_at: new Date().toISOString(),
			elapsed_ms: Math.max(0, Math.round(performance.now() - this.startedMono)),
			elapsed_source: "monotonic",
		};
	}

	cancel(reason: "user" | "shutdown" | "signal" = "user"): void {
		if (this.cancellation.isCancelled) return;
		this._cancelReason = reason;
		this.phase = "cancelling";
		this.log(`cancellation requested (${reason})`);
		this.cancellation.cancel();
		this.render();
	}

	log(line: string): void {
		const stamped = `${new Date().toISOString()} ${line}`;
		try {
			this.diagnostics.write("run.log", `${stamped}\n`, true);
		} catch {
			/* log dir unavailable; the UI still gets the line */
		}
	}

	setPhase(phase: string, notify = true): void {
		this.phase = phase;
		this.log(`phase: ${phase}`);
		if (notify) safeUi(() => this.ctx.ui.notify(`[${fmtElapsed(Date.now() - this.startedAt)}] ${phase}`, "info"));
		safeUi(() => this.render());
	}

	startDispatch(taskId: string, label: string, model: string, depth: number = 0): void {
		const now = Date.now();
		this.dispatches.set(taskId, {
			taskId,
			label,
			model,
			startedAt: now,
			turns: 0,
			toolCalls: 0,
			lastActivity: "starting",
			activityTail: ["starting"],
			costUsd: 0,
			nestedCostUsd: 0,
			status: "running",
			depth,
			progress: createProgressView(now),
		});
		this.log(`dispatch ${taskId} → ${label} on ${model} (depth=${depth})`);
		this.render();
	}

	recordProgress(taskId: string, observation: ProgressObservation, check: TimeoutCheck, now = Date.now()): void {
		const dispatch = this.dispatches.get(taskId);
		if (!dispatch) return;
		applyObservation(dispatch.progress, observation, now);
		applyWarnings(dispatch.progress, check.warnings, now, (warning) => this.log(`  ${taskId} ${warning}`));
		const detail = observation.detail.replace(/\s+/g, " ").trim();
		if (
			observation.kind === "progress" &&
			detail !== "tool execution completed" &&
			dispatch.lastLoggedProgressDetail !== detail &&
			(detail.startsWith("nested worker progress") || dispatch.lastLoggedProgressAt === undefined || now - dispatch.lastLoggedProgressAt >= 60_000)
		) {
			dispatch.lastLoggedProgressDetail = detail;
			dispatch.lastLoggedProgressAt = now;
			this.log(`  ${taskId} progress: ${detail}`);
		}
		this.scheduleRender();
	}

	/** Feed a parsed `--mode json` event from a child, plus the delta
	 * `dispatch/child-events.ts`'s accumulator already computed for it (B4.5
	 * step 3: this is UI/board bookkeeping only now — turns/cost come from the
	 * delta, not from re-deriving them off `event` a second time). */
	onChildEvent(taskId: string, event: any, delta: ChildEventDelta): void {
		const d = this.dispatches.get(taskId);
		if (!d) return;
		// Nested worker counts/turns are derived by render() from the single
		// de-duplicated progress view, never from raw event snapshots.
		let changed: string | null = null;
		switch (event?.type) {
			case "tool_execution_start": {
				d.toolCalls += 1;
				d.lastTool = event.toolName;
				const detail = shortArgs(event.toolName, event.args);
				changed = `${event.toolName}${detail ? ` ${detail}` : ""}`;
				this.log(`  ${taskId} tool#${d.toolCalls} ${changed}`);
				break;
			}
			case "tool_execution_end":
				if (event.isError) {
					changed = `${event.toolName} ✗`;
					this.log(`  ${taskId} tool ${event.toolName} returned error`);
				}
				break;
			case "message_start":
				if (event.message?.role === "assistant") changed = "thinking";
				break;
			case "message_end":
				if (delta.turn) {
					d.turns += 1;
					d.costUsd += delta.turn.costDelta;
					changed = `turn ${d.turns} done (${d.toolCalls} tools)`;
				}
				break;
			default:
				return;
		}
		if (changed) {
			d.lastActivity = changed;
			d.activityTail.push(changed);
			if (d.activityTail.length > MAX_ACTIVITY_TAIL) {
				d.activityTail.splice(0, d.activityTail.length - MAX_ACTIVITY_TAIL);
			}
		}
		this.scheduleRender();
	}

	endDispatch(taskId: string, exitCode: number, costUsd: number, note?: string): void {
		const d = this.dispatches.get(taskId);
		if (!d) return;
		d.endedAt = Date.now();
		d.status = this.cancellation.isCancelled ? "cancelled" : exitCode === 0 ? "done" : "failed";
		d.costUsd = costUsd || d.costUsd;
		d.lastActivity = note ?? (d.status === "cancelled" ? "cancelled by user" : exitCode === 0 ? "finished" : `exit ${exitCode}`);
		this.log(
			`dispatch ${taskId} ${d.status} in ${fmtElapsed(d.endedAt - d.startedAt)} — ${d.turns} turns, ${d.toolCalls} tool calls, $${d.costUsd.toFixed(4)}${d.nestedCostUsd > 0 ? ` + $${d.nestedCostUsd.toFixed(4)} in subagents` : ""}${note ? ` — ${note}` : ""}`,
		);
		this.render();
	}

	setNestedCost(taskId: string, costUsd: number): void {
		const d = this.dispatches.get(taskId);
		if (!d) return;
		d.nestedCostUsd = costUsd;
		this.scheduleRender();
	}

	totalCost(): number {
		let c = 0;
		for (const d of this.dispatches.values()) c += d.costUsd + d.nestedCostUsd;
		return c;
	}

	private scheduleRender(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.render();
		}, 250);
	}

	render(): void {
		if (this.closed) return;
		const now = Date.now();
		const snapshot: BoardSnapshot = {
			runId: this.runId,
			phase: this.phase,
			startedAt: this.startedAt,
			goal: this.goal,
			worktree: this.worktree,
			dispatches: [...this.dispatches.values()],
			queuedMessageCount: this.queuedMessages.length,
			lastDelivery: this.deliveryLog[this.deliveryLog.length - 1],
			totalCostUsd: this.totalCost(),
			logPath: this.file("run.log"),
		};
		const { statusLine, widgetLines } = renderBoard(snapshot, now);
		safeUi(() => this.ctx.ui.setStatus("orchestrator", statusLine));
		safeUi(() => this.ctx.ui.setWidget("orchestrator", widgetLines));
	}

	close(): void {
		if (this.closed) return;
		if (this.tickTimer) clearInterval(this.tickTimer);
		if (this.renderTimer) clearTimeout(this.renderTimer);
		// Cleared unconditionally, including on cancel: a stale widget/status left behind
		// after cancellation used to be the only visible trace that a run had ended, but it
		// also blocked the footer from ever going quiet. `run.log` and the terminal notify
		// carry the same information without pinning it to the screen forever.
		safeUi(() => this.ctx.ui.setWidget("orchestrator", undefined));
		safeUi(() => this.ctx.ui.setStatus("orchestrator", undefined));
		this.closed = true;
		this.log(`run ${this.runId} closed after ${fmtElapsed(Date.now() - this.startedAt)}`);
	}

	cancelledDispatches(): string[] {
		return [...this.dispatches.values()].filter((d) => d.status === "cancelled").map((d) => d.label);
	}

	/** Point-in-time status snapshot for the `orchestrator_status` tool and any other
	 *  out-of-band caller that needs to see run progress without owning the UI widget. */
	statusSnapshot(logLines = 20): OrchestratorStatus {
		const now = Date.now();
		const dispatches = [...this.dispatches.values()].map((d) => ({
			label: d.label,
			model: d.model,
			status: d.status,
			elapsedMs: (d.endedAt ?? now) - d.startedAt,
			turns: d.turns,
			lastTool: d.lastTool,
			costUsd: d.costUsd,
		}));
		const clampedLines = Number.isFinite(logLines) ? Math.max(1, Math.min(200, Math.trunc(logLines))) : 20;
		let recentLog: string[] = [];
		try {
			const text = readFileSync(this.file("run.log"), "utf8");
			const lines = text.split("\n").filter((l) => l.length > 0);
			recentLog = lines.slice(-clampedLines);
		} catch {
			/* log not written yet, or unreadable; report no lines rather than throw */
			recentLog = [];
		}
		return {
			runId: this.runId,
			phase: this.phase,
			elapsedMs: now - this.startedAt,
			totalCostUsd: this.totalCost(),
			dispatches,
			recentLog,
		};
	}
}

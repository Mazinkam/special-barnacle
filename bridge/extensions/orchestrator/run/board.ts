/**
 * Pure progress-board view (B4.6): the per-dispatch view model, the constants/
 * helpers that decide what to show, and `renderBoard()`, which turns a
 * point-in-time snapshot of a run into the status-bar line and widget lines
 * `RunSession.render()` hands to `ctx.ui`. Nothing here touches `ctx.ui`
 * itself (no `safeUi`, no `setStatus`/`setWidget` calls) — `RunSession` owns
 * that side effect and this module only computes the text.
 *
 * Also owns `OrchestratorStatus`/`formatOrchestratorStatus`, the other pure
 * view this extension renders (for `orchestrator_status` and any other
 * out-of-band caller), and `WorktreeInfo`, the data shape `RunSession`'s
 * `detectWorktree()` (I/O; stays in run/session.ts) constructs.
 *
 * run/* must not import index.ts.
 */
import type { DispatchProgressView } from "../run-ui.ts";
import {
	fmtElapsed,
	formatNestedWorkerRows,
	formatProgressLine,
	formatWarningLine,
	spinnerFrame,
} from "../run-ui.ts";
import { shortName } from "../models.ts";

/** Git worktree the orchestrator is running in; null when cwd isn't git-tracked. */
export interface WorktreeInfo {
	root: string;
	branch: string;
	shortBranch: string;
	name: string;
}

/**
 * One dispatch's live bookkeeping, mutated by `RunSession` as child events
 * arrive and read (never mutated) by `renderBoard()`.
 */
export interface DispatchProgress {
	taskId: string;
	label: string;
	model: string;
	startedAt: number;
	endedAt?: number;
	turns: number;
	toolCalls: number;
	lastActivity: string;
	/** Last few activity strings, newest at the end; rendered as a dim sub-line. */
	activityTail: string[];
	costUsd: number;
	/** Running spend of this dispatch's own subagent calls. */
	nestedCostUsd: number;
	status: "running" | "done" | "failed" | "cancelled";
	/** Nesting depth (0 = top-level dispatch, 1 = child of a lead, …). */
	depth: number;
	progress: DispatchProgressView;
	lastLoggedProgressDetail?: string;
	lastLoggedProgressAt?: number;
	/** Most recent tool name this dispatch invoked. `lastActivity` gets overwritten by
	 *  assistant turn summaries ("turn N done (...)"), so it can't answer "what tool is
	 *  it running now" — this field is set only from tool events and never cleared by them. */
	lastTool?: string;
}

/** Number of trailing `activityTail` entries `RunSession.onChildEvent` retains and `renderBoard` shows. */
export const MAX_ACTIVITY_TAIL = 4;

export function shortArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const pick =
		(typeof a.command === "string" && a.command) ||
		(typeof a.path === "string" && a.path) ||
		(typeof a.pattern === "string" && a.pattern) ||
		(typeof a.agent === "string" && `agent=${a.agent}`) ||
		(Array.isArray(a.tasks) && `${a.tasks.length} tasks`) ||
		(typeof a.task === "string" && a.task) ||
		"";
	const s = String(pick).replace(/\s+/g, " ").trim();
	return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}

/** Point-in-time snapshot of a live `/orchestrate` run, returned by `RunSession.statusSnapshot()`
 *  and the `orchestrator_status` tool. Deliberately UI-agnostic (no ANSI, no widget lines) so it
 *  can be consumed by the LLM (as tool `details`) or a human (via `formatOrchestratorStatus`). */
export interface OrchestratorStatus {
	runId: string;
	phase: string;
	elapsedMs: number;
	totalCostUsd: number;
	dispatches: Array<{
		label: string;
		model: string;
		status: "running" | "done" | "failed" | "cancelled";
		elapsedMs: number;
		turns: number;
		lastTool?: string;
		costUsd: number;
	}>;
	recentLog: string[];
}

/** Render an `OrchestratorStatus` snapshot as plain text for chat/tool output. */
export function formatOrchestratorStatus(s: OrchestratorStatus): string {
	const lines: string[] = [
		`Orchestration ${s.runId} — phase: ${s.phase} · elapsed ${fmtElapsed(s.elapsedMs)} · total cost $${s.totalCostUsd.toFixed(4)}`,
	];
	if (s.dispatches.length > 0) {
		lines.push("", "Dispatches:");
		for (const d of s.dispatches) {
			lines.push(
				`  - ${d.label} (${d.model}) [${d.status}] ${fmtElapsed(d.elapsedMs)} · turns ${d.turns}` +
					`${d.lastTool ? ` · last tool ${d.lastTool}` : ""} · $${d.costUsd.toFixed(4)}`,
			);
		}
	} else {
		lines.push("", "Dispatches: none yet");
	}
	if (s.recentLog.length > 0) {
		lines.push("", "Recent log:");
		for (const line of s.recentLog) lines.push(`  ${line}`);
	}
	return lines.join("\n");
}

function formatRunningRow(d: DispatchProgress, now: number): string {
	const indent = "  ".repeat(1 + d.depth);
	const spin = spinnerFrame(now);
	const model = shortName(d.model).padEnd(20);
	const elapsed = fmtElapsed(now - d.startedAt).padStart(7);
	const turns = `t${d.turns}`.padStart(4);
	const tools = `⚙${d.toolCalls}`.padStart(5);
	const cost = `$${(d.costUsd + d.nestedCostUsd).toFixed(4)}`.padStart(9);
	const idleMs = now - d.progress.lastProgressAt;
	const idle = idleMs > 60_000 ? `  idle ${fmtElapsed(idleMs)}` : "";
	return `${indent}${spin} ${d.label.padEnd(20)}  ${model}  ${elapsed}  ${turns} ${tools}  ${cost}${idle}`;
}

function appendActivityTail(lines: string[], d: DispatchProgress): void {
	const indent = "  ".repeat(2 + d.depth);
	const tail = d.activityTail.slice(0, -1);
	if (tail.length > 0) lines.push(`${indent}↳ ${tail.join(" · ")}`.slice(0, 120));
	const nestedWorkers = d.progress.nested.size;
	const nestedTurns = [...d.progress.nested.values()].reduce((total, worker) => total + worker.turns, 0);
	if (nestedWorkers > 0) {
		lines.push(`${indent}${nestedWorkers} worker${nestedWorkers === 1 ? "" : "s"} (${nestedTurns} turns)`);
	}
}

function formatDoneRow(d: DispatchProgress, now: number): string {
	const indent = "  ".repeat(1 + d.depth);
	const mark = d.status === "done" ? "✓" : d.status === "cancelled" ? "⏹" : "✗";
	const model = shortName(d.model).padEnd(20);
	const elapsed = fmtElapsed((d.endedAt ?? now) - d.startedAt).padStart(7);
	const turns = `t${d.turns}`.padStart(4);
	const tools = `⚙${d.toolCalls}`.padStart(5);
	const cost = `$${(d.costUsd + d.nestedCostUsd).toFixed(4)}`.padStart(9);
	// Surface the captured note for failed and cancelled dispatches so the
	// user can see "exit 1", "cancelled by user", or the stderr summary at a
	// glance. For normal completions the ✓ mark already conveys status.
	const note =
		d.status !== "done" && d.lastActivity ? `  ${d.lastActivity}` : "";
	return `${indent}${mark} ${d.label.padEnd(20)}  ${model}  ${elapsed}  ${turns} ${tools}  ${cost}${note}`;
}

/** Everything `renderBoard()` needs; a point-in-time snapshot `RunSession.render()` builds each tick. */
export interface BoardSnapshot {
	runId: string;
	phase: string;
	/** `Date.now()` when the run started. */
	startedAt: number;
	goal: string;
	worktree: WorktreeInfo | null;
	dispatches: DispatchProgress[];
	queuedMessageCount: number;
	/** Most recent delivered message batch, if any (shown when nothing is queued). */
	lastDelivery?: { count: number; to: string; ts: number };
	totalCostUsd: number;
	/** Absolute path to the run's `run.log`, shown in the footer. */
	logPath: string;
}

/** The status-bar line plus the multi-line progress widget for one render tick. */
export interface BoardView {
	statusLine: string;
	widgetLines: string[];
}

/**
 * Pure: computes the status-bar text and progress-widget lines for one
 * render tick. `RunSession.render()` is the only caller and is the one place
 * that hands the result to `ctx.ui.setStatus`/`setWidget` (via `safeUi`).
 */
export function renderBoard(snapshot: BoardSnapshot, now: number): BoardView {
	const { runId, phase, startedAt, goal, worktree, dispatches, queuedMessageCount, lastDelivery, totalCostUsd, logPath } = snapshot;
	const running = dispatches.filter((d) => d.status === "running");
	const done = dispatches.filter((d) => d.status !== "running");
	const failed = done.filter((d) => d.status === "failed").length;
	const cancelled = done.filter((d) => d.status === "cancelled").length;
	const elapsed = fmtElapsed(now - startedAt);

	// Compact status line for the bar: phase + headline numbers. The phase is
	// most important when terminal (cancelled, failed) — keeping it visible
	// here means the user can see the verdict in the status bar even after
	// the widget has been closed.
	const wtShort = worktree ? ` · ${worktree.shortBranch} @ ${worktree.name}` : "";
	const statusLine = `orch ${phase} · ${elapsed} · ${running.length} running · ${failed} failed${wtShort} · $${totalCostUsd.toFixed(3)}`;

	const lines: string[] = [];
	// Title bar: run id, phase, elapsed, total cost, worktree.
	const titleWt = worktree
		? `  ${worktree.shortBranch} @ ${worktree.root}`
		: "";
	lines.push(
		`▶ /orchestrate  ${runId}  ·  ${phase}  ·  ${elapsed}  ·  $${totalCostUsd.toFixed(4)}${titleWt}`,
	);
	// Goal line: keep first 80 + last 40 chars so the user can recognize long goals.
	const goalText = goal.replace(/\s+/g, " ").trim();
	if (goalText.length <= 120) {
		lines.push(`  Goal: ${goalText}`);
	} else {
		lines.push(`  Goal: ${goalText.slice(0, 80)} … ${goalText.slice(-40)}`);
	}
	// Rollup line only when at least one task has finished.
	if (done.length > 0) {
		lines.push(
			`  ${running.length} running  ${done.length} done  ${failed} failed  ${cancelled} cancelled`,
		);
	}

	// Running section.
	if (running.length > 0) {
		lines.push("");
		lines.push(`  ▸ running (${running.length})`);
		for (const d of running) {
			lines.push(formatRunningRow(d, now));
			appendActivityTail(lines, d);
			const indent = "  ".repeat(2 + d.depth);
			const progressLine = formatProgressLine(d.progress, now, indent);
			if (progressLine) lines.push(progressLine);
			const warningLine = formatWarningLine(d.progress, now, indent);
			if (warningLine) lines.push(warningLine);
			lines.push(...formatNestedWorkerRows(d.progress, now, d.depth));
		}
	}

	// Completed section — tail of most recent 6.
	if (done.length > 0) {
		lines.push("");
		lines.push(`  ▸ completed (${done.length})`);
		const tail = done.slice(-6);
		for (const d of tail) lines.push(formatDoneRow(d, now));
		if (done.length > 6) {
			lines.push(`    … ${done.length - 6} earlier in run.log`);
		}
	}

	// Message queue indicator — only when there is something queued.
	if (queuedMessageCount > 0) {
		lines.push("");
		lines.push(
			`  ↳ ${queuedMessageCount} message${queuedMessageCount === 1 ? "" : "s"} queued for next dispatch — /omsg <text>`,
		);
	} else if (lastDelivery && now - lastDelivery.ts < 5 * 60 * 1000) {
		// Most recent delivery within the last 5 minutes — confirms the agent saw it.
		const ago = fmtElapsed(now - lastDelivery.ts);
		lines.push(
			`  ✓ ${lastDelivery.count} message${lastDelivery.count === 1 ? "" : "s"} delivered to ${lastDelivery.to} — ${ago} ago`,
		);
	}

	lines.push("");
	lines.push(`  ↯ updated ${new Date(now).toISOString().slice(11, 19)} UTC · log: ${logPath}`);

	return { statusLine, widgetLines: lines };
}

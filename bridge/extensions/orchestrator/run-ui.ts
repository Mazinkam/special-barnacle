import type { ProgressObservation, TimeoutWarning } from "./dispatch-progress.ts";

export interface NestedWorkerRow {
	taskId: string;
	agent: string;
	depth: number;
	turns: number;
	exitCode: number;
	finished: boolean;
	costUsd: number;
	latestText: string;
	firstSeenAt: number;
	lastChangedAt: number;
}

export interface DispatchProgressView {
	lastProgressAt: number;
	lastProgressDetail: string;
	loopSuspects: number;
	duplicateSnapshots: number;
	warning?: { text: string; at: number; kind: "inactivity" | "absolute" };
	lastLoggedWarning?: { text: string; at: number };
	nested: Map<string, NestedWorkerRow>;
}

export function createProgressView(now: number): DispatchProgressView {
	return {
		lastProgressAt: now,
		lastProgressDetail: "",
		loopSuspects: 0,
		duplicateSnapshots: 0,
		nested: new Map(),
	};
}

export function applyObservation(view: DispatchProgressView, observation: ProgressObservation, now: number): void {
	if (observation.kind === "progress") {
		view.lastProgressAt = now;
		view.lastProgressDetail = observation.detail;
		if (view.warning?.kind === "inactivity") view.warning = undefined;
	} else if (observation.kind === "loop") {
		view.loopSuspects += 1;
	} else if (observation.kind === "duplicate") {
		view.duplicateSnapshots += 1;
	}

	for (const snapshot of observation.nested ?? []) {
		const existing = view.nested.get(snapshot.taskId);
		if (!snapshot.changed) continue;
		if (existing) {
			Object.assign(existing, {
				agent: snapshot.agent,
				depth: snapshot.depth,
				turns: snapshot.turns,
				exitCode: snapshot.exitCode,
				finished: snapshot.finished,
				costUsd: snapshot.costUsd,
				latestText: snapshot.latestText,
				lastChangedAt: now,
			});
			continue;
		}
		view.nested.set(snapshot.taskId, {
			taskId: snapshot.taskId,
			agent: snapshot.agent,
			depth: snapshot.depth,
			turns: snapshot.turns,
			exitCode: snapshot.exitCode,
			finished: snapshot.finished,
			costUsd: snapshot.costUsd,
			latestText: snapshot.latestText,
			firstSeenAt: now,
			lastChangedAt: now,
		});
		if (view.nested.size > 32) {
			let oldest: NestedWorkerRow | undefined;
			for (const row of view.nested.values()) {
				if (!oldest || row.firstSeenAt < oldest.firstSeenAt) oldest = row;
			}
			if (oldest) view.nested.delete(oldest.taskId);
		}
	}
}

export function applyWarnings(
	view: DispatchProgressView,
	warnings: TimeoutWarning[],
	now: number,
	log: (line: string) => void,
): void {
	for (const warning of warnings) {
		view.warning = { text: warning.text, at: now, kind: warning.kind };
		if (view.lastLoggedWarning?.text === warning.text && now - view.lastLoggedWarning.at < 5 * 60 * 1000) continue;
		log(warning.text.replace(/\s+/g, " ").trim());
		view.lastLoggedWarning = { text: warning.text, at: now };
	}
}

export function fmtElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 0) return "";
	if (maxLength === 1) return "…";
	return `${text.slice(0, maxLength - 1)}…`;
}

export function formatProgressLine(view: DispatchProgressView, now: number, indent: string): string | undefined {
	if (!view.lastProgressDetail) return undefined;
	const prefix = `${indent}↳ progress ${fmtElapsed(now - view.lastProgressAt)} ago: `;
	const suffix = [
		view.loopSuspects > 0 ? `${view.loopSuspects} loop-suspect calls` : "",
		view.duplicateSnapshots > 0 ? `${view.duplicateSnapshots} duplicate snapshots` : "",
	].filter(Boolean).map((text) => ` · ${text}`).join("");
	const detail = singleLine(view.lastProgressDetail);
	const available = Math.max(0, 120 - prefix.length - suffix.length);
	return `${prefix}${truncate(detail, available)}${suffix}`.slice(0, 120);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinnerFrame(now: number): string {
	return SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length];
}

export function formatNestedWorkerRows(view: DispatchProgressView, now: number, parentDepth: number): string[] {
	const indent = "  ".repeat(2 + parentDepth);
	return [...view.nested.values()]
		.sort((a, b) => a.firstSeenAt - b.firstSeenAt)
		.map((row) => {
			const mark = row.exitCode === -1 ? (row.finished ? "✓" : spinnerFrame(now)) : row.exitCode === 0 ? "✓" : "✗";
			const fixed = `${indent}${mark} ${truncate(singleLine(row.agent), 20).padEnd(20)}  t${row.turns}  $${row.costUsd.toFixed(4)}  latest: `;
			const latest = truncate(singleLine(row.latestText), Math.max(0, 120 - fixed.length));
			return `${fixed}${latest}`.slice(0, 120);
		});
}

export function formatWarningLine(view: DispatchProgressView, now: number, indent: string): string | undefined {
	if (!view.warning) return undefined;
	const prefix = `${indent}⚠ `;
	const suffix = ` (${fmtElapsed(now - view.warning.at)} ago)`;
	const text = singleLine(view.warning.text);
	return `${prefix}${truncate(text, Math.max(0, 120 - prefix.length - suffix.length))}${suffix}`.slice(0, 120);
}

export function connectCancellationLoader(
	loader: { onAbort?: () => void },
	cancel: () => void,
	done: () => void,
): () => void {
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		done();
	};
	loader.onAbort = () => {
		cancel();
		close();
	};
	return close;
}

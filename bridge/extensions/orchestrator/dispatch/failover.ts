/**
 * Run one dispatch across its candidate models (spec §5.3). All I/O is injected
 * through `deps`, so tests use a fake clock and fake attempts.
 */
import { scanEvents, type EventScan } from "../core/event-scan.ts";
import { attemptSignalsFromScan, classifyFailure, failureReason, hadRealWork, type AttemptSignals, type FailureClass } from "../core/failure-class.ts";
import { applyStep, initialState, nextStep, pickCandidate, resumeAfterWait, waitOrGiveUp, type FailoverConfig, type Step } from "./failover-policy.ts";
import { buildHandoff } from "./handoff.ts";
import { providerRegion, type ModelHealth } from "../run/model-health.ts";
import { shortName } from "../models.ts";

export interface AttemptLike {
	exitCode: number;
	outcome: string;
	stderr: string;
	stopReason?: string;
	timeoutReason?: "inactivity" | "absolute";
	costUsd: number;
	nestedCostUsd?: number;
}
export interface AttemptRecord { model: string; cls: FailureClass; reason: string; costUsd: number; realWork: boolean }
export interface FailoverSwitch { from: string; to: string; cls: FailureClass; reason: string }
export interface FailoverTask { taskId: string; capability: string; prompt: string }

export interface FailoverDeps<R> {
	runAttempt: (model: string, prompt: string, attempt: number, spentBeforeUsd: number) => Promise<R>;
	readEvents: (result: R) => Iterable<string>;
	snapshot: () => unknown;
	changedSince: (snapshot: unknown) => string[];
	sleep: (ms: number) => Promise<void>;
	health: ModelHealth;
	isCancelled: () => boolean;
	recordEvent: (event: string, payload: Record<string, unknown>) => void;
	log: (line: string) => void;
	config: FailoverConfig;
	redact?: (s: string) => string;
	effortDropped?: (model: string) => boolean;
}

export interface FailoverResult<R> {
	result: R;
	attempts: Array<{ model: string; result: R; record: AttemptRecord }>;
	switches: FailoverSwitch[];
	finalModel: string;
	finalScan: EventScan;
	exhausted: boolean;
}

export async function dispatchWithFailover<R extends AttemptLike>(
	task: FailoverTask,
	candidates: string[],
	deps: FailoverDeps<R>,
): Promise<FailoverResult<R>> {
	if (candidates.length === 0) throw new Error(`dispatchWithFailover: no candidate models for ${task.taskId}`);
	const healthy = (m: string) => deps.health.isHealthy(m);
	const start = candidates.findIndex(healthy);
	let state = initialState(candidates, start >= 0 ? start : 0);
	let prompt = task.prompt;
	let spent = 0;
	const files = new Set<string>();
	const attempts: FailoverResult<R>["attempts"] = [];
	const switches: FailoverSwitch[] = [];

	for (;;) {
		const model = candidates[state.current];
		const snap = deps.snapshot();
		const n = attempts.length + 1;
		const result = await deps.runAttempt(model, prompt, n, spent);
		spent += result.costUsd + (result.nestedCostUsd ?? 0);
		const scan = scanEvents(deps.readEvents(result));
		const signals: AttemptSignals = attemptSignalsFromScan(result, scan, deps.isCancelled());
		const cls = classifyFailure(signals);
		const changed = deps.changedSince(snap);
		for (const f of changed) files.add(f);
		const realWork = hadRealWork(scan, changed, deps.config.realWorkMinToolCalls);
		const reason = cls === "ok" ? "" : failureReason(signals);
		attempts.push({ model, result, record: { model, cls, reason, costUsd: result.costUsd + (result.nestedCostUsd ?? 0), realWork } });
		const done = (exhausted: boolean, r: R = result): FailoverResult<R> => ({ result: r, attempts, switches, finalModel: model, finalScan: scan, exhausted });
		if (cls === "ok" || cls === "task" || cls === "cancelled") return done(false);

		deps.health.markUnhealthy(model, cls, deps.config.unhealthyMs);
		deps.recordEvent("model_unhealthy", { task_id: task.taskId, model, class: cls, for_ms: deps.config.unhealthyMs, reason });
		state = { ...state, failedRegions: [...state.failedRegions, providerRegion(model)] };
		if (realWork) {
			prompt = `${task.prompt}\n\n${buildHandoff({
				taskId: task.taskId, attempt: n + 1, previousModel: model, failureClass: cls, reason,
				filesChanged: [...files], scan, redact: deps.redact,
			})}`;
		}

		let step: Step = nextStep(state, cls, realWork, healthy, deps.config);
		let resumed = false;
		while (step.kind === "wait") {
			deps.log(`${task.taskId}: no healthy candidate; waiting ${Math.round(step.delayMs / 1000)}s before retrying the list`);
			await deps.sleep(step.delayMs);
			state = applyStep(state, step);
			if (deps.isCancelled()) return done(false);
			const index = pickCandidate(state, healthy);
			if (index !== null) {
				state = resumeAfterWait(state, index);
				step = { kind: "switch", index };
				resumed = true;
			} else {
				step = waitOrGiveUp(state, deps.config);
			}
		}

		if (step.kind === "give-up") {
			const summary = attempts.map((a) => `${a.model}: ${a.record.cls} ${a.record.reason}`).join("; ");
			deps.recordEvent("failover_exhausted", { task_id: task.taskId, capability: task.capability, reason: step.reason, attempts: attempts.map((a) => a.record) });
			deps.log(`${task.taskId}: all candidates unavailable (${step.reason})`);
			return done(true, { ...result, stderr: `[orchestrator] all candidates unavailable (${step.reason}): ${summary}\n${result.stderr}` });
		}
		if (step.kind === "retry-same") {
			deps.log(`${task.taskId}: ${model} failed (${cls}: ${reason}) after real work; retrying it once in ${Math.round(step.delayMs / 1000)}s with a handoff`);
			await deps.sleep(step.delayMs);
			if (deps.isCancelled()) return done(false);
			state = applyStep(state, step);
			continue;
		}
		const to = candidates[step.index];
		if (!resumed) state = applyStep(state, step);
		switches.push({ from: model, to, cls, reason });
		deps.recordEvent("route_degraded", {
			task_id: task.taskId, capability: task.capability, from_model: model, to_model: to, class: cls, reason,
			attempt: n + 1, real_work: realWork, handoff: realWork, effort_dropped: deps.effortDropped?.(to) ?? false,
		});
		deps.log(`${task.taskId}: ${model} failed (${cls}: ${reason}); switching to ${to}`);
	}
}

export function formatFailoverLine(results: Array<{ failovers?: FailoverSwitch[] }>): string | null {
	const all = results.flatMap((r) => r.failovers ?? []);
	if (all.length === 0) return null;
	return `failovers: ${all.length} — ${all.map((s) => `${shortName(s.from)}→${shortName(s.to)} (${s.cls} ${s.reason.slice(0, 80)})`).join(", ")}`;
}

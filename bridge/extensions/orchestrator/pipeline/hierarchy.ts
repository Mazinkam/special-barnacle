/**
 * Hierarchical dispatch (B4.6): given the planner's topology, run the
 * architect (when the topology calls for one), the Rule-2 parent-owned recon
 * packet, and the lead wave(s), in that order. `dispatchHierarchical` is the
 * per-plan entry point; `dispatchReconAndLeads` is the parent-owned
 * recon/lead sequencing on its own, independently tested with injected
 * `effects` (it has no RunContext/RunSession dependency at all).
 *
 * `dispatchHierarchical` used to return an `escalationResults: []` field for
 * the /orchestrate handler's verify/retry loop to `.push()` into after this
 * function had already returned — a mutable sink smuggled through a return
 * value. It no longer does: escalation retries are the retry loop's own
 * concern (pipeline/verify-loop.ts once extracted; today still in index.ts),
 * which owns and returns its own `escalationResults` array instead.
 *
 * pipeline/* must not import index.ts. `dispatch`/`captureDispatchCost` are
 * required fields on `deps` (no default referencing an index.ts singleton);
 * index.ts's caller supplies its own real `dispatchParallel`/
 * `captureDispatchCost`/`MAX_LEADS`/`RECON_EVIDENCE_MAX_CHARS`.
 */
import type { ExtensionContext } from "@humain/terminal";

import type { Adapter } from "../adapters/adapter-resolver.ts";
import { summarizeStderr } from "../dispatch/stderr-sink.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { isTransientProviderError } from "../core/transient-error.ts";
import {
	architectPrompt,
	complexityNeedsArchitect,
	effectiveLeadCount,
	leadPrompt,
	resumeLeadPrompt,
	retryLeadPrompt,
	type DispatchTask,
	type PlanResponse,
} from "../core/prompts.ts";
import { parseLeadAssignments, planLeadWaves, type LeadAssignment } from "../lead-plan.ts";
import { parseLeadStatus } from "../run-outcome.ts";
import { formatReconEvidence, planReconTasks } from "../recon.ts";
import { METHOD, shortName } from "../models.ts";
import { fmtElapsed } from "../run-ui.ts";
import type { RunContext, RunSessionLike } from "../run/context.ts";

/**
 * True when a lead's `DispatchResult` ended because of a transient provider
 * error (docs/architecture-review.md C3) rather than a bad result, a blocked
 * status, cancellation, its own dispatch timeout, or a spend-cap stop — the
 * single decision point both the wave loop below and its tests use, so
 * "should this lead be resumed" is judged exactly once, from exactly this
 * text. A cancelled dispatch is never resumed; a lead that exited 0 needs no
 * resuming; a lead whose own report says `STATUS: blocked` stopped at a
 * precondition, not a transient failure; a dispatch that hit its own
 * absolute timeout or spend-cap stop is not resumed. An inactivity kill with
 * provider evidence in its stderr or nested errorMessage is a provider_stall and
 * uses the same single resume budget as A3. Deliberately does not look at `stdout`: a
 * lead's own prose can legitimately mention words like "overloaded" while
 * describing something else, and the result's error/stderr/stopReason/exit
 * text is what actually reflects why the dispatch itself ended.
 */
// The watchdog's standalone ⚠ warning is also captured in stderr; its
// timeout-setting hint is not a provider timeout or retry signal.
function providerEvidenceStderr(stderr: string): string {
	return stderr.split("\n").filter((line) =>
		!/^\s*(?:⚠\s*no meaningful progress\b|\[orchestrator\].*timeout|dispatch timed out|UNVERIFIED PARTIAL WORK|taskId:|elapsedMs:|sinceLastProgressMs:|turns:|toolCalls:|repeatedToolCalls:|lastProgress:|nestedWorkers:|verified:|partialText:)/i.test(line),
	).join("\n");
}

function isProviderStall(r: DispatchResult): boolean {
	if (r.exitCode === 0 || r.outcome === "cancelled" || r.stopReason === "spend_cap" || parseLeadStatus(r.stdout) === "blocked") return false;
	if (r.outcome === "timed_out" && r.timeoutReason !== "inactivity") return false;
	const nestedErrors = r.interruption?.nestedWorkers.map((w) => w.errorMessage ?? "") ?? [];
	// The watchdog's timeout/interruption report and the copied nested lastText
	// are diagnostics, not provider evidence. Only actual stderr/provider error
	// lines and structured nested errorMessage may trigger a resume.
	const stderr = providerEvidenceStderr(r.stderr ?? "");
	return [stderr, ...nestedErrors].some((text) => isTransientProviderError(text));
}

export function isTransientLeadFailure(r: DispatchResult): boolean {
	if (r.exitCode === 0) return false;
	if (r.outcome === "cancelled") return false;
	if (isProviderStall(r)) return true;
	// Other timeouts remain A3 retry candidates only when a dependent wave
	// needs recovery. Never resume a spend-cap stop.
	if (r.outcome === "timed_out") return false;
	if (r.stopReason === "spend_cap") return false;
	if (parseLeadStatus(r.stdout) === "blocked") return false;
	const text = [providerEvidenceStderr(r.stderr ?? ""), r.stopReason, r.timeoutReason].filter(Boolean).join("\n");
	return isTransientProviderError(text);
}

/**
 * `"completed (STATUS: ...)"`, `"blocked"`, or `"failed (<reason>)"` for one lead's already-settled
 * `DispatchResult` (A3's truthful `## Other leads` section): never guesses, only describes what
 * actually happened to this exact result.
 */
function leadStatusLine(r: DispatchResult): string {
	if (parseLeadStatus(r.stdout) === "blocked") return "blocked";
	if (r.exitCode === 0) {
		const status = parseLeadStatus(r.stdout);
		return status ? `completed (STATUS: ${status})` : "completed";
	}
	const reason = r.outcome === "cancelled" ? "cancelled" : r.outcome === "timed_out" ? (r.timeoutReason ?? "timed out") : `exit ${r.exitCode}`;
	return `failed (${reason})`;
}

/**
 * The `## Other leads` lines a resume/retry prompt hands to `resumeLeadPrompt`/`retryLeadPrompt`
 * (A3): built fresh from real state at the moment of the call — every OTHER lead's own settled
 * result (from an earlier wave, or already-settled within this same wave) reads as its real
 * completed/failed/blocked state; a lead that has not run yet reads as "not started — depends on a
 * lead that failed or was blocked" only when that is actually true, otherwise "not started yet —
 * runs in a later wave after this recovery". Returns `undefined` (section omitted) when there is
 * only one lead — nothing false is ever said about a lead that doesn't exist.
 */
function buildOtherLeadsLines(
	excludeIndex: number,
	leadCount: number,
	completedLeadResults: DispatchResult[],
	currentWaveResults: Map<number, DispatchResult>,
	stoppedSoFar: ReadonlySet<number>,
	assignments: LeadAssignment[] | null,
): string[] | undefined {
	if (leadCount <= 1) return undefined;
	const priorByIndex = new Map<number, DispatchResult>();
	for (const r of completedLeadResults) {
		const m = /-lead-(\d+)$/.exec(r.taskId);
		if (m) priorByIndex.set(Number(m[1]), r);
	}
	const isStoppedNow = (idx: number): boolean => {
		if (idx === excludeIndex) return false; // its outcome is pending on the very recovery this section is written for
		if (stoppedSoFar.has(idx)) return true;
		const r = currentWaveResults.get(idx);
		return r ? r.exitCode !== 0 || parseLeadStatus(r.stdout) === "blocked" : false;
	};
	const lines: string[] = [];
	for (let j = 0; j < leadCount; j++) {
		if (j === excludeIndex) continue;
		const r = priorByIndex.get(j) ?? currentWaveResults.get(j);
		const state = r
			? leadStatusLine(r)
			: (assignments?.[j]?.dependsOn ?? []).some((d) => isStoppedNow(d))
				? "not started — depends on a lead that failed or was blocked"
				: "not started yet — runs in a later wave after this recovery";
		lines.push(`Lead ${j + 1}: ${state}`);
	}
	return lines;
}

/**
 * `"inactivity timeout"` / `"absolute timeout"` / `"exit N"` — the caller-supplied
 * `failureReason` `retryLeadPrompt` states plainly instead of the resume prompt's blanket
 * "transient provider error" (A3: the in-wave retry is also eligible for a dispatch's own
 * inactivity/absolute timeout, which is never a transient provider error).
 */
function retryFailureReason(r: DispatchResult): string {
	if (r.outcome === "timed_out") return `${r.timeoutReason ?? "unknown"} timeout`;
	return `exit ${r.exitCode}`;
}

/** Parent-owned recon/lead sequencing; effects are supplied by the bridge. */
export async function dispatchReconAndLeads(
	input: {
		runId: string;
		goal: string;
		plan: PlanResponse;
		adapter: Adapter;
		architectResult?: DispatchResult;
		/** Rule-2 recon evidence packet budget (method.json evidence_packet_max_tokens * chars/token). */
		evidenceMaxChars: number;
		/** Ceiling on the topology's requested lead count. */
		maxLeads: number;
		/** Sized lead capability (lead_small | lead | lead_large); defaults to "lead". */
		leadCapability?: string;
		/** The run's cwd, resolved absolute; forwarded into every lead prompt (docs/architecture-review.md C4). */
		repoRoot: string;
		/** The `## Provided context` block from `--context`/`--with-last-reply` (docs/architecture-review.md C6); `""`/undefined when neither was given. */
		providedContext?: string;
		/** A3: recover a lead that still fails after the transient-resume pass, IN-WAVE, when a later
		 *  wave depends on it — instead of leaving it in `stopped` until the post-QA escalation loop
		 *  recovers it too late for any dependent wave to ever be dispatched. Default `false`: today's
		 *  behavior (dependent waves marked "not started", the post-QA escalation loop is the only
		 *  recovery path) is unchanged unless a caller opts in. */
		inWaveRecovery?: boolean;
	},
	effects: {
		dispatch: (tasks: DispatchTask[]) => Promise<DispatchResult[]>;
		capture: (result: DispatchResult) => Promise<void>;
		setPhase: (phase: string) => void;
		throwIfCancelled: () => void;
		/** Opaque snapshot of the current file state, for `filesChangedSince` (C3 resume prompts). Optional: only real dispatch callers need to supply it. */
		markFiles?: () => unknown;
		/** Files changed since `mark` was taken, unioned with `claimed` (files the lead's own report named). Optional: falls back to `claimed` when absent. */
		filesChangedSince?: (mark: unknown, claimed: string[]) => string[];
	},
): Promise<{ leadResults: DispatchResult[]; workerResults: DispatchResult[]; skippedLeads: number; leadTasks: DispatchTask[]; resumedLeadTaskIds: string[]; retriedLeadTaskIds: string[]; resumedAttemptResults: DispatchResult[] }> {
	const { runId, goal, plan, adapter, architectResult, evidenceMaxChars, maxLeads, leadCapability = "lead", repoRoot, providedContext = "", inWaveRecovery = false } = input;
	const requestedLeadCount = effectiveLeadCount(plan, maxLeads);

	// Rule 2: parent-owned, read-only recon dispatched directly by the bridge
	// (not left to a lead's discretion) so it is an observable, billed dispatch
	// with its own progress row, log files, and cost — not an optimistic claim
	// that "workers fan out inside each lead".
	const reconTasks: DispatchTask[] = planReconTasks({
		method: METHOD.rules.pre_implementation_recon,
		complexity: plan.complexity,
		taskClass: plan.task_class,
		goal,
		runId,
	});
	// Cancellation boundaries. A cancelled run must (1) dispatch nothing new,
	// but (2) never lose the accounting for children that already finished.
	// So the check runs BEFORE each dispatch batch and AFTER the whole capture
	// loop for a completed batch — never between captures, or a cancellation
	// that lands mid-billing would leave some finished workers unbilled.
	effects.throwIfCancelled();
	let workerResults: DispatchResult[] = [];
	if (reconTasks.length === 0) {
		// Name the actual reason; "below threshold OR exempt" made the operator
		// guess, and read as false for an exempt class at high complexity.
		const rule = METHOD.rules.pre_implementation_recon;
		const reason = plan.complexity < rule.min_complexity
			? `complexity ${plan.complexity} is below the Rule-2 threshold ${rule.min_complexity}`
			: `task class "${plan.task_class}" is exempt (skip_for_task_classes)`;
		effects.setPhase(`no parent-owned recon required: ${reason}`);
	} else {
		effects.setPhase(`recon: 0/${reconTasks.length} starting`);
		workerResults = await effects.dispatch(reconTasks);
		for (const result of workerResults) await effects.capture(result);
		// Every finished recon worker is now billed exactly once; if the run was
		// cancelled while recon ran (or while billing it), stop here — before any
		// lead is announced or started.
		effects.throwIfCancelled();
		const completedRecon = workerResults.filter((r) => r.exitCode === 0).length;
		effects.setPhase(`recon: ${completedRecon}/${reconTasks.length} completed; dispatching lead(s)`);
	}
	// Every completed/failed recon result is folded into one bounded evidence
	// packet; failed workers are represented as unavailable, never silently
	// dropped. If ALL recon calls failed, say so explicitly rather than
	// letting the per-worker diagnostics read as ordinary partial coverage.
	const reconEvidenceBody = formatReconEvidence(workerResults, evidenceMaxChars);
	const reconAllFailed = reconTasks.length > 0 && workerResults.every((r) => r.exitCode !== 0);
	const reconEvidence = reconAllFailed
		? `DEGRADED: all ${workerResults.length} parent-owned recon worker(s) failed; no verified recon evidence is available for this run. Raw diagnostics follow for context only:\n\n${reconEvidenceBody}`
		: reconEvidenceBody;

	// Several leads need the architect's Lead assignments (scope + depends on).
	// Without them, run ONE lead with the whole goal rather than N clones.
	const architectText = architectResult && architectResult.exitCode === 0 ? architectResult.stdout : "";
	const assignments = requestedLeadCount > 1 ? parseLeadAssignments(architectText, requestedLeadCount) : null;
	const leadCount = assignments ? requestedLeadCount : 1;
	if (requestedLeadCount > 1 && !assignments) {
		effects.setPhase(`topology asked for ${requestedLeadCount} leads but the architect gave no valid Lead assignments; running a single lead`);
	}
	const waves = assignments ? planLeadWaves(assignments) : [[0]];
	const leadTaskFor = (i: number): DispatchTask => ({
		capability: leadCapability,
		task: leadPrompt(goal, plan, architectResult, reconEvidence, i, leadCount, adapter, repoRoot, assignments?.[i], providedContext),
		taskId: `${runId}-lead-${i}`,
	});

	const completedReconCount = workerResults.filter((r) => r.exitCode === 0).length;
	const reconPhaseNote =
		reconTasks.length > 0
			? `${completedReconCount}/${reconTasks.length} completed recon packet(s)`
			: "no parent-owned recon packets (not required for this task)";
	effects.throwIfCancelled();
	effects.setPhase(
		`${leadCount} lead(s) in ${waves.length} wave(s) executing on ${shortName(adapter[leadCapability]?.model ?? "?")} with ${reconPhaseNote}; nested subagent calls inside a lead are not authoritative worker accounting`,
	);
	const leadResults: DispatchResult[] = [];
	// The exact DispatchTask objects dispatched for each lead, in the same
	// order/identity as leadResults (paired by taskId). BUG 2: escalation
	// retries were built from the failed lead's REPORT because the original
	// prompt was never kept anywhere past this function; callers now use this
	// to recover the lead's original goal/scope/model-routing prompt on retry.
	const leadTasks: DispatchTask[] = [];
	const stopped = new Set<number>();
	const resumedLeadTaskIds: string[] = [];
	// taskIds recovered via A3's in-wave retry (never the same taskId as resumedLeadTaskIds: a lead
	// gets at most one recovery in total). Kept separate from resumedLeadTaskIds so run-orchestration.ts
	// can label them "in-wave retry" instead of "resume" in the run summary.
	const retriedLeadTaskIds: string[] = [];
	// The discarded (failed) attempt of every resumed OR in-wave-retried lead, kept separately from
	// `leadResults` (which only ever holds the ONE result used to classify that
	// lead's status) so its cost is still counted toward the run's total spend
	// — both attempts are billed, but only the final attempt speaks for the lead.
	const resumedAttemptResults: DispatchResult[] = [];
	for (const [w, wave] of waves.entries()) {
		// A lead whose dependency failed or reported STATUS: blocked is not started.
		const runnable = wave.filter((i) => !(assignments?.[i]?.dependsOn ?? []).some((d) => stopped.has(d)));
		for (const i of wave) if (!runnable.includes(i)) stopped.add(i);
		const skipped = wave.filter((i) => !runnable.includes(i));
		if (skipped.length > 0) {
			effects.setPhase(`wave ${w + 1}: not starting lead(s) ${skipped.map((i) => i + 1).join(", ")} — a lead they depend on failed or was blocked`);
		}
		if (runnable.length === 0) continue;
		if (waves.length > 1) effects.setPhase(`wave ${w + 1}/${waves.length}: lead(s) ${runnable.map((i) => i + 1).join(", ")}`);
		const tasks = runnable.map(leadTaskFor);
		const waveStartMark = effects.markFiles ? effects.markFiles() : undefined;
		const results = await effects.dispatch(tasks);
		for (const r of results) await effects.capture(r);
		// Same contract as recon: bill every finished lead, then honour cancellation.
		effects.throwIfCancelled();
		// C3: a lead that exited because of a transient provider error (not a bad
		// result, blocked status, or cancellation) is re-dispatched once, with the
		// original lead prompt plus a `## Resume` section built from its own last
		// report and the files changed since it started — instead of discarding
		// the work a lead's subagents already left on disk. Never more than once
		// per lead: the replaced result below is not re-examined for resume.
		const finalResults = [...results];
		const currentWaveResults = (): Map<number, DispatchResult> => new Map(runnable.map((idx, kk) => [idx, finalResults[kk]!]));
		for (const [k, r] of results.entries()) {
			if (!isTransientLeadFailure(r)) continue;
			const leadIndex = runnable[k];
			const originalTask = tasks[k];
			const filesChangedSinceStart = effects.filesChangedSince
				? effects.filesChangedSince(waveStartMark, r.filesChanged)
				: r.filesChanged;
			effects.setPhase(`lead ${leadIndex + 1}: ${isProviderStall(r) ? "provider_stall" : "transient provider error"}, resuming once`);
			const otherLeads = buildOtherLeadsLines(leadIndex, leadCount, leadResults, currentWaveResults(), stopped, assignments);
			const [resumed] = await effects.dispatch([
				{ ...originalTask, task: resumeLeadPrompt(originalTask.task, r.stdout, filesChangedSinceStart, otherLeads) },
			]);
			if (resumed) {
				await effects.capture(resumed);
				resumedAttemptResults.push(r);
				finalResults[k] = resumed;
				resumedLeadTaskIds.push(originalTask.taskId);
			}
			effects.throwIfCancelled();
		}
		// A3: in-wave recovery, gated on `inWaveRecovery` and run AFTER the transient-resume pass above,
		// BEFORE `stopped` is computed for this wave — a lead still failing here, with a dependent lead
		// in a later wave, gets exactly one more recovery attempt (never a second one on top of a
		// transient resume: `resumedLeadTaskIds` already used this lead's one recovery). Eligible: still
		// failed (`exitCode !== 0`), not cancelled, not stopped by the per-dispatch spend cap, not
		// `STATUS: blocked` (a real precondition failure, not a recoverable one), and has at least one
		// dependent lead — a lead nobody depends on keeps today's behavior (the post-QA escalation loop
		// recovers it, if anything does). Timed-out leads ARE eligible here (unlike the transient-resume
		// pass above): a lead that hit its own inactivity/absolute timeout still blocks every dependent
		// wave if left in `stopped`.
		if (inWaveRecovery) {
			for (const [k, r] of finalResults.entries()) {
				const leadIndex = runnable[k];
				const originalTask = tasks[k];
				if (resumedLeadTaskIds.includes(originalTask.taskId)) continue; // already used this lead's one recovery
				if (r.exitCode === 0) continue;
				if (r.outcome === "cancelled") continue;
				if (r.stopReason === "spend_cap") continue;
				if (parseLeadStatus(r.stdout) === "blocked") continue;
				const hasDependent = (assignments ?? []).some((a) => a.dependsOn.includes(leadIndex));
				if (!hasDependent) continue;
				const filesChangedSinceStart = effects.filesChangedSince
					? effects.filesChangedSince(waveStartMark, r.filesChanged)
					: r.filesChanged;
				const failureReason = retryFailureReason(r);
				effects.setPhase(`lead ${leadIndex + 1}: ${failureReason}, retrying in-wave (a later wave depends on it)`);
				const otherLeads = buildOtherLeadsLines(leadIndex, leadCount, leadResults, currentWaveResults(), stopped, assignments);
				const [retried] = await effects.dispatch([
					{ ...originalTask, task: retryLeadPrompt(originalTask.task, r.stdout, filesChangedSinceStart, failureReason, otherLeads) },
				]);
				if (retried) {
					await effects.capture(retried);
					resumedAttemptResults.push(r);
					finalResults[k] = retried;
					retriedLeadTaskIds.push(originalTask.taskId);
				}
				effects.throwIfCancelled();
			}
		}
		for (const [k, r] of finalResults.entries()) {
			if (r.exitCode !== 0 || parseLeadStatus(r.stdout) === "blocked") stopped.add(runnable[k]);
		}
		leadResults.push(...finalResults);
		leadTasks.push(...tasks);
	}

	// Recon is parent-owned and returned for billing/reporting. Any further
	// fan-out a lead performs via HT's own subagent tool happens inside that
	// lead's own context window; the bridge has no visibility into it and does
	// not count it as part of this run's authoritative worker accounting.
	// Leads never started because a lead they depend on failed or was blocked.
	const skippedLeads = [...stopped].filter((i) => !leadResults.some((r) => r.taskId === `${runId}-lead-${i}`)).length;
	return { leadResults, workerResults, skippedLeads, leadTasks, resumedLeadTaskIds, retriedLeadTaskIds, resumedAttemptResults };
}

/** Dispatch + billing seams `dispatchHierarchical` needs; index.ts's caller supplies the real ones. */
export interface HierarchyDeps {
	/** Fans a batch of tasks out to their own subprocesses; already bound to cwd/runId/adapter/ctx/run. */
	dispatch: (tasks: DispatchTask[]) => Promise<DispatchResult[]>;
	captureDispatchCost: (
		opts: CaptureOpts,
		result: DispatchResult,
		run: RunContext<RunSessionLike> | null,
	) => Promise<void>;
	/** Ceiling on the topology's requested lead count (config.ts's `maxLeads`). */
	maxLeads: number;
	/** Rule-2 recon evidence packet budget (config.ts's `reconEvidenceMaxChars`). */
	evidenceMaxChars: number;
	/** The run's cwd, resolved absolute (docs/architecture-review.md C4): threaded into every lead
	 *  prompt so the lead is told plainly where it is instead of guessing and running `find /`. */
	repoRoot: string;
	/** The `## Provided context` block from `--context`/`--with-last-reply` (docs/architecture-review.md C6); `""`/undefined when neither was given. */
	providedContext?: string;
	/** Opaque snapshot of the current file state, for `filesChangedSince` (C3 resume prompts). Optional. */
	markFiles?: () => unknown;
	/** Files changed since `mark` was taken, unioned with `claimed` (files the lead's own report named). Optional. */
	filesChangedSince?: (mark: unknown, claimed: string[]) => string[];
	/** A3: recover an in-wave-dependent lead that still fails after the transient-resume pass, instead
	 *  of leaving every dependent wave marked "not started" until the post-QA escalation loop recovers
	 *  it too late to matter. Default `false`. */
	inWaveRecovery?: boolean;
}

/**
 * Dispatch work according to the topology the planner returned. Two paths:
 *
 * - depth <= 2: dispatch a single orchestrator-lead agent at the recommended
 *   capability. The lead handles its own workers via the subagent tool. This
 *   is the common case for complexity < 7.
 *
 * - depth >= 3: dispatch `leads` orchestrator-lead agents in parallel; each
 *   lead fans out its own workers. Used for complexity 7+ where the
 *   architect has multiple independent sub-domains to attack.
 *
 * Returns the flat list of leaf (worker) dispatches for bookkeeping. Lead
 * dispatches themselves get recorded as their own model_call + route_executed.
 */
export async function dispatchHierarchical(
	runId: string,
	planId: string,
	goal: string,
	plan: PlanResponse,
	adapter: Adapter,
	ctx: ExtensionContext,
	/** The run this dispatch belongs to; threaded through to `deps.dispatch`,
	 *  `deps.captureDispatchCost` and `dispatchReconAndLeads`'s effects instead
	 *  of an implicit "active run" read (B4.4). */
	run: RunContext<RunSessionLike> | null,
	leadCapability: string,
	deps: HierarchyDeps,
): Promise<{
	leadResults: DispatchResult[];
	workerResults: DispatchResult[];
	/** Leads not started because a dependency failed or was blocked. */
	skippedLeads: number;
	/** The architect dispatch, when the topology called for one. Billed by the caller. */
	architectResult?: DispatchResult;
	/** Original DispatchTask objects dispatched for each lead, paired with leadResults by taskId — needed to build faithful retry prompts (BUG 2). */
	leadTasks: DispatchTask[];
	/** taskIds of leads re-dispatched once after a transient provider error (C3). */
	resumedLeadTaskIds: string[];
	/** taskIds of leads recovered in-wave (A3) because a later wave depended on them. */
	retriedLeadTaskIds: string[];
	/** The discarded (failed) attempt of every resumed lead, for billing alongside `leadResults` (C3). */
	resumedAttemptResults: DispatchResult[];
}> {
	const { depth } = plan.topology;
	const captureOpts: CaptureOpts = {
		runId, planId, taskClass: plan.task_class, complexity: plan.complexity,
		risk: plan.risk, recommended: plan.route.recommended, mode: plan.route.mode,
	};

	// Always: dispatch the architect first if it's a high-complexity / new-domain
	// task. The architect's output feeds into subsequent dispatch prompts.
	// For depth=1, skip — the lead IS the architect.
	let architectResult: DispatchResult | undefined;
	const needsArchitect = depth >= 2 && complexityNeedsArchitect(plan.complexity);
	if (needsArchitect) {
		run?.session.setPhase(
			`architect planning on ${shortName(adapter.architect?.model ?? "?")} (complexity ${plan.complexity} ≥ 5)`,
		);
		[architectResult] = await deps.dispatch([
			{
				capability: "architect",
				task: architectPrompt(goal, plan, deps.maxLeads, deps.providedContext ?? ""),
				taskId: `${runId}-architect`,
			},
		]);
		await deps.captureDispatchCost(captureOpts, architectResult, run);
		// The leads proceed without a plan rather than aborting the run, but the
		// operator must be told the decomposition step was lost — it silently
		// changes what the leads are working from.
		if (!architectResult || architectResult.exitCode !== 0) {
			ctx.ui.notify(
				`Architect dispatch failed (exit ${architectResult?.exitCode ?? "n/a"}): ${
					summarizeStderr(architectResult?.stderr ?? "no result", 300) || "(no output)"
				}\nLeads will run without an architect plan.`,
				"warning",
			);
		} else if (architectResult) {
			run?.session.setPhase(
				`architect done in ${fmtElapsed(architectResult.durationMs)} ($${architectResult.costUsd.toFixed(4)}) — ${architectResult.stdout.split("\n").filter((l) => /^\s*\d+[.)]/.test(l)).length} tasks planned`,
			);
		}
	}

	const results = await dispatchReconAndLeads(
		{ runId, goal, plan, adapter, architectResult, leadCapability, evidenceMaxChars: deps.evidenceMaxChars, maxLeads: deps.maxLeads, repoRoot: deps.repoRoot, providedContext: deps.providedContext, inWaveRecovery: deps.inWaveRecovery },
		{
			dispatch: deps.dispatch,
			capture: (result) => deps.captureDispatchCost(captureOpts, result, run),
			setPhase: (phase) => run?.session.setPhase(phase),
			throwIfCancelled: () => run?.session.cancellation.throwIfCancelled(),
			markFiles: deps.markFiles,
			filesChangedSince: deps.filesChangedSince,
		},
	);
	return { ...results, architectResult };
}

/**
 * Every dispatch this run paid for, in lifecycle order. Parent-owned recon
 * workers are billed dispatches like any other; omitting them under-reported
 * total spend, which is the number the cost policy is judged on. Each result
 * appears exactly once — recon is captured to the ledger during
 * `dispatchReconAndLeads()`, and this list is only the final-summary view.
 */
export function collectBilledResults(input: {
	architectResult?: DispatchResult;
	workerResults: DispatchResult[];
	leadResults: DispatchResult[];
	verificationResults: DispatchResult[];
	escalationResults: DispatchResult[];
	/** The discarded (failed) attempt of every lead resumed once after a transient provider error
	 *  (C3): billed alongside `leadResults`' kept (final) attempt, so both dispatches' cost counts
	 *  toward the run's total spend even though only the final attempt speaks for the lead's status. */
	resumedAttemptResults?: DispatchResult[];
}): DispatchResult[] {
	return [
		...(input.architectResult ? [input.architectResult] : []),
		...input.workerResults,
		...input.leadResults,
		...(input.resumedAttemptResults ?? []),
		...input.verificationResults,
		...input.escalationResults,
	];
}

/**
 * Operator-facing summary line for parent-owned recon. Failed workers are
 * named with a summarized (never raw) stderr so the final notification stays
 * bounded and readable.
 */
export function summarizeReconWorkers(workerResults: DispatchResult[]): string {
	if (workerResults.length === 0) return "recon workers: none (not required for this task)";
	const completed = workerResults.filter((r) => r.exitCode === 0).length;
	const cost = workerResults.reduce((s, r) => s + r.costUsd, 0);
	const failures = workerResults
		.filter((r) => r.exitCode !== 0)
		.map((r) => `${r.taskId} exit ${r.exitCode}: ${summarizeStderr(r.stderr, 120) || "(no output)"}`);
	return [
		`recon workers: ${completed}/${workerResults.length} completed · $${cost.toFixed(4)}`,
		...failures.map((f) => `  failed ${f}`),
	].join("\n");
}

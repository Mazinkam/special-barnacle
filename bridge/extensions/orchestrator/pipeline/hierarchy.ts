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
	type DispatchTask,
	type PlanResponse,
} from "../core/prompts.ts";
import { parseLeadAssignments, planLeadWaves } from "../lead-plan.ts";
import { parseLeadStatus } from "../run-outcome.ts";
import { formatReconEvidence, planReconTasks } from "../recon.ts";
import { METHOD, shortName } from "../models.ts";
import { fmtElapsed } from "../run-ui.ts";
import type { RunContext } from "../run/context.ts";
import type { RunSession } from "../run/session.ts";

/**
 * True when a lead's `DispatchResult` ended because of a transient provider
 * error (docs/architecture-review.md C3) rather than a bad result, a blocked
 * status, cancellation, its own dispatch timeout, or a spend-cap stop — the
 * single decision point both the wave loop below and its tests use, so
 * "should this lead be resumed" is judged exactly once, from exactly this
 * text. A cancelled dispatch is never resumed; a lead that exited 0 needs no
 * resuming; a lead whose own report says `STATUS: blocked` stopped at a
 * precondition, not a transient failure; a dispatch that hit its own
 * inactivity/absolute timeout (`outcome === "timed_out"`) or was stopped by
 * the per-dispatch spend cap (`stopReason === "spend_cap"`) is not resumed
 * either, mirroring dispatch/parallel.ts's quota-fallback eligibility check
 * (`r.outcome !== "timed_out" && r.stopReason !== "spend_cap"`) — resuming
 * either would re-run work that already ran to its own limit rather than a
 * transient provider hiccup. Deliberately does not look at `stdout`: a
 * lead's own prose can legitimately mention words like "overloaded" while
 * describing something else, and the result's error/stderr/stopReason/exit
 * text is what actually reflects why the dispatch itself ended.
 */
export function isTransientLeadFailure(r: DispatchResult): boolean {
	if (r.exitCode === 0) return false;
	if (r.outcome === "cancelled") return false;
	// Never resume a dispatch that hit its own timeout (`timed_out`) or was
	// stopped by the per-dispatch spend cap (`spend_cap`): resuming either
	// would re-run work that already ran to its own limit, mirroring
	// dispatch/parallel.ts's quota-fallback eligibility check
	// (`r.outcome !== "timed_out" && r.stopReason !== "spend_cap"`).
	if (r.outcome === "timed_out") return false;
	if (r.stopReason === "spend_cap") return false;
	if (parseLeadStatus(r.stdout) === "blocked") return false;
	const text = [r.stderr, r.stopReason, r.timeoutReason].filter(Boolean).join("\n");
	return isTransientProviderError(text);
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
): Promise<{ leadResults: DispatchResult[]; workerResults: DispatchResult[]; skippedLeads: number; leadTasks: DispatchTask[]; resumedLeadTaskIds: string[]; resumedAttemptResults: DispatchResult[] }> {
	const { runId, goal, plan, adapter, architectResult, evidenceMaxChars, maxLeads, leadCapability = "lead", repoRoot, providedContext = "" } = input;
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
	// The discarded (failed) attempt of every resumed lead, kept separately from
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
		for (const [k, r] of results.entries()) {
			if (!isTransientLeadFailure(r)) continue;
			const leadIndex = runnable[k];
			const originalTask = tasks[k];
			const filesChangedSinceStart = effects.filesChangedSince
				? effects.filesChangedSince(waveStartMark, r.filesChanged)
				: r.filesChanged;
			effects.setPhase(`lead ${leadIndex + 1}: transient provider error, resuming once`);
			const [resumed] = await effects.dispatch([
				{ ...originalTask, task: resumeLeadPrompt(originalTask.task, r.stdout, filesChangedSinceStart) },
			]);
			if (resumed) {
				await effects.capture(resumed);
				resumedAttemptResults.push(r);
				finalResults[k] = resumed;
				resumedLeadTaskIds.push(originalTask.taskId);
			}
			effects.throwIfCancelled();
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
	return { leadResults, workerResults, skippedLeads, leadTasks, resumedLeadTaskIds, resumedAttemptResults };
}

/** Dispatch + billing seams `dispatchHierarchical` needs; index.ts's caller supplies the real ones. */
export interface HierarchyDeps {
	/** Fans a batch of tasks out to their own subprocesses; already bound to cwd/runId/adapter/ctx/run. */
	dispatch: (tasks: DispatchTask[]) => Promise<DispatchResult[]>;
	captureDispatchCost: (
		opts: CaptureOpts,
		result: DispatchResult,
		run: RunContext<RunSession> | null,
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
	run: RunContext<RunSession> | null,
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
		{ runId, goal, plan, adapter, architectResult, leadCapability, evidenceMaxChars: deps.evidenceMaxChars, maxLeads: deps.maxLeads, repoRoot: deps.repoRoot, providedContext: deps.providedContext },
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

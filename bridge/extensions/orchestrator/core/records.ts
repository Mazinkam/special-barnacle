/**
 * Metrics rows attributable to a single dispatch. Pure: takes the dispatch's
 * `CaptureOpts`/`DispatchResult`, plus the active run's tag set as an explicit
 * parameter (the caller — `index.ts` — passes its current `RunContext.tags`
 * (B4.4, run/context.ts); this module never reads a global itself).
 */

import type { SubagentSingleResult } from "@humain/terminal";
import { isLeadCapability } from "../lead-sizing.ts";
import { type LeadSize, METHOD } from "../models.ts";
import type { InterruptionReport } from "../dispatch-progress.ts";

export interface DispatchResult {
	taskId: string;
	capability: string;
	model: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	usage: SubagentSingleResult["usage"];
	durationMs: number;
	costUsd: number;
	/** Spend of the dispatch's own `subagent` calls (a lead's implementers/reviewers); not in `costUsd`. */
	nestedCostUsd?: number;
	costReported: boolean;
	stopReason?: string;
	/** Process disposition after considering terminal JSON events (see index.ts's SubagentProcessResult). */
	outcome?: "completed" | "completed_after_process_error" | "failed" | "timed_out" | "cancelled";
	timeoutReason?: "inactivity" | "absolute";
	interruption?: InterruptionReport;
	filesChanged: string[];
	/** HT thinking level the dispatch ran at (from the binding), when one was set. */
	effort?: string;
}

export interface CaptureOpts {
	runId: string;
	planId: string;
	taskClass: string;
	complexity: number;
	risk: string;
	recommended: {
		capability: string;
		effort: string;
		verification_depth: string;
		estimated_verified_cost_usd?: number;
		estimated_quality_evidence?: number;
	};
	mode: string;
}

/**
 * Cohort tags stamped on every model_call / route_executed row of the active
 * run so routing history can be grouped by profile, resolved adapter, and
 * lead size.
 */
export interface RunTags {
	profile?: string;
	policy_id?: string;
	lead_size?: LeadSize;
}

export function runTagFields(tags: RunTags): Record<string, string> {
	const out: Record<string, string> = {};
	if (tags.profile) out.profile = tags.profile;
	if (tags.policy_id) out.policy_id = tags.policy_id;
	if (tags.lead_size) out.lead_size = tags.lead_size;
	return out;
}

/** HT thinking level -> method.json effort vocabulary (minimal|low|standard|high|maximum). */
export function methodEffortFor(thinking: string | undefined): string {
	if (thinking === undefined) return "standard"; // unset defaults to standard
	return METHOD.effort_aliases[thinking] ?? "standard";
}

/**
 * A lead that reports changed files but never mentions dispatching an
 * implementer did the implementation itself — the costliest pattern in the
 * 2026-09-24 data. Flagged for the dashboard, not blocked here.
 */
export function leadSelfImplemented(result: Pick<DispatchResult, "filesChanged" | "stdout"> | undefined): boolean {
	return (result?.filesChanged?.length ?? 0) > 0 && !/orch-implementation-(strong|fast)|orch-worker/.test(result?.stdout ?? "");
}

/**
 * Every metrics row one dispatch is accountable for, as pure data so the whole
 * set can be asserted without spawning the Python CLI. Exactly two rows — and
 * deliberately not a third.
 *
 * There is no `task_verified` / `task_failed` row here. `records.py` classifies
 * those events as ATTESTED, its strongest evidence class, meaning "a runtime
 * states that this task cleared its quality gates". A process exit code cannot
 * support that claim, and deriving one from it is the exact conflation this
 * branch exists to remove — it is how `Verified tasks` read 174 when 22 tasks
 * had a real verdict. Three reasons, all reproducible:
 *
 * 1. Redundancy. The dispatch-level signal is already reported twice, honestly:
 *    `result: 'pass' | 'fail'` on the `model_call` row and `executed_passes` on
 *    the `route_executed` row. `records.py` reads `result` as DISPATCH strength,
 *    which is exactly what an exit code is worth.
 * 2. Ordering. `runVerification` bills its QA dispatch through here BEFORE the
 *    gate verdict exists (`qaResult.exitCode === 0 && failedChecks.length === 0`
 *    is computed afterwards). A QA agent that exits 0 while reporting failed
 *    checks therefore emitted an attested `task_verified` while `recordOutcome`
 *    wrote `outcome: 'fail'` for the SAME `task_id`.
 * 3. Attribution. Five of the six call sites dispatch coordination, not
 *    deliverable tasks: `${runId}-architect`, `${runId}-lead-${i}`,
 *    `triage-<slug>`, the escalation retry, and the QA pass itself. Attesting
 *    verification of a synthetic coordination id asserts nothing about work.
 *
 * Per-task attestation is not derivable in this bridge, so the gap is left
 * honest rather than filled with a fabrication (`records.UNINSTRUMENTED_FIELDS`
 * exists so the dashboard can report exactly that): one QA pass returns ONE
 * verdict over the union of changed files; `changedSince` flattens that union to
 * a `string[]` whose task provenance does not survive the git-snapshot
 * intersection; `failedChecks` names checks (`typecheck`), not tasks; and the
 * real deliverable tasks are the leads' own workers, which this bridge never
 * observes (`dispatchHierarchical` returns `workerResults: []`). The one genuine
 * gate verdict that does exist is written by `runVerification` through
 * `recordOutcome`, after `failedChecks` is known.
 */
export function dispatchRecordsFor(
	opts: CaptureOpts,
	result: DispatchResult,
	runTags: RunTags = {},
): Record<string, unknown>[] {
	// Defensive defaults: every field on `result` may be sparse when HT
	// returns a partial / cancelled dispatch. Normalize once at the top so
	// the metric payloads below are always well-formed and the split() on
	// the model id can't throw.
	const model = result?.model ?? "unknown";
	const usage = result?.usage ?? {};
	const provider = model.includes("/") ? model.split("/")[0] : "unknown";
	const taskId = result?.taskId ?? `unknown-${opts.runId}`;

	// 1. The model_call record HT actually produced. `cost_source: "reported"`
	//    means the harness reported cost directly; if cost is missing, the
	//    pricing table resolves it to `estimated`.
	const hasReportedCost = result?.costReported === true;
	return [{
		event: "model_call",
		run_id: opts.runId,
		task_id: taskId,
		task_class: opts.taskClass,
		complexity: opts.complexity,
		risk: opts.risk,
		role: result?.capability ?? "unknown",
		capability_class: result?.capability ?? "unknown",
		agent_runtime: "humain-terminal",
		provider,
		model,
		// `effort` stays in the method's vocabulary (comparable with
		// recommended_effort); the raw HT thinking level is kept separately.
		effort: methodEffortFor(result?.effort),
		...(result?.effort ? { thinking_level: result.effort } : {}),
		verification_depth: "targeted",
		// HT input excludes cache reads; the telemetry/pricing contract includes them.
		input_tokens: (usage.input ?? 0) + (usage.cacheRead ?? 0),
		cached_input_tokens: usage.cacheRead ?? 0,
		cache_write_tokens: usage.cacheWrite ?? 0,
		output_tokens: usage.output ?? 0,
		...(hasReportedCost ? { cost_usd: result.costUsd, cost_source: "reported" } : {}),
		duration_ms: result?.durationMs ?? 0,
		result: result?.exitCode === 0 ? "pass" : "fail",
		stop_reason: result?.stopReason,
		files_changed: result?.filesChanged ?? [],
		plan_id: opts.planId,
		...runTagFields(runTags),
		...(isLeadCapability(result?.capability ?? "") && leadSelfImplemented(result) ? { lead_self_implemented: true } : {}),
	}, {
		// 2. The executed-route record. This is the closing half of the
		//    (recommended, executed, observed) triple: the plan-time
		//    `adaptive_route_decision` event already has `recommended_*`; this
		//    event records what was actually dispatched and what it cost.
		event: "route_executed",
		run_id: opts.runId,
		task_id: taskId,
		plan_id: opts.planId,
		task_class: opts.taskClass,
		complexity: opts.complexity,
		risk: opts.risk,
		capability_class: result?.capability ?? "unknown",
		executed_model: model,
		executed_effort: methodEffortFor(result?.effort),
		...(result?.effort ? { executed_thinking_level: result.effort } : {}),
		executed_verification_depth: "targeted",
		...(hasReportedCost ? { executed_cost_usd: result.costUsd } : {}),
		executed_input_tokens: (usage.input ?? 0) + (usage.cacheRead ?? 0),
		executed_output_tokens: usage.output ?? 0,
		executed_passes: result?.exitCode === 0,
		recommended_capability: opts.recommended.capability,
		recommended_effort: opts.recommended.effort,
		recommended_verification_depth: opts.recommended.verification_depth,
		recommended_estimated_verified_cost_usd:
			opts.recommended.estimated_verified_cost_usd,
		recommended_estimated_quality_evidence:
			opts.recommended.estimated_quality_evidence,
		adaptive_mode: opts.mode,
		...runTagFields(runTags),
	}];
}

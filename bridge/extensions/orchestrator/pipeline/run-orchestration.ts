/**
 * `/orchestrate`'s run body (B4.6): triage -> plan -> size -> confirm ->
 * dispatch -> verify/escalate -> finalize. Extracted out of
 * `commands/orchestrate.ts` per docs/architecture-review.md B4.6 as a
 * mechanical cut — the confirmation gates, cancellation checks and side
 * effect ordering are unchanged, only their home moved. It stays one
 * function for the same reason it did in `commands/orchestrate.ts`: its
 * steps share dozens of run-scoped locals (the plan, lead sizing decision,
 * accumulating dispatch results, the retry loop's escalation state, ...)
 * that a confirmation gate or a cancellation check can observe or
 * short-circuit at almost any point.
 *
 * `runOrchestration` does NOT build or post the final summary text: it
 * returns a `RunReport` (core/report.ts) for the caller to run through
 * `buildRunSummary`, so `commands/orchestrate.ts` keeps ownership of the
 * final `notify`/`postRunMessage` pair. A handful of *earlier* stops (the
 * user declining a confirmation, triage/plan failing outright) are not
 * "the run's summary" — they already fully log, `failRun`, and notify
 * themselves, exactly as they did inline, and are reported back as
 * `{ kind: "aborted" }` so the caller does nothing further for them.
 *
 * pipeline/* must not import index.ts; every seam is a required field on
 * `deps` instead, same as `pipeline/hierarchy.ts` and `pipeline/verify-loop.ts`.
 */
import type { ExtensionContext } from "@humain/terminal";

import type { OrchestrateArgs } from "../core/args.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { complexityNeedsArchitect, type DispatchTask, type PlanResponse } from "../core/prompts.ts";
import type { RunReport } from "../core/report.ts";
import type { TriageResult } from "../core/triage.ts";
import { pickModel } from "../core/routing.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";
import { changedFilesSinceRunStart, gitDirtySnapshot, gitHead } from "../adapters/git-changes.ts";
import { formatAdapterTable, shortName } from "../models.ts";
import { planEscalation, type EscalationLeadInput } from "../escalation.ts";
import { leadSizeOf, sizeLead, type LeadSizeDecision } from "../lead-sizing.ts";
import { classifyRunOutcome, externalChangeFiles, parseLeadStatus } from "../run-outcome.ts";
import { summarizeStderr } from "../dispatch/stderr-sink.ts";
import { confirmStep, safeUi } from "../run/ui-sink.ts";
import { describeRunArtifact, type RunSession, type RunTiming } from "../run/session.ts";
import type { RunContext } from "../run/context.ts";
import { telemetryWarning, type FlushReport, type QueueStats } from "../record-queue.ts";
import { collectBilledResults, dispatchHierarchical, summarizeReconWorkers } from "./hierarchy.ts";
import { runVerification, type VerificationResult } from "./verify-loop.ts";

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

/** The seams `runOrchestration` needs; `commands/orchestrate.ts` supplies the real ones
 *  (a subset of `OrchestrateDeps` — resolving the adapter and creating/claiming the
 *  session happen before this function is called). */
export interface RunOrchestrationDeps {
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
	/** `<STATE_ROOT>`, threaded through onto the returned `RunReport`'s ledger line. */
	stateRoot: string;
}

/**
 * A run that reached its terminal (non-cancelled, non-crashed) state: the
 * caller builds and posts the summary from `report` itself.
 */
export interface RunCompleted {
	kind: "completed";
	report: RunReport;
}

/**
 * A run that stopped before dispatch settled anything worth summarizing — a
 * declined confirmation, or triage/plan failing outright. Already fully
 * logged, `failRun`'d and notified by the step that stopped it; the caller
 * has nothing further to do.
 */
export interface RunAborted {
	kind: "aborted";
}

export type RunOrchestrationResult = RunCompleted | RunAborted;

/** Surface a failed terminal drain to the operator; silent on success. Exported so
 *  `commands/orchestrate.ts`'s cancellation/crash catch block (outside this function's
 *  scope) can use the exact same wording. */
export function warnTelemetry(ctx: ExtensionContext, report: FlushReport): void {
	for (const line of telemetryWarning(report)) safeUi(() => ctx.ui.notify(line, "warning"));
}

/**
 * Write the run's lead reports to `lead-report.md` and return whether the write actually
 * landed on disk. `RunReport.hasLeadReports`/`leadReportPath` must reflect this, not merely
 * "there was something to write": a write that throws or is rejected (diagnostics sealed) used
 * to still report `hasLeadReports: true`, pointing the run summary at a file that was never
 * created (B4.7). Exported for direct unit coverage — exercising it through a full
 * `runOrchestration()` run would require standing up a whole dispatch pipeline for one write
 * call.
 */
export function writeLeadReportsDiagnostic(
	session: { writeDiagnostic(name: string, text: string): boolean; log(line: string): void },
	leadReports: string[],
): boolean {
	if (leadReports.length === 0) return false;
	try {
		const written = session.writeDiagnostic("lead-report.md", leadReports.join("\n\n---\n\n"));
		if (!written) {
			session.log("lead-report.md write failed: diagnostics writer rejected the write (sealed/closing)");
		}
		return written;
	} catch (err) {
		session.log(`lead-report.md write failed: ${(err as Error).message}`);
		return false;
	}
}

/**
 * Run the triage -> plan -> size -> confirm -> dispatch -> verify/escalate ->
 * finalize pipeline for an already-claimed session. Throws (rather than
 * returning) only for cancellation (`session.cancellation.throwIfCancelled`)
 * and unexpected errors — both left for `commands/orchestrate.ts`'s
 * try/catch to handle, exactly as they did inline.
 */
export async function runOrchestration(
	runId: string,
	cwd: string,
	parsed: OrchestrateArgs,
	adapter: Adapter,
	resolved: FullResolution,
	ctx: ExtensionContext,
	session: RunSession,
	claimed: RunContext<RunSession>,
	deps: RunOrchestrationDeps,
): Promise<RunOrchestrationResult> {
	// -----------------------------------------------------------------
	// LLM triage: auto-fill missing task_class / complexity / risk via
	// the cheapest available model. Skip when the user supplied all
	// three explicitly; skip silently on any failure and use defaults.
	// -----------------------------------------------------------------
	const missingTriage =
		parsed.taskClass === "implementation" && parsed.complexity === 5 && parsed.risk === "medium";
	let effectiveTaskClass = parsed.taskClass;
	let effectiveComplexity = parsed.complexity;
	let effectiveRisk = parsed.risk;
	let triageResult: TriageResult | null = null;
	const triageCost = { usd: 0 };

	if (missingTriage) {
		session.setPhase(`triage on ${shortName(adapter.implementation_fast?.model ?? "?")}`);
		triageResult = await deps.triageTask(runId, parsed.goal, cwd, ctx, claimed, triageCost, adapter);
		session.cancellation.throwIfCancelled();
		if (triageResult) {
			effectiveTaskClass = triageResult.task_class;
			effectiveComplexity = triageResult.complexity;
			effectiveRisk = triageResult.risk;
			const proceed = await Promise.race([session.cancellation.wait(), confirmStep(
				ctx,
				"Triage filled in missing values",
				`task_class: ${effectiveTaskClass}\n` +
					`complexity:  ${effectiveComplexity}\n` +
					`risk:        ${effectiveRisk}\n\n` +
					`Reasoning: ${triageResult.reasoning}\n\n` +
					`OK to plan with these values? (Cancel to abort)`,
				parsed.interactive,
			)]);
			if (!proceed) {
				const reason = parsed.interactive && !ctx.hasUI
					? "interactive confirmation unavailable after triage"
					: "cancelled by user after triage";
				session.log(reason);
				warnTelemetry(ctx, await deps.failRun(runId, reason, session.terminalTiming(), session.telemetryBaseline));
				ctx.ui.notify("Cancelled.", "info");
				return { kind: "aborted" };
			}
		} else {
			ctx.ui.notify(
				"Triage unavailable; using defaults task_class=implementation complexity=5 risk=medium. " +
					`Details: ${session.file("triage.stderr.log")}`,
				"warning",
			);
		}
	}

	// Step 1: Plan.
	session.setPhase("planning topology + route", false);
	let plan: PlanResponse;
	try {
		// Plan from the EFFECTIVE values. Passing `parsed.*` here threw away
		// the triage verdict the operator had just confirmed, so every
		// auto-triaged run planned as implementation/5/medium regardless.
		plan = await deps.planRun(runId, {
			goal: parsed.goal,
			taskClass: effectiveTaskClass,
			complexity: effectiveComplexity,
			risk: effectiveRisk,
			qualityFloor: parsed.qualityFloor,
			costAggressiveness: parsed.costAggressiveness,
		});
		session.cancellation.throwIfCancelled();
	} catch (err) {
		if (session.cancellation.isCancelled) throw err;
		session.log(`plan failed: ${(err as Error).message}`);
		warnTelemetry(ctx, await deps.failRun(runId, `plan failed: ${(err as Error).message}`, session.terminalTiming(), session.telemetryBaseline));
		ctx.ui.notify(`Plan failed: ${(err as Error).message}`, "error");
		return { kind: "aborted" };
	}

	// Lead sizing (method.json rules.lead_sizing): triage's complexity and
	// risk pick lead_small / lead / lead_large; the profile binds each to
	// a model through its tier. --lead-size overrides.
	const leadDecision: LeadSizeDecision = sizeLead({
		complexity: effectiveComplexity,
		risk: effectiveRisk,
		override: parsed.leadSize,
		source: parsed.leadSize ? "flag" : triageResult ? "triage" : missingTriage ? "heuristic" : "flag",
	});
	const leadModel = adapter[leadDecision.capability]?.model ?? adapter.lead?.model ?? "unknown";
	claimed.tags.lead_size = leadDecision.size;
	deps.recordEvent("lead_sized", {
		run_id: runId,
		complexity: effectiveComplexity,
		risk: effectiveRisk,
		band_size: leadDecision.bandSize,
		risk_floor_size: leadDecision.riskFloorSize,
		size: leadDecision.size,
		capability: leadDecision.capability,
		model: leadModel,
		source: leadDecision.source,
	});
	session.log(`lead size: ${leadDecision.size} → ${leadDecision.capability} on ${leadModel} (source: ${leadDecision.source})`);

	const needsArchitect = plan.topology.depth >= 2 && complexityNeedsArchitect(plan.complexity);
	const leadCount = Number.isFinite(plan.topology.leads)
		? Math.min(deps.maxLeads, Math.max(1, Math.trunc(plan.topology.leads)))
		: 1;
	const pipeline = [
		...(needsArchitect ? [`architect (${shortName(adapter.architect?.model ?? "?")})`] : []),
		`${leadCount} lead${leadCount > 1 ? "s" : ""} (${leadDecision.size}: ${shortName(leadModel)}) → workers (${shortName(adapter.worker?.model ?? "?")})`,
		`qa (${shortName(adapter.qa_agent?.model ?? "?")})`,
	].join(" → ");

	const hasUserOverride = Object.values(resolved.sources).some((s) => s !== "dynamic" && s !== "fallback");
	const planSummary = [
		`Plan ${plan.plan_id.slice(0, 12)} — "${parsed.goal.slice(0, 60)}${parsed.goal.length > 60 ? "…" : ""}"`,
		`triage:   ${effectiveTaskClass} / complexity ${effectiveComplexity} / risk ${effectiveRisk}`,
		`lead:     ${leadDecision.size} → ${shortName(leadModel)} (${leadDecision.source}; band ${leadDecision.bandSize}, risk floor ${leadDecision.riskFloorSize})`,
		`topology: ${plan.topology.shape} depth=${plan.topology.depth} leads=${plan.topology.leads} workers=${plan.topology.workers}`,
		`route:    ${plan.route.selected.capability} @ ${plan.route.selected.effort} (${plan.route.mode}); quality floor ${plan.effective_quality_floor}`,
		`pipeline: ${pipeline}`,
		`models (profile "${resolved.profileName}"${hasUserOverride ? "" : " is empty — cost-tier defaults; set with /orchestrator-models set"}):`,
		...formatAdapterTable(resolved).map((l) => `  ${l}`),
		`log:      ${session.file("run.log")}`,
	];
	ctx.ui.notify(planSummary.join("\n"), "info");
	session.log(planSummary.join("\n"));

	const proceed = await Promise.race([session.cancellation.wait(), confirmStep(
		ctx,
		"Dispatch this plan?",
		`${pipeline}\n\nOrchestrating stages use an inactivity limit plus an absolute ceiling (leaf dispatches use a fixed timeout); live progress shows above the editor.`,
		parsed.interactive,
	)]);
	session.cancellation.throwIfCancelled();
	if (!proceed) {
		const reason = parsed.interactive && !ctx.hasUI
			? "interactive confirmation unavailable before dispatch"
			: "cancelled by user at plan confirmation";
		session.log(reason);
		warnTelemetry(ctx, await deps.failRun(runId, reason, session.terminalTiming(), session.telemetryBaseline));
		ctx.ui.notify("Cancelled.", "info");
		return { kind: "aborted" };
	}

	// Step 2: Dispatch.
	const captureOpts: CaptureOpts = {
		runId,
		planId: plan.plan_id,
		taskClass: effectiveTaskClass,
		complexity: effectiveComplexity,
		risk: effectiveRisk,
		recommended: {
			capability: plan.route.recommended.capability,
			effort: plan.route.recommended.effort,
			verification_depth: plan.route.recommended.verification_depth,
		},
		mode: plan.route.mode,
	};

	deps.recordEvent("dispatch_plan_confirmed", {
		run_id: runId,
		plan_id: plan.plan_id,
		models: Object.fromEntries(Object.entries(adapter).map(([k, v]) => [k, v.model])),
		model_sources: resolved.sources,
		profile: resolved.profileName,
		log_dir: session.dir,
	});

	const dirtyBefore = gitDirtySnapshot(cwd);
	const headBefore = gitHead(cwd);
	// `workerResults` carries the parent-owned recon dispatches; they must stay
	// destructured here or the run stops billing them (plan Task 3).
	const { leadResults, workerResults, architectResult, skippedLeads, leadTasks } = await dispatchHierarchical(
		runId,
		plan.plan_id,
		parsed.goal,
		plan,
		adapter,
		ctx,
		claimed,
		leadDecision.capability,
		{
			dispatch: (tasks) => deps.dispatchParallel(cwd, runId, tasks, adapter, ctx, claimed),
			captureDispatchCost: deps.captureDispatchCost,
			maxLeads: deps.maxLeads,
			evidenceMaxChars: deps.reconEvidenceMaxChars,
		},
	);
	// dispatchHierarchical no longer hands back a mutable `escalationResults`
	// sink to push into (B4.6); the retry loop below owns its own.
	const escalationResults: DispatchResult[] = [];
	session.cancellation.throwIfCancelled();

	for (const r of leadResults) {
		if (r.exitCode !== 0) {
			ctx.ui.notify(
				`Lead ${r.taskId.replace(`${runId}-`, "")} failed (exit ${r.exitCode}): ${summarizeStderr(r.stderr, 300) || "(no output)"}\nSee ${session.file(`${r.taskId}.stderr.log`)}`,
				"warning",
			);
		}
	}

	// Step 3: Verification + escalation. We run QA against whatever files
	// were touched so far. If QA fails, escalate per policy Rule 1. The loop
	// is bounded by maxRetries.
	// `filesChanged` is scraped from dispatch prose, so a report that merely
	// MENTIONS README.md counted it as changed and sent QA after a phantom.
	// In a Git workspace, include both commits made since the run began and
	// dirty files whose content differs from the pre-run snapshot. Pre-existing
	// untracked scratch files a report merely names are not sent to QA. Every
	// round diffs against the same pre-run snapshot so the list is the
	// cumulative set QA must cover. `roundResults` are the dispatches that
	// just ran (used for the phantom log); `priorResults` widen the prose
	// fallback when git is unavailable so lead files aren't dropped on retry.
	let snapshotWarned = false;
	const changedSince = (
		label: string,
		roundResults: DispatchResult[],
		priorResults: DispatchResult[] = [],
	): string[] => {
		const roundClaimed = new Set(roundResults.flatMap((r) => r.filesChanged));
		const claimedFiles = new Set([...priorResults.flatMap((r) => r.filesChanged), ...roundClaimed]);
		const dirtyAfter = gitDirtySnapshot(cwd);
		if ((!dirtyBefore || !dirtyAfter) && !snapshotWarned) {
			snapshotWarned = true;
			session.log(
				`git snapshot unavailable (${!dirtyBefore ? "before" : "after"} ${label}); falling back to file paths scraped from dispatch prose`,
			);
		}
		const { changed, phantom, historyUnavailable } = changedFilesSinceRunStart(cwd, headBefore, dirtyBefore, claimedFiles, dirtyAfter);
		if (historyUnavailable) session.log(`${label}: git history unavailable; using claimed file paths`);
		const roundPhantom = phantom.filter((f) => roundClaimed.has(f));
		if (roundPhantom.length > 0) {
			session.log(
				`${label} named ${roundPhantom.length} file(s) not modified during this run; ignored: ${roundPhantom.join(", ")}`,
			);
		}
		return changed;
	};
	let allFiles = changedSince("lead phase", leadResults);

	// Run outcome from the leads' own STATUS lines. All leads blocked =>
	// BLOCKED: no QA, no PASS. Files git shows as changed while every
	// lead reports "Files Changed: None" belong to someone else (a
	// concurrent session) and are excluded from this run's QA scope.
	const leadStatuses = leadResults.map((r) => parseLeadStatus(r.stdout));
	const runOutcome = classifyRunOutcome({
		leadStatuses,
		succeededLeads: leadResults.filter((r) => r.exitCode === 0).length,
		leads: leadResults.length,
	});
	// Only when EVERY lead exited 0 and says it changed nothing: a lead that
	// failed, timed out or hit the spend cap may have edited files it never
	// got to report, and those must still be verified.
	const externalFiles = runOutcome === "blocked" ? [...allFiles] : externalChangeFiles(allFiles, leadResults);
	if (externalFiles.length > 0) {
		session.log(
			`${externalFiles.length} file(s) changed during the run but no lead reported changing them (likely a concurrent session); excluded from QA: ${externalFiles.join(", ")}`,
		);
		deps.recordEvent("external_changes_detected", { run_id: runId, files: externalFiles, lead_statuses: leadStatuses });
		allFiles = allFiles.filter((f) => !externalFiles.includes(f));
	}
	if (runOutcome === "blocked") {
		session.log(`all ${leadResults.length} lead(s) reported STATUS: blocked; skipping QA`);
		deps.recordEvent("run_blocked", { run_id: runId, leads: leadResults.length });
	}

	let retries = 0;
	let lastVerification: VerificationResult | null = null;
	const verificationResults: DispatchResult[] = [];
	while (runOutcome !== "blocked" && retries <= parsed.maxRetries) {
		if (allFiles.length > 0) {
			session.setPhase(
				retries === 0
					? `QA on ${allFiles.length} changed file(s) via ${shortName(adapter.qa_agent?.model ?? "?")}`
					: `QA retry ${retries + 1}/${parsed.maxRetries + 1} on ${allFiles.length} changed file(s)`,
			);
		}
		lastVerification = await runVerification(
			runId,
			plan.plan_id,
			allFiles,
			ctx,
			claimed,
			captureOpts,
			{
				dispatch: (tasks) => deps.dispatchParallel(cwd, runId, tasks, adapter, ctx, claimed),
				captureDispatchCost: deps.captureDispatchCost,
				recordOutcome: deps.recordOutcome,
			},
		);
		session.cancellation.throwIfCancelled();
		if (lastVerification.dispatch) verificationResults.push(lastVerification.dispatch);
		if (lastVerification.passed) break;

		session.log(`verification failed: ${lastVerification.failedChecks.join(", ") || "(unparsed)"}`);
		// Pair each lead's ORIGINAL dispatch task (goal/scope/model-routing
		// prompt) with its own outcome so planEscalation can retry with the
		// real prompt instead of the failed report (BUG 2), and can decide
		// per-lead whether a retry is warranted instead of only ever
		// retrying lead 0.
		const leadsForEscalation: EscalationLeadInput[] = leadResults.map((r) => {
			const task = leadTasks.find((t) => t.taskId === r.taskId) ?? { capability: r.capability, task: r.stdout, taskId: r.taskId };
			return { task, result: { exitCode: r.exitCode, stdout: r.stdout, filesChanged: r.filesChanged } };
		});
		const escalationTasks = planEscalation(
			lastVerification.failedChecks,
			leadsForEscalation,
			plan.complexity,
			plan.risk,
			retries,
			parsed.maxRetries,
		);
		if (escalationTasks.length === 0) break;

		// Re-run escalations with bumped models (handled by pickModel when
		// retryCount > 0 via adapter override). One or many retry tasks (one
		// per retried lead) run sequentially here; each still gets its own
		// adapter override for its own capability.
		const roundStart = escalationResults.length;
		for (const t of escalationTasks) {
			const binding = adapter[t.capability] ?? adapter.worker;
			const escalatedModel = pickModel(
				t.capability,
				adapter,
				t.retryCount ?? 0,
				plan.risk,
			);
			session.setPhase(
				`escalation retry ${retries + 1}: ${t.capability} on ${shortName(escalatedModel)} — failed checks: ${lastVerification.failedChecks.slice(0, 3).join(", ")}`,
			);
			const escalatedSize = leadSizeOf(t.capability);
			if (escalatedSize) {
				claimed.tags.lead_size = escalatedSize;
				deps.recordEvent("lead_sized", {
					run_id: runId,
					complexity: effectiveComplexity,
					risk: effectiveRisk,
					band_size: leadDecision.bandSize,
					risk_floor_size: leadDecision.riskFloorSize,
					size: escalatedSize,
					capability: t.capability,
					model: escalatedModel,
					source: "escalation",
					retry: t.retryCount ?? 1,
				});
			}
			const [retryResult] = await deps.dispatchParallel(
				cwd,
				runId,
				[t],
				{
					...adapter,
					[t.capability]: { ...binding, model: escalatedModel },
				},
				ctx,
				claimed,
			);
			// Capture settled usage before cancellation unwinds this round, just
			// as the architect, lead and QA paths do.
			// dispatchParallel returns [] for an empty task list; billing an
			// absent result wrote an all-"unknown" model_call for a dispatch
			// that never happened.
			if (retryResult) {
				await deps.captureDispatchCost(captureOpts, retryResult, claimed);
				escalationResults.push(retryResult);
			}
			session.cancellation.throwIfCancelled();
		}
		retries++;
		// The retry may have touched different files than the first lead
		// pass (or reverted some). Re-QA against the tree as it stands now
		// rather than the list computed before the loop, so escalation edits
		// are verified and a stale list can't fail the run forever. This also
		// runs after the final retry: finalize reports `allFiles`, and the
		// post-escalation tree is the state worth reporting.
		const thisRound = escalationResults.slice(roundStart);
		allFiles = changedSince(`escalation retry ${retries}`, thisRound, [
			...leadResults,
			...escalationResults.slice(0, roundStart),
		]).filter((f) => !externalFiles.includes(f));
		if (allFiles.length === 0) {
			// Nothing left to verify, but QA already failed this run. Re-running
			// against an empty list would return `skipped: true` and record the
			// run as passed; keep the failed verdict instead.
			session.log(
				`escalation retry ${retries} left no files differing from the pre-run tree; keeping the failed verification verdict`,
			);
			break;
		}
	}

	// Step 4: Finalize.
	// Total cost must cover EVERY dispatch this run paid for — architect,
	// parent-owned recon workers, and escalations included. Summing leads
	// alone under-reported spend, which is the one number the
	// cost-optimisation policy is judged on.
	const billedResults = collectBilledResults({
		architectResult,
		workerResults,
		leadResults,
		verificationResults,
		escalationResults,
	});
	// Leads' own subagent calls are billed too: they were the bulk of real spend
	// (ht-orch-1790256789245-1a3fms: $13.22 nested vs $1.56 reported).
	const nestedCost = billedResults.reduce((s, r) => s + (r.nestedCostUsd ?? 0), 0);
	const totalCost =
		triageCost.usd + billedResults.reduce((s, r) => s + r.costUsd, 0) + nestedCost;
	const succeededLeads = leadResults.filter((r) => r.exitCode === 0).length;
	// A run that dispatched nothing, or whose every lead failed, has not
	// verified anything — reporting the empty verification suite as PASS is
	// how phantom runs looked green.
	const dispatchOk = leadResults.length > 0 && succeededLeads > 0;
	const verificationSkipped = lastVerification?.skipped ?? false;
	const passedVerification = dispatchOk && (lastVerification?.passed ?? false);

	session.cancellation.throwIfCancelled();
	const telemetry = await deps.completeRun(runId, {
		success_rate: succeededLeads / Math.max(1, leadResults.length),
		verification_passed: passedVerification,
		blocked: runOutcome === "blocked",
		lead_statuses: leadStatuses,
		external_changes: externalFiles.length,
		total_cost_usd: totalCost,
		files_changed: allFiles,
		retries,
		models: Object.fromEntries(Object.entries(adapter).map(([k, v]) => [k, v.model])),
		log_dir: session.dir,
	}, session.terminalTiming(), session.telemetryBaseline);
	// Elapsed time for the run summary: the session's own monotonic clock (started when the
	// run's RunSession was constructed), not Date.now() minus a timestamp parsed out of the run
	// id -- the run id's third segment is not guaranteed to be a timestamp, and parsing it as one
	// used to silently produce NaN (B4.7).
	const elapsedMs = session.terminalTiming().elapsed_ms;


	// The lead's final report is the only place its reasoning, open
	// questions, and non-file results (audits, package lists, verdicts)
	// live. Always write it to disk; show it inline when there are no file
	// edits to speak for the run, or when the lead raised open items.
	const leadReports = leadResults
		.filter((r) => r.stdout.trim() || r.outcome === "timed_out" || r.outcome === "cancelled")
		.map((r) => {
			const interrupted = r.outcome === "timed_out" || r.outcome === "cancelled";
			const reason = r.outcome === "cancelled"
				? "cancelled"
				: r.timeoutReason ?? "unknown";
			const marker = interrupted ? `> UNVERIFIED PARTIAL WORK — ${reason}\n\n` : "";
			const report = r.stdout.trim() || r.interruption?.partialText || "(no assistant text captured)";
			return `${marker}### ${r.taskId.replace(`${runId}-`, "")}\n\n${report}`;
		});
	const leadReportWritten = writeLeadReportsDiagnostic(session, leadReports);
	const firstReport = leadResults.find((r) => r.exitCode === 0)?.stdout.trim() ?? "";
	const openItems = /##\s*Open items\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(firstReport)?.[1]?.trim();
	const showFullReport = allFiles.length === 0 && firstReport;
	const reportLines = showFullReport
		? firstReport.split("\n").slice(0, 40)
		: openItems && !/^(none|n\/a|-\s*none)/i.test(openItems)
			? openItems.split("\n").slice(0, 15)
			: [];
	const reportTruncated = showFullReport && firstReport.split("\n").length > 40;

	// The run FAILED because no lead succeeded, so name a lead first;
	// recon/architect failures are reported on their own lines.
	const firstFailure = leadResults.find((r) => r.exitCode !== 0) ?? billedResults.find((r) => r.exitCode !== 0);
	const firstFailureLine = firstFailure
		? `${firstFailure.taskId.replace(`${runId}-`, "")} exit ${firstFailure.exitCode}: ${summarizeStderr(firstFailure.stderr, 300) || "(no output)"}`
		: "(no dispatch attempted)";

	const report: RunReport = {
		runId,
		elapsedMs,
		blocked: runOutcome === "blocked",
		dispatchOk,
		succeededLeads,
		totalLeads: leadResults.length,
		skippedLeads,
		retries,
		filesChangedCount: allFiles.length,
		externalFilesCount: externalFiles.length,
		reconWorkersLine: summarizeReconWorkers(workerResults),
		verificationSkipped,
		passedVerification,
		totalCostUsd: totalCost,
		dispatchCount: billedResults.length + (triageCost.usd > 0 ? 1 : 0),
		nestedCostUsd: nestedCost,
		firstFailureLine,
		reportLines,
		showFullReport: Boolean(showFullReport),
		reportTruncated: Boolean(reportTruncated),
		hasLeadReports: leadReportWritten,
		leadReportPath: describeRunArtifact(session.file("lead-report.md")),
		runLogPath: describeRunArtifact(session.file("run.log")),
		stateRoot: deps.stateRoot,
		telemetryReport: telemetry,
	};
	return { kind: "completed", report };
}

/**
 * `/orchestrate` (B4.6): the triage -> plan -> size -> confirm -> dispatch ->
 * verify/escalate -> finalize flow. This is the single largest command in
 * the extension; it stays one function (mechanically wrapped for DI, not
 * restructured) because its steps share dozens of run-scoped locals (the
 * resolved adapter, plan, lead sizing decision, accumulating dispatch
 * results, the retry loop's escalation state, ...) that a confirmation gate
 * or a cancellation check can observe or short-circuit at almost any point.
 * Splitting it further into a `pipeline/run-orchestration.ts` that returns a
 * `RunReport` is future work flagged in docs/architecture-review.md B4.6;
 * doing it as a mechanical cut here (rather than an intentional redesign of
 * where each confirmation gate and cancellation check lives) would risk
 * silently reordering them.
 *
 * commands/* must not import index.ts. Every function this handler used to
 * call on index.ts's module scope (the resolved-adapter/session/telemetry
 * seams, the config constants) is a required field on `deps` instead; every
 * pure helper (git/lead-sizing/escalation/verdict-building/...) is imported
 * directly from its own module, same as any other caller.
 */
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";

import { parseArgs, usageText, type ModelOverrides } from "../core/args.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { complexityNeedsArchitect, type DispatchTask, type PlanResponse } from "../core/prompts.ts";
import { buildRunSummary } from "../core/report.ts";
import type { TriageResult } from "../core/triage.ts";
import { pickModel } from "../core/routing.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";
import { policyIdFor } from "../adapters/adapter-resolver.ts";
import { changedFilesSinceRunStart, gitDirtySnapshot, gitHead } from "../adapters/git-changes.ts";
import { formatAdapterTable, shortName, userLayerWarnings } from "../models.ts";
import { planEscalation, type EscalationLeadInput } from "../escalation.ts";
import { leadSizeOf, sizeLead, type LeadSizeDecision } from "../lead-sizing.ts";
import { classifyRunOutcome, externalChangeFiles, parseLeadStatus } from "../run-outcome.ts";
import { summarizeStderr } from "../dispatch/stderr-sink.ts";
import { confirmStep, safeUi } from "../run/ui-sink.ts";
import { describeRunArtifact, type RunSession, type RunTiming } from "../run/session.ts";
import type { RunContext, RunRegistry } from "../run/context.ts";
import { telemetryWarning, type FlushReport, type QueueStats } from "../record-queue.ts";
import {
	collectBilledResults,
	dispatchHierarchical,
	summarizeReconWorkers,
} from "../pipeline/hierarchy.ts";
import { runVerification, type VerificationResult } from "../pipeline/verify-loop.ts";

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

/** Surface a failed terminal drain to the operator; silent on success. */
function warnTelemetry(ctx: ExtensionContext, report: FlushReport): void {
	for (const line of telemetryWarning(report)) safeUi(() => ctx.ui.notify(line, "warning"));
}

export function registerOrchestrateCommand(pi: ExtensionAPI, deps: OrchestrateDeps): void {
	const usage = usageText(deps.profilesPath);
	pi.registerCommand("orchestrate", {
		description:
			"Plan and dispatch a hierarchical agent run. " +
			"Args: <goal> [--task-class T] [--complexity N] [--risk low|medium|high|critical] " +
			"[--profile NAME] [--lead-size small|standard|large] [--cheap ALIAS] [--mid ALIAS] [--premium ALIAS] [--frontier ALIAS] [--model <capability>=ALIAS] [--effort LEVEL] " +
			"[--quality-floor F] [--cost-aggressiveness C] [--max-retries R] [--interactive]\n\n" +
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
			// Step 0: resolve models. Done before anything is spent so a typo in
			// --premium or the override file stops the run here, not after a
			// 10-minute architect pass on the wrong model.
			// -----------------------------------------------------------------
			const resolved = await deps.resolveAdapter(ctx, parsed.models);
			const adapter = resolved.adapter;
			const hasUserOverride = Object.values(resolved.sources).some((s) => s !== "dynamic" && s !== "fallback");
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
							return;
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
					return;
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
					return;
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
					const claimed = new Set([...priorResults.flatMap((r) => r.filesChanged), ...roundClaimed]);
					const dirtyAfter = gitDirtySnapshot(cwd);
					if ((!dirtyBefore || !dirtyAfter) && !snapshotWarned) {
						snapshotWarned = true;
						session.log(
							`git snapshot unavailable (${!dirtyBefore ? "before" : "after"} ${label}); falling back to file paths scraped from dispatch prose`,
						);
					}
					const { changed, phantom, historyUnavailable } = changedFilesSinceRunStart(cwd, headBefore, dirtyBefore, claimed, dirtyAfter);
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
				if (leadReports.length > 0) {
					try {
						session.writeDiagnostic("lead-report.md", leadReports.join("\n\n---\n\n"));
					} catch {
						/* best-effort */
					}
				}
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

				const { text: summaryText, succeeded } = buildRunSummary({
					runId,
					elapsedMs: Date.now() - Number(runId.split("-")[2]),
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
					hasLeadReports: leadReports.length > 0,
					leadReportPath: describeRunArtifact(session.file("lead-report.md")),
					runLogPath: describeRunArtifact(session.file("run.log")),
					stateRoot: deps.stateRoot,
					telemetryReport: telemetry,
				});
				session.log(summaryText);
				safeUi(() => ctx.ui.notify(summaryText, succeeded ? "info" : "warning"));
				postRunMessage(pi, runId, succeeded ? "completed" : "failed", summaryText, totalCost);
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

/**
 * `/orchestrate` (B4.6): the triage -> plan -> size -> confirm -> dispatch ->
 * verify/escalate -> finalize flow lives in `pipeline/run-orchestration.ts`
 * (`runOrchestration`); this module owns arg parsing, model resolution,
 * session/registry setup, and the run's single cleanup point (the
 * cancellation/crash catch block, `session.close()`/`release()`/`finish()`
 * in `finally`). It also owns the final summary's `notify`/`postRunMessage`
 * pair: `runOrchestration` returns a `RunReport` (core/report.ts) rather than
 * posting anything itself, so this is the one place that decides how (and
 * whether) a settled run's outcome reaches the user.
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
import type { DispatchTask, PlanResponse } from "../core/prompts.ts";
import { buildRunSummary } from "../core/report.ts";
import type { TriageResult } from "../core/triage.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";
import { policyIdFor } from "../adapters/adapter-resolver.ts";
import { formatAdapterTable, userLayerWarnings } from "../models.ts";
import { safeUi } from "../run/ui-sink.ts";
import type { RunSession, RunTiming } from "../run/session.ts";
import type { RunContext, RunRegistry } from "../run/context.ts";
import type { FlushReport, QueueStats } from "../record-queue.ts";
import { runOrchestration, warnTelemetry, type RunOrchestrationDeps } from "../pipeline/run-orchestration.ts";

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
				const orchestrationDeps: RunOrchestrationDeps = {
					triageTask: deps.triageTask,
					planRun: deps.planRun,
					recordEvent: deps.recordEvent,
					recordOutcome: deps.recordOutcome,
					captureDispatchCost: deps.captureDispatchCost,
					dispatchParallel: deps.dispatchParallel,
					completeRun: deps.completeRun,
					failRun: deps.failRun,
					maxLeads: deps.maxLeads,
					reconEvidenceMaxChars: deps.reconEvidenceMaxChars,
					stateRoot: deps.stateRoot,
				};
				const result = await runOrchestration(runId, cwd, parsed, adapter, resolved, ctx, session, claimed, orchestrationDeps);
				if (result.kind === "completed") {
					const { text: summaryText, succeeded } = buildRunSummary(result.report);
					session.log(summaryText);
					safeUi(() => ctx.ui.notify(summaryText, succeeded ? "info" : "warning"));
					postRunMessage(pi, runId, succeeded ? "completed" : "failed", summaryText, result.report.totalCostUsd);
				}
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

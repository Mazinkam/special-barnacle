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
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OrchestrateArgs } from "../core/args.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { detectLiveExtensionTree, detectOutOfTreeChanges, outOfTreeChangesSummaryLine, type LiveTreeSeams } from "../core/live-tree.ts";
import { complexityNeedsArchitect, type DispatchTask, type PlanResponse } from "../core/prompts.ts";
import type { RunReport } from "../core/report.ts";
import type { TriageResult } from "../core/triage.ts";
import { loadEfficiencyControls } from "../efficiency-flags.ts";
import { pickModel } from "../core/routing.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";
import { changedFilesSinceRunStart, gitDirtySnapshot, gitHead } from "../adapters/git-changes.ts";
import { formatAdapterTable, shortName } from "../models.ts";
import { planEscalation, type EscalationLeadInput } from "../escalation.ts";
import { leadSizeOf, sizeLead, type LeadSizeDecision } from "../lead-sizing.ts";
import { classifyRunOutcome, externalChangeFiles, parseLeadStatus, qaScopeEvidenceFor } from "../run-outcome.ts";
import { summarizeStderr } from "../dispatch/stderr-sink.ts";
import { confirmStep, safeUi } from "../run/ui-sink.ts";
import { describeRunArtifact, type RunTiming } from "../run/session.ts";
import type { RunContext, RunSessionLike } from "../run/context.ts";
import { telemetryWarning, type FlushReport, type QueueStats } from "../record-queue.ts";
import { collectBilledResults, dispatchHierarchical, summarizeReconWorkers } from "./hierarchy.ts";
import { collectLeadAttempts, formatLeadAttemptLines } from "./lead-attempts.ts";
import { runVerification, type VerificationResult } from "./verify-loop.ts";
import {
	buildLiveQaSummaryField,
	candidateOwnedFilesForLiveQa,
	liveQaCostRowsHaveUnknownCost,
	liveQaKnownCostUsd,
	recordLiveQaStageResult,
	runLiveQaStage,
	type RunLiveQaStageResult,
} from "../live-qa-stage.ts";

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
		run: RunContext<RunSessionLike> | null,
		costSink: { usd: number },
		adapter: Adapter,
	): Promise<TriageResult | null>;
	planRun(runId: string, opts: PlanOptions): Promise<PlanResponse>;
	recordEvent(event: string, payload: Record<string, unknown>): void;
	recordOutcome(outcome: Record<string, unknown>): void;
	captureDispatchCost(opts: CaptureOpts, result: DispatchResult, run: RunContext<RunSessionLike> | null): Promise<void>;
	dispatchParallel(
		cwd: string,
		runId: string,
		tasks: DispatchTask[],
		adapter: Adapter,
		ctx: ExtensionContext,
		run: RunContext<RunSessionLike> | null,
	): Promise<DispatchResult[]>;
	completeRun(runId: string, summary: Record<string, unknown>, timing?: RunTiming, since?: QueueStats): Promise<FlushReport>;
	failRun(runId: string, error: string, timing?: RunTiming, since?: QueueStats): Promise<FlushReport>;
	/** Ceiling on the topology's requested lead count (config.ts's `maxLeads`). */
	maxLeads: number;
	/** Rule-2 recon evidence packet budget (config.ts's `reconEvidenceMaxChars`). */
	reconEvidenceMaxChars: number;
	/** `<STATE_ROOT>`, threaded through onto the returned `RunReport`'s ledger line. */
	stateRoot: string;
	/** The `## Provided context` block from `--context`/`--with-last-reply` (docs/architecture-review.md C6), built
	 *  by `commands/orchestrate.ts` from files it already read; `""` when neither flag was given. */
	providedContext: string;
	/**
	 * Phase 3 opt-in Forge live-QA stage: env passed straight to `runLiveQaStage`'s
	 * `loadLiveQaConfig` (never logged); index.ts's caller supplies `process.env`, tests supply a
	 * fixture env. Only read when `parsed.liveQa`.
	 */
	env: Record<string, string | undefined>;
	/** Records a single model-usage row (the Python-side economics ledger); used to record the
	 *  live-QA stage's own cost rows, independent of `recordOutcome`'s outcome row. */
	recordModelCall: (metric: Record<string, unknown>) => void;
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
 * A6/N2: the real (impure) `git rev-parse --show-toplevel` / realpath edge `detectLiveExtensionTree`
 * (core/live-tree.ts) needs. Kept tiny and inlined here — never exported, never unit-tested
 * directly — specifically so core/live-tree.ts's own tests never need a real repo: they inject
 * their own `LiveTreeSeams` fixtures instead. Any failure here (not a git work tree, `git`
 * missing, permission error) resolves to `null`, which `detectLiveExtensionTree` already treats
 * as "skip silently".
 */
const REAL_LIVE_TREE_SEAMS: LiveTreeSeams = {
	gitToplevel: (path) => {
		try {
			const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf-8", timeout: 10_000 });
			if (result.status !== 0) return null;
			const top = result.stdout.trim();
			return top || null;
		} catch {
			return null;
		}
	},
	realpath: (path) => {
		try {
			return realpathSync(path);
		} catch {
			return null;
		}
	},
};

/**
 * A6/N2: at run start (before any cost is spent), warn — loudly, but never block — when the
 * orchestrator extension currently executing this run lives inside the very repo the run is
 * about to dispatch leads against. A lead editing files under the extension's own directory
 * would be rewriting the code driving this run mid-flight. `cwd` is the run's own working
 * directory; the extension's own directory is derived from this module's `import.meta.url` (this
 * file lives at `<extension dir>/pipeline/run-orchestration.ts`). Any git/realpath failure is
 * swallowed here too, as a second line of defense on top of `detectLiveExtensionTree`'s own
 * `null`-on-failure contract — this is a warn-only feature, never worth failing (or even noisily
 * logging) a run over.
 */
/** Read only bounded head/tail of a lead's own diagnostic event log. Tool arguments are
 * retained on tool_execution_start; assistant prose and nested subagent prompts are not tool
 * execution evidence. Open without following symlinks, and fail closed on missing logs. */
function leadToolCommands(session: RunSessionLike, taskId: string): string[] {
	const safeId = taskId.replace(/[^a-zA-Z0-9._-]+/g, "_");
	let fd: number;
	try {
		fd = openSync(session.file(`${safeId}.events.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch { return []; }
	try {
		const size = fstatSync(fd).size;
		const window = 128 * 1024;
		const chunks: string[] = [];
		for (const [start, length] of size <= window * 2
			? [[0, size]]
			: [[0, window], [size - window, window]]) {
			const buffer = Buffer.alloc(length);
			const bytes = readSync(fd, buffer, 0, length, start);
			const text = buffer.toString("utf8", 0, bytes);
			chunks.push(start === 0 ? text.slice(0, text.lastIndexOf("\n") + 1) : text.slice(text.indexOf("\n") + 1));
		}
		const commands: string[] = [];
		for (const line of chunks.join("\n").split("\n")) {
			if (!line || line.length > 20_000) continue;
			try {
				const event = JSON.parse(line) as { type?: unknown; toolName?: unknown; args?: { command?: unknown } };
				if (event.type === "tool_execution_start" && (event.toolName === "bash" || event.toolName === "functions.bash") && typeof event.args?.command === "string") {
					commands.push(event.args.command);
					if (commands.length > 20) commands.shift(); // Keep the most recent calls in the bounded head/tail.
				}
			} catch { /* incomplete or malformed JSONL is not evidence */ }
		}
		return commands;
	} catch { return []; }
	finally { closeSync(fd); }
}

function warnIfLiveExtensionTree(
	cwd: string,
	ctx: ExtensionContext,
	session: RunSessionLike,
	runId: string,
	recordEvent: RunOrchestrationDeps["recordEvent"],
): void {
	try {
		const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const match = detectLiveExtensionTree(cwd, extensionDir, REAL_LIVE_TREE_SEAMS);
		if (!match) return;
		const message =
			`Live extension tree: this run's repo (${match.runRoot}) contains the orchestrator extension ` +
			`currently executing it (${match.extensionRoot}). A dispatched lead editing files under the ` +
			"extension's own directory can rewrite the code driving this very run. Continuing — this is a warning, not a block.";
		session.log(message);
		safeUi(() => ctx.ui.notify(message, "warning"));
		recordEvent("live_extension_tree", { run_id: runId, repo_root: match.runRoot, extension_dir: match.extensionRoot });
	} catch {
		// Warn-only feature; any unexpected failure skips silently.
	}
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
	session: RunSessionLike,
	claimed: RunContext<RunSessionLike>,
	deps: RunOrchestrationDeps,
): Promise<RunOrchestrationResult> {
	// A6/N2: warn (never block) when this run's own repo contains the orchestrator extension
	// currently executing it — before any cost is spent, alongside the other run-start setup below.
	warnIfLiveExtensionTree(cwd, ctx, session, runId, deps.recordEvent);

	// -----------------------------------------------------------------
	// A1 review fix: `scoped_leads`/`file_ownership`/`recon_before_architect` are efficiency
	// switches this modular pipeline does not implement (core/records.ts's `scopedPhaseReports`
	// doc; all three default OFF in method.json) — only the pre-unification index.ts hierarchy code
	// still does. Flip one on and this pipeline silently runs with it disabled instead of doing what
	// the operator asked; surface that loudly at run start (before any cost is spent) rather than
	// let the run's behavior quietly not match its own config, and continue with default (switch
	// disabled) behavior — this is a config mismatch warning, not a reason to abort the run.
	// -----------------------------------------------------------------
	const unsupportedSwitchNames = ["scoped_leads", "file_ownership", "recon_before_architect"];
	const { enabled: enabledSwitches } = loadEfficiencyControls(deps.env);
	const unsupportedEnabled = enabledSwitches.filter((name) => unsupportedSwitchNames.includes(name));
	if (unsupportedEnabled.length > 0) {
		ctx.ui.notify(
			`Efficiency switch(es) enabled in config but not supported by this pipeline: ${unsupportedEnabled.join(", ")}. ` +
				"Continuing with default (switch disabled) behavior — the run will NOT get the effect these switches promise.",
			"warning",
		);
		deps.recordEvent("efficiency_switch_unsupported", { run_id: runId, switches: unsupportedEnabled });
	}

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
	const repoRoot = resolve(cwd);
	const { leadResults, workerResults, architectResult, skippedLeads, leadTasks, resumedLeadTaskIds, retriedLeadTaskIds, resumedAttemptResults } = await dispatchHierarchical(
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
			repoRoot,
			providedContext: deps.providedContext,
			// A3: an in-wave-dependent lead that still fails after C3's transient-resume pass gets one
			// more in-wave recovery attempt instead of blocking every dependent wave until the post-QA
			// escalation loop recovers it too late for those waves to ever be dispatched. Gated on
			// `--max-retries` > 0, the same knob that gates the post-QA escalation loop below.
			inWaveRecovery: parsed.maxRetries > 0,
			// C3: a lead's resume prompt needs "files changed since it started", using
			// the same git dirty-snapshot machinery `changedSince` below uses for QA
			// scope — a snapshot taken right before the lead's (wave's) dispatch,
			// diffed against the tree at resume-decision time.
			markFiles: () => ({ head: gitHead(cwd), dirty: gitDirtySnapshot(cwd) }),
			filesChangedSince: (mark, claimedFiles) => {
				const { head, dirty } = mark as { head: string | null; dirty: Map<string, string> | null };
				return changedFilesSinceRunStart(cwd, head, dirty, claimedFiles).changed;
			},
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
	let gitObservationAvailable = dirtyBefore !== null;
	const changedSince = (
		label: string,
		roundResults: DispatchResult[],
		priorResults: DispatchResult[] = [],
	): string[] => {
		const roundClaimed = new Set(roundResults.flatMap((r) => r.filesChanged));
		const claimedFiles = new Set([...priorResults.flatMap((r) => r.filesChanged), ...roundClaimed]);
		const dirtyAfter = gitDirtySnapshot(cwd);
		if (!dirtyAfter) gitObservationAvailable = false;
		if ((!dirtyBefore || !dirtyAfter) && !snapshotWarned) {
			snapshotWarned = true;
			session.log(
				`git snapshot unavailable (${!dirtyBefore ? "before" : "after"} ${label}); falling back to file paths scraped from dispatch prose`,
			);
		}
		const { changed, phantom, historyUnavailable } = changedFilesSinceRunStart(cwd, headBefore, dirtyBefore, claimedFiles, dirtyAfter);
		if (historyUnavailable) {
			gitObservationAvailable = false;
			session.log(`${label}: git history unavailable; using claimed file paths`);
		}
		const roundPhantom = phantom.filter((f) => roundClaimed.has(f));
		if (roundPhantom.length > 0) {
			session.log(
				`${label} named ${roundPhantom.length} file(s) not modified during this run; ignored: ${roundPhantom.join(", ")}`,
			);
		}
		return changed;
	};
	let allFiles = changedSince("lead phase", leadResults);

	// A6/N2: compare claimed paths against git-observed paths, and inspect actual lead tool
	// calls for a foreign cd. Warn-only: never alters `allFiles`/QA scope. When git observation
	// is unavailable, prose/claims cannot establish a missing local edit.
	const leadClaimedFiles = candidateOwnedFilesForLiveQa(leadResults);
	// `cwd` can be a subdirectory; git's changed paths are relative to the repository root.
	// Comparing cd targets to cwd would mislabel an in-repo cd as another worktree.
	const gitRoot = REAL_LIVE_TREE_SEAMS.gitToplevel(cwd);
	const runTreeRoot = gitRoot ? (REAL_LIVE_TREE_SEAMS.realpath(gitRoot) ?? gitRoot) : repoRoot;
	const outOfTreeChanges = detectOutOfTreeChanges({
		claimedFiles: leadClaimedFiles,
		observedFiles: gitObservationAvailable ? allFiles : null,
		leadTexts: leadResults.map((r) => r.stdout),
		toolTexts: leadResults.flatMap((r) => leadToolCommands(session, r.taskId)),
		runRoot: runTreeRoot,
		realpath: REAL_LIVE_TREE_SEAMS.realpath,
	});
	if (outOfTreeChanges.detected) {
		const line = outOfTreeChangesSummaryLine(outOfTreeChanges) ?? "changes outside run tree: (unknown)";
		session.log(`out-of-tree changes: ${line}`);
		safeUi(() => ctx.ui.notify(`Warning: ${line} — lead activity not reflected by corresponding changes in this run's own repo.`, "warning"));
		deps.recordEvent("out_of_tree_changes", {
			run_id: runId,
			foreign_path: outOfTreeChanges.foreignPath,
			claimed_files: outOfTreeChanges.claimedFiles,
		});
	}

	// Run outcome from the leads' own STATUS lines. All leads blocked =>
	// BLOCKED: no QA, no PASS. Files git shows as changed while every
	// lead reports "Files Changed: None" belong to someone else (a
	// concurrent session) and are excluded from this run's QA scope.
	const leadStatuses = leadResults.map((r) => parseLeadStatus(r.stdout));
	// Computed here (not only in Step 4's finalize) so the retry loop below can
	// skip QA entirely when no lead succeeded, instead of sending it to verify
	// a failed lead's partial, unreported changes (docs/architecture-review.md
	// C4: the old QA ran on 29 files a failed lead had left behind, decided it
	// was in the wrong directory, ran `find / -iname ...`, and hung until the
	// 20-minute timeout).
	const succeededLeads = leadResults.filter((r) => r.exitCode === 0).length;
	const dispatchOk = leadResults.length > 0 && succeededLeads > 0;
	const runOutcome = classifyRunOutcome({
		leadStatuses,
		succeededLeads,
		leads: leadResults.length,
	});
	// Only when EVERY lead exited 0 and says it changed nothing: a lead that
	// failed, timed out or hit the spend cap may have edited files it never
	// got to report, and those must still be verified.
	const externalFiles = runOutcome === "blocked" ? [...allFiles] : externalChangeFiles(allFiles, qaScopeEvidenceFor(leadResults));
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
	} else if (!dispatchOk) {
		session.log(`no lead succeeded (0/${leadResults.length}); skipping QA on the failed lead(s)' partial work`);
		deps.recordEvent("qa_skipped_no_lead_succeeded", { run_id: runId, leads: leadResults.length });
	}

	let retries = 0;
	let lastVerification: VerificationResult | null = null;
	const verificationResults: DispatchResult[] = [];
	// A6/A4: at most ONE QA re-run per run, triggered only by the QA dispatch itself timing out
	// (never by QA completing and reporting a failing check). Tracked outside the while loop so a
	// later QA dispatch (after an escalation retry) that also times out does not get a second
	// re-run — it just ends the run with the TIMED OUT verdict, same as the first re-run failing.
	let qaRerunUsed = false;
	while (runOutcome !== "blocked" && dispatchOk && retries <= parsed.maxRetries) {
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
			repoRoot,
		);
		session.cancellation.throwIfCancelled();
		if (lastVerification.dispatch) verificationResults.push(lastVerification.dispatch);
		if (lastVerification.passed) break;

		if (lastVerification.timedOut || lastVerification.providerStall) {
			const qaFailure = lastVerification.providerStall ? "provider_stall" : "timeout";
			if (qaRerunUsed) {
				// No completed QA verdict exists; never escalate on a provider failure.
				session.log(`QA dispatch ${qaFailure} again after the re-run; ending without a verification verdict (no escalation)`);
				break;
			}
			qaRerunUsed = true;
			session.log(`QA dispatch ${qaFailure}; re-running QA once with scoped-test-command guidance`);
			deps.recordEvent(qaFailure === "timeout" ? "qa_timed_out_rerun" : "qa_provider_stall_rerun", { run_id: runId, attempt: 1 });
			session.setPhase(`QA re-run (attempt 1) on ${allFiles.length} changed file(s) after ${qaFailure}`);
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
				repoRoot,
				{ attempt: 1, reason: lastVerification.providerStall ? "provider_stall" : "timeout" },
			);
			session.cancellation.throwIfCancelled();
			if (lastVerification.dispatch) verificationResults.push(lastVerification.dispatch);
			if (lastVerification.passed) break;
			if (lastVerification.timedOut || lastVerification.providerStall) {
				// The re-run also failed before a verdict — finish now, no escalation.
				session.log(`QA re-run also ${lastVerification.providerStall ? "hit provider_stall" : "timed out"}; ending without a verification verdict (no escalation)`);
				break;
			}
			// The re-run completed and reported a real (non-timeout) verdict; fall through to the
			// normal failure/escalation handling below using this re-run's `lastVerification`.
		}

		session.log(`verification failed: ${lastVerification.failedChecks.join(", ") || "(unparsed)"}`);
		// Pair each lead's ORIGINAL dispatch task (goal/scope/model-routing
		// prompt) with its own outcome so planEscalation can retry with the
		// real prompt instead of the failed report (BUG 2), and can decide
		// per-lead whether a retry is warranted instead of only ever
		// retrying lead 0. `task` stays the lead's ORIGINAL prompt/taskId
		// (from `leadTasks`) so planEscalation keeps building `<lead>-retry-N`
		// off the original taskId — but `result` must be the lead's LATEST
		// attempt so far (this round's own `escalationResults`, if any retry
		// has already run for this lead, else the original `leadResults`
		// entry), not the stale original exit code/filesChanged/report a
		// second-round selection or feedback section would otherwise see.
		const leadAttemptsSoFar = collectLeadAttempts(leadResults, resumedAttemptResults, escalationResults, retriedLeadTaskIds);
		const latestResultByLeadTaskId = new Map(leadAttemptsSoFar.map((l) => [l.leadTaskId, l.attempts[l.attempts.length - 1]!.result]));
		const leadsForEscalation: EscalationLeadInput[] = leadResults.map((r) => {
			const task = leadTasks.find((t) => t.taskId === r.taskId) ?? { capability: r.capability, task: r.stdout, taskId: r.taskId };
			const latest = latestResultByLeadTaskId.get(r.taskId) ?? r;
			return { task, result: { exitCode: latest.exitCode, stdout: latest.stdout, filesChanged: latest.filesChanged } };
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

	// A lead that failed and was later retried (C3's transient resume, or an escalation retry after
	// a failed verification, taskId `<lead>-retry-N`) is judged by its FINAL attempt from here on —
	// `leadResults` alone only ever holds the ONE result used to decide that lead's status, which
	// for a resumed lead is already its final attempt, but for an escalated lead is still its
	// FAILED first attempt. `succeededLeads`/`dispatchOk`/`leadStatuses`/`runOutcome` above are
	// deliberately left as computed (from the initial `leadResults`) for the QA-gating decisions
	// already made by this point; everything from here on reports the run's actual final outcome.
	const leadAttempts = collectLeadAttempts(leadResults, resumedAttemptResults, escalationResults, retriedLeadTaskIds);
	const leadAttemptLines = formatLeadAttemptLines(runId, leadAttempts);
	const finalSucceededLeads = leadAttempts.filter((l) => l.succeeded).length;
	const finalDispatchOk = leadAttempts.length > 0 && finalSucceededLeads > 0;
	const finalLeadStatuses = leadAttempts.map((l) => parseLeadStatus(l.final.stdout));
	const finalRunOutcome = classifyRunOutcome({
		leadStatuses: finalLeadStatuses,
		succeededLeads: finalSucceededLeads,
		leads: leadAttempts.length,
	});

	// Step 4: Finalize.
	// Total cost must cover EVERY dispatch this run paid for — architect,
	// parent-owned recon workers, and escalations included. Summing leads
	// alone under-reported spend, which is the one number the
	// cost-optimisation policy is judged on.
	const billedResults = collectBilledResults({
		architectResult,
		workerResults,
		leadResults,
		resumedAttemptResults,
		verificationResults,
		escalationResults,
	});
	// Leads' own subagent calls are billed too: they were the bulk of real spend
	// (ht-orch-1790256789245-1a3fms: $13.22 nested vs $1.56 reported).
	const nestedCost = billedResults.reduce((s, r) => s + (r.nestedCostUsd ?? 0), 0);
	let totalCost =
		triageCost.usd + billedResults.reduce((s, r) => s + r.costUsd, 0) + nestedCost;
	// `passedVerification` accepts EITHER `dispatchOk` (the pre-retry-loop gate QA actually ran
	// under) or `finalDispatchOk` (a lead that failed initially but succeeded on a later retry): a
	// lead-attempts accounting quirk in either direction must never make an otherwise-passing QA
	// verdict read as unverified.
	const verificationSkipped = lastVerification?.skipped ?? false;
	const passedVerification = (lastVerification?.passed ?? false) && (dispatchOk || finalDispatchOk);
	// The QA dispatch itself timing out (inactivity/absolute ceiling) is a distinct state from QA
	// completing and reporting failing checks — the summary must say so instead of folding both
	// into a plain FAIL (docs/architecture-review.md C5).
	// Both failures are unverified dispatches, never code/check FAIL; preserve
	// their distinct causes in the report instead of labeling a provider error a timeout.
	const verificationTimedOut = lastVerification?.dispatch?.outcome === "timed_out";
	const verificationProviderStall = lastVerification?.providerStall === true && !verificationTimedOut;
	const failedChecks = lastVerification?.failedChecks ?? [];

	// -----------------------------------------------------------------
	// Step 3.5: Phase 3 opt-in Forge live-QA stage. Runs at most once, only when explicitly
	// requested (--live-qa / --live-qa-scope), and only once the run is not blocked, dispatch
	// succeeded, and the generic QA gate above passed — a live-QA runner is never spawned against a
	// candidate whose generic verification already failed, was skipped, or never ran. Never
	// escalated or retried on failure; only recorded.
	//
	// `changedFiles` handed to the live-QA checkpoint is deliberately the CANDIDATE-OWNED set
	// (files this run's own leads/implementers claimed changing, `filesChanged`) — never `allFiles`
	// (the broader git-dirty-detection set the generic QA gate above uses, which can also include a
	// dirty path nobody in this run claimed touching). `escalationResults` is included too: a
	// retried lead's own claimed files are just as much this run's own work as the first pass's.
	// -----------------------------------------------------------------
	let liveQaStageResult: RunLiveQaStageResult | null = null;
	let liveQaNotRunReason: string | null = null;
	if (parsed.liveQa) {
		if (finalRunOutcome === "blocked") {
			liveQaNotRunReason = "run was blocked";
		} else if (!finalDispatchOk) {
			liveQaNotRunReason = "dispatch did not succeed";
		} else if (!passedVerification) {
			liveQaNotRunReason = verificationSkipped
				? "generic verification was skipped (no files changed)"
				: "generic verification failed";
		} else {
			session.setPhase(
				`live QA: requesting Forge focused run${parsed.liveQaAdapterId ? ` (adapter ${parsed.liveQaAdapterId})` : ""}`,
			);
			liveQaStageResult = await runLiveQaStage({
				request: { requested: true, adapterId: parsed.liveQaAdapterId, scope: parsed.liveQaScope },
				env: deps.env,
				cwd,
				runId,
				changedFiles: candidateOwnedFilesForLiveQa([...leadResults, ...escalationResults]),
				cancellation: session.cancellation,
				onLine: (line) => session.log(`[live-qa] ${line}`),
			});
			// The settled runner's own outcome/cost rows must be recorded BEFORE cancellation unwinds
			// — see `recordLiveQaStageResult`'s doc comment.
			recordLiveQaStageResult(liveQaStageResult, {
				recordOutcome: deps.recordOutcome,
				recordModelCall: deps.recordModelCall,
				throwIfCancelled: () => session.cancellation.throwIfCancelled(),
			});
		}
	}
	const liveQaCostRowsForRun = liveQaStageResult?.costRows ?? [];
	// Added exactly once here; `recordModelCall` above feeds the Python-side economics ledger
	// independently (its own `record_id`-keyed dedup) — this JS-side `totalCost` never reads from
	// that ledger, so adding the same number here is not a double count of anything.
	totalCost += liveQaKnownCostUsd(liveQaCostRowsForRun);
	const liveQaHasUnknownCost = liveQaCostRowsHaveUnknownCost(liveQaCostRowsForRun);

	session.cancellation.throwIfCancelled();
	const telemetry = await deps.completeRun(runId, {
		success_rate: finalSucceededLeads / Math.max(1, leadAttempts.length),
		verification_passed: passedVerification,
		blocked: finalRunOutcome === "blocked",
		lead_statuses: finalLeadStatuses,
		external_changes: externalFiles.length,
		total_cost_usd: totalCost,
		files_changed: allFiles,
		retries,
		models: Object.fromEntries(Object.entries(adapter).map(([k, v]) => [k, v.model])),
		log_dir: session.dir,
		// Phase 3 opt-in Forge live-QA stage (T1): the `live_qa` key itself is present ONLY when
		// `--live-qa`/`--live-qa-scope` was given — a run that never requested it gets the exact
		// pre-Phase-3 summary shape, not a `{requested: false}` placeholder key.
		...buildLiveQaSummaryField(parsed.liveQa, liveQaStageResult, liveQaNotRunReason),
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
	// Prefer the final successful attempt's stdout — a lead retried after a failed dispatch or a
	// failed verification speaks through its LAST attempt, not a discarded failed one.
	const firstReport = leadAttempts.find((l) => l.succeeded)?.final.stdout.trim() ?? "";
	const openItems = /##\s*Open items\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(firstReport)?.[1]?.trim();
	const showFullReport = allFiles.length === 0 && firstReport;
	const reportLines = showFullReport
		? firstReport.split("\n").slice(0, 40)
		: openItems && !/^(none|n\/a|-\s*none)/i.test(openItems)
			? openItems.split("\n").slice(0, 15)
			: [];
	const reportTruncated = showFullReport && firstReport.split("\n").length > 40;

	// The run FAILED because no lead succeeded, so name a lead first — but only a lead whose FINAL
	// attempt failed; a lead retried to success is not a failure to report. If no lead finally
	// failed, fall back to the existing recon/architect/verification billedResults logic, but only
	// when the run didn't finally succeed (`!finalDispatchOk`) — a lead-level success must never be
	// overridden by naming an unrelated billed dispatch as "the" failure.
	const firstFailedLeadAttempt = leadAttempts.find((l) => !l.succeeded)?.final;
	const firstFailure = firstFailedLeadAttempt ?? (finalDispatchOk ? undefined : billedResults.find((r) => r.exitCode !== 0));
	const firstFailureLine = firstFailure
		? `${firstFailure.taskId.replace(`${runId}-`, "")} exit ${firstFailure.exitCode}: ${summarizeStderr(firstFailure.stderr, 300) || "(no output)"}`
		: "(no dispatch attempted)";

	const report: RunReport = {
		runId,
		elapsedMs,
		blocked: finalRunOutcome === "blocked",
		dispatchOk: finalDispatchOk,
		// The verdict line must not read "NOT RUN (no lead succeeded)" for a run where QA actually
		// ran (it only ever does while `dispatchOk`, the pre-loop gate, held) even if `finalDispatchOk`
		// later reads false for an unrelated reason — see `VerificationVerdictInput.dispatchOk`.
		verificationDispatchOk: dispatchOk || finalDispatchOk,
		succeededLeads: finalSucceededLeads,
		totalLeads: leadResults.length,
		skippedLeads,
		retries,
		leadAttemptLines,
		resumedLeadIds: resumedLeadTaskIds.map((id) => id.replace(`${runId}-`, "")),
		filesChangedCount: allFiles.length,
		externalFilesCount: externalFiles.length,
		reconWorkersLine: summarizeReconWorkers(workerResults),
		verificationSkipped,
		passedVerification,
		verificationTimedOut,
		verificationProviderStall,
		failedChecks,
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
		outOfTreeChangesLine: outOfTreeChangesSummaryLine(outOfTreeChanges),
		...(parsed.liveQa ? { liveQa: { stage: liveQaStageResult, notRunReason: liveQaNotRunReason, hasUnknownCost: liveQaHasUnknownCost } } : {}),
	};
	return { kind: "completed", report };
}

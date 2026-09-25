/**
 * LLM triage (B4.6): dispatch the cheapest configured model to pre-classify
 * a goal's task_class/complexity/risk before the real `plan_run`, so the
 * operator isn't asked to fill in boilerplate the model can infer cheaply
 * (Rule 3, "cheapest sufficient", applied to the orchestrator's own front
 * end).
 *
 * Takes the dispatching run's `RunContext` plus a small deps object
 * (dispatch function, cost-capture function) instead of importing
 * dispatch/child-process.ts's `runSubagentProcess`/index.ts's
 * `captureDispatchCost` directly — pipeline/* must not import index.ts, and
 * this keeps the module testable with a fake dispatcher.
 */
import type { ExtensionContext } from "@humain/terminal";

import type { Adapter } from "../adapters/adapter-resolver.ts";
import type { DispatchSession, runSubagentProcess } from "../dispatch/child-process.ts";
import { summarizeStderr } from "../dispatch/stderr-sink.ts";
import type { CaptureOpts, DispatchResult } from "../core/records.ts";
import { parseTriageResponse, TRIAGE_PROMPT, type TriageResult } from "../core/triage.ts";
import type { RunContext } from "../run/context.ts";

/** The dispatch + billing seams `triageTask` needs; index.ts's caller supplies the real ones. */
export interface TriageDeps {
	runProcess: (
		opts: Omit<Parameters<typeof runSubagentProcess>[0], "env"> & { env?: () => NodeJS.ProcessEnv },
	) => ReturnType<typeof runSubagentProcess>;
	captureDispatchCost: (
		opts: CaptureOpts,
		result: DispatchResult,
		run: RunContext<DispatchSession> | null,
	) => Promise<void>;
}

/**
 * Classify the goal with the cheapest capability.
 *
 * `costSink` accumulates what triage spent. Triage is logged as run overhead under
 * the same run identifier even when classification fails.
 */
export async function triageTask(
	runId: string,
	goal: string,
	cwd: string,
	ctx: ExtensionContext,
	/** The claiming run's context, threaded explicitly (B4.4) so triage's dispatch
	 *  and billing land on the right run instead of an implicit "active run" read. */
	run: RunContext<DispatchSession> | null,
	costSink: { usd: number },
	adapter: Adapter,
	deps: TriageDeps,
): Promise<TriageResult | null> {
	const cheapest =
		adapter["implementation_fast"] ??
		adapter["worker"] ??
		adapter["scout"] ??
		Object.values(adapter)[0];
	if (!cheapest || !cheapest.model) {
		console.warn("[orchestrator] triage skipped: adapter has no dispatchable model");
		return null;
	}

	const prompt = TRIAGE_PROMPT + "\n" + goal + "\n\nJSON:\n";
	try {
		const r = await deps.runProcess({
			cwd,
			agentName: "orch-implementation-fast",
			task: prompt,
			model: cheapest.model,
			ctx,
			taskId: "triage",
			label: "triage",
			session: run?.session,
		});
		costSink.usd += r?.costUsd ?? 0;
		// Bill the dispatch before parsing: malformed/empty classifier output still used tokens.
		await deps.captureDispatchCost(
			{ runId, planId: "triage", taskClass: "triage", complexity: 5, risk: "medium",
				recommended: { capability: "implementation_fast", effort: "low", verification_depth: "none" }, mode: "triage" },
			{ taskId: "triage", capability: "triage", model: r.model ?? cheapest.model,
				exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, usage: r.usage,
				durationMs: r.durationMs, costUsd: r.costUsd, costReported: r.costReported, stopReason: r.stopReason, filesChanged: [] },
			run,
		);
		if (r.exitCode !== 0) {
			console.warn(`[orchestrator] triage exited ${r.exitCode}: ${summarizeStderr(r.stderr || r.rawStdout, 400) || "(no output)"}`);
			return null;
		}
		// The child's final assistant message is the JSON verdict.
		const text = r.finalText || r.stdout;
		if (!text.trim()) {
			console.warn("[orchestrator] triage produced no assistant text");
			return null;
		}
		return parseTriageResponse(text);
	} catch (err) {
		console.warn(`[orchestrator] triage failed: ${(err as Error).message}`);
		return null;
	}
}

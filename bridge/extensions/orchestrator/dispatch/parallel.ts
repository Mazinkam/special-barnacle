/**
 * Parallel subagent dispatch (B4.5 step 5 — extracted from index.ts).
 *
 * `dispatchParallel` fans a batch of `DispatchTask`s out to their own
 * `humain-terminal --mode json --no-session` subprocesses (via `runProcess`,
 * normally `dispatch/child-process.ts`'s `runSubagentProcess`) with bounded
 * concurrency, retries a codex quota failure once on its Bedrock twin, and
 * turns each settled `SubagentProcessResult` into a `DispatchResult`.
 *
 * dispatch/* must not import index.ts. `recordEvent`/`runProcess` are
 * required fields on `deps` (no default referencing an index.ts singleton);
 * index.ts's re-exported `dispatchParallel` supplies its own real
 * `recordEvent`/`runSubagentProcess`/`maxConcurrentDispatches` as defaults so
 * every existing call site there is unchanged.
 */
import type { ExtensionContext, SubagentUsageStats } from "@humain/terminal";

import type { Adapter } from "../adapters/adapter-resolver.ts";
import { diffDirtySnapshots, gitDirtySnapshot, parseFilesChanged } from "../adapters/git-changes.ts";
import type { DispatchResult } from "../core/records.ts";
import { formatTaskPrompt, type DispatchTask } from "../core/prompts.ts";
import { METHOD, type AliasTable } from "../models.ts";
import { bedrockFallbackFor } from "../provider-fallback.ts";
import { failoverConfig } from "./failover-policy.ts";
import { dispatchWithFailover } from "./failover.ts";
import { ModelHealth } from "../run/model-health.ts";
import { usableModels, type Candidate } from "../adapters/model-router.ts";
import type { RunContext } from "../run/context.ts";
import { summarizeStderr } from "./stderr-sink.ts";
import type { DispatchSession } from "./child-process.ts";
import { runSubagentProcess } from "./child-process.ts";

export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

// Capabilities whose persona file is not simply `orch-<capability>`. Without
// these, the derived name missed the installed persona and the child silently
// ran with the DEFAULT system prompt and the default (unrestricted) tool set —
// e.g. capability "lead" looked for "orch-lead" while the shipped persona is
// "orchestrator-lead", so the lead lost its subagent fan-out instructions.
// Review capabilities intentionally collapse onto the reviewer personas so the
// read-only tool allow-list in their frontmatter keeps applying.
const CAPABILITY_AGENT_ALIASES: Record<string, string> = {
	// Every lead size (lead_small / lead / lead_large) runs the same
	// orchestrator-lead persona: no write/edit tools, delegation rule, STATUS line.
	...Object.fromEntries(Object.values(METHOD.rules.lead_sizing.sizes).map((cap) => [cap, "orchestrator-lead"])),
	...METHOD.capability_personas,
};

export function agentNameFor(capability: string): string {
	return CAPABILITY_AGENT_ALIASES[capability] ?? `orch-${capability.replace(/_/g, "-")}`;
}

function sumUsage(a: SubagentUsageStats, b: SubagentUsageStats): SubagentUsageStats {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		contextTokens: Math.max(a.contextTokens, b.contextTokens),
		turns: a.turns + b.turns,
	};
}

/**
 * One task for `dispatchParallel()`. Declared standalone rather than derived
 * from `recon.ts`'s `ReconTaskPlan`: the bridge's dispatch contract is the
 * general case and must not depend on the pure Rule-2 recon module, which is
 * only one of its callers. `ReconTaskPlan` is structurally assignable here
 * (its `tools` is required, this one's is optional), and the annotation on
 * `reconTasks` in `dispatchHierarchical()` fails the typecheck if that ever
 * stops being true.
 */
export async function dispatchParallel(
	cwd: string,
	runId: string,
	tasks: DispatchTask[],
	adapter: Adapter,
	ctx: ExtensionContext,
	/** The dispatching run's context (session/tags/aliasTable), or null outside a
	 *  run (e.g. a bare test call). Threaded explicitly (B4.4) instead of reading
	 *  the module-level runRegistry singleton from inside the dispatch path. */
	run: RunContext<DispatchSession> | null,
	depth: number,
	deps: {
		recordEvent: (event: string, payload: Record<string, unknown>) => void;
		/**
		 * `env` stays optional here even though dispatch/child-process.ts's own
		 * `runSubagentProcess` requires it (B4.5 hardening): the real binding is
		 * always index.ts's re-exported wrapper, which supplies `config.ts`'s
		 * `liveEnv` default; this module never has to build one itself.
		 */
		runProcess: (
			opts: Omit<Parameters<typeof runSubagentProcess>[0], "env"> & { env?: () => NodeJS.ProcessEnv },
		) => ReturnType<typeof runSubagentProcess>;
		/** Alias table for the codex -> Bedrock quota fallback; defaults to `run`'s. */
		aliasTable?: AliasTable | null;
		/** Bounded concurrency ceiling; the real caller passes its configured value. */
		maxConcurrentDispatches: number;
		/** Test seam / non-run caller routing; production normally uses RunContext. */
		candidates?: Record<string, Candidate[]>;
		modelHealth?: ModelHealth;
		/** Test seam for retry waits; production waits cancelably on the run session. */
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<DispatchResult[]> {
	if (tasks.length === 0) return [];

	// Drain queued user messages ONCE at the start of this batch. Every task in
	// the batch sees the same messages; the next dispatchParallel call picks up
	// anything that arrived during or after this one. Draining mid-batch would
	// split messages across two prompts in non-obvious ways.
	const session = run?.session ?? null;
	const recipient = tasks.length === 1
		? `${tasks[0].capability}:${tasks[0].taskId.replace(`${runId}-`, "")}`
		: `${tasks.length} ${tasks[0].capability} tasks`;
	const userMessages = session ? session.drainMessages(recipient) : [];

	const taskInputs = tasks.map((t) => {
		// Adapter lookups can return undefined if the dynamic adapter
		// didn't surface every capability (rare but seen during plan-time
		// routing handoffs). Fall back to any binding we can find, then to
		// explicit "unknown" so the dispatch never dereferences undefined.
		const binding =
			adapter[t.capability] ??
			adapter.worker ??
			adapter.scout ??
			Object.values(adapter).find((v) => v && typeof v === "object") ??
			{ model: "unknown" };
		return {
			agent: agentNameFor(t.capability),
			task: formatTaskPrompt(t, runId, userMessages),
			model: binding.model ?? "unknown",
			effort: binding.effort,
			tools: t.tools,
			cwd,
			_capability: t.capability,
			_taskId: t.taskId,
			_retryOf: t.retryOf,
			_retryCount: t.retryCount,
		};
	});

	// Direct Pi subprocess fan-out — replaces `createSubagentTool(cwd).execute()`.
	// See the comment on `runSubagentProcess` (dispatch/child-process.ts) for why
	// we don't use the human-facing subagent tool from inside an extension
	// handler. Each worker task becomes its own
	// `humain-terminal --mode json --no-session` subprocess that writes JSON
	// events to stdout; runSubagentProcess parses the assistant `message_end`
	// for model + usage + cost.
	const health = deps.modelHealth ?? run?.modelHealth ?? new ModelHealth();
	const settled = await mapWithConcurrency(taskInputs, deps.maxConcurrentDispatches, async (input) => {
		const shortId = (input._taskId ?? "").replace(`${runId}-`, "") || input._capability || "task";
		const aliasTable = deps.aliasTable === undefined ? (run?.aliasTable ?? null) : deps.aliasTable;
		const declared = deps.candidates?.[input._capability] ?? run?.candidates?.[input._capability];
		const twin = aliasTable ? bedrockFallbackFor(input.model, aliasTable) : null;
		const models = declared ? usableModels(declared, input.model) : [input.model, ...(twin ? [twin] : [])];
		let changedFiles: string[] = [];
		const cancellableSleep = async (ms: number) => {
			if (deps.sleep) return deps.sleep(ms);
			if (!session) return;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { remove(); resolve(); }, ms);
				const remove = session.cancellation.onCancel(() => { clearTimeout(timer); remove(); resolve(); });
			});
		};
		deps.recordEvent("dispatch_started", { run_id: runId, task_id: input._taskId, capability: input._capability, agent: input.agent, model: input.model, retry_of: input._retryOf });
		try {
			const fo = await dispatchWithFailover({ taskId: input._taskId ?? `unknown-${runId}`, capability: input._capability ?? "unknown", prompt: input.task }, models, {
				runAttempt: async (model, prompt, attempt, spentBeforeUsd) => {
					const attemptTaskId = attempt === 1 || !input._taskId ? input._taskId : `${input._taskId}-fallback-${attempt - 1}`;
					deps.recordEvent("dispatch_attempt_started", { run_id: runId, task_id: input._taskId, attempt, model });
					const result = await deps.runProcess({
						cwd: input.cwd, agentName: input.agent, task: prompt, model, effort: input.effort,
						taskId: attemptTaskId, label: attempt === 1 ? shortId : `${shortId}↻${attempt - 1}`,
						capability: input._capability, depth, tools: input.tools, ctx, session: session ?? undefined,
						spendCapOffsetUsd: spentBeforeUsd,
					});
					changedFiles = result.personaCanMutate ? parseFilesChanged(result.stdout) : [];
					return result;
				},
				readEvents: (result) => result.rawStdout.split(/\r?\n/),
				snapshot: () => gitDirtySnapshot(input.cwd),
				changedSince: (snapshot) => diffDirtySnapshots(snapshot as Map<string, string> | null, gitDirtySnapshot(input.cwd), changedFiles).changed,
				sleep: cancellableSleep,
				health,
				isCancelled: () => session?.cancellation.isCancelled ?? false,
				recordEvent: (event, payload) => deps.recordEvent(event, { run_id: runId, ...payload }),
				log: (line) => session?.log(line),
				config: failoverConfig(),
				redact: (text) => text,
				effortDropped: (model) => Boolean(input.effort && !declared?.find((candidate) => candidate.model === model)?.effortControl),
			});
			const attempts = fo.attempts.map((attempt) => attempt.result);
			const aggregateUsage = attempts.reduce((sum, result) => sumUsage(sum, result.usage), {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
				} as SubagentUsageStats);
			const r = {
				...fo.result,
				model: fo.finalModel,
				usage: aggregateUsage,
				costUsd: attempts.reduce((sum, result) => sum + result.costUsd, 0),
				nestedCostUsd: attempts.reduce((sum, result) => sum + (result.nestedCostUsd ?? 0), 0),
				durationMs: attempts.reduce((sum, result) => sum + result.durationMs, 0),
				costReported: attempts.every((result) => result.costReported),
			};
			fo.attempts.forEach(({ model, result, record }, index) => deps.recordEvent("dispatch_finished", {
				run_id: runId, task_id: input._taskId, capability: input._capability, model,
				exit_code: result.exitCode, duration_ms: result.durationMs, cost_usd: result.costUsd,
				nested_cost_usd: result.nestedCostUsd, turns: result.usage.turns, stop_reason: result.stopReason,
				log_dir: session?.dir, attempt: index + 1, failure_class: record.cls,
				superseded_by_fallback: index < fo.attempts.length - 1,
			}));
			return {
				taskId: input._taskId ?? `unknown-${runId}`,
				capability: input._capability ?? "unknown",
				model: r.model,
				exitCode: r.exitCode,
				stdout: r.stdout,
				stderr: r.exitCode === 0 ? r.stderr : summarizeStderr(r.stderr || r.rawStdout, 2_000) || "(no output)",
				usage: r.usage,
				durationMs: r.durationMs,
				costUsd: r.costUsd,
				...(r.nestedCostUsd > 0 ? { nestedCostUsd: r.nestedCostUsd } : {}),
				costReported: r.costReported,
				stopReason: r.stopReason,
				outcome: r.outcome,
				timeoutReason: r.timeoutReason,
				toolInFlight: r.toolInFlight,
				interruption: r.interruption,
				filesChanged: r.personaCanMutate ? parseFilesChanged(r.stdout) : [],
				...(input.effort ? { effort: input.effort } : {}),
			};
		} catch (err) {
			return {
				taskId: input._taskId ?? `unknown-${runId}`, capability: input._capability ?? "unknown", model: input.model,
				exitCode: -1, stdout: "", stderr: (err as Error).message,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				durationMs: 0, costUsd: 0, costReported: false, filesChanged: [],
			};
		}
	});

	return settled;
}

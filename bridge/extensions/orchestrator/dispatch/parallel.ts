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
import { parseFilesChanged } from "../adapters/git-changes.ts";
import type { DispatchResult } from "../core/records.ts";
import { formatTaskPrompt, type DispatchTask } from "../core/prompts.ts";
import { METHOD, type AliasTable } from "../models.ts";
import { bedrockFallbackFor, isQuotaError } from "../provider-fallback.ts";
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
		runProcess: typeof runSubagentProcess;
		/** Alias table for the codex -> Bedrock quota fallback; defaults to `run`'s. */
		aliasTable?: AliasTable | null;
		/** Bounded concurrency ceiling; the real caller passes its configured value. */
		maxConcurrentDispatches: number;
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
	const settled = await mapWithConcurrency(taskInputs, deps.maxConcurrentDispatches, async (input) => {
		// `a || b ?? c` is a SyntaxError — mixing || and ?? needs explicit parens.
		// Left unparenthesised this failed to load the whole extension.
		const shortId =
			(input._taskId ?? "").replace(`${runId}-`, "") || input._capability || "task";
		// Queued, not awaited: the child starts now and the record lands in the next
		// batch. Routed through `deps` so tests can observe it; the default binding
		// is the same `recordEvent`, so the queuing behaviour is unchanged.
		deps.recordEvent("dispatch_started", {
			run_id: runId,
			task_id: input._taskId,
			capability: input._capability,
			agent: input.agent,
			model: input.model,
			retry_of: input._retryOf,
		});
		try {
			const runOn = (model: string, taskId: string | undefined, label: string) => deps.runProcess({
				cwd: input.cwd,
				agentName: input.agent,
				task: input.task,
				model,
				effort: input.effort,
				taskId,
				label,
				capability: input._capability,
				depth,
				// Still no *hardcoded* tools override here — that is what previously
				// granted reviewers write access and stripped tools the personas need.
				// `input.tools` is per-task and set by exactly one producer,
				// `planReconTasks()`, which pins recon to read-only. Every other task
				// leaves it undefined, and runSubagentProcess then falls back to the
				// persona's own frontmatter allow-list, so persona policy still wins
				// everywhere it did before.
				tools: input.tools,
				ctx,
				// Explicit (B4.4): this dispatch's progress/diagnostics belong to the
				// run whose RunContext was passed in, not whatever the module-level
				// registry currently holds.
				session: session ?? undefined,
			});
			let r = await runOn(input.model, input._taskId, shortId);
			// Codex first, Bedrock fallback: a quota/rate-limit failure on an
			// openai-codex model is retried ONCE on the same model id under
			// amazon-bedrock. Both attempts are billed (usage summed).
			const table = deps.aliasTable === undefined ? (run?.aliasTable ?? null) : deps.aliasTable;
			// Only a genuine provider rejection qualifies: not a timeout, a user
			// cancel, or a spend-cap stop (those would re-run finished work), and
			// only when stderr (not the model's own prose) names the quota.
			// `session` above is `run?.session` captured once at this call's start;
			// unlike the old `session ?? ACTIVE_RUN` fallback, there is no live global
			// left to re-read here. That fallback only ever mattered if the module
			// global changed after `session` was captured but before this line ran —
			// impossible in practice, since only one run is ever active and this
			// closure only runs inside that same run's own dispatch flow.
			const eligible = r.exitCode !== 0 && r.outcome !== "timed_out" && r.outcome !== "cancelled" &&
				r.stopReason !== "spend_cap" && !session?.cancellation.isCancelled;
			const twin = eligible && table && isQuotaError(r.stderr) ? bedrockFallbackFor(input.model, table) : null;
			if (twin) {
				deps.recordEvent("dispatch_finished", {
					run_id: runId, task_id: input._taskId, capability: input._capability, model: r.model ?? input.model,
					exit_code: r.exitCode, duration_ms: r.durationMs, cost_usd: r.costUsd, turns: r.usage.turns,
					stop_reason: r.stopReason, log_dir: session?.dir, superseded_by_fallback: true,
				});
				deps.recordEvent("route_degraded", {
					run_id: runId, task_id: input._taskId, capability: input._capability,
					from_model: input.model, to_model: twin, reason: "provider_quota",
					detail: summarizeStderr(r.stderr, 240),
				});
				session?.log(`${input._taskId}: ${input.model} hit a provider quota; retrying once on ${twin}`);
				const first = r;
				const second = await runOn(twin, input._taskId ? `${input._taskId}-fallback` : undefined, `${shortId}↻`);
				r = {
					...second,
					usage: sumUsage(first.usage, second.usage),
					costUsd: first.costUsd + second.costUsd,
					nestedCostUsd: (first.nestedCostUsd ?? 0) + (second.nestedCostUsd ?? 0),
					costReported: first.costReported && second.costReported,
					durationMs: first.durationMs + second.durationMs,
				};
			}
			deps.recordEvent("dispatch_finished", {
				run_id: runId,
				task_id: input._taskId,
				capability: input._capability,
				model: r.model ?? input.model,
				exit_code: r.exitCode,
				duration_ms: r.durationMs,
				cost_usd: r.costUsd,
				nested_cost_usd: r.nestedCostUsd,
				turns: r.usage.turns,
				stop_reason: r.stopReason,
				log_dir: session?.dir,
			});
			return {
				taskId: input._taskId ?? `unknown-${runId}`,
				capability: input._capability ?? "unknown",
				model: r.model ?? input.model,
				exitCode: r.exitCode,
				stdout: r.stdout,
				// On a non-zero exit HT often fails before emitting any event (bad
				// argv, provider auth), so stderr is the only diagnostic. When even
				// that is empty, fall back to the raw event stream so the failure is
				// explainable in metrics.jsonl instead of a silent zero.
				stderr:
					r.exitCode === 0 ? r.stderr : summarizeStderr(r.stderr || r.rawStdout, 2_000) || "(no output)",
				usage: r.usage,
				durationMs: r.durationMs,
				costUsd: r.costUsd,
				...((r.nestedCostUsd ?? 0) > 0 ? { nestedCostUsd: r.nestedCostUsd } : {}),
				costReported: r.costReported,
				stopReason: r.stopReason,
				outcome: r.outcome,
				timeoutReason: r.timeoutReason,
				interruption: r.interruption,
				// parseFilesChanged scrapes the child's prose, so a read-only reviewer
				// or QA agent would "report" every path it merely mentioned.
				filesChanged: r.personaCanMutate ? parseFilesChanged(r.stdout) : [],
				...(input.effort ? { effort: input.effort } : {}),
			};
		} catch (err) {
			return {
				taskId: input._taskId ?? `unknown-${runId}`,
				capability: input._capability ?? "unknown",
				model: input.model ?? "unknown",
				exitCode: -1,
				stdout: "",
				stderr: (err as Error).message,
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
					cost: 0, contextTokens: 0, turns: 0,
				},
				durationMs: 0,
				costUsd: 0,
				costReported: false,
				filesChanged: [],
			};
		}
	});

	return settled;
}

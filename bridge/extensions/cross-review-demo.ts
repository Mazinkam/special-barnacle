/**
 * Three-way cross-review demo — illustrates the "review each other" pattern
 * using whatever models HT actually has dispatchable today. Drop-in for
 * kimi/glm/humain-m3 once those providers are registered.
 *
 * Run with: /cross-review-demo <some file or module to review>
 *
 * Topology: 3 implementers in parallel, each reviewed by a DIFFERENT model
 * than the one that wrote it. Final synthesis by the lead.
 *
 * This is the demonstration of the orchestrator's "review each other" pattern.
 * Same topology works for kimi/glm/humain-m3 once those providers are
 * registered — just add entries to MODEL_POOL below.
 */

import { spawn } from "node:child_process";
import { createSubagentTool, type SubagentDetails } from "@core/tools/subagent.ts";
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";

// Three-way cross-review using the human-node models the user asked for.
// Each implementer is reviewed by a model from a DIFFERENT family than theirs.
// This demonstrates the "review each other" pattern the orchestrator enables —
// the same topology works for any registered model set (kimi, glm, claude, gpt).
const MODEL_POOL = [
	{
		label:        "glm-5.2",
		implementer:  "humain-node/glm-5.2",
		reviewer:     "humain-node/kimi-k3",              // different family (Zhipu vs Moonshot)
	},
	{
		label:        "kimi-k3",
		implementer:  "humain-node/kimi-k3",
		reviewer:     "humain-node/humain-m3-research-preview", // different family (Moonshot vs HUMAIN)
	},
	{
		label:        "humain-m3-research-preview",
		implementer:  "humain-node/humain-m3-research-preview",
		reviewer:     "humain-node/glm-5.2",              // different family (HUMAIN vs Zhipu)
	},
];

const SYNTHESIS_MODEL = "humain-node/kimi-k3";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cross-review-demo", {
		description:
			"Demo: 3 models implement a change in parallel; each is reviewed by a different model. " +
			"Args: <target-file-or-module>",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("Usage: /cross-review-demo <file-or-module>", "warning");
				return;
			}

			const cwd = process.cwd();
			const runId = `cross-review-${Date.now()}`;
			const tool = createSubagentTool(cwd);

			// Phase 1: 3 implementers in parallel.
			ctx.ui.notify(`Phase 1: dispatching ${MODEL_POOL.length} implementers in parallel…`, "info");
			const implTasks = MODEL_POOL.map((m, i) => ({
				agent: "orch-implementation-strong",
				task: [
					`[cross-review-demo run=${runId} model=${m.label}]`,
					`Implement the requested change to: ${target}`,
					"Stay narrowly scoped. Run typecheck/tests if applicable.",
					"Output format: ## Completed / ## Files Changed / ## Verification",
				].join("\n"),
				model: m.implementer,
				cwd,
			}));

			const implDetails = (await tool.execute(
				runId + "-impl",
				{ tasks: implTasks },
				undefined,
				undefined,
				ctx,
			)) as SubagentDetails;

			// Phase 2: each implementation is reviewed by a DIFFERENT model.
			ctx.ui.notify("Phase 2: cross-reviewing each implementation…", "info");
			const reviewTasks = MODEL_POOL.map((m, i) => {
				const impl = implDetails.results[i];
				const implText = impl.messages
					.filter((msg: any) => msg.role === "assistant")
					.map((msg: any) => (typeof msg.content === "string" ? msg.content : ""))
					.join("\n");
				return {
					agent: "orch-technical-review",
					task: [
						`[cross-review-demo run=${runId} reviewer=${m.label}]`,
						`Review the following implementation of changes to: ${target}`,
						"Read the diff/files. Output: ## Files Reviewed / ## Critical / ## Warnings / ## Verdict (PASS|FAIL|PASS-WITH-WARNINGS).",
						"Be specific. If you can't reproduce locally, say so.",
						"",
						"--- Implementation under review ---",
						implText.slice(0, 6000),
					].join("\n"),
					model: m.reviewer,
					cwd,
				};
			});

			const reviewDetails = (await tool.execute(
				runId + "-review",
				{ tasks: reviewTasks },
				undefined,
				undefined,
				ctx,
			)) as SubagentDetails;

			// Phase 3: lead synthesizes.
			ctx.ui.notify("Phase 3: synthesis…", "info");
			const digest = MODEL_POOL.map((m, i) => {
				const impl = implDetails.results[i];
				const rev = reviewDetails.results[i];
				return `### ${m.label}: implementer=${m.implementer} reviewer=${m.reviewer} impl_cost=$${impl.usage.cost.toFixed(4)} review_cost=$${rev.usage.cost.toFixed(4)}\n\nImplementation:\n${impl.messages.filter((msg: any) => msg.role === "assistant").map((msg: any) => typeof msg.content === "string" ? msg.content : "").join("\n").slice(0, 2000)}\n\nReview verdict:\n${rev.messages.filter((msg: any) => msg.role === "assistant").map((msg: any) => typeof msg.content === "string" ? msg.content : "").join("\n").slice(0, 1000)}`;
			}).join("\n\n---\n\n");

			const synthTasks = [
				{
					agent: "orchestrator-lead",
					task: [
						`[cross-review-demo run=${runId} phase=synthesis]`,
						`Synthesize the final verdict for changes to: ${target}`,
						"Three implementations and three reviews are below. Identify consensus, dissent, and the strongest implementation.",
						"Output format: ## Consensus / ## Dissent / ## Strongest / ## Final Verdict (PASS|PASS-WITH-WARNINGS|FAIL) / ## Recommended follow-ups.",
						"",
						"--- Implementation + review digest ---",
						digest,
					].join("\n"),
					model: SYNTHESIS_MODEL,
					cwd,
				},
			];

			const synthDetails = (await tool.execute(
				runId + "-synth",
				{ tasks: synthTasks },
				undefined,
				undefined,
				ctx,
			)) as SubagentDetails;

			// Per-phase cost attribution. Capture each dispatch's `model_call`
			// record via the Python CLI so the orchestrator's history sees them.
			const pyScript = "/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator/scripts/cross_review_capture.py";
			for (const [phase, details] of [
				["impl", implDetails],
				["review", reviewDetails],
				["synth", synthDetails],
			] as const) {
				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					const m = MODEL_POOL[i];
					const label = phase === "synth" ? "synthesis" : m?.label ?? `i${i}`;
					const spawn_args = JSON.stringify({
						event: "model_call",
						run_id: runId,
						task_id: `${runId}-${phase}-${label}`,
						task_class: "cross_review_demo",
						complexity: 5,
						risk: "medium",
						role: phase === "review" ? "technical_review" : "implementation_strong",
						capability_class: phase === "review" ? "technical_review" : "implementation_strong",
						agent_runtime: "humain-terminal",
						provider: (r.model ?? "").split("/")[0],
						model: r.model,
						effort: "standard",
						verification_depth: "targeted",
						input_tokens: r.usage.input,
						cached_input_tokens: r.usage.cacheRead,
						cache_write_tokens: r.usage.cacheWrite,
						output_tokens: r.usage.output,
						cost_usd: r.usage.cost,
						cost_source: r.usage.cost > 0 ? "reported" : "estimated-from-reported-tokens",
						result: r.exitCode === 0 ? "pass" : "fail",
						stop_reason: r.stopReason,
					});
					const child = spawn("python3", ["-m", "orchestrator.cli", "metric", spawn_args], {
						env: {
							...process.env,
							CODING_AGENT_RUNTIME: "humain-terminal",
							PYTHONPATH: "/Users/abdulkarim/.local/share/agent-skills/hierarchical-agent-orchestrator",
						},
						stdio: "ignore",
					});
					child.unref();
				}
			}

			const totalCost =
				[implDetails, reviewDetails, synthDetails].flatMap((d) => d.results).reduce((s, r) => s + r.usage.cost, 0);

			ctx.ui.notify(
				[
					`Cross-review complete.`,
					`run_id: ${runId}`,
					`phases: 3 (implement, review, synthesize)`,
					`disptaches: ${MODEL_POOL.length} × 2 + 1 = ${MODEL_POOL.length * 2 + 1}`,
					`total cost: $${totalCost.toFixed(4)}`,
				].join("\n"),
				"info",
			);

			// Show the synthesis output.
			const synthText = synthDetails.results[0]?.messages
				?.filter((m: any) => m.role === "assistant")
				?.map((m: any) => (typeof m.content === "string" ? m.content : ""))
				?.join("\n") ?? "(no synthesis output)";
			ctx.ui.notify(synthText.slice(0, 4000), "info");
		},
	});
}

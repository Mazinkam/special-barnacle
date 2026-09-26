/**
 * `orchestrator_status` tool (B4.6): read-only status of the current
 * `/orchestrate` run, if any. Takes the `RunRegistry` as a parameter instead
 * of importing index.ts's singleton — tools/* must not import index.ts.
 */
import { Type } from "typebox";

import type { ExtensionAPI } from "@humain/terminal";

import { formatOrchestratorStatus } from "../run/board.ts";
import type { RunRegistry } from "../run/context.ts";
import type { RunSession } from "../run/session.ts";

export function registerOrchestratorStatusTool(pi: ExtensionAPI, registry: RunRegistry<RunSession>): void {
	const parameters = Type.Object({
		logLines: Type.Optional(Type.Number({ description: "Number of trailing run.log lines to include (clamped to 1..200; default 20)." })),
	});
	pi.registerTool({
		name: "orchestrator_status",
		label: "Orchestrator Status",
		description:
			"Read-only status of the current /orchestrate run, if any: phase, elapsed time, total cost, " +
			"per-dispatch progress (model, status, turns, last tool call, cost), and recent run.log lines. " +
			"Does not affect the run.",
		promptSnippet: "orchestrator_status: check progress of a live /orchestrate run without blocking on it",
		parameters,
		async execute(_toolCallId, params) {
			const active = registry.active();
			if (!active) {
				return { content: [{ type: "text", text: "No orchestrator run is active." }], details: undefined };
			}
			const snapshot = active.session.statusSnapshot(params.logLines ?? 20);
			return {
				content: [{ type: "text", text: formatOrchestratorStatus(snapshot) }],
				details: snapshot,
			};
		},
	});
}

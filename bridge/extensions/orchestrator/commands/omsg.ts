/**
 * `/omsg` (B4.6): queue a user message for the next dispatched task in the
 * live `/orchestrate` run. Cannot be injected into a running Pi subprocess
 * (humain-terminal --mode json --no-session has no stdin channel), so
 * delivery is at the next dispatch boundary. commands/* must not import
 * index.ts; the `RunRegistry` is passed in instead of read from a module
 * singleton.
 */
import type { ExtensionAPI } from "@humain/terminal";

import type { RunRegistry } from "../run/context.ts";
import type { RunSession } from "../run/session.ts";

export function registerOmsgCommand(pi: ExtensionAPI, registry: RunRegistry<RunSession>): void {
	pi.registerCommand("omsg", {
		description:
			"Send a message to the running orchestration (queued, delivered to the next dispatched task). " +
			"Usage: /omsg <text> — the lead will see and respond to it. Use '\\n' for newlines if needed.",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /omsg <message>  (queues one message for the next dispatch)", "warning");
				return;
			}
			const active = registry.active();
			if (!active) {
				ctx.ui.notify(
					"No orchestration is running. Start one with /orchestrate <goal> first — " +
						"messages are only delivered to a live run.",
					"warning",
				);
				return;
			}
			// Literal "\n" in the input becomes a real newline so multi-line
			// instructions paste cleanly from shell history.
			const normalized = text.replace(/\\n/g, "\n");
			const depth = active.session.enqueueMessage(normalized);
			const preview = normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
			ctx.ui.notify(
				`Queued for next dispatch (depth=${depth}): “${preview}”`,
				"info",
			);
		},
	});
}

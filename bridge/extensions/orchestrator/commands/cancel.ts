/**
 * `/orchestrate-cancel` (B4.6): cancel the currently running `/orchestrate`
 * run, if any. commands/* must not import index.ts; the `RunRegistry` is
 * passed in instead of read from a module singleton.
 */
import type { ExtensionAPI } from "@humain/terminal";

import type { RunRegistry } from "../run/context.ts";
import type { RunSession } from "../run/session.ts";

export function registerOrchestrateCancelCommand(pi: ExtensionAPI, registry: RunRegistry<RunSession>): void {
	pi.registerCommand("orchestrate-cancel", {
		description: "Cancel the currently running /orchestrate run, if any.",
		handler: async (_args, ctx) => {
			const active = registry.active();
			if (!active) {
				ctx.ui.notify("no active run", "info");
				return;
			}
			const runId = active.session.runId;
			active.session.cancel("user");
			ctx.ui.notify(`Cancelling orchestration ${runId}…`, "info");
		},
	});
}

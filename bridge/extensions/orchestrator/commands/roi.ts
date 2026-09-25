/**
 * `/orchestrator-roi` (B4.6): print the skill vs flat-baseline ROI report by
 * running `scripts/skill_vs_baseline.py` through the shared Python CLI seam
 * (C1). commands/* must not import index.ts; `cli`/`skillRoot` are passed in
 * instead of index.ts's `orchestratorPythonCli()`/`expandedSkillRoot`.
 */
import { join } from "node:path";

import type { ExtensionAPI } from "@humain/terminal";

import type { PythonCli } from "../adapters/python-cli.ts";

export interface RoiDeps {
	/** Builds the one Python spawner this extension uses (C1); called fresh so a test
	 *  `spyOn(childProcess, "spawn")` installed after activation still takes effect. */
	cli(): PythonCli;
	/** Absolute path to the skill root `scripts/skill_vs_baseline.py` is run from/against. */
	skillRoot: string;
}

export function registerOrchestratorRoiCommand(pi: ExtensionAPI, deps: RoiDeps): void {
	pi.registerCommand("orchestrator-roi", {
		description: "Print the skill vs flat-baseline ROI report.",
		handler: async (_args, ctx) => {
			const result = await deps.cli().run(join(deps.skillRoot, "scripts/skill_vs_baseline.py"), [], {
				cwd: deps.skillRoot,
			});
			if (result.code !== 0) {
				ctx.ui.notify(`ROI report failed: ${result.error ?? result.stderr}`, "error");
				return;
			}
			ctx.ui.notify(result.stdout.split("\n").slice(0, 20).join("\n"), "info");
		},
	});
}

import type { WorkflowMode, WorkflowPolicy } from "./models.ts";

export const WORKFLOW_MODES: readonly WorkflowMode[] = ["off", "observe", "enforce"];
export const WORKFLOW_MODE_ENV = "HUMAIN_ORCHESTRATOR_WORKFLOW_MODE";

export type WorkflowModeSource = "env" | "setting" | "method" | "absent";

export function isWorkflowMode(value: unknown): value is WorkflowMode {
	return typeof value === "string" && (WORKFLOW_MODES as readonly string[]).includes(value);
}

/**
 * Effective workflow mode. Precedence: `HUMAIN_ORCHESTRATOR_WORKFLOW_MODE` env (one-off override,
 * e.g. benchmarks/CI) > persisted `orchestrator-profiles.json` `workflow_mode` (set with
 * `/orchestrator-models workflow`) > `method.json` `rules.workflow_policy.mode`. An invalid value at
 * any layer is reported and skipped; no policy at all means `off`.
 */
export function resolveWorkflowMode(
	policy: WorkflowPolicy | undefined,
	env: Record<string, string | undefined>,
	setting?: string,
): { mode: WorkflowMode; source: WorkflowModeSource; problems: string[] } {
	if (!policy) return { mode: "off", source: "absent", problems: ["workflow_policy missing from method.json; workflow levels disabled"] };
	const problems: string[] = [];
	const raw = env[WORKFLOW_MODE_ENV];
	if (raw !== undefined && raw !== "") {
		if (isWorkflowMode(raw)) return { mode: raw, source: "env", problems };
		problems.push(`Invalid ${WORKFLOW_MODE_ENV}=${raw}; ignoring it`);
	}
	if (setting !== undefined && setting !== "") {
		if (isWorkflowMode(setting)) return { mode: setting, source: "setting", problems };
		problems.push(`Invalid orchestrator-profiles.json workflow_mode "${setting}"; using method.json default ${policy.mode}`);
	}
	return { mode: policy.mode, source: "method", problems };
}

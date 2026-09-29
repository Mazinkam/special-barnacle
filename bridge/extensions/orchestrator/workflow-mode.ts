import type { WorkflowMode, WorkflowPolicy } from "./models.ts";

const MODES: readonly WorkflowMode[] = ["off", "observe", "enforce"];
export const WORKFLOW_MODE_ENV = "HUMAIN_ORCHESTRATOR_WORKFLOW_MODE";

export function resolveWorkflowMode(
	policy: WorkflowPolicy | undefined,
	env: Record<string, string | undefined>,
): { mode: WorkflowMode; source: "method" | "env" | "absent"; problems: string[] } {
	if (!policy) return { mode: "off", source: "absent", problems: ["workflow_policy missing from method.json; workflow levels disabled"] };
	const raw = env[WORKFLOW_MODE_ENV];
	if (raw === undefined || raw === "") return { mode: policy.mode, source: "method", problems: [] };
	if ((MODES as readonly string[]).includes(raw)) return { mode: raw as WorkflowMode, source: "env", problems: [] };
	return { mode: policy.mode, source: "method", problems: [`Invalid ${WORKFLOW_MODE_ENV}=${raw}; using ${policy.mode}`] };
}

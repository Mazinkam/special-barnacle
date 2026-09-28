import { METHOD } from "./models";

export interface EfficiencyControls {
	delegation_guidance: { enabled: boolean; own_tool_budget: { architect: number; lead: number }; targeted_reads_allowed: number };
	event_waiting_guidance: { enabled: boolean };
	file_ownership: { mode: "off" | "report" };
	model_canaries: { enabled: boolean; activation_available: false };
}

const SWITCHES = ["delegation_guidance", "event_waiting_guidance"] as const;
type SwitchName = (typeof SWITCHES)[number];
const ENV_NAMES: Record<SwitchName, string> = {
	delegation_guidance: "HUMAIN_ORCHESTRATOR_EFFICIENCY_DELEGATION_GUIDANCE",
	event_waiting_guidance: "HUMAIN_ORCHESTRATOR_EFFICIENCY_EVENT_WAITING_GUIDANCE",
};
const defaults: EfficiencyControls = {
	delegation_guidance: { enabled: false, own_tool_budget: { architect: 12, lead: 25 }, targeted_reads_allowed: 8 },
	event_waiting_guidance: { enabled: false },
	file_ownership: { mode: "off" },
	model_canaries: { enabled: false, activation_available: false },
};

export function resolveEfficiencyControls(raw: unknown, env: Record<string, string | undefined> = process.env): { controls: EfficiencyControls; problems: string[]; enabled: string[] } {
	const problems: string[] = [];
	const controls: EfficiencyControls = structuredClone(defaults);
	const config = record(raw);
	if (!config) problems.push("efficiency_controls config is missing or malformed");
	for (const name of ["scoped_leads", "recon_before_architect"] as const) {
		if (config?.[name] !== undefined) problems.push(`efficiency_controls.${name} was removed; ignoring`);
		if (env[`HUMAIN_ORCHESTRATOR_EFFICIENCY_${name.toUpperCase()}`] !== undefined) problems.push(`HUMAIN_ORCHESTRATOR_EFFICIENCY_${name.toUpperCase()} was removed; ignoring`);
	}
	for (const name of SWITCHES) {
		const item = record(config?.[name]);
		if (!item || typeof item.enabled !== "boolean") problems.push(`efficiency_controls.${name} is malformed; using OFF`);
		else controls[name].enabled = item.enabled;
		if (name === "delegation_guidance" && item) {
			const budgets = record(item.own_tool_budget);
			controls.delegation_guidance.own_tool_budget.architect = positiveInt(budgets?.architect, 12, "delegation_guidance.own_tool_budget.architect", problems);
			controls.delegation_guidance.own_tool_budget.lead = positiveInt(budgets?.lead, 25, "delegation_guidance.own_tool_budget.lead", problems);
			controls.delegation_guidance.targeted_reads_allowed = positiveInt(item.targeted_reads_allowed, 8, "delegation_guidance.targeted_reads_allowed", problems);
		}
		const value = env[ENV_NAMES[name]];
		if (value !== undefined) {
			const normalized = value.toLowerCase();
			if (["on", "true", "1"].includes(normalized)) controls[name].enabled = true;
			else if (["off", "false", "0"].includes(normalized)) controls[name].enabled = false;
			else problems.push(`Invalid ${ENV_NAMES[name]} value; config value kept`);
		}
	}
	const file = record(config?.file_ownership);
	const fileMode = file?.mode;
	if (fileMode === "off" || fileMode === "report") controls.file_ownership.mode = fileMode;
	else problems.push(fileMode === "serialize" ? "efficiency_controls.file_ownership=serialize is not supported; using OFF" : "efficiency_controls.file_ownership is malformed; using OFF");
	const override = env.HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP;
	if (override !== undefined) {
		if (override === "off" || override === "report") controls.file_ownership.mode = override;
		else problems.push(override === "serialize" ? "HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP=serialize is not supported; using OFF" : "Invalid HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP value; config value kept");
		if (override === "serialize") controls.file_ownership.mode = "off";
	}
	const canary = record(config?.model_canaries);
	if (!canary || typeof canary.enabled !== "boolean" || canary.activation_available !== false) problems.push("model_canaries config is malformed; using OFF");
	else controls.model_canaries.enabled = canary.enabled;
	const enabled: string[] = SWITCHES.filter((name) => controls[name].enabled);
	if (controls.file_ownership.mode !== "off") enabled.push("file_ownership");
	return { controls, problems, enabled };
}

export function loadEfficiencyControls(env: Record<string, string | undefined> = process.env): ReturnType<typeof resolveEfficiencyControls> {
	const rules = (METHOD as unknown as { rules: Record<string, unknown> }).rules;
	return resolveEfficiencyControls(rules.efficiency_controls && { ...record(rules.efficiency_controls), model_canaries: rules.model_canaries }, env);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function positiveInt(value: unknown, fallback: number, label: string, problems: string[]): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	problems.push(`${label} must be a positive integer; using ${fallback}`);
	return fallback;
}

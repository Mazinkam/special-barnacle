import { METHOD } from "./models";

export interface EfficiencyControls {
	recon_before_architect: { enabled: boolean };
	delegation_guidance: { enabled: boolean; own_tool_budget: { architect: number; lead: number }; targeted_reads_allowed: number };
	event_waiting_guidance: { enabled: boolean };
	scoped_leads: { enabled: boolean; max_handoff_chars: number };
	file_ownership: { mode: "off" | "report" | "serialize" };
	model_canaries: { enabled: boolean; activation_available: false };
}

const SWITCHES = ["recon_before_architect", "delegation_guidance", "event_waiting_guidance", "scoped_leads"] as const;
type SwitchName = (typeof SWITCHES)[number];
const ENV_NAMES: Record<SwitchName, string> = {
	recon_before_architect: "HUMAIN_ORCHESTRATOR_EFFICIENCY_RECON_BEFORE_ARCHITECT",
	delegation_guidance: "HUMAIN_ORCHESTRATOR_EFFICIENCY_DELEGATION_GUIDANCE",
	event_waiting_guidance: "HUMAIN_ORCHESTRATOR_EFFICIENCY_EVENT_WAITING_GUIDANCE",
	scoped_leads: "HUMAIN_ORCHESTRATOR_EFFICIENCY_SCOPED_LEADS",
};
const defaults: EfficiencyControls = {
	recon_before_architect: { enabled: false },
	delegation_guidance: { enabled: false, own_tool_budget: { architect: 12, lead: 25 }, targeted_reads_allowed: 8 },
	event_waiting_guidance: { enabled: false },
	scoped_leads: { enabled: false, max_handoff_chars: 12000 },
	file_ownership: { mode: "off" },
	model_canaries: { enabled: false, activation_available: false },
};

export function resolveEfficiencyControls(raw: unknown, env: Record<string, string | undefined> = process.env): { controls: EfficiencyControls; problems: string[]; enabled: string[] } {
	const problems: string[] = [];
	const controls: EfficiencyControls = structuredClone(defaults);
	const config = record(raw);
	if (!config) problems.push("efficiency_controls config is missing or malformed");
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
		if (name === "scoped_leads" && item) controls.scoped_leads.max_handoff_chars = positiveInt(item.max_handoff_chars, 12000, "scoped_leads.max_handoff_chars", problems);
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
	if (fileMode === "off" || fileMode === "report" || fileMode === "serialize") controls.file_ownership.mode = fileMode;
	else problems.push("efficiency_controls.file_ownership is malformed; using OFF");
	const override = env.HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP;
	if (override !== undefined) {
		if (override === "off" || override === "report" || override === "serialize") controls.file_ownership.mode = override;
		else problems.push("Invalid HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP value; config value kept");
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

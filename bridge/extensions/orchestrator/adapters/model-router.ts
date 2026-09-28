/** Pure ordered backup resolution and capability qualification. */
import { METHOD, resolveAlias, shortName, tierOf, type AliasTable, type ModelRequirementsRule, type Tier } from "../models.ts";
import type { Catalog } from "./model-catalog.ts";
import { providerRegion } from "../run/model-health.ts";
import { bedrockFallbackFor } from "../provider-fallback.ts";

export interface Requirement { minContext: number; minOutput: number; effortControl: boolean }
export interface Candidate {
	model: string;
	spec: string;
	source: "primary" | "twin" | "backup" | "upgrade";
	qualified: boolean;
	reasons: string[];
	effortControl: boolean;
}
export interface CandidateInput {
	capability: string;
	primary: string;
	backups?: Record<string, string[]>;
	tierPrimaries: Partial<Record<Tier, string>>;
	table: AliasTable;
	preference: string[];
	catalog: Catalog;
	requirement?: Requirement;
}

export function requirementFor(capability: string, rule: ModelRequirementsRule = METHOD.rules.model_requirements): Requirement {
	const group = Object.values(rule.groups).find((entry) => entry.capabilities.includes(capability)) ?? rule.default;
	return { minContext: group.min_context, minOutput: group.min_output, effortControl: group.effort_control ?? false };
}

function check(model: string, catalog: Catalog, requirement: Requirement): { reasons: string[]; effortControl: boolean } {
	const facts = catalog.get(model) ?? {};
	const reasons: string[] = [];
	if (facts.context === undefined) reasons.push("unknown context");
	else if (facts.context < requirement.minContext) reasons.push(`context ${facts.context} < ${requirement.minContext}`);
	if (facts.maxOutput === undefined) reasons.push("unknown max output");
	else if (facts.maxOutput < requirement.minOutput) reasons.push(`min_output ${facts.maxOutput} < ${requirement.minOutput}`);
	const effortControl = facts.effortControl ?? false;
	if (requirement.effortControl && !effortControl) reasons.push("no effort control");
	return { reasons, effortControl };
}

const ASCENDING: Tier[] = ["cheap", "mid", "premium", "frontier"];
export function resolveCandidates(input: CandidateInput): Candidate[] {
	const requirement = input.requirement ?? requirementFor(input.capability);
	const result: Candidate[] = [];
	const seen = new Set<string>();
	const add = (model: string, spec: string, source: Candidate["source"]) => {
		if (seen.has(model)) return;
		seen.add(model);
		const facts = check(model, input.catalog, requirement);
		result.push({ model, spec, source, qualified: source === "primary" || facts.reasons.length === 0, reasons: facts.reasons, effortControl: facts.effortControl });
	};
	const addSpec = (spec: string, source: Candidate["source"]) => {
		const resolved = resolveAlias(spec, input.table, input.preference);
		if (resolved.model) add(resolved.model, spec, source);
		else if (!seen.has(`?${spec}`)) {
			seen.add(`?${spec}`);
			result.push({ model: spec, spec, source, qualified: false, reasons: [`unresolved: ${resolved.error ?? "unknown model"}`], effortControl: false });
		}
	};
	add(input.primary, input.primary, "primary");
	const twin = bedrockFallbackFor(input.primary, input.table);
	if (twin) add(twin, twin, "twin");
	const tier = tierOf(input.capability);
	for (const spec of input.backups?.[input.capability] ?? (tier ? input.backups?.[tier] : undefined) ?? []) addSpec(spec, "backup");
	if (tier) for (const higher of ASCENDING.slice(ASCENDING.indexOf(tier) + 1)) {
		const primary = input.tierPrimaries[higher];
		if (primary) addSpec(primary, "upgrade");
		for (const spec of input.backups?.[higher] ?? []) addSpec(spec, "upgrade");
	}
	return result;
}

export function usableModels(candidates: Candidate[] | undefined, primary: string): string[] {
	const qualified = (candidates ?? []).filter((candidate) => candidate.qualified).map((candidate) => candidate.model);
	return [primary, ...qualified.filter((model) => model !== primary)];
}

export function pickBackup(models: string[], current: string, isHealthy: (model: string) => boolean = () => true): string | undefined {
	const options = models.filter((model) => model !== current && isHealthy(model));
	const region = providerRegion(current);
	return options.find((model) => providerRegion(model) !== region) ?? options[0];
}

function label(candidate: Candidate): string {
	return candidate.reasons.some((reason) => reason.startsWith("unresolved")) ? candidate.spec : `${shortName(candidate.model)}@${providerRegion(candidate.model)}`;
}
export function formatCandidates(candidates: Candidate[]): string {
	return candidates.map((candidate) => {
		if (!candidate.qualified) return `${label(candidate)} ✗ ${candidate.reasons.join("; ")}`;
		const warning = candidate.reasons.length ? ` (warning: ${candidate.reasons.join("; ")})` : "";
		return `${label(candidate)} ✓${candidate.effortControl ? "" : " (effort n/a)"}${warning}`;
	}).join(" · ");
}
export function formatCandidateGroups(table: Record<string, Candidate[]>): string[] {
	const groups = new Map<string, string[]>();
	for (const [capability, candidates] of Object.entries(table)) {
		const line = formatCandidates(candidates);
		groups.set(line, [...(groups.get(line) ?? []), capability]);
	}
	return [...groups].map(([line, capabilities]) => `${capabilities.join(", ")}: ${line}`);
}
export function backupWarnings(table: Record<string, Candidate[]>): string[] {
	const lonely = Object.entries(table).filter(([, candidates]) => candidates.length && usableModels(candidates, candidates[0].model).length < 2).map(([cap]) => cap);
	return lonely.length ? [`no qualifying backup for ${lonely.join(", ")}; a provider outage will fail those dispatches`] : [];
}

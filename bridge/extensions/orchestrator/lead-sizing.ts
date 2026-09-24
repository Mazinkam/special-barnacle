/**
 * Pure lead sizing (method.json `rules.lead_sizing`). Triage supplies
 * complexity and risk; this picks a lead size and the capability that size
 * maps to. No model names here: profiles bind lead_small / lead / lead_large
 * through the mid / premium / frontier tiers. Mirrored in Python by
 * `orchestrator.method.lead_size` (parity pinned in tests/test_method.py).
 */
import { METHOD, type LeadSize } from "./models.ts";

const ORDER: readonly LeadSize[] = ["small", "standard", "large"];

export type LeadSizeSource = "triage" | "heuristic" | "flag" | "escalation";

export interface LeadSizeDecision {
	size: LeadSize;
	capability: string;
	/** Size the complexity band alone would pick. */
	bandSize: LeadSize;
	/** Minimum size the risk level requires. */
	riskFloorSize: LeadSize;
	source: LeadSizeSource;
}

export function isLeadSize(s: string): s is LeadSize {
	return (ORDER as readonly string[]).includes(s);
}

export function isLeadCapability(capability: string): boolean {
	return Object.values(METHOD.rules.lead_sizing.sizes).includes(capability);
}

/**
 * size = max(complexity band, risk floor), unless `override` is given.
 * Complexity is rounded and clamped to 1..10 (non-finite -> 5); an unknown
 * risk uses the medium floor, so a bad triage reply can never size a lead
 * below "standard" by accident.
 */
export function sizeLead(input: {
	complexity: number;
	risk: string;
	override?: LeadSize;
	source: Exclude<LeadSizeSource, "escalation">;
}): LeadSizeDecision {
	const rule = METHOD.rules.lead_sizing;
	const raw = Number.isFinite(input.complexity) ? Math.round(input.complexity) : 5;
	const c = Math.max(1, Math.min(10, raw));
	const bands = rule.by_complexity;
	const bandSize = bands.find((b) => c >= b.min && c <= b.max)?.size ?? bands[bands.length - 1].size;
	const riskFloorSize = rule.risk_floor[input.risk] ?? rule.risk_floor.medium;
	const size = input.override ?? (ORDER.indexOf(bandSize) >= ORDER.indexOf(riskFloorSize) ? bandSize : riskFloorSize);
	return { size, capability: rule.sizes[size], bandSize, riskFloorSize, source: input.source };
}

/** The next lead size's capability, or null at the top or for a non-lead capability. */
export function escalateLeadCapability(capability: string): string | null {
	const sizes = METHOD.rules.lead_sizing.sizes;
	const current = ORDER.find((s) => sizes[s] === capability);
	if (!current) return null;
	const next = ORDER[ORDER.indexOf(current) + 1];
	return next ? sizes[next] : null;
}

/** Lead size for a lead capability (inverse of `sizes`), or undefined. */
export function leadSizeOf(capability: string): LeadSize | undefined {
	const sizes = METHOD.rules.lead_sizing.sizes;
	return ORDER.find((s) => sizes[s] === capability);
}

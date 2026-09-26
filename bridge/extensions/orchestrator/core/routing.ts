/**
 * Pure model-routing helpers: pick the model a capability dispatches on, and
 * find the cheapest model at a given cost tier, escalating a review capability
 * one tier per retry. No process/env access; everything is derived from the
 * resolved `Adapter` and `method.json` (via `models.ts`).
 */

import {
	type Binding,
	METHOD,
	rereviewFloor,
	type Tier,
	TIER_CAPABILITIES,
	tierIndex,
	tierOf,
	tierOfModel,
} from "../models.ts";

type Adapter = Record<string, Binding>;

export function pickModel(
	capability: string,
	adapter: Adapter,
	retryCount: number,
	risk = "medium",
): string {
	// Defensive: adapter lookups can yield undefined if the dynamic
	// resolver returned a partial map. Fall back to any binding we can
	// find before dereferencing .model — otherwise the escalation logic
	// itself becomes the crash site.
	const binding =
		adapter[capability] ??
		adapter.worker ??
		adapter.implementation_fast ??
		Object.values(adapter).find((v) => v && typeof v === "object");
	const base = binding?.model ?? "unknown";
	if (retryCount === 0) return base;

	const isReview = capability === "technical_review" || capability === "security_review";
	if (!isReview) return base;

	// Tier from the resolved adapter (highest tier any capability binds this
	// model to), falling back to name classification for unbound models.
	const current = tierOfModel(base, adapter);
	if (current === "unknown") return base;

	// Floor from the method: max(risk tier_min, one tier above current), then
	// one more tier per additional retry. Prohibited tiers are never allowed.
	const floor = rereviewFloor(risk);
	const prohibited = METHOD.rules.review_after_fix.prohibit_tiers;
	let targetIdx = Math.max(tierIndex(floor.tier_min), tierIndex(current) + 1) + (retryCount - 1);
	targetIdx = Math.min(targetIdx, METHOD.tiers.length - 1);
	while (targetIdx < METHOD.tiers.length - 1 && prohibited.includes(METHOD.tiers[targetIdx] as Tier)) targetIdx++;
	const target = METHOD.tiers[targetIdx] as Tier;
	if (target === current) return base;

	// Walk upward from the target so a missing tier still escalates.
	for (let i = targetIdx; i < METHOD.tiers.length; i++) {
		const m = cheapestAtTier(adapter, METHOD.tiers[i] as Tier, capability);
		if (m) return m;
	}
	return base;
}

export function cheapestAtTier(adapter: Adapter, tier: string, preferredCapability: string): string | null {
	// Look through the adapter for any capability at the requested tier. The
	// dynamic adapter's resolve code picks models uniformly by cost tier, so
	// for the "mid" tier we want a mid-tier capability. We prefer the
	// specific capability (e.g. technical_review for technical_review), fall
	// back to peer review/implementation capabilities, then to architect/
	// security_review which the dynamic adapter tends to map to the premium
	// tier. Without the fallback, "mid -> premium" escalation has nothing to
	// escalate to because every review-capability sits at the same tier.
	// Within a tier, general-purpose capabilities come before specialised ones
	// (security_review is often overridden to a different vendor on purpose).
	const candidates = [
		preferredCapability,
		"implementation_strong",
		"technical_review",
		"analysis_mid",
		"analysis_strong",
		"architect",
		"lead",
		"security_review",
		"lead_large",
		"worker",
	];
	// Pick from capabilities that BELONG to the target tier (method.json), not
	// from any model that happens to be bound somewhere at that tier: a profile
	// override (e.g. oss binding `lead` to a mid model) must not turn that model
	// into the "premium" escalation target.
	for (const cap of [...candidates, ...TIER_CAPABILITIES[tier as Tier] ?? []]) {
		if (tierOf(cap) !== tier) continue;
		const binding = adapter[cap];
		if (binding?.model) return binding.model;
	}
	return null;
}

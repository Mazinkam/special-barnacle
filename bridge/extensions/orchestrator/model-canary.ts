/**
 * Model canaries: comparison candidates for a capability's baseline model,
 * activated by a deterministic per-run/per-candidate coin flip. 0% exposure
 * by default. Pure logic only (no I/O, no HT imports) so it can be unit
 * tested with `bun test`; the extension supplies the live model registry,
 * the run id, and telemetry sinks.
 *
 * There is deliberately no catalog "qualification" here (tool/context/
 * reasoning requirement checks). Eligibility is purely: capability match,
 * alias resolvability, and never lowering tier below the baseline.
 */

import { createHash } from "node:crypto";
import { classifyModelName, DEFAULT_PROVIDER_PREFERENCE, resolveAlias, shortName, tierIndex, tierOf, type AliasTable, type Tier } from "./models.ts";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

export interface CanaryCandidate {
	id: string;
	/** Eligible when the requested capability sits at this tier. */
	tier?: Tier;
	/** Eligible when the requested capability is explicitly named here. */
	capabilities?: string[];
	model: string;
	/** 0..100. 0 by default: candidates are comparison-only until raised. */
	percentage: number;
}

export interface ModelCanaryConfig {
	configVersion?: string;
	enabled: boolean;
	activationAvailable: boolean;
	activationUnavailableReason?: string;
	excludeCapabilities: string[];
	candidates: CanaryCandidate[];
}

export function emptyModelCanaryConfig(): ModelCanaryConfig {
	return {
		enabled: false,
		activationAvailable: false,
		excludeCapabilities: [],
		candidates: [],
	};
}

const TIER_SET = new Set<Tier>(["cheap", "mid", "premium", "frontier"]);

/** Qualification checks exist only on unmerged feat/model-failover; do not reimplement them here. */
export const CANARY_QUALIFICATION_AVAILABLE = false;

/**
 * Parse the raw `rules.model_canaries` JSON. Never throws: malformed input
 * yields a disabled config plus a list of problems the caller can surface.
 * Individual malformed candidates are dropped (with a problem) rather than
 * disabling the whole config, matching how `parseProfilesFile` degrades.
 */
export function parseModelCanaries(raw: unknown): { config: ModelCanaryConfig; problems: string[] } {
	const problems: string[] = [];
	const config = emptyModelCanaryConfig();

	if (!raw || typeof raw !== "object") {
		problems.push("model_canaries is not a JSON object");
		return { config, problems };
	}
	const r = raw as Record<string, unknown>;

	if (typeof r.config_version === "string" && r.config_version.trim()) {
		config.configVersion = r.config_version.trim();
	}

	if (r.enabled === true) config.enabled = true;
	else if (r.enabled !== undefined && r.enabled !== false) {
		problems.push(`model_canaries.enabled must be a boolean, got ${JSON.stringify(r.enabled)} — defaulting to false`);
	}

	if (r.activation_available === true) {
		if (CANARY_QUALIFICATION_AVAILABLE) config.activationAvailable = true;
		else problems.push("activation_available_ignored:qualification_unavailable");
	} else if (r.activation_available !== undefined && r.activation_available !== false) {
		problems.push(
			`model_canaries.activation_available must be a boolean, got ${JSON.stringify(r.activation_available)} — defaulting to false`,
		);
	}

	if (typeof r.activation_unavailable_reason === "string" && r.activation_unavailable_reason.trim()) {
		config.activationUnavailableReason = r.activation_unavailable_reason.trim();
	}

	if (r.exclude_capabilities !== undefined) {
		if (Array.isArray(r.exclude_capabilities) && r.exclude_capabilities.every((c) => typeof c === "string")) {
			config.excludeCapabilities = r.exclude_capabilities as string[];
		} else {
			problems.push("model_canaries.exclude_capabilities must be an array of strings — ignoring");
		}
	}

	if (r.candidates !== undefined) {
		if (!Array.isArray(r.candidates)) {
			problems.push("model_canaries.candidates must be an array — ignoring");
		} else {
			const seenIds = new Set<string>();
			for (let i = 0; i < r.candidates.length; i++) {
				const parsed = parseCandidate(r.candidates[i], i, problems);
				if (!parsed) continue;
				if (seenIds.has(parsed.id)) {
					problems.push(`model_canaries.candidates[${i}]: duplicate id "${parsed.id}" — dropping`);
					continue;
				}
				seenIds.add(parsed.id);
				config.candidates.push(parsed);
			}
		}
	}

	return { config, problems };
}

function parseCandidate(raw: unknown, index: number, problems: string[]): CanaryCandidate | null {
	const where = `model_canaries.candidates[${index}]`;
	if (!raw || typeof raw !== "object") {
		problems.push(`${where} is not an object — dropping`);
		return null;
	}
	const c = raw as Record<string, unknown>;

	if (typeof c.id !== "string" || !c.id.trim()) {
		problems.push(`${where}.id must be a non-empty string — dropping`);
		return null;
	}
	const id = c.id.trim();

	if (typeof c.model !== "string" || !c.model.trim()) {
		problems.push(`${where}.model must be a non-empty string — dropping`);
		return null;
	}
	const model = c.model.trim();

	if (typeof c.percentage !== "number" || !Number.isFinite(c.percentage) || c.percentage < 0 || c.percentage > 100) {
		problems.push(`${where}.percentage must be a number in 0..100, got ${JSON.stringify(c.percentage)} — dropping`);
		return null;
	}
	const percentage = c.percentage;

	let tier: Tier | undefined;
	if (c.tier !== undefined) {
		if (typeof c.tier === "string" && TIER_SET.has(c.tier as Tier)) {
			tier = c.tier as Tier;
		} else {
			problems.push(`${where}.tier "${String(c.tier)}" is not a known tier — ignoring`);
		}
	}

	let capabilities: string[] | undefined;
	if (c.capabilities !== undefined) {
		if (Array.isArray(c.capabilities) && c.capabilities.every((x) => typeof x === "string")) {
			capabilities = c.capabilities as string[];
		} else {
			problems.push(`${where}.capabilities must be an array of strings — ignoring`);
		}
	}

	if (!tier && (!capabilities || capabilities.length === 0)) {
		problems.push(`${where} has neither "tier" nor "capabilities" — it will never be eligible`);
	}

	return { id, tier, capabilities, model, percentage };
}

// -----------------------------------------------------------------------------
// Deterministic assignment
// -----------------------------------------------------------------------------

/**
 * Must match the Python engine's `orchestrator/adaptive.py::_unit_interval`
 * bit-for-bit: sha256(seed utf-8) hex, first 16 hex chars as an integer,
 * divided by 0xFFFFFFFFFFFFFFFF. Both conversions to `Number` here mirror
 * Python's int -> float rounding (IEEE754 round-to-nearest), so the result
 * matches even though the numerator exceeds Number.MAX_SAFE_INTEGER.
 */
export function canaryUnit(seed: string): number {
	const hex = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
	const n = BigInt(`0x${hex}`);
	return Number(n) / Number(0xffffffffffffffffn);
}

export type CanaryCohort = "baseline" | "candidate" | "ineligible";
export type CanaryActivation = "disabled" | "unavailable" | "zero_exposure" | "active";

export interface CanaryAssignment {
	cohort: CanaryCohort;
	candidateId?: string;
	baselineModel: string;
	candidateModel?: string;
	requestedModel: string;
	activation: CanaryActivation;
	reason: string;
	policyVersion: string;
}

export interface AssignCanaryInput {
	runId: string;
	capability: string;
	baselineModel: string;
	explicitOverride: boolean;
	config: ModelCanaryConfig;
	aliasTable?: AliasTable | null;
	preference?: string[];
}

/** Candidates eligible for a capability under the config's own rules. */
function eligibleCandidates(config: ModelCanaryConfig, capability: string): CanaryCandidate[] {
	if (config.excludeCapabilities.includes(capability)) return [];
	const capTier = tierOf(capability);
	return config.candidates.filter((c) => {
		if (c.capabilities?.includes(capability)) return true;
		return Boolean(c.tier && capTier && c.tier === capTier);
	});
}

/** disabled > unavailable > zero_exposure, given a resolved percentage. */
function baseActivation(config: ModelCanaryConfig, percentage: number): CanaryActivation {
	if (!config.enabled) return "disabled";
	if (!CANARY_QUALIFICATION_AVAILABLE || !config.activationAvailable) return "unavailable";
	if (percentage <= 0) return "zero_exposure";
	return "active";
}

export function wouldSelectCandidate(runId: string, candidateId: string, percentage: number): boolean {
	return canaryUnit(`canary:${runId}:${candidateId}`) < percentage / 100;
}

export function assignCanary(input: AssignCanaryInput): CanaryAssignment {
	const { runId, capability, baselineModel, explicitOverride, config, aliasTable, preference } = input;
	const policyVersion = config.configVersion ?? "unversioned";
	const baseline: Omit<CanaryAssignment, "activation" | "reason"> = {
		cohort: "baseline",
		baselineModel,
		requestedModel: baselineModel,
		policyVersion,
	};

	const candidates = eligibleCandidates(config, capability);
	if (candidates.length === 0) {
		const activation = baseActivation(config, 0);
		const reason = config.excludeCapabilities.includes(capability) ? "capability_excluded" : "no_matching_candidate";
		return { ...baseline, activation, reason };
	}

	const candidate = candidates[0];
	const activation = baseActivation(config, candidate.percentage);

	// Resolve the candidate's model, independent of activation state, so
	// telemetry can always show what the candidate would have been.
	const table = aliasTable ?? null;
	const resolution = table ? resolveAlias(candidate.model, table, preference ?? DEFAULT_PROVIDER_PREFERENCE) : { error: "no alias table available" };

	if (explicitOverride) {
		return {
			...baseline,
			cohort: "ineligible",
			candidateId: candidate.id,
			candidateModel: resolution.model,
			activation,
			reason: "explicit_user_override",
		};
	}

	if (!resolution.model) {
		return {
			...baseline,
			cohort: "ineligible",
			candidateId: candidate.id,
			activation,
			reason: `candidate_unresolvable: ${resolution.error}`,
		};
	}
	const candidateModel = resolution.model;

	if (candidateModel.toLowerCase() === baselineModel.toLowerCase()) {
		return {
			...baseline,
			cohort: "ineligible",
			candidateId: candidate.id,
			candidateModel,
			activation,
			reason: "candidate_equals_baseline",
		};
	}

	const baselineTier = classifyModelName(baselineModel);
	const candidateTier = classifyModelName(candidateModel);
	if (baselineTier !== "unknown" && candidateTier !== "unknown" && tierIndex(candidateTier) < tierIndex(baselineTier)) {
		return {
			...baseline,
			cohort: "ineligible",
			candidateId: candidate.id,
			candidateModel,
			activation,
			reason: "tier_lowering_rejected",
		};
	}

	if (activation === "disabled") {
		return { ...baseline, candidateId: candidate.id, candidateModel, activation, reason: "canary_disabled" };
	}
	if (activation === "unavailable") {
		return {
			...baseline,
			candidateId: candidate.id,
			candidateModel,
			activation,
			reason: config.activationUnavailableReason ?? "activation_unavailable",
		};
	}
	if (activation === "zero_exposure") {
		return { ...baseline, candidateId: candidate.id, candidateModel, activation, reason: "zero_exposure" };
	}

	// activation === "active": enabled, available, percentage > 0. The only
	// remaining question is whether this run/candidate pair lands in the
	// exposed slice.
	if (CANARY_QUALIFICATION_AVAILABLE && wouldSelectCandidate(runId, candidate.id, candidate.percentage)) {
		return {
			cohort: "candidate",
			candidateId: candidate.id,
			baselineModel,
			candidateModel,
			requestedModel: candidateModel,
			activation,
			reason: "canary_active",
			policyVersion,
		};
	}
	return { ...baseline, candidateId: candidate.id, candidateModel, activation, reason: "not_selected" };
}

// -----------------------------------------------------------------------------
// Telemetry
// -----------------------------------------------------------------------------

export type CanaryDeviation = "provider_substitution" | "model_substitution" | "unknown" | null;

function deviation(requestedModel: string, executedModel: string | undefined): CanaryDeviation {
	if (executedModel === undefined) return "unknown";
	if (executedModel === requestedModel) return null;
	const [reqProvider, reqId] = splitCanonical(requestedModel);
	const [execProvider, execId] = splitCanonical(executedModel);
	if (shortName(reqId).toLowerCase() === shortName(execId).toLowerCase()) {
		if (reqProvider !== execProvider) return "provider_substitution";
		return null;
	}
	return "model_substitution";
}

function splitCanonical(model: string): [string | undefined, string] {
	const slash = model.indexOf("/");
	return slash === -1 ? [undefined, model] : [model.slice(0, slash), model.slice(slash + 1)];
}

/** Flat snake_case fields for run/attempt telemetry records. */
export function canaryTelemetryFields(
	a: CanaryAssignment,
	executedModel: string | undefined,
	attemptId: string,
): Record<string, unknown> {
	return {
		canary_cohort: a.cohort,
		canary_candidate_id: a.candidateId ?? null,
		canary_activation: a.activation,
		canary_reason: a.reason,
		canary_policy_version: a.policyVersion,
		baseline_model: a.baselineModel,
		candidate_model: a.candidateModel ?? null,
		requested_model: a.requestedModel,
		executed_model: executedModel ?? null,
		canary_attempt_id: attemptId,
		canary_deviation: deviation(a.requestedModel, executedModel),
	};
}

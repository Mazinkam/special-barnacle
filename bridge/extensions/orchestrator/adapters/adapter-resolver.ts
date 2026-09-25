/**
 * Adapter/profile resolution (B4.3): the last-resort fallback bindings, the
 * dynamic (`resolve-adapter --explain`) adapter, and the merge of flags >
 * profile capabilities > profile tiers > dynamic > fallback into the
 * capability -> model table a run actually dispatches against.
 *
 * `FALLBACK_ADAPTER` used to be a 17-line hand-copied literal that had to be
 * kept in sync by hand with the shipped `premium` profile
 * (`bridge/orchestrator-profiles.json`). It is derived from that file instead
 * (imported the same way `models.ts` imports `method.json`): for each
 * capability, resolve its tier's alias, then apply the profile's own
 * capability overrides for any alias with a known Bedrock model id.
 * `security_review`'s profile override (`astra`) has no entry in
 * `BEDROCK_MODEL_ID`, so it falls through to its tier default
 * (`opus-5-5`) — which is also why the pre-existing literal disagreed with
 * the profile's `capabilities.security_review` for that one capability.
 * `adapter-resolver.test.ts` pins the derived value against that literal.
 */

import { createHash } from "node:crypto";

import {
	type AliasTable,
	type AvailableModel,
	type Binding,
	buildAliasTable,
	DEFAULT_PROVIDER_PREFERENCE,
	type Layer,
	mergeLayers,
	type ResolvedAdapter,
	type Tier,
	TIER_CAPABILITIES,
	tiersToBindings,
} from "../models.ts";
import { emptyOverrides, type ModelOverrides } from "../core/args.ts";
import type { LoadedProfiles } from "./profiles-store.ts";
import profilesFile from "../orchestrator-profiles.json";

export type Adapter = Record<string, Binding>;

/** Known Bedrock model ids for the aliases the shipped profiles use. Not every alias has one (see module doc). */
const BEDROCK_MODEL_ID: Record<string, string> = {
	"gpt-6-luna": "amazon-bedrock/global.openai.gpt-6-luna",
	"gpt-6-sol": "amazon-bedrock/global.openai.gpt-6-sol",
	"sonnet-5": "amazon-bedrock/global.anthropic.claude-sonnet-5",
	"opus-5-5": "amazon-bedrock/global.anthropic.claude-opus-5-5",
	"fable-5-1": "amazon-bedrock/global.anthropic.claude-fable-5-1",
};

interface ShippedProfileSpec {
	tiers?: Partial<Record<string, string>>;
	capabilities?: Record<string, string>;
}

function deriveFallbackAdapter(): Adapter {
	const raw = profilesFile as { active_profile: string; profiles: Record<string, ShippedProfileSpec> };
	const profile = raw.profiles[raw.active_profile];
	const out: Adapter = {};
	if (!profile) return out;
	for (const [tier, caps] of Object.entries(TIER_CAPABILITIES) as [Tier, string[]][]) {
		const alias = profile.tiers?.[tier];
		const id = alias ? BEDROCK_MODEL_ID[alias] : undefined;
		if (!id) continue;
		for (const cap of caps) out[cap] = { model: id };
	}
	for (const [cap, alias] of Object.entries(profile.capabilities ?? {})) {
		const id = BEDROCK_MODEL_ID[alias];
		if (id) out[cap] = { model: id };
	}
	return out;
}

/**
 * Last-resort bindings, used only when neither a profile nor the dynamic
 * resolver yields a model for a capability. Derived from the shipped
 * `premium` profile (see module doc); `adapter-resolver.test.ts` pins it
 * against the historical hand-written literal.
 */
export const FALLBACK_ADAPTER: Adapter = deriveFallbackAdapter();

/** `<profile>-<sha256(canonical adapter)[:8]>`: stable for identical bindings. */
export function policyIdFor(profileName: string, adapter: Record<string, Binding>): string {
	const canon = Object.keys(adapter)
		.sort()
		.map((c) => `${c}=${adapter[c]?.model ?? ""}@${adapter[c]?.effort ?? ""}`)
		.join(";");
	return `${profileName}-${createHash("sha256").update(canon).digest("hex").slice(0, 8)}`;
}

/** The slice of `createPythonCli()`'s `run()` the dynamic adapter needs. */
export interface DynamicAdapterCli {
	run(module: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;
}

export async function loadDynamicAdapter(cli: DynamicAdapterCli): Promise<{ adapter: Adapter; warning?: string }> {
	try {
		const result = await cli.run("orchestrator.cli", ["resolve-adapter", "--explain"]);
		if (result.code !== 0) {
			return {
				adapter: {},
				warning: `resolve-adapter failed (exit ${result.code ?? "n/a"}): ${(result.error ?? result.stderr).trim().slice(0, 300)}`,
			};
		}
		const resolved = JSON.parse(result.stdout.trim()) as Record<string, any>;
		const out: Adapter = {};
		for (const [cap, info] of Object.entries(resolved)) {
			if (!info || typeof info !== "object" || cap.startsWith("_")) continue;
			if (!info.provider || !info.model) continue;
			out[cap] = { model: `${info.provider}/${info.model}` };
		}
		return { adapter: out, warning: Object.keys(out).length === 0 ? "resolve-adapter returned no bindings" : undefined };
	} catch (err) {
		return { adapter: {}, warning: `resolve-adapter error: ${(err as Error).message}` };
	}
}

export interface FullResolution extends ResolvedAdapter {
	profileName: string;
	profiles: LoadedProfiles;
	table: AliasTable;
	preference: string[];
}

export interface ResolveAdapterDeps {
	/** Where profiles were loaded from, for the "not defined in ..." warning. */
	profilesPath: string;
	loadProfiles: () => LoadedProfiles;
	availableModels: () => AvailableModel[];
	dynamicCli: DynamicAdapterCli;
}

/**
 * Build the capability -> model table for a run. Precedence, highest first:
 * flags > profile capabilities > profile tiers > dynamic resolver > fallback.
 * Problems in the profiles file are surfaced as warnings; an unresolvable spec
 * at a user layer is a warning the /orchestrate handler treats as fatal.
 */
export async function resolveAdapter(
	deps: ResolveAdapterDeps,
	overrides: ModelOverrides = emptyOverrides(),
): Promise<FullResolution> {
	const profiles = deps.loadProfiles();
	const table = buildAliasTable(deps.availableModels());
	const preference = profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE;
	const profileName = overrides.profile ?? profiles.file.active_profile;
	const profile = profiles.file.profiles[profileName];
	const warnings: string[] = [...profiles.problems];
	if (!profile) {
		warnings.push(
			`(profile:${profileName}) profile "${profileName}" is not defined in ${deps.profilesPath} (have: ${Object.keys(profiles.file.profiles).join(", ") || "none"})`,
		);
	}
	const dynamic = await loadDynamicAdapter(deps.dynamicCli);
	if (dynamic.warning) warnings.push(dynamic.warning);

	const layers: Layer[] = [
		{ source: "flag", bindings: { ...tiersToBindings(overrides.tiers), ...overrides.capabilities } },
		{
			source: `profile:${profileName}`,
			bindings: Object.fromEntries(Object.entries(profile?.capabilities ?? {}).map(([c, m]) => [c, { model: m }])),
		},
		{ source: `profile:${profileName}`, bindings: tiersToBindings(profile?.tiers) },
		{ source: "dynamic", bindings: dynamic.adapter },
		{ source: "fallback", bindings: FALLBACK_ADAPTER },
	];
	const merged = mergeLayers(layers, table, preference, profile?.effort ?? {}, overrides.effort);
	// Fallback/dynamic specs are canonical already but may name models the user
	// has not configured; those show up as non-user warnings and are informational.
	return {
		...merged,
		warnings: [...warnings, ...merged.warnings],
		profileName,
		profiles,
		table,
		preference,
	};
}

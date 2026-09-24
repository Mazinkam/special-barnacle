/**
 * Pure model-resolution logic for the orchestrator bridge: profiles, aliases,
 * precedence merge, validation. No HT imports so it can be unit-tested with
 * `bun test`. The extension (index.ts) supplies I/O: the model registry, file
 * reads/writes, and UI.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// Canonical orchestration method. `./method.json` is a symlink to
// `orchestrator/method.json` at the repo root — the same bytes the Python
// engine reads — so capability tiers and routing rules cannot drift between
// the two runtimes. Edit the root file, never this one.
import method from "./method.json";

export type Tier = "cheap" | "mid" | "premium" | "frontier";
/** Display order, most expensive first. `METHOD.tiers` is the ascending cost order. */
export const TIERS: Tier[] = ["frontier", "premium", "mid", "cheap"];

export type LeadSize = "small" | "standard" | "large";
export type SpendCapMode = "off" | "warn" | "enforce";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ReReviewFloor {
	capability: string;
	tier_min: Tier;
	verification_depth: string;
	independent_review?: boolean;
}

interface MethodFile {
	schema_version: number;
	tiers: Tier[];
	capabilities: Record<string, { tier: Tier; default_effort: string }>;
	effort_levels: string[];
	roles: Record<string, string>;
	rules: {
		review_after_fix: {
			prohibit_tiers: Tier[];
			escalation_by_risk: Record<RiskLevel, ReReviewFloor>;
		};
		pre_implementation_recon: {
			min_complexity: number;
			workers_by_complexity: { min: number; max: number; workers: number }[];
			/** Abstract capability every parent-owned recon worker dispatches as. */
			worker_capability: string;
			/** Token budget for the aggregate recon evidence packet handed to a lead. */
			evidence_packet_max_tokens: number;
			skip_for_task_classes: string[];
		};
		lead_sizing: {
			sizes: Record<LeadSize, string>;
			by_complexity: { min: number; max: number; size: LeadSize }[];
			risk_floor: Record<string, LeadSize>;
			escalate_on_verification_failure: boolean;
		};
		dispatch_spend_cap: {
			mode: SpendCapMode;
			usd_by_capability: Record<string, number>;
			default_usd: number;
		};
	};
}

export const METHOD = method as unknown as MethodFile;

/** Which cost tier each abstract capability sits at. Derived from method.json. */
export const TIER_CAPABILITIES: Record<Tier, string[]> = { cheap: [], mid: [], premium: [], frontier: [] };
for (const [cap, spec] of Object.entries(METHOD.capabilities)) TIER_CAPABILITIES[spec.tier].push(cap);
export const ALL_CAPABILITIES = Object.keys(METHOD.capabilities);

/** Rule 1: the minimum re-review package for a risk level (unknown risk -> medium). */
export function rereviewFloor(risk: string): ReReviewFloor {
	const table = METHOD.rules.review_after_fix.escalation_by_risk;
	return table[risk as RiskLevel] ?? table.medium;
}

/** Rule 2: how many pre-implementation recon workers a task warrants; 0 = skip recon. */
export function reconWorkers(complexity: number, taskClass?: string): number {
	const r = METHOD.rules.pre_implementation_recon;
	if ((taskClass && r.skip_for_task_classes.includes(taskClass)) || complexity < r.min_complexity) return 0;
	const band = r.workers_by_complexity.find((b) => complexity >= b.min && complexity <= b.max);
	return band?.workers ?? r.workers_by_complexity[r.workers_by_complexity.length - 1]?.workers ?? 0;
}

export function tierIndex(tier: Tier): number {
	return METHOD.tiers.indexOf(tier);
}

export function tierOf(capability: string): Tier | undefined {
	return (Object.keys(TIER_CAPABILITIES) as Tier[]).find((t) => TIER_CAPABILITIES[t].includes(capability));
}

export function isTier(s: string): s is Tier {
	return s === "cheap" || s === "mid" || s === "premium" || s === "frontier";
}

export function isThinkingLevel(s: string): s is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(s);
}

// -----------------------------------------------------------------------------
// Profiles file
// -----------------------------------------------------------------------------

export interface ProfileSpec {
	description?: string;
	/** tier -> alias or provider/id */
	tiers?: Partial<Record<Tier, string>>;
	/** capability -> alias or provider/id */
	capabilities?: Record<string, string>;
	/** capability -> HT thinking level */
	effort?: Record<string, string>;
}

export interface ProfilesFile {
	version: 1;
	active_profile: string;
	/** Providers to prefer, in order, when a bare alias exists on several. */
	provider_preference?: string[];
	profiles: Record<string, ProfileSpec>;
}

export const DEFAULT_PROVIDER_PREFERENCE = ["openai-codex", "amazon-bedrock"];
export const PROFILE_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function emptyProfilesFile(): ProfilesFile {
	return { version: 1, active_profile: "default", profiles: { default: {} } };
}

/**
 * Validate the parsed JSON of a profiles file. Structural problems are returned,
 * not thrown, so the caller can show all of them at once. Unknown capability
 * names, bad tier names, and bad thinking levels are reported and dropped;
 * everything else is kept.
 */
export function parseProfilesFile(raw: unknown): { file: ProfilesFile; problems: string[] } {
	const problems: string[] = [];
	const file = emptyProfilesFile();
	if (!raw || typeof raw !== "object") {
		problems.push("profiles file is not a JSON object");
		return { file, problems };
	}
	const r = raw as Record<string, unknown>;
	if (r.version !== 1) problems.push(`unsupported version ${JSON.stringify(r.version)} (expected 1)`);
	if (Array.isArray(r.provider_preference) && r.provider_preference.every((p) => typeof p === "string")) {
		file.provider_preference = r.provider_preference as string[];
	}
	const profiles = r.profiles;
	if (!profiles || typeof profiles !== "object") {
		problems.push("missing \"profiles\" object");
		return { file, problems };
	}
	file.profiles = {};
	for (const [name, spec] of Object.entries(profiles as Record<string, unknown>)) {
		if (!PROFILE_NAME_RE.test(name)) {
			problems.push(`profile name "${name}" must match ${PROFILE_NAME_RE}`);
			continue;
		}
		const parsed = parseProfileSpec(spec, `profiles.${name}`, problems);
		if (parsed) file.profiles[name] = parsed;
	}
	if (typeof r.active_profile === "string" && r.active_profile) {
		file.active_profile = r.active_profile;
		if (!file.profiles[r.active_profile]) {
			problems.push(`active_profile "${r.active_profile}" is not defined in "profiles"`);
		}
	} else {
		problems.push("missing \"active_profile\"");
	}
	return { file, problems };
}

export function parseProfileSpec(spec: unknown, where: string, problems: string[]): ProfileSpec | null {
	if (!spec || typeof spec !== "object") {
		problems.push(`${where} is not an object`);
		return null;
	}
	const s = spec as Record<string, unknown>;
	const out: ProfileSpec = {};
	if (typeof s.description === "string") out.description = s.description;
	if (s.tiers && typeof s.tiers === "object") {
		out.tiers = {};
		for (const [tier, v] of Object.entries(s.tiers as Record<string, unknown>)) {
			if (!isTier(tier)) problems.push(`${where}.tiers: unknown tier "${tier}" (cheap|mid|premium|frontier)`);
			else if (typeof v !== "string" || !v.trim()) problems.push(`${where}.tiers.${tier} must be a non-empty string`);
			else out.tiers[tier] = v.trim();
		}
	}
	if (s.capabilities && typeof s.capabilities === "object") {
		out.capabilities = {};
		for (const [cap, v] of Object.entries(s.capabilities as Record<string, unknown>)) {
			if (!ALL_CAPABILITIES.includes(cap)) problems.push(`${where}.capabilities: unknown capability "${cap}"`);
			else if (typeof v !== "string" || !v.trim()) problems.push(`${where}.capabilities.${cap} must be a non-empty string`);
			else out.capabilities[cap] = v.trim();
		}
	}
	if (s.effort && typeof s.effort === "object") {
		out.effort = {};
		for (const [cap, v] of Object.entries(s.effort as Record<string, unknown>)) {
			if (!ALL_CAPABILITIES.includes(cap)) problems.push(`${where}.effort: unknown capability "${cap}"`);
			else if (typeof v !== "string" || !isThinkingLevel(v))
				problems.push(`${where}.effort.${cap}: "${String(v)}" is not a thinking level (${THINKING_LEVELS.join("|")})`);
			else out.effort[cap] = v;
		}
	}
	return out;
}

/**
 * Convert the legacy `orchestrator-adapter.json` shape into a ProfileSpec.
 * Accepts both `{tiers, capabilities: {cap: {model, effort}}}` and the flat
 * `{cap: {model}}` form. Efforts that are not HT thinking levels are dropped
 * (the legacy fallback used "standard", which `--thinking` rejects).
 */
export function migrateAdapterToProfile(raw: unknown): { spec: ProfileSpec; notes: string[] } {
	const notes: string[] = [];
	const spec: ProfileSpec = { description: "migrated from orchestrator-adapter.json" };
	if (!raw || typeof raw !== "object") return { spec, notes: ["adapter file is not an object; nothing migrated"] };
	const r = raw as Record<string, unknown>;
	if (r.tiers && typeof r.tiers === "object") {
		spec.tiers = {};
		for (const [tier, v] of Object.entries(r.tiers as Record<string, unknown>)) {
			if (isTier(tier) && typeof v === "string" && v.trim()) spec.tiers[tier] = v.trim();
		}
	}
	const caps = r.capabilities && typeof r.capabilities === "object" ? (r.capabilities as Record<string, unknown>) : r;
	for (const [cap, v] of Object.entries(caps)) {
		if (cap === "tiers" || cap === "capabilities" || cap.startsWith("$") || cap.startsWith("_")) continue;
		if (!v || typeof v !== "object") continue;
		if (!ALL_CAPABILITIES.includes(cap)) {
			notes.push(`skipped unknown capability "${cap}"`);
			continue;
		}
		const model = (v as { model?: unknown }).model;
		if (typeof model !== "string" || !model.trim()) continue;
		spec.capabilities ??= {};
		spec.capabilities[cap] = model.trim();
		const effort = (v as { effort?: unknown }).effort;
		if (typeof effort === "string") {
			if (isThinkingLevel(effort)) {
				spec.effort ??= {};
				spec.effort[cap] = effort;
			} else {
				notes.push(`dropped effort "${effort}" for ${cap} (not an HT thinking level)`);
			}
		}
	}
	return { spec, notes };
}

// -----------------------------------------------------------------------------
// Aliases (derived from the live registry, never a static table)
// -----------------------------------------------------------------------------

export interface AvailableModel {
	provider: string;
	id: string;
	name?: string;
}

const REGION_RE = /^(global|eu|us|apac|ap|jp|au|ca)\./;
const VENDOR_RE = /^(anthropic|openai|amazon|google|meta|mistral|deepseek|xai|minimax|qwen|cohere|ai21|moonshotai|zai)\./;
const DATE_SUFFIX_RE = /-\d{8}(-v\d+(:\d+)?)?$/;
const VERSION_SUFFIX_RE = /-v\d+(:\d+)?$/;

/** `amazon-bedrock/global.anthropic.claude-fable-5-1` -> `fable-5-1`. */
export function shortName(canonical: string): string {
	const id = canonical.includes("/") ? canonical.slice(canonical.indexOf("/") + 1) : canonical;
	return id
		.replace(REGION_RE, "")
		.replace(VENDOR_RE, "")
		.replace(DATE_SUFFIX_RE, "")
		.replace(VERSION_SUFFIX_RE, "")
		.replace(/^claude-/, "");
}

/**
 * All the names a model answers to, most specific first:
 *   global.anthropic.claude-fable-5-1 -> fable-5-1, claude-fable-5-1, fable
 *   gpt-6-astra                       -> gpt-6-astra, astra, gpt-6
 *   gpt-5.6-terra                     -> gpt-5.6-terra, terra, gpt-5.6
 *   global.anthropic.claude-haiku-4-5-20251001-v1:0 -> haiku-4-5, claude-haiku-4-5, haiku
 */
export function deriveAliases(id: string): string[] {
	const out = new Set<string>();
	const stripped = id.replace(REGION_RE, "").replace(VENDOR_RE, "").replace(DATE_SUFFIX_RE, "").replace(VERSION_SUFFIX_RE, "");
	out.add(stripped);
	const noClaude = stripped.replace(/^claude-/, "");
	out.add(noClaude);
	// Family: leading alphabetic run before the first "-<digit>".
	const family = /^([a-z][a-z0-9.]*?)(?=-\d|$)/i.exec(noClaude)?.[1];
	if (family && family !== noClaude) out.add(family);
	// Codename: trailing alphabetic segment after a numeric one (gpt-6-astra -> astra, gpt-6).
	const codename = /^(.*-\d+(?:\.\d+)?)-([a-z][a-z0-9]*)$/i.exec(noClaude);
	if (codename) {
		out.add(codename[2]);
		out.add(codename[1]);
	}
	return [...out].map((a) => a.toLowerCase()).filter(Boolean);
}

export interface AliasTable {
	/** alias -> canonical provider/id candidates */
	byAlias: Map<string, string[]>;
	models: AvailableModel[];
}

export function buildAliasTable(models: AvailableModel[]): AliasTable {
	const byAlias = new Map<string, string[]>();
	for (const m of models) {
		const canonical = `${m.provider}/${m.id}`;
		const names = new Set<string>([m.id.toLowerCase(), canonical.toLowerCase(), ...deriveAliases(m.id)]);
		if (m.name) names.add(m.name.toLowerCase());
		for (const a of names) {
			const list = byAlias.get(a) ?? [];
			if (!list.includes(canonical)) list.push(canonical);
			byAlias.set(a, list);
		}
	}
	return { byAlias, models };
}

function regionRank(id: string): number {
	const m = REGION_RE.exec(id)?.[1];
	if (!m) return 1;
	return m === "global" ? 0 : m === "us" ? 2 : 3;
}

function isDated(id: string): boolean {
	return DATE_SUFFIX_RE.test(id);
}

/**
 * Pick one canonical id out of several that share an alias.
 * Order: preferred provider, then undated over dated, then global > bare >
 * regional, then highest version (numeric-aware descending).
 */
export function chooseCandidate(candidates: string[], preference: string[]): string {
	const rank = (c: string) => {
		const provider = c.slice(0, c.indexOf("/"));
		const id = c.slice(c.indexOf("/") + 1);
		const p = preference.indexOf(provider);
		return [p === -1 ? preference.length : p, isDated(id) ? 1 : 0, regionRank(id)];
	};
	return [...candidates].sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
		// Highest version first: numeric-aware compare, descending.
		return b.localeCompare(a, undefined, { numeric: true });
	})[0];
}

export interface AliasResolution {
	model?: string;
	error?: string;
	/** Set when the alias existed on several providers and preference decided. */
	note?: string;
}

/**
 * Resolve a user-facing spec to an exact `provider/id`.
 *  - `provider/pattern`: exact id, else exact alias within that provider, else
 *    unique-ish substring (undated alias preferred, highest version).
 *  - bare alias: alias table, provider preference decides collisions.
 * Unknown names get up to 5 suggestions.
 */
export function resolveAlias(spec: string, table: AliasTable, preference: string[] = DEFAULT_PROVIDER_PREFERENCE): AliasResolution {
	const s = spec.trim();
	if (!s) return { error: "empty model spec" };
	const lower = s.toLowerCase();
	const providers = [...new Set(table.models.map((m) => m.provider))];

	const slash = s.indexOf("/");
	if (slash !== -1) {
		const providerRaw = s.slice(0, slash);
		const pattern = s.slice(slash + 1).toLowerCase();
		const provider = providers.find((p) => p.toLowerCase() === providerRaw.toLowerCase());
		if (!provider) return { error: `unknown provider "${providerRaw}" (providers: ${providers.join(", ")})` };
		const inProvider = table.models.filter((m) => m.provider === provider);
		const exact = inProvider.find((m) => m.id.toLowerCase() === pattern);
		if (exact) return { model: `${provider}/${exact.id}` };
		const viaAlias = (table.byAlias.get(pattern) ?? []).filter((c) => c.startsWith(`${provider}/`));
		if (viaAlias.length > 0) return { model: chooseCandidate(viaAlias, [provider]) };
		const partial = inProvider.filter((m) => m.id.toLowerCase().includes(pattern) || (m.name ?? "").toLowerCase().includes(pattern));
		if (partial.length > 0) return { model: chooseCandidate(partial.map((m) => `${provider}/${m.id}`), [provider]) };
		return { error: `no model matching "${pattern}" under provider "${provider}"${suggest(pattern, table)}` };
	}

	const candidates = table.byAlias.get(lower);
	if (!candidates || candidates.length === 0) {
		return { error: `unknown model alias "${s}"${suggest(lower, table)}` };
	}
	const chosen = chooseCandidate(candidates, preference);
	const providersHit = [...new Set(candidates.map((c) => c.slice(0, c.indexOf("/"))))];
	if (providersHit.length > 1) {
		const others = candidates.filter((c) => !c.startsWith(chosen.slice(0, chosen.indexOf("/") + 1)));
		return {
			model: chosen,
			note: `"${s}" also exists as ${others.join(", ")}; picked ${chosen} by provider preference (${preference.join(" > ")}). Write provider/alias to be explicit.`,
		};
	}
	return { model: chosen };
}

function suggest(needle: string, table: AliasTable): string {
	const nice = [...table.byAlias.keys()].filter((a) => !a.includes("/") && !a.includes(".") && !a.includes(":"));
	const hits = nice
		.filter((a) => a.includes(needle) || needle.includes(a))
		.sort((a, b) => a.length - b.length)
		.slice(0, 5);
	return hits.length > 0 ? `; did you mean: ${hits.join(", ")}` : "";
}

/**
 * The aliases worth showing a human: short, no punctuation noise, and not
 * merely the raw id. Grouped by the canonical model they resolve to under the
 * given preference.
 */
export function listShortcuts(table: AliasTable, preference: string[] = DEFAULT_PROVIDER_PREFERENCE): Array<{ alias: string; model: string; alsoOn: string[] }> {
	const out: Array<{ alias: string; model: string; alsoOn: string[] }> = [];
	const rawIds = new Set(table.models.map((m) => m.id.toLowerCase()));
	for (const [alias, candidates] of table.byAlias) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(alias) || alias.length > 24) continue; // no display names, paths, ids with dots
		if (rawIds.has(alias)) continue; // raw id, not a shortcut
		if (alias.startsWith("claude-") && table.byAlias.has(alias.slice(7))) continue; // `fable-5-1` already listed
		if (alias === "gpt" || alias === "claude") continue; // too broad to be useful
		const model = chooseCandidate(candidates, preference);
		const chosenProvider = model.slice(0, model.indexOf("/"));
		const alsoOn = [...new Set(candidates.map((c) => c.slice(0, c.indexOf("/"))).filter((p) => p !== chosenProvider))];
		out.push({ alias, model, alsoOn });
	}
	return out.sort((a, b) => a.alias.localeCompare(b.alias));
}

// -----------------------------------------------------------------------------
// Precedence merge
// -----------------------------------------------------------------------------

export type BindingSource = "flag" | `profile:${string}` | "adapter:legacy" | "dynamic" | "fallback";

export interface Binding {
	model: string;
	effort?: string;
}

/** One precedence layer: capability -> spec (alias or provider/id) [+ effort]. */
export interface Layer {
	source: BindingSource;
	/** true when specs are already canonical provider/ids (dynamic, fallback). */
	bindings: Record<string, Binding>;
}

export interface ResolvedAdapter {
	adapter: Record<string, Binding>;
	sources: Record<string, BindingSource>;
	/** original spec the user wrote, per capability (for display). */
	specs: Record<string, string>;
	warnings: string[];
	notes: string[];
}

/** Expand `tiers` into per-capability bindings. */
export function tiersToBindings(tiers: Partial<Record<Tier, string>> | undefined): Record<string, Binding> {
	const out: Record<string, Binding> = {};
	if (!tiers) return out;
	for (const tier of Object.keys(tiers) as Tier[]) {
		const spec = tiers[tier];
		if (!spec) continue;
		for (const cap of TIER_CAPABILITIES[tier]) out[cap] = { model: spec };
	}
	return out;
}

/**
 * Capability-by-capability merge. For each capability, the first layer whose
 * spec resolves wins; an unresolvable spec at a user layer (flag/profile/
 * adapter) is a warning and falls through — the caller decides whether that
 * aborts (it does, for /orchestrate). Effort: `runEffort` > per-capability
 * effort map > the winning binding's own effort.
 */
export function mergeLayers(
	layers: Layer[],
	table: AliasTable,
	preference: string[],
	effortMap: Record<string, string> = {},
	runEffort?: string,
): ResolvedAdapter {
	const out: ResolvedAdapter = { adapter: {}, sources: {}, specs: {}, warnings: [], notes: [] };
	const caps = new Set<string>(ALL_CAPABILITIES);
	for (const l of layers) for (const c of Object.keys(l.bindings)) caps.add(c);

	// De-duplicate identical failure messages across the many capabilities one
	// tier spec feeds.
	const failed = new Map<string, string[]>();
	const noted = new Set<string>();

	for (const cap of caps) {
		for (const layer of layers) {
			const b = layer.bindings[cap];
			if (!b) continue;
			const res = resolveAlias(b.model, table, preference);
			if (!res.model) {
				const key = `(${layer.source}) ${b.model}: ${res.error}`;
				failed.set(key, [...(failed.get(key) ?? []), cap]);
				continue;
			}
			if (res.note && !noted.has(res.note)) {
				noted.add(res.note);
				out.notes.push(res.note);
			}
			const effort = runEffort ?? effortMap[cap] ?? b.effort;
			out.adapter[cap] = { model: res.model, ...(effort ? { effort } : {}) };
			out.sources[cap] = layer.source;
			out.specs[cap] = b.model;
			break;
		}
	}
	for (const [key, capsHit] of failed) {
		out.warnings.push(`${capsHit.join(", ")} ${key} — falling back`);
	}
	return out;
}

/** Warnings that came from a layer the user wrote (as opposed to dynamic/fallback). */
export function userLayerWarnings(resolved: ResolvedAdapter): string[] {
	return resolved.warnings.filter((w) => /\((flag|profile:[^)]+|adapter:legacy)\)/.test(w));
}

/** Human-readable table grouped by tier, one row per distinct model. */
export function formatAdapterTable(resolved: ResolvedAdapter): string[] {
	const lines: string[] = [];
	for (const tier of TIERS) {
		const byModel = new Map<string, string[]>();
		for (const cap of TIER_CAPABILITIES[tier]) {
			const b = resolved.adapter[cap];
			if (!b) continue;
			const spec = resolved.specs[cap];
			const alias = spec && spec.toLowerCase() !== b.model.toLowerCase() && !spec.includes("/") ? `${spec} → ` : "";
			const key = `${alias}${b.model}${b.effort ? ` @${b.effort}` : ""} [${resolved.sources[cap]}]`;
			byModel.set(key, [...(byModel.get(key) ?? []), cap]);
		}
		for (const [key, caps] of byModel) {
			lines.push(`${tier.padEnd(8)} ${key}`);
			lines.push(`         └ ${caps.join(", ")}`);
		}
	}
	return lines;
}

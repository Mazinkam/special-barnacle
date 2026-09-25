/**
 * `/orchestrator-models` (B4.6): manage which models `/orchestrate` uses.
 * Replaces the previous 9-way `switch` over subcommands with a subcommand
 * table (`Record<string, SubcommandHandler>`) — same output/notify messages
 * for every subcommand, including unknown/no-args (which default to "show").
 *
 * commands/* must not import index.ts. `resolveAdapter`/`availableModels`/
 * `loadProfiles`/`writeProfilesFile`/`checkModels`/`profilesPath` are
 * required fields on `deps`; index.ts's caller supplies its own real ones
 * (each already closed over `PROFILES_PATH`/`ctx.modelRegistry`/etc.).
 */
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";

import { emptyOverrides, type ModelOverrides, parseArgs } from "../core/args.ts";
import type { FullResolution } from "../adapters/adapter-resolver.ts";
import type { LoadedProfiles } from "../adapters/profiles-store.ts";
import {
	ALL_CAPABILITIES,
	type AvailableModel,
	buildAliasTable,
	DEFAULT_PROVIDER_PREFERENCE,
	formatAdapterTable,
	isThinkingLevel,
	isTier,
	listShortcuts,
	PROFILE_NAME_RE,
	type ProfileSpec,
	type ProfilesFile,
	resolveAlias,
	type ResolvedAdapter,
	THINKING_LEVELS,
	TIER_CAPABILITIES,
	TIERS,
	userLayerWarnings,
} from "../models.ts";

/** The seams `registerOrchestratorModelsCommand` needs; index.ts's caller supplies the real ones. */
export interface OrchestratorModelsDeps {
	resolveAdapter(ctx: ExtensionContext, overrides?: ModelOverrides): Promise<FullResolution>;
	availableModels(ctx: ExtensionContext): AvailableModel[];
	loadProfiles(): LoadedProfiles;
	writeProfilesFile(file: ProfilesFile): void;
	/** Live per-model connectivity probe (`/orchestrator-models validate --live` / `check`). */
	checkModels(ctx: ExtensionContext, resolved: ResolvedAdapter): Promise<boolean>;
	/** Where `orchestrator-profiles.json` lives; shown in usage/error text. */
	profilesPath: string;
}

function buildModelsUsage(profilesPath: string): string {
	return [
		"Usage:",
		"  /orchestrator-models                       resolved table for the active profile",
		"  /orchestrator-models show [PROFILE]        resolved table for a profile",
		"  /orchestrator-models list                  aliases you can use + full catalog",
		"  /orchestrator-models validate [PROFILE] [--live]   offline check; --live probes every model",
		"  /orchestrator-models check                 = validate --live",
		"  /orchestrator-models set <capability|tier> <ALIAS> [--profile P]",
		"  /orchestrator-models effort <capability> <level|none> [--profile P]",
		"  /orchestrator-models use <PROFILE>         switch active profile",
		"  /orchestrator-models new <PROFILE> [--from P]",
		"  /orchestrator-models pick [PROFILE]        interactive: tiers first, then capability overrides",
		`file: ${profilesPath}`,
	].join("\n");
}

/** Everything a subcommand handler needs for one invocation. */
interface SubcommandInput {
	ctx: ExtensionContext;
	sub: string;
	/** Non-flag tokens after the subcommand, in order. */
	positional: string[];
	/** Every token after the subcommand, flags included (e.g. to find `--from`'s value). */
	rest: string[];
	parsed: ReturnType<typeof parseArgs>;
	deps: OrchestratorModelsDeps;
	modelsUsage: string;
	/** Resolve + notify the resolved model table for a profile; shared by show/validate/use/set/pick. */
	showResolved(profile?: string): Promise<FullResolution>;
}

type SubcommandHandler = (input: SubcommandInput) => Promise<void>;

const show: SubcommandHandler = async ({ positional, parsed, showResolved }) => {
	await showResolved(positional[0] ?? parsed.models.profile);
};

const list: SubcommandHandler = async ({ ctx, deps }) => {
	const models = deps.availableModels(ctx);
	const table = buildAliasTable(models);
	const profiles = deps.loadProfiles();
	const preference = profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE;
	const shortcuts = listShortcuts(table, preference);
	const byProvider = new Map<string, string[]>();
	for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m.id]);
	const width = Math.min(20, Math.max(...shortcuts.map((s) => s.alias.length), 5));
	ctx.ui.notify(
		[
			`Aliases (provider preference: ${preference.join(" > ")}; write provider/alias to force one):`,
			...shortcuts.map((s) => `  ${s.alias.padEnd(width)} → ${s.model}${s.alsoOn.length ? `  (also on ${s.alsoOn.join(", ")})` : ""}`),
			"",
			`Full catalog (${models.length} models configured):`,
			...[...byProvider.entries()].flatMap(([prov, ids]) => [`  ${prov} (${ids.length}):`, ...ids.sort().map((id) => `    ${id}`)]),
		].join("\n"),
		"info",
	);
};

const validateOrCheck: SubcommandHandler = async ({ ctx, sub, positional, parsed, deps, showResolved }) => {
	const resolved = await showResolved(positional[0] ?? parsed.models.profile);
	const problems = [...resolved.profiles.problems, ...userLayerWarnings(resolved)];
	if (problems.length > 0) {
		ctx.ui.notify(`Offline validation: FAIL (${problems.length} problem(s)) — /orchestrate would refuse to dispatch.`, "error");
		return;
	}
	ctx.ui.notify("Offline validation: OK — every binding resolves to a configured model.", "info");
	if (sub === "check" || parsed.check) await deps.checkModels(ctx, resolved);
};

const use: SubcommandHandler = async ({ ctx, positional, deps, showResolved }) => {
	const name = positional[0];
	const profiles = deps.loadProfiles();
	if (!name || !profiles.file.profiles[name]) {
		ctx.ui.notify(`Unknown profile "${name ?? ""}". Have: ${Object.keys(profiles.file.profiles).join(", ")}`, "error");
		return;
	}
	profiles.file.active_profile = name;
	deps.writeProfilesFile(profiles.file);
	ctx.ui.notify(`Active profile → "${name}"`, "info");
	await showResolved(name);
};

const create: SubcommandHandler = async ({ ctx, positional, rest, deps }) => {
	const name = positional[0];
	if (!name || !PROFILE_NAME_RE.test(name)) {
		ctx.ui.notify(`Profile name must match ${PROFILE_NAME_RE}`, "error");
		return;
	}
	const profiles = deps.loadProfiles();
	if (profiles.file.profiles[name]) {
		ctx.ui.notify(`Profile "${name}" already exists.`, "error");
		return;
	}
	const fromIdx = rest.indexOf("--from");
	const from = fromIdx !== -1 ? rest[fromIdx + 1] : undefined;
	const base: ProfileSpec = from ? structuredClone(profiles.file.profiles[from] ?? {}) : {};
	if (from && !profiles.file.profiles[from]) {
		ctx.ui.notify(`--from profile "${from}" does not exist.`, "error");
		return;
	}
	profiles.file.profiles[name] = { ...base, description: from ? `copied from ${from}` : undefined };
	deps.writeProfilesFile(profiles.file);
	ctx.ui.notify(`Created profile "${name}"${from ? ` from "${from}"` : ""}. Activate with: /orchestrator-models use ${name}`, "info");
};

const set: SubcommandHandler = async ({ ctx, positional, parsed, deps, modelsUsage, showResolved }) => {
	const [target, spec] = positional;
	if (!target || !spec) {
		ctx.ui.notify(`Usage: /orchestrator-models set <capability|cheap|mid|premium|frontier> <alias|provider/model> [--profile P]\n${modelsUsage}`, "error");
		return;
	}
	if (!isTier(target) && !ALL_CAPABILITIES.includes(target)) {
		ctx.ui.notify(`"${target}" is not a tier (cheap|mid|premium|frontier) or capability (${ALL_CAPABILITIES.join(", ")})`, "error");
		return;
	}
	const profiles = deps.loadProfiles();
	const name = parsed.models.profile ?? profiles.file.active_profile;
	const profile = (profiles.file.profiles[name] ??= {});
	const table = buildAliasTable(deps.availableModels(ctx));
	const res = resolveAlias(spec, table, profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE);
	if (!res.model) {
		ctx.ui.notify(`${res.error}\nNothing written. /orchestrator-models list shows valid aliases.`, "error");
		return;
	}
	if (isTier(target)) (profile.tiers ??= {})[target] = spec;
	else (profile.capabilities ??= {})[target] = spec;
	deps.writeProfilesFile(profiles.file);
	ctx.ui.notify(`${name}.${target} = ${spec} → ${res.model}${res.note ? `\nnote: ${res.note}` : ""}`, "info");
	await showResolved(name);
};

const effort: SubcommandHandler = async ({ ctx, positional, parsed, deps }) => {
	const [cap, level] = positional;
	if (!cap || !level || !ALL_CAPABILITIES.includes(cap) || (level !== "none" && !isThinkingLevel(level))) {
		ctx.ui.notify(`Usage: /orchestrator-models effort <capability> <${THINKING_LEVELS.join("|")}|none> [--profile P]`, "error");
		return;
	}
	const profiles = deps.loadProfiles();
	const name = parsed.models.profile ?? profiles.file.active_profile;
	const profile = (profiles.file.profiles[name] ??= {});
	if (level === "none") delete profile.effort?.[cap];
	else (profile.effort ??= {})[cap] = level;
	deps.writeProfilesFile(profiles.file);
	ctx.ui.notify(`${name}.effort.${cap} = ${level}`, "info");
};

const pick: SubcommandHandler = async ({ ctx, positional, deps, showResolved }) => {
	if (!ctx.hasUI) {
		ctx.ui.notify("pick needs an interactive session; use `set` instead.", "error");
		return;
	}
	const profiles = deps.loadProfiles();
	const name = positional[0] ?? profiles.file.active_profile;
	if (positional[0] && !PROFILE_NAME_RE.test(positional[0])) {
		ctx.ui.notify(`Profile name must match ${PROFILE_NAME_RE}`, "error");
		return;
	}
	const profile = (profiles.file.profiles[name] ??= {});
	const table = buildAliasTable(deps.availableModels(ctx));
	const preference = profiles.file.provider_preference ?? DEFAULT_PROVIDER_PREFERENCE;
	const shortcuts = listShortcuts(table, preference);
	// Options: short aliases first (what people think in), then every raw provider/id.
	const options = [
		...shortcuts.map((s) => `${s.alias}  →  ${s.model}`),
		...[...new Set(table.models.map((m) => `${m.provider}/${m.id}`))].sort(),
	];
	const KEEP = "(keep current)";
	const CLEAR = "(clear — fall through to next layer)";
	const pickOne = async (title: string, current: string | undefined) => {
		const choice = await ctx.ui.select(`${title}${current ? `  [current: ${current}]` : ""}`, [KEEP, CLEAR, ...options]);
		if (choice === undefined || choice === KEEP) return "keep" as const;
		if (choice === CLEAR) return "clear" as const;
		return choice.includes("  →  ") ? choice.split("  →  ")[0].trim() : choice;
	};
	// Tiers first — three picks cover every capability.
	for (const tier of TIERS) {
		const r = await pickOne(`${tier} tier (${TIER_CAPABILITIES[tier].join(", ")})`, profile.tiers?.[tier]);
		if (r === "clear") delete profile.tiers?.[tier];
		else if (r !== "keep") (profile.tiers ??= {})[tier] = r;
	}
	// Then optional per-capability overrides until Done.
	const DONE = "(done)";
	while (true) {
		const cap = await ctx.ui.select(
			"Override a single capability? (tiers already cover all of them)",
			[DONE, ...ALL_CAPABILITIES.map((c) => `${c}${profile.capabilities?.[c] ? `  = ${profile.capabilities[c]}` : ""}`)],
		);
		if (cap === undefined || cap === DONE) break;
		const capName = cap.split("  =")[0].trim();
		const r = await pickOne(`model for ${capName}`, profile.capabilities?.[capName]);
		if (r === "clear") delete profile.capabilities?.[capName];
		else if (r !== "keep") (profile.capabilities ??= {})[capName] = r;
	}
	deps.writeProfilesFile(profiles.file);
	ctx.ui.notify(`Saved profile "${name}".`, "info");
	const resolved = await showResolved(name);
	const problems = [...resolved.profiles.problems, ...userLayerWarnings(resolved)];
	if (problems.length > 0) ctx.ui.notify(`Validation: FAIL (${problems.length}) — see warnings above.`, "error");
	else if (await ctx.ui.confirm("Validation OK", "Run a live probe on each configured model now? (a few cents)")) await deps.checkModels(ctx, resolved);
};

/** Keyed by subcommand name; `orchestrator-models <goal-that-isn't-a-flag>` with no match falls through to `default`. */
const SUBCOMMANDS: Record<string, SubcommandHandler> = {
	show,
	list,
	validate: validateOrCheck,
	check: validateOrCheck,
	use,
	new: create,
	set,
	effort,
	pick,
};

export function registerOrchestratorModelsCommand(pi: ExtensionAPI, deps: OrchestratorModelsDeps): void {
	const modelsUsage = buildModelsUsage(deps.profilesPath);
	pi.registerCommand("orchestrator-models", {
		description:
			"Manage which models /orchestrate uses. Subcommands: show|list|validate [--live]|check|set|effort|use|new|pick. " +
			"Aliases like fable-5-1, opus-5-5, sonnet-5, gpt-6-sol, gpt-6-luna, astra resolve against your configured models.",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : "show";
			const rest = tokens[0] && !tokens[0].startsWith("--") ? tokens.slice(1) : tokens;
			const VALUE_FLAGS = new Set(["--profile", "--from", "--effort", "--cheap", "--mid", "--premium", "--frontier", "--model"]);
			const positional = rest.filter((t, i) => !t.startsWith("--") && !VALUE_FLAGS.has(rest[i - 1] ?? ""));
			// Flags (--profile, --live, ...) come from the same parser as /orchestrate;
			// bare words land in `goal`, which we ignore here in favour of `positional`.
			const parsed = parseArgs(`x ${rest.join(" ")}`);

			const showResolved = async (profile?: string) => {
				const resolved = await deps.resolveAdapter(ctx, { ...emptyOverrides(), profile });
				const p = resolved.profiles;
				const lines = [
					`Profile "${resolved.profileName}"${resolved.profileName === p.file.active_profile ? " (active)" : ""}${p.file.profiles[resolved.profileName]?.description ? ` — ${p.file.profiles[resolved.profileName].description}` : ""}`,
					"precedence: --flags > profile capabilities > profile tiers > cost-tier resolver > fallback",
					...formatAdapterTable(resolved).map((l) => `  ${l}`),
					...(resolved.notes.length > 0 ? ["", ...resolved.notes.map((n) => `  note: ${n}`)] : []),
					...(resolved.warnings.length > 0 ? ["", "warnings:", ...resolved.warnings.map((w) => `  - ${w}`)] : []),
					...(p.notes.length > 0 ? ["", ...p.notes.map((n) => `  ${n}`)] : []),
					"",
					`profiles: ${Object.keys(p.file.profiles).map((n) => (n === p.file.active_profile ? `*${n}` : n)).join(", ")}  file: ${deps.profilesPath}${p.present ? "" : " (not created yet)"}`,
					"commands: /orchestrator-models list | set <cap|tier> <alias> | use <profile> | pick | validate --live",
				];
				ctx.ui.notify(lines.join("\n"), resolved.warnings.length > 0 ? "warning" : "info");
				return resolved;
			};

			const handler = SUBCOMMANDS[sub];
			if (!handler) {
				ctx.ui.notify(`Unknown subcommand "${sub}".\n${modelsUsage}`, "error");
				return;
			}
			await handler({ ctx, sub, positional, rest, parsed, deps, modelsUsage, showResolved });
		},
	});
}

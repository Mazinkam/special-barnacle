import { describe, expect, test } from "bun:test";
import {
	buildAliasTable,
	chooseCandidate,
	deriveAliases,
	formatAdapterTable,
	listShortcuts,
	mergeLayers,
	migrateAdapterToProfile,
	parseProfilesFile,
	resolveAlias,
	shortName,
	tiersToBindings,
	userLayerWarnings,
	METHOD,
	TIERS,
	TIER_LITERALS,
	isTier,
	tierOf,
	type AvailableModel,
} from "./models.ts";

const MODELS: AvailableModel[] = [
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-fable-5-1" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-fable-5" },
	{ provider: "amazon-bedrock", id: "eu.anthropic.claude-fable-5" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5" },
	{ provider: "amazon-bedrock", id: "eu.anthropic.claude-sonnet-5" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-sonnet-4-5-20250929-v1:0" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-haiku-4-5-20251001-v1:0" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-opus-5" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-5.6-terra" },
	{ provider: "openai-codex", id: "gpt-6-astra" },
	{ provider: "openai-codex", id: "gpt-5.6-terra" },
	{ provider: "openai-codex", id: "gpt-5.6-luna" },
	{ provider: "amazon-bedrock", id: "eu.amazon.nova-pro-v1:0", name: "Nova Pro (eu)" },
];
const TABLE = buildAliasTable(MODELS);
const PREF = ["openai-codex", "amazon-bedrock"];

describe("aliases", () => {
	test("deriveAliases strips region/vendor/date/version and yields family + codename", () => {
		expect(deriveAliases("global.anthropic.claude-fable-5-1")).toEqual(
			expect.arrayContaining(["claude-fable-5-1", "fable-5-1", "fable"]),
		);
		expect(deriveAliases("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual(
			expect.arrayContaining(["haiku-4-5", "haiku"]),
		);
		expect(deriveAliases("gpt-6-astra")).toEqual(expect.arrayContaining(["gpt-6-astra", "astra", "gpt-6"]));
		expect(deriveAliases("gpt-5.6-terra")).toEqual(expect.arrayContaining(["terra", "gpt-5.6"]));
	});

	test("shortName", () => {
		expect(shortName("amazon-bedrock/global.anthropic.claude-fable-5-1")).toBe("fable-5-1");
		expect(shortName("amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("haiku-4-5");
		expect(shortName("openai-codex/gpt-6-astra")).toBe("gpt-6-astra");
	});

	test("bare alias on two providers picks by preference and explains", () => {
		const r = resolveAlias("astra", TABLE, PREF);
		expect(r.model).toBe("openai-codex/gpt-6-astra");
		expect(r.note).toContain("amazon-bedrock/global.openai.gpt-6-astra");
		const r2 = resolveAlias("astra", TABLE, ["amazon-bedrock", "openai-codex"]);
		expect(r2.model).toBe("amazon-bedrock/global.openai.gpt-6-astra");
	});

	test("explicit provider/alias wins over preference", () => {
		expect(resolveAlias("amazon-bedrock/astra", TABLE, PREF).model).toBe("amazon-bedrock/global.openai.gpt-6-astra");
		expect(resolveAlias("amazon-bedrock/sonnet-5", TABLE, PREF).model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
	});

	test("family alias prefers undated, global, highest version", () => {
		expect(resolveAlias("fable", TABLE, PREF).model).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
		expect(resolveAlias("sonnet", TABLE, PREF).model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(resolveAlias("sonnet-5", TABLE, PREF).model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(resolveAlias("haiku", TABLE, PREF).model).toBe("amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	test("exact provider/id passes through", () => {
		expect(resolveAlias("amazon-bedrock/eu.anthropic.claude-sonnet-5", TABLE, PREF).model).toBe(
			"amazon-bedrock/eu.anthropic.claude-sonnet-5",
		);
	});

	test("unknown alias errors with suggestions; unknown provider errors", () => {
		const r = resolveAlias("fabel", TABLE, PREF);
		expect(r.model).toBeUndefined();
		expect(r.error).toContain("unknown model alias");
		const r2 = resolveAlias("fab", TABLE, PREF);
		expect(r2.error).toContain("did you mean");
		expect(r2.error).toContain("fable");
		expect(resolveAlias("nope/x", TABLE, PREF).error).toContain("unknown provider");
	});

	test("chooseCandidate orders preference > undated > global > version", () => {
		expect(chooseCandidate(["amazon-bedrock/eu.anthropic.claude-fable-5", "amazon-bedrock/global.anthropic.claude-fable-5"], PREF)).toBe(
			"amazon-bedrock/global.anthropic.claude-fable-5",
		);
	});

	test("listShortcuts hides raw ids and reports other providers", () => {
		const s = listShortcuts(TABLE, PREF);
		const astra = s.find((x) => x.alias === "astra");
		expect(astra?.model).toBe("openai-codex/gpt-6-astra");
		expect(astra?.alsoOn).toEqual(["amazon-bedrock"]);
		expect(s.find((x) => x.alias === "gpt-6-astra")).toBeUndefined(); // raw id
		expect(s.find((x) => x.alias === "fable-5-1")).toBeDefined();
		expect(s.find((x) => x.alias === "claude-fable-5-1")).toBeUndefined(); // redundant with fable-5-1
		expect(s.find((x) => x.alias === "fable")?.alsoOn).toEqual([]); // eu/global are the same provider
		expect(s.find((x) => x.alias === "gpt")).toBeUndefined();
	});
});

describe("profiles file", () => {
	test("valid file parses; problems are collected not thrown", () => {
		const { file, problems } = parseProfilesFile({
			version: 1,
			active_profile: "default",
			profiles: {
				default: { tiers: { premium: "fable-5-1", mid: "sonnet", cheap: "haiku" }, capabilities: { technical_review: "astra" }, effort: { technical_review: "high" } },
			},
		});
		expect(problems).toEqual([]);
		expect(file.profiles.default.capabilities?.technical_review).toBe("astra");
	});

	test("bad tier, capability, effort, active_profile are reported and dropped", () => {
		const { file, problems } = parseProfilesFile({
			version: 1,
			active_profile: "missing",
			profiles: { p: { tiers: { gold: "x" }, capabilities: { nope: "x", architect: "fable" }, effort: { architect: "standard" } } },
		});
		expect(problems.join("\n")).toContain('unknown tier "gold"');
		expect(problems.join("\n")).toContain('unknown capability "nope"');
		expect(problems.join("\n")).toContain("not a thinking level");
		expect(problems.join("\n")).toContain('active_profile "missing"');
		expect(file.profiles.p.capabilities).toEqual({ architect: "fable" });
		expect(file.profiles.p.effort).toEqual({});
	});

	test("migrateAdapterToProfile handles tiers/capabilities and legacy flat form; drops non-HT efforts", () => {
		const { spec, notes } = migrateAdapterToProfile({
			tiers: { premium: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
			capabilities: { technical_review: { model: "openai-codex/gpt-6-astra", effort: "standard" }, security_review: { model: "openai-codex/gpt-6-astra", effort: "high" } },
		});
		expect(spec.tiers?.premium).toContain("fable-5-1");
		expect(spec.capabilities?.technical_review).toBe("openai-codex/gpt-6-astra");
		expect(spec.effort).toEqual({ security_review: "high" });
		expect(notes.join()).toContain('dropped effort "standard"');
		const flat = migrateAdapterToProfile({ architect: { model: "x/y" }, bogus: { model: "z" } });
		expect(flat.spec.capabilities).toEqual({ architect: "x/y" });
		expect(flat.notes.join()).toContain("bogus");
	});
});

describe("mergeLayers", () => {
	const dynamic = {
		source: "dynamic" as const,
		bindings: Object.fromEntries(
			["architect", "lead", "worker", "technical_review", "qa_agent"].map((c) => [c, { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" }]),
		),
	};

	test("flag > profile capability > profile tier > dynamic, per capability", () => {
		const r = mergeLayers(
			[
				{ source: "flag", bindings: { architect: { model: "opus" } } },
				{ source: "profile:default", bindings: { technical_review: { model: "astra" } } },
				{ source: "profile:default", bindings: tiersToBindings({ premium: "fable-5-1", cheap: "luna" }) },
				dynamic,
			],
			TABLE,
			PREF,
			{ technical_review: "high" },
		);
		expect(r.adapter.architect.model).toBe("amazon-bedrock/global.anthropic.claude-opus-5");
		expect(r.sources.architect).toBe("flag");
		expect(r.adapter.technical_review).toEqual({ model: "openai-codex/gpt-6-astra", effort: "high" });
		expect(r.adapter.security_review.model).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
		expect(r.sources.security_review).toBe("profile:default");
		expect(r.adapter.worker.model).toContain("luna");
		// `lead` is a premium-tier capability, so the profile's premium tier wins.
		expect(r.adapter.lead.model).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
		expect(r.sources.lead).toBe("profile:default");
		expect(r.adapter.qa_agent.model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(r.notes.join()).toContain("astra");
	});

	test("unresolvable user spec warns once per spec and falls through", () => {
		const r = mergeLayers([{ source: "profile:p", bindings: tiersToBindings({ mid: "sonet" }) }, dynamic], TABLE, PREF);
		expect(r.adapter.lead.model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(r.sources.lead).toBe("dynamic");
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("(profile:p) sonet");
		expect(r.warnings[0]).toContain("lead");
		expect(userLayerWarnings(r)).toHaveLength(1);
	});

	test("run-wide effort overrides everything", () => {
		const r = mergeLayers([dynamic], TABLE, PREF, { lead: "low" }, "max");
		expect(r.adapter.lead.effort).toBe("max");
	});

	test("formatAdapterTable shows alias → canonical and groups by tier", () => {
		const r = mergeLayers([{ source: "profile:default", bindings: tiersToBindings({ premium: "fable-5-1" }) }, dynamic], TABLE, PREF);
		const t = formatAdapterTable(r).join("\n");
		expect(t).toContain("premium  fable-5-1 → amazon-bedrock/global.anthropic.claude-fable-5-1 [profile:default]");
		expect(t).toContain("architect, security_review");
	});
});

describe("method.json (canonical orchestration method)", () => {
	const { METHOD, TIER_CAPABILITIES, ALL_CAPABILITIES, rereviewFloor, reconWorkers, tierOf } = require("./models.ts");

	test("tier table is derived from method.json, not hand-written", () => {
		for (const [cap, spec] of Object.entries(METHOD.capabilities) as [string, { tier: string }][]) {
			expect(tierOf(cap)).toBe(spec.tier);
		}
		expect(ALL_CAPABILITIES.length).toBe(Object.keys(METHOD.capabilities).length);
		expect(TIER_CAPABILITIES.cheap).toContain("implementation_fast");
		expect(TIER_CAPABILITIES.premium).toContain("architect");
	});

	test("Rule 1 floors come from data", () => {
		expect(rereviewFloor("low").tier_min).toBe("mid");
		expect(rereviewFloor("high").tier_min).toBe("premium");
		expect(rereviewFloor("critical").independent_review).toBe(true);
		expect(rereviewFloor("garbage")).toEqual(METHOD.rules.review_after_fix.escalation_by_risk.medium);
	});

	test("Rule 2 recon worker count follows complexity bands", () => {
		expect(reconWorkers(4)).toBe(0);
		expect(reconWorkers(5)).toBe(3);
		expect(reconWorkers(8)).toBe(4);
		expect(reconWorkers(10)).toBe(5);
		expect(reconWorkers(9, "investigation")).toBe(0);
	});

	test("Rule 2: a complexity above every band's max (missing band) skips recon, matching planReconTasks (B4.7)", () => {
		// method.json's workers_by_complexity currently tops out at max 10; a complexity above
		// that has no matching band. recon.ts's planReconTasks() treats a missing band as 0
		// workers (skip recon) — the actual production behaviour, since it is the function
		// dispatchHierarchical/pipeline/hierarchy.ts calls. reconWorkers must agree, not fall
		// back to the highest band's count.
		const maxBand = Math.max(...METHOD.rules.pre_implementation_recon.workers_by_complexity.map((b: { max: number }) => b.max));
		expect(reconWorkers(maxBand + 1)).toBe(0);
	});
});

describe("tiers", () => {
	test("frontier is a tier and orders above premium", () => {
		expect(METHOD.tiers).toEqual(["cheap", "mid", "premium", "frontier"]);
		expect(TIERS[0]).toBe("frontier");
		expect(isTier("frontier")).toBe(true);
		expect(isTier("ultra")).toBe(false);
	});
	test("the Tier literal union matches method.json's tiers list, in both directions", () => {
		// TIER_LITERALS is the hand-written source of truth the `Tier` type is checked
		// against at compile time (see the comment above `Tier` in models.ts). This test
		// is the runtime half of that guarantee: it must equal METHOD.tiers as a set.
		expect([...TIER_LITERALS].sort()).toEqual([...METHOD.tiers].sort());
		expect(TIER_LITERALS.length as number).toBe(METHOD.tiers.length);
		expect(TIERS.length).toBe(METHOD.tiers.length);
		expect([...TIERS].sort()).toEqual([...METHOD.tiers].sort());
	});
	test("lead sizes sit on mid/premium/frontier", () => {
		expect(tierOf("lead_small")).toBe("mid");
		expect(tierOf("lead")).toBe("premium");
		expect(tierOf("lead_large")).toBe("frontier");
	});
	test("frontier tier binding reaches lead_large", () => {
		expect(tiersToBindings({ frontier: "fable-5-1" }).lead_large).toEqual({ model: "fable-5-1" });
	});
	test("profile tiers accept frontier", () => {
		const { problems, file } = parseProfilesFile({ version: 1, active_profile: "p", profiles: { p: { tiers: { frontier: "fable-5-1" } } } });
		expect(problems).toEqual([]);
		expect(file.profiles.p.tiers?.frontier).toBe("fable-5-1");
	});
});


// ---------------------------------------------------------------------------
// Shipped profiles (bridge/orchestrator-profiles.json)
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyProfilesFile, type ProfileSpec } from "./models.ts";

const CATALOG: AvailableModel[] = [
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-fable-5-1" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-opus-5" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5" },
	{ provider: "amazon-bedrock", id: "global.anthropic.claude-haiku-4-5-20251001-v1:0" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-sol" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-luna" },
	{ provider: "openai-codex", id: "gpt-6-astra" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
	{ provider: "humain-node", id: "claude-sonnet-5" },
	{ provider: "humain-node", id: "glm-5.2" },
	{ provider: "humain-node", id: "minimax-m3" },
	{ provider: "humain-node", id: "qwen3.8-27b" },
	{ provider: "humain-node", id: "kimi-k3" },
	{ provider: "humain-node", id: "humain-m3-research-preview" },
];
const SHIPPED_RAW = JSON.parse(readFileSync(join(import.meta.dir, "../../orchestrator-profiles.json"), "utf-8"));

function resolveShipped(p: ProfileSpec, table = buildAliasTable(CATALOG), name = "p") {
	return mergeLayers(
		[
			{ source: `profile:${name}`, bindings: Object.fromEntries(Object.entries(p.capabilities ?? {}).map(([c, m]) => [c, { model: m }])) },
			{ source: `profile:${name}`, bindings: tiersToBindings(p.tiers) },
		],
		table,
		["openai-codex", "amazon-bedrock"],
		p.effort ?? {},
	);
}

describe("shipped profiles", () => {
	const { file, problems } = parseProfilesFile(SHIPPED_RAW);

	test("parse cleanly with premium active and no default profile", () => {
		expect(problems).toEqual([]);
		expect(file.active_profile).toBe("premium");
		expect(Object.keys(file.profiles).sort()).toEqual(["anthropic", "openai", "oss", "premium"]);
		expect(file.provider_preference).toEqual(["openai-codex", "amazon-bedrock"]);
	});

	test("no haiku and no gpt-5.6 anywhere", () => {
		const text = JSON.stringify(SHIPPED_RAW).toLowerCase();
		expect(text).not.toContain("haiku");
		expect(text).not.toContain("gpt-5.6");
	});

	for (const name of ["premium", "anthropic", "openai", "oss"]) {
		test(`${name} resolves every capability from user layers, never haiku`, () => {
			const r = resolveShipped(file.profiles[name], undefined, name);
			expect(userLayerWarnings(r)).toEqual([]);
			for (const cap of Object.keys(METHOD.capabilities)) {
				expect(r.adapter[cap]?.model, `${name}.${cap}`).toBeDefined();
				expect(r.adapter[cap].model).not.toContain("haiku");
				expect(r.sources[cap]).toBe(`profile:${name}`);
			}
		});
	}

	test("premium binds the agreed lead ladder and cross-vendor review", () => {
		const r = resolveShipped(file.profiles.premium);
		expect(r.adapter.scout.model).toBe("amazon-bedrock/global.openai.gpt-6-luna");
		expect(r.adapter.worker.model).toBe("amazon-bedrock/global.openai.gpt-6-luna");
		expect(r.adapter.lead_small.model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(r.adapter.implementation_strong.model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(r.adapter.lead.model).toBe("amazon-bedrock/global.anthropic.claude-opus-5-5");
		expect(r.adapter.architect.model).toBe("amazon-bedrock/global.anthropic.claude-opus-5-5");
		expect(r.adapter.lead_large.model).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
		expect(r.adapter.technical_review.model).toBe("amazon-bedrock/global.openai.gpt-6-sol");
		expect(r.adapter.security_review.model).toBe("openai-codex/gpt-6-astra");
	});

	test("anthropic is Anthropic-only with a low-effort sonnet cheap tier", () => {
		const r = resolveShipped(file.profiles.anthropic);
		for (const cap of Object.keys(METHOD.capabilities)) expect(r.adapter[cap].model).toContain("anthropic.claude-");
		expect(r.adapter.scout).toEqual({ model: "amazon-bedrock/global.anthropic.claude-sonnet-5", effort: "low" });
		expect(r.adapter.lead_large.model).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
	});

	test("openai is OpenAI-only; premium tier is gpt-6-sol at high effort; codex first for astra", () => {
		const r = resolveShipped(file.profiles.openai);
		for (const cap of Object.keys(METHOD.capabilities)) expect(r.adapter[cap].model).toMatch(/openai/);
		expect(r.adapter.lead).toEqual({ model: "amazon-bedrock/global.openai.gpt-6-sol", effort: "high" });
		expect(r.adapter.lead_small.model).toBe("amazon-bedrock/global.openai.gpt-6-sol");
		expect(r.adapter.lead_small.effort).toBeUndefined();
		expect(r.adapter.lead_large.model).toBe("openai-codex/gpt-6-astra");
		expect(r.adapter.scout.model).toBe("amazon-bedrock/global.openai.gpt-6-luna");
	});

	test("oss stays on humain-node", () => {
		const r = resolveShipped(file.profiles.oss);
		for (const cap of Object.keys(METHOD.capabilities)) expect(r.adapter[cap].model).toStartWith("humain-node/");
	});

	test("empty profiles file defaults to premium", () => {
		expect(emptyProfilesFile().active_profile).toBe("premium");
		expect(Object.keys(emptyProfilesFile().profiles)).toEqual(["premium"]);
	});

	test("an alias missing from the registry is a user-layer warning and leaves the capability unbound", () => {
		const table = buildAliasTable(CATALOG.filter((m) => !m.id.includes("opus-5-5")));
		const r = resolveShipped(file.profiles.premium, table);
		expect(userLayerWarnings(r).some((w) => w.includes("opus-5-5"))).toBe(true);
		expect(r.adapter.lead).toBeUndefined();
	});
});

import { classifyModelName, tierOfModel } from "./models.ts";

describe("tierOfModel", () => {
	const adapter = {
		scout: { model: "amazon-bedrock/global.openai.gpt-6-luna" },
		lead_small: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
		lead: { model: "amazon-bedrock/global.openai.gpt-6-sol", effort: "high" },
		lead_large: { model: "openai-codex/gpt-6-astra" },
	};
	test("highest tier of any capability bound to the model", () => {
		expect(tierOfModel("amazon-bedrock/global.openai.gpt-6-sol", adapter)).toBe("premium");
		expect(tierOfModel("openai-codex/gpt-6-astra", adapter)).toBe("frontier");
		expect(tierOfModel("amazon-bedrock/global.openai.gpt-6-luna", adapter)).toBe("cheap");
	});
	test("falls back to name classification for unbound models", () => {
		expect(tierOfModel("amazon-bedrock/global.anthropic.claude-fable-5-1", {})).toBe("frontier");
		expect(classifyModelName("amazon-bedrock/global.anthropic.claude-opus-5-5")).toBe("premium");
		expect(classifyModelName("global.anthropic.claude-sonnet-5")).toBe("mid");
		expect(classifyModelName("gpt-6-sol")).toBe("mid");
		expect(classifyModelName("openai-codex/gpt-6-astra")).toBe("frontier");
		expect(classifyModelName("gpt-6-luna")).toBe("cheap");
		expect(classifyModelName("humain-node/minimax-m3")).toBe("mid");
		expect(classifyModelName("mystery-9")).toBe("unknown");
	});
});

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
				{ source: "profile:default", bindings: tiersToBindings({ premium: "fable-5-1", cheap: "haiku" }) },
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
		expect(r.adapter.worker.model).toContain("haiku");
		expect(r.adapter.lead.model).toBe("amazon-bedrock/global.anthropic.claude-sonnet-5");
		expect(r.sources.lead).toBe("dynamic");
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
		expect(t).toContain("premium fable-5-1 → amazon-bedrock/global.anthropic.claude-fable-5-1 [profile:default]");
		expect(t).toContain("architect, security_review");
	});
});

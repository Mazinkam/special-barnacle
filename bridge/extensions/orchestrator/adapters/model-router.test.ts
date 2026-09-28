import { describe, expect, test } from "bun:test";
import { buildAliasTable } from "../models.ts";
import { buildCatalog } from "./model-catalog.ts";
import { ModelHealth } from "../run/model-health.ts";
import {
	backupWarnings, formatCandidateGroups, formatCandidates, pickBackup, requirementFor, resolveCandidates, usableModels,
} from "./model-router.ts";

const MODELS = [
	["amazon-bedrock", "global.anthropic.claude-opus-5-5", 1_000_000, 128_000, true],
	["amazon-bedrock", "eu.anthropic.claude-opus-5-5", 1_000_000, 128_000, true],
	["amazon-bedrock", "global.anthropic.claude-fable-5-1", 1_000_000, 128_000, true],
	["amazon-bedrock", "global.anthropic.claude-sonnet-5", 1_000_000, 128_000, true],
	["amazon-bedrock", "global.openai.gpt-6-luna", 1_100_000, 128_000, true],
	["openai-codex", "gpt-6-astra", 272_000, 128_000, true],
	["openai-codex", "gpt-6-luna", 272_000, 128_000, true],
	["humain-node", "minimax-m3", 204_800, 16_384, false],
	["humain-node", "glm-5.2", 1_000_000, 131_072, false],
	["humain-node", "claude-opus-5", undefined, undefined, false],
] as const;
const table = buildAliasTable(MODELS.map(([provider, id]) => ({ provider, id })));
const catalog = buildCatalog(MODELS.map(([provider, id, contextWindow, maxTokens, reasoning]) => ({ provider, id, contextWindow, maxTokens, reasoning })));
const base = { table, preference: ["openai-codex", "amazon-bedrock"], catalog, tierPrimaries: {} };
const view = (c: ReturnType<typeof resolveCandidates>) => c.map((x) => [x.model, x.source, x.qualified, x.reasons]);

describe("requirementFor", () => {
	test("group or default", () => {
		expect(requirementFor("lead_large")).toEqual({ minContext: 256000, minOutput: 64000, effortControl: false });
		expect(requirementFor("qa_agent")).toEqual({ minContext: 200000, minOutput: 32000, effortControl: false });
		expect(requirementFor("not_in_any_group")).toEqual({ minContext: 128000, minOutput: 16000, effortControl: false });
	});
});

describe("resolveCandidates", () => {
	test("capability list beats tier list; minimums checked; unresolved kept as excluded", () => {
		const c = resolveCandidates({
			...base,
			capability: "lead_large",
			primary: "amazon-bedrock/global.anthropic.claude-opus-5-5",
			backups: {
				lead_large: ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra", "humain-node/minimax-m3", "humain-node/glm-5.2", "humain-node/claude-opus-5", "nope/x"],
				frontier: ["openai-codex/gpt-6-luna"],
			},
		});
		expect(view(c)).toEqual([
			["amazon-bedrock/global.anthropic.claude-opus-5-5", "primary", true, ["tier premium below capability tier frontier"]],
			["amazon-bedrock/eu.anthropic.claude-opus-5-5", "backup", false, ["tier premium below capability tier frontier"]],
			["openai-codex/gpt-6-astra", "backup", true, []],
			["humain-node/minimax-m3", "backup", false, ["context 204800 < 256000", "min_output 16384 < 64000", "tier mid below capability tier frontier"]],
			["humain-node/glm-5.2", "backup", false, ["tier mid below capability tier frontier"]],
			["humain-node/claude-opus-5", "backup", false, ["unknown context", "unknown max output", "tier premium below capability tier frontier"]],
			["nope/x", "backup", false, ['unresolved: unknown provider "nope" (providers: amazon-bedrock, openai-codex, humain-node)']],
		]);
		expect(c.find((x) => x.model === "humain-node/glm-5.2")?.effortControl).toBe(false);
	});
	test("tier list, then higher tiers only, duplicates removed", () => {
		const c = resolveCandidates({
			...base,
			capability: "qa_agent",
			primary: "amazon-bedrock/global.anthropic.claude-sonnet-5",
			tierPrimaries: { cheap: "gpt-6-luna", premium: "amazon-bedrock/global.anthropic.claude-opus-5-5", frontier: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
			backups: { mid: ["openai-codex/gpt-6-astra"], premium: ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra"], cheap: ["openai-codex/gpt-6-luna"] },
		});
		expect(c.map((x) => [x.model, x.source])).toEqual([
			["amazon-bedrock/global.anthropic.claude-sonnet-5", "primary"],
			["openai-codex/gpt-6-astra", "backup"],
			["amazon-bedrock/global.anthropic.claude-opus-5-5", "upgrade"],
			["amazon-bedrock/eu.anthropic.claude-opus-5-5", "upgrade"],
			["amazon-bedrock/global.anthropic.claude-fable-5-1", "upgrade"],
		]);
	});
	test("an openai-codex primary gets its Bedrock twin right after it", () => {
		const c = resolveCandidates({ ...base, capability: "worker", primary: "openai-codex/gpt-6-luna", backups: { cheap: ["amazon-bedrock/global.openai.gpt-6-luna"] } });
		expect(c.map((x) => [x.model, x.source])).toEqual([
			["openai-codex/gpt-6-luna", "primary"],
			["amazon-bedrock/global.openai.gpt-6-luna", "twin"],
		]);
	});
	test("the primary is usable even when it fails a minimum; the failure is kept as a warning", () => {
		const c = resolveCandidates({ ...base, capability: "lead_large", primary: "humain-node/minimax-m3" });
		expect(view(c)).toEqual([["humain-node/minimax-m3", "primary", true, ["context 204800 < 256000", "min_output 16384 < 64000", "tier mid below capability tier frontier"]]]);
	});
});

describe("usableModels / pickBackup", () => {
	const cands = resolveCandidates({
		...base, capability: "lead_large", primary: "amazon-bedrock/global.anthropic.claude-opus-5-5",
		backups: { lead_large: ["humain-node/minimax-m3", "amazon-bedrock/global.anthropic.claude-fable-5-1", "amazon-bedrock/eu.anthropic.claude-opus-5-5", "openai-codex/gpt-6-astra"] },
	});
	test("usable = qualified, primary first; no list means just the primary", () => {
		expect(usableModels(cands, "amazon-bedrock/global.anthropic.claude-opus-5-5")).toEqual([
			"amazon-bedrock/global.anthropic.claude-opus-5-5", "amazon-bedrock/global.anthropic.claude-fable-5-1",
			"openai-codex/gpt-6-astra",
		]);
		expect(usableModels(undefined, "a/b")).toEqual(["a/b"]);
		expect(usableModels(cands, "x/override")[0]).toBe("x/override");
	});
	test("backup prefers another provider/region, skips unhealthy, else same region, else none", () => {
		const models = usableModels(cands, "amazon-bedrock/global.anthropic.claude-opus-5-5");
		const cur = models[0];
		expect(pickBackup(models, cur)).toBe("openai-codex/gpt-6-astra");
		const h = new ModelHealth(() => 0);
		h.markUnhealthy("amazon-bedrock/eu.anthropic.claude-opus-5-5", "transient", 10);
		h.markUnhealthy("openai-codex/gpt-6-astra", "transient", 10);
		expect(pickBackup(models, cur, (m) => h.isHealthy(m))).toBe("amazon-bedrock/global.anthropic.claude-fable-5-1");
		expect(pickBackup([cur], cur)).toBeUndefined();
	});
});

describe("formatting", () => {
	const t = {
		lead: resolveCandidates({ ...base, capability: "lead", primary: "amazon-bedrock/global.anthropic.claude-opus-5-5", backups: { lead: ["humain-node/glm-5.2", "humain-node/minimax-m3"] } }),
		architect: resolveCandidates({ ...base, capability: "architect", primary: "amazon-bedrock/global.anthropic.claude-opus-5-5", backups: { architect: ["humain-node/glm-5.2", "humain-node/minimax-m3"] } }),
		scout: resolveCandidates({ ...base, capability: "scout", primary: "humain-node/glm-5.2" }),
	};
	test("one line per candidate list, capabilities grouped", () => {
		expect(formatCandidates(t.lead)).toBe(
			"opus-5-5@amazon-bedrock/global ✓ · glm-5.2@humain-node ✗ tier mid below capability tier premium · minimax-m3@humain-node ✗ context 204800 < 256000; min_output 16384 < 64000; tier mid below capability tier premium",
		);
		expect(formatCandidateGroups(t)).toEqual([
			`lead, architect: ${formatCandidates(t.lead)}`,
			`scout: ${formatCandidates(t.scout)}`,
		]);
	});
	test("warns once for capabilities with no usable backup", () => {
		expect(backupWarnings(t)).toEqual(["no qualifying backup for lead, architect, scout; a provider outage will fail those dispatches"]);
	});
});

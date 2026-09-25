import { describe, expect, test } from "bun:test";

import { FALLBACK_ADAPTER, policyIdFor } from "./adapter-resolver.ts";

/**
 * The historical hand-copied literal (pre-B4.3). `FALLBACK_ADAPTER` is now
 * derived from `bridge/orchestrator-profiles.json`; this pins the derived
 * value against what shipped before, so the derivation can't silently drift
 * routing.
 */
const HISTORICAL_FALLBACK_ADAPTER: Record<string, { model: string; effort?: string }> = {
	scout: { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	worker: { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	implementation_fast: { model: "amazon-bedrock/global.openai.gpt-6-luna" },
	analysis_mid: { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	technical_lead: { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	lead_small: { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	implementation_strong: { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	qa_agent: { model: "amazon-bedrock/global.anthropic.claude-sonnet-5" },
	technical_review: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	integration_review: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	migration_review: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	performance_review: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	api_contract_review: { model: "amazon-bedrock/global.openai.gpt-6-sol" },
	lead: { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	architect: { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	analysis_strong: { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	security_review: { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
	lead_large: { model: "amazon-bedrock/global.anthropic.claude-fable-5-1" },
};

describe("FALLBACK_ADAPTER (derived from bridge/orchestrator-profiles.json)", () => {
	test("equals the historical hand-copied literal", () => {
		expect(FALLBACK_ADAPTER).toEqual(HISTORICAL_FALLBACK_ADAPTER);
	});

	test("covers exactly the historical capability set (nothing added or dropped by the derivation)", () => {
		expect(Object.keys(FALLBACK_ADAPTER).sort()).toEqual(Object.keys(HISTORICAL_FALLBACK_ADAPTER).sort());
	});
});

describe("policyIdFor", () => {
	test("is stable regardless of key order and changes when a binding changes", () => {
		const a = { scout: { model: "x/a" }, lead: { model: "x/b" } };
		const b = { lead: { model: "x/b" }, scout: { model: "x/a" } };
		expect(policyIdFor("premium", a)).toBe(policyIdFor("premium", b));
		expect(policyIdFor("premium", a)).toMatch(/^premium-[0-9a-f]{8}$/);
		expect(policyIdFor("premium", { ...a, lead: { model: "x/c" } })).not.toBe(policyIdFor("premium", a));
	});
});

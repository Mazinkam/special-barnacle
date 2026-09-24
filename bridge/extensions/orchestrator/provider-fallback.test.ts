import { describe, expect, test } from "bun:test";
import { buildAliasTable } from "./models.ts";
import { bedrockFallbackFor, isQuotaError } from "./provider-fallback.ts";

const table = buildAliasTable([
	{ provider: "openai-codex", id: "gpt-6-astra" },
	{ provider: "amazon-bedrock", id: "global.openai.gpt-6-astra" },
	{ provider: "amazon-bedrock", id: "us.openai.gpt-6-astra" },
	{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
]);

describe("provider fallback", () => {
	test("detects quota and rate-limit errors", () => {
		for (const s of [
			"usage limit reached", "429 Too Many Requests", "rate_limit_error", "Rate limit exceeded",
			"Weekly credit cap reached. Resets next week.", "quota exceeded",
		]) expect(isQuotaError(s)).toBe(true);
		for (const s of ["TypeError: x is undefined", "exit 1", "", "unauthorized: access token could not be refreshed"]) {
			expect(isQuotaError(s)).toBe(false);
		}
	});
	test("maps a codex model to its global Bedrock twin", () => {
		expect(bedrockFallbackFor("openai-codex/gpt-6-astra", table)).toBe("amazon-bedrock/global.openai.gpt-6-astra");
	});
	test("no twin, or not a codex model -> null", () => {
		expect(bedrockFallbackFor("openai-codex/gpt-5.3-codex-spark", table)).toBeNull();
		expect(bedrockFallbackFor("amazon-bedrock/global.openai.gpt-6-astra", table)).toBeNull();
		expect(bedrockFallbackFor("unknown", table)).toBeNull();
	});
});

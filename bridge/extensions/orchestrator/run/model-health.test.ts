import { describe, expect, test } from "bun:test";
import { ModelHealth, providerRegion } from "./model-health.ts";

describe("ModelHealth", () => {
	test("unhealthy until the window passes; a longer mark extends, a shorter one does not shorten", () => {
		let t = 0;
		const h = new ModelHealth(() => t);
		h.markUnhealthy("a/x", "transient", 100);
		expect(h.isHealthy("a/x")).toBe(false);
		expect(h.isHealthy("b/y")).toBe(true);
		h.markUnhealthy("a/x", "quota", 10);
		t = 50;
		expect(h.snapshot()).toEqual([{ model: "a/x", cls: "transient", until: 100 }]);
		h.markUnhealthy("a/x", "quota", 200);
		t = 150;
		expect(h.isHealthy("a/x")).toBe(false);
		t = 250;
		expect(h.isHealthy("a/x")).toBe(true);
		expect(h.snapshot()).toEqual([]);
	});
});

describe("providerRegion", () => {
	test.each([
		["amazon-bedrock/global.anthropic.claude-opus-5-5", "amazon-bedrock/global"],
		["amazon-bedrock/eu.anthropic.claude-opus-5-5", "amazon-bedrock/eu"],
		["amazon-bedrock/minimax.minimax-m2", "amazon-bedrock"],
		["openai-codex/gpt-6-astra", "openai-codex"],
		["humain-node/glm-5.2", "humain-node"],
		["bare-model", "bare-model"],
	])("%s -> %s", (model, expected) => expect(providerRegion(model)).toBe(expected));
});

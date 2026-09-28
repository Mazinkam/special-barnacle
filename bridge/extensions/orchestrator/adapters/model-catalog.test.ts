import { describe, expect, test } from "bun:test";
import { buildCatalog, parseModelFacts } from "./model-catalog.ts";

describe("model catalog", () => {
	test("takes context, max output and reasoning from the registry", () => {
		const c = buildCatalog([
			{ provider: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true },
			{ provider: "humain-node", id: "minimax-m3", contextWindow: 204_800, maxTokens: 16_384, reasoning: false },
			{ provider: "x", id: "bad", contextWindow: 0, maxTokens: Number.NaN },
		]);
		expect(c.get("amazon-bedrock/global.anthropic.claude-opus-5-5")).toEqual({ context: 1_000_000, maxOutput: 128_000, effortControl: true });
		expect(c.get("humain-node/minimax-m3")).toEqual({ context: 204_800, maxOutput: 16_384, effortControl: false });
		expect(c.get("x/bad")).toEqual({});
	});
	test("overrides win field by field", () => {
		const c = buildCatalog([{ provider: "humain-node", id: "glm-5.2", contextWindow: 1_000_000, maxTokens: 131_072, reasoning: false }],
			{ "humain-node/glm-5.2": { effortControl: true }, "extra/model": { context: 5 } });
		expect(c.get("humain-node/glm-5.2")).toEqual({ context: 1_000_000, maxOutput: 131_072, effortControl: true });
		expect(c.get("extra/model")).toEqual({ context: 5 });
	});
	test("parseModelFacts validates shape and reports problems", () => {
		const { facts, problems } = parseModelFacts({ version: 1, models: { "a/b": { context: 10, max_output: 5, effort_control: true }, nope: {}, "c/d": { context: -1 }, "e/f": "x" } });
		expect(facts["a/b"]).toEqual({ context: 10, maxOutput: 5, effortControl: true });
		expect(facts["c/d"]).toEqual({});
		expect(problems).toEqual(['model facts: "nope" must be provider/id', "model facts: c/d.context must be a positive integer", 'model facts: "e/f" must be an object']);
		expect(parseModelFacts([]).problems).toEqual(["model facts file is not an object"]);
		expect(parseModelFacts({ version: 2 }).problems).toEqual(["model facts: unsupported version 2 (expected 1)"]);
	});
});

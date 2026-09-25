import { describe, expect, test } from "bun:test";
import { cheapestAtTier, pickModel } from "./routing.ts";

const adapter = {
	implementation_fast: { model: "amazon-bedrock/us.anthropic.claude-haiku-5" },
	worker: { model: "amazon-bedrock/us.anthropic.claude-haiku-5" },
	technical_review: { model: "amazon-bedrock/us.anthropic.claude-sonnet-5" },
	lead: { model: "amazon-bedrock/global.anthropic.claude-opus-5-5" },
};

describe("core/routing.ts pickModel", () => {
	test("retryCount 0 returns the capability's base model", () => {
		expect(pickModel("technical_review", adapter, 0)).toBe(adapter.technical_review.model);
	});

	test("a non-review capability never escalates by retry", () => {
		expect(pickModel("lead", adapter, 3)).toBe(adapter.lead.model);
	});

	test("an unbound capability falls back to worker, then any binding", () => {
		expect(pickModel("nonexistent", adapter, 0)).toBe(adapter.worker.model);
	});

	test("technical_review escalates one tier on retry", () => {
		const escalated = pickModel("technical_review", adapter, 1, "medium");
		expect(escalated).not.toBe(adapter.technical_review.model);
	});
});

describe("core/routing.ts cheapestAtTier", () => {
	test("returns null when no capability is bound at that tier", () => {
		expect(cheapestAtTier({}, "premium", "technical_review")).toBeNull();
	});

	test("prefers the requested capability's own binding at the target tier", () => {
		const m = cheapestAtTier(adapter, "premium", "lead");
		expect(m).toBe(adapter.lead.model);
	});
});

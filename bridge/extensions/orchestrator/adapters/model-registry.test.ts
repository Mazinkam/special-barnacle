import { describe, expect, test } from "bun:test";
import { availableModels } from "./model-registry.ts";
import type { ExtensionContext } from "@humain/terminal";

function ctxWith(getAvailable: () => Array<{ provider: string; id: string; name: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }>): ExtensionContext {
	return { modelRegistry: { getAvailable } } as unknown as ExtensionContext;
}

describe("availableModels", () => {
	test("maps identity and qualification facts off the live model registry", () => {
		const ctx = ctxWith(() => [
			{ provider: "anthropic", id: "claude-x", name: "Claude X", contextWindow: 200_000, maxTokens: 32_000, reasoning: true, extra: "ignored" as never },
		]);
		expect(availableModels(ctx)).toEqual([{ provider: "anthropic", id: "claude-x", name: "Claude X", contextWindow: 200_000, maxTokens: 32_000, reasoning: true }]);
	});

	test("returns an empty list when the registry throws", () => {
		const ctx = ctxWith(() => {
			throw new Error("no registry wired");
		});
		expect(availableModels(ctx)).toEqual([]);
	});

	test("returns an empty list when there are no available models", () => {
		const ctx = ctxWith(() => []);
		expect(availableModels(ctx)).toEqual([]);
	});
});

import { describe, expect, test } from "bun:test";
import { ChildEventAccumulator } from "./child-events.ts";

function messageEnd(message: any) {
	return { type: "message_end", message };
}

describe("ChildEventAccumulator", () => {
	test("agent_settled / agent_end set flags and are reported in the delta", () => {
		const acc = new ChildEventAccumulator();
		expect(acc.absorb({ type: "agent_settled" })).toEqual({ settled: true });
		expect(acc.sawAgentSettled).toBe(true);
		expect(acc.absorb({ type: "agent_end" })).toEqual({ ended: true });
		expect(acc.sawAgentEnd).toBe(true);
	});

	test("a top-level stopReason is captured and reported even with no turn", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb({ type: "some_other_event", stopReason: "aborted" });
		expect(delta.topLevelStopReason).toBe("aborted");
		expect(acc.stopReason).toBe("aborted");
		expect(delta.turn).toBeUndefined();
	});

	test("a non-assistant message_end is ignored entirely", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(messageEnd({ role: "user", content: "hi", usage: { input: 5 } }));
		expect(delta.turn).toBeUndefined();
		expect(acc.usage.turns).toBe(0);
	});

	test("a turn with no usage block counts no turn/cost, but text and model still absorb", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(messageEnd({ role: "assistant", model: "claude-sonnet", content: "hello" }));
		expect(delta.turn).toEqual({ costDelta: 0, hadUsage: false, model: "claude-sonnet", stopReason: undefined, errorMessage: undefined, errorKind: undefined, text: "hello" });
		expect(acc.usage.turns).toBe(0);
		expect(acc.usage.cost).toBe(0);
		expect(acc.model).toBe("claude-sonnet");
	});

	test("a full turn accumulates usage, cost, turns, and prefers responseModel over model", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(
			messageEnd({
				role: "assistant",
				model: "claude-sonnet",
				responseModel: "claude-sonnet-4-5",
				stopReason: "stop",
				content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }],
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { total: 0.0123 } },
			}),
		);
		expect(delta.turn).toEqual({
			costDelta: 0.0123, hadUsage: true, model: "claude-sonnet-4-5", stopReason: "stop",
			errorMessage: undefined, errorKind: undefined, text: "part one\npart two",
		});
		expect(acc.usage).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.0123, contextTokens: 165, turns: 1 });
		expect(acc.model).toBe("claude-sonnet-4-5");
		expect(acc.stopReason).toBe("stop");
		expect(acc.costReported).toBe(true);
	});

	test("costReported goes false once any turn fails to report a valid cost, and stays false", () => {
		const acc = new ChildEventAccumulator();
		acc.absorb(messageEnd({ role: "assistant", usage: { input: 1, cost: { total: 0.01 } } }));
		expect(acc.costReported).toBe(true);
		acc.absorb(messageEnd({ role: "assistant", usage: { input: 1, cost: {} } }));
		expect(acc.costReported).toBe(false);
		acc.absorb(messageEnd({ role: "assistant", usage: { input: 1, cost: { total: 0.02 } } }));
		expect(acc.costReported).toBe(false);
	});

	test("cost of exactly $0 still counts as reported", () => {
		const acc = new ChildEventAccumulator();
		acc.absorb(messageEnd({ role: "assistant", usage: { input: 1, cost: { total: 0 } } }));
		expect(acc.costReported).toBe(true);
		expect(acc.usage.cost).toBe(0);
	});

	test("a provider error turn surfaces errorMessage/errorKind and still counts cost/turns", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(
			messageEnd({ role: "assistant", stopReason: "error", errorMessage: "quota exceeded", usage: { input: 1, cost: { total: 0.001 } } }),
		);
		expect(delta.turn?.errorMessage).toBe("quota exceeded");
		expect(delta.turn?.errorKind).toBe("error");
		expect(acc.usage.turns).toBe(1);
		expect(acc.usage.cost).toBe(0.001);
	});

	test("aborted stopReason with an empty errorMessage does not surface an error", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(messageEnd({ role: "assistant", stopReason: "aborted", errorMessage: "", usage: { input: 1 } }));
		expect(delta.turn?.errorMessage).toBeUndefined();
		expect(delta.turn?.errorKind).toBeUndefined();
	});

	test("a plain string content turn is trimmed into text", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(messageEnd({ role: "assistant", content: "  padded text  ", usage: { input: 1 } }));
		expect(delta.turn?.text).toBe("padded text");
	});

	test("whitespace-only content produces no text", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(messageEnd({ role: "assistant", content: "   ", usage: { input: 1 } }));
		expect(delta.turn?.text).toBeUndefined();
	});

	test("turn-level stopReason overrides a top-level stopReason on the same event, matching the original single-pass order", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb({ ...messageEnd({ role: "assistant", stopReason: "stop", usage: { input: 1 } }), stopReason: "aborted" });
		expect(delta.topLevelStopReason).toBe("aborted");
		expect(delta.turn?.stopReason).toBe("stop");
		expect(acc.stopReason).toBe("stop");
	});

	test("multiple turns accumulate cost/usage cumulatively", () => {
		const acc = new ChildEventAccumulator();
		acc.absorb(messageEnd({ role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.01 } } }));
		acc.absorb(messageEnd({ role: "assistant", usage: { input: 20, output: 15, cost: { total: 0.02 } } }));
		expect(acc.usage.turns).toBe(2);
		expect(acc.usage.input).toBe(30);
		expect(acc.usage.output).toBe(20);
		expect(acc.usage.cost).toBeCloseTo(0.03, 10);
	});

	test("an unparseable/negative cost.total is treated as no cost reported for that turn", () => {
		const acc = new ChildEventAccumulator();
		const delta = acc.absorb(messageEnd({ role: "assistant", usage: { input: 1, cost: { total: -5 } } }));
		expect(delta.turn?.costDelta).toBe(0);
		expect(acc.costReported).toBe(false);
	});
});

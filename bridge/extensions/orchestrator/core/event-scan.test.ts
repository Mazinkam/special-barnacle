import { describe, expect, test } from "bun:test";
import { scanEvents } from "./event-scan.ts";

const j = (o: unknown) => JSON.stringify(o);
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
	j({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], ...extra } });

describe("scanEvents", () => {
	test("counts finished tools, detects a tool still running, keeps last text and error", () => {
		const s = scanEvents([
			j({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }),
			j({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: {}, isError: false }),
			assistant("first"),
			assistant("second plan"),
			j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Service unavailable: Bedrock is unable to process your request." } }),
			j({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} }),
			"not json",
			"",
		]);
		expect(s.toolCalls).toBe(1);
		expect(s.toolInFlight).toBe(true);
		expect(s.lastAssistantText).toBe("second plan");
		expect(s.lastErrorMessage).toBe("Service unavailable: Bedrock is unable to process your request.");
	});
	test("records subagent calls, finished and unfinished nested workers", () => {
		const s = scanEvents([
			j({ type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: { tasks: [
				{ id: "t1", agent: "orch-worker", task: "x", onFailure: { maxAttempts: 2, retryWith: { model: "openai-codex/gpt-6-luna" } } },
				{ id: "t2", agent: "orch-worker", task: "y" },
			] } }),
			j({ type: "tool_execution_end", toolCallId: "s1", toolName: "subagent", isError: false, result: { content: [{ type: "text", text: "Parallel: 2/2" }], details: { results: [
				{ taskId: "t1", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "## Completed\nfixed bug 1" }] }] },
				{ taskId: "t2", exitCode: 1, messages: [] },
			] } } }),
			j({ type: "tool_execution_start", toolCallId: "s2", toolName: "subagent", args: { agent: "orch-worker", task: "z" } }),
		]);
		expect(s.subagentCalls).toEqual([
			{ toolCallId: "s1", tasks: [{ id: "t1", hasRetry: true }, { id: "t2", hasRetry: false }] },
			{ toolCallId: "s2", tasks: [{ id: undefined, hasRetry: false }] },
		]);
		expect(s.finishedWorkers).toEqual([
			{ id: "t1", ok: true, summary: "## Completed" },
			{ id: "t2", ok: false, summary: "" },
		]);
		expect(s.unfinishedWorkers).toEqual(["s2#0"]);
		expect(s.toolInFlight).toBe(true);
	});
	test("never throws on parseable-but-malformed event shapes", () => {
		const malformed = [
			j({ type: "tool_execution_start", toolCallId: { toString: null }, toolName: "bash", args: {} }),
			j({ type: "tool_execution_end", toolCallId: { toString: null }, toolName: "bash", result: {}, isError: false }),
			j({ type: "tool_execution_start", toolCallId: 5, toolName: "subagent", args: { tasks: [{ id: { toString: null }, onFailure: { retryWith: { model: { toString: null } } } }] } }),
			j({ type: "tool_execution_end", toolCallId: 5, toolName: "subagent", result: { details: { results: [{ taskId: { toString: null }, agent: { toString: null }, exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: { toString: null } }] }] }] } } }),
			j({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: { toString: null } }], stopReason: "error", errorMessage: { toString: null } } }),
			j({ type: { toString: null } }),
			j(42),
			j(null),
			j([]),
			"not json",
			"",
		];
		expect(() => scanEvents(malformed)).not.toThrow();
	});

	describe("bounded retained text fields", () => {
		test("lastAssistantText keeps only the last 32000 characters, as a tail", () => {
			const huge = `HEAD${"a".repeat(40000)}`;
			const s = scanEvents([assistant(huge)]);
			expect(s.lastAssistantText.length).toBe(32000);
			expect(s.lastAssistantText).not.toContain("HEAD");
			expect(s.lastAssistantText.endsWith("a".repeat(100))).toBe(true);
		});
		test("lastAssistantText under the cap is unchanged", () => {
			const s = scanEvents([assistant("short reply")]);
			expect(s.lastAssistantText).toBe("short reply");
		});
		test("lastErrorMessage keeps only the first 2000 characters", () => {
			const huge = `HEAD${"c".repeat(3000)}`;
			const s = scanEvents([
				j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: huge } }),
			]);
			expect(s.lastErrorMessage?.length).toBe(2000);
			expect(s.lastErrorMessage?.startsWith("HEAD")).toBe(true);
		});
		test("toolCallId ids are capped to 200 characters, on both start and end", () => {
			const hugeId = "x".repeat(500);
			const s = scanEvents([
				j({ type: "tool_execution_start", toolCallId: hugeId, toolName: "bash", args: {} }),
				j({ type: "tool_execution_end", toolCallId: hugeId, toolName: "bash", result: {}, isError: false }),
			]);
			// A matching capped id on both start and end still resolves the tool call
			// (toolInFlight false, exactly one finished call) -- counts stay exact.
			expect(s.toolCalls).toBe(1);
			expect(s.toolInFlight).toBe(false);
		});
		test("nested worker ids (from asId) are capped to 200 characters; counts stay exact", () => {
			const hugeTaskId = "y".repeat(500);
			const s = scanEvents([
				j({ type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: { tasks: [{ id: "t1" }, { id: "t2" }] } }),
				j({ type: "tool_execution_end", toolCallId: "s1", toolName: "subagent", result: { details: { results: [
					{ taskId: hugeTaskId, exitCode: 0, messages: [] },
					{ taskId: "t2", exitCode: 0, messages: [] },
				] } } }),
			]);
			expect(s.finishedWorkers).toHaveLength(2);
			expect(s.finishedWorkers[0]?.id.length).toBe(200);
			expect(s.finishedWorkers[0]?.id).toBe(hugeTaskId.slice(0, 200));
		});
		test("args.tasks[].id is capped to 200 characters in subagentCalls and unfinishedWorkers; counts stay exact", () => {
			const hugeId = "z".repeat(500);
			const s = scanEvents([
				j({ type: "tool_execution_start", toolCallId: "s1", toolName: "subagent", args: { tasks: [
					{ id: hugeId },
					{ id: "t2" },
				] } }),
			]);
			expect(s.subagentCalls).toHaveLength(1);
			expect(s.subagentCalls[0]?.tasks).toHaveLength(2);
			expect(s.subagentCalls[0]?.tasks[0]?.id?.length).toBe(200);
			expect(s.subagentCalls[0]?.tasks[0]?.id).toBe(hugeId.slice(0, 200));
			expect(s.unfinishedWorkers).toHaveLength(2);
			expect(s.unfinishedWorkers[0]?.length).toBe(200);
			expect(s.unfinishedWorkers[0]).toBe(hugeId.slice(0, 200));
		});
		test("does not reject or drop long lines, and never caps counts", () => {
			const manyAssistantMessages = Array.from({ length: 50 }, (_, i) => assistant(`msg ${i} `.repeat(1000)));
			const s = scanEvents(manyAssistantMessages);
			expect(s.lastAssistantText.length).toBeLessThanOrEqual(32000);
			expect(s.lastAssistantText).toContain("msg 49");
		});
	});
});

import { describe, expect, test } from "bun:test";
import { DispatchTelemetryTracker, isObservablePollCall } from "./dispatch-telemetry.ts";

describe("isObservablePollCall", () => {
	test("detects orchestrator_status regardless of args", () => {
		expect(isObservablePollCall("orchestrator_status", undefined)).toBe(true);
		expect(isObservablePollCall("orchestrator_status", { anything: 1 })).toBe(true);
	});

	test("detects a bash sleep with a numeric duration", () => {
		expect(isObservablePollCall("bash", { command: "sleep 5" })).toBe(true);
		expect(isObservablePollCall("bash", { command: "echo hi && sleep 30 && echo done" })).toBe(true);
	});

	test("does not match bash commands that merely mention sleep without a duration", () => {
		expect(isObservablePollCall("bash", { command: "grep sleep file.txt" })).toBe(false);
	});

	test("does not match non-bash, non-status tools", () => {
		expect(isObservablePollCall("edit", { command: "sleep 5" })).toBe(false);
		expect(isObservablePollCall("bash", { path: "sleep 5" })).toBe(false);
	});

	test("tolerates missing/malformed args", () => {
		expect(isObservablePollCall("bash", undefined)).toBe(false);
		expect(isObservablePollCall("bash", null)).toBe(false);
		expect(isObservablePollCall("bash", "sleep 5")).toBe(false);
	});
});

describe("DispatchTelemetryTracker", () => {
	test("counts own tool calls and mix", () => {
		const t = new DispatchTelemetryTracker();
		t.observeToolCall("bash", { command: "ls" });
		t.observeToolCall("read", { path: "a.ts" });
		t.observeToolCall("read", { path: "b.ts" });
		const fields = t.fields(3);
		expect(fields.own_tool_calls).toBe(3);
		expect(fields.own_tool_mix).toEqual({ bash: 1, read: 2 });
	});

	test("counts delegated subagent calls as a subset of own tool calls", () => {
		const t = new DispatchTelemetryTracker();
		t.observeToolCall("subagent", { tasks: [1, 2] });
		t.observeToolCall("subagent", { tasks: [1] });
		t.observeToolCall("read", { path: "a.ts" });
		const fields = t.fields(1);
		expect(fields.own_tool_calls).toBe(3);
		expect(fields.delegated_subagent_calls).toBe(2);
		expect(fields.own_tool_mix.subagent).toBe(2);
	});

	test("counts observable polls (sleep + orchestrator_status) without affecting other counters", () => {
		const t = new DispatchTelemetryTracker();
		t.observeToolCall("bash", { command: "sleep 5" });
		t.observeToolCall("orchestrator_status", {});
		t.observeToolCall("bash", { command: "ls" });
		const fields = t.fields(1);
		expect(fields.observable_poll_calls).toBe(2);
		expect(fields.own_tool_calls).toBe(3);
	});

	test("peak_context_tokens is null when no usage was ever observed", () => {
		const t = new DispatchTelemetryTracker();
		const fields = t.fields(0);
		expect(fields.peak_context_tokens).toBeNull();
		expect(fields.context_token_semantics).toBe("provider_total_tokens_per_message");
	});

	test("peak_context_tokens tracks the max across messages, ignoring 0/invalid readings", () => {
		const t = new DispatchTelemetryTracker();
		t.observeContextTokens(1000);
		t.observeContextTokens(0);
		t.observeContextTokens(NaN);
		t.observeContextTokens(undefined);
		t.observeContextTokens(500);
		t.observeContextTokens(2500);
		const fields = t.fields(3);
		expect(fields.peak_context_tokens).toBe(2500);
	});

	test("dispatch_phase is included only when provided", () => {
		const t = new DispatchTelemetryTracker();
		expect(t.fields(0).dispatch_phase).toBeUndefined();
		expect(t.fields(0, "implementation").dispatch_phase).toBe("implementation");
	});

	test("turns is supplied by the caller and passed through unchanged", () => {
		const t = new DispatchTelemetryTracker();
		expect(t.fields(7).turns).toBe(7);
	});
});

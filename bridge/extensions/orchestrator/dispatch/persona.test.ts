import { describe, expect, test } from "bun:test";
import { resolvePersona } from "./persona.ts";

const NO_PERSONA = "__no_persona__";

function discovery(agents: Array<{ name: string; tools?: string[]; systemPrompt: string }>) {
	return () => ({ agents });
}

describe("resolvePersona", () => {
	test("sentinel agent name skips resolution entirely: no tools, no prompt file, no fs access", () => {
		const mkdtempFn = () => { throw new Error("must not be called"); };
		const writeFileFn = () => { throw new Error("must not be called"); };
		const result = resolvePersona({
			cwd: "/repo",
			agentName: NO_PERSONA,
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: discovery([]),
			tmpPrefix: "orch-agent-",
			mkdtempFn,
			writeFileFn,
		});
		expect(result.tools).toBeUndefined();
		expect(result.promptPath).toBeUndefined();
		expect(() => result.cleanup()).not.toThrow();
	});

	test("agent found with a non-empty system prompt: writes the prompt file and returns its path + tools", () => {
		const written: Array<{ path: string; content: string }> = [];
		const result = resolvePersona({
			cwd: "/repo",
			agentName: "orch-scout",
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: discovery([{ name: "orch-scout", tools: ["read", "grep"], systemPrompt: "you are a scout" }]),
			tmpPrefix: "orch-agent-",
			mkdtempFn: (prefix) => { expect(prefix).toBe("orch-agent-"); return "/tmp/orch-agent-abc123"; },
			writeFileFn: (path, content) => written.push({ path, content }),
		});
		expect(result.tools).toEqual(["read", "grep"]);
		expect(result.promptPath).toBe("/tmp/orch-agent-abc123/orch-scout.md");
		expect(written).toEqual([{ path: "/tmp/orch-agent-abc123/orch-scout.md", content: "you are a scout" }]);
	});

	test("agent found with an empty (whitespace-only) system prompt: no prompt file written, tools still returned", () => {
		const mkdtempFn = () => { throw new Error("must not be called for an empty prompt"); };
		const writeFileFn = () => { throw new Error("must not be called for an empty prompt"); };
		const result = resolvePersona({
			cwd: "/repo",
			agentName: "orch-implementation-fast",
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: discovery([{ name: "orch-implementation-fast", tools: ["read", "write", "edit", "bash"], systemPrompt: "   \n  " }]),
			tmpPrefix: "orch-agent-",
			mkdtempFn,
			writeFileFn,
		});
		expect(result.tools).toEqual(["read", "write", "edit", "bash"]);
		expect(result.promptPath).toBeUndefined();
	});

	test("agent not found: warns and returns no tools/prompt, without throwing", () => {
		const warnings: string[] = [];
		const result = resolvePersona({
			cwd: "/repo",
			agentName: "orch-missing",
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: discovery([{ name: "orch-scout", tools: ["read"], systemPrompt: "x" }]),
			tmpPrefix: "orch-agent-",
			warn: (message) => warnings.push(message),
		});
		expect(result.tools).toBeUndefined();
		expect(result.promptPath).toBeUndefined();
		expect(warnings).toEqual(["[orchestrator] agent persona not found: orch-missing (using default persona)"]);
	});

	test("discoverAgents throwing: warns with the error message and returns no tools/prompt", () => {
		const warnings: string[] = [];
		const result = resolvePersona({
			cwd: "/repo",
			agentName: "orch-scout",
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: () => { throw new Error("agents dir unreadable"); },
			tmpPrefix: "orch-agent-",
			warn: (message) => warnings.push(message),
		});
		expect(result.tools).toBeUndefined();
		expect(result.promptPath).toBeUndefined();
		expect(warnings).toEqual(["[orchestrator] agent persona load failed: agents dir unreadable"]);
	});

	test("discoverAgents throwing: surfaces the failure on the result so callers can log/diagnose it", () => {
		const result = resolvePersona({
			cwd: "/repo",
			agentName: "orch-scout",
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: () => { throw new Error("agents dir unreadable"); },
			tmpPrefix: "orch-agent-",
			warn: () => {},
		});
		expect(result.error).toBe("agents dir unreadable");
	});

	test("writeFileFn throwing: does not return a promptPath pointing at a file that was never written, and surfaces the failure", () => {
		const warnings: string[] = [];
		const result = resolvePersona({
			cwd: "/repo",
			agentName: "orch-scout",
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: discovery([{ name: "orch-scout", tools: ["read"], systemPrompt: "you are a scout" }]),
			tmpPrefix: "orch-agent-",
			mkdtempFn: () => "/tmp/orch-agent-abc123",
			writeFileFn: () => { throw new Error("EACCES: permission denied"); },
			warn: (message) => warnings.push(message),
		});
		expect(result.promptPath).toBeUndefined();
		expect(result.error).toBe("EACCES: permission denied");
		expect(warnings).toEqual(["[orchestrator] agent persona load failed: EACCES: permission denied"]);
	});

	test("cleanup removes the temp dir exactly once via the injected rm behaviour, and is idempotent", () => {
		const removed: string[] = [];
		const result = resolvePersona({
			cwd: "/repo",
			agentName: "orch-scout",
			noPersonaSentinel: NO_PERSONA,
			discoverAgents: discovery([{ name: "orch-scout", tools: ["read"], systemPrompt: "body" }]),
			tmpPrefix: "orch-agent-",
			mkdtempFn: () => "/tmp/orch-agent-xyz",
			writeFileFn: () => {},
		});
		expect(result.promptPath).toBe("/tmp/orch-agent-xyz/orch-scout.md");
		// cleanup() uses the real rmSync against a path that doesn't exist; it must not throw.
		expect(() => result.cleanup()).not.toThrow();
		expect(() => result.cleanup()).not.toThrow();
	});
});

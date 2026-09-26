import { describe, expect, test } from "bun:test";
import { buildChildArgs, buildChildEnv, personaCanMutateFor } from "./child-args.ts";

describe("buildChildArgs", () => {
	test("bare model, no effort, no persona, no tools", () => {
		expect(buildChildArgs({ model: "claude-sonnet", task: "do the thing" })).toEqual([
			"--mode", "json", "-p", "--no-session",
			"--model", "claude-sonnet",
			"--no-extensions", "--no-skills", "--no-prompt-templates",
			"do the thing",
		]);
	});

	test("provider/model is split into --provider and --model", () => {
		expect(buildChildArgs({ model: "amazon-bedrock/claude-sonnet-4", task: "t" })).toEqual([
			"--mode", "json", "-p", "--no-session",
			"--provider", "amazon-bedrock",
			"--model", "claude-sonnet-4",
			"--no-extensions", "--no-skills", "--no-prompt-templates",
			"t",
		]);
	});

	test("effort adds --thinking", () => {
		expect(buildChildArgs({ model: "m", effort: "high", task: "t" })).toEqual([
			"--mode", "json", "-p", "--no-session",
			"--model", "m",
			"--thinking", "high",
			"--no-extensions", "--no-skills", "--no-prompt-templates",
			"t",
		]);
	});

	test("promptPath adds --append-system-prompt before --tools", () => {
		expect(buildChildArgs({ model: "m", promptPath: "/tmp/orch-agent-xyz/orch-scout.md", tools: ["read", "grep"], task: "t" })).toEqual([
			"--mode", "json", "-p", "--no-session",
			"--model", "m",
			"--append-system-prompt", "/tmp/orch-agent-xyz/orch-scout.md",
			"--tools", "read,grep",
			"--no-extensions", "--no-skills", "--no-prompt-templates",
			"t",
		]);
	});

	test("empty tools array is treated as no tools", () => {
		expect(buildChildArgs({ model: "m", tools: [], task: "t" })).toEqual([
			"--mode", "json", "-p", "--no-session",
			"--model", "m",
			"--no-extensions", "--no-skills", "--no-prompt-templates",
			"t",
		]);
	});

	test("full representative dispatch: provider/model, effort, persona prompt, tools", () => {
		expect(
			buildChildArgs({
				model: "openai-codex/gpt-5",
				effort: "medium",
				promptPath: "/tmp/orch-agent-abc/orch-implementation-fast.md",
				tools: ["read", "write", "edit", "bash"],
				task: "implement the thing",
			}),
		).toEqual([
			"--mode", "json", "-p", "--no-session",
			"--provider", "openai-codex",
			"--model", "gpt-5",
			"--thinking", "medium",
			"--append-system-prompt", "/tmp/orch-agent-abc/orch-implementation-fast.md",
			"--tools", "read,write,edit,bash",
			"--no-extensions", "--no-skills", "--no-prompt-templates",
			"implement the thing",
		]);
	});
});

describe("personaCanMutateFor", () => {
	test("no tools at all (default tool set) can mutate", () => {
		expect(personaCanMutateFor(undefined)).toBe(true);
	});
	test("an explicitly empty tools array cannot mutate (no write/edit in an empty list)", () => {
		expect(personaCanMutateFor([])).toBe(false);
	});
	test("read-only allow-list cannot mutate", () => {
		expect(personaCanMutateFor(["read", "grep", "find", "ls", "bash"])).toBe(false);
	});
	test("allow-list with write can mutate", () => {
		expect(personaCanMutateFor(["read", "write"])).toBe(true);
	});
	test("allow-list with edit can mutate", () => {
		expect(personaCanMutateFor(["read", "edit"])).toBe(true);
	});
});

describe("buildChildEnv", () => {
	test("copies baseEnv through and overlays orchestrator-dispatch fields, clearing supacode vars", () => {
		const baseEnv = { PATH: "/usr/bin", SUPACODE_SESSION: "abc123", SUPACODE_TAB_ID: "tab-1", HOME: "/home/x" };
		expect(buildChildEnv(baseEnv, { cwd: "/repo" })).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/x",
			HUMAIN_TERMINAL_RUNTIME: "orchestrator-dispatch",
			CODING_AGENT_RUNTIME: "humain-terminal",
			CODING_AGENT_REPOSITORY: "/repo",
			SUPACODE_SESSION: undefined,
			SUPACODE_TAB_ID: undefined,
		});
	});

	test("baseEnv without supacode vars still gets them explicitly cleared", () => {
		const baseEnv = { PATH: "/usr/bin" };
		const env = buildChildEnv(baseEnv, { cwd: "/work/repo" });
		expect(env.SUPACODE_SESSION).toBeUndefined();
		expect(env.SUPACODE_TAB_ID).toBeUndefined();
		expect(env.CODING_AGENT_REPOSITORY).toBe("/work/repo");
		expect(env.PATH).toBe("/usr/bin");
	});
});

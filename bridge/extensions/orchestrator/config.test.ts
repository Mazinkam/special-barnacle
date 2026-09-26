import { describe, expect, test } from "bun:test";
import { expandHome, loadBridgeConfig } from "./config.ts";
import contract from "./contract.json";

const HOME = "/home/test-user";

describe("config.ts expandHome", () => {
	test("expands a leading ~ to home", () => {
		expect(expandHome("~/foo/bar", HOME)).toBe("/home/test-user/foo/bar");
	});

	test("leaves an already-absolute path unchanged", () => {
		expect(expandHome("/already/absolute", HOME)).toBe("/already/absolute");
	});

	test("only expands a LEADING ~, not one elsewhere in the path", () => {
		expect(expandHome("/foo/~bar", HOME)).toBe("/foo/~bar");
	});
});

describe("config.ts loadBridgeConfig defaults", () => {
	test("defaults skillRoot/stateRoot/python and expands ~ against home", () => {
		const cfg = loadBridgeConfig({}, HOME);
		expect(cfg.skillRoot).toBe("~/.local/share/agent-skills/hierarchical-agent-orchestrator");
		expect(cfg.expandedSkillRoot).toBe(`${HOME}/.local/share/agent-skills/hierarchical-agent-orchestrator`);
		expect(cfg.stateRoot).toBe(contract.state_root.default);
		expect(cfg.expandedStateRoot).toBe(expandHome(contract.state_root.default, HOME));
		expect(cfg.python).toBe("python3");
	});

	test("default profiles/legacy-adapter paths live under ~/.humain-terminal/agent", () => {
		const cfg = loadBridgeConfig({}, HOME);
		expect(cfg.profilesPath).toBe(`${HOME}/.humain-terminal/agent/orchestrator-profiles.json`);
		expect(cfg.legacyAdapterPath).toBe(`${HOME}/.humain-terminal/agent/orchestrator-adapter.json`);
	});

	test("numeric ceilings default as before", () => {
		const cfg = loadBridgeConfig({}, HOME);
		expect(cfg.pythonTimeoutMs).toBe(60_000);
		expect(cfg.maxConcurrentDispatches).toBe(4);
		expect(cfg.maxLeads).toBe(contract.max_leads);
		expect(cfg.dispatchTimeoutMs).toBe(20 * 60 * 1000);
		expect(cfg.telemetryFlushMs).toBe(500);
		expect(cfg.telemetryMaxBatch).toBe(100);
		expect(cfg.reconEvidenceMaxChars).toBeGreaterThan(0);
	});

	test("pythonExtraEnv defaults CODING_AGENT_REPOSITORY to process.cwd()", () => {
		const cfg = loadBridgeConfig({}, HOME);
		expect(cfg.pythonExtraEnv.CODING_AGENT_RUNTIME).toBe("humain-terminal");
		expect(cfg.pythonExtraEnv.CODING_AGENT_REPOSITORY).toBe(process.cwd());
	});
});

describe("config.ts loadBridgeConfig env overrides", () => {
	test("every path/binary override wins over its default", () => {
		const cfg = loadBridgeConfig(
			{
				HUMAIN_ORCHESTRATOR_SKILL_ROOT: "/custom/skill",
				[contract.state_root.env_vars.ts]: "/custom/state",
				HUMAIN_ORCHESTRATOR_PYTHON: "python3.11",
				HUMAIN_ORCHESTRATOR_PROFILES_FILE: "/custom/profiles.json",
				HUMAIN_ORCHESTRATOR_ADAPTER_FILE: "/custom/adapter.json",
				CODING_AGENT_REPOSITORY: "/custom/repo",
			},
			HOME,
		);
		expect(cfg.skillRoot).toBe("/custom/skill");
		expect(cfg.expandedSkillRoot).toBe("/custom/skill");
		expect(cfg.stateRoot).toBe("/custom/state");
		expect(cfg.expandedStateRoot).toBe("/custom/state");
		expect(cfg.python).toBe("python3.11");
		expect(cfg.profilesPath).toBe("/custom/profiles.json");
		expect(cfg.legacyAdapterPath).toBe("/custom/adapter.json");
		expect(cfg.pythonExtraEnv.CODING_AGENT_REPOSITORY).toBe("/custom/repo");
	});

	test("a ~-prefixed override is still expanded against home", () => {
		const cfg = loadBridgeConfig({ HUMAIN_ORCHESTRATOR_SKILL_ROOT: "~/other/skill" }, HOME);
		expect(cfg.expandedSkillRoot).toBe(`${HOME}/other/skill`);
	});

	test("every numeric override wins over its default", () => {
		const cfg = loadBridgeConfig(
			{
				HUMAIN_ORCHESTRATOR_PYTHON_TIMEOUT_MS: "1234",
				HUMAIN_ORCHESTRATOR_MAX_CONCURRENCY: "9",
				HUMAIN_ORCHESTRATOR_MAX_LEADS: "3",
				HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS: "5000",
				HUMAIN_ORCHESTRATOR_TELEMETRY_FLUSH_MS: "10",
				HUMAIN_ORCHESTRATOR_TELEMETRY_BATCH: "7",
				HUMAIN_ORCHESTRATOR_RECON_EVIDENCE_MAX_CHARS: "42",
			},
			HOME,
		);
		expect(cfg.pythonTimeoutMs).toBe(1234);
		expect(cfg.maxConcurrentDispatches).toBe(9);
		expect(cfg.maxLeads).toBe(3);
		expect(cfg.dispatchTimeoutMs).toBe(5000);
		expect(cfg.telemetryFlushMs).toBe(10);
		expect(cfg.telemetryMaxBatch).toBe(7);
		expect(cfg.reconEvidenceMaxChars).toBe(42);
	});

	test("a non-positive or non-numeric override falls back to the default instead of coercing to 0", () => {
		const cfg = loadBridgeConfig(
			{ HUMAIN_ORCHESTRATOR_MAX_LEADS: "not-a-number", HUMAIN_ORCHESTRATOR_MAX_CONCURRENCY: "-1" },
			HOME,
		);
		expect(cfg.maxLeads).toBe(contract.max_leads);
		expect(cfg.maxConcurrentDispatches).toBe(4);
	});
});

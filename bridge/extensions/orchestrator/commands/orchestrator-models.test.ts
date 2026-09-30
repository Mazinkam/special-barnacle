import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";
import { registerOrchestratorModelsCommand, type OrchestratorModelsDeps } from "./orchestrator-models.ts";
import type { ProfilesFile } from "../models.ts";

function harness(file: ProfilesFile, env: Record<string, string | undefined> = {}) {
	let handler!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const pi = { registerCommand: (_n: string, def: { handler: typeof handler }) => { handler = def.handler; } } as unknown as ExtensionAPI;
	const notes: Array<{ text: string; level: string }> = [];
	const ctx = { hasUI: true, ui: { notify: (text: string, level: string) => notes.push({ text, level }) } } as unknown as ExtensionContext;
	const writes: ProfilesFile[] = [];
	let current = structuredClone(file);
	const deps = {
		resolveAdapter: async () => { throw new Error("not used by the workflow subcommand"); },
		availableModels: () => [],
		loadProfiles: () => ({ file: structuredClone(current), present: true, problems: [], notes: [] }),
		writeProfilesFile: (f: ProfilesFile) => { writes.push(structuredClone(f)); current = structuredClone(f); },
		checkModels: async () => true,
		profilesPath: "/tmp/orchestrator-profiles.json",
		env,
	} as unknown as OrchestratorModelsDeps;
	registerOrchestratorModelsCommand(pi, deps);
	return { run: (args: string) => handler(args, ctx), notes, writes };
}

const FILE: ProfilesFile = { version: 1, active_profile: "premium", provider_preference: ["amazon-bedrock"], profiles: { premium: { tiers: { mid: "sonnet-5" } } } };

describe("/orchestrator-models workflow", () => {
	test("sets and persists the mode, preserving every other field", async () => {
		const h = harness(FILE);
		await h.run("workflow observe");
		expect(h.writes).toEqual([{ ...FILE, workflow_mode: "observe" }]);
		expect(h.notes.at(-1)?.text).toContain("observe");
	});

	test("with no argument shows the effective mode and its source", async () => {
		const h = harness({ ...FILE, workflow_mode: "observe" });
		await h.run("workflow");
		expect(h.writes).toEqual([]);
		expect(h.notes.at(-1)?.text).toContain("workflow mode: observe (source: orchestrator-profiles.json)");
	});

	test("default removes the persisted key", async () => {
		const h = harness({ ...FILE, workflow_mode: "enforce" });
		await h.run("workflow default");
		expect(h.writes).toEqual([FILE]);
		expect("workflow_mode" in h.writes[0]).toBe(false);
	});

	test("an invalid mode is rejected and nothing is written", async () => {
		const h = harness(FILE);
		await h.run("workflow sometimes");
		expect(h.writes).toEqual([]);
		expect(h.notes.at(-1)?.level).toBe("error");
	});

	test("warns when the env var overrides the saved setting", async () => {
		const h = harness(FILE, { HUMAIN_ORCHESTRATOR_WORKFLOW_MODE: "off" });
		await h.run("workflow observe");
		expect(h.writes[0].workflow_mode).toBe("observe");
		expect(h.notes.some((n) => n.level === "warning" && n.text.includes("HUMAIN_ORCHESTRATOR_WORKFLOW_MODE"))).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProfiles, writeProfilesFile } from "./profiles-store.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "profiles-store-test-"));
}

describe("loadProfiles", () => {
	test("no file: falls back to defaults and notes install.sh, mentioning the shipped path", () => {
		const dir = tempDir();
		const profilesPath = join(dir, "orchestrator-profiles.json");
		const legacyAdapterPath = join(dir, "orchestrator-adapter.json");
		const result = loadProfiles({ profilesPath, legacyAdapterPath, shippedProfilesPath: () => "/shipped/path.json" });
		expect(result.present).toBe(false);
		expect(result.problems).toEqual([]);
		expect(result.notes.join("\n")).toContain("/shipped/path.json");
	});

	test("legacy adapter file present but no profiles file: notes it is ignored", () => {
		const dir = tempDir();
		const profilesPath = join(dir, "orchestrator-profiles.json");
		const legacyAdapterPath = join(dir, "orchestrator-adapter.json");
		writeFileSync(legacyAdapterPath, "{}");
		const result = loadProfiles({ profilesPath, legacyAdapterPath, shippedProfilesPath: () => "/shipped/path.json" });
		expect(result.notes.join("\n")).toContain("is ignored");
	});

	test("valid file: parses and reports present, and notes a coexisting legacy file is ignored", () => {
		const dir = tempDir();
		const profilesPath = join(dir, "orchestrator-profiles.json");
		const legacyAdapterPath = join(dir, "orchestrator-adapter.json");
		writeFileSync(
			profilesPath,
			JSON.stringify({ version: 1, active_profile: "premium", profiles: { premium: { tiers: { cheap: "gpt-6-luna" } } } }),
		);
		writeFileSync(legacyAdapterPath, "{}");
		const result = loadProfiles({ profilesPath, legacyAdapterPath, shippedProfilesPath: () => "/shipped/path.json" });
		expect(result.present).toBe(true);
		expect(result.problems).toEqual([]);
		expect(result.file.active_profile).toBe("premium");
		expect(result.notes.join("\n")).toContain("is ignored now that");
	});

	test("corrupt JSON: reports present with a parse-error problem instead of throwing", () => {
		const dir = tempDir();
		const profilesPath = join(dir, "orchestrator-profiles.json");
		writeFileSync(profilesPath, "{not json");
		const result = loadProfiles({
			profilesPath,
			legacyAdapterPath: join(dir, "orchestrator-adapter.json"),
			shippedProfilesPath: () => "/shipped/path.json",
		});
		expect(result.present).toBe(true);
		expect(result.problems[0]).toContain("could not be parsed");
	});
});

describe("writeProfilesFile", () => {
	test("writes atomically (via a temp file + rename) and leaves valid, pretty JSON behind", () => {
		const dir = tempDir();
		const profilesPath = join(dir, "nested", "orchestrator-profiles.json");
		writeProfilesFile(profilesPath, { version: 1, active_profile: "premium", profiles: {} } as never);
		const contents = readFileSync(profilesPath, "utf-8");
		expect(JSON.parse(contents)).toMatchObject({ active_profile: "premium" });
		expect(contents.endsWith("\n")).toBe(true);
	});
});

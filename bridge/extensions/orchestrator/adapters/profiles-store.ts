/**
 * Reading and writing `orchestrator-profiles.json` (B4.3): the named
 * profiles of alias -> capability/tier bindings the bridge routes through.
 * Every path is a parameter (`profilesPath`, `legacyAdapterPath`); nothing
 * here reads `process.env` or a module global — index.ts wires the real
 * paths from `config.ts`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { emptyProfilesFile, parseProfilesFile, type ProfilesFile } from "../models.ts";

export interface LoadedProfiles {
	file: ProfilesFile;
	/** true when the file exists on disk (vs. synthesized defaults). */
	present: boolean;
	problems: string[];
	notes: string[];
}

/** Write the profiles file atomically: a crash mid-write must not leave a truncated config behind. */
export function writeProfilesFile(profilesPath: string, file: ProfilesFile): void {
	mkdirSync(dirname(profilesPath), { recursive: true });
	const tmp = `${profilesPath}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, profilesPath);
}

export interface LoadProfilesOptions {
	profilesPath: string;
	legacyAdapterPath: string;
	/** Where the profiles shipped with the skill live, for the "run install.sh" note. */
	shippedProfilesPath: () => string;
}

/**
 * Load profiles. When the file does not exist, the caller falls back to the
 * dynamic resolver + fallback bindings; loading never writes (install.sh is
 * what installs the shipped profiles).
 */
export function loadProfiles(opts: LoadProfilesOptions): LoadedProfiles {
	const { profilesPath, legacyAdapterPath, shippedProfilesPath } = opts;
	const notes: string[] = [];
	if (existsSync(profilesPath)) {
		try {
			const { file, problems } = parseProfilesFile(JSON.parse(readFileSync(profilesPath, "utf-8")));
			if (existsSync(legacyAdapterPath)) {
				notes.push(`${legacyAdapterPath} is ignored now that ${profilesPath} exists; delete it to silence this note.`);
			}
			return { file, present: true, problems, notes };
		} catch (err) {
			return {
				file: emptyProfilesFile(),
				present: true,
				problems: [`${profilesPath} could not be parsed: ${(err as Error).message}`],
				notes,
			};
		}
	}
	// No profiles file: run on the dynamic resolver + fallback bindings and say
	// how to get the shipped profiles. Loading never writes: install.sh copies
	// bridge/orchestrator-profiles.json (active "premium"), backing up any file
	// it replaces. The legacy adapter is no longer migrated into a "default"
	// profile; that profile was retired.
	notes.push(`${profilesPath} not found; using dynamic/fallback bindings. Run install.sh to install the shipped profiles (${shippedProfilesPath()}).`);
	if (existsSync(legacyAdapterPath)) {
		notes.push(`${legacyAdapterPath} is ignored; the shipped profiles replace it.`);
	}
	return { file: emptyProfilesFile(), present: false, problems: [], notes };
}

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changedFilesSinceRunStart, diffDirtySnapshots, gitDirtySnapshot, gitHead } from "./git-changes.ts";

describe("changed-file detection around the lead phase", () => {
	function initRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "orch-dirty-snapshot-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		git("config", "commit.gpgsign", "false");
		writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
		git("add", "tracked.ts");
		git("commit", "-q", "-m", "init");
		return dir;
	}

	test("committed work is reported while untouched pre-existing dirty files stay excluded", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			writeFileSync(join(dir, "old-scratch.md"), "existing\n");
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = gitDirtySnapshot(dir);
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "change tracked file");
			// This is the reported failure: a committed change has no dirty snapshot entry.
			expect(gitDirtySnapshot(dir)?.has("tracked.ts")).toBe(false);
			const result = changedFilesSinceRunStart(dir, beforeHead, beforeDirty, ["tracked.ts", "old-scratch.md"]);
			expect(result.changed).toEqual(["tracked.ts"]);
			expect(result.phantom).toEqual(["old-scratch.md"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committed and new dirty files are both reported without duplicates", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = gitDirtySnapshot(dir);
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "change tracked file");
			writeFileSync(join(dir, "tracked.ts"), "export const a = 3;\n");
			writeFileSync(join(dir, "new.ts"), "export {};\n");
			expect(changedFilesSinceRunStart(dir, beforeHead, beforeDirty, []).changed.sort()).toEqual(["new.ts", "tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committing untouched pre-existing dirty content does not claim it as new work", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			writeFileSync(join(dir, "tracked.ts"), "existing dirty content\n");
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = gitDirtySnapshot(dir);
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "commit old dirty file");
			const result = changedFilesSinceRunStart(dir, beforeHead, beforeDirty, ["tracked.ts"]);
			expect(result.changed).toEqual([]);
			expect(result.phantom).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committing an untouched pre-existing staged rename does not claim either path", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			git("mv", "tracked.ts", "renamed.ts");
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			const beforeDirty = gitDirtySnapshot(dir);
			git("commit", "-q", "-m", "commit old rename");
			const result = changedFilesSinceRunStart(dir, beforeHead, beforeDirty, ["tracked.ts", "renamed.ts"]);
			expect(result.changed).toEqual([]);
			expect(result.phantom).toEqual(["tracked.ts", "renamed.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unborn repository reports files committed in its first commit", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-unborn-run-"));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			git("init", "-q");
			git("config", "user.email", "t@example.com");
			git("config", "user.name", "t");
			git("config", "commit.gpgsign", "false");
			const beforeHead = gitHead(dir);
			const beforeDirty = gitDirtySnapshot(dir);
			writeFileSync(join(dir, "new.ts"), "export {};\n");
			git("add", "new.ts");
			git("commit", "-q", "-m", "first commit");
			expect(changedFilesSinceRunStart(dir, beforeHead, beforeDirty, []).changed).toEqual(["new.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing start HEAD falls back to claimed files rather than a report-only verdict", () => {
		const dir = initRepo();
		try {
			const beforeDirty = gitDirtySnapshot(dir);
			expect(changedFilesSinceRunStart(dir, null, beforeDirty, ["tracked.ts"]).changed).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("committed files remain visible if the pre-run dirty snapshot is unavailable", () => {
		const dir = initRepo();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			const beforeHead = git("rev-parse", "HEAD").toString().trim();
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			git("add", "tracked.ts");
			git("commit", "-q", "-m", "change tracked file");
			expect(changedFilesSinceRunStart(dir, beforeHead, null, []).changed).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failed history comparison cannot silently mark reported work as report-only", () => {
		const dir = initRepo();
		try {
			const beforeDirty = gitDirtySnapshot(dir);
			// A missing commit can occur after a branch rewrite while leads execute.
			const result = changedFilesSinceRunStart(dir, "f".repeat(40), beforeDirty, ["tracked.ts"]);
			expect(result.changed).toEqual(["tracked.ts"]);
			expect(result.phantom).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("pre-existing untracked scratch file named in lead prose is a phantom, not a change", () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "scratch.js"), "console.log(1)\n");
			const before = gitDirtySnapshot(dir);
			// Lead runs, touches nothing, but its report mentions `scratch.js`.
			const after = gitDirtySnapshot(dir);
			const result = diffDirtySnapshots(before, after, ["scratch.js"]);
			expect(result.changed).toEqual([]);
			expect(result.phantom).toEqual(["scratch.js"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("pre-dirty file whose content changed during the run is reported as changed", () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "scratch.js"), "v1\n");
			const before = gitDirtySnapshot(dir);
			writeFileSync(join(dir, "scratch.js"), "v2\n");
			const after = gitDirtySnapshot(dir);
			expect(diffDirtySnapshots(before, after, []).changed).toEqual(["scratch.js"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("new, modified-tracked, and deleted-tracked files are all detected", () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "old-untracked.md"), "keep\n");
			const before = gitDirtySnapshot(dir);
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "new file.ts"), "export {};\n");
			writeFileSync(join(dir, "tracked.ts"), "export const a = 2;\n");
			const after = gitDirtySnapshot(dir);
			const changed = diffDirtySnapshots(before, after, ["old-untracked.md"]).changed.sort();
			expect(changed).toEqual(["src/new file.ts", "tracked.ts"]);

			unlinkSync(join(dir, "tracked.ts"));
			const afterDelete = gitDirtySnapshot(dir);
			expect(afterDelete?.get("tracked.ts")).toBe("<deleted>");
			expect(diffDirtySnapshots(after, afterDelete, []).changed).toEqual(["tracked.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resolves paths against the repo root when cwd is a subdirectory", () => {
		const dir = initRepo();
		try {
			mkdirSync(join(dir, "pkg"));
			writeFileSync(join(dir, "pkg", "scratch.js"), "v1\n");
			const before = gitDirtySnapshot(join(dir, "pkg"));
			expect(before?.get("pkg/scratch.js")).not.toBe("<deleted>");
			writeFileSync(join(dir, "pkg", "scratch.js"), "v2\n");
			const after = gitDirtySnapshot(join(dir, "pkg"));
			expect(diffDirtySnapshots(before, after, []).changed).toEqual(["pkg/scratch.js"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("nested repos and staged renames do not abort the snapshot", () => {
		const dir = initRepo();
		try {
			const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
			mkdirSync(join(dir, "inner"));
			execFileSync("git", ["init", "-q"], { cwd: join(dir, "inner"), stdio: "pipe" });
			writeFileSync(join(dir, "inner", "x.txt"), "x\n");
			git("mv", "tracked.ts", "renamed.ts");
			const snap = gitDirtySnapshot(dir);
			expect(snap).not.toBeNull();
			expect(snap?.get("inner/")).toBe("<non-file>");
			expect(snap?.get("renamed.ts")).toMatch(/^[0-9a-f]{40,64}$/);
			expect(snap?.has("tracked.ts")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("diffDirtySnapshots falls back to the de-duplicated scraped list without git snapshots", () => {
		const result = diffDirtySnapshots(null, new Map(), ["a.ts", "a.ts", "b.ts"]);
		expect(result.changed).toEqual(["a.ts", "b.ts"]);
		expect(result.phantom).toEqual([]);
	});
});


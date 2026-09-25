import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { killProcessTree, reapOrphanedPersonaDirs } from "./process-reaper.ts";

describe("killProcessTree", () => {
	test("kills the negative pid (process group) first", () => {
		const calls: Array<[number, NodeJS.Signals | number | undefined]> = [];
		const kill = mock((pid: number, signal?: NodeJS.Signals | number) => {
			calls.push([pid, signal]);
			return true;
		});
		killProcessTree({ pid: 4242, kill: () => true }, kill);
		expect(calls).toEqual([[-4242, "SIGKILL"]]);
	});

	test("falls back to proc.kill when the group is already gone", () => {
		const kill = mock(() => {
			throw new Error("ESRCH");
		});
		const procKill = mock(() => true);
		killProcessTree({ pid: 4242, kill: procKill }, kill);
		expect(procKill).toHaveBeenCalledWith("SIGKILL");
	});

	test("uses proc.kill directly when there is no pid", () => {
		const kill = mock(() => true);
		const procKill = mock(() => true);
		killProcessTree({ kill: procKill }, kill);
		expect(kill).not.toHaveBeenCalled();
		expect(procKill).toHaveBeenCalledWith("SIGKILL");
	});

	test("swallows a proc.kill failure (already gone)", () => {
		const procKill = mock(() => {
			throw new Error("already exited");
		});
		expect(() => killProcessTree({ kill: procKill })).not.toThrow();
	});
});

describe("reapOrphanedPersonaDirs", () => {
	test("removes only prefixed, stale entries and warns once with the count", () => {
		const root = mkdtempSync(join(tmpdir(), "process-reaper-test-"));
		const stale = join(root, "orch-agent-stale");
		const fresh = join(root, "orch-agent-fresh");
		const other = join(root, "not-ours");
		writeFileSync(stale, "x");
		writeFileSync(fresh, "x");
		writeFileSync(other, "x");
		// Backdate the "stale" entry well past the TTL.
		const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
		utimesSync(stale, old, old);

		const warnings: string[] = [];
		reapOrphanedPersonaDirs({
			tmpRoot: root,
			prefix: "orch-agent-",
			ttlMs: 60 * 60 * 1000,
			warn: (m) => warnings.push(m),
		});

		const remaining = readdirSync(root).sort();
		expect(remaining).toEqual(["not-ours", "orch-agent-fresh"]);
		expect(warnings).toEqual([`[orchestrator] reaped 1 orphaned persona temp dir(s) in ${root}`]);
	});

	test("does nothing and does not warn when nothing is stale", () => {
		const root = mkdtempSync(join(tmpdir(), "process-reaper-test-"));
		writeFileSync(join(root, "orch-agent-fresh"), "x");
		const warnings: string[] = [];
		reapOrphanedPersonaDirs({ tmpRoot: root, prefix: "orch-agent-", ttlMs: 60 * 60 * 1000, warn: (m) => warnings.push(m) });
		expect(warnings).toEqual([]);
		expect(readdirSync(root)).toEqual(["orch-agent-fresh"]);
	});

	test("an unreadable tmp root is swallowed, not thrown", () => {
		expect(() =>
			reapOrphanedPersonaDirs({ tmpRoot: "/no/such/dir", prefix: "orch-agent-", ttlMs: 1000 }),
		).not.toThrow();
	});

	test("a single entry's stat failure does not abort the sweep", () => {
		const root = mkdtempSync(join(tmpdir(), "process-reaper-test-"));
		writeFileSync(join(root, "orch-agent-a"), "x");
		const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
		utimesSync(join(root, "orch-agent-a"), old, old);
		writeFileSync(join(root, "orch-agent-b"), "x");
		utimesSync(join(root, "orch-agent-b"), old, old);
		let calls = 0;
		const fakeStat: typeof statSync = ((p: string) => {
			calls++;
			if (p.endsWith("orch-agent-a")) throw new Error("boom");
			return statSync(p);
		}) as typeof statSync;
		const warnings: string[] = [];
		reapOrphanedPersonaDirs({
			tmpRoot: root,
			prefix: "orch-agent-",
			ttlMs: 60 * 60 * 1000,
			warn: (m) => warnings.push(m),
			fs: { readdirSync, statSync: fakeStat, rmSync: require("node:fs").rmSync },
		});
		expect(calls).toBe(2);
		expect(readdirSync(root).sort()).toEqual(["orch-agent-a"]);
		expect(warnings).toEqual([`[orchestrator] reaped 1 orphaned persona temp dir(s) in ${root}`]);
	});
});

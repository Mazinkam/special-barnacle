import { describe, expect, test } from "bun:test";
import {
	detectLiveExtensionTree,
	detectOutOfTreeChanges,
	extractForeignPath,
	isLiveExtensionTree,
	isPathWithin,
	outOfTreeChangesSummaryLine,
	type LiveTreeSeams,
} from "./live-tree.ts";

describe("core/live-tree.ts isPathWithin / isLiveExtensionTree", () => {
	test("a path equal to the parent root is within it", () => {
		expect(isPathWithin("/repo", "/repo")).toBe(true);
	});
	test("a path underneath the parent root is within it", () => {
		expect(isPathWithin("/repo", "/repo/bridge/extensions/orchestrator")).toBe(true);
	});
	test("a sibling directory sharing a prefix is NOT within it", () => {
		expect(isPathWithin("/repo", "/repo-other/x")).toBe(false);
	});
	test("an unrelated path is not within it", () => {
		expect(isPathWithin("/repo", "/elsewhere")).toBe(false);
	});
	test("a trailing slash on either side does not change the result", () => {
		expect(isPathWithin("/repo/", "/repo/sub/")).toBe(true);
	});
	test("empty strings never match", () => {
		expect(isPathWithin("", "/repo")).toBe(false);
		expect(isPathWithin("/repo", "")).toBe(false);
	});
	test("isLiveExtensionTree delegates to isPathWithin(runRoot, extensionRoot)", () => {
		expect(isLiveExtensionTree("/repo", "/repo/bridge/extensions/orchestrator")).toBe(true);
		expect(isLiveExtensionTree("/repo", "/somewhere/else")).toBe(false);
	});
});

function seams(overrides: Partial<LiveTreeSeams> = {}): LiveTreeSeams {
	return {
		gitToplevel: () => null,
		realpath: (p: string) => p,
		...overrides,
	};
}

describe("core/live-tree.ts detectLiveExtensionTree", () => {
	test("reports a match when the extension's git root is inside the run's git root", () => {
		const result = detectLiveExtensionTree("/run/cwd", "/ext/dir", seams({
			gitToplevel: (p) => (p === "/run/cwd" ? "/repo" : p === "/ext/dir" ? "/repo/bridge/extensions/orchestrator" : null),
		}));
		expect(result).toEqual({ runRoot: "/repo", extensionRoot: "/repo/bridge/extensions/orchestrator" });
	});
	test("returns null when the extension lives in a different repo", () => {
		const result = detectLiveExtensionTree("/run/cwd", "/ext/dir", seams({
			gitToplevel: (p) => (p === "/run/cwd" ? "/repo" : p === "/ext/dir" ? "/other-repo" : null),
		}));
		expect(result).toBeNull();
	});
	test("returns null (skips silently) when the run's cwd is not a git work tree", () => {
		const result = detectLiveExtensionTree("/run/cwd", "/ext/dir", seams({
			gitToplevel: (p) => (p === "/ext/dir" ? "/repo" : null),
		}));
		expect(result).toBeNull();
	});
	test("returns null (skips silently) when the extension's own toplevel can't be resolved", () => {
		const result = detectLiveExtensionTree("/run/cwd", "/ext/dir", seams({
			gitToplevel: (p) => (p === "/run/cwd" ? "/repo" : null),
		}));
		expect(result).toBeNull();
	});
	test("realpath is applied to both roots before comparing", () => {
		const result = detectLiveExtensionTree("/run/cwd", "/ext/dir", {
			gitToplevel: (p) => (p === "/run/cwd" ? "/symlinked-repo" : "/symlinked-repo/bridge/extensions/orchestrator"),
			realpath: (p) => p.replace("symlinked-repo", "real-repo"),
		});
		expect(result).toEqual({ runRoot: "/real-repo", extensionRoot: "/real-repo/bridge/extensions/orchestrator" });
	});
	test("a realpath failure falls back to the unresolved toplevel rather than throwing", () => {
		const result = detectLiveExtensionTree("/run/cwd", "/ext/dir", {
			gitToplevel: (p) => (p === "/run/cwd" ? "/repo" : "/repo/bridge/extensions/orchestrator"),
			realpath: () => null,
		});
		expect(result).toEqual({ runRoot: "/repo", extensionRoot: "/repo/bridge/extensions/orchestrator" });
	});
});

describe("core/live-tree.ts extractForeignPath", () => {
	test("finds a `cd <path>` outside the run root", () => {
		expect(extractForeignPath(["some text\ncd /elsewhere/repo\nmore text"], "/repo")).toBe("/elsewhere/repo");
	});
	test("ignores a `cd <path>` inside the run root", () => {
		expect(extractForeignPath(["cd /repo/sub"], "/repo")).toBeNull();
	});
	test("finds a `cwd: <path>` reference outside the run root", () => {
		expect(extractForeignPath(["tool call: cwd: /elsewhere/repo did the thing"], "/repo")).toBe("/elsewhere/repo");
	});
	test("finds a `cwd=<path>` reference outside the run root", () => {
		expect(extractForeignPath(['cwd="/elsewhere/repo"'], "/repo")).toBe("/elsewhere/repo");
	});
	test("returns null when nothing outside the run root is referenced", () => {
		expect(extractForeignPath(["cd /repo\ncwd: /repo/sub", "no path references here"], "/repo")).toBeNull();
	});
	test("returns null on empty input", () => {
		expect(extractForeignPath([], "/repo")).toBeNull();
		expect(extractForeignPath(["  "], "/repo")).toBeNull();
	});
	test("only scans the first SCAN_MAX_TEXTS texts (bounded)", () => {
		const texts = Array.from({ length: 25 }, (_, i) => (i === 24 ? "cd /elsewhere/late" : "nothing here"));
		expect(extractForeignPath(texts, "/repo")).toBeNull();
	});
	test("only scans the first slice of a very long text (bounded)", () => {
		const padding = "x".repeat(30_000);
		expect(extractForeignPath([`${padding}cd /elsewhere/too-late`], "/repo")).toBeNull();
	});
});

describe("core/live-tree.ts detectOutOfTreeChanges / outOfTreeChangesSummaryLine", () => {
	test("no claimed files: never detected", () => {
		const result = detectOutOfTreeChanges({ claimedFiles: [], observedFiles: [], leadTexts: [], runRoot: "/repo" });
		expect(result.detected).toBe(false);
		expect(outOfTreeChangesSummaryLine(result)).toBeNull();
	});
	test("claimed files observed by git: not detected even if leads mention a foreign cd", () => {
		const result = detectOutOfTreeChanges({
			claimedFiles: ["a.ts"],
			observedFiles: ["a.ts"],
			leadTexts: ["cd /elsewhere; edit a.ts"],
			runRoot: "/repo",
		});
		expect(result.detected).toBe(false);
	});
	test("claimed files but none observed: detected, names the foreign path when found", () => {
		const result = detectOutOfTreeChanges({
			claimedFiles: ["a.ts", "b.ts"],
			observedFiles: [],
			leadTexts: ["I ran: cd /elsewhere/repo && edited a.ts and b.ts"],
			runRoot: "/repo",
		});
		expect(result.detected).toBe(true);
		expect(result.foreignPath).toBe("/elsewhere/repo");
		expect(result.claimedFiles).toEqual(["a.ts", "b.ts"]);
		expect(outOfTreeChangesSummaryLine(result)).toBe("changes outside run tree: /elsewhere/repo");
	});
	test("claimed files but none observed, no foreign path found: falls back to naming claimed files (never silent)", () => {
		const result = detectOutOfTreeChanges({
			claimedFiles: ["a.ts", "b.ts"],
			observedFiles: [],
			leadTexts: ["no path references in this report at all"],
			runRoot: "/repo",
		});
		expect(result.detected).toBe(true);
		expect(result.foreignPath).toBeNull();
		expect(outOfTreeChangesSummaryLine(result)).toBe("changes outside run tree: a.ts, b.ts");
	});
	test("claimed files sample is bounded", () => {
		const claimedFiles = Array.from({ length: 30 }, (_, i) => `file-${i}.ts`);
		const result = detectOutOfTreeChanges({ claimedFiles, observedFiles: [], leadTexts: [], runRoot: "/repo" });
		expect(result.claimedFiles.length).toBe(10);
	});
});

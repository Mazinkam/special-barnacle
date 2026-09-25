import { describe, expect, test } from "bun:test";
import {
	DEFAULT_INTEGRATION_FILES,
	canonicalizePath,
	findOwnershipOverlaps,
	observedEditConflicts,
	pathsOverlap,
	serializeWaves,
} from "./file-ownership.ts";

describe("canonicalizePath", () => {
	test("strips leading ./ and trailing /", () => {
		expect(canonicalizePath("./src/a.ts")).toEqual({ path: "src/a.ts", unsafe: false });
		expect(canonicalizePath("src/dir/")).toEqual({ path: "src/dir", unsafe: false });
	});
	test("collapses a/../b segments", () => {
		expect(canonicalizePath("src/../src/a.ts")).toEqual({ path: "src/a.ts", unsafe: false });
	});
	test("flags absolute paths as unsafe", () => {
		expect(canonicalizePath("/etc/passwd").unsafe).toBe(true);
	});
	test("flags repo-escaping paths as unsafe", () => {
		expect(canonicalizePath("../secret").unsafe).toBe(true);
		expect(canonicalizePath("src/../../secret").unsafe).toBe(true);
	});
	test("flags empty/blank paths as unsafe", () => {
		expect(canonicalizePath("").unsafe).toBe(true);
		expect(canonicalizePath("   ").unsafe).toBe(true);
	});
	test("flags paths containing NUL as unsafe", () => {
		expect(canonicalizePath("src/a\0.ts").unsafe).toBe(true);
	});
});

describe("pathsOverlap", () => {
	test("exact match overlaps, including ./ prefix and trailing slash normalization", () => {
		expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
		expect(pathsOverlap("./src/a.ts", "src/a.ts")).toBe(true);
		expect(pathsOverlap("src/dir/", "src/dir")).toBe(true);
	});
	test("a/../b segments are collapsed before comparison", () => {
		expect(pathsOverlap("src/../src/a.ts", "src/a.ts")).toBe(true);
	});
	test("directory-prefix containment overlaps", () => {
		expect(pathsOverlap("src", "src/a.ts")).toBe(true);
		expect(pathsOverlap("src/a.ts", "src")).toBe(true);
	});
	test("disjoint non-glob paths do not overlap", () => {
		expect(pathsOverlap("src/a.ts", "src/ab.ts")).toBe(false);
		expect(pathsOverlap("src/x", "lib/x")).toBe(false);
		expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
		expect(pathsOverlap("src/a/", "src/b/")).toBe(false);
		expect(pathsOverlap("docs/*.md", "src/x.ts")).toBe(false);
	});
	test("all glob metacharacters overlap conservatively by literal prefix", () => {
		expect(pathsOverlap("src/a?.ts", "src/ab.ts")).toBe(true);
		expect(pathsOverlap("src/[ab].ts", "src/a.ts")).toBe(true);
		expect(pathsOverlap("src/{a,b}.ts", "src/a.ts")).toBe(true);
		expect(pathsOverlap("src/a?.ts", "lib/ab.ts")).toBe(false);
	});
	test("glob patterns overlap conservatively by literal prefix", () => {
		expect(pathsOverlap("src/**/*.ts", "src/a.ts")).toBe(true);
		expect(pathsOverlap("src/**/*.ts", "src/dir/a.ts")).toBe(true);
		expect(pathsOverlap("src/**/*.ts", "lib/a.ts")).toBe(false);
		expect(pathsOverlap("src/*.ts", "src/*.md")).toBe(true); // same literal prefix, err toward overlap
	});
	test("glob with no literal anchor overlaps everything", () => {
		expect(pathsOverlap("*", "anything/at/all.ts")).toBe(true);
	});
	test("glob vs non-glob: literal path matching the glob's literal prefix overlaps", () => {
		expect(pathsOverlap("src/foo*.ts", "src/foo.ts")).toBe(true);
		expect(pathsOverlap("src/foo*", "src/foobar.ts")).toBe(true);
		expect(pathsOverlap("**/*.ts", "a/b.ts")).toBe(true);
		expect(pathsOverlap("src/*", "src/x/y.ts")).toBe(true);
	});
	test("unsafe paths (absolute, repo-escaping, empty, NUL) always overlap", () => {
		expect(pathsOverlap("/etc/passwd", "src/a.ts")).toBe(true);
		expect(pathsOverlap("../secret", "src/a.ts")).toBe(true);
		expect(pathsOverlap("", "src/a.ts")).toBe(true);
		expect(pathsOverlap("src/a\0.ts", "src/b.ts")).toBe(true);
	});
});

describe("findOwnershipOverlaps", () => {
	test("no overlap when owns lists are disjoint", () => {
		const { overlaps, undeclared } = findOwnershipOverlaps([
			{ lead: 0, owns: ["src/a"] },
			{ lead: 1, owns: ["src/b"] },
		]);
		expect(overlaps).toEqual([]);
		expect(undeclared).toEqual([]);
	});
	test("reports overlapping pairs with the concrete overlapping paths", () => {
		const { overlaps } = findOwnershipOverlaps([
			{ lead: 0, owns: ["src/a", "src/shared"] },
			{ lead: 1, owns: ["src/shared", "src/b"] },
		]);
		expect(overlaps).toEqual([{ a: 0, b: 1, paths: [["src/shared", "src/shared"]] }]);
	});
	test("leads with owns undefined are undeclared, not paired into overlaps", () => {
		const { overlaps, undeclared } = findOwnershipOverlaps([
			{ lead: 0, owns: ["src/a"] },
			{ lead: 1 },
			{ lead: 2, owns: [] },
		]);
		expect(undeclared).toEqual([1]);
		expect(overlaps).toEqual([]);
	});
	test("two leads declaring the same integration file overlap", () => {
		const [f] = DEFAULT_INTEGRATION_FILES;
		const { overlaps } = findOwnershipOverlaps([
			{ lead: 0, owns: [f] },
			{ lead: 1, owns: [f] },
		]);
		expect(overlaps).toEqual([{ a: 0, b: 1, paths: [[f, f]] }]);
	});
	test("a lead declaring an unsafe path is reported in `unsafe` and overlaps everything", () => {
		const { overlaps, unsafe } = findOwnershipOverlaps([
			{ lead: 0, owns: ["/etc/passwd"] },
			{ lead: 1, owns: ["src/b"] },
		]);
		expect(unsafe).toEqual([0]);
		expect(overlaps).toEqual([{ a: 0, b: 1, paths: [["/etc/passwd", "src/b"]] }]);
	});
	test("leads with only safe paths report an empty unsafe list", () => {
		const { unsafe } = findOwnershipOverlaps([
			{ lead: 0, owns: ["src/a"] },
			{ lead: 1, owns: ["src/b"] },
		]);
		expect(unsafe).toEqual([]);
	});
});

describe("serializeWaves", () => {
	const owners = [
		{ lead: 0, owns: ["src/a"] },
		{ lead: 1, owns: ["src/a"] }, // overlaps with 0
		{ lead: 2, owns: ["src/z"] },
	];

	test("off: waves pass through unchanged, no evidence", () => {
		const result = serializeWaves([[0, 1, 2]], owners, "off");
		expect(result.waves).toEqual([[0, 1, 2]]);
		expect(result.changed).toBe(false);
		expect(result.evidence).toEqual([]);
	});

	test("report: waves unchanged, evidence describes the overlap", () => {
		const result = serializeWaves([[0, 1, 2]], owners, "report");
		expect(result.waves).toEqual([[0, 1, 2]]);
		expect(result.changed).toBe(false);
		expect(result.evidence).toEqual([
			{ kind: "ownership_overlap", wave: 0, a: 0, b: 1, paths: [["src/a", "src/a"]] },
		]);
	});

	test("report: undeclared lead sharing a wave produces an undeclared row, not a fabricated overlap", () => {
		const withUndeclared = [{ lead: 0, owns: ["src/a"] }, { lead: 1 }];
		const result = serializeWaves([[0, 1]], withUndeclared, "report");
		expect(result.waves).toEqual([[0, 1]]);
		expect(result.evidence).toEqual([
			{ kind: "ownership_undeclared", wave: 0, lead: 1, othersInWave: [0] },
		]);
	});

	test("report: a lead alone in its own wave produces no evidence", () => {
		const result = serializeWaves([[0], [1]], [{ lead: 0 }, { lead: 1 }], "report");
		expect(result.evidence).toEqual([]);
	});

	test("serialize: splits overlapping leads into separate waves, keeps disjoint lead alongside", () => {
		const result = serializeWaves([[0, 1, 2]], owners, "serialize");
		expect(result.changed).toBe(true);
		// 0 and 1 overlap so cannot share a wave; 2 is disjoint from 0 and can join it.
		expect(result.waves).toEqual([[0, 2], [1]]);
		expect(result.evidence).toEqual([
			{ kind: "ownership_serialized", originalWave: [0, 1, 2], splitInto: [[0, 2], [1]] },
		]);
	});

	test("serialize: undeclared lead always runs alone even with a disjoint co-wave lead", () => {
		const withUndeclared = [{ lead: 0, owns: ["src/a"] }, { lead: 1 }, { lead: 2, owns: ["src/z"] }];
		const result = serializeWaves([[0, 1, 2]], withUndeclared, "serialize");
		expect(result.waves).toEqual([[0, 2], [1]]);
		expect(result.changed).toBe(true);
	});

	test("serialize: a wave with no conflicts is left as-is and not marked changed", () => {
		const disjoint = [{ lead: 0, owns: ["src/a"] }, { lead: 1, owns: ["src/b"] }];
		const result = serializeWaves([[0, 1]], disjoint, "serialize");
		expect(result.waves).toEqual([[0, 1]]);
		expect(result.changed).toBe(false);
		expect(result.evidence).toEqual([]);
	});

	test("serialize: leads never move before their original wave — later waves stay after the split", () => {
		const threeWaves = [{ lead: 0, owns: ["src/a"] }, { lead: 1, owns: ["src/a"] }, { lead: 2, owns: ["src/z"] }];
		const result = serializeWaves([[0, 1], [2]], threeWaves, "serialize");
		expect(result.waves).toEqual([[0], [1], [2]]);
	});
});

describe("observedEditConflicts", () => {
	test("empty input yields no rows", () => {
		expect(observedEditConflicts([])).toEqual([]);
	});
	test("a single lead touching a file is not a conflict", () => {
		expect(observedEditConflicts([{ lead: 0, files: ["src/a.ts"] }])).toEqual([]);
	});
	test("two leads actually changing the same file is reported", () => {
		const result = observedEditConflicts([
			{ lead: 0, files: ["src/a.ts", "src/shared.ts"] },
			{ lead: 1, files: ["src/shared.ts"] },
			{ lead: 2, files: ["src/b.ts"] },
		]);
		expect(result).toEqual([{ kind: "observed_edit_overlap", file: "src/shared.ts", leads: [0, 1] }]);
	});
	test("never fabricates a zero-rate row", () => {
		const result = observedEditConflicts([{ lead: 0, files: ["src/a.ts"] }, { lead: 1, files: ["src/b.ts"] }]);
		expect(result).toEqual([]);
	});
});

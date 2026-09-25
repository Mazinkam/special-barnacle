/**
 * Pure file-ownership overlap checks for parallel leads. `parseLeadAssignments`
 * (lead-plan.ts) may give each lead an `owns` list; when it doesn't, ownership
 * is UNKNOWN for that lead — we can never prove it's disjoint from anyone
 * else's, so it must be treated conservatively (see `undeclared` below), not
 * silently assumed safe.
 *
 * `serializeWaves` is the only function that changes scheduling; `off` and
 * `report` are pure observability modes that must never mutate the plan.
 */

import { posix } from "node:path";

export interface OwnershipInput {
	lead: number;
	owns?: string[];
}

export interface OwnershipOverlap {
	a: number;
	b: number;
	paths: [string, string][];
}

/**
 * Files every parallel run touches regardless of what any lead's own scope
 * says (bridge wiring, method config, economics/records). Two leads that
 * BOTH declare owning one of these always overlap — there is no such thing
 * as two leads safely "owning" shared integration surface at once.
 */
export const DEFAULT_INTEGRATION_FILES: string[] = [
	"bridge/extensions/orchestrator/index.ts",
	"orchestrator/method.json",
	"bridge/orchestrator-profiles.json",
	"orchestrator/config.json",
	"orchestrator/economics.py",
	"orchestrator/records.py",
];

export interface PathCanonicalization {
	/** The canonicalized repo-relative path (only meaningful when `unsafe` is false). */
	path: string;
	/**
	 * True when the raw input is absolute, escapes the repo root (a leading
	 * `..` segment after normalization), empty/blank, or contains a NUL byte.
	 * Such a path can never be proven disjoint from anything, so callers must
	 * treat it as overlapping everything rather than compare it literally.
	 */
	unsafe: boolean;
}

/**
 * Canonicalize a repo-relative path for overlap comparison: strips a
 * leading `./`, collapses `a/../b` segments via `posix.normalize`, and
 * drops a trailing `/`. Flags `unsafe` for anything that cannot be trusted
 * as an ordinary repo-relative path (absolute, escapes the repo, empty, or
 * contains NUL) — never silently normalized into something comparable.
 */
export function canonicalizePath(input: string): PathCanonicalization {
	if (input.includes("\0")) return { path: input, unsafe: true };
	const trimmed = input.trim();
	if (trimmed === "") return { path: "", unsafe: true };
	if (posix.isAbsolute(trimmed)) return { path: trimmed, unsafe: true };
	let normalized = posix.normalize(trimmed).replace(/\/+$/, "");
	if (normalized === "") normalized = ".";
	if (normalized === ".." || normalized.startsWith("../")) return { path: normalized, unsafe: true };
	return { path: normalized, unsafe: false };
}

function isGlob(path: string): boolean {
	return /[*?\[\]{}!]/.test(path);
}

/** The fixed, non-wildcard portion of a glob, e.g. "src/**\/*.ts" -> "src/". */
function literalPrefix(path: string): string {
	const idx = path.search(/[*?\[\]{}!]/);
	return (idx === -1 ? path : path.slice(0, idx)).replace(/\/+$/, "");
}

/**
 * Conservative overlap: unsafe paths (absolute, repo-escaping, empty, or
 * containing NUL) always overlap, since they can never be proven disjoint.
 * Otherwise: exact match, directory containment (one path is a directory
 * prefix of the other), and glob patterns compared by their literal
 * (non-wildcard) prefix — a glob overlaps any path (or other glob) whose
 * literal prefix relationship is ambiguous rather than clearly disjoint.
 * Globs and uncertain cases always err toward reporting overlap rather than
 * missing a real conflict.
 */
export function pathsOverlap(a: string, b: string): boolean {
	const ca = canonicalizePath(a);
	const cb = canonicalizePath(b);
	if (ca.unsafe || cb.unsafe) return true;
	const na = ca.path;
	const nb = cb.path;
	if (na === nb) return true;
	if (na === "" || nb === "" || na === "." || nb === ".") return true; // empty/root scope: cannot rule out overlap
	if (nb.startsWith(`${na}/`) || na.startsWith(`${nb}/`)) return true;

	const globA = isGlob(na);
	const globB = isGlob(nb);
	if (globA && globB) {
		const pa = literalPrefix(na);
		const pb = literalPrefix(nb);
		if (pa === "" || pb === "") return true; // glob with no literal anchor: could match anything
		if (pa === pb) return true;
		if (pb.startsWith(pa) || pa.startsWith(pb)) return true;
		return false;
	}
	if (globA || globB) {
		const globPath = globA ? na : nb;
		const literal = globA ? nb : na;
		const p = literalPrefix(globPath);
		if (p === "") return true; // glob with no literal anchor: could match anything
		if (literal.startsWith(p) || p.startsWith(literal)) return true;
		return false;
	}
	return false;
}

/**
 * Pairwise overlaps among leads that both declared `owns`, plus the set of
 * leads that declared none at all — ownership unknown, so they can never be
 * proven disjoint from any other lead (declared or not) — plus the set of
 * leads that declared at least one `unsafe` path (absolute, repo-escaping,
 * empty, or containing NUL). An unsafe path already forces `pathsOverlap`
 * to report overlap with everything it's compared against, so it shows up
 * in `overlaps` too; `unsafe` additionally names which lead(s) supplied it
 * so a caller can surface that as its own diagnostic.
 */
export function findOwnershipOverlaps(
	owners: OwnershipInput[],
): { overlaps: OwnershipOverlap[]; undeclared: number[]; unsafe: number[] } {
	const undeclared = owners.filter((o) => o.owns === undefined).map((o) => o.lead);
	const unsafeSet = new Set<number>();
	for (const o of owners) {
		if (o.owns === undefined) continue;
		if (o.owns.some((p) => canonicalizePath(p).unsafe)) unsafeSet.add(o.lead);
	}
	const overlaps: OwnershipOverlap[] = [];
	for (let i = 0; i < owners.length; i++) {
		const a = owners[i];
		if (a.owns === undefined) continue;
		for (let j = i + 1; j < owners.length; j++) {
			const b = owners[j];
			if (b.owns === undefined) continue;
			const paths: [string, string][] = [];
			for (const pa of a.owns) for (const pb of b.owns) if (pathsOverlap(pa, pb)) paths.push([pa, pb]);
			if (paths.length > 0) overlaps.push({ a: a.lead, b: b.lead, paths });
		}
	}
	return { overlaps, undeclared, unsafe: [...unsafeSet].sort((x, y) => x - y) };
}

function conflicts(leadA: number, leadB: number, undeclaredSet: Set<number>, overlaps: OwnershipOverlap[]): boolean {
	if (undeclaredSet.has(leadA) || undeclaredSet.has(leadB)) return true;
	return overlaps.some((o) => (o.a === leadA && o.b === leadB) || (o.a === leadB && o.b === leadA));
}

export type OwnershipMode = "off" | "report" | "serialize";

export interface SerializeWavesResult {
	waves: number[][];
	changed: boolean;
	evidence: Array<Record<string, unknown>>;
}

/**
 * `off` — waves pass through untouched, no evidence (fully disabled).
 * `report` — waves pass through untouched; evidence rows describe overlaps
 * and undeclared ownership among leads sharing a wave, for a human/QA gate
 * to act on without the scheduler silently reordering anything.
 * `serialize` — splits any wave so no two co-scheduled leads overlap or are
 * undeclared (an undeclared lead always runs alone). Leads never move
 * earlier than their original wave; relative order within a wave is kept
 * when leads don't conflict.
 */
export function serializeWaves(waves: number[][], owners: OwnershipInput[], mode: OwnershipMode): SerializeWavesResult {
	const { overlaps, undeclared } = findOwnershipOverlaps(owners);
	const undeclaredSet = new Set(undeclared);

	if (mode === "off") {
		return { waves: waves.map((w) => [...w]), changed: false, evidence: [] };
	}

	if (mode === "report") {
		const evidence: Array<Record<string, unknown>> = [];
		waves.forEach((wave, waveIndex) => {
			for (let i = 0; i < wave.length; i++) {
				for (let j = i + 1; j < wave.length; j++) {
					const a = wave[i];
					const b = wave[j];
					if (undeclaredSet.has(a) || undeclaredSet.has(b)) continue; // reported once per lead below
					const overlap = overlaps.find((o) => (o.a === a && o.b === b) || (o.a === b && o.b === a));
					if (overlap) evidence.push({ kind: "ownership_overlap", wave: waveIndex, a, b, paths: overlap.paths });
				}
			}
			if (wave.length > 1) {
				for (const lead of wave) {
					if (undeclaredSet.has(lead)) {
						evidence.push({
							kind: "ownership_undeclared",
							wave: waveIndex,
							lead,
							othersInWave: wave.filter((l) => l !== lead),
						});
					}
				}
			}
		});
		return { waves: waves.map((w) => [...w]), changed: false, evidence };
	}

	// serialize
	const evidence: Array<Record<string, unknown>> = [];
	const outWaves: number[][] = [];
	let changed = false;
	for (const wave of waves) {
		if (wave.length <= 1) {
			outWaves.push([...wave]);
			continue;
		}
		const buckets: number[][] = [];
		for (const lead of wave) {
			if (undeclaredSet.has(lead)) {
				buckets.push([lead]); // undeclared: always its own bucket, never shared
				continue;
			}
			let placed = false;
			for (const bucket of buckets) {
				if (bucket.some((l) => undeclaredSet.has(l))) continue; // reserved for the undeclared lead alone
				if (!bucket.some((other) => conflicts(lead, other, undeclaredSet, overlaps))) {
					bucket.push(lead);
					placed = true;
					break;
				}
			}
			if (!placed) buckets.push([lead]);
		}
		if (buckets.length > 1) {
			changed = true;
			evidence.push({ kind: "ownership_serialized", originalWave: [...wave], splitInto: buckets.map((b) => [...b]) });
		}
		for (const b of buckets) outWaves.push(b);
	}
	return { waves: outWaves, changed, evidence };
}

export interface ObservedEditConflict {
	kind: "observed_edit_overlap";
	file: string;
	leads: number[];
}

/**
 * Ground truth from what leads actually changed (not what they declared).
 * Only reports a file when >=2 leads actually touched it — never fabricate a
 * conflict for a file no one, or only one lead, changed.
 */
export function observedEditConflicts(changed: Array<{ lead: number; files: string[] }>): ObservedEditConflict[] {
	const byFile = new Map<string, Set<number>>();
	for (const c of changed) {
		for (const file of c.files) {
			if (!byFile.has(file)) byFile.set(file, new Set());
			byFile.get(file)!.add(c.lead);
		}
	}
	const out: ObservedEditConflict[] = [];
	for (const [file, leads] of byFile) {
		if (leads.size >= 2) out.push({ kind: "observed_edit_overlap", file, leads: [...leads].sort((a, b) => a - b) });
	}
	return out;
}

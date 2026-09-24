/**
 * Pure lead-assignment planning. When the topology asks for several leads,
 * the architect must say what each lead owns and which leads depend on which
 * (`## Lead assignments`). Leads then run in dependency waves instead of all
 * at once. Without a valid assignment section the bridge runs ONE lead:
 * cloning the same goal into N parallel leads made all three repeat the same
 * preflight on 2026-09-24 (run ht-orch-1790237987755-lyjkn8).
 */

export interface LeadAssignment {
	/** 0-based lead index. */
	index: number;
	scope: string;
	/** 0-based indices of leads that must finish first. */
	dependsOn: number[];
}

const LINE_RE = /^[\s>*-]*\**\s*Lead\s+(\d+)\s*:?\**\s*:?\s*(.+?)\s*$/i;
const DEPS_RE = /\(\s*depends\s+on\s*:\s*([^)]*)\)/i;

export function parseLeadAssignments(architectText: string, leadCount: number): LeadAssignment[] | null {
	const section = /^##\s*Lead assignments\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(architectText)?.[1];
	if (!section) return null;
	const out: LeadAssignment[] = [];
	for (const line of section.split("\n")) {
		const m = LINE_RE.exec(line);
		if (!m) continue;
		const index = Number(m[1]) - 1;
		let rest = m[2].replace(/^\**\s*/, "");
		let dependsOn: number[] = [];
		// The deps parenthesis may sit anywhere in the line and be followed by
		// punctuation or more prose; "Lead 1", "1 and 2" and "1, 2" all work.
		const deps = DEPS_RE.exec(rest);
		if (deps) {
			rest = `${rest.slice(0, deps.index)} ${rest.slice(deps.index + deps[0].length)}`;
			dependsOn = [...deps[1].matchAll(/\d+/g)].map((d) => Number(d[0]) - 1);
		}
		const scope = rest.replace(/\s+/g, " ").replace(/\*+/g, "").trim().replace(/^[\s.;,]+|[\s.;,]+$/g, "");
		out.push({ index, scope, dependsOn });
	}
	if (out.length !== leadCount) return null;
	const indices = new Set(out.map((a) => a.index));
	for (let i = 0; i < leadCount; i++) if (!indices.has(i)) return null;
	for (const a of out) {
		// Only backward dependencies: rules out unknown ids, self-edges and cycles.
		if (a.dependsOn.some((d) => !Number.isInteger(d) || d < 0 || d >= a.index)) return null;
	}
	return out.sort((a, b) => a.index - b.index);
}

/** Topological waves: each wave's leads only depend on leads in earlier waves. */
export function planLeadWaves(assignments: LeadAssignment[]): number[][] {
	const waveOf = new Map<number, number>();
	for (const a of [...assignments].sort((x, y) => x.index - y.index)) {
		const wave = a.dependsOn.length === 0 ? 0 : Math.max(...a.dependsOn.map((d) => waveOf.get(d) ?? 0)) + 1;
		waveOf.set(a.index, wave);
	}
	const waves: number[][] = [];
	for (const [index, wave] of waveOf) (waves[wave] ??= []).push(index);
	return waves.map((w) => w.sort((a, b) => a - b));
}

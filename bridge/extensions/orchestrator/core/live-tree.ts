/**
 * A6/N2: pure detectors for two "the run and the tooling running it are
 * tangled together" hazards.
 *
 * 1. `isLiveExtensionTree`/`detectLiveExtensionTree` — the orchestrator extension is itself
 *    inside the repo a run is about to dispatch leads against. A lead editing files under the
 *    extension's own directory can rewrite the code that is currently executing it mid-run. This
 *    is never blocked (the operator may genuinely be developing the orchestrator on itself) — only
 *    surfaced loudly, once, at run start.
 *
 * 2. `detectOutOfTreeChanges` — a lead claims (`DispatchResult.filesChanged`, or its own report
 *    prose) to have changed files, but the run's own git tree shows none of those changes. The
 *    most common real cause: the lead `cd`'d into a different git worktree/repo (another checkout,
 *    a sibling clone) and did its work there instead of in the run's own tree, so the run's summary
 *    would otherwise silently report 0 files changed with no explanation.
 *
 * Everything here is pure string/path comparison over already-resolved inputs — no `node:fs`, no
 * `node:child_process`. The actual `git rev-parse --show-toplevel` / realpath calls (and their
 * failure handling — "any git failure skips silently") live in the pipeline module that calls
 * this one; that impure edge is small and inlined there specifically so this module stays fully
 * unit-testable with plain strings and no real repo.
 */

import { sep } from "node:path";

/** Strip exactly one trailing path separator (so `"/a/b/"` and `"/a/b"` compare equal); never
 *  strips the root separator itself (`"/"` stays `"/"`). */
function stripTrailingSep(p: string): string {
	return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/**
 * True when `childRoot` is `parentRoot` itself, or a path underneath it. Both must already be
 * fully resolved (realpath'd) absolute paths — this does no normalization beyond stripping one
 * trailing separator, so a caller comparing an un-resolved symlinked path against its real target
 * will get a false negative, not a false positive.
 */
export function isPathWithin(parentRoot: string, childRoot: string): boolean {
	if (!parentRoot || !childRoot) return false;
	const parent = stripTrailingSep(parentRoot);
	const child = stripTrailingSep(childRoot);
	return child === parent || child.startsWith(parent + sep);
}

/** N2: true when the running extension's own git repo root is inside (or equal to) the run's
 *  own git repo root — i.e. a lead dispatched by this run could edit the extension's own code. */
export function isLiveExtensionTree(runRepoRoot: string, extensionRepoRoot: string): boolean {
	return isPathWithin(runRepoRoot, extensionRepoRoot);
}

/** The two seams `detectLiveExtensionTree` needs, kept as plain functions (not a class) so a test
 *  can hand it inline closures over fixture data with no real repo and no real filesystem. Both
 *  return `null` on ANY failure (not inside a git work tree, git missing, permission error, ...);
 *  the caller treats `null` as "skip silently", never as an error to surface. */
export interface LiveTreeSeams {
	/** Resolve `path`'s (or `cwd`'s) git repository root, or `null` if it cannot be determined. */
	gitToplevel(path: string): string | null;
	/** Resolve a path to its real, symlink-free form, or `null` if it cannot be resolved. */
	realpath(path: string): string | null;
}

/** Result of a live-extension-tree check that actually found one; `detectLiveExtensionTree`
 *  returns `null` instead of this shape when there is nothing to warn about (including on any
 *  git/realpath failure — see `LiveTreeSeams`'s doc comment). */
export interface LiveExtensionTreeMatch {
	runRoot: string;
	extensionRoot: string;
}

/**
 * N2: resolve both the run's and the extension's git repo roots through `seams`, realpath both,
 * and report a match only when the extension's root sits inside (or equals) the run's root.
 * Never throws: any seam returning `null` short-circuits to `null` (skip silently), exactly as a
 * real `git rev-parse` failure or unresolvable path would.
 */
export function detectLiveExtensionTree(
	runCwd: string,
	extensionDir: string,
	seams: LiveTreeSeams,
): LiveExtensionTreeMatch | null {
	const runToplevel = seams.gitToplevel(runCwd);
	if (!runToplevel) return null;
	const extToplevel = seams.gitToplevel(extensionDir);
	if (!extToplevel) return null;
	const runRoot = seams.realpath(runToplevel) ?? runToplevel;
	const extensionRoot = seams.realpath(extToplevel) ?? extToplevel;
	if (!isLiveExtensionTree(runRoot, extensionRoot)) return null;
	return { runRoot, extensionRoot };
}

/** Bound how much of a lead's report text `extractForeignPath` will ever scan: this text comes
 *  straight from a dispatch this module does not control, so both the number of texts and the
 *  characters per text are capped to keep the scan linear and bounded regardless of input size. */
const SCAN_MAX_TEXTS = 20;
const SCAN_MAX_CHARS_PER_TEXT = 20_000;
/** How many claimed files the summary line falls back to naming when no foreign path was found
 *  in the lead's own text (still never zero — see `detectOutOfTreeChanges`'s doc comment). */
const CLAIMED_SAMPLE_MAX = 10;

/** `cd /abs/path`, in command position (start of string, or after a shell separator/opener). */
const CD_RE = /(?:^|[\s;&|(])cd\s+(\/[^\s"'`;&|)]+)/g;
/** `cwd: /abs/path` / `cwd=/abs/path` / `cwd = "/abs/path"`, as a lead's tool-call output or its
 *  own report prose sometimes echoes its working directory. */
const CWD_RE = /\bcwd\b\s*[:=]\s*["']?(\/[^\s"'`]+)/gi;

/**
 * Scan `leadTexts` (bounded — see `SCAN_MAX_TEXTS`/`SCAN_MAX_CHARS_PER_TEXT`) for the first
 * absolute path named after `cd `/`cwd` that sits OUTSIDE `runRoot` — evidence a lead worked in a
 * different git worktree/repo instead of the run's own tree. Returns `null` when no such path is
 * found (the mismatch is still reported by `detectOutOfTreeChanges`; it just can't name a specific
 * foreign path).
 */
export function extractForeignPath(leadTexts: string[], runRoot: string): string | null {
	const root = stripTrailingSep(runRoot);
	if (!root) return null;
	for (const raw of leadTexts.slice(0, SCAN_MAX_TEXTS)) {
		if (!raw) continue;
		const text = raw.slice(0, SCAN_MAX_CHARS_PER_TEXT);
		for (const re of [CD_RE, CWD_RE]) {
			re.lastIndex = 0;
			let m: RegExpExecArray | null;
			// eslint-disable-next-line no-cond-assign
			while ((m = re.exec(text))) {
				const candidate = m[1];
				if (candidate && !isPathWithin(root, candidate)) return candidate;
			}
		}
	}
	return null;
}

export interface OutOfTreeChangesInput {
	/** Union of every lead's `DispatchResult.filesChanged` for this run (or this round). */
	claimedFiles: string[];
	/** The run's own git-observed changed files for the same round (already intersected against
	 *  `claimedFiles` by the pipeline's own `changedSince`, per its doc comment) — empty here means
	 *  the run's tree shows none of what was claimed, not merely "fewer than claimed". */
	observedFiles: string[];
	/** Lead stdout/report text to scan for a `cd`/`cwd` reference to a path outside `runRoot`. */
	leadTexts: string[];
	/** The run's own (already-resolved) repo root, or `cwd` when git is unavailable. */
	runRoot: string;
}

export interface OutOfTreeChangesResult {
	detected: boolean;
	/** An out-of-tree path named in a lead's own text, when one was found. */
	foreignPath: string | null;
	/** Bounded sample of the files leads claimed changing (non-empty whenever `detected`). */
	claimedFiles: string[];
}

/**
 * N2: a lead claimed changing files, but the run's own git tree shows none of them changed —
 * most often because the lead worked in a different worktree/repo entirely. Detection is
 * deliberately simple (claimed-but-none-observed, plus a best-effort foreign path from the lead's
 * own text) rather than a precise diff of which claimed files are missing: precision here would
 * require re-running git per file, and the summary line this feeds is a warning, not a gate.
 */
export function detectOutOfTreeChanges(input: OutOfTreeChangesInput): OutOfTreeChangesResult {
	const { claimedFiles, observedFiles, leadTexts, runRoot } = input;
	if (claimedFiles.length === 0 || observedFiles.length > 0) {
		return { detected: false, foreignPath: null, claimedFiles: [] };
	}
	return {
		detected: true,
		foreignPath: extractForeignPath(leadTexts, runRoot),
		// Never empty: `claimedFiles.length === 0` already returned above, so a detected mismatch
		// always has at least one claimed file to show — the whole point is to never silently
		// report 0 files changed when leads claimed otherwise.
		claimedFiles: claimedFiles.slice(0, CLAIMED_SAMPLE_MAX),
	};
}

/**
 * Render `detectOutOfTreeChanges`'s result as the single summary line
 * (`core/report.ts`'s `buildRunSummary`) — `null` when there is nothing to report. Names the
 * foreign path when one was found; otherwise falls back to the claimed files themselves so the
 * line is never empty-handed.
 */
export function outOfTreeChangesSummaryLine(result: OutOfTreeChangesResult): string | null {
	if (!result.detected) return null;
	const named = result.foreignPath ?? result.claimedFiles.join(", ");
	return `changes outside run tree: ${named}`;
}

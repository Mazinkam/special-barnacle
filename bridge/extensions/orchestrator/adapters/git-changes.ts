/**
 * Git changed-files / diff helpers (B4.3). Used to tell files a lead phase
 * actually changed apart from files that were already dirty, or merely
 * mentioned in a report ("phantom" claims). Every function here shells out to
 * `git` via `spawnSync`; there is no other I/O and no module-level state, so
 * `cwd` (and, for the fingerprint helpers, an explicit worktree root) is the
 * only "dependency" these take.
 */

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

/** Fingerprint recorded for a dirty path that no longer exists on disk. */
export const DELETED_FINGERPRINT = "<deleted>";
/** Fingerprint for dirty entries that are not regular files (submodules, nested repos, symlinked dirs). */
export const NON_FILE_FINGERPRINT = "<non-file>";
/** Fingerprint for paths `git hash-object --stdin-paths` cannot accept (embedded newline). */
export const UNHASHABLE_FINGERPRINT = "<unhashable>";
/** Generous cap for `git status` / `hash-object` output on large, noisy trees. */
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Paths that differ from HEAD (modified, added, deleted, renamed, untracked),
 * repo-relative, mapped to a content fingerprint (git blob hash, or
 * `DELETED_FINGERPRINT`). Two snapshots taken around a run let callers tell a
 * file that was actually edited apart from one that was already dirty and
 * merely mentioned in a report. `null` when `cwd` is not inside a git work
 * tree, in which case callers fall back to the scraped list.
 */
export function gitDirtySnapshot(cwd: string): Map<string, string> | null {
	// `git status` reports paths relative to the repository root, not `cwd`, so
	// resolve the root once for the filesystem checks below.
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 10_000 });
	if (top.status !== 0) return null;
	const root = top.stdout.trim();
	if (!root) return null;
	const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
		cwd: root,
		encoding: "utf-8",
		timeout: 10_000,
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	if (status.status !== 0) return null;
	const paths: string[] = [];
	const entries = status.stdout.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		// "XY path"; renames emit destination and source as adjacent records.
		// Keep the source as a deleted baseline path: committing a rename that
		// was already staged before the run must not count as new work.
		paths.push(entry.slice(3));
		if (entry[0] === "R" || entry[1] === "R") {
			const source = entries[++i];
			if (source) paths.push(source);
		} else if (entry[0] === "C" || entry[1] === "C") i++;
	}
	const out = new Map<string, string>();
	const present: string[] = [];
	for (const p of paths) {
		let st: ReturnType<typeof lstatSync> | null = null;
		try {
			st = lstatSync(join(root, p));
		} catch {
			st = null;
		}
		if (!st) out.set(p, DELETED_FINGERPRINT);
		// `hash-object` refuses directories (submodules, nested repos) and would
		// abort the whole batch; fingerprint them by kind instead of content.
		else if (!st.isFile()) out.set(p, NON_FILE_FINGERPRINT);
		// `--stdin-paths` is newline-delimited and has no -z form.
		else if (p.includes("\n")) out.set(p, UNHASHABLE_FINGERPRINT);
		else present.push(p);
	}
	if (present.length > 0) {
		const hashed = spawnSync("git", ["hash-object", "--stdin-paths"], {
			cwd: root,
			encoding: "utf-8",
			input: `${present.join("\n")}\n`,
			timeout: 30_000,
			maxBuffer: GIT_OUTPUT_MAX_BUFFER,
		});
		if (hashed.status !== 0) return null;
		const hashes = hashed.stdout.trim().split("\n");
		if (hashes.length !== present.length) return null;
		present.forEach((p, idx) => out.set(p, hashes[idx]));
	}
	return out;
}

/**
 * Decide which files a lead phase actually changed. A path counts when it is
 * dirty after the run and either was clean before or has different content
 * now. `claimed` (paths scraped from lead prose) is only used when git
 * snapshots are unavailable, and to report phantoms — files the lead named
 * but did not touch. Note a pre-dirty file the lead reverts to HEAD drops out
 * of `after` and is therefore not reported as changed.
 */
export function diffDirtySnapshots(
	before: Map<string, string> | null,
	after: Map<string, string> | null,
	claimed: Iterable<string>,
): { changed: string[]; phantom: string[] } {
	const claimedSet = new Set(claimed);
	if (!before || !after) return { changed: [...claimedSet], phantom: [] };
	const changed: string[] = [];
	for (const [path, fingerprint] of after) {
		if (before.get(path) !== fingerprint) changed.push(path);
	}
	const changedSet = new Set(changed);
	const phantom = [...claimedSet].filter((f) => !changedSet.has(f));
	return { changed, phantom };
}

/** Starting HEAD for a run; an unborn/non-Git repository has no commit history to compare. */
export function gitHead(cwd: string): string | null {
	const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd, encoding: "utf-8", timeout: 10_000,
	});
	if (result.status === 0 && /^[0-9a-f]{40,64}$/.test(result.stdout.trim())) return result.stdout.trim();
	// An unborn branch has no HEAD yet, but its first commit must still count.
	const ref = spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd, encoding: "utf-8", timeout: 10_000 });
	if (ref.status !== 0 || !ref.stdout.trim()) return null;
	const exists = spawnSync("git", ["show-ref", "--verify", "--quiet", ref.stdout.trim()], { cwd, timeout: 10_000 });
	if (exists.status !== 1) return null;
	const empty = spawnSync("git", ["hash-object", "-t", "tree", "--stdin"], {
		cwd, encoding: "utf-8", input: "", timeout: 10_000,
	});
	return empty.status === 0 && /^[0-9a-f]{40,64}$/.test(empty.stdout.trim()) ? empty.stdout.trim() : null;
}

/** Current worktree content for a path that was already dirty when the run began. */
function currentFingerprint(root: string, path: string): string | null {
	let st: ReturnType<typeof lstatSync>;
	try { st = lstatSync(join(root, path)); } catch { return DELETED_FINGERPRINT; }
	if (!st.isFile()) return NON_FILE_FINGERPRINT;
	if (path.includes("\n")) return UNHASHABLE_FINGERPRINT;
	const hashed = spawnSync("git", ["hash-object", "--stdin-paths"], {
		cwd: root, encoding: "utf-8", input: `${path}\n`, timeout: 30_000, maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	return hashed.status === 0 && /^[0-9a-f]{40,64}$/.test(hashed.stdout.trim()) ? hashed.stdout.trim() : null;
}

/** Union changes committed during the run with edits that remain dirty at verification time. */
export function changedFilesSinceRunStart(
	cwd: string,
	startHead: string | null,
	beforeDirty: Map<string, string> | null,
	claimed: Iterable<string>,
	afterDirty = gitDirtySnapshot(cwd),
): { changed: string[]; phantom: string[]; historyUnavailable?: boolean } {
	const claimedSet = new Set(claimed);
	const dirty = diffDirtySnapshots(beforeDirty, afterDirty, claimedSet);
	const changed = new Set(dirty.changed);
	if (!startHead && beforeDirty && afterDirty) {
		return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
	}
	if (startHead) {
		const history = spawnSync("git", ["diff", "--name-only", "--no-renames", "-z", startHead, "HEAD"], {
			cwd, encoding: "utf-8", timeout: 30_000, maxBuffer: GIT_OUTPUT_MAX_BUFFER,
		});
		if (history.status !== 0) {
			// History was rewritten or Git failed: use the reported paths rather than
			// falsely treating an implementation run as report-only.
			return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
		}
		const paths = history.stdout.split("\0").filter(Boolean);
		if (beforeDirty && paths.some((path) => beforeDirty.has(path))) {
			const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 10_000 });
			if (top.status !== 0 || !top.stdout.trim()) {
				return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
			}
			for (const path of paths) {
				const original = beforeDirty.get(path);
				if (original !== undefined) {
					const current = currentFingerprint(top.stdout.trim(), path);
					if (current === null) {
						return { changed: [...new Set([...changed, ...claimedSet])], phantom: [], historyUnavailable: true };
					}
					if (original === current) continue;
				}
				changed.add(path);
			}
		} else {
			for (const path of paths) changed.add(path);
		}
	}
	return {
		changed: [...changed],
		phantom: [...claimedSet].filter((path) => !changed.has(path)),
	};
}

/** Scrape backtick-quoted, file-path-looking tokens out of a lead's/reviewer's prose. */
export function parseFilesChanged(text: string): string[] {
	const files: string[] = [];
	const re = /`([^`]+\.[a-zA-Z0-9]+)`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const f = m[1];
		if (!files.includes(f) && looksLikeFilePath(f)) files.push(f);
	}
	return files;
}

export function looksLikeFilePath(s: string): boolean {
	return (
		s.startsWith("/") ||
		s.startsWith("~") ||
		/^[a-zA-Z0-9_./\\-]+\.(ts|tsx|js|jsx|py|md|json|yaml|yml|toml|rs|go|java|kt|swift|css|scss|html|sh|sql)$/.test(
			s,
		)
	);
}

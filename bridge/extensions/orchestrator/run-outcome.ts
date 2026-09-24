/**
 * Pure run-outcome classification from lead reports. Fixes two false greens
 * seen on 2026-09-24 (run ht-orch-1790237987755-lyjkn8): every lead stopped at
 * a precondition, yet the run reported "verification: PASS" because QA
 * checked files a concurrent session had edited.
 *
 * - A lead ends its report with `STATUS: completed|partial|blocked`
 *   (LEAD_STATUS_CONTRACT in index.ts). All-blocked => the run is BLOCKED.
 * - If every lead explicitly reports `## Files Changed: None`, files git shows
 *   as changed during the run were changed by someone else; they are not the
 *   run's work and must not be sent to QA.
 */

export type LeadStatus = "completed" | "partial" | "blocked" | "unknown";

export function parseLeadStatus(report: string): LeadStatus {
	// Line-anchored (a STATUS quoted mid-sentence does not count); tolerates
	// list markers, bold/italic/code around the key and the value.
	const matches = [...report.matchAll(/^[\s>*_`-]*STATUS[*_`]*\s*:[\s*_`]*([a-z]+)/gim)];
	const last = matches.at(-1)?.[1]?.toLowerCase();
	return last === "completed" || last === "partial" || last === "blocked" ? last : "unknown";
}

export type LeadFilesChanged = { kind: "none" } | { kind: "list"; files: string[] } | { kind: "unknown" };

export function parseLeadFilesChanged(report: string): LeadFilesChanged {
	const m = /^##\s*Files Changed\s*:?[ \t]*([^\n]*)\n?([\s\S]*?)(?=^##\s|^[\s>*_`-]*STATUS[*_`]*\s*:|(?![\s\S]))/im.exec(report);
	if (!m) return { kind: "unknown" };
	const section = `${m[1]}\n${m[2]}`.trim();
	// Listed paths win over any leading "None of …" wording.
	const files = [...section.matchAll(/^[-*]\s+`?([^`\s—]+)`?/gm)].map((f) => f[1]).filter((f) => !/^(none|n\/a|nothing)\b/i.test(f));
	if (files.length > 0) return { kind: "list", files };
	if (section === "" || /^[-*\s]*(none|n\/a|nothing)\b/i.test(section)) return { kind: "none" };
	return { kind: "unknown" };
}

export type RunOutcome = "blocked" | "dispatched" | "failed";

export function classifyRunOutcome(input: { leadStatuses: LeadStatus[]; succeededLeads: number; leads: number }): RunOutcome {
	if (input.leads === 0 || input.succeededLeads === 0) return "failed";
	// BLOCKED only when every lead exited cleanly AND reported blocked; a lead
	// that crashed after writing "STATUS: blocked" may have changed files.
	if (input.succeededLeads === input.leads && input.leadStatuses.length === input.leads &&
		input.leadStatuses.every((s) => s === "blocked")) return "blocked";
	return "dispatched";
}

/**
 * Git-changed files that no lead claims: only when EVERY lead exited 0 AND
 * its report states explicitly that it changed nothing. A lead that failed,
 * timed out or hit the spend cap may have edited files it never reported, so
 * any such lead — or any list / missing section — keeps the conservative
 * default: the run owns what git shows and QA verifies it.
 */
export function externalChangeFiles(gitChanged: string[], leads: Array<{ exitCode: number; stdout: string }>): string[] {
	if (leads.length === 0) return [];
	const allCleanNone = leads.every((l) => l.exitCode === 0 && parseLeadFilesChanged(l.stdout).kind === "none");
	return allCleanNone ? [...gitChanged] : [];
}

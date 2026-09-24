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
	const matches = [...report.matchAll(/^[\s>*_`]*STATUS:\s*([a-z]+)/gim)];
	const last = matches.at(-1)?.[1]?.toLowerCase();
	return last === "completed" || last === "partial" || last === "blocked" ? last : "unknown";
}

export type LeadFilesChanged = { kind: "none" } | { kind: "list"; files: string[] } | { kind: "unknown" };

export function parseLeadFilesChanged(report: string): LeadFilesChanged {
	const section = /^##\s*Files Changed\s*\n([\s\S]*?)(?=^##\s|^[\s>*_`]*STATUS:|(?![\s\S]))/im.exec(report)?.[1]?.trim();
	if (section === undefined) return { kind: "unknown" };
	if (section === "" || /^[-*\s]*(none|n\/a|nothing)\b/i.test(section)) return { kind: "none" };
	const files = [...section.matchAll(/^[-*]\s+`?([^`\s—]+)`?/gm)].map((m) => m[1]);
	return files.length > 0 ? { kind: "list", files } : { kind: "unknown" };
}

export type RunOutcome = "blocked" | "dispatched" | "failed";

export function classifyRunOutcome(input: { leadStatuses: LeadStatus[]; succeededLeads: number; leads: number }): RunOutcome {
	if (input.leads === 0 || input.succeededLeads === 0) return "failed";
	if (input.leadStatuses.length > 0 && input.leadStatuses.every((s) => s === "blocked")) return "blocked";
	return "dispatched";
}

/**
 * Git-changed files that no lead claims: only when EVERY lead report states
 * explicitly that it changed nothing. Any list or missing section keeps the
 * conservative default (the run owns what git shows).
 */
export function externalChangeFiles(gitChanged: string[], leadReports: string[]): string[] {
	if (leadReports.length === 0) return [];
	const allNone = leadReports.every((r) => parseLeadFilesChanged(r).kind === "none");
	return allNone ? [...gitChanged] : [];
}

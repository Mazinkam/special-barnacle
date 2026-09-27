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

import type { DispatchResult } from "./core/records.ts";

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

/**
 * `scoped_leads`: `externalChangeFiles` above classifies "changed by someone else" purely from
 * each lead's own report prose (`## Files Changed: None`) — correct for an ordinary long-lived
 * lead, whose one dispatch's report IS the whole story. A scoped lead's final result is a REPORT
 * phase that legitimately says "None" for its OWN phase while an earlier plan/integrate phase in
 * the SAME chain made real edits. The de-duplicated `filesChanged` union `finalizeScopedLeadResult`
 * (index.ts) attaches is not by itself trustworthy evidence of "no files changed": `parseFilesChanged`
 * only recognizes backtick-quoted paths with a known extension, so a phase reporting `- Dockerfile`
 * or `- src/a.ts` (unbackticked, or extensionless) contributes nothing to that union even though
 * `parseLeadFilesChanged` (this file) — what `externalChangeFiles` itself uses — would read it as a
 * real listed file. An empty union therefore never proves no edits happened; only every phase's own
 * prose, reparsed the same way `externalChangeFiles` reparses an ordinary lead's, can prove that.
 *
 * So for a lead that ran as a scoped chain (`scopedPhaseReports` present, attached only by
 * `finalizeScopedLeadResult`): reparse EVERY phase's stdout with `parseLeadFilesChanged` and
 * combine with the union.
 *   - `exitCode`: the final phase's exit code if every phase in the chain exited 0, otherwise a
 *     non-zero code (so `externalChangeFiles`'s exit-code gate never treats a chain with a failed
 *     phase as "all clean").
 *   - Evidence is exactly `## Files Changed\nNone` only when every phase exited 0 AND every phase's
 *     own `parseLeadFilesChanged` reads `"none"` AND the union is empty.
 *   - Otherwise, if the union is non-empty OR any phase parses as a `"list"`, evidence lists the
 *     union plus every path any phase's `parseLeadFilesChanged` found.
 *   - Otherwise (some phase is unparseable and nothing above proved either "none" or "list"): emit
 *     no `## Files Changed` section at all — `parseLeadFilesChanged` reads that as `"unknown"`, the
 *     same conservative default `externalChangeFiles` already applies.
 *
 * A lead without `scopedPhaseReports` has only one dispatch whose report IS the whole story; this
 * passes that dispatch's real `stdout` through unchanged. The modular `pipeline/hierarchy.ts` does
 * not populate `scopedPhaseReports` today (`scoped_leads` has not been ported — see the A1
 * unification notes), so this is currently an identity transform on every `DispatchResult` it
 * produces; wiring it in now is forward-compatible and changes nothing at the current defaults.
 */
export function qaScopeEvidenceFor(
	leadResults: Array<Pick<DispatchResult, "exitCode" | "stdout" | "filesChanged" | "scopedPhaseReports">>,
): Array<{ exitCode: number; stdout: string }> {
	return leadResults.map((r) => {
		const phases = r.scopedPhaseReports;
		if (!phases) return { exitCode: r.exitCode, stdout: r.stdout };

		const allPhasesCleanExit = phases.every((p) => p.exitCode === 0);
		const firstFailedExit = phases.find((p) => p.exitCode !== 0)?.exitCode;
		const exitCode = allPhasesCleanExit ? r.exitCode : (firstFailedExit ?? 1);

		const parsedPhases = phases.map((p) => parseLeadFilesChanged(p.stdout));
		const union = new Set<string>(r.filesChanged);
		let anyList = false;
		for (const parsed of parsedPhases) {
			if (parsed.kind === "list") {
				anyList = true;
				for (const f of parsed.files) union.add(f);
			}
		}

		if (allPhasesCleanExit && union.size === 0 && parsedPhases.every((p) => p.kind === "none")) {
			return { exitCode, stdout: "## Files Changed\nNone" };
		}
		if (union.size > 0 || anyList) {
			return { exitCode, stdout: `## Files Changed\n${[...union].map((f) => `- \`${f}\``).join("\n")}` };
		}
		return { exitCode, stdout: "" };
	});
}

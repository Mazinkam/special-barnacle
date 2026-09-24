import { describe, expect, test } from "bun:test";
import { classifyRunOutcome, externalChangeFiles, parseLeadFilesChanged, parseLeadStatus } from "./run-outcome.ts";

const report = (status: string, files = "None.") => `## Completed\nstuff\n\n## Files Changed\n${files}\n\n## Open items\n- x\n\n${status}`;

describe("parseLeadStatus", () => {
	test("reads the last STATUS line", () => {
		expect(parseLeadStatus(report("STATUS: blocked"))).toBe("blocked");
		expect(parseLeadStatus(report("STATUS: completed"))).toBe("completed");
		expect(parseLeadStatus("STATUS: partial\n")).toBe("partial");
		expect(parseLeadStatus("**STATUS: BLOCKED**")).toBe("blocked");
		expect(parseLeadStatus("STATUS: completed\nlater\nSTATUS: blocked")).toBe("blocked");
	});
	test("missing or invalid status is unknown", () => {
		expect(parseLeadStatus("no status here")).toBe("unknown");
		expect(parseLeadStatus("STATUS: great")).toBe("unknown");
		expect(parseLeadStatus("")).toBe("unknown");
	});
});

describe("parseLeadFilesChanged", () => {
	test("explicit none", () => {
		expect(parseLeadFilesChanged(report("STATUS: blocked", "None."))).toEqual({ kind: "none" });
		expect(parseLeadFilesChanged(report("STATUS: blocked", "- None"))).toEqual({ kind: "none" });
		expect(parseLeadFilesChanged(report("STATUS: blocked", "None; nothing was implemented."))).toEqual({ kind: "none" });
	});
	test("a list of paths", () => {
		expect(parseLeadFilesChanged(report("STATUS: completed", "- `src/a.ts` — added x\n- `src/b.ts` — fixed y"))).toEqual({ kind: "list", files: ["src/a.ts", "src/b.ts"] });
	});
	test("no section is unknown", () => {
		expect(parseLeadFilesChanged("## Completed\nx")).toEqual({ kind: "unknown" });
	});
});

describe("classifyRunOutcome", () => {
	test("all leads blocked -> blocked, even if git shows changes", () => {
		expect(classifyRunOutcome({ leadStatuses: ["blocked", "blocked", "blocked"], succeededLeads: 3, leads: 3 })).toBe("blocked");
	});
	test("a blocked lead that did not exit cleanly does not make the run blocked", () => {
		expect(classifyRunOutcome({ leadStatuses: ["blocked", "blocked"], succeededLeads: 1, leads: 2 })).toBe("dispatched");
	});
	test("mixed or completed -> dispatched", () => {
		expect(classifyRunOutcome({ leadStatuses: ["blocked", "completed"], succeededLeads: 2, leads: 2 })).toBe("dispatched");
		expect(classifyRunOutcome({ leadStatuses: ["unknown"], succeededLeads: 1, leads: 1 })).toBe("dispatched");
	});
	test("no lead succeeded -> failed", () => {
		expect(classifyRunOutcome({ leadStatuses: ["unknown"], succeededLeads: 0, leads: 1 })).toBe("failed");
		expect(classifyRunOutcome({ leadStatuses: [], succeededLeads: 0, leads: 0 })).toBe("failed");
	});
});

describe("externalChangeFiles", () => {
	const ok = (stdout: string) => ({ exitCode: 0, stdout });
	test("every lead exited 0 and said None -> all git-changed files are external", () => {
		expect(externalChangeFiles(["a.py", "b.py"], [ok(report("STATUS: completed")), ok(report("STATUS: blocked"))])).toEqual(["a.py", "b.py"]);
	});
	test("any lead that listed files or omitted the section -> nothing is classed external", () => {
		expect(externalChangeFiles(["a.py"], [ok(report("STATUS: completed", "- `a.py` — x")), ok(report("STATUS: blocked"))])).toEqual([]);
		expect(externalChangeFiles(["a.py"], [ok("## Completed\nno files section")])).toEqual([]);
		expect(externalChangeFiles(["a.py"], [])).toEqual([]);
	});
	test("a lead that failed, timed out or hit the spend cap keeps every file in QA", () => {
		for (const exitCode of [1, 124, 125]) {
			expect(externalChangeFiles(["a.py"], [{ exitCode, stdout: "" }, ok(report("STATUS: completed"))])).toEqual([]);
		}
	});
});

describe("report parsing — formatting variants (review fixes)", () => {
	test("bold or code-formatted STATUS values", () => {
		expect(parseLeadStatus("**STATUS:** blocked")).toBe("blocked");
		expect(parseLeadStatus("STATUS: `blocked`")).toBe("blocked");
		expect(parseLeadStatus("- **STATUS**: completed")).toBe("completed");
	});
	test("a STATUS quoted mid-sentence does not count", () => {
		expect(parseLeadStatus("I will not report STATUS: blocked here.\nSTATUS: completed")).toBe("completed");
		expect(parseLeadStatus("The goal says to write STATUS: blocked if stuck.")).toBe("unknown");
	});
	test("inline '## Files Changed: None' is none", () => {
		expect(parseLeadFilesChanged("## Completed\nx\n## Files Changed: None\n\nSTATUS: completed")).toEqual({ kind: "none" });
	});
	test("a section that starts with 'None of …' but lists files is a list, not none", () => {
		expect(parseLeadFilesChanged("## Files Changed\nNone of the API files; updated:\n- `src/a.ts` — fix\n\nSTATUS: completed"))
			.toEqual({ kind: "list", files: ["src/a.ts"] });
	});
});

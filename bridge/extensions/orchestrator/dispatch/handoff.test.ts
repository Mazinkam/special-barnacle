import { describe, expect, test } from "bun:test";
import type { EventScan } from "../core/event-scan.ts";
import { HANDOFF_MAX_CHARS, buildHandoff } from "./handoff.ts";

const scan = (o: Partial<EventScan> = {}): EventScan => ({
	toolCalls: 5, toolInFlight: false, lastAssistantText: "Batch A done; starting batch B.", finishedWorkers: [], unfinishedWorkers: [], subagentCalls: [], ...o,
});
const input = { taskId: "run-lead-0", attempt: 2, previousModel: "amazon-bedrock/global.anthropic.claude-fable-5-1", failureClass: "transient", reason: "[provider error] Service unavailable" };

describe("buildHandoff", () => {
	test("carries header, files, workers, last text and the closing instruction", () => {
		const h = buildHandoff({
			...input,
			filesChanged: ["orchestrator/cli.py", "tests/test_cli_args.py"],
			scan: scan({ finishedWorkers: [{ id: "t205", ok: true, summary: "## Completed" }, { id: "t206", ok: false, summary: "" }], unfinishedWorkers: ["t210"] }),
		});
		expect(h.split("\n")).toEqual([
			"## Resume from a failed attempt (attempt 2 of run-lead-0; previous model amazon-bedrock/global.anthropic.claude-fable-5-1 failed: transient [provider error] Service unavailable)",
			"Work already on disk: verify it, don't redo it.",
			"- Files changed since this dispatch started: orchestrator/cli.py, tests/test_cli_args.py",
			"- Finished nested workers: t205 ✓ ## Completed; t206 ✗   Unfinished: t210",
			"- Last plan/report text from the previous attempt (bounded): Batch A done; starting batch B.",
			"Continue from here. Re-run the verification before claiming success.",
		]);
	});
	test("bounds the file list, redacts, and handles empty input", () => {
		const files = Array.from({ length: 150 }, (_, i) => `/Users/someone/repo/f${i}.ts`);
		const h = buildHandoff({ ...input, filesChanged: files, scan: scan(), redact: (s) => s.replaceAll("/Users/someone", "~") });
		expect(h).toContain("~/repo/f99.ts +50 more");
		expect(h).not.toContain("f100.ts");
		expect(h).not.toContain("/Users/someone");
		const empty = buildHandoff({ ...input, filesChanged: [], scan: scan({ lastAssistantText: "" }) });
		expect(empty).toContain("Files changed since this dispatch started: (none detected)");
		expect(empty).toContain("Finished nested workers: (none)   Unfinished: (none)");
		expect(empty).toContain("(bounded): (none)");
	});
	test("caps the whole section and keeps the closing line", () => {
		const files = Array.from({ length: 100 }, (_, i) => `repo/${"d".repeat(200)}/f${i}.ts`);
		const h = buildHandoff({ ...input, filesChanged: files, scan: scan({ lastAssistantText: "x".repeat(9000) }) });
		expect(h.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
		expect(h.endsWith("Continue from here. Re-run the verification before claiming success.")).toBe(true);
	});
	test("keeps the END of a long last text", () => {
		const h = buildHandoff({ ...input, filesChanged: [], scan: scan({ lastAssistantText: "a".repeat(5000) + "TAIL" }) });
		expect(h).toContain("…" + "a".repeat(3995) + "TAIL");
	});
	test("does not leak a fragment of a secret that straddles the truncation boundary", () => {
		const secret = "SECRET-abcdefghij"; // 7 + 10 = 17 chars
		const before = "z".repeat(3990);
		const after = "y".repeat(3987);
		// Naive truncate-then-redact keeps the last 3999 chars of the RAW text, which starts
		// 5 chars into `secret` — cutting off the "SECRE" prefix the redactor needs to match.
		const text = before + secret + after;
		const h = buildHandoff({
			...input,
			filesChanged: [],
			scan: scan({ lastAssistantText: text }),
			redact: (s) => s.replace(/SECRET-\w+/g, "[REDACTED]"),
		});
		expect(h).not.toContain("SECRET-");
		expect(h).not.toContain("abcdef");
		expect(h).not.toContain("cdefghij");
		expect(h).toContain("[REDACTED]");
	});
	test("bounds the last-text segment even when the redactor expands it", () => {
		const h = buildHandoff({
			...input,
			filesChanged: [],
			scan: scan({ lastAssistantText: "x".repeat(2000) }),
			redact: (s) => s.replaceAll("x", "xxxxx"),
		});
		const lines = h.split("\n");
		const prefix = "- Last plan/report text from the previous attempt (bounded): ";
		const lastLine = lines.find((l) => l.startsWith(prefix));
		expect(lastLine).toBeDefined();
		expect((lastLine!.length - prefix.length)).toBeLessThanOrEqual(4000);
		expect(h.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
		expect(h.endsWith("Continue from here. Re-run the verification before claiming success.")).toBe(true);
	});
});

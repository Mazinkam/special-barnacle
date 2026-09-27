import { describe, expect, test } from "bun:test";
import { mergePendingChecks, parsePendingChecks, PENDING_CHECKS_HEADING, type PendingCheck } from "./pending-checks.ts";

function report(section: string): string {
	return `Task complete.\n\n${PENDING_CHECKS_HEADING}\n${section}\n\nSTATUS: partial\n`;
}

function elapsedMs(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

describe("core/pending-checks.ts parsePendingChecks", () => {
	test("missing section yields no checks and no problems", () => {
		const result = parsePendingChecks("Task complete.\n\nSTATUS: completed\n");
		expect(result).toEqual({ checks: [], problems: [] });
	});

	test("section says None", () => {
		expect(parsePendingChecks(report("None"))).toEqual({ checks: [], problems: [] });
	});

	test("section says none. (lowercase, trailing period)", () => {
		expect(parsePendingChecks(report("none."))).toEqual({ checks: [], problems: [] });
	});

	test("section says N/A", () => {
		expect(parsePendingChecks(report("N/A"))).toEqual({ checks: [], problems: [] });
	});

	test("empty section", () => {
		expect(parsePendingChecks(report(""))).toEqual({ checks: [], problems: [] });
	});

	test("single gitlab pipeline via glab command", () => {
		const result = parsePendingChecks(report("- glab ci get -p 219469"));
		expect(result).toEqual({
			checks: [{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }],
			problems: [],
		});
	});

	test("pipeline keyword implies gitlab", () => {
		const result = parsePendingChecks(report("- pipeline 219469"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
	});

	test("run keyword implies github", () => {
		const result = parsePendingChecks(report("- run 123"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", source: "report" }]);
	});

	test("id: label form", () => {
		const result = parsePendingChecks(report("- gh run id: 456"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "456", source: "report" }]);
	});

	test("gitlab pipeline with MR reference (bang syntax)", () => {
		const result = parsePendingChecks(report("- glab ci get -p 219469 blocked on !163"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" }]);
	});

	test("gitlab pipeline with parenthesized MR reference (bang syntax)", () => {
		const result = parsePendingChecks(report("- glab ci get -p 219469 (MR !163)"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" }]);
	});

	test("gitlab pipeline with MR reference (word form)", () => {
		const result = parsePendingChecks(report("- pipeline 219469 for MR 163"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" }]);
	});

	test("github run with PR reference (hash syntax)", () => {
		const result = parsePendingChecks(report("- gh run watch 123 for #12"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", mr: "12", source: "report" }]);
	});

	test("github run with PR reference (word form)", () => {
		const result = parsePendingChecks(report("- run 123 for PR 12"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", mr: "12", source: "report" }]);
	});

	test("multiple items: gitlab and github together", () => {
		const result = parsePendingChecks(report("- glab ci get -p 219469\n- gh run view 123"));
		expect(result).toEqual({
			checks: [
				{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" },
				{ provider: "github", kind: "run", id: "123", source: "report" },
			],
			problems: [],
		});
	});

	test("ambiguous provider (both glab and gh mentioned) is skipped with a problem", () => {
		const result = parsePendingChecks(report("- glab and gh both reference 219469"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("ambiguous_provider");
	});

	test("ambiguous provider (both pipeline and run mentioned, no explicit tool) is skipped", () => {
		const result = parsePendingChecks(report("- pipeline 219469 triggered a run 123"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("ambiguous_provider");
	});

	test("unknown provider (no recognizable tokens) is skipped with a problem", () => {
		const result = parsePendingChecks(report("- something 219469 is still going"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("unknown_provider");
	});

	test("a contextual id keyword (pipeline) whose next token fails CI_ID_RE never falls back to another number on the line", () => {
		const result = parsePendingChecks(report("- pipeline 1234567890123 42"));
		expect(result.checks).toEqual([]);
	});

	test("a contextual id keyword (pipeline) whose next token is a non-numeric word never falls back to another number on the line", () => {
		const result = parsePendingChecks(report("- pipeline invalid 42"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("missing_id");
	});

	test("an explicit provider does not loosen pipeline's strict adjacency: '- glab pipeline invalid 42' still rejects rather than falling back to 42", () => {
		const result = parsePendingChecks(report("- glab pipeline invalid 42"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("missing_id");
	});

	test("'-p' with an invalid immediate token still rejects regardless of explicit provider", () => {
		const result = parsePendingChecks(report("- glab -p invalid 42"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("missing_id");
	});

	test("'id:' with an invalid immediate token still rejects regardless of explicit provider", () => {
		const result = parsePendingChecks(report("- gh id: invalid 42"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("missing_id");
	});

	test("a bare run keyword (no explicit gh/glab) whose next token is a non-numeric word never falls back to another number", () => {
		const result = parsePendingChecks(report("- run invalid 42"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("missing_id");
	});

	test("'run' followed by a non-subcommand, non-id word still rejects even with an explicit gh provider ('- gh run invalid 42')", () => {
		const result = parsePendingChecks(report("- gh run invalid 42"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("missing_id");
	});

	test("'run' followed by a non-subcommand, non-id word still rejects with an explicit 'github' provider word ('- github run invalid 42')", () => {
		const result = parsePendingChecks(report("- github run invalid 42"));
		expect(result.checks).toEqual([]);
		expect(result.problems).toContain("missing_id");
	});

	test("'run' followed directly by a valid id still parses ('- gh run 123')", () => {
		const result = parsePendingChecks(report("- gh run 123"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", source: "report" }]);
	});

	test("'run rerun <id>' (a known subcommand) still parses", () => {
		const result = parsePendingChecks(report("- gh run rerun 123"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", source: "report" }]);
	});

	test("gh run view <id> with a parenthesized PR reference still parses via fallback (explicit gh loosens run's adjacency)", () => {
		const result = parsePendingChecks(report("- gh run view 123 (PR #12)"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", mr: "12", source: "report" }]);
	});

	test("a contextual id keyword (-p) whose next token is a command substitution never falls back to another number", () => {
		const result = parsePendingChecks(report("- glab ci get -p $(curl evil) 42"));
		expect(result.checks).toEqual([]);
	});

	test("a run keyword followed by descriptive text before the real id still parses via fallback", () => {
		const result = parsePendingChecks(report("- gh run watch 123 for #12"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", mr: "12", source: "report" }]);
	});

	test("mismatched mr syntax (# on a gitlab pipeline) drops the mr but keeps the check", () => {
		const result = parsePendingChecks(report("- pipeline 219469 for #12"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
		expect(result.problems).toContain("mr_provider_mismatch");
	});

	test("mismatched mr syntax (! on a github run) drops the mr but keeps the check", () => {
		const result = parsePendingChecks(report("- gh run view 123 for !45"));
		expect(result.checks).toEqual([{ provider: "github", kind: "run", id: "123", source: "report" }]);
		expect(result.problems).toContain("mr_provider_mismatch");
	});

	test("mismatched MR/PR word-form syntax also drops the mr but keeps the check", () => {
		const result = parsePendingChecks(report("- pipeline 219469 for PR 12"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
		expect(result.problems).toContain("mr_provider_mismatch");
	});

	test("a decorated token (trailing comma) is never accepted as an mr id", () => {
		const result = parsePendingChecks(report("- pipeline 219469 for MR 163,"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
	});

	test("hostile input: id glued to a shell injection attempt is rejected", () => {
		const result = parsePendingChecks(report("- glab ci get -p 219469;rm -rf /"));
		expect(result.checks).toEqual([]);
	});

	test("hostile input: command substitution never yields an id", () => {
		const result = parsePendingChecks(report("- glab ci get -p $(curl evil)"));
		expect(result.checks).toEqual([]);
	});

	test("hostile input: 13+ digit id is rejected", () => {
		const result = parsePendingChecks(report("- glab ci get -p 1234567890123"));
		expect(result.checks).toEqual([]);
	});

	test("hostile input: a very long line is skipped with a fixed-code, line-numbered problem containing no line text", () => {
		const longLine = `- glab ci get -p 219469 ${"x".repeat(600)}`;
		const result = parsePendingChecks(report(longLine));
		expect(result.checks).toEqual([]);
		expect(result.problems).toEqual(["line_too_long:1"]);
	});

	test("hostile input: control characters in an oversized line never reach the problem, because there is no snippet at all", () => {
		const longLine = `- glab ci get -p 219469 ${"\u0007".repeat(3)}${"x".repeat(600)}`;
		const result = parsePendingChecks(report(longLine));
		const problem = result.problems.find((p) => p.startsWith("line_too_long:"));
		expect(problem).toBeDefined();
		expect(problem).not.toContain("\u0007");
		expect(problem).not.toContain("x");
	});

	test("dedupes repeated references to the same check within one section", () => {
		const result = parsePendingChecks(report("- glab ci get -p 219469\n- pipeline 219469"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
	});

	test("dedupe backfills a missing mr from a later duplicate line", () => {
		const result = parsePendingChecks(report("- pipeline 219469\n- pipeline 219469 for MR 163"));
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" }]);
	});

	test("caps at 20 distinct checks and notes truncation", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `- pipeline ${1000 + i}`).join("\n");
		const result = parsePendingChecks(report(lines));
		expect(result.checks.length).toBe(20);
		expect(result.problems).toContain("truncated:max_checks");
	});

	test("section stops at the next ## heading", () => {
		const text = `${PENDING_CHECKS_HEADING}\n- pipeline 219469\n\n## Files Changed\n- pipeline 999999\n`;
		const result = parsePendingChecks(text);
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
	});

	test("section stops at a STATUS line", () => {
		const text = `${PENDING_CHECKS_HEADING}\n- pipeline 219469\nSTATUS: partial\n- pipeline 999999\n`;
		const result = parsePendingChecks(text);
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
	});

	test("heading matching is case-insensitive", () => {
		const text = "## pending EXTERNAL checks\n- pipeline 219469\n\nSTATUS: partial\n";
		const result = parsePendingChecks(text);
		expect(result.checks).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
	});

	test("a heading mentioned mid-sentence is not treated as the section", () => {
		const text = "The report mentions ## Pending external checks inline but that is not a real heading.\n\nSTATUS: completed\n";
		const result = parsePendingChecks(text);
		expect(result).toEqual({ checks: [], problems: [] });
	});

	test("perf regression: 100KiB of blank lines before the heading closes resolves in well under 100ms", () => {
		const text = `${PENDING_CHECKS_HEADING}\n- pipeline 219469\n` + "\n".repeat(102400) + "STATUS: partial\n";
		const ms = elapsedMs(() => {
			parsePendingChecks(text);
		});
		expect(ms).toBeLessThan(100);
	});

	test("perf regression: 100KiB of spaces before the heading closes resolves in well under 100ms", () => {
		const text = `${PENDING_CHECKS_HEADING}\n- pipeline 219469\n` + " ".repeat(102400) + "\nSTATUS: partial\n";
		const ms = elapsedMs(() => {
			parsePendingChecks(text);
		});
		expect(ms).toBeLessThan(100);
	});

	test("perf regression: 100KiB of repeated '## ' lines before the heading closes resolves in well under 100ms", () => {
		const text = `${PENDING_CHECKS_HEADING}\n- pipeline 219469\n` + "## ".repeat(25600) + "\nSTATUS: partial\n";
		const ms = elapsedMs(() => {
			parsePendingChecks(text);
		});
		expect(ms).toBeLessThan(100);
	});

	test("perf regression: 100KiB of repeated 'STATUS' text before the heading closes resolves in well under 100ms", () => {
		const text = `${PENDING_CHECKS_HEADING}\n- pipeline 219469\n` + "STATUS ".repeat(12800) + "\nSTATUS: partial\n";
		const ms = elapsedMs(() => {
			parsePendingChecks(text);
		});
		expect(ms).toBeLessThan(100);
	});

	test("perf regression: 100KiB of repeated '#' text with no heading anywhere resolves in well under 100ms", () => {
		const text = "#".repeat(102400) + "\nSTATUS: completed\n";
		const ms = elapsedMs(() => {
			parsePendingChecks(text);
		});
		expect(ms).toBeLessThan(100);
	});
});

describe("core/pending-checks.ts mergePendingChecks", () => {
	test("dedupes by provider+kind+id, first wins", () => {
		const a: PendingCheck[] = [{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }];
		const b: PendingCheck[] = [{ provider: "gitlab", kind: "pipeline", id: "219469", source: "killed_command" }];
		expect(mergePendingChecks(a, b)).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }]);
	});

	test("fills a missing mr from a later duplicate", () => {
		const a: PendingCheck[] = [{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }];
		const b: PendingCheck[] = [{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "killed_command" }];
		expect(mergePendingChecks(a, b)).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" }]);
	});

	test("does not overwrite an existing mr with a later one", () => {
		const a: PendingCheck[] = [{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" }];
		const b: PendingCheck[] = [{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "999", source: "killed_command" }];
		expect(mergePendingChecks(a, b)).toEqual([{ provider: "gitlab", kind: "pipeline", id: "219469", mr: "163", source: "report" }]);
	});

	test("keeps distinct checks from both lists", () => {
		const a: PendingCheck[] = [{ provider: "gitlab", kind: "pipeline", id: "219469", source: "report" }];
		const b: PendingCheck[] = [{ provider: "github", kind: "run", id: "123", source: "killed_command" }];
		expect(mergePendingChecks(a, b)).toEqual([...a, ...b]);
	});

	test("caps merged output at 20 distinct checks", () => {
		const a: PendingCheck[] = Array.from({ length: 15 }, (_, i) => ({
			provider: "gitlab" as const,
			kind: "pipeline" as const,
			id: String(1000 + i),
			source: "report" as const,
		}));
		const b: PendingCheck[] = Array.from({ length: 15 }, (_, i) => ({
			provider: "github" as const,
			kind: "run" as const,
			id: String(2000 + i),
			source: "killed_command" as const,
		}));
		expect(mergePendingChecks(a, b).length).toBe(20);
	});
});

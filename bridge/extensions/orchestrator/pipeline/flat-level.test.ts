import { describe, expect, test } from "bun:test";
import { dispatchFlat, implementerTask, runFlatVerification } from "./flat-level.ts";

const ok = (taskId: string, capability: string, stdout = "## Files Changed\n- src/a.ts\n\nSTATUS: completed") => ({
	taskId, capability, model: "p/m", exitCode: 0, stdout, stderr: "", filesChanged: ["src/a.ts"], durationMs: 1, costUsd: 0.1, costReported: true,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 1 },
});

describe("flat level", () => {
	test("implementer task carries goal, context and report contract", () => {
		const t = implementerTask("r1", "Fix src/a.ts", "CTX", "direct");
		expect(t.capability).toBe("implementation_strong");
		expect(t.task).toContain("Fix src/a.ts");
		expect(t.task).toContain("CTX");
		expect(t.task).toContain("STATUS: completed|partial|blocked");
	});

	test("dispatchFlat returns the hierarchy shape with one lead-equivalent result", async () => {
		const billed: string[] = [];
		const r = await dispatchFlat({ runId: "r1", goal: "g", providedContext: "", level: "direct" },
			{ dispatch: async (tasks) => tasks.map((t) => ok(t.taskId, t.capability)), captureDispatchCost: async (x) => { billed.push(x.taskId); } });
		expect(r.leadResults).toHaveLength(1);
		expect(r.leadTasks[0].taskId).toBe("r1-impl");
		expect(r.workerResults).toEqual([]);
		expect(billed).toEqual(["r1-impl"]);
	});

	test("direct: failing deterministic check fails verification and records run-scoped outcome", async () => {
		const outcomes: Record<string, unknown>[] = [];
		const v = await runFlatVerification({ runId: "r1", level: "direct", files: ["src/a.ts"], checks: [{ name: "test", argv: ["x"], cwd: ".", source: "p" }], repoRoot: "/r", checkTimeoutMs: 1000, goal: "g" },
			{ dispatch: async () => [], captureDispatchCost: async () => {}, recordOutcome: (o) => outcomes.push(o),
			  runChecks: async () => [{ name: "test", argv: ["x"], status: "fail", exitCode: 1, durationMs: 1, tail: "1 failed" }] });
		expect(v.passed).toBe(false);
		expect(v.failedChecks).toEqual(["test"]);
		expect(outcomes[0]).toMatchObject({ task_id: "r1-qa", verification_scope: "run", outcome: "fail", verification: false, workflow_level: "direct" });
	});

	test("checked: passing checks plus explicit FAIL review verdict fails", async () => {
		const v = await runFlatVerification({ runId: "r1", level: "checked", files: ["src/a.ts"], checks: [{ name: "test", argv: ["x"], cwd: ".", source: "p" }], repoRoot: "/r", checkTimeoutMs: 1000, goal: "g" },
			{ dispatch: async (tasks) => tasks.map((t) => ok(t.taskId, t.capability, "## Verdict\nFAIL\n- off-by-one remains")), captureDispatchCost: async () => {}, recordOutcome: () => {},
			  runChecks: async () => [{ name: "test", argv: ["x"], status: "pass", exitCode: 0, durationMs: 1, tail: "" }] });
		expect(v.passed).toBe(false);
		expect(v.failedChecks).toEqual(["review"]);
		expect(v.dispatch?.capability).toBe("technical_review");
	});

	test("no changed files is skipped (never a pass on nothing)", async () => {
		const v = await runFlatVerification({ runId: "r1", level: "direct", files: [], checks: [], repoRoot: "/r", checkTimeoutMs: 1, goal: "g" },
			{ dispatch: async () => [], captureDispatchCost: async () => {}, recordOutcome: () => {} });
		expect(v.skipped).toBe(true);
	});
	describe("checked: requires an affirmative PASS verdict", () => {
		const review = (stdout: string) => runFlatVerification({ runId: "r1", level: "checked", files: ["src/a.ts"], checks: [{ name: "test", argv: ["x"], cwd: ".", source: "p" }], repoRoot: "/r", checkTimeoutMs: 1000, goal: "g" },
			{ dispatch: async (tasks) => tasks.map((t) => ok(t.taskId, t.capability, stdout)), captureDispatchCost: async () => {}, recordOutcome: () => {},
			  runChecks: async () => [{ name: "test", argv: ["x"], status: "pass", exitCode: 0, durationMs: 1, tail: "" }] });
		test("empty reviewer output is not a pass", async () => {
			const v = await review("");
			expect(v.passed).toBe(false);
			expect(v.failedChecks).toContain("review");
		});
		test("'unable to review' is not a pass", async () => {
			const v = await review("I was unable to review this change.");
			expect(v.passed).toBe(false);
			expect(v.failedChecks).toContain("review");
		});
		test("## Verdict PASS passes", async () => {
			const v = await review("Looks fine.\n## Verdict\nPASS");
			expect(v.passed).toBe(true);
			expect(v.failedChecks).toEqual([]);
		});
		test("VERDICT: PASS line passes", async () => {
			expect((await review("VERDICT: PASS")).passed).toBe(true);
		});
		test("PASS with trailing qualifier text fails closed (strict verdict contract)", async () => {
			const v = await review("## Verdict\nPASS — ok");
			expect(v.passed).toBe(false);
			expect(v.failedChecks).toContain("review");
		});
		test("fenced example verdict does not satisfy the gate", async () => {
			const v = await review("```text\n## Verdict\nPASS\n```\nI cannot PASS this change.");
			expect(v.passed).toBe(false);
			expect(v.failedChecks).toContain("review");
		});
		test("tilde-fenced example verdict does not satisfy the gate", async () => {
			expect((await review("~~~\nVERDICT: PASS\n~~~\nno verdict")).passed).toBe(false);
		});
		test("conflicting VERDICT lines fail", async () => {
			const v = await review("VERDICT: PASS\nVERDICT: FAIL");
			expect(v.passed).toBe(false);
			expect(v.failedChecks).toContain("review");
		});
		test("conflicting ## Verdict headings fail", async () => {
			const v = await review("## Verdict\nPASS\n\n## Verdict\nFAIL");
			expect(v.passed).toBe(false);
			expect(v.failedChecks).toContain("review");
		});
		test("blockquoted-only verdict fails", async () => {
			const v = await review("> ## Verdict\n> PASS");
			expect(v.passed).toBe(false);
			expect(v.failedChecks).toContain("review");
		});
		test("ambiguous PASS? token fails", async () => {
			expect((await review("## Verdict\nPASS?")).passed).toBe(false);
		});
		describe("strict positional contract", () => {
			const bypasses: Record<string, string> = {
				"invalid closing fence line": "```text\n## Verdict\nPASS\n```not-a-closing-fence\n\nI cannot PASS this change.",
				"lazy blockquote continuation": "> Example only:\nVERDICT: PASS\n\nI cannot PASS this change.",
				"bold PASS?": "## Verdict\n**PASS**?",
				"PASS but blocking": "PASS but blocking: auth bypass remains.",
				"PASS-WITH-WARNINGS": "PASS-WITH-WARNINGS",
				"PASS?": "## Verdict\nPASS?",
				"PASS but after heading": "## Verdict\nPASS but blocking issue remains",
				"PASS-WITH-WARNINGS after heading": "## Verdict\nPASS-WITH-WARNINGS",
				"trailing text after verdict": "## Verdict\nPASS\n\nThanks!",
				"bare PASS without heading": "Looks fine.\nPASS",
				"unclosed fence at verdict": "```\n## Verdict\nPASS",
				"verdict inside quote after heading": "> ## Verdict\n> PASS",
				"blockquote line before heading": "> note\n## Verdict\nPASS",
			};
			for (const [name, out] of Object.entries(bypasses)) {
				test(`rejects ${name}`, async () => {
					const v = await review(out);
					expect(v.passed).toBe(false);
					expect(v.failedChecks).toContain("review");
				});
			}
			test("passes heading + PASS at end", async () => {
				expect((await review("Notes.\n## Verdict\nPASS")).passed).toBe(true);
			});
			test("passes CRLF emphasised PASS with trailing newline", async () => {
				expect((await review("## Verdict\r\n**PASS**\r\n")).passed).toBe(true);
			});
			test("passes VERDICT: PASS as last line", async () => {
				expect((await review("Fine.\nVERDICT: PASS")).passed).toBe(true);
			});
			test("passes after a properly closed fence", async () => {
				expect((await review("```\nx\n```\n## Verdict\nPASS")).passed).toBe(true);
			});
		});
	});
});

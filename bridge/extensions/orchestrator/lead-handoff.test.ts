import { describe, expect, test } from "bun:test";
import {
	boundHandoff,
	decideContinuation,
	extractHandoff,
	handoffStaleness,
	scopedPhasePrompt,
	validateHandoff,
	type LeadHandoff,
} from "./lead-handoff.ts";

function baseHandoff(overrides: Partial<LeadHandoff> = {}): LeadHandoff {
	return {
		schema_version: 1,
		phase: "plan",
		run_id: "run-1",
		lead_task_id: "lead-1",
		base_revision: "abc123",
		tested_revision: null,
		decisions: [{ decision: "use approach X", rationale: "smallest diff that satisfies the spec" }],
		constraints: ["do not touch index.ts"],
		file_ownership: { "src/a.ts": ["lead-1"] },
		work: [{ task_id: "t1", summary: "did the thing", result: "passed", files: ["src/a.ts"] }],
		unresolved_risks: ["glob overlap with lead-2 unresolved"],
		verification: [{ command: "bun test", outcome: "pass", revision: "abc123" }],
		artifacts: [{ ref: "run-1/lead-1/plan.md", description: "full plan notes" }],
		...overrides,
	};
}

function renderHandoffBlock(h: LeadHandoff): string {
	return `## Handoff\n\n\`\`\`json\n${JSON.stringify(h, null, 2)}\n\`\`\`\n`;
}

const expect1 = { phase: "plan" as const, runId: "run-1", leadTaskId: "lead-1" };

describe("extractHandoff", () => {
	test("round-trips decisions and unresolved risks from a well-formed block", () => {
		const h = baseHandoff();
		const { handoff, problems } = extractHandoff(renderHandoffBlock(h));
		expect(problems).toEqual([]);
		expect(handoff?.decisions).toEqual(h.decisions);
		expect(handoff?.unresolved_risks).toEqual(h.unresolved_risks);
	});
	test("missing '## Handoff' heading -> problem, no throw", () => {
		const { handoff, problems } = extractHandoff("no heading here at all");
		expect(handoff).toBeUndefined();
		expect(problems).toEqual(["missing_handoff_section"]);
	});
	test("missing json fence -> problem, no throw", () => {
		const { handoff, problems } = extractHandoff("## Handoff\n\nno fenced block here\n");
		expect(handoff).toBeUndefined();
		expect(problems).toEqual(["missing_json_fence"]);
	});
	test("malformed JSON -> fixed code, no throw, no raw parser error text", () => {
		const { handoff, problems } = extractHandoff("## Handoff\n\n```json\n{ not valid json\n```\n");
		expect(handoff).toBeUndefined();
		expect(problems).toEqual(["json_parse_error"]);
	});
	test("JSON array instead of object -> problem, no throw", () => {
		const { handoff, problems } = extractHandoff("## Handoff\n\n```json\n[1,2,3]\n```\n");
		expect(handoff).toBeUndefined();
		expect(problems).toEqual(["handoff_not_object"]);
	});
	test("fenced JSON larger than maxInputChars -> input_too_large, no parse attempted", () => {
		const huge = `## Handoff\n\n\`\`\`json\n{"x": "${"a".repeat(20_000)}"}\n\`\`\`\n`;
		const { handoff, problems } = extractHandoff(huge, { maxInputChars: 12_000 });
		expect(handoff).toBeUndefined();
		expect(problems).toEqual(["input_too_large"]);
	});
	test("default maxInputChars (64000) accepts a normal-sized handoff", () => {
		const h = baseHandoff();
		const { handoff, problems } = extractHandoff(renderHandoffBlock(h));
		expect(problems).toEqual([]);
		expect(handoff).toBeDefined();
	});
});

describe("validateHandoff", () => {
	test("complete, matching handoff -> no problems", () => {
		expect(validateHandoff(baseHandoff(), expect1)).toEqual([]);
	});
	test("incomplete handoff (missing keys) -> fixed missing_field codes", () => {
		const broken = { ...baseHandoff() } as any;
		delete broken.decisions;
		delete broken.verification;
		const problems = validateHandoff(broken, expect1);
		expect(problems).toContain("missing_field:decisions");
		expect(problems).toContain("missing_field:verification");
	});
	test("phase/run/lead mismatch -> fixed mismatch codes", () => {
		const h = baseHandoff({ phase: "integrate", run_id: "other-run", lead_task_id: "other-lead" });
		const problems = validateHandoff(h, expect1);
		expect(problems).toContain("phase_mismatch");
		expect(problems).toContain("run_id_mismatch");
		expect(problems).toContain("lead_task_id_mismatch");
	});
	test("wrong-typed field -> invalid_field code", () => {
		const h = { ...baseHandoff(), constraints: "not-an-array" } as unknown as LeadHandoff;
		expect(validateHandoff(h, expect1)).toContain("invalid_field:constraints");
	});
	test("problems never echo the model-supplied run_id value", () => {
		const secretExpect = { phase: "plan" as const, runId: "expected-run", leadTaskId: "lead-1" };
		const h = baseHandoff({ run_id: "SECRET_TOKEN_123" });
		const problems = validateHandoff(h, secretExpect);
		expect(problems).toContain("run_id_mismatch");
		expect(problems.some((p) => p.includes("SECRET_TOKEN_123"))).toBe(false);
	});
	test("per-field caps: oversized arrays/strings -> field_too_large codes", () => {
		const h = baseHandoff({
			constraints: Array.from({ length: 201 }, (_, i) => `c${i}`),
			unresolved_risks: ["x".repeat(4001)],
		});
		const problems = validateHandoff(h, expect1);
		expect(problems).toContain("field_too_large:constraints");
		expect(problems).toContain("field_too_large:unresolved_risks");
	});
});

describe("handoffStaleness", () => {
	test("unknown current head is always unsafe", () => {
		expect(handoffStaleness(baseHandoff(), null)).toEqual({
			stale: true,
			reason: "stale:unknown_head",
		});
	});
	test("tested_revision must equal current head when present", () => {
		const h = baseHandoff({ tested_revision: "abc123" });
		expect(handoffStaleness(h, "abc123").stale).toBe(false);
		const result = handoffStaleness(h, "def456");
		expect(result.stale).toBe(true);
		expect(result.reason).toBe("stale:tested_revision_mismatch");
	});
	test("falls back to base_revision when tested_revision is absent/null", () => {
		const h = baseHandoff({ tested_revision: null });
		expect(handoffStaleness(h, "abc123").stale).toBe(false);
		const result = handoffStaleness(h, "def456");
		expect(result.stale).toBe(true);
		expect(result.reason).toBe("stale:base_revision_mismatch");
	});
	test("reasons never echo the actual revision values", () => {
		const h = baseHandoff({ tested_revision: "SECRET_TOKEN_123" });
		const result = handoffStaleness(h, "def456");
		expect(result.reason?.includes("SECRET_TOKEN_123")).toBe(false);
		expect(result.reason?.includes("def456")).toBe(false);
	});
});

describe("decideContinuation", () => {
	test("continues on a fresh, valid, matching handoff with an unchanged tree", () => {
		const h = baseHandoff({ tested_revision: "abc123" });
		expect(
			decideContinuation({ handoff: h, problems: [], currentHead: "abc123", expect: expect1, treeUnchanged: true }),
		).toEqual({ action: "continue" });
	});
	test("extraction problems -> fallback with a reason built from fixed codes", () => {
		const result = decideContinuation({ problems: ["missing_handoff_section"], currentHead: "abc123", expect: expect1, treeUnchanged: true });
		expect(result.action).toBe("fallback_long_lived_lead");
		expect((result as any).reason).toContain("missing_handoff_section");
	});
	test("incomplete handoff -> fallback", () => {
		const broken = { ...baseHandoff() } as any;
		delete broken.decisions;
		const result = decideContinuation({ handoff: broken, problems: [], currentHead: "abc123", expect: expect1, treeUnchanged: true });
		expect(result.action).toBe("fallback_long_lived_lead");
	});
	test("stale revision -> fallback with fixed code reason", () => {
		const h = baseHandoff({ tested_revision: "abc123" });
		const result = decideContinuation({ handoff: h, problems: [], currentHead: "def456", expect: expect1, treeUnchanged: true });
		expect(result.action).toBe("fallback_long_lived_lead");
		expect((result as any).reason).toBe("stale:tested_revision_mismatch");
	});
	test("unknown current head -> fallback with fixed code reason", () => {
		const h = baseHandoff({ tested_revision: "abc123" });
		const result = decideContinuation({ handoff: h, problems: [], currentHead: null, expect: expect1, treeUnchanged: true });
		expect(result.action).toBe("fallback_long_lived_lead");
		expect((result as any).reason).toBe("stale:unknown_head");
	});
	test("treeUnchanged: false -> fallback with stale:tree_changed", () => {
		const h = baseHandoff({ tested_revision: "abc123" });
		const result = decideContinuation({ handoff: h, problems: [], currentHead: "abc123", expect: expect1, treeUnchanged: false });
		expect(result.action).toBe("fallback_long_lived_lead");
		expect((result as any).reason).toBe("stale:tree_changed");
	});
	test("treeUnchanged: null/undefined -> fallback with stale:tree_unknown", () => {
		const h = baseHandoff({ tested_revision: "abc123" });
		const withNull = decideContinuation({ handoff: h, problems: [], currentHead: "abc123", expect: expect1, treeUnchanged: null });
		expect((withNull as any).reason).toBe("stale:tree_unknown");
		const withUndefined = decideContinuation({ handoff: h, problems: [], currentHead: "abc123", expect: expect1 });
		expect((withUndefined as any).reason).toBe("stale:tree_unknown");
	});
	test("no problem or reason ever contains a model-supplied run_id value", () => {
		const h = baseHandoff({ run_id: "SECRET_TOKEN_123", tested_revision: "abc123" });
		const mismatchedExpect = { phase: "plan" as const, runId: "expected-run", leadTaskId: "lead-1" };
		const result = decideContinuation({ handoff: h, problems: [], currentHead: "abc123", expect: mismatchedExpect, treeUnchanged: true });
		expect(result.action).toBe("fallback_long_lived_lead");
		expect((result as any).reason.includes("SECRET_TOKEN_123")).toBe(false);
	});
});

describe("boundHandoff", () => {
	test("under budget: returned verbatim, not truncated, within budget", () => {
		const h = baseHandoff();
		const { text, truncated, withinBudget } = boundHandoff(h, 100_000);
		expect(truncated).toBe(false);
		expect(withinBudget).toBe(true);
		expect(JSON.parse(text).decisions).toEqual(h.decisions);
	});
	test("over budget: shrinks long work text but keeps every required field intact", () => {
		const h = baseHandoff({
			work: [
				{ task_id: "t1", summary: "x".repeat(5000), result: "y".repeat(5000), files: ["src/a.ts"] },
				{ task_id: "t2", summary: "short", result: "short", files: [] },
			],
			decisions: [{ decision: "keep this decision intact", rationale: "must never be dropped by bounding" }],
			unresolved_risks: ["must never be dropped by bounding"],
		});
		const { text, truncated, withinBudget } = boundHandoff(h, 2000);
		expect(truncated).toBe(true);
		expect(withinBudget).toBe(true);
		const parsed = JSON.parse(text);
		expect(parsed.decisions).toEqual(h.decisions);
		expect(parsed.unresolved_risks).toEqual(h.unresolved_risks);
		expect(parsed.file_ownership).toEqual(h.file_ownership);
		expect(parsed.base_revision).toBe(h.base_revision);
		expect(parsed.verification).toEqual(h.verification);
		expect(parsed.artifacts).toEqual(h.artifacts);
		expect(parsed.work[0].summary.length).toBeLessThan(5000);
		expect(parsed.work[0].summary).toContain("truncated; full evidence:");
		expect(text.length).toBeLessThanOrEqual(2000);
	});
	test("truncation marker points at an artifact ref when one exists", () => {
		const h = baseHandoff({ work: [{ task_id: "t1", summary: "z".repeat(3000), result: "short", files: [] }] });
		const { text } = boundHandoff(h, 500);
		expect(text).toContain(h.artifacts[0].ref);
	});
	test("when required fields alone cannot fit the budget, withinBudget is false", () => {
		// 100 decisions with long rationale text (not shrinkable by boundHandoff)
		// plus a single tiny work item — the required fields alone exceed 12,000
		// chars, so even shrinking the (already-small) work text cannot help.
		const h = baseHandoff({
			decisions: Array.from({ length: 100 }, (_, i) => ({
				decision: `decision-${i}-${"d".repeat(150)}`,
				rationale: `rationale-${i}-${"r".repeat(150)}`,
			})),
			work: [{ task_id: "t1", summary: "short", result: "short", files: [] }],
		});
		expect(JSON.stringify(h).length).toBeGreaterThan(20_000 - 5000); // sanity: input is large
		const { truncated, withinBudget, text } = boundHandoff(h, 12_000);
		expect(truncated).toBe(true);
		expect(withinBudget).toBe(false);
		expect(text.length).toBeGreaterThan(12_000);
	});
});

describe("scopedPhasePrompt", () => {
	test("plan phase requires an ending '## Handoff' json block", () => {
		const prompt = scopedPhasePrompt("plan", "Do the thing.");
		expect(prompt).toContain("## Phase: plan");
		expect(prompt).toContain("## Handoff");
		expect(prompt).toContain('"phase": "plan"');
	});
	test("integrate phase carries the prior handoff and forbids restart-on-phase-change", () => {
		const prompt = scopedPhasePrompt("integrate", "Continue.", { text: '{"phase":"plan"}' });
		expect(prompt).toMatch(/do not restart/i);
		expect(prompt).toContain('{"phase":"plan"}');
	});
	test("integrate phase without a prior handoff still says to proceed conservatively", () => {
		const prompt = scopedPhasePrompt("integrate", "Continue.");
		expect(prompt).toContain("No prior handoff was available");
	});
	test("report phase preserves review/QA gates", () => {
		const prompt = scopedPhasePrompt("report", "Report on it.");
		expect(prompt).toContain("Do not weaken, skip, or reinterpret");
	});
	test("report phase carries the prior (integrate) handoff and forbids restart/re-running passing checks", () => {
		const prompt = scopedPhasePrompt("report", "Report on it.", { text: '{"phase":"integrate"}' });
		expect(prompt).toContain('{"phase":"integrate"}');
		expect(prompt).toMatch(/without re-running|do not re-run/i);
		expect(prompt).toMatch(/restart/i);
		expect(prompt).toContain("Do not weaken, skip, or reinterpret");
	});
	test("report phase without a prior handoff still proceeds conservatively", () => {
		const prompt = scopedPhasePrompt("report", "Report on it.");
		expect(prompt).toContain("No prior handoff was available");
	});
});

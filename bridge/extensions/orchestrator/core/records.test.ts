import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { dispatchRecordsFor, leadSelfImplemented, methodEffortFor, runCompletionOutcomeFor, runTagFields, type DispatchResult } from "./records.ts";

function result(overrides: Partial<DispatchResult> = {}): DispatchResult {
	return {
		taskId: "run-1-lead-0",
		capability: "lead",
		model: "amazon-bedrock/global.anthropic.claude-opus-5-5",
		exitCode: 0,
		stdout: "",
		stderr: "",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		durationMs: 1000,
		costUsd: 0.5,
		costReported: true,
		filesChanged: [],
		...overrides,
	};
}

const opts = {
	runId: "run-1",
	planId: "plan-1",
	taskClass: "implementation",
	complexity: 5,
	risk: "medium",
	recommended: { capability: "lead", effort: "standard", verification_depth: "targeted" },
	mode: "adaptive",
};

describe("core/records.ts dispatchRecordsFor", () => {
	test("emits exactly a model_call and a route_executed row", () => {
		const records = dispatchRecordsFor(opts, result());
		expect(records).toHaveLength(2);
		expect(records[0].event).toBe("model_call");
		expect(records[1].event).toBe("route_executed");
	});

	test("stamps the run tags passed in explicitly, not any ambient global", () => {
		const records = dispatchRecordsFor(opts, result(), { profile: "default", policy_id: "default-abc123" });
		expect(records[0].profile).toBe("default");
		expect(records[0].policy_id).toBe("default-abc123");
	});

	test("omitting run tags stamps none — no implicit global read", () => {
		const records = dispatchRecordsFor(opts, result());
		expect(records[0].profile).toBeUndefined();
		expect(records[0].policy_id).toBeUndefined();
	});

	test("flags lead_self_implemented only for a lead capability that changed files itself", () => {
		const records = dispatchRecordsFor(opts, result({ filesChanged: ["a.ts"], stdout: "edited a.ts myself" }));
		expect(records[0].lead_self_implemented).toBe(true);
	});
});

describe("core/records.ts runTagFields", () => {
	test("only includes tags that are set", () => {
		expect(runTagFields({})).toEqual({});
		expect(runTagFields({ profile: "p" })).toEqual({ profile: "p" });
	});
});

describe("core/records.ts methodEffortFor", () => {
	test("defaults unset thinking level to standard", () => {
		expect(methodEffortFor(undefined)).toBe("standard");
	});
});

describe("core/records.ts leadSelfImplemented", () => {
	test("true only when files changed and no implementer dispatch is mentioned", () => {
		expect(leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "I edited a.ts" })).toBe(true);
		expect(leadSelfImplemented({ filesChanged: ["a.ts"], stdout: "dispatched orch-implementation-strong" })).toBe(false);
		expect(leadSelfImplemented({ filesChanged: [], stdout: "" })).toBe(false);
	});
});

describe("dispatch/verification records", () => {
	test("passed verification writes a run-complete verified outcome", () => {
		expect(runCompletionOutcomeFor("run-2", {
			success_rate: 1,
			verification_passed: true,
		})).toMatchObject({
			run_id: "run-2",
			task_id: "run-complete",
			outcome: "verified",
			verification_scope: "run",
		});
	});

	test("failed verification does not write a run-complete verified outcome", () => {
		expect(runCompletionOutcomeFor("run-1", {
			success_rate: 0,
			verification_passed: false,
		})).toMatchObject({
			run_id: "run-1",
			task_id: "run-complete",
			outcome: "fail",
			verification_scope: "run",
		});
	});
});

describe("dispatch records (T6)", () => {
	/**
	 * These replace six tests that asserted only the exit-code-to-event mapping of the
	 * deleted `verificationRecordFor` (`exitCode 0` -> `task_verified`). That mapping was
	 * itself the defect, so tests pinning it could only ever pass: they asserted the
	 * conflation instead of the property that matters, which is WHICH RECORDS a dispatch is
	 * allowed to write. Every assertion below is over the full record set from
	 * `dispatchRecordsFor`, so a future re-introduction of an attested verdict fails here no
	 * matter what it is named.
	 */
	const ATTESTED_EVENTS = ["task_verified", "task_failed", "verification_result"];

	function captureOpts(overrides: Record<string, unknown> = {}) {
		return {
			runId: "run-1",
			planId: "plan-1",
			taskClass: "crud",
			complexity: 4,
			risk: "low",
			recommended: { capability: "implementation_fast", effort: "low", verification_depth: "targeted" },
			mode: "adaptive",
			...overrides,
		} as Parameters<typeof dispatchRecordsFor>[0];
	}

	function dispatchTestResult(overrides: Record<string, unknown> = {}) {
		return {
			taskId: "run-1-worker-a",
			capability: "implementation_fast",
			model: "provider/model",
			exitCode: 0,
			stdout: "",
			stderr: "",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			durationMs: 10,
			costUsd: 0.01,
			costReported: true,
			filesChanged: [],
			...overrides,
		} as Parameters<typeof dispatchRecordsFor>[1];
	}

	const recordsFor = (result: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
		dispatchRecordsFor(captureOpts(opts), dispatchTestResult(result));

	test("a QA dispatch that exits 0 while reporting failed checks attests nothing", () => {
		// The reproducer: `runVerification` bills the QA dispatch BEFORE computing
		// `exitCode === 0 && failedChecks.length === 0`, then writes `outcome: 'fail'` for the
		// same task_id. An attested `task_verified` here made the contradictory pair resolve to
		// verified — the one number this branch exists to stop overstating.
		const records = recordsFor({
			taskId: "run-1-qa",
			capability: "qa_agent",
			exitCode: 0,
			stdout: "| typecheck | FAIL |\n| tests | FAIL |",
		});

		expect(records.map((r) => r.event)).toEqual(["model_call", "route_executed"]);
		for (const record of records) {
			expect(ATTESTED_EVENTS).not.toContain(record.event as string);
			expect(record.result).not.toBe("verified");
		}
	});

	test.each([
		["architect", "run-1-architect", "architect"],
		["lead", "run-1-lead-0", "lead"],
		["triage", "triage-repair-the-login-race", "implementation_fast"],
		["escalation retry", "run-1-lead-0-retry-1", "lead"],
	])("a %s dispatch never attests a task verdict", (_label, taskId, capability) => {
		// These task ids are coordination bookkeeping, not deliverable tasks, so an attested
		// verdict about them is meaningless regardless of how the subprocess exited.
		for (const exitCode of [0, 1]) {
			const records = recordsFor({ taskId, capability, exitCode });
			expect(records.map((r) => r.event)).toEqual(["model_call", "route_executed"]);
			expect(records.some((r) => ATTESTED_EVENTS.includes(r.event as string))).toBe(false);
		}
	});

	test("no dispatch outcome, at any exit code, produces an attested record", () => {
		for (const exitCode of [0, 1, 137, -1]) {
			const events = recordsFor({ exitCode }).map((r) => r.event);
			expect(events).toEqual(["model_call", "route_executed"]);
		}
	});

	test("the dispatch-level verdict is still reported, as dispatch-strength evidence", () => {
		// records.py reads `result` as DISPATCH strength and `executed_passes` as the executed
		// route's outcome. Dropping the attested row must not drop the honest signal.
		const [call, route] = recordsFor({ exitCode: 0 });
		expect(call.result).toBe("pass");
		expect(route.executed_passes).toBe(true);

		const [failedCall, failedRoute] = recordsFor({ exitCode: 1 });
		expect(failedCall.result).toBe("fail");
		expect(failedRoute.executed_passes).toBe(false);
	});

	test("both records carry the routing context, so neither is orphaned from its route group", () => {
		for (const record of recordsFor({}, { taskClass: "refactor", complexity: 7, risk: "high" })) {
			expect(record.run_id).toBe("run-1");
			expect(record.task_id).toBe("run-1-worker-a");
			expect(record.plan_id).toBe("plan-1");
			expect(record.task_class).toBe("refactor");
			expect(record.complexity).toBe(7);
			expect(record.risk).toBe("high");
			expect(record.capability_class).toBe("implementation_fast");
		}
	});

	test("the two records agree on task_id, including the unknown-run fallback", () => {
		// One dispatch must not be able to write two rows under different ids, or a task-level
		// join sees two half-instrumented tasks.
		const records = recordsFor({ taskId: undefined });
		expect(new Set(records.map((r) => r.task_id))).toEqual(new Set(["unknown-run-1"]));
	});

	test("cost is reported exactly once, on the model_call row", () => {
		const [call, route] = recordsFor({ costUsd: 5.5 });
		expect(call.cost_usd).toBe(5.5);
		expect(route).not.toHaveProperty("cost_usd");
		expect(route.executed_cost_usd).toBe(5.5);
	});

	test("never fabricates quality_evidence_score or review_wait_ms", () => {
		// records.py registers the first as emitted only by Engine.verify_task and the second as
		// having no producer at all; a zero here would invent a measurement.
		for (const record of recordsFor({})) {
			expect(record).not.toHaveProperty("quality_evidence_score");
			expect(record).not.toHaveProperty("review_wait_ms");
		}
	});

	test("the attested-verdict emission is gone from the module, not merely unused", () => {
		// Guards the deletion itself: a re-added builder would otherwise be reachable from
		// dispatchRecordsFor without any test noticing.
		const module = require("./records.ts") as Record<string, unknown>;
		expect(module).not.toHaveProperty("verificationRecordFor");
		const source = readFileSync(new URL("./records.ts", import.meta.url), "utf8");
		for (const event of ["task_verified", "task_failed"]) {
			expect(source).not.toContain(`event: passed ? "${event}"`);
			expect(source).not.toContain(`event: "${event}"`);
		}
	});
});

import { describe, expect, test } from "bun:test";
import { failoverConfig } from "./failover-policy.ts";
import { ModelHealth } from "../run/model-health.ts";
import { dispatchWithFailover, formatFailoverLine, type AttemptLike, type FailoverDeps } from "./failover.ts";

interface Fake extends AttemptLike { model: string; events: string[]; files: string[] }
const A = "amazon-bedrock/global.anthropic.claude-fable-5-1";
const B = "openai-codex/gpt-6-astra";
const E503 = "[provider error] Service unavailable: Bedrock is unable to process your request.";
const toolEnd = (id: string) => JSON.stringify({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: {}, isError: false });
const fail = (model: string, o: Partial<Fake> = {}): Fake => ({ exitCode: 1, outcome: "failed", stderr: E503, costUsd: 0.5, model, events: [], files: [], ...o });
const ok = (model: string): Fake => ({ exitCode: 0, outcome: "completed", stderr: "", costUsd: 1, model, events: [], files: [] });

function harness(script: (model: string, n: number) => Fake, o: { health?: ModelHealth; cancelAfterSleeps?: number } = {}) {
	let clock = 0;
	const calls: Array<{ model: string; prompt: string; n: number; spent: number }> = [];
	const sleeps: number[] = [];
	const events: Array<[string, Record<string, unknown>]> = [];
	let lastFiles: string[] = [];
	const health = o.health ?? new ModelHealth(() => clock);
	const deps: FailoverDeps<Fake> = {
		runAttempt: async (model, prompt, n, spent) => {
			calls.push({ model, prompt, n, spent });
			const r = script(model, n);
			lastFiles = r.files;
			return r;
		},
		readEvents: (r) => r.events,
		snapshot: () => null,
		changedSince: () => lastFiles,
		sleep: async (ms) => { sleeps.push(ms); clock += ms; },
		health,
		isCancelled: () => o.cancelAfterSleeps !== undefined && sleeps.length >= o.cancelAfterSleeps,
		recordEvent: (e, p) => events.push([e, p]),
		log: () => {},
		config: failoverConfig(),
	};
	return { deps, calls, sleeps, events, health };
}
const task = { taskId: "run-lead-0", capability: "lead_large", prompt: "ORIGINAL" };

describe("dispatchWithFailover", () => {
	test("503 with no work: switch straight to the backup", async () => {
		const h = harness((m) => (m === A ? fail(A) : ok(B)));
		const r = await dispatchWithFailover(task, [A, B], h.deps);
		expect(r.finalModel).toBe(B);
		expect(r.exhausted).toBe(false);
		expect(r.switches).toEqual([{ from: A, to: B, cls: "transient", reason: E503 }]);
		expect(h.sleeps).toEqual([]);
		expect(h.calls.map((c) => [c.model, c.prompt])).toEqual([[A, "ORIGINAL"], [B, "ORIGINAL"]]);
		expect(h.events.map(([e]) => e)).toEqual(["model_unhealthy", "route_degraded"]);
	});
	test("503 with nested cost: spend offset carries nested worker cost forward", async () => {
		const h = harness((m) => (m === A ? fail(A, { costUsd: 0.5, nestedCostUsd: 2 }) : ok(B)));
		await dispatchWithFailover(task, [A, B], h.deps);
		expect(h.calls.map((c) => c.spent)).toEqual([0, 2.5]);
	});
	test("real work: one delayed same-model retry with a handoff, then switch; spend is cumulative", async () => {
		const worked = { events: [toolEnd("1"), toolEnd("2"), toolEnd("3")], files: ["a.ts"] };
		const h = harness((m, n) => (n <= 2 ? fail(A, worked) : ok(B)));
		const r = await dispatchWithFailover(task, [A, B], h.deps);
		expect(h.calls.map((c) => c.model)).toEqual([A, A, B]);
		expect(h.sleeps).toEqual([60000]);
		expect(h.calls[1].prompt.startsWith("ORIGINAL\n\n## Resume from a failed attempt (attempt 2 of run-lead-0")).toBe(true);
		expect(h.calls[2].prompt).toContain("attempt 3 of run-lead-0");
		expect(h.calls[2].prompt.split("## Resume").length).toBe(2);
		expect(h.calls.map((c) => c.spent)).toEqual([0, 0.5, 1]);
		expect(r.attempts.map((a) => a.record.realWork)).toEqual([true, true, false]);
	});
	test("quota switches immediately even after real work", async () => {
		const h = harness((m) => (m === A ? fail(A, { stderr: "429 rate limit", events: [toolEnd("1"), toolEnd("2"), toolEnd("3")] }) : ok(B)));
		await dispatchWithFailover(task, [A, B], h.deps);
		expect(h.sleeps).toEqual([]);
		expect(h.calls.map((c) => c.model)).toEqual([A, B]);
	});
	test("a task failure passes through untouched", async () => {
		const h = harness(() => fail(A, { stderr: "TypeError: boom" }));
		const r = await dispatchWithFailover(task, [A, B], h.deps);
		expect(h.calls.length).toBe(1);
		expect(r.attempts[0].record.cls).toBe("task");
		expect(r.result.stderr).toBe("TypeError: boom");
	});
	test("a single candidate waits by schedule, retries after the unhealthy window, then gives up at max_wait", async () => {
		const h = harness(() => fail(A));
		const r = await dispatchWithFailover(task, [A], h.deps);
		expect(h.calls.length).toBe(2);
		expect(h.sleeps).toEqual([60000, 120000, 240000, 240000, 240000]);
		expect(r.exhausted).toBe(true);
		expect(r.result.stderr.startsWith("[orchestrator] all candidates unavailable (max-wait):")).toBe(true);
		expect(h.events.map(([e]) => e).at(-1)).toBe("failover_exhausted");
	});
	test("dispatches share health: a later dispatch starts on the healthy backup", async () => {
		let clock = 0;
		const health = new ModelHealth(() => clock);
		const first = harness((m) => (m === A ? fail(A) : ok(B)), { health });
		await dispatchWithFailover(task, [A, B], first.deps);
		const second = harness(() => ok(B), { health });
		const r = await dispatchWithFailover({ ...task, taskId: "run-lead-1" }, [A, B], second.deps);
		expect(second.calls.map((c) => c.model)).toEqual([B]);
		expect(r.switches).toEqual([]);
	});
	test("cancel during a wait returns at once", async () => {
		const h = harness(() => fail(A), { cancelAfterSleeps: 1 });
		const r = await dispatchWithFailover(task, [A], h.deps);
		expect(h.calls.length).toBe(1);
		expect(h.sleeps).toEqual([60000]);
		expect(r.exhausted).toBe(false);
	});
});

describe("formatFailoverLine", () => {
	test("null without failovers; otherwise one compact line", () => {
		expect(formatFailoverLine([{}, { failovers: [] }])).toBeNull();
		expect(formatFailoverLine([{ failovers: [{ from: A, to: B, cls: "transient", reason: "503" }] }])).toBe("failovers: 1 — fable-5-1→gpt-6-astra (transient 503)");
	});
});

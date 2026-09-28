import { describe, expect, test } from "bun:test";
import { applyStep, failoverConfig, initialState, nextStep, pickCandidate, resumeAfterWait, waitOrGiveUp } from "./failover-policy.ts";

const cfg = failoverConfig();
const C = [
	"amazon-bedrock/global.anthropic.claude-opus-5-5",
	"amazon-bedrock/global.anthropic.claude-fable-5-1",
	"amazon-bedrock/eu.anthropic.claude-opus-5-5",
	"openai-codex/gpt-6-astra",
];
const all = () => true;

describe("failoverConfig", () => {
	test("reads method.json defaults", () => {
		expect(cfg).toEqual({ unhealthyMs: 600000, sameModelRetryDelayMs: 60000, waitScheduleMs: [60000, 120000, 240000], maxWaitMs: 900000, maxSwitches: 4, realWorkMinToolCalls: 3 });
	});
});

describe("nextStep", () => {
	const failedGlobal = { ...initialState(C), failedRegions: ["amazon-bedrock/global"] };
	test("real work gets one same-model retry, but never for quota", () => {
		expect(nextStep(failedGlobal, "transient", true, all, cfg)).toEqual({ kind: "retry-same", delayMs: 60000 });
		expect(nextStep(failedGlobal, "stall", true, all, cfg)).toEqual({ kind: "retry-same", delayMs: 60000 });
		expect(nextStep(failedGlobal, "quota", true, all, cfg)).toEqual({ kind: "switch", index: 2 });
		expect(nextStep({ ...failedGlobal, sameModelRetried: true }, "transient", true, all, cfg)).toEqual({ kind: "switch", index: 2 });
	});
	test("no real work switches, preferring another provider/region", () => {
		expect(nextStep(failedGlobal, "transient", false, all, cfg)).toEqual({ kind: "switch", index: 2 });
	});
	test("skips unhealthy; falls back to the same region last", () => {
		expect(pickCandidate(failedGlobal, (m) => !m.includes("eu."))).toBe(3);
		expect(pickCandidate({ ...failedGlobal, attempted: [0, 2, 3] }, all)).toBe(1);
	});
	test("max switches gives up", () => {
		expect(nextStep({ ...failedGlobal, switches: 4 }, "transient", false, all, cfg)).toEqual({ kind: "give-up", reason: "max-switches" });
	});
	test("nothing left: wait by schedule, capped at max_wait, then give up", () => {
		const s = { ...failedGlobal, attempted: [0, 1, 2, 3] };
		expect(nextStep(s, "transient", false, all, cfg)).toEqual({ kind: "wait", delayMs: 60000 });
		expect(waitOrGiveUp({ ...s, waitIndex: 5 }, cfg)).toEqual({ kind: "wait", delayMs: 240000 });
		expect(waitOrGiveUp({ ...s, waitIndex: 2, waitedMs: 800000 }, cfg)).toEqual({ kind: "wait", delayMs: 100000 });
		expect(waitOrGiveUp({ ...s, waitedMs: 900000 }, cfg)).toEqual({ kind: "give-up", reason: "max-wait" });
	});
});

describe("state transitions", () => {
	test("applyStep and resumeAfterWait", () => {
		const s0 = initialState(C, 1);
		expect(s0).toEqual({ candidates: C, current: 1, attempted: [1], failedRegions: [], sameModelRetried: false, switches: 0, waitIndex: 0, waitedMs: 0 });
		const s1 = applyStep(s0, { kind: "retry-same", delayMs: 1 });
		expect(s1.sameModelRetried).toBe(true);
		const s2 = applyStep(s1, { kind: "switch", index: 3 });
		expect([s2.current, s2.attempted, s2.switches, s2.sameModelRetried]).toEqual([3, [1, 3], 1, false]);
		const s3 = applyStep(s2, { kind: "wait", delayMs: 60000 });
		expect([s3.attempted, s3.waitIndex, s3.waitedMs]).toEqual([[], 1, 60000]);
		const s4 = resumeAfterWait(s3, 0);
		expect([s4.current, s4.attempted, s4.switches]).toEqual([0, [0], 1]);
	});
});

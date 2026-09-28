/**
 * Pure failover decisions (spec §5.3): retry the same model once after real work,
 * switch to the next healthy candidate (moving candidates on the failed
 * provider/region to the end), wait by schedule when none are left, and give up
 * after max_switches or max_wait_ms.
 */
import { METHOD, type ModelFailoverRule } from "../models.ts";
import { providerRegion } from "../run/model-health.ts";

export interface FailoverConfig {
	unhealthyMs: number;
	sameModelRetryDelayMs: number;
	waitScheduleMs: number[];
	maxWaitMs: number;
	maxSwitches: number;
	realWorkMinToolCalls: number;
}

export function failoverConfig(rule: ModelFailoverRule = METHOD.rules.model_failover): FailoverConfig {
	return {
		unhealthyMs: rule.unhealthy_ms,
		sameModelRetryDelayMs: rule.same_model_retry_delay_ms,
		waitScheduleMs: [...rule.wait_schedule_ms],
		maxWaitMs: rule.max_wait_ms,
		maxSwitches: rule.max_switches,
		realWorkMinToolCalls: rule.real_work_min_tool_calls,
	};
}

export interface PolicyState {
	candidates: string[];
	current: number;
	/** Candidate indexes tried since the last wait. */
	attempted: number[];
	failedRegions: string[];
	sameModelRetried: boolean;
	switches: number;
	waitIndex: number;
	waitedMs: number;
}

export type Step =
	| { kind: "retry-same"; delayMs: number }
	| { kind: "switch"; index: number }
	| { kind: "wait"; delayMs: number }
	| { kind: "give-up"; reason: "max-switches" | "max-wait" };

export function initialState(candidates: string[], start = 0): PolicyState {
	return { candidates, current: start, attempted: [start], failedRegions: [], sameModelRetried: false, switches: 0, waitIndex: 0, waitedMs: 0 };
}

export function pickCandidate(state: PolicyState, isHealthy: (m: string) => boolean): number | null {
	const open = state.candidates.map((_, i) => i).filter((i) => !state.attempted.includes(i) && isHealthy(state.candidates[i]));
	const fresh = open.filter((i) => !state.failedRegions.includes(providerRegion(state.candidates[i])));
	const stale = open.filter((i) => !fresh.includes(i));
	return [...fresh, ...stale][0] ?? null;
}

export function waitOrGiveUp(state: PolicyState, cfg: FailoverConfig): Step {
	const remaining = cfg.maxWaitMs - state.waitedMs;
	if (remaining <= 0) return { kind: "give-up", reason: "max-wait" };
	const planned = cfg.waitScheduleMs[Math.min(state.waitIndex, cfg.waitScheduleMs.length - 1)];
	return { kind: "wait", delayMs: Math.min(planned, remaining) };
}

export function nextStep(
	state: PolicyState,
	failure: "quota" | "transient" | "stall",
	realWork: boolean,
	isHealthy: (m: string) => boolean,
	cfg: FailoverConfig,
): Step {
	if (failure !== "quota" && realWork && !state.sameModelRetried) return { kind: "retry-same", delayMs: cfg.sameModelRetryDelayMs };
	if (state.switches >= cfg.maxSwitches) return { kind: "give-up", reason: "max-switches" };
	const index = pickCandidate(state, isHealthy);
	return index === null ? waitOrGiveUp(state, cfg) : { kind: "switch", index };
}

export function applyStep(state: PolicyState, step: Step): PolicyState {
	switch (step.kind) {
		case "retry-same":
			return { ...state, sameModelRetried: true };
		case "switch":
			return { ...state, current: step.index, attempted: [...state.attempted, step.index], switches: state.switches + 1, sameModelRetried: false };
		case "wait":
			return { ...state, attempted: [], waitIndex: state.waitIndex + 1, waitedMs: state.waitedMs + step.delayMs };
		case "give-up":
			return state;
	}
}

/** After a wait, start again on `index` without counting it as a switch. */
export function resumeAfterWait(state: PolicyState, index: number): PolicyState {
	return { ...state, current: index, attempted: [index], sameModelRetried: false };
}

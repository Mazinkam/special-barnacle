/**
 * Pure per-dispatch spend cap (method.json `rules.dispatch_spend_cap`).
 * The bridge feeds each dispatch's running reported cost into `observe`;
 * `warn` notifies once, `enforce` additionally asks the caller to stop that
 * dispatch, `off` disables. No I/O here.
 */
import { METHOD, type SpendCapMode } from "./models.ts";

export interface SpendCapPolicy {
	mode: SpendCapMode;
	usd_by_capability: Record<string, number>;
	default_usd: number;
}

export type SpendCapVerdict = "ok" | "warn" | "stop";

export function capFor(capability: string, policy: SpendCapPolicy = METHOD.rules.dispatch_spend_cap): number {
	return policy.usd_by_capability[capability] ?? policy.default_usd;
}

export class SpendCapTracker {
	private readonly fired = new Set<string>();
	constructor(private readonly policy: SpendCapPolicy = METHOD.rules.dispatch_spend_cap) {}

	get mode(): SpendCapMode {
		return this.policy.mode;
	}

	/** Non-"ok" at most once per taskId: the first time costUsd exceeds the cap. */
	observe(taskId: string, capability: string, costUsd: number): SpendCapVerdict {
		if (this.policy.mode === "off" || this.fired.has(taskId)) return "ok";
		if (!(costUsd > capFor(capability, this.policy))) return "ok";
		this.fired.add(taskId);
		return this.policy.mode === "enforce" ? "stop" : "warn";
	}
}

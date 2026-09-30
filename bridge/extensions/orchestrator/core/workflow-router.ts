import type { WorkflowLevel, WorkflowPolicy } from "../models.ts";
import type { WorkflowSignals } from "./workflow-signals.ts";

export interface WorkflowDecision {
	level: WorkflowLevel; floor: WorkflowLevel; reasons: string[]; uncertainty: string[];
	override?: { requested: WorkflowLevel; accepted: boolean; reason: string };
}

export const LEVEL_ORDER: readonly WorkflowLevel[] = ["direct", "checked", "led", "full"];
const rank = (l: WorkflowLevel) => LEVEL_ORDER.indexOf(l);
export const atLeast = (a: WorkflowLevel, b: WorkflowLevel): WorkflowLevel => (rank(a) >= rank(b) ? a : b);

export function routeWorkflow(s: WorkflowSignals, policy: WorkflowPolicy): WorkflowDecision {
	const uncertainty = [
		...(s.ambiguous ? ["no candidate files resolved from the goal"] : []),
		...(s.checks.length === 0 ? ["no deterministic checks discovered"] : []),
	];
	const baseFloor: WorkflowLevel = s.checks.length === 0 ? "checked" : "direct";
	const highRisk = s.triageRisk === "high" || s.triageRisk === "critical";
	if (highRisk || s.riskPathHits.length > 0) {
		return { level: "full", floor: "full", uncertainty, reasons: [highRisk ? `explicit risk ${s.triageRisk}` : `protected path: ${s.riskPathHits[0]}`] };
	}
	if (s.interfaceHits.length > 0 && s.packages.length > 1) {
		// A cross-package contract change needs coordinated design: nothing may lower it.
		return { level: "full", floor: "full", uncertainty, reasons: [`interface change across ${s.packages.length} packages`] };
	}
	const t = policy.thresholds;
	if (s.ambiguous || s.candidates.length >= t.led_min_files || s.packages.length >= t.led_min_packages) {
		const why = s.ambiguous ? "scope unresolved" : s.candidates.length >= t.led_min_files ? `${s.candidates.length} candidate files` : `${s.packages.length} packages`;
		// Unresolved scope is missing evidence, not evidence of a small change: floor at led.
		// A large but resolved scope stays overridable (an explicit, informed user choice).
		return { level: "led", floor: s.ambiguous ? "led" : baseFloor, uncertainty, reasons: [why] };
	}
	if (s.candidates.length === 1 && s.triageRisk === "low" && s.interfaceHits.length === 0 && s.testsNearby && s.checks.length > 0) {
		return { level: "direct", floor: "direct", uncertainty, reasons: ["one localized low-risk file with adjacent tests and runnable checks"] };
	}
	const why = s.checks.length === 0 ? "no runnable checks" : !s.testsNearby ? "no adjacent tests" : s.interfaceHits.length ? "local interface change" : s.triageRisk !== "low" ? `risk ${s.triageRisk}` : `${s.candidates.length} files`;
	return { level: "checked", floor: baseFloor, uncertainty, reasons: [why] };
}

export function applyWorkflowOverride(d: WorkflowDecision, requested: WorkflowLevel | undefined): WorkflowDecision {
	if (!requested) return d;
	if (rank(requested) < rank(d.floor)) return { ...d, override: { requested, accepted: false, reason: `below hard floor ${d.floor}` } };
	return { ...d, level: requested, reasons: [...d.reasons, `override --workflow ${requested}`], override: { requested, accepted: true, reason: "at or above floor" } };
}

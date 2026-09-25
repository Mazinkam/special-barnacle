import { describe, expect, test } from "bun:test";
import { loadEfficiencyControls, resolveEfficiencyControls } from "./efficiency-flags";

describe("efficiency controls", () => {
	test("shipped defaults are all off", () => {
		const { controls, enabled } = loadEfficiencyControls({});
		expect(controls.recon_before_architect.enabled).toBe(false);
		expect(controls.delegation_guidance.enabled).toBe(false);
		expect(controls.event_waiting_guidance.enabled).toBe(false);
		expect(controls.scoped_leads.enabled).toBe(false);
		expect(controls.file_ownership.mode).toBe("off");
		expect(controls.model_canaries.enabled).toBe(false);
		expect(controls.model_canaries.activation_available).toBe(false);
		expect(enabled).toEqual([]);
	});

	test("environment switches are independent", () => {
		const result = resolveEfficiencyControls(config, { HUMAIN_ORCHESTRATOR_EFFICIENCY_RECON_BEFORE_ARCHITECT: "on" });
		expect(result.controls.recon_before_architect.enabled).toBe(true);
		expect(result.controls.delegation_guidance.enabled).toBe(false);
		expect(result.enabled).toEqual(["recon_before_architect"]);
	});

	test("invalid environment values are ignored and reported", () => {
		const result = resolveEfficiencyControls(config, { HUMAIN_ORCHESTRATOR_EFFICIENCY_RECON_BEFORE_ARCHITECT: "maybe" });
		expect(result.controls.recon_before_architect.enabled).toBe(false);
		expect(result.problems.length).toBeGreaterThan(0);
	});

	test("malformed configuration falls back off and reports problems", () => {
		const result = resolveEfficiencyControls({}, {});
		expect(result.controls.recon_before_architect.enabled).toBe(false);
		expect(result.problems.length).toBeGreaterThan(0);
	});
});

const config = {
	recon_before_architect: { enabled: false },
	delegation_guidance: { enabled: false, own_tool_budget: { architect: 12, lead: 25 }, targeted_reads_allowed: 8 },
	event_waiting_guidance: { enabled: false },
	scoped_leads: { enabled: false, max_handoff_chars: 12000 },
	file_ownership: { mode: "off" },
};

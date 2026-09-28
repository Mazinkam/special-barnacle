import { describe, expect, test } from "bun:test";
import { loadEfficiencyControls, resolveEfficiencyControls } from "./efficiency-flags";

const config = {
	delegation_guidance: { enabled: false, own_tool_budget: { architect: 12, lead: 25 }, targeted_reads_allowed: 8 },
	event_waiting_guidance: { enabled: false },
	file_ownership: { mode: "off" },
};

describe("efficiency controls", () => {
	test("shipped defaults are all off", () => {
		const { controls, enabled } = loadEfficiencyControls({});
		expect(controls.delegation_guidance.enabled).toBe(false);
		expect(controls.event_waiting_guidance.enabled).toBe(false);
		expect(controls.file_ownership.mode).toBe("off");
		expect(controls.model_canaries.enabled).toBe(false);
		expect(enabled).toEqual([]);
	});
	test("environment switches are independent", () => {
		const result = resolveEfficiencyControls(config, { HUMAIN_ORCHESTRATOR_EFFICIENCY_DELEGATION_GUIDANCE: "on" });
		expect(result.controls.delegation_guidance.enabled).toBe(true);
		expect(result.controls.event_waiting_guidance.enabled).toBe(false);
		expect(result.enabled).toEqual(["delegation_guidance"]);
	});
	test("invalid environment values are ignored and reported", () => {
		const result = resolveEfficiencyControls(config, { HUMAIN_ORCHESTRATOR_EFFICIENCY_DELEGATION_GUIDANCE: "maybe" });
		expect(result.controls.delegation_guidance.enabled).toBe(false);
		expect(result.problems.length).toBeGreaterThan(0);
	});
	test("malformed configuration falls back off and reports problems", () => {
		const result = resolveEfficiencyControls({}, {});
		expect(result.controls.delegation_guidance.enabled).toBe(false);
		expect(result.problems.length).toBeGreaterThan(0);
	});
	test("removed switches and env overrides are rejected without activating", () => {
		const result = resolveEfficiencyControls({ ...config, scoped_leads: { enabled: true }, recon_before_architect: { enabled: true } }, {
			HUMAIN_ORCHESTRATOR_EFFICIENCY_SCOPED_LEADS: "on",
			HUMAIN_ORCHESTRATOR_EFFICIENCY_RECON_BEFORE_ARCHITECT: "on",
		});
		expect(result.enabled).toEqual([]);
		expect(result.problems.join(" ")).toContain("scoped_leads");
		expect(result.problems.join(" ")).toContain("recon_before_architect");
	});
	test("serialize is rejected rather than enabled", () => {
		const result = resolveEfficiencyControls({ ...config, file_ownership: { mode: "serialize" } }, {});
		expect(result.controls.file_ownership.mode).toBe("off");
		expect(result.problems.join(" ")).toContain("serialize");
		const overridden = resolveEfficiencyControls(config, { HUMAIN_ORCHESTRATOR_EFFICIENCY_FILE_OWNERSHIP: "serialize" });
		expect(overridden.controls.file_ownership.mode).toBe("off");
		expect(overridden.problems.join(" ")).toContain("serialize");
	});
});

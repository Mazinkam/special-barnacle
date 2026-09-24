import { describe, expect, test } from "bun:test";
import { SpendCapTracker, capFor } from "./spend-cap.ts";
import { METHOD } from "./models.ts";

const policy = { mode: "warn" as const, usd_by_capability: { lead: 4, lead_large: 10 }, default_usd: 1 };

describe("spend cap", () => {
	test("capFor uses the capability cap, then the default", () => {
		expect(capFor("lead", policy)).toBe(4);
		expect(capFor("scout", policy)).toBe(1);
		expect(capFor("lead_large")).toBe(METHOD.rules.dispatch_spend_cap.usd_by_capability.lead_large);
	});
	test("warn fires once when crossed, including one large jump", () => {
		const t = new SpendCapTracker(policy);
		expect(t.observe("a", "lead", 3.9)).toBe("ok");
		expect(t.observe("a", "lead", 4)).toBe("ok"); // at the cap is not over it
		expect(t.observe("a", "lead", 12)).toBe("warn");
		expect(t.observe("a", "lead", 20)).toBe("ok");
		expect(t.observe("b", "lead", 0)).toBe("ok");
		expect(t.observe("b", "lead", 5)).toBe("warn");
	});
	test("enforce returns stop exactly once", () => {
		const t = new SpendCapTracker({ ...policy, mode: "enforce" });
		expect(t.observe("a", "lead_large", 10.01)).toBe("stop");
		expect(t.observe("a", "lead_large", 11)).toBe("ok");
	});
	test("off never fires; NaN cost never fires", () => {
		expect(new SpendCapTracker({ ...policy, mode: "off" }).observe("a", "lead", 1000)).toBe("ok");
		expect(new SpendCapTracker(policy).observe("a", "lead", Number.NaN)).toBe("ok");
	});
});

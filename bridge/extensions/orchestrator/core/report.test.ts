import { describe, expect, test } from "bun:test";
import { verificationVerdictFor } from "./report.ts";

const base = { blocked: false, dispatchOk: true, verificationSkipped: false, filesChangedCount: 3, passedVerification: true };

describe("core/report.ts verificationVerdictFor", () => {
	test("blocked wins over every other state", () => {
		expect(verificationVerdictFor({ ...base, blocked: true, dispatchOk: false })).toContain("NOT RUN (blocked");
	});

	test("no lead succeeded, not blocked", () => {
		expect(verificationVerdictFor({ ...base, dispatchOk: false })).toBe("NOT RUN (no lead succeeded)");
	});

	test("skipped with no files changed reads as N/A, not SKIPPED", () => {
		expect(verificationVerdictFor({ ...base, verificationSkipped: true, filesChangedCount: 0 })).toContain("N/A");
	});

	test("skipped with files changed reads as SKIPPED", () => {
		expect(verificationVerdictFor({ ...base, verificationSkipped: true, filesChangedCount: 2 })).toBe("SKIPPED (no files changed)");
	});

	test("verification ran: PASS/FAIL follow the actual verdict, not dispatch success", () => {
		expect(verificationVerdictFor({ ...base, passedVerification: true })).toBe("PASS");
		expect(verificationVerdictFor({ ...base, passedVerification: false })).toBe("FAIL");
	});
});

import { describe, expect, test } from "bun:test";
import { parseAcceptanceManifest } from "./live-qa-acceptance.ts";

function valid144(): Record<string, unknown> {
	return {
		version: 1,
		issue: 144,
		criteria: [
			{ id: "AC-1", text: "source is shared with other", expected: { identity: "other" } },
			{ id: "AC-2", text: "source in error state", expected: { "source.status": "error", "source.editorAccess": true, "target.existsBefore": false } },
			{ id: "AC-3", text: "422 invalid state", expected: { "http.status": 422, "body.code": "invalid_state", "body.message": "invalid state" } },
			{ id: "AC-4", text: "source unchanged and target absent after the request", expected: { "source.unchanged": true, "target.existsAfter": false } },
			{ id: "AC-5", text: "no duplicate, provisioning, or analytics records created", manual: true },
		],
	};
}

function reject(raw: unknown): string {
	const r = parseAcceptanceManifest(raw);
	expect(r.ok).toBe(false);
	return r.ok ? "" : r.reason;
}

describe("parseAcceptanceManifest", () => {
	test("parses the #144 manifest", () => {
		const r = parseAcceptanceManifest(valid144());
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.manifest.criteria).toHaveLength(5);
			expect(r.manifest.criteria[2].expected).toEqual({ "http.status": 422, "body.code": "invalid_state", "body.message": "invalid state" });
			expect(r.manifest.criteria[4]).toEqual({ id: "AC-5", text: "no duplicate, provisioning, or analytics records created", manual: true });
		}
	});
	test("rejects expected and manual together", () => {
		const m = valid144();
		(m.criteria as Record<string, unknown>[])[0].manual = true;
		expect(reject(m)).toContain("exactly one");
	});
	test("rejects neither expected nor manual", () => {
		const m = valid144();
		delete (m.criteria as Record<string, unknown>[])[0].expected;
		reject(m);
	});
	test("rejects duplicate id", () => {
		const m = valid144();
		(m.criteria as Record<string, unknown>[])[1].id = "AC-1";
		expect(reject(m)).toContain("duplicate");
	});
	test("rejects 21 criteria", () => {
		const m = valid144();
		m.criteria = Array.from({ length: 21 }, (_, i) => ({ id: `AC-${i + 1}`, text: "t", manual: true }));
		reject(m);
	});
	test("rejects unknown keys at both levels", () => {
		const top = valid144();
		top.extra = 1;
		reject(top);
		const per = valid144();
		(per.criteria as Record<string, unknown>[])[0].extra = 1;
		reject(per);
	});
	test("rejects a nested object value", () => {
		const m = valid144();
		(m.criteria as Record<string, unknown>[])[0].expected = { identity: { a: 1 } };
		reject(m);
	});
	test("rejects a __proto__ expected key", () => {
		const m = JSON.parse('{"version":1,"issue":144,"criteria":[{"id":"AC-1","text":"t","expected":{"__proto__":"x"}}]}');
		reject(m);
	});
	test("rejects bad version, issue, id, text, non-finite numbers, long strings, manual:false", () => {
		reject({ ...valid144(), version: 2 });
		reject({ ...valid144(), issue: 0 });
		reject({ version: 1, issue: 1, criteria: [] });
		reject({ version: 1, issue: 1, criteria: [{ id: "AC-1000", text: "t", manual: true }] });
		reject({ version: 1, issue: 1, criteria: [{ id: "AC-1", text: "", manual: true }] });
		reject({ version: 1, issue: 1, criteria: [{ id: "AC-1", text: "t", manual: false }] });
		reject({ version: 1, issue: 1, criteria: [{ id: "AC-1", text: "t", expected: { a: Number.NaN } }] });
		reject({ version: 1, issue: 1, criteria: [{ id: "AC-1", text: "t", expected: { a: "x".repeat(201) } }] });
		reject({ version: 1, issue: 1, criteria: [{ id: "AC-1", text: "t", expected: { Bad: 1 } }] });
		reject(null);
	});
});

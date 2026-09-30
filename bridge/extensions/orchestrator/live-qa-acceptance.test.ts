import { describe, expect, test } from "bun:test";
import { distrustAcceptance, evaluateAcceptance, parseAcceptanceManifest, redactAcceptance, type AcceptanceManifest } from "./live-qa-acceptance.ts";

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

const m144 = { version: 1, issue: 144, criteria: [
	{ id: "AC-3", text: "422 invalid_state", expected: { "http.status": 422, "body.code": "invalid_state", "body.message": "invalid state" } },
	{ id: "AC-5", text: "no side effects", manual: true },
] } as const;
const ok422 = { "http.status": 422, "body.code": "invalid_state", "body.message": "invalid state" };

describe("evaluateAcceptance", () => {
	test("409 cannot satisfy an expected 422", () => {
		const r = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", observed: { "http.status": 409, "body.code": "project_source_repository_unavailable", "body.message": "Source project repository is unavailable" } },
			{ id: "AC-5", result: "PASS", artifacts: ["results.md"] }] }, new Set(["results.md"]));
		expect(r.overall).toBe("fail");
		expect(r.criteria[0]?.result).toBe("fail");
		expect(r.criteria[0]?.note).toContain("http.status: expected 422, observed 409");
	});

	test("contradictory agent result: matching observed but FAIL is fail, but BLOCKED is blocked", () => {
		const run = (result: string) => evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result, observed: ok422 },
			{ id: "AC-5", result: "PASS", artifacts: ["results.md"] }] }, new Set(["results.md"]));
		expect(run("FAIL").criteria[0]?.result).toBe("fail");
		expect(run("FAIL").overall).toBe("fail");
		expect(run("BLOCKED").criteria[0]?.result).toBe("blocked");
		expect(run("BLOCKED").overall).toBe("blocked");
		expect(run("PASS").criteria[0]?.result).toBe("pass");
	});

	test("manual criterion without a confined artifact is blocked", () => {
		const r = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", observed: ok422 },
			{ id: "AC-5", result: "PASS", artifacts: ["../../etc/passwd"] }] }, new Set(["results.md"]));
		expect(r.criteria[1]?.result).toBe("blocked");
		expect(r.overall).toBe("blocked");
	});

	test("missing criterion is blocked; unexpected id blocks overall", () => {
		const missing = evaluateAcceptance(m144 as never, { criteria: [{ id: "AC-3", result: "PASS", observed: ok422 }] }, new Set(["results.md"]));
		expect(missing.criteria[1]?.result).toBe("blocked");
		expect(missing.criteria[1]?.note).toContain("not reported");
		expect(missing.overall).toBe("blocked");
		const extra = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", observed: ok422 },
			{ id: "AC-5", result: "PASS", artifacts: ["results.md"] },
			{ id: "AC-9", result: "PASS" }] }, new Set(["results.md"]));
		expect(extra.overall).toBe("blocked");
		expect(JSON.stringify(extra)).toContain("unexpected criterion ids");
	});

	test("exact 422 evidence passes", () => {
		const r = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", observed: ok422 },
			{ id: "AC-5", result: "PASS", artifacts: ["results.md"] }] }, new Set(["results.md"]));
		expect(r.overall).toBe("pass");
		expect(r.criteria.map((c) => c.result)).toEqual(["pass", "pass"]);
		expect(r.criteria[1]?.artifacts).toEqual(["results.md"]);
	});

	test("malformed or hostile reported shapes are blocked, never thrown", () => {
		for (const bad of [null, "x", 5, {}, { criteria: "no" }, { criteria: [null, 3] }]) {
			const r = evaluateAcceptance(m144 as never, bad, new Set());
			expect(r.overall).toBe("blocked");
			expect(r.criteria).toHaveLength(2);
		}
		const proto = JSON.parse('{"criteria":[{"id":"AC-3","result":"PASS","observed":{"__proto__":{"http.status":422}}},{"id":"AC-5","result":"PASS","artifacts":["results.md"]}]}');
		const r = evaluateAcceptance(m144 as never, proto, new Set(["results.md"]));
		expect(r.criteria[0]?.result).toBe("blocked");
	});

	test("present null and object values fail, while an absent key is blocked", () => {
		const manifest = { version: 1, issue: 1, criteria: [{ id: "AC-1", text: "status", expected: { "http.status": 422 } }] };
		const evaluate = (observed: Record<string, unknown>) => evaluateAcceptance(manifest as never, { criteria: [
			{ id: "AC-1", result: "PASS", observed },
		] }, new Set());

		const nullValue = evaluate({ "http.status": null });
		expect(nullValue.criteria[0]?.result).toBe("fail");
		expect(nullValue.criteria[0]?.note).toContain("http.status: expected 422, observed null");

		const objectValue = evaluate({ "http.status": { a: 1 } });
		expect(objectValue.criteria[0]?.result).toBe("fail");
		expect(objectValue.criteria[0]?.note).toContain("http.status: expected 422, observed object");

		const secretValue = evaluate({ "http.status": { secret: "x" } });
		expect(secretValue.criteria[0]?.note).toContain("http.status: expected 422, observed object");
		expect(secretValue.criteria[0]?.note).not.toContain("secret");

		const absent = evaluate({});
		expect(absent.criteria[0]?.result).toBe("blocked");
	});

	test("missing observed key is blocked", () => {
		const r = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", observed: { "http.status": 422 } },
			{ id: "AC-5", result: "FAIL" }] }, new Set());
		expect(r.criteria[0]?.result).toBe("blocked");
		expect(r.criteria[1]?.result).toBe("fail");
		expect(r.overall).toBe("fail");
	});

	test("more than 100 reported criteria: blocked, not iterated", () => {
		const many = Array.from({ length: 101 }, (_, i) => ({ id: `AC-${i % 5 + 1}`, result: "PASS" }));
		const r = evaluateAcceptance(m144 as never, { criteria: many }, new Set());
		expect(r.overall).toBe("blocked");
		expect(r.criteria.every((c) => c.result === "blocked" && (c.note ?? "").includes("too many reported criteria"))).toBe(true);
	});

	test("per-criterion artifacts are capped at RUN_RESULT_LIMITS.artifacts", () => {
		const names = Array.from({ length: 80 }, (_, i) => `a${i}.log`);
		const r = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", observed: { "http.status": 422, "body.code": "invalid_state", "body.message": "invalid state" } },
			{ id: "AC-5", result: "PASS", artifacts: names }] }, new Set(names));
		expect(r.criteria[1]?.artifacts.length).toBe(50);
		expect(r.criteria[1]?.result).toBe("pass");
	});

	test("redaction happens before clipping: a secret straddling the clip boundary leaves no prefix", () => {
		const redact = (t: string) => t.split("s3cr3t-value-abcdefghijk").join("[REDACTED]");
		const lead = "http.status: expected 422, observed 409 (agent note: ";
		const filler = "x".repeat(2040 - lead.length);
		const r = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", note: `${filler}s3cr3t-value-abcdefghijk tail`, observed: { "http.status": 409, "body.code": "invalid_state", "body.message": "invalid state" } },
			{ id: "AC-5", result: "FAIL" }] }, new Set(), redact);
		const note = r.criteria[0]?.note ?? "";
		expect(note).not.toContain("s3cr");
		expect(note.length).toBeLessThanOrEqual(2048);
		const observedLong = evaluateAcceptance(m144 as never, { criteria: [
			{ id: "AC-3", result: "PASS", observed: { "http.status": 422, "body.code": "invalid_state", "body.message": `${"y".repeat(2040)}s3cr3t-value-abcdefghijk` } },
			{ id: "AC-5", result: "FAIL" }] }, new Set(), redact);
		expect(JSON.stringify(observedLong)).not.toContain("s3cr");
	});
});

describe("redactAcceptance", () => {
	test("redacts notes, expected, observed strings and artifact names; no git-id exemption", () => {
		const hex = "0123456789abcdef0123456789abcdef01234567";
		const redact = (t: string) => t.split(hex).join("[REDACTED]");
		const out = redactAcceptance({ overall: "fail", criteria: [{
			id: "AC-1", result: "fail", note: `n ${hex}`, expected: { sha: hex, n: 1 }, observed: { tree: hex, ok: true }, artifacts: [hex],
		}] }, redact);
		expect(JSON.stringify(out)).not.toContain(hex);
		expect(out.criteria[0]?.expected).toEqual({ sha: "[REDACTED]", n: 1 });
		expect(out.criteria[0]?.observed).toEqual({ tree: "[REDACTED]", ok: true });
	});
});

describe("evaluateAcceptance clipping", () => {
	const manifest: AcceptanceManifest = { version: 1, issue: 1, criteria: [
		{ id: "AC-1", text: "t", expected: { a: "x" } },
		{ id: "AC-2", text: "t", expected: { b: "y" } },
	] };
	test("observed strings are clipped to 200 and agent notes to 300, with explicit markers", () => {
		const r = evaluateAcceptance(manifest, { criteria: [
			{ id: "AC-1", result: "PASS", observed: { a: "o".repeat(5000) }, note: "n".repeat(5000) },
			{ id: "AC-2", result: "FAIL", note: "m".repeat(5000) },
		] }, new Set());
		expect(r.overall).toBe("fail");
		const obs = r.criteria[0]!.observed!.a as string;
		expect(obs.length).toBeLessThanOrEqual(200);
		expect(obs).toContain("…[truncated");
		const note1 = r.criteria[0]!.note!;
		expect(note1.length).toBeLessThan(900);
		expect(note1).toContain("…[truncated");
		const note2 = r.criteria[1]!.note!;
		expect(note2.length).toBeLessThanOrEqual("agent reported FAIL (agent note: )".length + 300);
		expect(note2).toContain("…[truncated");
	});
	test("a secret straddling the 200-char observed clip is redacted first (no prefix left)", () => {
		const secret = "SECRETSECRETSECRET";
		const redact = (t: string) => t.split(secret).join("[REDACTED]");
		const value = `${"o".repeat(185)}${secret}tail`;
		const r = evaluateAcceptance(manifest, { criteria: [
			{ id: "AC-1", result: "PASS", observed: { a: value }, note: value },
			{ id: "AC-2", result: "PASS", observed: { b: "y" } },
		] }, new Set(), redact);
		expect(JSON.stringify(r)).not.toContain("SECRET");
	});
});

describe("evaluateAcceptance unexpected ids", () => {
	const manifest: AcceptanceManifest = { version: 1, issue: 1, criteria: [
		{ id: "AC-1", text: "t", expected: { a: "x" } },
		{ id: "AC-2", text: "t", expected: { b: "y" } },
	] };
	test("one fail + one unknown id => overall blocked, with the unexpected ids noted", () => {
		const r = evaluateAcceptance(manifest, { criteria: [
			{ id: "AC-1", result: "FAIL" },
			{ id: "AC-2", result: "PASS", observed: { b: "y" } },
			{ id: "AC-99", result: "PASS" },
		] }, new Set());
		expect(r.overall).toBe("blocked");
		expect(r.criteria[0]?.result).toBe("fail");
		expect(r.criteria[1]?.result).toBe("blocked");
		expect(r.criteria[1]?.note).toContain("unexpected criterion ids: AC-99");
	});
	test("one fail + a malformed entry => overall blocked", () => {
		const r = evaluateAcceptance(manifest, { criteria: [{ id: "AC-1", result: "FAIL" }, "junk"] }, new Set());
		expect(r.overall).toBe("blocked");
	});
});

describe("distrustAcceptance", () => {
	const crit = (id: string, result: "pass" | "fail" | "blocked") => ({ id, result, artifacts: [] });
	test("pass verdict leaves acceptance untouched", () => {
		const a = { overall: "pass" as const, criteria: [crit("AC-1", "pass")] };
		expect(distrustAcceptance(a, "pass")).toBe(a);
	});
	test("non-pass verdict: pass -> blocked, fail stays fail", () => {
		const r = distrustAcceptance({ overall: "fail", criteria: [crit("AC-1", "pass"), crit("AC-2", "fail")] }, "unavailable");
		expect(r.overall).toBe("fail");
		expect(r.criteria.map((c) => c.result)).toEqual(["blocked", "fail"]);
		expect(r.criteria[0]?.note).toBe("live QA verdict unavailable; evidence not trusted");
	});
	test("an already-blocked overall (e.g. unexpected ids) is never relaxed to fail", () => {
		const r = distrustAcceptance({ overall: "blocked", criteria: [crit("AC-1", "pass"), crit("AC-2", "fail")] }, "fail");
		expect(r.overall).toBe("blocked");
	});
});

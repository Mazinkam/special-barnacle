/**
 * Acceptance manifest (`--live-qa-acceptance`): the per-issue list of criteria a live-QA run is
 * checked against. Parsed strictly and prototype-safely; output objects are rebuilt from scratch.
 */

export interface AcceptanceCriterion {
	id: string;
	text: string;
	expected?: Record<string, string | number | boolean>;
	manual?: true;
}

export interface AcceptanceManifest {
	version: 1;
	issue: number;
	criteria: AcceptanceCriterion[];
}

export type AcceptanceParseResult = { ok: true; manifest: AcceptanceManifest } | { ok: false; reason: string };

const ID_RE = /^AC-\d{1,3}$/;
const KEY_RE = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const MAX_CRITERIA = 20;
const MAX_TEXT = 500;
const MAX_EXPECTED_KEYS = 10;
const MAX_EXPECTED_STRING = 200;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(reason: string): { ok: false; reason: string } {
	return { ok: false, reason };
}

export function parseAcceptanceManifest(raw: unknown): AcceptanceParseResult {
	if (!isPlainRecord(raw)) return fail("manifest must be an object");
	const own = (o: Record<string, unknown>, k: string): unknown =>
		Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
	for (const key of Object.keys(raw)) {
		if (key !== "version" && key !== "issue" && key !== "criteria") return fail(`unknown manifest key "${key}"`);
	}
	if (own(raw, "version") !== 1) return fail("version must be 1");
	const issue = own(raw, "issue");
	if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) return fail("issue must be a positive integer");
	const list = own(raw, "criteria");
	if (!Array.isArray(list)) return fail("criteria must be an array");
	if (list.length < 1 || list.length > MAX_CRITERIA) return fail(`criteria must have 1-${MAX_CRITERIA} entries`);

	const seen = new Set<string>();
	const criteria: AcceptanceCriterion[] = [];
	for (let i = 0; i < list.length; i++) {
		const c = list[i] as unknown;
		if (!isPlainRecord(c)) return fail(`criteria[${i}] must be an object`);
		for (const key of Object.keys(c)) {
			if (key !== "id" && key !== "text" && key !== "expected" && key !== "manual") {
				return fail(`criteria[${i}] has unknown key "${key}"`);
			}
		}
		const id = own(c, "id");
		if (typeof id !== "string" || !ID_RE.test(id)) return fail(`criteria[${i}].id must match ${ID_RE.source}`);
		if (seen.has(id)) return fail(`duplicate criterion id "${id}"`);
		seen.add(id);
		const text = own(c, "text");
		if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
			return fail(`${id}: text must be a string of 1-${MAX_TEXT} characters`);
		}
		const expected = own(c, "expected");
		const manual = own(c, "manual");
		const hasExpected = Object.prototype.hasOwnProperty.call(c, "expected");
		const hasManual = Object.prototype.hasOwnProperty.call(c, "manual");
		if (hasExpected === hasManual) return fail(`${id}: exactly one of "expected" or "manual" is required`);
		if (hasManual) {
			if (manual !== true) return fail(`${id}: manual must be literally true`);
			criteria.push({ id, text, manual: true });
			continue;
		}
		if (!isPlainRecord(expected)) return fail(`${id}: expected must be an object`);
		const keys = Object.keys(expected);
		if (keys.length < 1 || keys.length > MAX_EXPECTED_KEYS) return fail(`${id}: expected must have 1-${MAX_EXPECTED_KEYS} keys`);
		const out: Record<string, string | number | boolean> = Object.create(null);
		for (const key of keys) {
			if (!KEY_RE.test(key)) return fail(`${id}: expected key "${key}" is invalid`);
			const value = expected[key];
			if (typeof value === "string") {
				if (value.length > MAX_EXPECTED_STRING) return fail(`${id}: expected.${key} exceeds ${MAX_EXPECTED_STRING} characters`);
			} else if (typeof value === "number") {
				if (!Number.isFinite(value)) return fail(`${id}: expected.${key} must be finite`);
			} else if (typeof value !== "boolean") {
				return fail(`${id}: expected.${key} must be a string, number, or boolean`);
			}
			out[key] = value;
		}
		criteria.push({ id, text, expected: { ...out } });
	}
	return { ok: true, manifest: { version: 1, issue, criteria } };
}

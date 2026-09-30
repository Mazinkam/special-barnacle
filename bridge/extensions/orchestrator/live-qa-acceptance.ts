/**
 * Acceptance manifest (`--live-qa-acceptance`): the per-issue list of criteria a live-QA run is
 * checked against. Parsed strictly and prototype-safely; output objects are rebuilt from scratch.
 */

import { RUN_RESULT_LIMITS, type AcceptanceResult, type CriterionResult } from "./core/run-result.ts";

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

// -----------------------------------------------------------------------------
// Evaluation: compare the (untrusted) agent-reported acceptance.json to the manifest.
// -----------------------------------------------------------------------------

type Primitive = string | number | boolean;
type Redact = (text: string) => string;
const identity: Redact = (t) => t;

function clip(text: string): string {
	const max = RUN_RESULT_LIMITS.stringChars;
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isPrimitive(v: unknown): v is Primitive {
	return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function fmt(v: unknown): string {
	if (isPrimitive(v)) return JSON.stringify(v);
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "object") return "object";
	return typeof v;
}

function ownValue(o: object, k: string): unknown {
	return Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}

/** Every criterion `blocked` with `note` (redacted, then clipped -- never the reverse). */
export function blockedAcceptance(manifest: AcceptanceManifest, note: string, redact: Redact = identity): AcceptanceResult {
	return {
		overall: "blocked",
		criteria: manifest.criteria.map((c) => ({ id: c.id, result: "blocked" as const, artifacts: [], note: clip(redact(note)) })),
	};
}

/**
 * Applies `redact` to EVERY string in an acceptance result -- ids, notes, expected/observed string
 * values, artifact names -- with no git-object-id exemption (unlike `sanitizeForPersistence`, whose
 * key-based exemption would let a 40-hex secret sit unredacted under an `expected` key named `sha`).
 */
export function redactAcceptance(acceptance: AcceptanceResult, redact: Redact): AcceptanceResult {
	const rec = (o: Record<string, Primitive>): Record<string, Primitive> =>
		Object.fromEntries(Object.entries(o).map(([k, v]) => [redact(k), typeof v === "string" ? redact(v) : v]));
	return {
		overall: acceptance.overall,
		criteria: acceptance.criteria.map((c) => ({
			id: redact(c.id),
			result: c.result,
			...(c.expected ? { expected: rec(c.expected) } : {}),
			...(c.observed ? { observed: rec(c.observed) } : {}),
			artifacts: c.artifacts.map(redact),
			...(c.note !== undefined ? { note: redact(c.note) } : {}),
		})),
	};
}

function overallOf(criteria: CriterionResult[]): AcceptanceResult["overall"] {
	return criteria.some((c) => c.result === "fail") ? "fail" : criteria.some((c) => c.result === "blocked") ? "blocked" : "pass";
}

/**
 * Acceptance evidence is only as trustworthy as the live-QA session that produced it: whenever the
 * final live-QA verdict is not `pass`, every `pass` criterion becomes `blocked` (a genuine `fail`
 * stays `fail`) and `overall` is recomputed. Idempotent.
 */
export function distrustAcceptance(acceptance: AcceptanceResult, verdict: string): AcceptanceResult {
	if (verdict === "pass") return acceptance;
	const note = `live QA verdict ${verdict}; evidence not trusted`;
	const criteria = acceptance.criteria.map((c) => (c.result === "pass" ? { ...c, result: "blocked" as const, note } : c));
	return { overall: criteria.length === 0 ? (acceptance.overall === "fail" ? "fail" : "blocked") : overallOf(criteria), criteria };
}

/** Reported-criteria entries beyond this are never iterated: the whole result is blocked. */
export const MAX_REPORTED_CRITERIA = 100;

/**
 * `redact` is applied to every agent-influenced string BEFORE it is clipped to
 * `RUN_RESULT_LIMITS.stringChars`, so a secret straddling the clip boundary can never leave a
 * recognisable prefix behind. Comparisons always use the raw (unredacted) values.
 */
export function evaluateAcceptance(
	manifest: AcceptanceManifest,
	reported: unknown,
	confinedArtifactNames: Set<string>,
	redact: Redact = identity,
): AcceptanceResult {
	const fin = (text: string): string => clip(redact(text));
	if (!isPlainRecord(reported)) return blockedAcceptance(manifest, "acceptance.json is not an object", redact);
	const list = ownValue(reported, "criteria");
	if (!Array.isArray(list)) return blockedAcceptance(manifest, "acceptance.json has no criteria array", redact);
	if (list.length > MAX_REPORTED_CRITERIA) {
		return blockedAcceptance(manifest, `too many reported criteria (${list.length} > ${MAX_REPORTED_CRITERIA})`, redact);
	}

	const byId = new Map<string, Record<string, unknown>>();
	const duplicates = new Set<string>();
	const unexpected: string[] = [];
	const manifestIds = new Set(manifest.criteria.map((c) => c.id));
	let malformed = 0;
	for (const entry of list) {
		if (!isPlainRecord(entry)) {
			malformed++;
			continue;
		}
		const id = ownValue(entry, "id");
		if (typeof id !== "string") {
			malformed++;
			continue;
		}
		if (!manifestIds.has(id)) {
			unexpected.push(id);
			continue;
		}
		if (byId.has(id)) duplicates.add(id);
		else byId.set(id, entry);
	}

	let artifactBudget: number = RUN_RESULT_LIMITS.artifacts;
	const criteria: CriterionResult[] = manifest.criteria.map((c): CriterionResult => {
		const blocked = (note: string, artifacts: string[] = []): CriterionResult => ({
			id: c.id, result: "blocked", ...(c.expected ? { expected: { ...c.expected } } : {}), artifacts, note: fin(note),
		});
		const entry = byId.get(c.id);
		if (!entry) return blocked("not reported");
		if (duplicates.has(c.id)) return blocked("reported more than once");
		const result = ownValue(entry, "result");
		if (result !== "PASS" && result !== "FAIL" && result !== "BLOCKED") return blocked("result must be PASS, FAIL or BLOCKED");
		const agentNote = ownValue(entry, "note");
		const suffix = typeof agentNote === "string" && agentNote ? ` (agent note: ${agentNote})` : "";

		if (c.expected) {
			// Conservative: the agent's own FAIL/BLOCKED is never overridden by observed evidence;
			// only a reported PASS can become pass (and only when every expected key matches).
			if (result === "FAIL") return { id: c.id, result: "fail", expected: { ...c.expected }, artifacts: [], note: fin(`agent reported FAIL${suffix}`) };
			if (result === "BLOCKED") return blocked(`agent reported BLOCKED${suffix}`);
			const observedRaw = ownValue(entry, "observed");
			if (!isPlainRecord(observedRaw)) return blocked("observed evidence missing");
			const observed: Record<string, Primitive> = {};
			const mismatches: string[] = [];
			const missing: string[] = [];
			for (const [key, want] of Object.entries(c.expected)) {
				if (!Object.hasOwn(observedRaw, key)) {
					missing.push(key);
					continue;
				}
				const got = ownValue(observedRaw, key);
				if (isPrimitive(got)) observed[key] = typeof got === "string" ? fin(got) : got;
				if (got !== want) mismatches.push(`${key}: expected ${fmt(want)}, observed ${fmt(got)}`);
			}
			const base = { id: c.id, expected: { ...c.expected }, ...(Object.keys(observed).length ? { observed } : {}), artifacts: [] as string[] };
			if (mismatches.length > 0) {
				const extra = missing.length ? `; missing: ${missing.join(", ")}` : "";
				return { ...base, result: "fail", note: fin(mismatches.join("; ") + extra + suffix) };
			}
			if (missing.length > 0) return { ...base, result: "blocked", note: fin(`observed evidence missing keys: ${missing.join(", ")}${suffix}`) };
			return { ...base, result: "pass" };
		}

		// manual
		const claimed = ownValue(entry, "artifacts");
		const artifacts: string[] = [];
		if (Array.isArray(claimed)) {
			for (const a of claimed.slice(0, MAX_REPORTED_CRITERIA * 10)) {
				if (artifacts.length >= RUN_RESULT_LIMITS.artifacts) break;
				if (typeof a === "string" && confinedArtifactNames.has(a) && !artifacts.includes(a) && artifactBudget > 0) {
					artifacts.push(fin(a));
					artifactBudget--;
				}
			}
		}
		if (result === "FAIL") return { id: c.id, result: "fail", artifacts, note: fin(`agent reported FAIL${suffix}`) };
		if (result === "PASS" && artifacts.length > 0) return { id: c.id, result: "pass", artifacts };
		return blocked(result === "PASS" ? "PASS without a confined artifact" : `agent reported BLOCKED${suffix}`, artifacts);
	});

	const problems: string[] = [];
	if (unexpected.length > 0) problems.push(`unexpected criterion ids: ${unexpected.slice(0, 10).join(", ")}`);
	if (malformed > 0) problems.push(`${malformed} malformed criterion entr${malformed === 1 ? "y" : "ies"}`);
	if (problems.length > 0) {
		const note = fin(problems.join("; "));
		for (let i = 0; i < criteria.length; i++) {
			const c = criteria[i] as CriterionResult;
			if (c.result === "pass") criteria[i] = { ...c, result: "blocked", note };
		}
	}
	return { overall: overallOf(criteria), criteria };
}

/**
 * Pure triage logic: classify a goal into `task_class` / `complexity` / `risk`,
 * either heuristically or by validating an LLM's JSON verdict. Nothing here
 * spawns a process or reads `process.env` — the caller (`index.ts`'s
 * `triageTask`) owns the LLM dispatch and passes the raw response text in.
 */

export const VALID_TASK_CLASSES = [
	"implementation",
	"investigation",
	"bug_fix",
	"refactor",
	"test",
	"documentation",
	"design",
	"qa_verification",
];

export const VALID_RISKS = ["low", "medium", "high", "critical"];

export interface TriageResult {
	task_class: string;
	complexity: number;
	risk: string;
	reasoning: string;
}

export const TRIAGE_PROMPT = [
	"You are a task classifier for an autonomous coding orchestrator.",
	"Given the user\'s task goal below, classify it.",
	"Return ONLY a single valid JSON object (no markdown, no commentary, no extra text).",
	"",
	"JSON schema (all fields required):",
	'- "task_class": one of ' + JSON.stringify(VALID_TASK_CLASSES),
	'- "complexity": integer 1-10 (1=typo/one-liner, 10=multi-system architectural change spanning many files)',
	'- "risk": one of ' + JSON.stringify(VALID_RISKS) +
	  " (low=isolated change with no security/perf/data impact; " +
	  "critical=auth, payments, PII, or production data-loss potential)",
	'- "reasoning": one short sentence (<=120 chars) explaining the classification',
	"",
	"Task goal:",
].join("\n");

export function heuristicTriage(goal: string): TriageResult {
	// Cheap fallback when LLM triage is unavailable. Keyword-based with
	// conservative defaults. Intentionally under-confident.
	const text = goal.toLowerCase();
	let task_class = "implementation";
	if (/\b(fix|bug|broken|regress|issue|defect|error|failing)\b/.test(text)) task_class = "bug_fix";
	else if (/\b(refactor|reorgani[sz]e|restructure|clean up|tidy|modernize|rename|extract|split)\b/.test(text)) task_class = "refactor";
	else if (/\b(test|spec|coverage|jest|vitest|unit test|integration test)\b/.test(text)) task_class = "test";
	else if (/\b(investigate|why|investigate|root cause|debug|diagnose|triage|assess)\b/.test(text)) task_class = "investigation";
	else if (/\b(design|architect|propose|plan|spec|adr|whitepaper|rfc)\b/.test(text)) task_class = "design";
	else if (/\b(document|docs|readme|comment|jsdoc|tsdoc|changelog|wiki)\b/.test(text)) task_class = "documentation";
	else if (/\b(qa|verify|validate|check|audit|review|test plan)\b/.test(text)) task_class = "qa_verification";

	let complexity = 5;
	if (goal.length < 50) complexity = 3;
	else if (goal.length > 200) complexity = 7;
	if (/\b(refactor|architect|across|multiple|system|migration|rewrite|overhaul)\b/.test(text)) complexity = Math.max(complexity, 6);
	if (/\b(typo|one[- ]liner|small|tiny|minor|simple|quick|trivial|rename variable|update deps|bump version)\b/.test(text)) complexity = Math.min(complexity, 3);

	let risk: string = "medium";
	if (/\b(security|auth|permission|password|token|secret|ssl|tls|encrypt|cve|authn|authz|oauth|saml|sso)\b/.test(text)) risk = "high";
	if (/\b(payment|billing|money|financial|transaction|banking|credit|stripe|paypal|pci|ledger|invoice|payout|charge)\b/.test(text)) risk = "high";
	if (/\b(pii|personal data|gdpr|hipaa|private|redact|anonymize|pii|phi|ferpa|coppa)\b/.test(text)) risk = "high";
	if (/\b(critical|urgent|production|prod|live|customer-facing|p0|p1|sev[01]|outage|downtime|data loss|corruption)\b/.test(text)) risk = "critical";
	if (/\b(test|spec|doc|comment|readme|refactor|rename|cleanup|format|lint|type|typo|styling)\b/.test(text) && risk === "medium") risk = "low";

	return {
		task_class,
		complexity,
		risk,
		reasoning: `Heuristic: matched ${task_class} keywords; complexity by length/risk by keyword.`,
	};
}

/**
 * Normalise any complexity input (triage JSON or the manual `--complexity`
 * flag) to the integer 1-10 scale method.json's Rule-2 bands are defined on.
 * Out-of-band values (6.5, 12) otherwise match no `workers_by_complexity`
 * band, silently plan zero recon workers, and make the no-recon phase line
 * report a false reason.
 */
export function clampComplexity(raw: unknown, fallback = 5): number {
	// Only numbers and non-empty numeric strings are complexity values; null,
	// "", booleans and arrays mean "absent" and must take the fallback rather
	// than coerce to 0 and collapse to the minimum (which would skip recon).
	if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : fallback;
}

export function clampTriage(raw: Partial<TriageResult>): TriageResult | null {
	if (!raw || typeof raw !== "object") return null;
	const task_class = VALID_TASK_CLASSES.includes(raw.task_class ?? "")
		? raw.task_class!
		: "implementation";
	const complexity = clampComplexity(raw.complexity);
	const risk = VALID_RISKS.includes(raw.risk ?? "") ? raw.risk! : "medium";
	const reasoning = typeof raw.reasoning === "string" && raw.reasoning.length > 0
		? raw.reasoning.slice(0, 200)
		: "(no reasoning returned)";
	return { task_class, complexity, risk, reasoning };
}

/**
 * Extract and validate the classifier's JSON verdict from a child's final
 * assistant text. Strips markdown fences the model may have wrapped the JSON
 * in, then finds the outermost `{...}` span. Returns `null` (not a thrown
 * error) for anything that doesn't parse as a usable verdict; the caller
 * treats that the same as "triage unavailable". `JSON.parse` failures are
 * intentionally NOT caught here — the caller's own try/catch already wraps
 * the whole triage attempt, matching the pre-extraction behaviour where this
 * logic lived inline inside that same try block.
 */
export function parseTriageResponse(text: string): TriageResult | null {
	const jsonText = text
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/i, "")
		.trim();
	const firstBrace = jsonText.indexOf("{");
	const lastBrace = jsonText.lastIndexOf("}");
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
	const parsed = JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
	return clampTriage(parsed);
}

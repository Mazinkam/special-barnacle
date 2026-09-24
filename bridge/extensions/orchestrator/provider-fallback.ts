/**
 * Pure helpers for codex-first routing with a Bedrock fallback. A dispatch on
 * an `openai-codex/*` model that fails with a quota / rate-limit error is
 * retried once on the same model id under `amazon-bedrock` (metered, no
 * weekly cap). No I/O here; the bridge records `route_degraded`.
 */
import { resolveAlias, type AliasTable } from "./models.ts";

export const QUOTA_ERROR_RE = /usage limit|quota|rate.?limit|credit cap|\b429\b/i;

export function isQuotaError(text: string): boolean {
	return QUOTA_ERROR_RE.test(text);
}

/** `openai-codex/<id>` -> the preferred `amazon-bedrock/...<id>` twin, else null. */
export function bedrockFallbackFor(model: string, table: AliasTable): string | null {
	const prefix = "openai-codex/";
	if (!model.startsWith(prefix)) return null;
	const id = model.slice(prefix.length);
	const twins = (table.byAlias.get(id.toLowerCase()) ?? []).filter((c) => c.startsWith("amazon-bedrock/"));
	if (twins.length === 0) return null;
	return resolveAlias(`amazon-bedrock/${id}`, table, ["amazon-bedrock"]).model ?? null;
}

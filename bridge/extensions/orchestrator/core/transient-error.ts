/**
 * Local, pure classifier for transient (retry-worthy) provider errors, used
 * by C3 ("resume a lead after a transient failure instead of discarding
 * it"). This is a STAND-IN: `provider-fallback.ts`'s C2 work
 * (feat/model-failover) owns the real transient-vs-permanent classifier for
 * provider outage fallback/backoff/twin-model routing, and is expected to
 * replace this module (or have this module delegate to it) once it lands.
 * Until then this file exists so C3 does not have to wait on C2 or duplicate
 * its future shape.
 *
 * Quota/billing errors are excluded (they are permanent, not transient) by
 * reusing `provider-fallback.ts`'s `isQuotaError` — including its existing
 * `\b429\b` and `rate.?limit` patterns. That means a bare "429" or "rate
 * limit" message, with no other transient signal, is classified as a quota
 * error here too (not transient) and is left to C2's quota fallback path;
 * this classifier's own 429/rate-limit patterns only fire for text that also
 * carries some other transient signal (e.g. "429" alongside "overloaded").
 */
import { isQuotaError } from "../provider-fallback.ts";

/** HTTP 5xx (or Anthropic's 529 overloaded), overloaded/rate-limit wording, common Node socket
 *  errors, and a couple of provider-specific transient phrasings seen in the field. */
export const TRANSIENT_ERROR_RE =
	/\b(429|500|502|503|504|529)\b|overloaded|rate[ -]?limit|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|stream ended|premature close|service unavailable|internal server error/i;

/** True when `text` looks like a transient provider/network failure worth retrying, and is not
 *  a permanent quota/billing error (see module header for the 429/rate-limit overlap note). */
export function isTransientProviderError(text: string): boolean {
	if (!text) return false;
	if (isQuotaError(text)) return false;
	return TRANSIENT_ERROR_RE.test(text);
}

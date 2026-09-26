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

/**
 * A bare `5\d\d` number is never, on its own, a strong enough signal that a
 * report is describing an HTTP status code: a report can legitimately say
 * "500 lines changed" or "found 503 issues" with nothing to do with an HTTP
 * response. This requires a whole-word context marker (`HTTP`, `status`,
 * `error`, or `code`) immediately before the number, with only whitespace
 * or `:`/`=`/`#` separating them — e.g. "status: 507", "HTTP/1.1 520",
 * "error 520". The leading `\b` on the alternation is what makes this
 * whole-word: `code` must start at a real word boundary, so `decode 500`
 * does NOT count `code` as a marker (docs/architecture-review.md C3 — the
 * previous version's context check used unanchored substring matching and
 * fired on `code` inside `decode`).
 */
const HTTP_5XX_WITH_CONTEXT_RE = /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|error|code)[\s:=#]*5\d\d\b/i;

/** The literal token "5xx" mentioned near the word "http" (e.g. "HTTP 5xx from the upstream provider"). */
const HTTP_5XX_LITERAL_RE = /\bhttp\b[^\n]{0,10}\b5xx\b/i;

/**
 * Well-known HTTP reason phrases, Anthropic's "overloaded", common Node
 * socket errors, and timeout/throttling wording — all transient on their
 * own, independent of any adjacent number. Deliberately contains NO bare
 * numeric HTTP status code (500, 502, 503, 504, 529, ...): a bare number by
 * itself is only ever transient via `HTTP_5XX_WITH_CONTEXT_RE`/
 * `HTTP_5XX_LITERAL_RE` above (docs/architecture-review.md C3). "bad
 * gateway"/"gateway timeout" are included as phrases (not tied to 502/504's
 * digits) because they are the canonical, unambiguous HTTP reason strings
 * for those codes, the same way "service unavailable" already stood in for
 * 503 and "internal server error" for 500.
 */
export const TRANSIENT_ERROR_RE =
	/overloaded|rate[ -]?limit|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|stream ended|premature close|service unavailable|internal server error|bad gateway|gateway timeout|timed?[ -]?out|throttl(?:ed|ing)/i;

/** True when `text` looks like a transient provider/network failure worth retrying, and is not
 *  a permanent quota/billing error (see module header for the 429/rate-limit overlap note). */
export function isTransientProviderError(text: string): boolean {
	if (!text) return false;
	if (isQuotaError(text)) return false;
	return TRANSIENT_ERROR_RE.test(text) || HTTP_5XX_WITH_CONTEXT_RE.test(text) || HTTP_5XX_LITERAL_RE.test(text);
}

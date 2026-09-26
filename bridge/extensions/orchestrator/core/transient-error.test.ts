import { describe, expect, test } from "bun:test";
import { isTransientProviderError } from "./transient-error.ts";

describe("core/transient-error.ts isTransientProviderError", () => {
	const positive: Array<[string, string]> = [
		["500 Internal Server Error", "Internal Server Error (500): the model provider failed"],
		["502 Bad Gateway", "502 Bad Gateway"],
		["503 Service Unavailable", "Service unavailable: Bedrock is unable to process your request."],
		["504 Gateway Timeout", "upstream request timeout (504)"],
		["529 overloaded (Anthropic)", "overloaded_error: 529 the provider is temporarily overloaded"],
		["overloaded wording alone", "the model is overloaded, please retry"],
		["ECONNRESET", "Error: read ECONNRESET"],
		["ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443"],
		["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"],
		["EAI_AGAIN", "getaddrinfo EAI_AGAIN api.example.com"],
		["socket hang up", "Error: socket hang up"],
		["stream ended", "stream ended unexpectedly before completion"],
		["premature close", "Error: Premature close"],
		["internal server error phrasing", "internal server error, please try again"],
		["service unavailable phrasing", "503: service unavailable"],
		["timeout wording", "request timeout while waiting for the provider"],
		["timed out wording", "the request timed out after 60s"],
		["timed-out hyphenated wording", "connection timed-out"],
		["throttled wording", "the request was throttled by the provider"],
		["throttling wording", "provider is throttling requests right now"],
		["generic 5xx with status context", "status 507: insufficient storage at the provider"],
		["generic 5xx with HTTP 5xx literal", "HTTP 5xx from the upstream provider"],
		["generic 5xx with error context", "error 520: unknown error from Cloudflare"],
		["generic 5xx with code context", "code 503 returned from the sidecar"],
		["HTTP/version prefix", "HTTP/1.1 520 from the reverse proxy"],
		["bad gateway phrase alone (no context word, no number needed)", "502 Bad Gateway"],
		["status: prefix with colon, no space before number", "status: 507"],
		["HTTP prefix with space before number", "HTTP 500 returned from the load balancer"],
		["error prefix with space before number", "error 503 from the upstream service"],
	];

	for (const [label, text] of positive) {
		test(`transient: ${label}`, () => {
			expect(isTransientProviderError(text)).toBe(true);
		});
	}

	const negative: Array<[string, string]> = [
		["empty string", ""],
		["normal FAIL report", "STATUS: partial\n\nThe tests still fail: 3 assertions did not pass.\n\nSTATUS: blocked"],
		["normal bad-result report", "Task complete.\n\n## Result\n\nFAIL: the implementation does not compile.\n\nSTATUS: blocked"],
		["quota exhausted", "usage limit reached for this billing period"],
		["billing/credit cap", "Weekly credit cap reached. Resets next week."],
		["quota keyword", "quota exceeded for this model"],
		["bare 429 (quota overlaps rate limit)", "429 Too Many Requests"],
		["bare rate limit wording (quota overlaps)", "rate limit exceeded, slow down"],
		["unrelated crash", "TypeError: cannot read properties of undefined (reading 'foo')"],
		["plain exit", "exit 1"],
		["line count mention, not an HTTP status", "the report is 550 lines long"],
		["another line count mention, no status context", "the diff touched about 560 lines across the module"],
		["bare 500 with unrelated word containing \"code\" as a substring", "decode 500 bytes"],
		["bare 503 with unrelated word, no context marker", "found 503 issues"],
		["bare 502, no context word and no known reason phrase", "changed 502 lines in the diff"],
		["bare 504, no context word and no known reason phrase", "waited 504 milliseconds"],
		["marker glued directly to the number, no separator (C3)", "code500 error from the internal cache"],
		["marker glued to a longer word ending in a 5xx-looking number, no separator (C3)", "errorcode500x from the internal cache"],
	];

	for (const [label, text] of negative) {
		test(`not transient: ${label}`, () => {
			expect(isTransientProviderError(text)).toBe(false);
		});
	}
});

describe("core/transient-error.ts isTransientProviderError table tests (docs/architecture-review.md C3 5xx word-boundary fix)", () => {
	const table: Array<[string, string, boolean]> = [
		["decode 500 bytes", "decode 500 bytes", false],
		["found 503 issues", "found 503 issues", false],
		["status: 507", "status: 507", true],
		["HTTP/1.1 520", "HTTP/1.1 520", true],
		["HTTP 500", "HTTP 500", true],
		["error 503", "error 503", true],
		["code500 (no separator between marker and number)", "code500", false],
		["errorcode500x (no separator, trailing letter)", "errorcode500x", false],
	];

	for (const [label, text, expected] of table) {
		test(`${label} -> ${expected}`, () => {
			expect(isTransientProviderError(text)).toBe(expected);
		});
	}
});

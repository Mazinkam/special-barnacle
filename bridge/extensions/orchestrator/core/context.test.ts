import { describe, expect, test } from "bun:test";
import {
	buildProvidedContextBlock,
	CONTEXT_SOURCE_MAX_CHARS,
	contextFileLabel,
	formatContextSource,
	lastAssistantReplyText,
	LAST_REPLY_LABEL,
	type MinimalMessageEntry,
} from "./context.ts";

describe("core/context.ts formatContextSource / buildProvidedContextBlock", () => {
	test("no sources produce an empty block", () => {
		expect(buildProvidedContextBlock([])).toBe("");
	});

	test("one source under the cap is included verbatim under its label", () => {
		const block = buildProvidedContextBlock([{ label: "file: docs/plan.md", content: "the plan" }]);
		expect(block).toContain("## Provided context");
		expect(block).toContain("### file: docs/plan.md");
		expect(block).toContain("the plan");
	});

	test("multiple sources are separated and both present", () => {
		const block = buildProvidedContextBlock([
			{ label: "file: a.md", content: "A body" },
			{ label: "file: b.md", content: "B body" },
		]);
		expect(block).toContain("### file: a.md");
		expect(block).toContain("A body");
		expect(block).toContain("### file: b.md");
		expect(block).toContain("B body");
	});

	test("content at exactly the cap is not truncated", () => {
		const content = "x".repeat(CONTEXT_SOURCE_MAX_CHARS);
		const formatted = formatContextSource({ label: "file: x.md", content });
		expect(formatted).not.toContain("truncated");
		expect(formatted).toContain(content);
	});

	test("content over the cap is truncated with an explicit note naming the overage", () => {
		const content = "x".repeat(CONTEXT_SOURCE_MAX_CHARS + 123);
		const formatted = formatContextSource({ label: "file: x.md", content });
		expect(formatted).toContain("truncated: 123 more character(s) omitted");
		expect(formatted).toContain(`capped at ${CONTEXT_SOURCE_MAX_CHARS} characters`);
		expect(formatted.length).toBeLessThan(content.length + 200);
	});
});

describe("core/context.ts contextFileLabel", () => {
	test("a file inside cwd is shown as a relative path", () => {
		expect(contextFileLabel("/repo", "/repo/docs/plan.md")).toBe("file: docs/plan.md");
	});

	test("a file outside cwd never leaks the absolute home path", () => {
		const label = contextFileLabel("/repo/sub", "/Users/alice/notes.md");
		expect(label).not.toContain("/Users/alice");
		expect(label).toContain("<path>");
	});
});

describe("core/context.ts lastAssistantReplyText", () => {
	test("returns the last assistant message's text (string content)", () => {
		const entries: MinimalMessageEntry[] = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", content: "first reply" } },
			{ type: "message", message: { role: "user", content: "more" } },
			{ type: "message", message: { role: "assistant", content: "second reply" } },
		];
		expect(lastAssistantReplyText(entries)).toBe("second reply");
	});

	test("extracts text blocks when content is an array", () => {
		const entries: MinimalMessageEntry[] = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "block one" }, { type: "tool_use" }, { type: "text", text: "block two" }] },
			},
		];
		expect(lastAssistantReplyText(entries)).toBe("block one block two");
	});

	test("skips a blank assistant message and returns an earlier non-blank one", () => {
		const entries: MinimalMessageEntry[] = [
			{ type: "message", message: { role: "assistant", content: "real reply" } },
			{ type: "message", message: { role: "assistant", content: "   " } },
		];
		expect(lastAssistantReplyText(entries)).toBe("real reply");
	});

	test("returns null when there is no assistant message", () => {
		const entries: MinimalMessageEntry[] = [{ type: "message", message: { role: "user", content: "hi" } }];
		expect(lastAssistantReplyText(entries)).toBeNull();
	});

	test("returns null for an empty session", () => {
		expect(lastAssistantReplyText([])).toBeNull();
	});

	test("uses the documented label for the with-last-reply source", () => {
		expect(LAST_REPLY_LABEL).toBe("last assistant reply");
	});
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";

import {
	CONTEXT_AGGREGATE_MAX_CHARS,
	CONTEXT_FILE_PREFIX_BYTES,
	loadProvidedContext,
	MAX_CONTEXT_FILES,
	readContextFileSafely,
	registerOrchestrateCommand,
	type OrchestrateDeps,
} from "./orchestrate.ts";
import { contextFileLabel, CONTEXT_SOURCE_MAX_CHARS, formatContextSource } from "../core/context.ts";
import { RunRegistry } from "../run/context.ts";
import type { RunSession } from "../run/session.ts";
import type { Adapter, FullResolution } from "../adapters/adapter-resolver.ts";

/** Captures the handler `registerOrchestrateCommand` registers, without a real HT runtime. */
function fakePi(): { pi: ExtensionAPI; getHandler: () => (args: string, ctx: ExtensionContext) => Promise<void> } {
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			handler = def.handler;
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	return { pi, getHandler: () => handler! };
}

function fakeCtx(sessionEntries: unknown[] = []): { ctx: ExtensionContext; notifications: Array<{ text: string; level: string }> } {
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (text: string, level: string) => { notifications.push({ text, level }); },
			confirm: () => Promise.resolve(true),
		},
		sessionManager: {
			getEntries: () => sessionEntries,
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications };
}

function fakeAdapter(): Adapter {
	return { implementation_fast: { model: "p/fast" }, lead: { model: "p/lead" }, worker: { model: "p/worker" } };
}

/** A resolution whose `profiles.problems` is non-empty: `registerOrchestrateCommand`'s handler
 *  notifies "Model configuration is invalid" and returns right after `resolveAdapter`, well
 *  before a session/run is created \u2014 a deterministic, side-effect-free stopping point for
 *  asserting the handler got PAST the C6/C7 pre-triage checks. */
function shortCircuitingResolution(adapter: Adapter): FullResolution {
	return {
		adapter,
		sources: Object.fromEntries(Object.keys(adapter).map((k) => [k, "fallback"])) as FullResolution["sources"],
		specs: {},
		warnings: [],
		notes: [],
		profileName: "test-profile",
		profiles: { active_profile: "test-profile", profiles: {}, problems: ["boom: forced stop for test"], notes: [] } as unknown as FullResolution["profiles"],
		table: null as unknown as FullResolution["table"],
		preference: [],
	};
}

function baseDeps(overrides: Partial<OrchestrateDeps> = {}): { deps: OrchestrateDeps; calls: { resolveAdapter: number; dispatchParallel: number; createSession: number } } {
	const calls = { resolveAdapter: 0, dispatchParallel: 0, createSession: 0 };
	const adapter = fakeAdapter();
	const deps: OrchestrateDeps = {
		runRegistry: new RunRegistry<RunSession>(),
		resolveAdapter: async () => { calls.resolveAdapter++; return shortCircuitingResolution(adapter); },
		createSession: () => { calls.createSession++; throw new Error("createSession should not be reached in these tests"); },
		triageTask: async () => null,
		planRun: async () => { throw new Error("planRun not stubbed"); },
		recordEvent: () => {},
		recordOutcome: () => {},
		captureDispatchCost: async () => {},
		dispatchParallel: async () => { calls.dispatchParallel++; return []; },
		completeRun: async () => ({ ok: true, batches: 0, acknowledged: 0, failed: 0, derivedStale: 0 }),
		failRun: async () => ({ ok: true, batches: 0, acknowledged: 0, failed: 0, derivedStale: 0 }),
		maxLeads: 4,
		reconEvidenceMaxChars: 4000,
		stateRoot: "/tmp/state",
		profilesPath: "/tmp/profiles.json",
		...overrides,
	};
	return { deps, calls };
}

describe("commands/orchestrate.ts C7: goals that refer to missing context", () => {
	test("a flagged goal with no --context/--with-last-reply/--force stops before triage; nothing is dispatched", async () => {
		const { pi, getHandler } = fakePi();
		const { deps, calls } = baseDeps();
		registerOrchestrateCommand(pi, deps);
		const { ctx, notifications } = fakeCtx();

		await getHandler()("do A then C then B", ctx);

		expect(calls.resolveAdapter).toBe(0);
		expect(calls.dispatchParallel).toBe(0);
		expect(calls.createSession).toBe(0);
		expect(notifications.some((n) => n.text.includes("--context") && n.text.includes("--with-last-reply") && n.text.includes("--force"))).toBe(true);
	});

	test("--force proceeds past the check", async () => {
		const { pi, getHandler } = fakePi();
		const { deps, calls } = baseDeps();
		registerOrchestrateCommand(pi, deps);
		const { ctx, notifications } = fakeCtx();

		await getHandler()("do A then C then B --force", ctx);

		expect(calls.resolveAdapter).toBe(1);
		expect(notifications.some((n) => n.text.includes("Model configuration is invalid"))).toBe(true);
		expect(notifications.some((n) => n.text.includes("Attach it with --context"))).toBe(false);
	});

	test("--context proceeds past the check", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-c6-"));
		const file = join(dir, "notes.md");
		writeFileSync(file, "some notes");
		try {
			const { pi, getHandler } = fakePi();
			const { deps, calls } = baseDeps();
			registerOrchestrateCommand(pi, deps);
			const { ctx, notifications } = fakeCtx();

			await getHandler()(`--context ${file} do A then C then B`, ctx);

			expect(calls.resolveAdapter).toBe(1);
			expect(notifications.some((n) => n.text.includes("Model configuration is invalid"))).toBe(true);
			expect(notifications.some((n) => n.text.includes("Attach it with --context"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a plain, unflagged goal is not stopped", async () => {
		const { pi, getHandler } = fakePi();
		const { deps, calls } = baseDeps();
		registerOrchestrateCommand(pi, deps);
		const { ctx, notifications } = fakeCtx();

		await getHandler()("fix the login race condition in the auth module", ctx);

		expect(calls.resolveAdapter).toBe(1);
		expect(notifications.some((n) => n.text.includes("Attach it with --context"))).toBe(false);
	});
});

describe("commands/orchestrate.ts C6: --context / --with-last-reply", () => {
	test("a missing --context file stops before triage with a clear message; no run is started", async () => {
		const { pi, getHandler } = fakePi();
		const { deps, calls } = baseDeps();
		registerOrchestrateCommand(pi, deps);
		const { ctx, notifications } = fakeCtx();

		await getHandler()("--context /nonexistent/path/does-not-exist.md fix the login bug", ctx);

		expect(calls.resolveAdapter).toBe(0);
		expect(calls.dispatchParallel).toBe(0);
		expect(calls.createSession).toBe(0);
		expect(notifications.some((n) => n.level === "error" && n.text.includes("--context") && n.text.includes("could not read"))).toBe(true);
	});

	test("--with-last-reply with no assistant message in the session stops with a clear message", async () => {
		const { pi, getHandler } = fakePi();
		const { deps, calls } = baseDeps();
		registerOrchestrateCommand(pi, deps);
		const { ctx, notifications } = fakeCtx([]);

		await getHandler()("--with-last-reply fix the login bug", ctx);

		expect(calls.resolveAdapter).toBe(0);
		expect(notifications.some((n) => n.level === "error" && n.text.includes("--with-last-reply") && n.text.includes("no assistant message"))).toBe(true);
	});

	test("--with-last-reply with an assistant message present proceeds past the check", async () => {
		const { pi, getHandler } = fakePi();
		const { deps, calls } = baseDeps();
		registerOrchestrateCommand(pi, deps);
		const { ctx, notifications } = fakeCtx([
			{ type: "message", message: { role: "assistant", content: "here is the plan we discussed" } },
		]);

		await getHandler()("--with-last-reply fix the login bug", ctx);

		expect(calls.resolveAdapter).toBe(1);
		expect(notifications.some((n) => n.text.includes("no assistant message"))).toBe(false);
	});
});

describe("commands/orchestrate.ts readContextFileSafely / loadProvidedContext (docs/architecture-review.md C6 hardening)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "orch-c6-hardening-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fakeCtxNoLastReply(): ExtensionContext {
		return { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
	}

	test("a symlinked file is rejected, naming the target", () => {
		const real = join(dir, "real.md");
		writeFileSync(real, "the real content");
		const link = join(dir, "link.md");
		symlinkSync(real, link);

		expect(() => readContextFileSafely(link, dir)).toThrow(/is a symlink/);
	});

	test("a file reached through a symlinked parent directory is rejected", () => {
		const realDir = join(dir, "real-dir");
		mkdirSync(realDir);
		const target = join(realDir, "notes.md");
		writeFileSync(target, "notes");
		const linkedDir = join(dir, "linked-dir");
		symlinkSync(realDir, linkedDir);

		expect(() => readContextFileSafely(join(linkedDir, "notes.md"), dir)).toThrow(/containing directory is a symlink/);
	});

	test("a symlinked GRANDPARENT directory (two levels above the file) is rejected, not just the immediate parent", () => {
		// dir/real/b/file.txt is real; dir/link-a -> dir/real is a symlink. Reached as
		// dir/link-a/b/file.txt, the file's immediate parent ("b") is an ordinary directory --
		// only the grandparent ("link-a") is a symlink. The old immediate-parent-only lstat would
		// have missed this entirely.
		const real = join(dir, "real");
		mkdirSync(join(real, "b"), { recursive: true });
		writeFileSync(join(real, "b", "file.txt"), "content");
		const linkA = join(dir, "link-a");
		symlinkSync(real, linkA);

		expect(() => readContextFileSafely(join(linkA, "b", "file.txt"), dir)).toThrow(/symlink/);
	});

	test("a symlinked GREAT-GRANDPARENT directory (three levels above the file) is rejected", () => {
		const real = join(dir, "real2");
		mkdirSync(join(real, "b", "c"), { recursive: true });
		writeFileSync(join(real, "b", "c", "file.txt"), "content");
		const linkA = join(dir, "link-a2");
		symlinkSync(real, linkA);

		expect(() => readContextFileSafely(join(linkA, "b", "c", "file.txt"), dir)).toThrow(/symlink/);
	});

	test("both a symlinked parent AND a symlinked leaf in the same path are still rejected (not just the first one checked)", () => {
		const mid = join(dir, "mid");
		mkdirSync(mid);
		const realLeafTarget = join(dir, "real-leaf-target.txt");
		writeFileSync(realLeafTarget, "leaf content");
		const leafLink = join(mid, "leaf-link.txt");
		symlinkSync(realLeafTarget, leafLink);
		const linkToMid = join(dir, "link-to-mid");
		symlinkSync(mid, linkToMid);

		expect(() => readContextFileSafely(join(linkToMid, "leaf-link.txt"), dir)).toThrow(/symlink/);
	});

	test("an ordinary file nested several directories deep under a /tmp-based cwd is accepted (macOS /tmp -> /private/tmp must not be mistaken for a symlink attack)", () => {
		const nested = join(dir, "sub", "deep", "path");
		mkdirSync(nested, { recursive: true });
		const file = join(nested, "notes.md");
		writeFileSync(file, "nested notes");

		const { content } = readContextFileSafely(file, dir);
		expect(content).toBe("nested notes");
	});

	test("a file outside cwd, under its own real (non-symlinked) directory, is accepted via the top-level-component anchor", () => {
		const otherDir = mkdtempSync(join(tmpdir(), "orch-c6-outside-"));
		try {
			const file = join(otherDir, "notes.md");
			writeFileSync(file, "outside content");

			const { content } = readContextFileSafely(file, dir);
			expect(content).toBe("outside content");
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	test("a file under the real home directory is accepted (the cwd-outside, home-inside anchor branch)", () => {
		const homeTmp = mkdtempSync(join(homedir(), ".orch-c6-home-"));
		try {
			const file = join(homeTmp, "notes.md");
			writeFileSync(file, "home content");

			const { content } = readContextFileSafely(file, dir);
			expect(content).toBe("home content");
		} finally {
			rmSync(homeTmp, { recursive: true, force: true });
		}
	});

	test("a FIFO is rejected instead of hanging", () => {
		const fifo = join(dir, "pipe");
		const mkfifo = Bun.spawnSync(["mkfifo", fifo]);
		if (mkfifo.exitCode !== 0) {
			console.warn("mkfifo not available on this platform; skipping FIFO test");
			return;
		}

		expect(() => readContextFileSafely(fifo, dir)).toThrow(/is a FIFO/);
	});

	test("a directory is rejected", () => {
		const sub = join(dir, "a-directory");
		mkdirSync(sub);

		expect(() => readContextFileSafely(sub, dir)).toThrow(/is a directory/);
	});

	test("binary content (a NUL byte) is rejected", () => {
		const bin = join(dir, "binary.dat");
		writeFileSync(bin, Buffer.from([0x48, 0x49, 0x00, 0x42, 0x59, 0x45]));

		expect(() => readContextFileSafely(bin, dir)).toThrow(/binary content/);
	});

	test("content that is not valid UTF-8 is rejected", () => {
		const bad = join(dir, "invalid-utf8.txt");
		// 0xC3 alone (no continuation byte) is not valid UTF-8, and contains no NUL byte.
		writeFileSync(bad, Buffer.from([0x41, 0x42, 0xc3]));

		expect(() => readContextFileSafely(bad, dir)).toThrow(/not valid UTF-8/);
	});

	test("a huge file (over the per-file prefix cap) is only read up to the prefix, with a truncation note", () => {
		const huge = join(dir, "huge.txt");
		writeFileSync(huge, "x".repeat(1024 * 1024)); // 1 MB, well over CONTEXT_FILE_PREFIX_BYTES (160,000 bytes)

		const { content, truncatedOnDisk } = readContextFileSafely(huge, dir);
		expect(truncatedOnDisk).toBe(true);
		expect(content.length).toBe(4 * 40_000);
	});

	test("the disk-truncation note for a file over the per-file read limit is visible in the final rendered block, not swallowed by the per-source cap (docs/architecture-review.md C6)", () => {
		const huge = join(dir, "huge2.txt");
		writeFileSync(huge, "y".repeat(CONTEXT_FILE_PREFIX_BYTES + 50_000)); // > 160,000 bytes on disk

		const result = loadProvidedContext(dir, [huge], false, fakeCtxNoLastReply());
		expect("block" in result).toBe(true);
		if (!("block" in result)) return;
		expect(result.block).toContain(`${CONTEXT_FILE_PREFIX_BYTES}-byte read limit`);
	});

	test("a single source under both the per-file and aggregate caps is included verbatim, with no truncation note", () => {
		const p = join(dir, "small.md");
		writeFileSync(p, "small content");

		const result = loadProvidedContext(dir, [p], false, fakeCtxNoLastReply());
		expect("block" in result).toBe(true);
		if (!("block" in result)) return;
		expect(result.block).toContain("small content");
		expect(result.block).not.toContain("truncated");
		expect(result.block).not.toContain("omitted");
	});

	test("aggregate budget: several --context files that individually fit under the per-file cap still get bounded once their combined RENDERED size exceeds CONTEXT_AGGREGATE_MAX_CHARS, with exactly one collapsed omission notice", () => {
		const perFile = 35_000;
		const names = ["a.md", "b.md", "c.md", "d.md", "e.md"];
		const files = names.map((name) => {
			const p = join(dir, name);
			writeFileSync(p, "\u2022".repeat(perFile));
			return p;
		});

		const perSourceRendered = formatContextSource({
			label: contextFileLabel(dir, files[0]),
			content: "\u2022".repeat(perFile),
		}).length;
		const includedCount = Math.floor(CONTEXT_AGGREGATE_MAX_CHARS / perSourceRendered);
		expect(includedCount).toBeGreaterThan(0);
		expect(includedCount).toBeLessThan(names.length);

		const result = loadProvidedContext(dir, files, false, fakeCtxNoLastReply());
		expect("block" in result).toBe(true);
		if (!("block" in result)) return;
		expect(result.block.length).toBeLessThanOrEqual(CONTEXT_AGGREGATE_MAX_CHARS);
		const sections = result.block.split("\n\n---\n\n");
		expect(sections).toHaveLength(includedCount + 1);
		for (const section of sections.slice(0, includedCount)) {
			expect(section.match(/\u2022+/)?.[0].length).toBe(perFile);
		}
		expect(sections[includedCount]).toContain(`${names.length - includedCount} further attachment`);
		expect(result.block).not.toContain("truncated");
	});

	test("16 large attachments: the rendered block never balloons past the aggregate budget plus one collapsed notice", () => {
		const names = Array.from({ length: 16 }, (_, i) => `f${i}.md`);
		const files = names.map((name) => {
			const p = join(dir, name);
			writeFileSync(p, "z".repeat(CONTEXT_SOURCE_MAX_CHARS));
			return p;
		});

		const result = loadProvidedContext(dir, files, false, fakeCtxNoLastReply());
		expect("block" in result).toBe(true);
		if (!("block" in result)) return;
		expect(result.block.length).toBeLessThanOrEqual(CONTEXT_AGGREGATE_MAX_CHARS);
		const omittedMatch = result.block.match(/(\d+) further attachment/);
		expect(omittedMatch).not.toBeNull();
		const omittedCount = Number(omittedMatch![1]);
		expect(omittedCount).toBeGreaterThan(0);
		const includedHeadings = result.block.match(/^### file: f\d+\.md$/gm) ?? [];
		expect(includedHeadings.length + omittedCount).toBe(16);
		expect(result.block.match(/\d+ further attachment/g)?.length).toBe(1);
	});

	test("boundary: four sources sized to nearly fill the aggregate budget still produce a final block <= CONTEXT_AGGREGATE_MAX_CHARS", () => {
		// Four files, each just under 1/4 of the aggregate budget once rendered, so all four fit the
		// per-source sum of raw rendered lengths (<= CONTEXT_AGGREGATE_MAX_CHARS) while the header,
		// three separators, and the omission-notice reservation still have to be squeezed inside the
		// same 160_000-character ceiling — the case most likely to overshoot if assembly overhead is
		// not reserved inside the budget (docs/architecture-review.md C6).
		const perFileContentChars = 39_900;
		const names = ["a.md", "b.md", "c.md", "d.md"];
		const files = names.map((name) => {
			const p = join(dir, name);
			writeFileSync(p, "x".repeat(perFileContentChars));
			return p;
		});

		const result = loadProvidedContext(dir, files, false, fakeCtxNoLastReply());
		expect("block" in result).toBe(true);
		if (!("block" in result)) return;
		expect(result.block.length).toBeLessThanOrEqual(CONTEXT_AGGREGATE_MAX_CHARS);
	});

	test("more than MAX_CONTEXT_FILES attachments is a clear error before any file is opened (a count cap, independent of the aggregate character budget)", () => {
		const files = Array.from({ length: 1000 }, (_, i) => join(dir, `does-not-exist-${i}.md`));

		const result = loadProvidedContext(dir, files, false, fakeCtxNoLastReply());
		expect("error" in result).toBe(true);
		if (!("error" in result)) return;
		expect(result.error).toContain(String(MAX_CONTEXT_FILES));
		expect(result.error).not.toContain("could not read");
	});
});

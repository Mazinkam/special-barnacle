import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";

import {
	CONTEXT_AGGREGATE_MAX_CHARS,
	loadProvidedContext,
	readContextFileSafely,
	registerOrchestrateCommand,
	type OrchestrateDeps,
} from "./orchestrate.ts";
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

		expect(() => readContextFileSafely(link)).toThrow(/is a symlink/);
	});

	test("a file reached through a symlinked parent directory is rejected", () => {
		const realDir = join(dir, "real-dir");
		mkdirSync(realDir);
		const target = join(realDir, "notes.md");
		writeFileSync(target, "notes");
		const linkedDir = join(dir, "linked-dir");
		symlinkSync(realDir, linkedDir);

		expect(() => readContextFileSafely(join(linkedDir, "notes.md"))).toThrow(/containing directory is a symlink/);
	});

	test("a FIFO is rejected instead of hanging", () => {
		const fifo = join(dir, "pipe");
		const mkfifo = Bun.spawnSync(["mkfifo", fifo]);
		if (mkfifo.exitCode !== 0) {
			console.warn("mkfifo not available on this platform; skipping FIFO test");
			return;
		}

		expect(() => readContextFileSafely(fifo)).toThrow(/is a FIFO/);
	});

	test("a directory is rejected", () => {
		const sub = join(dir, "a-directory");
		mkdirSync(sub);

		expect(() => readContextFileSafely(sub)).toThrow(/is a directory/);
	});

	test("binary content (a NUL byte) is rejected", () => {
		const bin = join(dir, "binary.dat");
		writeFileSync(bin, Buffer.from([0x48, 0x49, 0x00, 0x42, 0x59, 0x45]));

		expect(() => readContextFileSafely(bin)).toThrow(/binary content/);
	});

	test("content that is not valid UTF-8 is rejected", () => {
		const bad = join(dir, "invalid-utf8.txt");
		// 0xC3 alone (no continuation byte) is not valid UTF-8, and contains no NUL byte.
		writeFileSync(bad, Buffer.from([0x41, 0x42, 0xc3]));

		expect(() => readContextFileSafely(bad)).toThrow(/not valid UTF-8/);
	});

	test("a huge file (over the per-file prefix cap) is only read up to the prefix, with a truncation note", () => {
		const huge = join(dir, "huge.txt");
		writeFileSync(huge, "x".repeat(1024 * 1024)); // 1 MB, well over CONTEXT_FILE_PREFIX_BYTES (160,000 bytes)

		const { content, truncatedOnDisk } = readContextFileSafely(huge);
		expect(truncatedOnDisk).toBe(true);
		expect(content.length).toBe(4 * 40_000);
	});

	test("aggregate budget: several --context files that individually fit under the per-file cap still get truncated once their combined size exceeds CONTEXT_AGGREGATE_MAX_CHARS", () => {
		// Each file is comfortably under both the per-file prefix cap (160,000 bytes) and the
		// per-source formatting cap (CONTEXT_SOURCE_MAX_CHARS = 40,000 characters), but five of
		// them together (175,000) exceed the 160,000-character aggregate budget.
		// A non-ASCII filler that cannot collide with anything else in the block (random
		// tmpdir path components, note wording, labels): unambiguous to count.
		const perFile = 35_000;
		const files = ["a.md", "b.md", "c.md", "d.md", "e.md"].map((name) => {
			const p = join(dir, name);
			writeFileSync(p, "\u2022".repeat(perFile));
			return p;
		});

		const result = loadProvidedContext(dir, files, false, fakeCtxNoLastReply());
		expect("block" in result).toBe(true);
		if (!("block" in result)) return;
		expect(result.block).toContain("aggregate --context/--with-last-reply budget");
		const sections = result.block.split("\n\n---\n\n");
		expect(sections).toHaveLength(5);
		// The first four sources are unaffected; the fifth's filler run is shorter than what was
		// written to disk \u2014 the aggregate budget, not just the (much larger) per-file cap, is
		// what cut it short.
		for (const section of sections.slice(0, 4)) {
			expect(section.match(/\u2022+/)?.[0].length).toBe(perFile);
		}
		const lastRun = sections[4].match(/\u2022+/)?.[0] ?? "";
		expect(lastRun.length).toBeLessThan(perFile);
		expect(lastRun.length).toBe(CONTEXT_AGGREGATE_MAX_CHARS - 4 * perFile);
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
});

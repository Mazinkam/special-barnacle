import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@humain/terminal";

import { registerOrchestrateCommand, type OrchestrateDeps } from "./orchestrate.ts";
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

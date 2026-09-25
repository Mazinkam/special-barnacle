/**
 * `/orchestrator-models check` / `validate --live` (B4.6): one cheap probe
 * per distinct configured model, through the exact spawn path `/orchestrate`
 * uses (same --provider/--model split, same env). Proves auth + routing and
 * that the model that answered is the one the table names — an
 * unauthenticated provider or wrong-region alias fails here for cents
 * instead of mid-run for dollars. Judged on "the model answered as itself",
 * not on reply text: personas rewrite replies into report formats.
 *
 * commands/* must not import index.ts. `runRegistry`/`createSession`/
 * `runSubagentProcess`/`maxConcurrentDispatches` are required fields on
 * `deps`; index.ts's caller supplies its own real ones.
 */
import type { ExtensionContext } from "@humain/terminal";

import { NO_PERSONA, type DispatchSession, type runSubagentProcess } from "../dispatch/child-process.ts";
import { mapWithConcurrency } from "../dispatch/parallel.ts";
import { summarizeStderr } from "../dispatch/stderr-sink.ts";
import { shortName, type ResolvedAdapter } from "../models.ts";
import { fmtElapsed } from "../run-ui.ts";
import type { RunRegistry } from "../run/context.ts";

/** The slice of `RunSession` `checkModels` needs, on top of what a dispatch itself needs (`DispatchSession`). */
export interface CheckModelsSession extends DispatchSession {
	setPhase(phase: string, notify?: boolean): void;
	file(name: string): string;
	close(): void;
	sealDiagnostics(): Promise<boolean>;
	finish(): void;
}

/** The seams `createCheckModels` needs; index.ts's caller supplies the real ones. */
export interface CheckModelsDeps<TSession extends CheckModelsSession> {
	runRegistry: RunRegistry<TSession>;
	createSession(runId: string, ctx: ExtensionContext, goal: string): TSession;
	runProcess: (
		opts: Omit<Parameters<typeof runSubagentProcess>[0], "env"> & { env?: () => NodeJS.ProcessEnv },
	) => ReturnType<typeof runSubagentProcess>;
	/** Hard ceiling on concurrent child processes (config.ts's `maxConcurrentDispatches`). */
	maxConcurrentDispatches: number;
}

export function createCheckModels<TSession extends CheckModelsSession>(
	deps: CheckModelsDeps<TSession>,
): (ctx: ExtensionContext, resolved: ResolvedAdapter) => Promise<boolean> {
	return async function checkModels(ctx: ExtensionContext, resolved: ResolvedAdapter): Promise<boolean> {
		const alreadyActive = deps.runRegistry.active();
		if (alreadyActive) {
			ctx.ui.notify(`An orchestration is already running (${alreadyActive.session.runId}); try again when it finishes.`, "warning");
			return false;
		}
		const byModel = new Map<string, string[]>();
		for (const [cap, b] of Object.entries(resolved.adapter)) {
			byModel.set(b.model, [...(byModel.get(b.model) ?? []), cap]);
		}
		const session = deps.createSession(`model-check-${Date.now()}`, ctx, "model check");
		// No await ran between the guard above and here, so nothing else could have
		// claimed the registry in between; claim() cannot fail. Kept as a real check
		// (not a `!` assertion) for symmetry with the /orchestrate handler's own
		// claim, and so this stays correct if that ever stops being true.
		const claimed = deps.runRegistry.claim(session);
		if (!claimed) {
			ctx.ui.notify(`An orchestration is already running (${deps.runRegistry.active()!.session.runId}); try again when it finishes.`, "warning");
			session.close();
			await session.sealDiagnostics();
			session.finish();
			return false;
		}
		session.setPhase(`probing ${byModel.size} distinct model(s)`);
		try {
			const probes = await mapWithConcurrency([...byModel.entries()], deps.maxConcurrentDispatches, async ([model, caps]) => {
				const r = await deps.runProcess({
					cwd: process.cwd(),
					agentName: NO_PERSONA,
					task: "Connectivity check. Reply with the single word OK.",
					model,
					tools: ["read"],
					ctx,
					taskId: `probe-${shortName(model)}`,
					label: shortName(model),
					session,
				});
				const replied = (r.finalText || r.stdout).trim();
				const expectedId = model.slice(model.indexOf("/") + 1);
				const servedBy = r.model;
				const idMatches =
					!servedBy || servedBy === expectedId || expectedId.endsWith(servedBy) || servedBy.endsWith(expectedId) || shortName(servedBy) === shortName(model);
				const ok = r.exitCode === 0 && replied.length > 0;
				return { model, caps, ok, idMatches, servedBy, replied, r };
			});

			const lines = probes.map((p) => {
				const mark = p.ok && p.idMatches ? "✓" : p.ok ? "⚠" : "✗";
				const detail = p.ok
					? p.idMatches
						? `${fmtElapsed(p.r.durationMs)}, $${p.r.costUsd.toFixed(4)}, served by ${p.servedBy ?? "(unreported)"}`
						: `answered, but served by ${p.servedBy} (expected ${p.model.slice(p.model.indexOf("/") + 1)})`
					: `exit ${p.r.exitCode}: ${summarizeStderr(p.r.stderr, 160) || "(no output)"}`;
				return [`${mark} ${p.model}`, `    ${detail}`, `    used by: ${p.caps.join(", ")}`].join("\n");
			});
			const failed = probes.filter((p) => !p.ok).length;
			const total = probes.reduce((s, p) => s + p.r.costUsd, 0);
			const summary = [
				`Live model check: ${probes.length - failed}/${probes.length} model(s) answered · $${total.toFixed(4)}`,
				...lines,
				...(failed > 0 ? ["", `Fix the failing binding(s) with /orchestrator-models set <capability|tier> <alias>, or pass --frontier/--premium/--mid/--cheap/--model; /orchestrate would abort on these.`] : []),
				`log: ${session.file("run.log")}`,
			];
			session.log(summary.join("\n"));
			ctx.ui.notify(summary.join("\n"), failed > 0 ? "error" : "info");
			return failed === 0;
		} finally {
			try {
				session.close();
				await session.sealDiagnostics(); // bounded drain; no terminal outcome means no seal
			} finally {
				deps.runRegistry.release(claimed);
				session.finish();
			}
		}
	};
}

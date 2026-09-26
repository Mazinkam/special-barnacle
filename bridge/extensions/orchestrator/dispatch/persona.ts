/**
 * Persona (orchestrator agent) resolution for a dispatch (B4.5 step 2 —
 * extracted from `runSubagentProcess` in index.ts).
 *
 * Resolves the orchestrator agent persona the same way the subagent tool
 * does: read the agent markdown from the runtime's agents/ directories and,
 * if it has a non-empty body, write it to a private temp file for
 * `--append-system-prompt` (there is NO `--agent` CLI flag; passing one makes
 * HT exit 1 with "Unknown option: --agent" before it ever contacts a
 * provider). fs access is behind injectable seams (`mkdtempFn`/`writeFileFn`)
 * so tests never touch the real filesystem's temp directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DiscoveredAgent {
	name: string;
	tools?: string[];
	systemPrompt: string;
}

export interface AgentDiscovery {
	agents: DiscoveredAgent[];
}

export interface ResolvePersonaOptions {
	cwd: string;
	agentName: string;
	/** Sentinel agent name that skips resolution entirely: probes run on the default system prompt on purpose. */
	noPersonaSentinel: string;
	discoverAgents: (cwd: string, mode: "both") => AgentDiscovery;
	/** Prefix for the persona's prompt-file temp dir, joined under `tmpdir()` by the default `mkdtempFn`. */
	tmpPrefix: string;
	/** Test seam: defaults to `mkdtempSync(join(tmpdir(), prefix))`. */
	mkdtempFn?: (prefix: string) => string;
	/** Test seam: defaults to `writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 })`. */
	writeFileFn?: (path: string, content: string) => void;
	/** Test seam: defaults to `console.warn`. */
	warn?: (message: string) => void;
}

export interface PersonaResolution {
	/** The persona's own tool allow-list, if the agent was found and declares one. */
	tools?: string[];
	/** Absolute path to the written system-prompt file, if the persona has a non-empty body. */
	promptPath?: string;
	/**
	 * Set when persona resolution threw (agent discovery or the prompt-file write). Callers must
	 * not silently proceed on this: log it to the session and surface it as a dispatch
	 * diagnostic — an agent that WAS found but whose prompt file failed to write otherwise runs
	 * on the default persona with no trace of why.
	 */
	error?: string;
	/** Remove the temp prompt-file dir this resolution created, if any. Idempotent; safe to call even when nothing was created. */
	cleanup: () => void;
}

const noopCleanup = (): void => {};

export function resolvePersona(opts: ResolvePersonaOptions): PersonaResolution {
	if (opts.agentName === opts.noPersonaSentinel) {
		/* probes run on the default system prompt on purpose */
		return { cleanup: noopCleanup };
	}

	const mkdtempFn = opts.mkdtempFn ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
	const writeFileFn = opts.writeFileFn ?? ((path: string, content: string) => writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 }));
	const warn = opts.warn ?? ((message: string) => console.warn(message));

	let tools: string[] | undefined;
	let promptDir: string | undefined;
	let promptPath: string | undefined;
	let error: string | undefined;
	try {
		const discovered = opts.discoverAgents(opts.cwd, "both");
		const agent = discovered.agents.find((a) => a.name === opts.agentName);
		if (agent) {
			tools = agent.tools;
			if (agent.systemPrompt.trim()) {
				promptDir = mkdtempFn(opts.tmpPrefix);
				const candidatePath = join(promptDir, `${opts.agentName}.md`);
				// Only trust `promptPath` once the write has actually succeeded — a
				// write failure used to still return this path, which the caller
				// then passed to `--append-system-prompt` pointing at a file that
				// was never created.
				writeFileFn(candidatePath, agent.systemPrompt);
				promptPath = candidatePath;
			}
		} else {
			warn(`[orchestrator] agent persona not found: ${opts.agentName} (using default persona)`);
		}
	} catch (err) {
		error = (err as Error).message;
		warn(`[orchestrator] agent persona load failed: ${error}`);
	}

	return {
		tools,
		promptPath,
		error,
		cleanup: () => {
			if (!promptDir) return;
			try {
				rmSync(promptDir, { recursive: true, force: true });
			} catch {
				/* best-effort temp cleanup */
			}
		},
	};
}

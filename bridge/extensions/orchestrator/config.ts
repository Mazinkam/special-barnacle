/**
 * All of this extension's `process.env` reads and `~` expansions, in one
 * place (B4.2). `loadBridgeConfig(env, home)` is called once, at module load,
 * from `index.ts`; every other module (including `core/*`) takes whatever it
 * needs as a parameter instead of reading `process.env` itself.
 *
 * Evaluated once and eagerly, matching the pre-B4.2 behaviour: index.ts's own
 * module-level consts were computed once at import time, and index.test.ts's
 * "runModule forwards STATE_ROOT..." test relies on exactly that — it mutates
 * `process.env.HUMAIN_ORCHESTRATOR_STATE_ROOT` and then does a cache-busting
 * dynamic re-`import()` of the whole module to pick up the new value, rather
 * than expecting a later call to observe it. Nothing here needs to be lazy.
 */

import { join } from "node:path";
import { METHOD } from "./models.ts";
import contract from "./contract.json";

export type BridgeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface BridgeConfig {
	/** `~`-unexpanded skill root, as configured (or the default). */
	skillRoot: string;
	/** `~`-unexpanded state root, as configured (or the default). */
	stateRoot: string;
	/** `skillRoot` with a leading `~` expanded to `home`. */
	expandedSkillRoot: string;
	/** `stateRoot` with a leading `~` expanded to `home`. */
	expandedStateRoot: string;
	python: string;
	/** Extra env every Python spawn gets on top of python-cli.ts's own builder. */
	pythonExtraEnv: {
		CODING_AGENT_RUNTIME: string;
		CODING_AGENT_REPOSITORY: string;
	};
	profilesPath: string;
	legacyAdapterPath: string;
	/** Wall clock for a single Python spawn; a hung Python must not hang a run's terminal path. */
	pythonTimeoutMs: number;
	/** Hard ceiling on concurrent child processes, independent of what a plan asks for. */
	maxConcurrentDispatches: number;
	/** Hard ceiling on lead fan-out, so a malformed topology can't spawn unbounded leads. */
	maxLeads: number;
	/** Per-dispatch wall clock for a LEAF dispatch that does its own work directly. */
	dispatchTimeoutMs: number;
	/** Telemetry batching window, in ms. */
	telemetryFlushMs: number;
	/** Telemetry batch size ceiling (well under Python's 500-record validation limit). */
	telemetryMaxBatch: number;
	/** Bounds the aggregate parent-owned recon evidence packet handed to every lead prompt. */
	reconEvidenceMaxChars: number;
}

/** `~`-expand a leading `~` in `path` to `home`; every other path is returned unchanged. */
export function expandHome(path: string, home: string): string {
	return path.replace(/^~/, home);
}

/**
 * Live, un-snapshotted `process.env` passthrough (B4.4 review fix). Every
 * other module — including `dispatch/*` and `index.ts`'s own
 * `orchestratorPythonCli()` and per-dispatch timeout-policy lookups — takes
 * env as an injected parameter/getter instead of naming `process.env`
 * itself; this is the one place that still does, so a child process's
 * inherited env and a dispatch's timeout policy both see the CURRENT
 * `process.env` at the moment they're read (not a value captured earlier),
 * matching the pre-B4.4 behaviour exactly.
 */
export function liveEnv(): NodeJS.ProcessEnv {
	return process.env;
}

function positiveIntEnv(env: BridgeEnv, name: string, fallback: number): number {
	const raw = Number(env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

export function loadBridgeConfig(env: BridgeEnv, home: string): BridgeConfig {
	const skillRoot = env.HUMAIN_ORCHESTRATOR_SKILL_ROOT ?? "~/.local/share/agent-skills/hierarchical-agent-orchestrator";
	const stateRoot = env[contract.state_root.env_vars.ts] ?? contract.state_root.default;
	const python = env.HUMAIN_ORCHESTRATOR_PYTHON ?? "python3";
	const expandedSkillRoot = expandHome(skillRoot, home);
	const expandedStateRoot = expandHome(stateRoot, home);
	const profilesPath = env.HUMAIN_ORCHESTRATOR_PROFILES_FILE ?? join(home, ".humain-terminal", "agent", "orchestrator-profiles.json");
	const legacyAdapterPath = env.HUMAIN_ORCHESTRATOR_ADAPTER_FILE ?? join(home, ".humain-terminal", "agent", "orchestrator-adapter.json");

	return {
		skillRoot,
		stateRoot,
		expandedSkillRoot,
		expandedStateRoot,
		python,
		pythonExtraEnv: {
			CODING_AGENT_RUNTIME: "humain-terminal",
			CODING_AGENT_REPOSITORY: env.CODING_AGENT_REPOSITORY ?? process.cwd(),
		},
		profilesPath,
		legacyAdapterPath,
		pythonTimeoutMs: positiveIntEnv(env, "HUMAIN_ORCHESTRATOR_PYTHON_TIMEOUT_MS", 60_000),
		maxConcurrentDispatches: positiveIntEnv(env, "HUMAIN_ORCHESTRATOR_MAX_CONCURRENCY", 4),
		maxLeads: positiveIntEnv(env, "HUMAIN_ORCHESTRATOR_MAX_LEADS", 8),
		dispatchTimeoutMs: positiveIntEnv(env, "HUMAIN_ORCHESTRATOR_DISPATCH_TIMEOUT_MS", 20 * 60 * 1000),
		telemetryFlushMs: positiveIntEnv(env, "HUMAIN_ORCHESTRATOR_TELEMETRY_FLUSH_MS", 500),
		telemetryMaxBatch: positiveIntEnv(env, "HUMAIN_ORCHESTRATOR_TELEMETRY_BATCH", 100),
		reconEvidenceMaxChars: positiveIntEnv(
			env,
			"HUMAIN_ORCHESTRATOR_RECON_EVIDENCE_MAX_CHARS",
			METHOD.rules.pre_implementation_recon.evidence_packet_max_tokens * CHARS_PER_TOKEN_ESTIMATE,
		),
	};
}

/**
 * Phase 3 — opt-in adapter that runs Forge's EXISTING live-QA runner (`bun qa run focused ...`,
 * see /Users/.../forge/scripts/qa) as a tracked verification stage. This module never invents
 * Forge CLI flags, never runs a shell string (argv is always spawned as argv[0] + args, shell:
 * false), never auto-discovers commands from the repository under test, and never activates
 * anything unless explicitly configured and requested — see index.ts for the `--live-qa` gate.
 *
 * Everything here is pure/testable: no dependency on the orchestrator's Python engine, its
 * record queue, or a live Forge checkout. index.ts wires this module's outputs into
 * recordModelCall/recordOutcome and the run summary.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Stats } from "node:fs";

// -----------------------------------------------------------------------------
// Config schema (v1)
// -----------------------------------------------------------------------------

export interface LiveQaAdapterConfig {
	id: string;
	kind: "forge-qa";
	trusted: true;
	runner_cwd: string;
	argv_prefix: string[];
	flow: "focused";
	slot?: 0 | 1;
	budget_minutes: number;
	runtime: "codex" | "humain-terminal" | "claude-code";
	model: string;
	effort: "low" | "medium" | "high" | "xhigh";
	local: true;
	required: boolean;
}

export interface LiveQaConfigProblem {
	adapter_id?: string;
	field?: string;
	reason: string;
}

export interface ParsedLiveQaConfig {
	adapters: LiveQaAdapterConfig[];
	problems: LiveQaConfigProblem[];
}

const TOP_LEVEL_KEYS = new Set(["version", "adapters"]);
const ADAPTER_KEYS = new Set([
	"id", "kind", "trusted", "runner_cwd", "argv_prefix", "flow", "slot",
	"budget_minutes", "runtime", "model", "effort", "local", "required",
]);

// Mirrors Forge's scripts/qa/cli.ts model-alias tables (MODELS at cli.ts:99, HUMAIN_NODE_MODELS
// at cli.ts:108, CLAUDE_CODE_MODELS just below) and the alias validation `parseArgs` performs at
// cli.ts:199-209 (including "Only the Terminal runtime can reach the HUMAIN Node provider"). If
// Forge renames or adds a model alias, this table drifts and MUST be updated to match — otherwise
// a valid Forge invocation is rejected here before it ever reaches Forge, or (worse) a value that
// Forge would reject is forwarded and only fails deep inside the runner.
const CODEX_MODEL_ALIASES = new Set(["luna", "terra", "astra", "sol"]);
const HUMAIN_NODE_MODEL_ALIASES = new Set(["m3", "m3preview", "glm", "glm52", "qwen"]);
const CLAUDE_CODE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);

function isValidModelForRuntime(runtime: LiveQaAdapterConfig["runtime"], model: string): boolean {
	if (runtime === "claude-code") return CLAUDE_CODE_MODEL_ALIASES.has(model);
	// HUMAIN Node models (cli.ts HUMAIN_NODE_MODELS) are reachable ONLY through the Terminal
	// runtime; the codex-alias table is also valid there (cli.ts: `isNode = ... Object.hasOwn(...)`,
	// falling back to `Object.hasOwn(MODELS, model)`).
	if (runtime === "humain-terminal") return CODEX_MODEL_ALIASES.has(model) || HUMAIN_NODE_MODEL_ALIASES.has(model);
	return CODEX_MODEL_ALIASES.has(model);
}

// Mirrors the credential-like argv element check used when validating argv_prefix: reject
// env-style `NAME=value` assignments and any element whose text plausibly names a secret. This
// closes an obvious leak surface (a credential typed directly into an adapter's argv_prefix by a
// human authoring the config) — it is not a substitute for redacting the runner's OWN output,
// which is handled separately in `runLiveQa`.
export const CREDENTIAL_LIKE_RE = /token|secret|password|api[_-]?key|bearer/i;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseAdapterEntry(
	entry: unknown,
	index: number,
): { adapter: LiveQaAdapterConfig | null; problems: LiveQaConfigProblem[] } {
	const problems: LiveQaConfigProblem[] = [];
	if (!isRecord(entry)) {
		problems.push({ reason: `adapters[${index}] must be an object` });
		return { adapter: null, problems };
	}
	const obj = entry;
	const id = typeof obj.id === "string" ? obj.id : undefined;

	for (const key of Object.keys(obj)) {
		if (!ADAPTER_KEYS.has(key)) {
			problems.push({ adapter_id: id, field: key, reason: `unknown adapter key "${key}"; adapter disabled` });
		}
	}
	const hasUnknownKey = Object.keys(obj).some((k) => !ADAPTER_KEYS.has(k));

	const idOk = typeof obj.id === "string" && /^[a-z0-9-]{1,40}$/.test(obj.id);
	if (!idOk) problems.push({ adapter_id: id, field: "id", reason: "id must match ^[a-z0-9-]{1,40}$" });

	const kindOk = obj.kind === "forge-qa";
	if (!kindOk) problems.push({ adapter_id: id, field: "kind", reason: 'kind must be "forge-qa"' });

	const trustedOk = obj.trusted === true;
	if (!trustedOk) problems.push({ adapter_id: id, field: "trusted", reason: "trusted must be literally true; adapter disabled" });

	const runnerCwdOk = typeof obj.runner_cwd === "string" && isAbsolute(obj.runner_cwd);
	if (!runnerCwdOk) problems.push({ adapter_id: id, field: "runner_cwd", reason: "runner_cwd must be an absolute path" });

	const argvOk = Array.isArray(obj.argv_prefix) && obj.argv_prefix.length > 0 &&
		obj.argv_prefix.every((v) => typeof v === "string" && v.length > 0 && !v.includes("\0") && !v.includes("\n")
			&& !v.includes("=") && !CREDENTIAL_LIKE_RE.test(v));
	if (!argvOk) {
		problems.push({
			adapter_id: id,
			field: "argv_prefix",
			reason: "argv_prefix must be a non-empty array of non-empty strings without NUL, newline, '=' " +
				"(env-style assignment), or a credential-like word (token/secret/password/api key/bearer)",
		});
	}

	const flowOk = obj.flow === "focused";
	if (!flowOk) problems.push({ adapter_id: id, field: "flow", reason: 'flow must be "focused" (the only flow this adapter supports)' });

	const slotOk = obj.slot === undefined || obj.slot === 0 || obj.slot === 1;
	if (!slotOk) problems.push({ adapter_id: id, field: "slot", reason: "slot must be 0 or 1 (or omitted to use Forge's own default)" });

	const budgetOk = typeof obj.budget_minutes === "number" && Number.isInteger(obj.budget_minutes) &&
		obj.budget_minutes >= 1 && obj.budget_minutes <= 240;
	if (!budgetOk) problems.push({ adapter_id: id, field: "budget_minutes", reason: "budget_minutes must be an integer 1..240" });

	const runtimeOk = obj.runtime === "codex" || obj.runtime === "humain-terminal" || obj.runtime === "claude-code";
	if (!runtimeOk) problems.push({ adapter_id: id, field: "runtime", reason: "runtime must be codex|humain-terminal|claude-code" });

	// Validated against Forge's own per-runtime model-alias tables (see CODEX_MODEL_ALIASES et al.
	// above, mirroring scripts/qa/cli.ts) rather than a permissive shape-only regex: an adapter
	// configured with an alias Forge would reject at its own `parseArgs` must fail HERE, at config
	// parse, not silently forward an invalid --model to the runner.
	const modelOk = runtimeOk && typeof obj.model === "string" &&
		isValidModelForRuntime(obj.runtime as LiveQaAdapterConfig["runtime"], obj.model);
	if (!modelOk) {
		problems.push({
			adapter_id: id,
			field: "model",
			reason: runtimeOk
				? `model must be a valid alias for runtime "${String(obj.runtime)}" (see Forge scripts/qa/cli.ts MODELS/HUMAIN_NODE_MODELS/CLAUDE_CODE_MODELS)`
				: "model cannot be validated because runtime is invalid",
		});
	}

	const effortOk = obj.effort === "low" || obj.effort === "medium" || obj.effort === "high" || obj.effort === "xhigh";
	if (!effortOk) problems.push({ adapter_id: id, field: "effort", reason: "effort must be low|medium|high|xhigh" });

	const localOk = obj.local === true;
	if (!localOk) problems.push({ adapter_id: id, field: "local", reason: "local must be literally true; this adapter never publishes to GitLab" });

	const requiredRaw = obj.required;
	const requiredOk = requiredRaw === undefined || typeof requiredRaw === "boolean";
	if (!requiredOk) problems.push({ adapter_id: id, field: "required", reason: "required must be a boolean" });

	const allOk = idOk && kindOk && trustedOk && runnerCwdOk && argvOk && flowOk && slotOk &&
		budgetOk && runtimeOk && modelOk && effortOk && localOk && requiredOk && !hasUnknownKey;
	if (!allOk) return { adapter: null, problems };

	return {
		adapter: {
			id: obj.id as string,
			kind: "forge-qa",
			trusted: true,
			runner_cwd: obj.runner_cwd as string,
			argv_prefix: obj.argv_prefix as string[],
			flow: "focused",
			...(obj.slot === undefined ? {} : { slot: obj.slot as 0 | 1 }),
			budget_minutes: obj.budget_minutes as number,
			runtime: obj.runtime as LiveQaAdapterConfig["runtime"],
			model: obj.model as string,
			effort: obj.effort as LiveQaAdapterConfig["effort"],
			local: true,
			required: requiredRaw === undefined ? true : (requiredRaw as boolean),
		},
		problems,
	};
}

/** Schema v1. Never throws: malformed input becomes `problems`, not an exception. */
export function parseLiveQaConfig(raw: unknown): ParsedLiveQaConfig {
	const problems: LiveQaConfigProblem[] = [];
	if (!isRecord(raw)) {
		problems.push({ reason: "config must be a JSON object" });
		return { adapters: [], problems };
	}
	const unknownTopLevelKeys = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
	for (const key of unknownTopLevelKeys) {
		problems.push({ field: key, reason: `unknown top-level key "${key}"` });
	}
	// An unknown top-level key rejects the WHOLE config, not just the offending key: a typo'd or
	// unrecognized key at this level (unlike an unknown per-adapter key, which only disables that
	// one adapter) most often signals a schema mismatch/version drift, and silently proceeding with
	// a partially-understood config is the wrong default for something that spawns real processes.
	if (unknownTopLevelKeys.length > 0) return { adapters: [], problems };
	if (raw.version !== 1) {
		problems.push({ field: "version", reason: "unsupported schema version (expected 1)" });
		return { adapters: [], problems };
	}
	if (!Array.isArray(raw.adapters)) {
		problems.push({ field: "adapters", reason: "adapters must be an array" });
		return { adapters: [], problems };
	}
	const adapters: LiveQaAdapterConfig[] = [];
	// Counted from EVERY entry's raw `id` field (any string, valid or not -- see below), never only
	// from `adapters` (the entries that fully validated): an otherwise-malformed entry (invalid
	// `trusted`/`runner_cwd`/model/etc.) that happens to reuse a VALID entry's `id` would otherwise
	// never be counted at all (it is never pushed into `adapters`), so the duplicate-id check below
	// would silently miss it and let the config load with exactly one "unambiguous" valid adapter --
	// even though the config on disk names that same id twice.
	const rawIds: string[] = [];
	raw.adapters.forEach((entry, index) => {
		if (isRecord(entry) && typeof entry.id === "string") rawIds.push(entry.id);
		const result = parseAdapterEntry(entry, index);
		if (result.adapter) adapters.push(result.adapter);
		problems.push(...result.problems);
	});
	// Duplicate adapter ids make selection ambiguous: `runLiveQaStage`'s own `--live-qa-adapter <id>`
	// lookup (`config.adapters.find((a) => a.id === request.adapterId)`) would silently bind to
	// whichever entry happens to come first, and a config with exactly one duplicated id would even
	// look unambiguous to the "exactly one adapter" auto-select path. Fails the WHOLE config closed
	// (same posture as an unknown top-level key above) rather than silently keeping one of the two.
	const idCounts = new Map<string, number>();
	for (const id of rawIds) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
	const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
	if (duplicateIds.length > 0) {
		for (const id of duplicateIds) {
			problems.push({ adapter_id: id, field: "id", reason: `duplicate adapter id "${id}"; adapter ids must be unique` });
		}
		return { adapters: [], problems };
	}
	return { adapters, problems };
}

/**
 * Reads the adapter config named by `HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG`. Absent env var means
 * "not configured" — never auto-discovers a config file or commands from the repository under
 * test. Never throws.
 */
export function loadLiveQaConfig(env: Record<string, string | undefined>): ParsedLiveQaConfig {
	const path = env.HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG;
	if (!path) return { adapters: [], problems: [{ reason: "not configured (HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG unset)" }] };
	// A relative path resolves against whatever the current working directory happens to be at
	// read time -- which this module never trusts (the candidate repository under test, a lead's
	// own cwd, etc. -- none of it is a directory this config's own location should ever depend
	// on). Required absolute so the config path's meaning is fixed regardless of caller cwd.
	if (!isAbsolute(path)) {
		return {
			adapters: [],
			problems: [{ reason: `HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG must be an absolute path (got "${path}")` }],
		};
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		return { adapters: [], problems: [{ reason: `could not read ${path}: ${(error as Error).message}` }] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { adapters: [], problems: [{ reason: `${path} is not valid JSON: ${(error as Error).message}` }] };
	}
	return parseLiveQaConfig(parsed);
}

// -----------------------------------------------------------------------------
// Scope validation and argv construction
// -----------------------------------------------------------------------------

export type ScopeValidation = { ok: true; scope: string } | { ok: false; reason: string };

/** The scope is user/lead-authored free text; it is passed as ONE argv element, never through a
 *  shell, so `$(...)`/`;`/quotes inside it are inert. The only injection surface this closes is
 *  a leading `-`, which a real argv parser (including Forge's) would read as a flag. */
export function validateScope(scope: unknown): ScopeValidation {
	if (typeof scope !== "string" || scope.length === 0) return { ok: false, reason: "scope is required" };
	if (scope.includes("\0")) return { ok: false, reason: "scope must not contain NUL bytes" };
	if (scope.includes("\n") || scope.includes("\r")) return { ok: false, reason: "scope must be a single line" };
	if (scope.length > 500) return { ok: false, reason: "scope must be at most 500 characters" };
	if (scope.startsWith("-")) return { ok: false, reason: "scope must not start with '-' (would be parsed as a flag)" };
	return { ok: true, scope };
}

/**
 * Exact argv for `bun qa run focused "<scope>" --slot N --ref <ref> --budget <min> --runtime
 * <runtime> --model <model> --effort <effort> --local`, per scripts/qa/cli.ts parseArgs. Always
 * executed as `spawn(argv[0], argv.slice(1), {cwd: runner_cwd, shell: false})` — never a shell
 * string, so `scope` is one argv element regardless of its contents.
 */
export function buildRunnerArgv(adapter: LiveQaAdapterConfig, scope: string, ref: string): string[] {
	return [
		...adapter.argv_prefix,
		"run",
		"focused",
		scope,
		...(adapter.slot === undefined ? [] : ["--slot", String(adapter.slot)]),
		"--ref", ref,
		"--budget", String(adapter.budget_minutes),
		"--runtime", adapter.runtime,
		"--model", adapter.model,
		"--effort", adapter.effort,
		"--local",
	];
}

// -----------------------------------------------------------------------------
// Tested-revision proof
// -----------------------------------------------------------------------------

export interface PreparedTestedRevision {
	ok: boolean;
	reason?: string;
	sha: string | null;
	tree: string | null;
	base_head: string | null;
	checkpoint: boolean;
	checkpoint_ref: string | null;
	/** false when the candidate repo's git common dir differs from the runner's — Forge cannot
	 *  exercise a component that lives in a different repository than the one it tests. */
	component_exercised: boolean;
	component_exercised_reason?: string;
}

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

// Every git invocation in this module runs against a repository whose hooks, filters,
// fsmonitor hook, attributes, and remote configuration CANNOT be trusted (the "candidate" is the
// repository a lead/worker just edited during this run; its `.git/hooks/*`, `.gitattributes`,
// and `.git/config` (`core.fsmonitor`, `filter.<name>.clean`, `remote.origin.*`,
// `core.sshCommand`, etc.) are attacker-reachable content). These `-c` overrides (command-line
// config always wins over repo-level `.git/config`) plus `GIT_CONFIG_NOSYSTEM=1` guarantee no
// repo-controlled hook, fsmonitor command, content filter, or NETWORK operation is ever invoked
// by any call this module makes: `core.hooksPath=/dev/null` makes every hook lookup miss,
// `core.fsmonitor=false` disables the fsmonitor hook/IPC entirely, `core.attributesFile=/dev/null`
// plus `--no-filters` on every `hash-object` call (never plain `git add`, which cannot be told to
// skip filters) keep `.gitattributes`-driven clean filters out of the loop altogether, and
// (S1b) `-c protocol.allow=never` plus the `GIT_NO_LAZY_FETCH=1`/`GIT_TERMINAL_PROMPT=0`
// environment variables below guarantee a repo configured as a partial-clone/promisor remote (a
// `remote.origin.promisor`/`extensions.partialClone` repo whose `core.sshCommand` or transport
// names an attacker-controlled command) can never lazily fetch a missing object, nor prompt for
// credentials, as a side effect of an ordinary read (`cat-file -e`, `rev-parse`, etc.) -- a
// missing object fails closed (unavailable), it is never fetched. Applied unconditionally to
// every call, including read-only ones, since `git status`/`read-tree`/`cat-file` also consult
// fsmonitor, attributes, and (for a partial clone) the promisor remote.
const HARDENED_GIT_ARGS = [
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.untrackedCache=false",
	"-c", "core.attributesFile=/dev/null",
	"-c", "protocol.allow=never",
];

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): GitResult {
	const r = spawnSync("git", [...HARDENED_GIT_ARGS, ...args], {
		cwd, encoding: "utf-8",
		// S1b: `GIT_NO_LAZY_FETCH=1` (belt-and-suspenders alongside `-c protocol.allow=never` above --
		// verified empirically to independently block a promisor remote's on-demand fetch of a missing
		// object) and `GIT_TERMINAL_PROMPT=0` (never block waiting on a credential prompt) are set
		// LAST so neither can be overridden by a caller-supplied `env`.
		env: { ...(env ?? process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
		timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
		...(input !== undefined ? { input } : {}),
	});
	return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Hardened `git rev-parse HEAD` (same no-hooks/no-fsmonitor/no-filters/no-network guarantees as
 *  every other git call in this module) for callers outside this module (`live-qa-stage.ts`) that
 *  need a repo's current HEAD sha without running an unhardened raw `git` call of their own.
 *  Never throws; `null` on any failure (not a git repo, git missing, no HEAD commit, etc.). */
export function gitRevParseHead(cwd: string): string | null {
	const r = git(cwd, ["rev-parse", "HEAD"]);
	if (r.status !== 0) return null;
	const sha = r.stdout.trim();
	return sha.length > 0 ? sha : null;
}

/**
 * THE AUTHORITATIVE guard (see also `repositoryFilterAttributesSafe` below, which is
 * defense-in-depth ONLY). A git content filter is a two-part mechanism: an ATTRIBUTE
 * (`.gitattributes`, itself repo-controlled content) that merely NAMES a driver, and a CONFIG
 * ENTRY (`filter.<name>.clean`/`.smudge`/`.process`) that supplies the actual command git will
 * run for that name. Naming a driver with no matching config entry is a no-op — git silently
 * skips filtering entirely when the driver name is unconfigured. The EXECUTABLE half of this
 * mechanism is therefore always the CONFIG, never the attribute value, and `git config` (a pure
 * read) executes nothing by itself, so this check is always safe to run before any
 * FILTER-CAPABLE git operation this module makes — including `repositoryFilterAttributesSafe`
 * below. (An earlier, purely informational `git rev-parse --git-common-dir` call in
 * `prepareTestedRevision` runs before this guard too, but that call is metadata-only — it can
 * never invoke a content filter — so it is not a filter-capable operation this guard needs to
 * precede.)
 *
 * This closes a bypass the attribute-value check alone cannot: `git check-attr`'s text output
 * cannot distinguish an attribute EXPLICITLY set to the literal string "false"/"unset"/
 * "unspecified" (`path filter=false`) from the corresponding BOOLEAN/negation keyword forms
 * (`-filter`/`!filter`/no mention at all) that produce the exact same text — so a path with
 * `filter=false` (or `=unset`/`=unspecified`) plus a LOCAL `filter.false.clean`/`filter.unset.
 * clean`/`filter.unspecified.clean` config entry would run that driver, and the old
 * value-string allow-list here let it through. Blocking on the CONFIG side makes the attribute
 * VALUE irrelevant: with no local/worktree-scope `filter.*` entry configured at all, no attribute
 * value of any kind can ever cause a driver to run, regardless of what path enumeration missed
 * (e.g. a `git rm --cached`-then-ignored file invisible to both `ls-files` and `ls-files
 * --others`, but still restored into the temporary index by `git read-tree HEAD` later).
 *
 * `local`/`worktree` scope (`.git/config` / `.git/config.worktree`) is repo-controlled — INCLUDING
 * a value pulled in transitively via an `include.path`/`includeIf.<cond>.path` directive written
 * in the local config: git attributes the reported scope of an included entry to the scope of
 * the config file that did the including, so a `.git/config` `[include] path = /anywhere` line
 * pointing at a file that defines `filter.x.clean` still reports scope `local` here (verified
 * empirically). `global`/`system`/`command` scope (an operator's own `~/.gitconfig` git-lfs
 * installation, or this module's own `-c` flags, none of which ever sets `filter.*`) is
 * operator-trusted and always allowed — `GIT_CONFIG_NOSYSTEM=1` (set on every call via `git()`)
 * already keeps `system` scope out of the picture, but this function checks explicitly for
 * `local`/`worktree` regardless, rather than depending on that env var alone.
 *
 * `-z` (NUL-delimited output): essential because a config VALUE can itself contain an embedded,
 * literal newline (a multi-line `filter.<name>.process` command). Without `-z`, verified
 * empirically against git 2.50, such a value's embedded newline is indistinguishable from a
 * record boundary, silently splitting one entry's value across multiple "lines" -- and one of
 * those trailing lines then has no scope prefix at all, which a naive newline/tab parser would
 * misread as belonging to whatever entry happened to precede it. See
 * `parseNulDelimitedShowScopeRecords` below for the exact `-z` record shape and why NUL, unlike
 * newline, can never appear inside a value.
 */
function repositoryFilterDriverConfigSafe(cwd: string): { ok: true } | { ok: false; reason: string } {
	const result = git(cwd, ["config", "-z", "--show-scope", "--get-regexp", "^filter\\."]);
	// `git config --get-regexp` exits 1 (not an error) when there are simply no matching entries.
	if (result.status !== 0 && result.status !== 1) {
		return { ok: false, reason: `git config -z --show-scope --get-regexp '^filter.' failed: ${result.stderr.trim()}` };
	}
	const scopes = parseNulDelimitedShowScopeRecords(result.stdout);
	if (scopes === null) {
		return {
			ok: false,
			reason: "git config -z --show-scope --get-regexp '^filter.' produced output this preflight could not parse; refusing checkpoint (fail closed) rather than risk missing a repository-local filter driver",
		};
	}
	for (const scope of scopes) {
		if (scope === "local" || scope === "worktree") {
			return {
				ok: false,
				reason: "repository-local git config defines filter drivers; refusing checkpoint to avoid executing repository-controlled commands",
			};
		}
	}
	return { ok: true };
}

/**
 * Parses `git config -z --show-scope --get-regexp`'s NUL-delimited output into the list of
 * per-entry scopes, or `null` if the output cannot be confidently parsed -- the caller fails
 * closed on `null` (never treats an unparseable stream as "no entries"). Verified empirically
 * against git 2.50: each entry is emitted as exactly `<scope>\0<key>\n<value>`, and the whole
 * stream is terminated by one final `\0`. Splitting on `\0` therefore yields an even-length
 * array alternating `scope`, `"key\nvalue"`, `scope`, `"key\nvalue"`, ..., plus one trailing
 * empty string from the final `\0`. A config VALUE may itself contain an embedded, literal
 * newline (e.g. a multi-line `filter.<name>.process` command), but a git config value can never
 * contain a NUL byte at all -- so `\0` is always exactly the per-ENTRY separator here, never
 * ambiguous with anything a value could contain, unlike `\n`.
 */
export function parseNulDelimitedShowScopeRecords(raw: string): string[] | null {
	if (raw.length === 0) return [];
	const parts = raw.split("\0");
	if (parts[parts.length - 1] !== "") return null;
	parts.pop();
	if (parts.length === 0 || parts.length % 2 !== 0) return null;
	const scopes: string[] = [];
	for (let i = 0; i < parts.length; i += 2) {
		const scope = parts[i];
		const keyAndValue = parts[i + 1];
		if (scope.length === 0 || keyAndValue.indexOf("\n") === -1) return null;
		scopes.push(scope);
	}
	return scopes;
}

/**
 * DEFENSE IN DEPTH ONLY — see `repositoryFilterDriverConfigSafe` above for the AUTHORITATIVE
 * guard, which must always run before any filter-capable git operation. Even a plain, read-only
 * `git status` can invoke a
 * repo-controlled "clean" filter on a TRACKED, modified path that carries a `filter=<driver>`
 * attribute -- git does this to get an accurate dirty/clean answer, and no `-c` override on the
 * command line can suppress a path-scoped `.gitattributes` entry the way
 * `core.attributesFile=/dev/null` suppresses the GLOBAL attributes file. `--no-filters` on our
 * own `hash-object` calls prevents THOSE calls from running the filter, but cannot retroactively
 * make an earlier `git status` safe.
 *
 * Checking only the caller-reported `changedFiles` (the previous approach) is not enough: a
 * dirty path git can see but the caller never reported (an untracked stray file, or a modified
 * tracked file the caller forgot to list) is just as capable of carrying a `filter=<driver>`
 * attribute, and `git status` walks EVERY such path, not merely the reported ones. The only
 * reliable guard is to enumerate every path git could possibly inspect content for -- tracked
 * (`git ls-files -z`, index-metadata only, never reads working-tree content), untracked-but-
 * not-ignored (`git ls-files -z --others --exclude-standard`), AND every path in `HEAD`'s tree
 * (`git ls-tree -r -z --name-only HEAD`) -- the last of these covers a file `git rm --cached`
 * removed from the index and whose path is now also `.gitignore`d: invisible to BOTH `ls-files`
 * calls above, yet still restored into the checkpoint's temporary index by `git read-tree HEAD`
 * later, where a subsequent `git status`/`hash-object` on it could invoke its filter -- and ask
 * `git check-attr` (which only ever answers an attribute LOOKUP; it never runs a filter or reads
 * blob content) for the `filter` attribute of every one of them, BEFORE any git operation that
 * could invoke one is run at all.
 *
 * The value comparison below is deliberately conservative (anything other than the literal text
 * "unspecified" fails closed) BECAUSE `check-attr`'s text output cannot distinguish a genuinely
 * unset attribute from one explicitly assigned that same literal string, or an attribute
 * negated via `-filter`/`!filter` from one explicitly assigned the literal string "false"/
 * "unset" — see `repositoryFilterDriverConfigSafe`'s doc comment for why this ambiguity makes
 * this function's value comparison NOT the authoritative control: whether anything can actually
 * execute is decided entirely by whether a matching `filter.<name>.clean`/`.smudge`/`.process`
 * config entry exists at local/worktree scope, checked separately (and first) above.
 */
function repositoryFilterAttributesSafe(cwd: string): { ok: true } | { ok: false; reason: string } {
	const tracked = git(cwd, ["ls-files", "-z"]);
	if (tracked.status !== 0) {
		return { ok: false, reason: `git ls-files -z failed while enumerating tracked paths: ${tracked.stderr.trim()}` };
	}
	const untracked = git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
	if (untracked.status !== 0) {
		return { ok: false, reason: `git ls-files -z --others --exclude-standard failed while enumerating untracked paths: ${untracked.stderr.trim()}` };
	}
	// `HEAD`'s tree may not resolve at all (unborn branch, no commits yet) -- that is not an error
	// worth failing the whole preflight over; it just means there is nothing this call can add
	// beyond what `ls-files`/`ls-files --others` already enumerated.
	const headTree = git(cwd, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]);
	const headTreePaths = headTree.status === 0 ? headTree.stdout.split("\0") : [];
	const paths = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0"), ...headTreePaths])]
		.filter((p) => p.length > 0);
	if (paths.length === 0) return { ok: true };
	const input = paths.map((p) => `${p}\0`).join("");
	const checked = git(cwd, ["check-attr", "--stdin", "-z", "filter"], undefined, input);
	if (checked.status !== 0) {
		return { ok: false, reason: `git check-attr --stdin -z filter failed while checking for repo-controlled filter attributes: ${checked.stderr.trim()}` };
	}
	const parts = checked.stdout.split("\0").filter((p) => p.length > 0);
	for (let i = 0; i + 2 < parts.length; i += 3) {
		const path = parts[i];
		const value = parts[i + 2];
		if (value !== "unspecified") {
			return {
				ok: false,
				reason: `${path} has a repo-controlled 'filter' attribute (${value}); repository declares git filter attributes; checkpoint refused to avoid executing repository-controlled filters`,
			};
		}
	}
	return { ok: true };
}

function gitCommonDirReal(cwd: string): string | null {
	const r = git(cwd, ["rev-parse", "--git-common-dir"]);
	if (r.status !== 0) return null;
	const raw = r.stdout.trim();
	// `--git-common-dir` returns an ABSOLUTE path when cwd is a linked worktree (this repo is
	// one), and a RELATIVE path (usually ".git") for a normal checkout. `path.join` does not
	// special-case an absolute second argument the way `path.resolve` does — it concatenates —
	// so joining an absolute common-dir onto cwd silently produces a nonexistent nested path.
	try {
		return realpathSync(isAbsolute(raw) ? raw : join(cwd, raw));
	} catch {
		return null;
	}
}

/** Resolves the git tree-entry MODE for `file` inside `sha`, via `git ls-tree` -- never trusted
 *  from `stat`/the working tree, which is exactly what `proveRevision` uses this to check
 *  AGAINST. `null` when the path has no entry in `sha` at all (an empty/unparseable `ls-tree`
 *  result, or the `git` invocation itself failing), which the caller must treat as "could not
 *  establish a type match" -- fail closed, never treated as an implicit pass. `-z` (NUL-
 *  delimited) avoids any ambiguity with a path containing characters `ls-tree`'s ordinary quoting
 *  would otherwise need to escape. */
function gitTreeEntryMode(cwd: string, sha: string, file: string): string | null {
	const r = git(cwd, ["ls-tree", "-z", sha, "--", file]);
	if (r.status !== 0) return null;
	const entry = r.stdout.split("\0").find((e) => e.length > 0);
	if (!entry) return null;
	const tabIdx = entry.indexOf("\t");
	if (tabIdx === -1) return null;
	const mode = entry.slice(0, tabIdx).split(" ")[0];
	return mode && mode.length > 0 ? mode : null;
}

/** Exported so tests can exercise it directly against an arbitrary sha (not merely `HEAD` or a
 *  freshly-minted checkpoint, both of which trivially match the working tree by construction) --
 *  see live-qa.test.ts's symlink-mismatch regression test. */
export function proveRevision(
	candidateCwd: string,
	runnerCwd: string,
	sha: string,
	changedFiles: string[],
): { ok: boolean; reason?: string } {
	// The runner resolves `--ref` inside ITS OWN checkout (scripts/qa/stack.ts calls
	// `git rev-parse --verify <ref>^{commit}` against repoRoot). If that checkout cannot see
	// this SHA (a separate clone, missing fetch, etc.) it is unavailable — never fall back to
	// main/HEAD of the runner, which would silently test the wrong tree.
	const catFile = git(runnerCwd, ["cat-file", "-e", `${sha}^{commit}`]);
	if (catFile.status !== 0) {
		return {
			ok: false,
			reason: `the runner repository at ${runnerCwd} cannot resolve tested revision ${sha} (git cat-file -e failed); a separate clone/checkout cannot see this commit`,
		};
	}
	for (const file of changedFiles) {
		const atSha = git(candidateCwd, ["rev-parse", `${sha}:${file}`]);
		let stat: ReturnType<typeof lstatSync> | null = null;
		try {
			stat = lstatSync(join(candidateCwd, file));
		} catch {
			stat = null;
		}
		if (!stat) {
			if (atSha.status === 0) return { ok: false, reason: `deleted file ${file} is still present in tested revision ${sha}` };
			continue;
		}
		if (stat.isSymbolicLink()) {
			// A symlink's tree-blob content is its target string (verbatim, no trailing newline --
			// matches what `buildCheckpointIndex` stores via `hash-object --stdin` fed `readlinkSync`'s
			// own output). Compared via `readlinkSync`, never by following the link and hashing
			// whatever it happens to point at.
			if (atSha.status !== 0) return { ok: false, reason: `changed symlink ${file} is missing from tested revision ${sha}` };
			// Content-only comparison is not enough: git's blob hashing is CONTENT-ADDRESSED, entirely
			// independent of the tree entry's own mode, so a REGULAR FILE (100644/100755) whose blob
			// content happens to equal this symlink's target text byte-for-byte would otherwise pass this
			// proof despite being a fundamentally different object type than what the working tree
			// actually has here -- checked via `git ls-tree` (never trusted from `stat`/working-tree state
			// alone, which is what this whole function exists to prove AGAINST).
			const mode = gitTreeEntryMode(candidateCwd, sha, file);
			if (mode !== "120000") {
				return {
					ok: false,
					reason: `tested revision entry for ${file} has mode ${mode ?? "(unknown)"} in ${sha}, not a symlink (120000), but the working tree has a symlink there; type mismatch, refusing to trust a content-only comparison`,
				};
			}
			let target: string;
			try {
				target = readlinkSync(join(candidateCwd, file));
			} catch (error) {
				return { ok: false, reason: `could not read symlink target for ${file}: ${(error as Error).message}` };
			}
			const treeBlob = git(candidateCwd, ["cat-file", "-p", `${sha}:${file}`]);
			if (treeBlob.status !== 0) return { ok: false, reason: `could not read tested revision blob for symlink ${file}` };
			if (treeBlob.stdout !== target) {
				return { ok: false, reason: `tested revision symlink target for ${file} does not match the working tree` };
			}
			continue;
		}
		if (!stat.isFile()) {
			// A changed path this proof cannot content-compare (a directory, submodule gitlink,
			// socket, FIFO, device, etc.) must never be silently treated as "proven" by skipping it --
			// fail closed instead of the previous `continue`, which let an unsupported changed path
			// through the proof entirely unchecked.
			return { ok: false, reason: `changed path ${file} is not a regular file or symlink (unsupported type); tested-revision proof cannot verify it` };
		}
		if (atSha.status !== 0) return { ok: false, reason: `changed file ${file} is missing from tested revision ${sha}` };
		// Same type-confusion guard as the symlink branch above, in the other direction: a blob's
		// content hash is independent of mode, so a SYMLINK (120000) tree entry whose target text
		// happens to equal this regular file's content byte-for-byte would otherwise pass the
		// hash-object comparison below despite being a fundamentally different object type.
		const mode = gitTreeEntryMode(candidateCwd, sha, file);
		if (mode !== "100644" && mode !== "100755") {
			return {
				ok: false,
				reason: `tested revision entry for ${file} has mode ${mode ?? "(unknown)"} in ${sha}, not a regular file (100644/100755), but the working tree has a regular file there; type mismatch, refusing to trust a content-only comparison`,
			};
		}
		// `--no-filters`: compares the RAW working-tree blob the checkpoint actually stored (also
		// hashed with `--no-filters`, see `buildCheckpointIndex`) against the tested revision's blob
		// — never a filter-transformed hash, which a repo-controlled `.gitattributes` clean filter
		// could otherwise make match anything.
		const hashed = git(candidateCwd, ["hash-object", "--no-filters", file]);
		if (hashed.status !== 0) return { ok: false, reason: `could not hash working-tree file ${file}` };
		if (atSha.stdout.trim() !== hashed.stdout.trim()) {
			return { ok: false, reason: `tested revision content for ${file} does not match the working tree` };
		}
	}
	return { ok: true };
}

/** Determines the git tree-entry mode for a checkpoint index entry from the working-tree file
 *  itself (never trusted from git status alone). `null` means an unsupported entry (directory/
 *  submodule/socket/etc.) that this checkpoint mechanism cannot represent -- the caller must fail
 *  closed rather than silently drop it. */
function checkpointEntryMode(fullPath: string): "100644" | "100755" | "120000" | null {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(fullPath);
	} catch {
		return null;
	}
	if (st.isSymbolicLink()) return "120000";
	if (st.isFile()) return (st.mode & 0o111) !== 0 ? "100755" : "100644";
	return null;
}

/**
 * Builds the checkpoint's temporary index entry-by-entry from the CALLER-SUPPLIED explicit
 * candidate file set (`changedFiles`, e.g. `index.ts`'s own `changedFilesSinceRunStart`) --
 * deliberately NEVER `git status`/`git add -A` (which would also pick up any OTHER dirty path in
 * the tree, tracked or untracked, that the caller never reported as part of this run's changes,
 * and which cannot be told to skip `.gitattributes` clean filters). Only the named paths are ever
 * touched: a file present in `changedFiles` is hashed straight from the working tree
 * (`git hash-object --no-filters -w` for a regular file, or `hash-object --no-filters -w -t blob
 * --stdin` fed the symlink target for a symlink) and added via `git update-index --add
 * --cacheinfo`; a file in `changedFiles` that no longer exists on disk is removed via
 * `update-index --force-remove` (a no-op, verified empirically, when the path was never in the
 * seeded-from-HEAD temp index to begin with -- e.g. a newly-added-then-deleted file). Every OTHER
 * path already present in the temp index (seeded from HEAD by the caller's `read-tree HEAD`) is
 * left exactly as HEAD has it: a concurrently-dirty file the caller did not report as changed, or
 * an unrelated untracked stray file (a `secrets.env` someone dropped in the working tree), is
 * therefore NEVER represented in the checkpoint tree even if `git status` would call it dirty --
 * the checkpoint tree is built entirely from `changedFiles` on top of the base HEAD tree, never
 * from "everything dirty git can see".
 */
function buildCheckpointIndex(candidateCwd: string, env: NodeJS.ProcessEnv, changedFiles: string[]): { ok: true } | { ok: false; reason: string } {
	const paths = [...new Set(changedFiles)];
	for (const path of paths) {
		if (path.length === 0 || path.includes("\0") || path.includes("\n")) {
			return { ok: false, reason: `checkpoint refused: candidate changed-file entry ${JSON.stringify(path)} is not a valid relative path` };
		}
		const fullPath = join(candidateCwd, path);
		let existsOnDisk: boolean;
		try {
			lstatSync(fullPath);
			existsOnDisk = true;
		} catch {
			existsOnDisk = false;
		}
		if (!existsOnDisk) {
			// Deleted (or never-existed) candidate path: remove it from the checkpoint's temp index
			// (seeded from HEAD). A no-op if it was never there in the first place.
			const rm = git(candidateCwd, ["update-index", "--force-remove", "--", path], env);
			if (rm.status !== 0) return { ok: false, reason: `git update-index --force-remove ${path} failed: ${rm.stderr.trim()}` };
			continue;
		}
		const mode = checkpointEntryMode(fullPath);
		if (mode === null) {
			return { ok: false, reason: `checkpoint cannot represent ${path} (not a regular file or symlink, or it vanished before hashing)` };
		}
		let sha: string;
		if (mode === "120000") {
			let target: string;
			try {
				target = readlinkSync(fullPath);
			} catch (error) {
				return { ok: false, reason: `could not read symlink target for ${path}: ${(error as Error).message}` };
			}
			const hashed = git(candidateCwd, ["hash-object", "--no-filters", "-w", "-t", "blob", "--stdin"], env, target);
			if (hashed.status !== 0) return { ok: false, reason: `git hash-object --no-filters -w (symlink) for ${path} failed: ${hashed.stderr.trim()}` };
			sha = hashed.stdout.trim();
		} else {
			const hashed = git(candidateCwd, ["hash-object", "--no-filters", "-w", "--", path], env);
			if (hashed.status !== 0) return { ok: false, reason: `git hash-object --no-filters -w ${path} failed: ${hashed.stderr.trim()}` };
			sha = hashed.stdout.trim();
		}
		const addEntry = git(candidateCwd, ["update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`], env);
		if (addEntry.status !== 0) return { ok: false, reason: `git update-index --add --cacheinfo for ${path} failed: ${addEntry.stderr.trim()}` };
	}
	return { ok: true };
}

/**
 * Proves the runner will test the candidate's actual changes. A clean HEAD is used directly.
 * A dirty tree is captured with a LOCAL CHECKPOINT commit that never touches the user's real
 * index, branch, or working tree: a temporary `GIT_INDEX_FILE` seeded from HEAD via
 * `git read-tree HEAD`, then rebuilt entry-by-entry by `buildCheckpointIndex` (deliberately NEVER
 * `git add -A`, which cannot be told to skip `.gitattributes` clean filters) into THAT temp
 * index, `git write-tree`, and `git commit-tree -p HEAD`. The result is protected from gc with a
 * private ref under `refs/orchestrator/live-qa/<runId>`.
 */
export function prepareTestedRevision(params: {
	candidateCwd: string;
	runnerCwd: string;
	runId: string;
	changedFiles: string[];
}): PreparedTestedRevision {
	const { candidateCwd, runnerCwd, runId, changedFiles } = params;

	const candidateCommon = gitCommonDirReal(candidateCwd);
	const runnerCommon = gitCommonDirReal(runnerCwd);
	const sameRepo = candidateCommon !== null && runnerCommon !== null && candidateCommon === runnerCommon;
	const componentExercisedReason = sameRepo
		? undefined
		: "the candidate repository's git common dir differs from the runner's; this component cannot be exercised by this Forge checkout";

	const fail = (reason: string, extra: Partial<PreparedTestedRevision> = {}): PreparedTestedRevision => ({
		ok: false,
		reason,
		sha: null,
		tree: null,
		base_head: null,
		checkpoint: false,
		checkpoint_ref: null,
		component_exercised: sameRepo,
		component_exercised_reason: componentExercisedReason,
		...extra,
	});

	// AUTHORITATIVE guard, run before any filter-capable git operation (the metadata-only
	// `git rev-parse --git-common-dir` calls above run earlier but never invoke a content filter):
	// refuse if any LOCAL/WORKTREE-scope `filter.*` config entry
	// exists at all (see `repositoryFilterDriverConfigSafe`'s doc comment for why this -- not the
	// attribute-value check below -- is what actually decides whether any filter can execute).
	const driverCheck = repositoryFilterDriverConfigSafe(candidateCwd);
	if (!driverCheck.ok) return fail(driverCheck.reason);

	// S1a: defense in depth. Refuse BEFORE the very first `git status` call (which can itself
	// invoke a repo-controlled clean filter, see `repositoryFilterAttributesSafe`'s doc comment) if
	// ANY path git can see in this repository -- tracked, untracked, or HEAD-tree-only (the
	// `rm --cached` + ignored case) -- has a `filter` attribute that could run an arbitrary command.
	const attrCheck = repositoryFilterAttributesSafe(candidateCwd);
	if (!attrCheck.ok) return fail(attrCheck.reason);

	// `--no-optional-locks` (git >= 2.14) plus `GIT_OPTIONAL_LOCKS=0` for older/edge cases together
	// guarantee this status check never takes the `.git/index.lock` and never rewrites/refreshes the
	// user's real index file (git's normal `status` behaviour opportunistically refreshes stat-cache
	// data in the index as a side effect, which is a write we must not perform against the real
	// index this adapter does not own).
	const status = git(candidateCwd, ["--no-optional-locks", "status", "--porcelain"], { ...process.env, GIT_OPTIONAL_LOCKS: "0" });
	if (status.status !== 0) return fail("candidate is not a git repository, or git is unavailable");
	const dirty = status.stdout.trim().length > 0;

	if (!dirty) {
		const head = git(candidateCwd, ["rev-parse", "HEAD"]);
		if (head.status !== 0) return fail("candidate has no HEAD commit");
		const sha = head.stdout.trim();
		const treeRes = git(candidateCwd, ["rev-parse", `${sha}^{tree}`]);
		const tree = treeRes.status === 0 ? treeRes.stdout.trim() : null;
		const proof = proveRevision(candidateCwd, runnerCwd, sha, changedFiles);
		if (!proof.ok) {
			return fail(proof.reason ?? "tested-revision proof failed", { sha, tree, base_head: sha, checkpoint: false, checkpoint_ref: null });
		}
		return {
			ok: true, sha, tree, base_head: sha, checkpoint: false, checkpoint_ref: null,
			component_exercised: sameRepo, component_exercised_reason: componentExercisedReason,
		};
	}

	// The checkpoint tree is built EXCLUSIVELY from the caller-supplied `changedFiles` set (see
	// `buildCheckpointIndex`'s doc comment) -- a dirty tree with an empty/unprovided candidate set
	// is ambiguous (which files, if any, should the checkpoint capture?) and is refused outright
	// rather than silently falling back to "everything git considers dirty", which is exactly the
	// over-broad behaviour this guard replaces.
	if (changedFiles.length === 0) {
		return fail("candidate working tree is dirty but no candidate changed-file set was provided; refusing to checkpoint an ambiguous/empty candidate set");
	}

	const headRes = git(candidateCwd, ["rev-parse", "HEAD"]);
	if (headRes.status !== 0) return fail("dirty candidate has no HEAD commit to checkpoint from");
	const baseHead = headRes.stdout.trim();
	// A per-call `mkdtempSync` directory (rather than a fixed, PID-derived filename under `tmpdir()`
	// directly) guarantees uniqueness even across concurrent live-QA stages sharing a PID namespace
	// (e.g. containers) and gives us one directory to remove wholesale in `finally`, rather than a
	// single loose file that could collide or leak.
	const tmpIndexDir = mkdtempSync(join(tmpdir(), "orch-live-qa-index-"));
	const tmpIndex = join(tmpIndexDir, "index");
	try {
		const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
		const r = git(candidateCwd, ["read-tree", "HEAD"], env);
		if (r.status !== 0) return fail(`git read-tree HEAD failed: ${r.stderr.trim()}`);
		const built = buildCheckpointIndex(candidateCwd, env, changedFiles);
		if (!built.ok) return fail(built.reason);
		const writeTree = git(candidateCwd, ["write-tree"], env);
		if (writeTree.status !== 0) return fail(`git write-tree failed: ${writeTree.stderr.trim()}`);
		const tree = writeTree.stdout.trim();
		const commit = git(candidateCwd, ["commit-tree", tree, "-p", baseHead, "-m", `orchestrator live-qa checkpoint ${runId}`]);
		if (commit.status !== 0) return fail(`git commit-tree failed: ${commit.stderr.trim()}`, { tree, base_head: baseHead });
		const sha = commit.stdout.trim();
		const ref = `refs/orchestrator/live-qa/${runId}`;
		// S2: a DANGLING symbolic ref (one that resolves to a branch that does not itself exist yet,
		// e.g. `refs/heads/does-not-exist`) has no resolvable SHA of its own -- git's own old-value
		// comparison inside `update-ref --no-deref` then reads it as "ref does not exist" and HAPPILY
		// replaces the dangling symbolic ref with a brand-new plain ref (verified empirically: this is
		// not hypothetical), silently destroying whatever pointed there. `--no-deref`'s create-only
		// guarantee is therefore NOT sufficient by itself for a dangling symref. Checked explicitly
		// here, before `update-ref` ever runs: `git symbolic-ref -q <ref>` succeeds for ANY symbolic
		// ref at this path (dangling or not), and `git show-ref --verify -q <ref>` succeeds for any
		// real/packed ref -- either one existing at all is a collision, and the checkpoint is refused
		// rather than risk moving/overwriting whatever the caller (or a stale prior run) put there.
		const existingSymbolicRef = git(candidateCwd, ["symbolic-ref", "-q", ref]);
		const existingRef = git(candidateCwd, ["show-ref", "--verify", "-q", ref]);
		if (existingSymbolicRef.status === 0 || existingRef.status === 0) {
			return fail(`refusing to create checkpoint ref ${ref}: a ref already exists at this path (symbolic or real, possibly dangling)`, { sha, tree, base_head: baseHead });
		}
		// `--no-deref` + an explicit all-zero old-value makes this CREATE-ONLY: git refuses (nonzero
		// exit) if `ref` already exists in any form — a real, packed, or SYMBOLIC ref — rather than
		// overwriting/moving it. A pre-existing symbolic ref at this path (e.g. one an attacker or a
		// stale prior run pointed at the candidate's real branch) is therefore never touched: this
		// call fails, and the caller reports unavailable, never a moved branch. Belt-and-suspenders
		// alongside the explicit pre-check immediately above (which alone closes the dangling-symref
		// gap this comment used to not account for).
		const updateRef = git(candidateCwd, ["update-ref", "--no-deref", ref, sha, "0".repeat(sha.length)]);
		if (updateRef.status !== 0) {
			return fail(`git update-ref --no-deref ${ref} failed (create-only; the ref may already exist): ${updateRef.stderr.trim()}`, { sha, tree, base_head: baseHead });
		}
		const proof = proveRevision(candidateCwd, runnerCwd, sha, changedFiles);
		if (!proof.ok) {
			return fail(proof.reason ?? "tested-revision proof failed", { sha, tree, base_head: baseHead, checkpoint: true, checkpoint_ref: ref });
		}
		return {
			ok: true, sha, tree, base_head: baseHead, checkpoint: true, checkpoint_ref: ref,
			component_exercised: sameRepo, component_exercised_reason: componentExercisedReason,
		};
	} finally {
		try {
			rmSync(tmpIndexDir, { recursive: true, force: true });
		} catch {
			/* best-effort: temp dir may never have been created */
		}
	}
}

// -----------------------------------------------------------------------------
// Running the adapter
// -----------------------------------------------------------------------------

/** Minimal shape `RunCancellation` (cancellation.ts) already satisfies without modification:
 *  its `onCancel` matches this exactly, and its `isCancelled` getter (typed `boolean`) is
 *  structurally assignable to this optional `boolean` property, so no cast is needed at the
 *  call site. */
export interface LiveQaCancellationSignal {
	onCancel(listener: () => void): () => void;
	/** When present and already `true` at call time, `runLiveQa` never spawns the child at all. */
	isCancelled?: boolean;
}

export interface RunLiveQaResult {
	exitCode: number | null;
	signal: string | null;
	reportPath: string | null;
	/** Forge's own run id, parsed from the `[qa slot=N run=<id>]` log prefix. */
	runnerRunId: string | null;
	cancelled: boolean;
	/** Bounded (<=4KB) tail of combined stdout+stderr, for diagnostics only. */
	tail: string;
	/** Set only when `spawn` itself failed (e.g. ENOENT). Never confuse this with a runner exit
	 *  code — downstream parsing must treat it (like any missing report) as UNAVAILABLE, never PASS. */
	spawnError?: string;
}

// Forge's progress logger (scripts/qa/progress.ts createLogger) always prefixes every line with
// `[<ISO timestamp>] [qa slot=N run=<id>] `, so the report line is never anchored at column 0 in
// real output — it is always `... report: <path>` at the end of a prefixed line.
const REPORT_LINE_RE = /report:\s*(.+)$/;
const RUN_PREFIX_RE = /\[qa slot=\d+ run=(\S+)\]/;
const TAIL_MAX_BYTES = 4096;
/** S6: caps the per-stream pending (not-yet-newline-terminated) raw buffer so a runner that
 *  writes without ever emitting a newline cannot grow memory unboundedly. */
const MAX_PENDING_BUFFER_BYTES = 64 * 1024;

// Names of process.env vars whose VALUES are treated as secrets and redacted out of runner
// output before it ever reaches `onLine` or the diagnostic `tail`. This is deliberately broad
// (PASS/PASSWORD/CREDENTIAL/AUTH, not just an exact "SECRET"/"KEY" match) because the runner
// inherits the full parent environment (see `runLiveQa` doc comment) and we cannot know in
// advance which of those variables a misbehaving or compromised runner/agent might echo.
const ENV_CREDENTIAL_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|DATABASE_URL|AUTH/i;
// Matches a shell/env-style `NAME=value` assignment anywhere in free text (runner stdout/stderr,
// a lead/human-authored scope string, or an adapter's own argv_prefix). Applied UNCONDITIONALLY
// (see `redactCredentialAssignments` below): unlike the process.env-driven redaction above, this
// pass does not require the value to actually be exported under that name in this process's own
// environment, and does not require any minimum length -- a short, free-text-typed, or otherwise
// never-exported credential-shaped assignment (`API_TOKEN=abc`, a human pasting a real secret
// into a `--live-qa-scope` argument, etc.) is redacted purely by NAME shape.
const CREDENTIAL_ASSIGNMENT_KEY_RE = /pass|secret|token|key|auth|credential|cookie|session/i;
const CREDENTIAL_ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|\S+)/g;
// Caps how many times `redactCredentialAssignments` recurses into an already-matched VALUE (see
// that function's doc comment for why recursion, not a single pass, is required at all). A
// realistic credential-shaped nesting is at most one or two levels deep (a human- or
// agent-authored log line, never an arbitrarily deep synthetic chain); this bound exists purely
// to cap the worst case at a small, CONSTANT number of full-string passes -- never unbounded --
// regardless of what a misbehaving or adversarial runner might emit (an unbounded version of this
// recursion both stack-overflows and does O(n * depth) work on an adversarial `a=a=a=a=...` chain,
// since each recursive call re-scans a string only one key shorter than the one before it).
const MAX_CREDENTIAL_ASSIGNMENT_NESTING_DEPTH = 8;
const MIN_REDACTED_ENV_VALUE_LENGTH = 6;
const BEARER_RE = /\bBearer\s+\S+/gi;
const SCHEME_CHAR_RE = /[A-Za-z0-9+.-]/;
const USERINFO_TERMINATOR_RE = /[/?#\s]/;

/**
 * Redacts URL userinfo (`scheme://user:pass@host`) with a linear-time MANUAL scanner rather than
 * a regex. The regex this replaced bounded its quantifiers (scheme <=20 chars, userinfo <=256
 * chars) specifically to avoid catastrophic backtracking on a long run of scheme-charset
 * characters with no `://` ever following -- but that same bound silently truncated the match
 * (and therefore skipped redaction ENTIRELY, leaking the whole credential) on any userinfo longer
 * than 256 characters, which is a real password length. This scanner is O(n) overall without
 * bounding the userinfo length at all: `indexOf("://", i)` finds each candidate scheme boundary
 * in one forward pass (no backtracking); the backward scheme scan and the forward userinfo scan
 * that follow each match only ever visit characters strictly between the current `i` and the next
 * advance of `i`, so no character is re-scanned across iterations and the whole function is a
 * single pass over the input.
 */
function redactUrlUserinfo(text: string): string {
	let result = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const idx = text.indexOf("://", i);
		if (idx === -1) {
			result += text.slice(i);
			break;
		}
		// Scheme: the maximal run of [A-Za-z0-9+.-] immediately preceding "://", scanned backward but
		// bounded by `i` (never re-walking text already appended to `result`).
		let schemeStart = idx;
		while (schemeStart > i && SCHEME_CHAR_RE.test(text[schemeStart - 1])) schemeStart--;
		const scheme = text.slice(schemeStart, idx);
		if (scheme.length === 0 || !/^[A-Za-z]/.test(scheme)) {
			// Not a real scheme (empty, or doesn't start with a letter): copy through "://" verbatim.
			result += text.slice(i, idx + 3);
			i = idx + 3;
			continue;
		}
		// Userinfo: every char after "://" up to the first '@', provided none of '/', '?', '#', or
		// whitespace occurs first (those mark the end of the authority with no userinfo present).
		let j = idx + 3;
		while (j < n && text[j] !== "@" && !USERINFO_TERMINATOR_RE.test(text[j])) j++;
		if (j >= n || text[j] !== "@") {
			// No userinfo terminator ('@') before the authority ends: nothing to redact here.
			result += text.slice(i, idx + 3);
			i = idx + 3;
			continue;
		}
		result += text.slice(i, schemeStart) + scheme + "://[REDACTED]@";
		i = j + 1;
	}
	return result;
}

/**
 * Redacts every credential-shaped `NAME=value` assignment in `text`, including one NESTED inside
 * a shallower, non-credential-shaped assignment's own value (e.g. `note=API_TOKEN=abc`,
 * `message="API_TOKEN=abc"`). A SINGLE pass with `CREDENTIAL_ASSIGNMENT_RE` cannot see the nested
 * assignment: an unquoted value's `\S+` (no whitespace before the nested `=`) and a quoted
 * value's `[^"\n]*`/`[^'\n]*` both swallow the ENTIRE nested assignment as one opaque token in the
 * very same match that decided the OUTER key (`note`, `message`) was not credential-shaped, and
 * `.replace`'s left-to-right scan never revisits those already-consumed characters to give the
 * inner assignment a second chance.
 *
 * The fix is to recurse into whatever text the outer match captured as its VALUE (with a matching
 * wrapping quote stripped, then restored around the recursed result) whenever the outer key is
 * NOT itself credential-shaped -- this hands the inner text back to the same regex as a fresh,
 * standalone string with no outer `key=` prefix in front of it to swallow it. Recursion depth is
 * capped at `MAX_CREDENTIAL_ASSIGNMENT_NESTING_DEPTH` (a small, fixed constant, not input-
 * dependent): each recursive call operates on a strictly SHORTER string (missing at least the
 * `key=` prefix), so the depth cap bounds total work at
 * `O(MAX_CREDENTIAL_ASSIGNMENT_NESTING_DEPTH * n)` -- i.e. still `O(n)` -- and bounds the call
 * stack, regardless of how many `=` characters an adversarial input contains (an EARLIER,
 * unbounded version of this recursion both stack-overflowed and did `O(n * depth)` work on an
 * input like `"a=".repeat(30000)`, since depth there is proportional to input length).
 */
function redactCredentialAssignments(text: string, depth = 0): string {
	if (depth >= MAX_CREDENTIAL_ASSIGNMENT_NESTING_DEPTH) {
		// Recursion budget exhausted: an earlier version returned `text` here VERBATIM, which let a
		// credential nested exactly `MAX_CREDENTIAL_ASSIGNMENT_NESTING_DEPTH` (or more) levels deep
		// inside a chain of otherwise-innocuous `key=key=key=...` assignments (e.g.
		// `a=a=a=a=a=a=a=a=API_TOKEN=abc`, each layer's key never itself credential-shaped) reach the
		// output completely unredacted, since nothing this deep is ever handed back to the regex
		// again to notice it. This final pass still applies the SAME assignment regex ONE more time
		// (never recursing further -- that would defeat the whole point of the depth cap) and redacts
		// whatever it captures as the value UNCONDITIONALLY, regardless of whether the key itself
		// looks credential-shaped: past the depth cap, this function can no longer tell a genuinely
		// non-credential deeply-nested value apart from one hiding a credential even deeper, so the
		// safe default is to treat it all as a credential rather than let it through unredacted.
		return text.replace(CREDENTIAL_ASSIGNMENT_RE, (_match, key: string) => `${key}=[REDACTED]`);
	}
	return text.replace(CREDENTIAL_ASSIGNMENT_RE, (match, key: string, rawValue: string) => {
		if (CREDENTIAL_ASSIGNMENT_KEY_RE.test(key)) return `${key}=[REDACTED]`;
		const isDoubleQuoted = rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"');
		const isSingleQuoted = rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'");
		const quote = isDoubleQuoted ? '"' : isSingleQuoted ? "'" : null;
		const inner = quote ? rawValue.slice(1, -1) : rawValue;
		const redactedInner = redactCredentialAssignments(inner, depth + 1);
		return `${key}=${quote ? `${quote}${redactedInner}${quote}` : redactedInner}`;
	});
}

/**
 * Redacts (a) the literal value of any `process.env` variable whose NAME matches
 * `ENV_CREDENTIAL_NAME_RE` and whose value is at least `MIN_REDACTED_ENV_VALUE_LENGTH` chars
 * (short values like "1"/"true" are not worth redacting and would make ordinary log text
 * unreadable), (a2) each newline-split COMPONENT of a multi-line credential-shaped env value
 * (also at least `MIN_REDACTED_ENV_VALUE_LENGTH` chars) so a PEM-style private key or multi-line
 * secret is still redacted line-by-line even when the runner only ever echoes one line of it at
 * a time (the whole-value match in (a) can never fire on a single line of a multi-line value),
 * (b) `Bearer <token>` patterns, and (c) URL userinfo (`scheme://user:pass@`). Applied to every
 * COMPLETE line of runner stdout/stderr (buffered per-stream until a newline or stream close,
 * never per-chunk — a chunk boundary can split a secret value in half, and a chunk-scoped
 * redaction would never see the whole value to match against) BEFORE it reaches `onLine` or
 * `tail` — env values themselves are never logged or recorded anywhere by this module.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv): string {
	let result = text;
	// Credential-shaped `NAME=value` assignments, redacted by NAME shape alone (and found ANYWHERE
	// in the text, including nested inside a shallower, non-credential-shaped assignment's own
	// value -- see `redactCredentialAssignments`'s doc comment), regardless of env match or value
	// length -- see `CREDENTIAL_ASSIGNMENT_KEY_RE`'s comment. Applied FIRST so the process.env-driven
	// substring pass below never has to re-discover a value already fully replaced with
	// `[REDACTED]` here.
	result = redactCredentialAssignments(result);
	for (const [name, value] of Object.entries(env)) {
		if (!value) continue;
		if (!ENV_CREDENTIAL_NAME_RE.test(name)) continue;
		if (value.length >= MIN_REDACTED_ENV_VALUE_LENGTH && result.includes(value)) {
			result = result.split(value).join("[REDACTED]");
		}
		if (value.includes("\n") || value.includes("\r")) {
			for (const component of value.split(/\r?\n/)) {
				if (component.length >= MIN_REDACTED_ENV_VALUE_LENGTH && result.includes(component)) {
					result = result.split(component).join("[REDACTED]");
				}
			}
		}
	}
	result = result.replace(BEARER_RE, "Bearer [REDACTED]");
	result = redactUrlUserinfo(result);
	return result;
}

// A git object id (SHA-1, 40 hex chars, or SHA-256, 64 hex chars) never contains a credential --
// it is a content hash -- but it is exactly the kind of long, opaque-looking string that a
// substring-based scan (`redactSecrets`' `result.includes(value)`) can accidentally clobber: if
// an unrelated env secret happens to be a substring of a sha (a real, if unlikely, collision --
// e.g. a short secret value that happens to appear inside `tested_revision`), redaction would
// splice `[REDACTED]` into the MIDDLE of a structured proof field (`tested_revision`/
// `tested_tree`/`base_head`) and corrupt it, rather than merely redacting genuinely secret text.
// These fields are proof, not free text -- never subject to substring redaction.
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// The exemption above must never apply merely because a value happens to be hex-shaped -- a
// caller-supplied credential (e.g. an operator accidentally passing an API token as
// --live-qa-adapter <id> or --live-qa-scope <scope>) can itself be exactly 40 or 64 hex
// characters, and blanket-exempting every hex-shaped string would let such a credential persist
// unredacted in stage.adapterId/stage.scope/outcomeRow.adapter. The exemption is therefore keyed
// on the OBJECT KEY as well as the shape: only a string sitting directly under one of these exact
// keys -- all of them fields THIS module derives from its own git calls (prepareTestedRevision's
// sha/tree/base_head, liveQaVerificationOutcomeFor's tested_revision/tested_tree, and
// runtimeUnderTestFor's runner_head in live-qa-stage.ts) and never from request input -- is
// eligible for the git-object-id exemption at all.
const GIT_OBJECT_ID_FIELD_ALLOWLIST = new Set(["tested_revision", "tested_tree", "base_head", "sha", "tree", "runner_head"]);

/**
 * Deep-walks `value` (objects/arrays recursively, every other type passed through unchanged) and
 * applies `redactSecrets` to every string found, anywhere in the structure -- EXCEPT a string
 * that (a) sits directly under one of `GIT_OBJECT_ID_FIELD_ALLOWLIST`'s keys (a revision-proof
 * field this module itself produced from its own git calls; see that constant's comment for why
 * the key check, not merely the shape check, is required) AND (b) is itself a bare git object id
 * (`GIT_OBJECT_ID_RE`, see its comment above) -- which is returned byte-for-byte unchanged so a
 * structured proof field can never be corrupted by an unrelated secret that happens to be one of
 * its substrings. Every other string, including a hex-shaped one under any other key (`adapterId`,
 * `scope`, the outcome row's `adapter`, etc.), is redacted normally. Numbers, booleans, and `null`
 * are always passed through unchanged (they are never subject to redaction in the first place; the
 * checks above only ever intercept `string`/array/plain-object). This is the single
 * persistence-boundary sanitizer (S3): everything `runLiveQaStage` returns -- the outcome row,
 * cost rows, reasons, and `runtime_under_test` (including `runner_cwd` and the adapter id) -- is
 * passed through this exactly once, on every return path, including a preflight/config/scope/
 * revision failure that never got far enough to produce runner output at all. A config path, a
 * `runner_cwd`, or any other string a caller supplies can itself contain a credential (e.g. an
 * env-derived path); this closes that gap the same way runner stdout/stderr and findings.json are
 * already closed, rather than trusting each call site to remember to redact its own fields.
 */
export function sanitizeForPersistence<T>(value: T, env: NodeJS.ProcessEnv, key?: string): T {
	if (typeof value === "string") {
		if (key !== undefined && GIT_OBJECT_ID_FIELD_ALLOWLIST.has(key) && GIT_OBJECT_ID_RE.test(value)) return value as unknown as T;
		return redactSecrets(value, env) as unknown as T;
	}
	if (Array.isArray(value)) return value.map((v) => sanitizeForPersistence(v, env, key)) as unknown as T;
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeForPersistence(v, env, k);
		return out as unknown as T;
	}
	return value;
}

/**
 * Spawns the runner's argv directly (shell: false), inherits process.env (the runner needs it —
 * never logs or records env values), and streams lines to `onLine` so the caller can write them
 * to the session log. There is NO timeout of our own — the runner owns its own budget/deadline.
 * On cancellation, sends SIGINT exactly once and then KEEPS WAITING for the child's `close`
 * event, resolving only then with `cancelled: true` and the real exit code/signal/report/tail;
 * it never sends SIGKILL and never runs `bun qa clean`. If `signal.isCancelled` is already
 * `true` before this call, the child is never spawned at all.
 */
export function runLiveQa(opts: {
	adapter: LiveQaAdapterConfig;
	argv: string[];
	signal: LiveQaCancellationSignal;
	onLine: (line: string) => void;
	/** Called synchronously right after `spawn()` returns (before any I/O), so a caller can track
	 *  the child's pid for teardown purposes even if the runner never produces readable output. */
	onSpawn?: (pid: number | undefined) => void;
}): Promise<RunLiveQaResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: RunLiveQaResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		if (opts.signal.isCancelled === true) {
			finish({ exitCode: null, signal: null, reportPath: null, runnerRunId: null, cancelled: true, tail: "" });
			return;
		}

		const child = spawn(opts.argv[0], opts.argv.slice(1), {
			cwd: opts.adapter.runner_cwd,
			shell: false,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		opts.onSpawn?.(child.pid);

		let tail = "";
		let reportPath: string | null = null;
		let runnerRunId: string | null = null;
		let cancelRequested = false;
		let sigintSent = false;

		const appendTail = (text: string) => {
			tail = (tail + text).slice(-TAIL_MAX_BYTES);
		};

		// A secret can straddle two separate `data` events (the kernel/pipe is free to split a
		// write anywhere, including mid-value). Redacting per-chunk (the previous behaviour) only
		// sees each half and never matches the full secret, leaking it into `tail`/`onLine`. The fix:
		// buffer RAW (unredacted) bytes per stream until a complete line is available, redact the
		// COMPLETE line, and only then hand it to `onLine`/`tail`. stdout and stderr are buffered
		// SEPARATELY — interleaving them into one buffer could otherwise fuse an unrelated stdout
		// fragment onto a stderr line (or vice versa) and misattribute report/run-id parsing.
		type StreamState = { pending: string; discarding: boolean; discardedBytes: number };
		const stdoutState: StreamState = { pending: "", discarding: false, discardedBytes: 0 };
		const stderrState: StreamState = { pending: "", discarding: false, discardedBytes: 0 };

		const emitLine = (rawLine: string) => {
			const line = redactSecrets(rawLine, process.env);
			appendTail(`${line}\n`);
			opts.onLine(line);
			const reportMatch = REPORT_LINE_RE.exec(line.trim());
			if (reportMatch) reportPath = reportMatch[1].trim();
			const runMatch = RUN_PREFIX_RE.exec(line);
			if (runMatch) runnerRunId = runMatch[1];
		};

		const NEWLINE_RE = /\r?\n/;

		// S4/S6: a per-stream pending (not-yet-newline-terminated) buffer that exceeds
		// `MAX_PENDING_BUFFER_BYTES` is DISCARDED outright, never emitted as a fragment (even a
		// redacted one): a secret can straddle exactly the cap boundary, and redacting a fragment can
		// only ever see ITS half of the secret, never the whole value to match against -- the previous
		// behaviour (slicing the oversized pending into cap-sized "lines" and redacting/emitting each)
		// is precisely this leak. The cap is checked against the FULL candidate line -- `state.pending`
		// carried over from earlier chunks PLUS whatever precedes the next newline in THIS chunk --
		// every time a newline is found, not merely against the leftover tail after popping already-
		// terminated lines: a chunk boundary and a line's terminating newline can otherwise coincide
		// (e.g. two synchronous child-process writes coalesced into one OS-level `data` event), which
		// would let an already-oversized line slip through as an ordinary "complete" line. Once
		// discarding starts (no newline anywhere in the current chunk to resolve it), every subsequent
		// byte is discarded too (never buffered, never re-attempted) until the next newline finally
		// arrives; at that point exactly one marker line reporting the byte COUNT (never any of the
		// discarded content) is emitted, and normal per-line parsing resumes for whatever follows.
		const processChunk = (state: StreamState, buf: Buffer) => {
			let text = buf.toString("utf-8");
			while (text.length > 0) {
				if (state.discarding) {
					const match = NEWLINE_RE.exec(text);
					if (!match) {
						state.discardedBytes += text.length;
						return;
					}
					state.discardedBytes += match.index;
					emitLine(`[live-qa] output line exceeded ${MAX_PENDING_BUFFER_BYTES} bytes; ${state.discardedBytes} bytes discarded`);
					state.discardedBytes = 0;
					state.discarding = false;
					text = text.slice(match.index + match[0].length);
					continue;
				}
				const match = NEWLINE_RE.exec(text);
				if (!match) {
					// No newline anywhere in this chunk: accumulate into `pending`, then check the cap.
					state.pending += text;
					if (state.pending.length > MAX_PENDING_BUFFER_BYTES) {
						state.discardedBytes = state.pending.length;
						state.discarding = true;
						state.pending = "";
					}
					text = "";
					continue;
				}
				const candidateLine = state.pending + text.slice(0, match.index);
				if (candidateLine.length > MAX_PENDING_BUFFER_BYTES) {
					emitLine(`[live-qa] output line exceeded ${MAX_PENDING_BUFFER_BYTES} bytes; ${candidateLine.length} bytes discarded`);
				} else {
					emitLine(candidateLine);
				}
				state.pending = "";
				text = text.slice(match.index + match[0].length);
			}
		};

		const handleStdout = (buf: Buffer) => processChunk(stdoutState, buf);
		const handleStderr = (buf: Buffer) => processChunk(stderrState, buf);

		// Flushes any trailing partial line (never newline-terminated by the runner, e.g. a final
		// write before exit) on `close`/`error` — it, too, is redacted before ever reaching
		// `onLine`/`tail`. `tail` therefore only ever contains redacted text, with no raw window. A
		// stream that was still discarding when the process closed (the oversized line's terminating
		// newline never arrived at all) still gets exactly one count-only marker line, never any of
		// the discarded content.
		const flushPending = () => {
			for (const state of [stdoutState, stderrState]) {
				if (state.discarding) {
					if (state.discardedBytes > 0) {
						emitLine(`[live-qa] output line exceeded ${MAX_PENDING_BUFFER_BYTES} bytes; ${state.discardedBytes} bytes discarded`);
					}
					state.discardedBytes = 0;
					state.discarding = false;
					continue;
				}
				if (state.pending.length > 0) {
					const raw = state.pending;
					state.pending = "";
					emitLine(raw);
				}
			}
		};

		const unsubscribe = opts.signal.onCancel(() => {
			cancelRequested = true;
			if (sigintSent) return;
			sigintSent = true;
			try {
				child.kill("SIGINT");
			} catch {
				/* process may already be gone */
			}
			// Deliberately does NOT resolve here — we wait for the real `close` event below so the
			// caller always gets the runner's actual exit code/signal, never a synthetic one.
		});

		child.stdout?.on("data", handleStdout);
		child.stderr?.on("data", handleStderr);
		child.on("close", (code, signal) => {
			unsubscribe();
			flushPending();
			finish({ exitCode: code, signal, reportPath, runnerRunId, cancelled: cancelRequested, tail });
		});
		child.on("error", (error) => {
			unsubscribe();
			flushPending();
			finish({
				exitCode: null,
				signal: null,
				reportPath,
				runnerRunId,
				cancelled: cancelRequested,
				tail,
				spawnError: (error as NodeJS.ErrnoException).code
					? `${(error as NodeJS.ErrnoException).code}: ${error.message}`
					: error.message,
			});
		});
	});
}

// -----------------------------------------------------------------------------
// Result parsing
// -----------------------------------------------------------------------------

export interface LiveQaAgentUsage {
	status: string;
	runtime: string | null;
	model: string | null;
	provider: string | null;
	effort: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	costMicrocents: number | null;
	costSource: string;
	elapsedMs: number | null;
}

export interface LiveQaHumainCodeUsage {
	status: string;
	totals?: {
		inputTokens: number | null;
		outputTokens: number | null;
		costMicrocents: number | null;
	};
}

export interface LiveQaUsageV2 {
	version: number;
	agent: LiveQaAgentUsage;
	humainCode: LiveQaHumainCodeUsage;
}

function readUsage(raw: string): LiveQaUsageV2 | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !isRecord(parsed.agent) || !isRecord(parsed.humainCode)) return null;
	const agent = parsed.agent;
	const humainCode = parsed.humainCode;
	const totalsRaw = isRecord(humainCode.totals) ? humainCode.totals : null;
	return {
		version: typeof parsed.version === "number" ? parsed.version : 2,
		agent: {
			status: typeof agent.status === "string" ? agent.status : "not_recorded",
			runtime: typeof agent.runtime === "string" ? agent.runtime : null,
			model: typeof agent.model === "string" ? agent.model : null,
			provider: typeof agent.provider === "string" ? agent.provider : null,
			effort: typeof agent.effort === "string" ? agent.effort : null,
			inputTokens: typeof agent.inputTokens === "number" ? agent.inputTokens : null,
			outputTokens: typeof agent.outputTokens === "number" ? agent.outputTokens : null,
			cacheReadInputTokens: typeof agent.cacheReadInputTokens === "number" ? agent.cacheReadInputTokens : null,
			cacheCreationInputTokens: typeof agent.cacheCreationInputTokens === "number" ? agent.cacheCreationInputTokens : null,
			costMicrocents: typeof agent.costMicrocents === "number" ? agent.costMicrocents : null,
			costSource: typeof agent.costSource === "string" ? agent.costSource : "unknown",
			elapsedMs: typeof agent.elapsedMs === "number" ? agent.elapsedMs : null,
		},
		humainCode: {
			status: typeof humainCode.status === "string" ? humainCode.status : "unavailable",
			totals: totalsRaw
				? {
					inputTokens: typeof totalsRaw.inputTokens === "number" ? totalsRaw.inputTokens : null,
					outputTokens: typeof totalsRaw.outputTokens === "number" ? totalsRaw.outputTokens : null,
					costMicrocents: typeof totalsRaw.costMicrocents === "number" ? totalsRaw.costMicrocents : null,
				}
				: undefined,
		},
	};
}

export interface LiveQaFinding {
	fingerprint: string;
	title: string;
	severity: string;
	tier: number;
	confirmed: boolean;
}

// Mirrors Forge's scripts/qa/findings.ts FindingInputSchema (a zod object): a malformed entry —
// wrong type, missing required field, out-of-range enum/number — must make the WHOLE envelope
// unavailable, never silently dropped (the old behaviour here skipped non-object entries and
// defaulted missing fields to ""/-1, which could turn a malformed P1 into an invisible pass).
const FINDING_SEVERITIES = new Set(["P1", "P2", "P3"]);
const FINDING_TIERS = new Set([1, 2, 3]);

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function validateFindingEntry(entry: unknown, index: number): { ok: true; finding: LiveQaFinding } | { ok: false; reason: string } {
	const fail = (detail: string) => ({ ok: false as const, reason: `findings.json entry ${index}: ${detail}` });
	if (!isRecord(entry)) return fail("must be an object");

	if (!(typeof entry.title === "string" && entry.title.length >= 1 && entry.title.length <= 200)) {
		return fail("title must be a non-empty string of at most 200 characters");
	}
	if (!(typeof entry.severity === "string" && FINDING_SEVERITIES.has(entry.severity))) {
		return fail("severity must be one of P1|P2|P3");
	}
	if (!(typeof entry.tier === "number" && FINDING_TIERS.has(entry.tier))) {
		return fail("tier must be one of 1|2|3");
	}
	if (entry.confirmed !== true && entry.confirmed !== false) {
		return fail("confirmed must be a boolean");
	}
	for (const field of ["area", "route", "identity", "failureClass", "symptom"] as const) {
		if (!isNonEmptyString(entry[field])) return fail(`${field} must be a non-empty string`);
	}
	for (const field of ["expected", "actual", "evidenceDir"] as const) {
		if (typeof entry[field] !== "string") return fail(`${field} must be a string`);
	}
	if (!(Array.isArray(entry.steps) && entry.steps.length >= 1 && entry.steps.every((s) => typeof s === "string"))) {
		return fail("steps must be a non-empty array of strings");
	}
	if (!(typeof entry.confidence === "number" && entry.confidence >= 0 && entry.confidence <= 1)) {
		return fail("confidence must be a number in [0, 1]");
	}
	if (entry.fingerprint !== undefined && typeof entry.fingerprint !== "string") return fail("fingerprint, if present, must be a string");
	// Mirrors Forge's scripts/qa/findings.ts FindingInputSchema optional fields exactly: an
	// entry that supplies one of these but with the wrong shape is malformed (fails closed),
	// never silently coerced or dropped.
	if (entry.source !== undefined && typeof entry.source !== "string") return fail("source, if present, must be a string");
	if (entry.duplicateOf !== undefined && typeof entry.duplicateOf !== "string") return fail("duplicateOf, if present, must be a string");
	if (entry.retainEnvironment !== undefined) {
		if (!isRecord(entry.retainEnvironment) || !isNonEmptyString(entry.retainEnvironment.reason)) {
			return fail("retainEnvironment, if present, must be an object with a non-empty string 'reason'");
		}
	}

	return {
		ok: true,
		finding: {
			fingerprint: typeof entry.fingerprint === "string" ? entry.fingerprint : "",
			title: entry.title,
			severity: entry.severity,
			tier: entry.tier,
			confirmed: entry.confirmed,
		},
	};
}

function parseFindingsEnvelope(raw: string): { ok: true; findings: LiveQaFinding[] } | { ok: false; reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, reason: `findings.json is not valid JSON: ${(error as Error).message}` };
	}
	const list: unknown[] | null = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed.findings)
			? parsed.findings
			: null;
	if (list === null) {
		return { ok: false, reason: "findings.json is not a valid findings envelope (expected an array or {findings:[...]})" };
	}
	const findings: LiveQaFinding[] = [];
	for (let i = 0; i < list.length; i++) {
		const validated = validateFindingEntry(list[i], i);
		if (!validated.ok) return { ok: false, reason: validated.reason };
		findings.push(validated.finding);
	}
	return { ok: true, findings };
}

// -----------------------------------------------------------------------------
// results.md parsing (Forge's own prompt contract, scripts/qa/prompts/common.md item 3: a
// Markdown table with a `Result` column whose values are exactly PASS|FAIL|BLOCKED; mirrors
// Forge's own readiness check, cli.ts ~425-430: >=1 `| PASS |` row and no FAIL/BLOCKED for GO).
// -----------------------------------------------------------------------------

const TABLE_SEPARATOR_CELL_RE = /^:?-+:?$/;
const RESULT_VALUES = new Set(["PASS", "FAIL", "BLOCKED"]);

function splitTableRow(line: string): string[] {
	const cells = line.split("|").map((c) => c.trim());
	// A well-formed `| a | b |` row has an empty leading and trailing cell from the outer pipes;
	// strip them, but only when actually empty (a malformed row missing outer pipes is not
	// silently reshaped).
	if (cells.length > 0 && cells[0] === "") cells.shift();
	if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
	return cells;
}

/**
 * Parses results.md's Markdown table and returns every value found in its `Result` column.
 * `ok: false` (missing/unparseable/no result rows) is the caller's cue to treat the whole
 * artifact as unavailable evidence — never silently treated as "no findings"/pass.
 */
function parseResultsMd(raw: string): { ok: true; rows: ("PASS" | "FAIL" | "BLOCKED")[] } | { ok: false; reason: string } {
	const tableLines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("|"));
	if (tableLines.length < 2) {
		return { ok: false, reason: "results.md has no Markdown table (Forge's prompt contract requires one with a Result column)" };
	}
	const headerCells = splitTableRow(tableLines[0]);
	const resultIdx = headerCells.findIndex((c) => c.toLowerCase() === "result");
	if (resultIdx === -1) {
		return { ok: false, reason: "results.md table has no Result column" };
	}
	const rows: ("PASS" | "FAIL" | "BLOCKED")[] = [];
	for (const line of tableLines.slice(1)) {
		const cells = splitTableRow(line);
		if (cells.every((c) => c === "" || TABLE_SEPARATOR_CELL_RE.test(c))) continue; // header separator row
		const value = cells[resultIdx]?.trim();
		if (value === undefined || !RESULT_VALUES.has(value)) {
			return {
				ok: false,
				reason: `results.md Result column contains "${value ?? "(missing)"}", not exactly PASS|FAIL|BLOCKED`,
			};
		}
		rows.push(value as "PASS" | "FAIL" | "BLOCKED");
	}
	if (rows.length === 0) return { ok: false, reason: "results.md table has no result rows" };
	return { ok: true, rows };
}

export interface LiveQaVerdict {
	verdict: "pass" | "fail" | "unavailable";
	reasons: string[];
	session_id: string | null;
	session_dir: string | null;
	findings: LiveQaFinding[];
	observations_count: number;
	/** Paths relative to `runnerCwd`. */
	artifacts: string[];
	usage: LiveQaUsageV2 | null;
	exit_code: number | null;
}

const SESSION_DIR_NAME_RE = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;
const SESSION_ARTIFACT_NAMES = ["report.md", "findings.json", "usage.json", "results.md", "stack.log"];

// A same-second write can legitimately land a filesystem mtime a few hundred ms "before"
// `startedAtMs` even though the artifact was genuinely written by THIS invocation: `startedAtMs`
// is captured in-process immediately before `spawn()`, and some filesystems/bind-mount layers
// (notably 1-second-resolution mtime truncation on certain overlay/FAT-derived mounts, and
// scheduling jitter between the parent capturing `Date.now()` and the child's first write)
// round or lag rather than reporting a precise sub-millisecond timestamp. 2000ms comfortably
// absorbs 1s truncation plus scheduling jitter while still rejecting anything that is actually
// stale (seconds-to-minutes old, the case this guard exists to catch).
const FRESHNESS_SLACK_MS = 2000;

type ConfinementResult = { ok: true; real: string; lstat: Stats } | { ok: false; reason: string };

/**
 * lstat's `targetPath` (never following a symlink at that exact path) and rejects it outright if
 * it IS a symlink — regardless of where the symlink points, since a symlink at a path Forge is
 * expected to have written as a plain file is itself a sign the artifact cannot be trusted.
 * Then realpath's it and rejects if the result is not inside `rootReal` (`path.relative` must not
 * start with `..` and must not be absolute — the two ways a resolved path can escape a root).
 * The `lstat` taken here is returned to the caller so a later, TOCTOU-safe re-open of the SAME
 * path (`readConfinedArtifact`) can confirm nothing was swapped in between (see its doc comment).
 */
export function checkConfined(targetPath: string, rootReal: string, label: string, opts: { rejectSelf?: boolean } = {}): ConfinementResult {
	let lst: ReturnType<typeof lstatSync>;
	try {
		lst = lstatSync(targetPath);
	} catch (error) {
		return { ok: false, reason: `${label} ${targetPath} does not exist: ${(error as Error).message}` };
	}
	if (lst.isSymbolicLink()) {
		return { ok: false, reason: `${label} ${targetPath} is a symlink; refusing to follow it` };
	}
	let real: string;
	try {
		real = realpathSync(targetPath);
	} catch (error) {
		return { ok: false, reason: `${label} ${targetPath} could not be resolved: ${(error as Error).message}` };
	}
	const rel = relative(rootReal, real);
	if ((opts.rejectSelf && rel === "") || rel.startsWith("..") || isAbsolute(rel)) {
		return { ok: false, reason: `${label} ${targetPath} escapes ${rootReal} (resolves to ${real})` };
	}
	return { ok: true, real, lstat: lst };
}

/** `path` must already be confinement-checked (never symlink-followed here); rejects an mtime
 *  older than `startedAtMs - FRESHNESS_SLACK_MS` (see slack rationale above `FRESHNESS_SLACK_MS`).
 *  Used only for the SESSION DIRECTORY (a directory, not eligible for `readConfinedArtifact`'s
 *  `isFile()`-only hardened open below) -- every regular-file artifact's freshness is checked via
 *  `readConfinedArtifact`'s own `fstat`ed mtime instead, closing the TOCTOU window a separate
 *  `statSync` call here would reopen. */
function checkFresh(path: string, label: string, startedAtMs: number): { ok: true } | { ok: false; reason: string } {
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(path);
	} catch (error) {
		return { ok: false, reason: `could not stat ${label} ${path}: ${(error as Error).message}` };
	}
	if (st.mtimeMs < startedAtMs - FRESHNESS_SLACK_MS) {
		return {
			ok: false,
			reason: `${label} ${path} predates this invocation (mtime ${st.mtimeMs} < invocation start ${startedAtMs} minus ${FRESHNESS_SLACK_MS}ms filesystem-mtime-granularity slack); a stale artifact cannot be trusted`,
		};
	}
	return { ok: true };
}

// 16 MiB: comfortably larger than any real report.md/findings.json/usage.json/results.md this
// module has ever seen, while still bounding the read against a runner/agent (compromised or
// merely buggy) that writes an unbounded amount of "evidence". An oversized artifact is treated
// as MISSING evidence (`unavailable`), never partially read and never a pass.
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * TOCTOU-hardened read of a session artifact whose path has ALREADY passed `checkConfined`
 * (`expectedLstat` is that call's own `lstat`, taken moments earlier). Opens with
 * `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` — `O_NOFOLLOW` refuses a symlink at this exact path even if
 * one appeared here after the earlier `lstat` (a second independent no-follow check, this time
 * enforced by the kernel at open time rather than by inspecting `lstat`'s result), and
 * `O_NONBLOCK` guarantees `open` never blocks even if the path was replaced with a FIFO with no
 * writer — the very next `fstat` below rejects a FIFO outright (never hangs waiting for one to
 * become readable). `fstatSync`s the resulting fd (never a second, separate `lstatSync`/`statSync`
 * call on the path, which could itself be swapped again in between) and rejects unless: (1) the
 * fd is a regular file; (2) its device/inode match `expectedLstat`'s — closing the TOCTOU window
 * between `checkConfined`'s lstat and this open, since a same-named replacement file would carry
 * different dev/ino; (3) the containing directory's realpath is STILL inside `rootReal` (a
 * directory-level swap — e.g. the session directory itself replaced with a symlinked tree between
 * `checkConfined` and this call — is caught here even though the file's own dev/ino might
 * coincidentally still differ); and (4) the file is at most `MAX_ARTIFACT_BYTES`. Reads via THAT
 * SAME fd (never `readFileSync(path)`, a second open that could race a swap performed after this
 * function's own fstat succeeded).
 */
export function readConfinedArtifact(
	real: string,
	rootReal: string,
	label: string,
	expectedLstat: Stats,
): { ok: true; content: string; mtimeMs: number } | { ok: false; reason: string } {
	let fd: number;
	try {
		fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	} catch (error) {
		return { ok: false, reason: `could not open ${label} ${real}: ${(error as Error).message}` };
	}
	try {
		let fst: ReturnType<typeof fstatSync>;
		try {
			fst = fstatSync(fd);
		} catch (error) {
			return { ok: false, reason: `could not fstat ${label} ${real}: ${(error as Error).message}` };
		}
		if (!fst.isFile()) {
			return { ok: false, reason: `${label} ${real} is not a regular file (fstat reports a different type, e.g. a FIFO/socket/device); refusing to read it` };
		}
		if (fst.dev !== expectedLstat.dev || fst.ino !== expectedLstat.ino) {
			return { ok: false, reason: `${label} ${real} changed between its confinement check and this read (device/inode mismatch); refusing to trust it` };
		}
		let parentReal: string;
		try {
			parentReal = realpathSync(dirname(real));
		} catch (error) {
			return { ok: false, reason: `${label} ${real}'s parent directory could not be resolved: ${(error as Error).message}` };
		}
		const parentRel = relative(rootReal, parentReal);
		if (parentRel.startsWith("..") || isAbsolute(parentRel)) {
			return { ok: false, reason: `${label} ${real}'s parent directory no longer resolves inside ${rootReal} (resolves to ${parentReal}); refusing to trust it` };
		}
		if (fst.size > MAX_ARTIFACT_BYTES) {
			return { ok: false, reason: `${label} ${real} is ${fst.size} bytes, over the ${MAX_ARTIFACT_BYTES}-byte artifact size limit; treating it as unreadable evidence` };
		}
		const buf = Buffer.alloc(fst.size);
		let offset = 0;
		while (offset < buf.length) {
			const n = readSync(fd, buf, offset, buf.length - offset, offset);
			if (n <= 0) break;
			offset += n;
		}
		return { ok: true, content: buf.slice(0, offset).toString("utf-8"), mtimeMs: fst.mtimeMs };
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* best-effort */
		}
	}
}

/** Wraps `readConfinedArtifact`'s freshness bar (`mtimeMs`) with the same slack-adjusted comparison
 *  `checkFresh` uses, for a hardened artifact read whose caller does not need the content. */
function isConfinedArtifactFresh(mtimeMs: number, label: string, real: string, startedAtMs: number): { ok: true } | { ok: false; reason: string } {
	if (mtimeMs < startedAtMs - FRESHNESS_SLACK_MS) {
		return {
			ok: false,
			reason: `${label} ${real} predates this invocation (mtime ${mtimeMs} < invocation start ${startedAtMs} minus ${FRESHNESS_SLACK_MS}ms filesystem-mtime-granularity slack); a stale artifact cannot be trusted`,
		};
	}
	return { ok: true };
}

/** Minimal, injectable subset of `fs.Stats` this function needs -- lets tests simulate an
 *  ancestor directory's uid/mode (root ownership, a foreign uid, the sticky bit) without needing
 *  to actually run as root or create a foreign-owned directory on disk. `lstatSync` itself already
 *  satisfies this shape structurally, so it is the default with no wrapping needed. */
export type AncestryLstat = Pick<Stats, "uid" | "mode"> & { isSymbolicLink(): boolean; isDirectory(): boolean };

/**
 * S7 (bounded, RESIDUAL-RISK-ACCEPTED mitigation for an ancestor-directory TOCTOU window -- see
 * docs/LIVE_QA.md's "Ancestor-directory ownership/writability" section for the full rationale).
 * Node has no `openat2(RESOLVE_NO_SYMLINKS)`/`O_BENEATH` equivalent, so there is no way to
 * atomically bind "the path I just confirmed is safe" to "the path I am about to open" across
 * every ANCESTOR directory the way `O_NOFOLLOW` does for the final path component alone (see
 * `readConfinedArtifact`'s own doc comment for that narrower guarantee, which this function
 * supplements, never replaces). Between `checkConfined`'s `realpathSync` and the eventual
 * `openSync`/`readSync` in `readConfinedArtifact`, an ancestor directory anywhere between the
 * session directory and the runner's own trusted root could in principle be removed and replaced
 * with a symlink by a CONCURRENT process -- no read-only syscall sequence available to plain Node
 * can close that window outright.
 *
 * An earlier version of this check stopped walking at (and including) `trustedRootReal` (the
 * adapter's configured `runner_cwd`). That left an real gap: the PARENT of `runner_cwd` (and
 * every directory above it, up to the filesystem root) was never inspected at all, so a
 * DIFFERENT uid with write access to `runner_cwd`'s parent could rename/replace the entire
 * `runner_cwd` tree (including everything beneath it, session directories and all) out from
 * under this process between the confinement check and the artifact read, and this function would
 * never have noticed -- the swap happens ABOVE the directory this check used to stop at. This
 * version walks all the way to the filesystem root `/`, so every directory in the chain --
 * including everything above `runner_cwd` -- is inspected.
 *
 * Walking all the way to `/` unavoidably passes through directories this process does not own
 * and did not create (`/`, `/private`, `/tmp`, `/Users`, etc. on macOS; `/`, `/tmp` on Linux),
 * which the ORIGINAL (uid-must-match-exactly, never group/world-writable) rule would always
 * reject -- `/tmp`/`/private/tmp` are deliberately world-writable with the STICKY bit set
 * instead. Each directory in the chain must therefore satisfy ONE of:
 *   (a) owned by THIS process's own uid (`process.getuid()`) or by uid 0 (root), AND not
 *       group- or world-writable (`mode & 0o022 === 0`); or
 *   (b) owned by uid 0 (root) AND has the sticky bit set (`mode & 0o1000`, e.g. `/tmp`,
 *       `/private/tmp`, mode `1777`) -- the sticky bit means only the OWNER of an entry inside
 *       this directory (or root) can rename/unlink that entry, so a sibling directory can never
 *       be swapped by an unrelated uid; but the sticky bit says nothing about entries ABOVE it,
 *       so this alternative additionally requires the directory immediately BELOW it in this
 *       chain (the entry `dir` itself protects) to already be confirmed owned by this process's
 *       own uid or root -- otherwise the sticky bit is protecting an entry that was never trusted
 *       in the first place.
 * Only a process already running as the SAME uid as this orchestrator process (or root) could
 * then perform the swap, and such a process already holds every privilege this orchestrator
 * process holds -- it gains nothing from this race that it could not already do directly. That
 * turns an otherwise-open TOCTOU window into "no privilege escalation beyond what an
 * equally-privileged process already has", which is the strongest guarantee achievable without a
 * kernel primitive Node does not expose. Any check that cannot be performed at all (no
 * `process.getuid`, e.g. Windows) fails closed like every other check here:
 * unreadable/unverifiable artifacts must never be treated as evidence of a pass.
 *
 * Callers must invoke this IMMEDIATELY BEFORE the artifact reads it protects (never once, far
 * earlier, at session-directory-confinement time) to keep the window between this check and the
 * read it guards as small as this module can make it.
 */
export function verifyTrustedAncestry(
	fromDirReal: string,
	trustedRootReal: string,
	opts: { lstat?: (path: string) => AncestryLstat } = {},
): { ok: true } | { ok: false; reason: string } {
	if (typeof process.getuid !== "function") {
		return {
			ok: false,
			reason: "cannot verify ancestor directory ownership on this platform (process.getuid is unavailable); refusing to trust artifacts under an unverifiable directory chain",
		};
	}
	const uid = process.getuid();
	const lstat = opts.lstat ?? ((p: string) => lstatSync(p));

	// Sanity check, performed once up front (never repeated per-iteration below): `fromDirReal`
	// must actually resolve at or under `trustedRootReal` -- a caller bug otherwise (this function
	// walks all the way to filesystem root regardless, so it can no longer detect this by "reached
	// root without ever passing through trustedRootReal" the way an earlier version did).
	const rootRel = relative(trustedRootReal, fromDirReal);
	if (rootRel !== "" && (rootRel.startsWith("..") || isAbsolute(rootRel))) {
		return { ok: false, reason: `${fromDirReal} does not resolve under trusted root ${trustedRootReal}; cannot verify ancestor ownership` };
	}

	let dir = fromDirReal;
	// uid of the directory immediately BELOW `dir` in this walk (the previous iteration's `dir`) --
	// `null` only on the very first iteration (`fromDirReal` itself has no child in THIS chain to
	// vouch for it; it is trusted via the caller's own confinement checks, not via this mechanism).
	// Used only by the sticky-root-owned alternative below.
	let childUid: number | null = null;
	// Bounded by construction: `dirname("/")` is `"/"` itself, so this loop always terminates once
	// `dir === "/"` -- a finite number of steps equal to `fromDirReal`'s own path depth, never an
	// unbounded loop.
	for (;;) {
		let lst: AncestryLstat;
		try {
			lst = lstat(dir);
		} catch (error) {
			return { ok: false, reason: `could not lstat ${dir} while verifying trusted ancestry: ${(error as Error).message}` };
		}
		if (lst.isSymbolicLink()) {
			return { ok: false, reason: `${dir} is a symlink; refusing to trust artifacts beneath it (the ancestor directory chain up to the filesystem root must contain no symlinks)` };
		}
		if (!lst.isDirectory()) {
			return { ok: false, reason: `${dir} is not a directory; refusing to trust artifacts beneath it` };
		}
		const stickyRootOwned = (lst.mode & 0o1000) !== 0 && lst.uid === 0;
		if (stickyRootOwned) {
			// The sticky bit protects entries INSIDE `dir` from being renamed/replaced by another uid;
			// it says nothing about `dir` ITSELF, so this alternative buys nothing unless the entry
			// immediately below `dir` in this chain (the one this iteration walked up FROM) is already
			// confirmed owned by this process's own uid or root.
			if (childUid === null || (childUid !== uid && childUid !== 0)) {
				return {
					ok: false,
					reason: `${dir} is a sticky, root-owned directory (mode ${(lst.mode & 0o7777).toString(8)}), but the directory immediately beneath it in this chain is not confirmed owned by this process's own uid ${uid} or root; the sticky bit protects entries inside ${dir}, not ${dir} itself, so this cannot be trusted`,
				};
			}
		} else {
			if (lst.uid !== uid && lst.uid !== 0) {
				return {
					ok: false,
					reason: `${dir} is owned by uid ${lst.uid}, not this process's own uid ${uid} or root; refusing to trust artifacts beneath a directory not owned by a trusted uid`,
				};
			}
			if ((lst.mode & 0o022) !== 0) {
				return {
					ok: false,
					reason: `${dir} is group- or world-writable (mode ${(lst.mode & 0o777).toString(8)}); refusing to trust artifacts beneath a directory writable by anyone other than this process's own uid or root`,
				};
			}
		}
		if (dir === "/") return { ok: true };
		childUid = lst.uid;
		dir = dirname(dir);
	}
}

/**
 * Redacts every persisted STRING field of a `LiveQaVerdict` before it is returned from
 * `parseLiveQaSession`: finding titles/fingerprints, verdict `reasons` (which embed finding
 * titles/fingerprints), artifact paths, and usage.json's own string fields (runtime/model/
 * provider/effort/costSource), using the SAME `redactSecrets` applied to runner stdout/stderr
 * (S3/S4). These strings originate from files the runner (and, transitively, the QA agent it
 * ran) wrote inside the candidate's working tree; a misbehaving or compromised runner/agent
 * could echo a credential into a finding title or a results.md cell exactly as readily as into a
 * stdout line, and every one of these fields is later persisted into outcome/cost rows and
 * summary lines (see `liveQaVerificationOutcomeFor`, `liveQaCostRows`).
 */
function redactVerdict(verdict: LiveQaVerdict): LiveQaVerdict {
	const env = process.env;
	const r = (s: string) => redactSecrets(s, env);
	return {
		...verdict,
		reasons: verdict.reasons.map(r),
		findings: verdict.findings.map((f) => ({ ...f, title: r(f.title), fingerprint: r(f.fingerprint) })),
		artifacts: verdict.artifacts.map(r),
		usage: verdict.usage
			? {
				...verdict.usage,
				agent: {
					...verdict.usage.agent,
					runtime: verdict.usage.agent.runtime !== null ? r(verdict.usage.agent.runtime) : null,
					model: verdict.usage.agent.model !== null ? r(verdict.usage.agent.model) : null,
					provider: verdict.usage.agent.provider !== null ? r(verdict.usage.agent.provider) : null,
					effort: verdict.usage.agent.effort !== null ? r(verdict.usage.agent.effort) : null,
					costSource: r(verdict.usage.agent.costSource),
				},
			}
			: null,
	};
}

/**
 * Structured pass/fail/unavailable verdict from the runner's own artifacts. Required live QA
 * that is unavailable means unverified, never passed: any confirmed tier 1/2 finding is a fail
 * even when the process exited 0; a clean exit with missing/malformed required artifacts is
 * "unavailable", never a pass.
 *
 * Run-id binding (Forge cli.ts:384-399, 506-619: `durable = join(repoRoot, 'qa/sessions', runId)`,
 * `reportPath = join(durable, 'report.md')`): the session this verdict is built from must be the
 * one produced by THIS invocation, identified by `runnerRunId` parsed from THIS invocation's own
 * `[qa slot=N run=<id>]` log prefix (never from the reported path alone, which a compromised or
 * buggy runner could point anywhere). A missing `runnerRunId`, a `reportPath` that does not
 * resolve to exactly `<runnerCwd>/qa/sessions/<runnerRunId>/report.md` (realpath'd, rejecting a
 * symlink escape out of the sessions root), or session artifacts that predate this invocation's
 * start time (`startedAtMs`, a second guard against a stale pre-existing session directory being
 * mistaken for a fresh one) are all "unavailable", never a pass.
 */
export function parseLiveQaSession(opts: {
	runnerCwd: string;
	reportPath: string | null;
	/** Forge's own run id for THIS invocation, parsed from its `[qa slot=N run=<id>]` output. */
	runnerRunId: string | null;
	exitCode: number | null;
	/** Epoch ms captured before this invocation was spawned; session artifacts must not predate it. */
	startedAtMs: number;
}): LiveQaVerdict {
	const unavailable = (reason: string, extra: Partial<LiveQaVerdict> = {}): LiveQaVerdict => redactVerdict({
		verdict: "unavailable",
		reasons: [reason],
		session_id: null,
		session_dir: null,
		findings: [],
		observations_count: 0,
		artifacts: [],
		usage: null,
		exit_code: opts.exitCode,
		...extra,
	});

	if (!opts.reportPath) {
		return unavailable(
			"no session report produced (preflight failure: docker, version mismatch, busy slot, bad environment, or a usage error before a session directory existed)",
		);
	}
	if (!opts.runnerRunId) {
		return unavailable(
			"no run id was parsed from this invocation's own output (missing '[qa slot=N run=<id>] ' prefix); a session cannot be trusted as belonging to this invocation without it",
		);
	}
	if (!SESSION_DIR_NAME_RE.test(opts.runnerRunId)) {
		return unavailable(`this invocation's run id "${opts.runnerRunId}" does not match the expected run-YYYYMMDD-HHMMSS-hex pattern`);
	}

	// Sessions-root confinement (S5): both `<runnerCwd>/qa` and `<runnerCwd>/qa/sessions` are
	// lstat'd and rejected if EITHER is a symlink (never followed, regardless of target) before
	// realpath is ever consulted, and the resolved sessions root must itself resolve to somewhere
	// under `runnerCwd`'s own realpath -- a runner_cwd whose `qa` or `qa/sessions` has been replaced
	// with a symlink (e.g. pointing at `/` or another user's directory) must never be trusted as
	// this invocation's sessions root.
	const qaDirPath = join(opts.runnerCwd, "qa");
	const sessionsDirPath = join(qaDirPath, "sessions");
	let runnerCwdReal: string;
	try {
		runnerCwdReal = realpathSync(opts.runnerCwd);
	} catch {
		return unavailable(`runner_cwd ${opts.runnerCwd} does not exist`);
	}
	for (const [label, p] of [["qa directory", qaDirPath], ["qa/sessions directory", sessionsDirPath]] as const) {
		let lst: ReturnType<typeof lstatSync>;
		try {
			lst = lstatSync(p);
		} catch (error) {
			return unavailable(`${label} ${p} does not exist: ${(error as Error).message}`);
		}
		if (lst.isSymbolicLink()) return unavailable(`${label} ${p} is a symlink; refusing to follow it`);
	}
	let sessionsRootReal: string;
	try {
		sessionsRootReal = realpathSync(sessionsDirPath);
	} catch {
		return unavailable(`runner sessions root ${sessionsDirPath} does not exist`);
	}
	const sessionsRootRel = relative(runnerCwdReal, sessionsRootReal);
	if (sessionsRootRel.startsWith("..") || isAbsolute(sessionsRootRel)) {
		return unavailable(`runner sessions root ${sessionsDirPath} escapes runner_cwd ${opts.runnerCwd} (resolves to ${sessionsRootReal})`);
	}

	// The ONLY session directory this invocation is permitted to bind to: the one at
	// `<runnerCwd>/qa/sessions/<runnerRunId>`, per this invocation's own parsed run id -- never
	// wherever `opts.reportPath` happens to point. `lstatSync`-checked first: the session
	// directory ITSELF must not be a symlink, regardless of where it points.
	const expectedSessionDir = join(opts.runnerCwd, "qa", "sessions", opts.runnerRunId);
	const sessionDirConfinement = checkConfined(expectedSessionDir, sessionsRootReal, "session directory", { rejectSelf: true });
	if (!sessionDirConfinement.ok) return unavailable(sessionDirConfinement.reason);
	const sessionDirReal = sessionDirConfinement.real;

	// S7: before trusting ANY artifact read beneath `sessionDirReal` (report.md, findings.json,
	// usage.json, results.md alike), verify every ancestor directory from the session directory up
	// to the FILESYSTEM ROOT ('/', not merely `runnerCwdReal`/the adapter's configured
	// `runner_cwd` -- an earlier version stopped there, leaving `runner_cwd`'s own parent tree
	// unchecked) is free of symlinks and either owned by this process's own uid/root and not
	// group/world-writable, or a root-owned sticky directory whose child in the chain is trusted --
	// see `verifyTrustedAncestry`'s doc comment for the residual-risk rationale this bounds (it
	// cannot eliminate the TOCTOU window Node's lack of an openat/O_BENEATH-equivalent leaves
	// open). Any failure here means artifacts are UNREADABLE evidence, never a pass.
	const ancestryCheck = verifyTrustedAncestry(sessionDirReal, runnerCwdReal);
	if (!ancestryCheck.ok) return unavailable(ancestryCheck.reason);

	// report.md must exist directly inside the session directory, as a real file (not a symlink,
	// regardless of target), and inside `sessionDirReal`.
	const expectedReportPath = join(sessionDirReal, "report.md");
	const reportConfinement = checkConfined(expectedReportPath, sessionDirReal, "report.md");
	if (!reportConfinement.ok) return unavailable(reportConfinement.reason);

	// The runner's OWN reported `reportPath` (parsed from its `report: <path>` log line) must
	// resolve to that exact confined file -- never merely "a report.md somewhere".
	let reportPathReal: string;
	try {
		reportPathReal = realpathSync(opts.reportPath);
	} catch {
		return unavailable(`reported report path ${opts.reportPath} does not exist`);
	}
	if (reportPathReal !== reportConfinement.real) {
		return unavailable(
			`reported report path ${opts.reportPath} does not resolve to this invocation's expected report path ${expectedReportPath} (run id mismatch or path escape)`,
		);
	}

	// Freshness guard against a stale pre-existing (already-clean) session/artifact being reused:
	// neither the session directory nor report.md may predate this invocation's start (beyond
	// `FRESHNESS_SLACK_MS`, justified above the constant). findings.json/usage.json/results.md are
	// checked the same way (via `readConfinedArtifact`'s own fstat'ed mtime) once their own
	// confinement is validated below.
	const sessionDirFresh = checkFresh(sessionDirReal, "session directory", opts.startedAtMs);
	if (!sessionDirFresh.ok) return unavailable(sessionDirFresh.reason);
	const reportRead = readConfinedArtifact(reportConfinement.real, sessionDirReal, "report.md", reportConfinement.lstat);
	if (!reportRead.ok) return unavailable(reportRead.reason);
	const reportFresh = isConfinedArtifactFresh(reportRead.mtimeMs, "report.md", reportConfinement.real, opts.startedAtMs);
	if (!reportFresh.ok) return unavailable(reportFresh.reason);

	const sessionId = opts.runnerRunId;
	const relSessionDir = relative(opts.runnerCwd, sessionDirReal);

	// Every artifact name is confinement-checked (lstat: not a symlink; realpath: inside
	// `sessionDirReal`) before being trusted for anything -- including merely being listed in
	// `artifacts`. A symlink or path-escape at a non-required artifact name (results.md,
	// stack.log) is simply omitted from `artifacts` rather than followed; at a REQUIRED artifact
	// name (findings.json, usage.json when present) it makes the verdict "unavailable" below.
	const confinedArtifacts = new Map<string, ConfinementResult & { ok: true }>();
	for (const name of SESSION_ARTIFACT_NAMES) {
		const p = join(sessionDirReal, name);
		try {
			lstatSync(p);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return unavailable(`could not inspect ${name}: ${(error as Error).message}`, {
				session_id: sessionId, session_dir: relSessionDir,
			});
		}
		const confinement = checkConfined(p, sessionDirReal, name);
		if (confinement.ok) {
			confinedArtifacts.set(name, confinement);
		} else if (name === "findings.json" || name === "usage.json" || name === "results.md") {
			return unavailable(confinement.reason, { session_id: sessionId, session_dir: relSessionDir });
		}
	}
	confinedArtifacts.set("report.md", reportConfinement);
	const artifacts = [...confinedArtifacts.values()].map((c) => relative(opts.runnerCwd, c.real));

	const findingsConfinement = confinedArtifacts.get("findings.json");
	if (!findingsConfinement) {
		return unavailable("session directory has no findings.json (incomplete run, or it failed a symlink/path-confinement check)", {
			session_id: sessionId, session_dir: relSessionDir, artifacts,
		});
	}
	const findingsRead = readConfinedArtifact(findingsConfinement.real, sessionDirReal, "findings.json", findingsConfinement.lstat);
	if (!findingsRead.ok) return unavailable(findingsRead.reason, { session_id: sessionId, session_dir: relSessionDir, artifacts });
	const findingsFresh = isConfinedArtifactFresh(findingsRead.mtimeMs, "findings.json", findingsConfinement.real, opts.startedAtMs);
	if (!findingsFresh.ok) return unavailable(findingsFresh.reason, { session_id: sessionId, session_dir: relSessionDir, artifacts });

	const parsedFindings = parseFindingsEnvelope(findingsRead.content);
	if (!parsedFindings.ok) {
		return unavailable(parsedFindings.reason, { session_id: sessionId, session_dir: relSessionDir, artifacts });
	}

	// usage.json is OPTIONAL (a run that never produced one is still a valid pass, see the
	// "missing usage.json is tolerated" test) -- but if it IS present, it is held to the same
	// confinement and freshness bar as findings.json/report.md; a present-but-untrustworthy
	// usage.json fails the whole verdict rather than being silently swapped for `null`, since
	// silently accepting an attacker-controlled usage.json would let it forge cost/telemetry data.
	const usageConfinement = confinedArtifacts.get("usage.json");
	let usage: LiveQaUsageV2 | null = null;
	if (usageConfinement) {
		const usageRead = readConfinedArtifact(usageConfinement.real, sessionDirReal, "usage.json", usageConfinement.lstat);
		if (!usageRead.ok) return unavailable(usageRead.reason, { session_id: sessionId, session_dir: relSessionDir, artifacts });
		const usageFresh = isConfinedArtifactFresh(usageRead.mtimeMs, "usage.json", usageConfinement.real, opts.startedAtMs);
		if (!usageFresh.ok) return unavailable(usageFresh.reason, { session_id: sessionId, session_dir: relSessionDir, artifacts });
		usage = readUsage(usageRead.content);
	}
	const confirmedSerious = parsedFindings.findings.filter((f) => f.confirmed && (f.tier === 1 || f.tier === 2));
	const observationsCount = parsedFindings.findings.filter((f) => f.tier === 3).length;

	if (confirmedSerious.length > 0) {
		return redactVerdict({
			verdict: "fail",
			reasons: confirmedSerious.map((f) => `confirmed tier ${f.tier} finding ${f.fingerprint || "(no fingerprint)"}: ${f.title}`),
			session_id: sessionId, session_dir: relSessionDir,
			findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage,
			exit_code: opts.exitCode,
		});
	}

	// results.md (T5): REQUIRED, and held to the same confinement/freshness bar as findings.json --
	// Forge's own prompt contract (scripts/qa/prompts/common.md item 3) requires it as a Markdown
	// table with a `Result` column of exactly PASS|FAIL|BLOCKED, mirroring Forge's own readiness
	// check (cli.ts ~425-430: >=1 `| PASS |` row and no FAIL/BLOCKED for GO). Missing, unparseable,
	// or containing no result rows at all is "unavailable", never a pass; any FAIL row is a fail
	// (even with a clean exit and no confirmed finding); any BLOCKED row (with no FAIL) is
	// "unavailable" (blocked is not a pass); only when every row is PASS does the ordinary exit-code
	// check below get to decide.
	const resultsConfinement = confinedArtifacts.get("results.md");
	if (!resultsConfinement) {
		return unavailable("session directory has no results.md (Forge's prompt contract requires a Result-column Markdown table)", {
			session_id: sessionId, session_dir: relSessionDir, findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage,
		});
	}
	const resultsRead = readConfinedArtifact(resultsConfinement.real, sessionDirReal, "results.md", resultsConfinement.lstat);
	if (!resultsRead.ok) {
		return unavailable(resultsRead.reason, { session_id: sessionId, session_dir: relSessionDir, findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage });
	}
	const resultsFresh = isConfinedArtifactFresh(resultsRead.mtimeMs, "results.md", resultsConfinement.real, opts.startedAtMs);
	if (!resultsFresh.ok) {
		return unavailable(resultsFresh.reason, { session_id: sessionId, session_dir: relSessionDir, findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage });
	}
	const parsedResults = parseResultsMd(resultsRead.content);
	if (!parsedResults.ok) {
		return unavailable(parsedResults.reason, { session_id: sessionId, session_dir: relSessionDir, findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage });
	}
	if (parsedResults.rows.includes("FAIL")) {
		const failCount = parsedResults.rows.filter((r) => r === "FAIL").length;
		return redactVerdict({
			verdict: "fail",
			reasons: [`results.md reports ${failCount} FAIL result(s)`],
			session_id: sessionId, session_dir: relSessionDir,
			findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage,
			exit_code: opts.exitCode,
		});
	}
	if (parsedResults.rows.includes("BLOCKED")) {
		return unavailable("results.md reports BLOCKED result(s); a blocked run is unverified, never a pass", {
			session_id: sessionId, session_dir: relSessionDir, findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage,
		});
	}

	if (opts.exitCode === 0) {
		return redactVerdict({
			verdict: "pass",
			reasons: [],
			session_id: sessionId, session_dir: relSessionDir,
			findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage,
			exit_code: opts.exitCode,
		});
	}

	return unavailable(
		`runner exited with code ${opts.exitCode ?? "null"} and no confirmed tier 1/2 finding; an incomplete run is not a pass`,
		{ session_id: sessionId, session_dir: relSessionDir, findings: parsedFindings.findings, observations_count: observationsCount, artifacts, usage },
	);
}

// -----------------------------------------------------------------------------
// Cost linking
// -----------------------------------------------------------------------------

/**
 * No double counting: Forge runs Codex QA sessions with `exec --ephemeral`
 * (scripts/qa/runtimes/codex.ts) and HUMAIN Terminal QA sessions with `--no-session`
 * (scripts/qa/runtimes/humain-terminal.ts) inside a temporary agent dir it creates per session.
 * The orchestrator's own ingest (orchestrator/ingest.py) only scans `~/.codex/sessions/*` and
 * `~/.humain-terminal/agent/sessions/<id>/` `.jsonl` files — an ephemeral/no-session run never
 * writes there, so ingest can never see (and re-bill) a live-QA session. These rows are the ONLY place a live-QA
 * session's cost is ever recorded.
 */
export function liveQaCostRows(params: {
	runId: string;
	taskId: string;
	adapterId: string;
	verdict: LiveQaVerdict;
}): Record<string, unknown>[] {
	const { runId, taskId, adapterId, verdict } = params;
	// T4: a missing `session_id` must never collapse into a shared `:unknown` record_id across
	// runs (two different runs' agent rows would then dedup against each other in the Python-side
	// `unique_records` join). This invocation-unique id (a stage runs at most once per run, per
	// live-qa-stage.ts) keeps every such row distinct.
	const recordKey = verdict.session_id ?? `${runId}:${adapterId}:no-session`;
	const agent = verdict.usage?.agent ?? null;
	const result = verdict.exit_code === 0 ? "pass" : "fail";
	const rows: Record<string, unknown>[] = [];

	const agentRow: Record<string, unknown> = {
		event: "model_call",
		record_id: `live-qa-agent:${recordKey}`,
		run_id: runId,
		task_id: taskId,
		role: "live_qa",
		capability: "live_qa",
		live_qa_session_id: verdict.session_id,
		live_qa_adapter: adapterId,
		live_qa_component: "agent",
		runtime: agent?.runtime ?? null,
		model: agent?.model ?? null,
		provider: agent?.provider ?? null,
		effort: agent?.effort ?? null,
		input_tokens: agent?.inputTokens ?? null,
		output_tokens: agent?.outputTokens ?? null,
		cached_input_tokens: agent?.cacheReadInputTokens ?? null,
		cache_write_tokens: agent?.cacheCreationInputTokens ?? null,
		cost_provenance: "forge-qa-usage.json-v2",
		result,
	};
	if (agent && typeof agent.elapsedMs === "number") agentRow.duration_ms = agent.elapsedMs;
	if (agent && typeof agent.costMicrocents === "number") {
		if (agent.costSource === "reported") {
			agentRow.cost_usd = agent.costMicrocents / 1e8;
			agentRow.cost_source = "reported";
		} else if (agent.costSource === "estimated") {
			agentRow.cost_usd = agent.costMicrocents / 1e8;
			agentRow.cost_source = "estimated-forge-qa-runtime-catalog";
		} else {
			// T3: cost provenance is unknown -- never set `cost_usd` (which economics.py's
			// `cost_class` would otherwise have to special-case); the number is kept ONLY as a
			// clearly-non-billable hint field, never summed into any total.
			agentRow.unattributed_cost_usd_hint = agent.costMicrocents / 1e8;
			agentRow.cost_source = "unknown-not-reported-by-qa-runtime";
		}
	} else {
		agentRow.cost_source = "unknown-not-reported-by-qa-runtime";
	}
	rows.push(agentRow);

	const humainCode = verdict.usage?.humainCode ?? null;
	if (humainCode && humainCode.status === "recorded") {
		const costMicrocents = humainCode.totals?.costMicrocents ?? null;
		const appRow: Record<string, unknown> = {
			event: "model_call",
			record_id: `live-qa-app:${recordKey}`,
			run_id: runId,
			task_id: taskId,
			role: "live_qa_app",
			capability: "live_qa",
			live_qa_session_id: verdict.session_id,
			live_qa_adapter: adapterId,
			live_qa_component: "app_under_test",
			cost_provenance: "forge-qa-usage.json-v2",
			result,
		};
		if (typeof costMicrocents === "number") {
			appRow.cost_usd = costMicrocents / 1e8;
			appRow.cost_source = "reported-forge-runs-cost-microcents";
		} else {
			appRow.cost_source = "unknown-forge-runs-cost-microcents-null";
		}
		rows.push(appRow);
	} else if (humainCode && humainCode.status === "unavailable") {
		rows.push({
			event: "model_call",
			record_id: `live-qa-app:${recordKey}`,
			run_id: runId,
			task_id: taskId,
			role: "live_qa_app",
			capability: "live_qa",
			live_qa_session_id: verdict.session_id,
			live_qa_adapter: adapterId,
			live_qa_component: "app_under_test",
			cost_provenance: "forge-qa-usage.json-v2",
			result,
			cost_source: "unknown-forge-runs-query-failed",
		});
	}
	// humainCode.status === "no_runs" (or usage.json entirely absent, i.e. `humainCode === null`):
	// no app row. The application under test was never exercised for cost purposes.

	return rows;
}

// -----------------------------------------------------------------------------
// Verification outcome
// -----------------------------------------------------------------------------

export interface LiveQaStage {
	adapterId: string;
	argv: string[];
	scope: string;
	revision: PreparedTestedRevision;
	verdict: LiveQaVerdict;
	required: boolean;
}

/**
 * `task_id` deliberately does NOT end in `-qa`: the Python side (records.py / the generic run
 * gate) treats any `*-qa` task id as the run's generic QA verdict. A live-QA stage is additive
 * evidence alongside that gate, never a replacement for it, so it gets its own suffix.
 */
export function liveQaVerificationOutcomeFor(runId: string, stage: LiveQaStage): Record<string, unknown> {
	const evidenceStatus = stage.verdict.verdict === "pass" || stage.verdict.verdict === "fail"
		? "verified"
		: "unverified_live_qa_unavailable";
	// S3: `stage.verdict.{reasons,findings,artifacts}` are already redacted by `redactVerdict`
	// inside `parseLiveQaSession`. `runner_argv`/`scope` are NOT runner output -- they are this
	// module's own constructed argv and the (user/lead-authored) scope text -- but a human could
	// still paste a credential into a scope string, or an adapter's own `argv_prefix` element
	// could echo one; redacted here with the SAME `redactSecrets` before persistence, for defense
	// in depth alongside the config-time `argv_prefix` credential-shape rejection.
	const env = process.env;
	return {
		run_id: runId,
		task_id: `${runId}-live-qa-stage`,
		verification_scope: "live_qa",
		outcome: stage.verdict.verdict === "pass" ? "verified" : stage.verdict.verdict === "fail" ? "fail" : "unavailable",
		evidence_status: evidenceStatus,
		live_qa_verdict: stage.verdict.verdict,
		reasons: stage.verdict.reasons,
		adapter: stage.adapterId,
		runner_argv: stage.argv.map((a) => redactSecrets(a, env)),
		scope: redactSecrets(stage.scope, env),
		tested_revision: stage.revision.sha,
		tested_tree: stage.revision.tree,
		base_head: stage.revision.base_head,
		checkpoint: stage.revision.checkpoint,
		checkpoint_ref: stage.revision.checkpoint_ref,
		component_exercised: stage.revision.component_exercised,
		...(stage.revision.component_exercised_reason ? { component_exercised_reason: stage.revision.component_exercised_reason } : {}),
		session_id: stage.verdict.session_id,
		findings: stage.verdict.findings,
		artifacts: stage.verdict.artifacts,
		required: stage.required,
		outcome_finality: "immediate",
	};
}

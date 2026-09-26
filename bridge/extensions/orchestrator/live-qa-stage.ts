/**
 * Phase 3 — wires the live-qa.ts adapter primitives (config, adapter selection, scope
 * validation, tested-revision proof, spawn, session parsing, cost rows, outcome row) into a
 * single `runLiveQaStage` call that `index.ts`'s `/orchestrate` handler invokes at most once per
 * run, only when explicitly requested. This module never invents policy beyond what live-qa.ts
 * already enforces: it selects at most one adapter, never spawns before every precondition
 * (config, adapter selection, scope, tested-revision proof) has passed, and always reports
 * "unavailable" (never "pass") for any failure that happens before the runner is spawned. It also
 * never reports "pass" for a run the runner's own SIGINT handling raced past -- see
 * `forceCancelledVerdict` -- even when the runner exits 0 with fully valid pass artifacts.
 */

import {
	buildRunnerArgv,
	gitRevParseHead,
	liveQaCostRows,
	liveQaVerificationOutcomeFor,
	loadLiveQaConfig,
	prepareTestedRevision,
	parseLiveQaSession,
	redactSecrets,
	runLiveQa,
	sanitizeForPersistence,
	validateScope,
	type LiveQaAdapterConfig,
	type LiveQaCancellationSignal,
	type LiveQaStage,
	type LiveQaVerdict,
	type PreparedTestedRevision,
} from "./live-qa.ts";

export interface LiveQaStageRequest {
	/** Explicit `--live-qa` (or implied by `--live-qa-scope`), never heuristically inferred. */
	requested: boolean;
	/** `--live-qa-adapter <id>`, when given. */
	adapterId?: string;
	/** `--live-qa-scope <scope>`, when given. */
	scope?: string;
}

export interface RunLiveQaStageOptions {
	request: LiveQaStageRequest;
	/** Never logged; passed straight to `loadLiveQaConfig`. */
	env: Record<string, string | undefined>;
	/** The candidate repository under test (the orchestrator's own `cwd`). */
	cwd: string;
	runId: string;
	changedFiles: string[];
	cancellation: LiveQaCancellationSignal;
	onLine: (line: string) => void;
	/** Fires synchronously right after the runner is spawned, for pid-tracking teardown in tests. */
	onSpawn?: (pid: number | undefined) => void;
	deps?: {
		loadLiveQaConfig?: typeof loadLiveQaConfig;
		prepareTestedRevision?: typeof prepareTestedRevision;
		runLiveQa?: typeof runLiveQa;
		parseLiveQaSession?: typeof parseLiveQaSession;
		now?: () => number;
	};
}

export interface RuntimeUnderTest {
	runtime: string | null;
	model: string | null;
	effort: string | null;
	humain_terminal_bin: string | null;
	runner_cwd: string | null;
	runner_head: string | null;
}

export interface RunLiveQaStageResult {
	stage: LiveQaStage | null;
	verdict: "pass" | "fail" | "unavailable" | "not_requested";
	required: boolean;
	reasons: string[];
	costRows: Record<string, unknown>[];
	outcomeRow: Record<string, unknown> | null;
	cancelled: boolean;
}

/** A `PreparedTestedRevision` for a stage that never got far enough to attempt the proof. */
function notStartedRevision(reason: string): PreparedTestedRevision {
	return {
		ok: false,
		reason,
		sha: null,
		tree: null,
		base_head: null,
		checkpoint: false,
		checkpoint_ref: null,
		component_exercised: false,
	};
}

function unavailableVerdict(reason: string): LiveQaVerdict {
	return {
		verdict: "unavailable",
		reasons: [reason],
		session_id: null,
		session_dir: null,
		findings: [],
		observations_count: 0,
		artifacts: [],
		usage: null,
		exit_code: null,
	};
}

/** When `runLiveQa` reports `cancelled: true`, the runner's own verdict must never be trusted as
 *  a completed pass -- see the call site in `runLiveQaStageUnsanitized` for why. Leaves every
 *  other field (`session_id`, `findings`, `observations_count`, `artifacts`, `usage`,
 *  `exit_code`) exactly as parsed: a cancelled run may still have incurred real, billable usage,
 *  and `liveQaCostRows` reads those fields straight off the returned verdict, so overriding them
 *  here would silently drop cost/usage evidence that a cancelled run legitimately produced. A
 *  verdict already `"unavailable"` is returned unchanged (nothing to force). */
function forceCancelledVerdict(verdict: LiveQaVerdict): LiveQaVerdict {
	if (verdict.verdict === "unavailable") return verdict;
	return {
		...verdict,
		verdict: "unavailable",
		reasons: [
			"run was cancelled; the runner's own verdict is never trusted after cancellation, even on a clean exit with pass-shaped artifacts",
			...verdict.reasons,
		],
	};
}

/** S3: `humain_terminal_bin` is only ever included when an adapter was actually selected (a
 *  request that never got that far has nothing meaningful to report here), and the value itself
 *  is redacted (S3) and rejected outright -- never merely redacted-in-place -- if it looks
 *  credential-shaped (a path someone mistakenly set to `TOKEN=...` or similar), since a bin path
 *  has no legitimate reason to contain credential-like text at all. */
function runtimeUnderTestFor(env: Record<string, string | undefined>, adapter: LiveQaAdapterConfig | null): RuntimeUnderTest {
	const rawBin = adapter ? (env.QA_HUMAIN_TERMINAL_BIN ?? null) : null;
	const CREDENTIAL_LIKE_RE = /token|secret|password|api[_-]?key|bearer/i;
	const humainTerminalBin = rawBin === null
		? null
		: CREDENTIAL_LIKE_RE.test(rawBin)
			? null
			: redactSecrets(rawBin, process.env);
	return {
		runtime: adapter?.runtime ?? null,
		model: adapter?.model ?? null,
		effort: adapter?.effort ?? null,
		humain_terminal_bin: humainTerminalBin,
		runner_cwd: adapter?.runner_cwd ?? null,
		runner_head: adapter ? gitRevParseHead(adapter.runner_cwd) : null,
	};
}

function buildOutcomeRow(
	runId: string,
	stage: LiveQaStage,
	env: Record<string, string | undefined>,
	adapter: LiveQaAdapterConfig | null,
): Record<string, unknown> {
	return {
		...liveQaVerificationOutcomeFor(runId, stage),
		// Forge runs Terminal with `--no-extensions --extension <its own>` (scripts/qa/runtimes/
		// humain-terminal.ts): this orchestrator extension is never loaded inside the runner it
		// spawns, so it can never be exercised by this stage, even on a `component_exercised: true`
		// (same-repo) run. Recorded unconditionally, not derived from `component_exercised`, which
		// answers a different question (does the runner's checkout resolve to this repo at all).
		orchestrator_extension_exercised: false,
		runtime_under_test: runtimeUnderTestFor(env, adapter),
	};
}

/**
 * Runs the Forge live-QA stage end to end, or determines (without ever spawning a process) that
 * it cannot run. Never throws on an ordinary precondition failure — those all resolve to
 * `verdict: "unavailable"`. Propagates only genuinely unexpected errors (e.g. `onLine` throwing).
 *
 * S3: this is a thin sanitizing wrapper around `runLiveQaStageUnsanitized` -- EVERY return path
 * of that inner function (not-requested, config/adapter-selection failure, scope/revision-proof
 * failure, and the full spawn-and-parse success path alike) is funnelled through here exactly
 * once, and `sanitizeForPersistence` is applied to every string anywhere in `stage` (the raw
 * `LiveQaStage` -- adapter id, argv, scope, revision, verdict -- that a caller may persist
 * directly, not only the flattened `reasons`/`costRows`/`outcomeRow` derived from it), `reasons`,
 * `costRows`, and `outcomeRow` (including `runtime_under_test`'s `runner_cwd` and the outcome
 * row's `adapter` id) before any of it is ever returned to a caller that will persist it.
 * `sanitizeForPersistence` never corrupts `stage.revision`'s git object ids (`sha`/`tree`/
 * `base_head`) while doing so -- see its own doc comment. A single seam here, rather than
 * redacting at each of the several return sites inside the inner function, is what makes this
 * guarantee "on every return path" actually checkable in one place.
 */
export async function runLiveQaStage(opts: RunLiveQaStageOptions): Promise<RunLiveQaStageResult> {
	const result = await runLiveQaStageUnsanitized(opts);
	const env = process.env;
	return {
		...result,
		stage: result.stage === null ? null : sanitizeForPersistence(result.stage, env),
		reasons: sanitizeForPersistence(result.reasons, env),
		costRows: sanitizeForPersistence(result.costRows, env),
		outcomeRow: result.outcomeRow === null ? null : sanitizeForPersistence(result.outcomeRow, env),
	};
}

async function runLiveQaStageUnsanitized(opts: RunLiveQaStageOptions): Promise<RunLiveQaStageResult> {
	const { request, env, cwd, runId, changedFiles, cancellation, onLine } = opts;
	const deps = opts.deps ?? {};
	const load = deps.loadLiveQaConfig ?? loadLiveQaConfig;
	const prepare = deps.prepareTestedRevision ?? prepareTestedRevision;
	const run = deps.runLiveQa ?? runLiveQa;
	const parseSession = deps.parseLiveQaSession ?? parseLiveQaSession;
	const now = deps.now ?? Date.now;

	if (!request.requested) {
		return { stage: null, verdict: "not_requested", required: false, reasons: [], costRows: [], outcomeRow: null, cancelled: false };
	}

	const taskId = `${runId}-live-qa-stage`;

	// A failure before an adapter is selected: an explicit request counts as required (there is
	// no adapter-level `required` flag to defer to yet).
	const failBeforeAdapter = (reason: string): RunLiveQaStageResult => {
		const stage: LiveQaStage = {
			adapterId: request.adapterId ?? "(none)",
			argv: [],
			scope: request.scope ?? "",
			revision: notStartedRevision(reason),
			verdict: unavailableVerdict(reason),
			required: true,
		};
		return {
			stage,
			verdict: "unavailable",
			required: true,
			reasons: [reason],
			costRows: [],
			outcomeRow: buildOutcomeRow(runId, stage, env, null),
			cancelled: false,
		};
	};

	const config = load(env);
	if (config.adapters.length === 0) {
		const detail = config.problems.map((p) => p.reason).join("; ");
		return failBeforeAdapter(
			detail ? `no valid live-QA adapter is configured (${detail})` : "no valid live-QA adapter is configured",
		);
	}

	let adapter: LiveQaAdapterConfig;
	if (request.adapterId) {
		const found = config.adapters.find((a) => a.id === request.adapterId);
		if (!found) {
			return failBeforeAdapter(
				`unknown live-QA adapter id "${request.adapterId}" (configured: ${config.adapters.map((a) => a.id).join(", ")})`,
			);
		}
		adapter = found;
	} else if (config.adapters.length === 1) {
		adapter = config.adapters[0];
	} else {
		return failBeforeAdapter(
			`ambiguous: ${config.adapters.length} valid live-QA adapters configured (${config.adapters.map((a) => a.id).join(", ")}); specify --live-qa-adapter <id>`,
		);
	}

	const required = adapter.required;

	// A failure after adapter selection: required now defers to the adapter's own flag.
	const failAfterAdapterSelection = (reason: string, scopeText: string, revision: PreparedTestedRevision): RunLiveQaStageResult => {
		const stage: LiveQaStage = {
			adapterId: adapter.id,
			argv: [],
			scope: scopeText,
			revision,
			verdict: unavailableVerdict(reason),
			required,
		};
		return {
			stage,
			verdict: "unavailable",
			required,
			reasons: [reason],
			costRows: [],
			outcomeRow: buildOutcomeRow(runId, stage, env, adapter),
			cancelled: false,
		};
	};

	const scopeValidation = validateScope(request.scope);
	if (!scopeValidation.ok) {
		return failAfterAdapterSelection(scopeValidation.reason, request.scope ?? "", notStartedRevision(scopeValidation.reason));
	}
	const scope = scopeValidation.scope;

	const revision = prepare({ candidateCwd: cwd, runnerCwd: adapter.runner_cwd, runId, changedFiles });
	if (!revision.ok) {
		return failAfterAdapterSelection(revision.reason ?? "tested-revision proof failed", scope, revision);
	}

	const argv = buildRunnerArgv(adapter, scope, revision.sha as string);
	const startedAtMs = now();
	const runResult = await run({ adapter, argv, signal: cancellation, onLine, onSpawn: opts.onSpawn });
	const parsedVerdict = parseSession({
		runnerCwd: adapter.runner_cwd,
		reportPath: runResult.reportPath,
		runnerRunId: runResult.runnerRunId,
		exitCode: runResult.exitCode,
		startedAtMs,
	});
	// A runner that receives SIGINT (because THIS run's own cancellation fired) but keeps running
	// long enough to write out fully valid, pass-shaped artifacts and exit 0 anyway did not run to
	// completion under this run's own control -- trusting that race as a genuine pass would
	// silently launder a cancelled run into a passing one. `usage`/`findings`/`artifacts`/
	// `session_id`/`exit_code` are left exactly as parsed (a cancelled run may still have incurred
	// real, billable usage, and `liveQaCostRows` below reads all of those straight off `verdict`) --
	// only `verdict`/`reasons` are overridden, and never to `pass`.
	const verdict = runResult.cancelled ? forceCancelledVerdict(parsedVerdict) : parsedVerdict;

	const stage: LiveQaStage = { adapterId: adapter.id, argv, scope, revision, verdict, required };
	const costRows = liveQaCostRows({ runId, taskId, adapterId: adapter.id, verdict });
	const outcomeRow = buildOutcomeRow(runId, stage, env, adapter);

	return {
		stage,
		verdict: verdict.verdict,
		required,
		reasons: verdict.reasons,
		costRows,
		outcomeRow,
		cancelled: runResult.cancelled,
	};
}

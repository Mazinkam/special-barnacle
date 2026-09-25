/**
 * Pure argv/env builder for the child `humain-terminal --mode json -p
 * --no-session ...` process a dispatch spawns (B4.5 step 1 — extracted from
 * `runSubagentProcess` in index.ts).
 *
 * Everything here is a pure function: no fs, no `process.env` reads, no
 * child-launcher access. The caller (currently index.ts's
 * `runSubagentProcess`, later dispatch/child-process.ts) resolves the persona
 * (dispatch/persona.ts) and passes its `promptPath`/`tools` in, and passes
 * `process.env` in explicitly as `baseEnv` rather than this module reading it
 * itself.
 */

export interface ChildArgsInput {
	/** "provider/modelId", or a bare modelId when the CLI should pick the provider itself. */
	model: string;
	effort?: string;
	/**
	 * Absolute path to the persona's system-prompt file, already written to
	 * disk by dispatch/persona.ts. Omitted when the persona has no body (or
	 * there is no persona at all).
	 */
	promptPath?: string;
	/** Resolved tool allow-list: `opts.tools` if non-empty, else the persona's own tools. */
	tools?: string[];
	/** The rendered task text to run as the child's one prompt. */
	task: string;
}

/**
 * Build the full argv for the child process, in the exact order
 * `runSubagentProcess` built it by hand: mode/session flags, provider+model
 * (split on the first `/`), thinking effort, the persona's
 * `--append-system-prompt` file (if any), the tool allow-list (if any), the
 * feedback-loop guards, and finally the task text itself.
 */
export function buildChildArgs(input: ChildArgsInput): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	// model is "provider/modelId"; split so the CLI resolver can pick the
	// right provider binding (mirrors executeSingleSubagent).
	const slashIndex = input.model.indexOf("/");
	if (slashIndex !== -1) {
		args.push("--provider", input.model.slice(0, slashIndex));
		args.push("--model", input.model.slice(slashIndex + 1));
	} else {
		args.push("--model", input.model);
	}

	if (input.effort) args.push("--thinking", input.effort);

	// There is NO `--agent` CLI flag; passing one makes HT exit 1 with
	// "Unknown option: --agent" before it ever contacts a provider. The
	// persona is instead a file already written by dispatch/persona.ts,
	// injected here via --append-system-prompt.
	if (input.promptPath) args.push("--append-system-prompt", input.promptPath);

	if (input.tools && input.tools.length > 0) args.push("--tools", input.tools.join(","));

	// Avoid feedback loops: an extension handler inside an interactive
	// session must not recursively load extensions or the user's skill
	// commands. Subagent tool does the same.
	args.push("--no-extensions", "--no-skills", "--no-prompt-templates");

	args.push(input.task);

	return args;
}

/**
 * An allow-list without write/edit means the child physically could not have
 * touched a file, so anything its prose mentions is a false positive. With no
 * allow-list at all the child gets the default tool set, which can mutate.
 */
export function personaCanMutateFor(tools: string[] | undefined): boolean {
	return !tools || tools.some((t) => t === "write" || t === "edit");
}

export interface ChildEnvInput {
	/** The repository the child should operate in. */
	cwd: string;
}

/**
 * Build the child's env: `baseEnv` (normally the caller's `process.env`,
 * passed in explicitly so this module never reads it itself) plus the
 * orchestrator-dispatch overrides `runSubagentProcess` always set.
 */
export function buildChildEnv(baseEnv: NodeJS.ProcessEnv, input: ChildEnvInput): NodeJS.ProcessEnv {
	return {
		...baseEnv,
		HUMAIN_TERMINAL_RUNTIME: "orchestrator-dispatch",
		CODING_AGENT_RUNTIME: "humain-terminal",
		CODING_AGENT_REPOSITORY: input.cwd,
		// Supacode/HT injected a few env vars that a nested Pi run would
		// pick up and try to attach to the parent's supacode session — that
		// fails fast with an auth error. Clear them.
		SUPACODE_SESSION: undefined,
		SUPACODE_TAB_ID: undefined,
	};
}

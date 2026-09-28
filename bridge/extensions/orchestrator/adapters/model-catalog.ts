/** Pure model facts catalog used to qualify fallback candidates. */
export interface ModelFacts {
	context?: number;
	maxOutput?: number;
	effortControl?: boolean;
}

export interface RegistryModel {
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export type Catalog = ReadonlyMap<string, ModelFacts>;

const isPositiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

export function parseModelFacts(raw: unknown): { facts: Record<string, ModelFacts>; problems: string[] } {
	const facts: Record<string, ModelFacts> = {};
	const problems: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { facts, problems: ["model facts file is not an object"] };
	const root = raw as Record<string, unknown>;
	if (root.version !== 1) problems.push(`model facts: unsupported version ${JSON.stringify(root.version)} (expected 1)`);
	if (root.models === undefined) return { facts, problems };
	if (!root.models || typeof root.models !== "object" || Array.isArray(root.models)) {
		problems.push('model facts: "models" must be an object');
		return { facts, problems };
	}
	for (const [model, value] of Object.entries(root.models as Record<string, unknown>)) {
		if (!model.includes("/")) {
			problems.push(`model facts: "${model}" must be provider/id`);
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			problems.push(`model facts: "${model}" must be an object`);
			continue;
		}
		const input = value as Record<string, unknown>;
		const factsForModel: ModelFacts = {};
		if (input.context !== undefined) {
			if (isPositiveInt(input.context)) factsForModel.context = input.context;
			else problems.push(`model facts: ${model}.context must be a positive integer`);
		}
		if (input.max_output !== undefined) {
			if (isPositiveInt(input.max_output)) factsForModel.maxOutput = input.max_output;
			else problems.push(`model facts: ${model}.max_output must be a positive integer`);
		}
		if (input.effort_control !== undefined) {
			if (typeof input.effort_control === "boolean") factsForModel.effortControl = input.effort_control;
			else problems.push(`model facts: ${model}.effort_control must be a boolean`);
		}
		facts[model] = factsForModel;
	}
	return { facts, problems };
}

export function buildCatalog(models: RegistryModel[], overrides: Record<string, ModelFacts> = {}): Catalog {
	const catalog = new Map<string, ModelFacts>();
	for (const model of models) {
		catalog.set(`${model.provider}/${model.id}`, {
			...(isPositiveInt(model.contextWindow) ? { context: model.contextWindow } : {}),
			...(isPositiveInt(model.maxTokens) ? { maxOutput: model.maxTokens } : {}),
			...(typeof model.reasoning === "boolean" ? { effortControl: model.reasoning } : {}),
		});
	}
	for (const [model, facts] of Object.entries(overrides)) catalog.set(model, { ...(catalog.get(model) ?? {}), ...facts });
	return catalog;
}

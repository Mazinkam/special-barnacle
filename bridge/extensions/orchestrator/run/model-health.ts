/** Per-run model cooldown state with an injectable clock. */
export class ModelHealth {
	private readonly marks = new Map<string, { until: number; cls: string }>();
	constructor(private readonly now: () => number = Date.now) {}
	markUnhealthy(model: string, cls: string, ms: number): void {
		const until = this.now() + ms;
		const prior = this.marks.get(model);
		if (!prior || prior.until < until) this.marks.set(model, { until, cls });
	}
	isHealthy(model: string): boolean {
		const mark = this.marks.get(model);
		return !mark || mark.until <= this.now();
	}
	snapshot(): Array<{ model: string; cls: string; until: number }> {
		const now = this.now();
		return [...this.marks].filter(([, mark]) => mark.until > now).map(([model, mark]) => ({ model, cls: mark.cls, until: mark.until }));
	}
}

const REGION_RE = /^(global|eu|us|apac|ap|jp|au|ca)\./;
export function providerRegion(model: string): string {
	const slash = model.indexOf("/");
	if (slash < 0) return model;
	const provider = model.slice(0, slash);
	const region = REGION_RE.exec(model.slice(slash + 1))?.[1];
	return region ? `${provider}/${region}` : provider;
}

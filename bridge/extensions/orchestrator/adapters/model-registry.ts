/**
 * The one place that reads HT's live model registry off an
 * `ExtensionContext` (B4.6). `resolveAdapter`'s "flags > profile > dynamic
 * resolver" precedence needs to know which models the current runtime
 * actually has available; `ctx.modelRegistry.getAvailable()` can throw in
 * contexts where no registry is wired (e.g. some test harnesses), so this
 * degrades to an empty list rather than propagating.
 */

import type { ExtensionContext } from "@humain/terminal";
import type { AvailableModel } from "../models.ts";

export function availableModels(ctx: ExtensionContext): AvailableModel[] {
	try {
		return ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
	} catch {
		return [];
	}
}

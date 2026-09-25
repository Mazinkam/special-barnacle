/**
 * `bridge/agents/*.md` front matter carries a `model:` line — e.g.
 * `orch-worker.md`'s `model: amazon-bedrock/global.openai.gpt-6-luna` — that
 * HT's agent loader itself never reads (agent personas are selected by name;
 * the actual model comes from the resolved adapter, see
 * `adapters/adapter-resolver.ts`). Per docs/architecture-review.md B4 that
 * front matter is either misleading dead text or must be checked against the
 * real routing.
 *
 * It checks out: each agent name is `agentNameFor(capability)` for exactly
 * one method.json capability, and every `model:` line equals
 * `FALLBACK_ADAPTER[capability].model` — the routing the same capability gets
 * when no profile/dynamic adapter yields a binding, itself derived from the
 * shipped `premium` profile (bridge/orchestrator-profiles.json). So the
 * front matter is documentation of the shipped default route, and this test
 * keeps it honest instead of removing it.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FALLBACK_ADAPTER } from "./adapter-resolver.ts";

const AGENTS_DIR = join(import.meta.dir, "..", "..", "..", "agents");

/** `orch-<capability with _ as ->` for every capability, except the lead sizes, which all share the `orchestrator-lead` persona. */
const AGENT_NAME_TO_CAPABILITY: Record<string, string> = {
	"orch-architect": "architect",
	"orch-implementation-fast": "implementation_fast",
	"orch-implementation-strong": "implementation_strong",
	"orch-qa-agent": "qa_agent",
	"orch-scout": "scout",
	"orch-security-review": "security_review",
	"orch-technical-lead": "technical_lead",
	"orch-technical-review": "technical_review",
	"orch-worker": "worker",
	"orchestrator-lead": "lead",
};

function frontMatterModel(path: string): string | null {
	const text = readFileSync(path, "utf-8");
	const m = /^model:\s*(.+)\s*$/m.exec(text);
	return m ? m[1].trim() : null;
}

describe("bridge/agents/*.md model: front matter", () => {
	const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));

	test("every .md file with a model: line is accounted for by the name -> capability map", () => {
		for (const file of files) {
			const name = file.replace(/\.md$/, "");
			const model = frontMatterModel(join(AGENTS_DIR, file));
			if (model !== null) {
				expect(AGENT_NAME_TO_CAPABILITY).toHaveProperty(name);
			}
		}
	});

	for (const [name, capability] of Object.entries(AGENT_NAME_TO_CAPABILITY)) {
		test(`${name}.md's model: matches FALLBACK_ADAPTER["${capability}"] (the shipped premium profile's routing)`, () => {
			const model = frontMatterModel(join(AGENTS_DIR, `${name}.md`));
			expect(model).toBe(FALLBACK_ADAPTER[capability]?.model ?? null);
		});
	}
});
